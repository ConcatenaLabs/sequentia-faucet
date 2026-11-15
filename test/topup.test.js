'use strict'
// deploy/faucet-topup.sh against a faucet, a node and a leaf wallet that are stand-ins: what it
// sends, from which wallet, and every bound that keeps it from sending.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const SCRIPT = path.join(__dirname, '..', 'deploy', 'faucet-topup.sh')
const USDX = '2a'.repeat(32)
const GOLD = '3a'.repeat(32)
const TSEQ = '4b'.repeat(32)

// A faucet answering /leaves with `assets`, a node command line that records what it is asked
// and holds `balances` (label -> coins), and a leaf wallet that gives one address.
async function setup (t, assets, balances = {}, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-topup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const server = http.createServer((req, res) => {
    if (opts.down) { res.writeHead(500); return res.end() }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ warn: 8, assets }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const cli = path.join(dir, 'cli')
  const ids = { [USDX]: 'USDX', [GOLD]: 'GOLD', [TSEQ]: 'tSEQ' }
  fs.writeFileSync(cli, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/cli.log"
for a in "$@"; do case "$a" in
  getbalance) case "\${@: -1}" in
${Object.entries(ids).map(([id, label]) => `    ${id}) echo "${balances[label] ?? '0'}";;`).join('\n')}
    esac; exit 0;;
  sendtoaddress) ${opts.sendFails ? 'echo "error: refused" >&2; exit 1' : 'echo "txid-$RANDOM$RANDOM"; exit 0'};;
esac; done
exit 1
`, { mode: 0o755 })
  const arca = path.join(dir, 'arca')
  fs.writeFileSync(arca, '#!/usr/bin/env bash\ncase "$3" in address) echo \'{"address":"tb1leafwallet"}\';; *) exit 1;; esac\n', { mode: 0o755 })
  const leaf = path.join(dir, 'leaf'); fs.mkdirSync(leaf)
  const state = path.join(dir, 'state')
  const envs = [`FAUCET_CLI=${cli}`, `FAUCET_DATADIR=${dir}/node`, `FAUCET_WALLET=${opts.wallet || 'funding'}`,
    `FAUCET_LEAF_ARCA=${arca}`, `FAUCET_LEAF_DATADIR=${leaf}`, `FAUCET_LEAF_ASSETS=USDX=${USDX},GOLD=${GOLD},tSEQ=${TSEQ}`].join(' ')
  const run = (env = {}) => new Promise(resolve => {
    const child = spawn('bash', [SCRIPT], {
      env: { PATH: process.env.PATH, FAUCET_URL: `http://127.0.0.1:${server.address().port}`, ENVS: envs, TOPUP_STATE: state, TOPUP_RETRY_S: '0', ...env }
    })
    let out = ''
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
    child.on('close', code => resolve({ code, out }))
  })
  const calls = () => (fs.existsSync(path.join(dir, 'cli.log')) ? fs.readFileSync(path.join(dir, 'cli.log'), 'utf8').trim().split('\n') : [])
  const sends = () => calls().filter(l => l.includes('sendtoaddress'))
  const records = () => (fs.existsSync(state) ? fs.readdirSync(state).filter(f => f.endsWith('.txid')) : [])
  return { run, calls, sends, records, state, dir }
}
const holds = (leaves, boarding, onchain, payout) => ({ leaves, boarding, onchain, low: leaves + boarding + onchain < 8, payout })

test('an asset under TOPUP_AT payouts is sent what brings it to TOPUP_TO, from the wallet the faucet names, its fee in itself', async t => {
  const s = await setup(t, { USDX: holds(1, 0, 0, '500000'), GOLD: holds(17, 0, 4, '125'), tSEQ: holds(0, 0, 0, '100') },
    { USDX: '33265416.28188638', GOLD: '582713.9', tSEQ: '9000000' })
  const r = await s.run()
  assert.equal(r.code, 0, r.out)
  assert.equal(s.sends().length, 1, r.out)
  const send = s.sends()[0]
  // 29 payouts of 500,000: 30 less the one it holds.
  assert.match(send, /-rpcwallet=funding -named sendtoaddress address=tb1leafwallet amount=14500000\.00000000 fee_rate=2 /)
  assert.ok(send.includes(`fee_asset_label=${USDX} assetlabel=${USDX}`), send)
  assert.match(r.out, /USDX held 1 payouts; sent 14500000\.00000000 from funding \(it held 33265416\.28188638\) to the leaf wallet: txid-/)
  assert.equal(s.records().length, 1)
  assert.match(s.records()[0], /^\d{4}-\d\d-\d\d-USDX-1\.txid$/)
  // GOLD holds enough and tSEQ is the drip covenant's: neither is asked about, let alone sent.
  assert.ok(!s.calls().some(l => l.includes(GOLD) || l.includes(TSEQ)), s.calls().join('\n'))
})

test('nothing is sent when every asset holds enough', async t => {
  const s = await setup(t, { USDX: holds(11, 0, 9, '500000'), GOLD: holds(12, 0, 0, '125') }, { USDX: '1000000000', GOLD: '1000000' })
  const r = await s.run()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /every asset holds 12 payouts or more; nothing sent/)
  assert.equal(s.calls().length, 0)
})

test('a send is at most half of what the source holds, in whole payouts; under one payout nothing is sent and the log says to fund the source', async t => {
  const s = await setup(t, { USDX: holds(2, 0, 0, '500000'), GOLD: holds(0, 0, 0, '125') }, { USDX: '3400000', GOLD: '249.99999999' })
  const r = await s.run()
  assert.equal(r.code, 0, r.out)
  assert.equal(s.sends().length, 1, r.out)
  // Half of 3,400,000 is 1,700,000: three whole payouts.
  assert.match(s.sends()[0], /amount=1500000\.00000000 .*assetlabel=2a/)
  assert.match(r.out, /GOLD holds 0 payouts, and half of what funding holds \(249\.99999999\) is less than one payout: not sent; fund funding/)
})

test('an asset is not sent again within the gap, nor more than TOPUP_DAILY times a day', async t => {
  const s = await setup(t, { USDX: holds(3, 0, 0, '500000') }, { USDX: '100000000' })
  assert.equal((await s.run()).code, 0)
  assert.equal(s.sends().length, 1)
  // The faucet has not counted the coins yet: the same reading again, minutes later.
  let r = await s.run()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /USDX holds 3 payouts; sent 0 minutes ago, not again within 45/)
  assert.equal(s.sends().length, 1)
  // With no gap, the daily bound is what stops it.
  r = await s.run({ TOPUP_GAP_MIN: '0', TOPUP_DAILY: '2' })
  assert.equal(s.sends().length, 2, r.out)
  r = await s.run({ TOPUP_GAP_MIN: '0', TOPUP_DAILY: '2' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /USDX holds 3 payouts and was sent 2 times today already: not again before tomorrow \(UTC\)/)
  assert.equal(s.sends().length, 2)
  // A record of another day does not count against today.
  for (const f of s.records()) fs.renameSync(path.join(s.state, f), path.join(s.state, f.replace(/^\d{4}-\d\d-\d\d/, '2020-01-01')))
  const old = new Date('2020-01-01T00:00:00Z')
  for (const f of s.records()) fs.utimesSync(path.join(s.state, f), old, old)
  r = await s.run({ TOPUP_DAILY: '2' })
  assert.equal(s.sends().length, 3, r.out)
})

test('a refused send fails the run and leaves no record; a faucet that does not answer exits 2 and nothing is asked of the node', async t => {
  const s = await setup(t, { USDX: holds(0, 0, 0, '500000') }, { USDX: '100000000' }, { sendFails: true })
  let r = await s.run()
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /faucet top-up FAILED: sending 15000000\.00000000 USDX from funding/)
  assert.equal(s.records().length, 0)
  const d = await setup(t, {}, {}, { down: true })
  r = await d.run()
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /faucet top-up FAILED: the faucet does not answer/)
  assert.equal(d.calls().length, 0)
})

test('/leaves of an older faucet, with no payout amount, sends nothing', async t => {
  const s = await setup(t, { USDX: { leaves: 0, boarding: 0, onchain: 0, low: true } }, { USDX: '100000000' })
  const r = await s.run()
  assert.equal(r.code, 0, r.out)
  assert.equal(s.calls().length, 0)
})
