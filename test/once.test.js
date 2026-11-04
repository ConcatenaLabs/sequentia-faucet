'use strict'
// Once per wallet: the claims ledger, its keys, the IP window, the exemption
// of our own tooling, the read of what a wallet has received, a restart, and
// two requests in flight together. No coins move: the node CLI is a stand-in.
//   npm test
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { mailboxOf } = require('../receive-code')

const ROOT = path.join(__dirname, '..')
const TB1 = n => 'tb1q' + String(n).padStart(4, '0').replace(/[1bio]/g, 'q') + 'q'.repeat(34)
const W = n => String(n).padStart(2, '0').repeat(32)     // a wallet id
// A receive code whose receive request is in the web wallet's short form
// (pay-code.js compactRequest), mailbox ab…ab.
const SHORT = 'SQR1QYPZYG3ZYGG3ZYG3XVENXVENXVENXVENXVENXVENXVENXVENXVENXVENXVENXVENXVE5G3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG39T4W46H2AT4W46H2AT4W46H2AT4W46H2AT4W46H2AT4W46H2AT4VQ0U66F6GQ92424242424242424242424242424242S2M07P8'
const code = n => 'BITCOIN:' + TB1(n).toUpperCase() + '?sequentia=' + SHORT

let ipSeq = 0
const nextIp = () => '203.0.113.' + (++ipSeq % 250 + 1)

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}
const base = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FAUCET_')))

function workdir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-once-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A stand-in for sequentia-cli: answers a balance, and for a send prints a txid
// after FAKE_CLI_DELAY seconds; it fails the send once when FAKE_CLI_FAIL_ONCE
// names a file that does not exist yet.
function fakeCli (dir) {
  const cli = path.join(dir, 'cli')
  fs.writeFileSync(cli, `#!/bin/sh
case "$*" in *getbalance*) echo 0; exit 0;; esac
if [ -n "$FAKE_CLI_FAIL_ONCE" ] && [ ! -e "$FAKE_CLI_FAIL_ONCE" ]; then : > "$FAKE_CLI_FAIL_ONCE"; echo "error: the node refused" >&2; exit 1; fi
sleep "\${FAKE_CLI_DELAY:-0}"
echo ${'cd'.repeat(32)}
`, { mode: 0o755 })
  return cli
}

async function start (t, dir, env = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...base(), FAUCET_PORT: String(port), FAUCET_CLI: fakeCli(dir), FAUCET_DATADIR: '/nowhere', FAUCET_LEDGER: path.join(dir, 'state', 'claims.jsonl'), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', d => { log += d })
  child.stderr.on('data', d => { log += d })
  const exited = new Promise(resolve => child.once('exit', resolve))
  t.after(() => child.kill())
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('listening')) resolve() })
    child.once('exit', code => reject(new Error('the server exited ' + code + ': ' + log)))
  })
  const url = 'http://127.0.0.1:' + port
  return {
    log: () => log,
    stop: async () => { child.kill(); await exited },
    get: async p => { const r = await fetch(url + p); return { status: r.status, body: await r.json() } },
    // Through the front door from `ip` (a fresh one unless named); `ip: null`
    // is a request straight to the loopback, as our own tooling makes.
    post: async (body, { ip, headers = {} } = {}) => {
      const h = { 'content-type': 'application/json', ...headers }
      if (ip !== null) h['x-forwarded-for'] = ip || nextIp()
      const r = await fetch(url + '/', { method: 'POST', headers: h, body: JSON.stringify(body) })
      return { status: r.status, body: await r.json() }
    }
  }
}

test('a wallet is paid each asset once, whatever address it names', async t => {
  const dir = workdir(t)
  const s = await start(t, dir)
  assert.equal((await s.post({ wallet: W(1), address: TB1(1), asset: 'USDX' })).status, 200)
  const again = await s.post({ wallet: W(1), address: TB1(2), asset: 'USDX' })
  assert.equal(again.status, 429)
  assert.equal(again.body.reason, 'wallet')
  assert.equal(again.body.claimed, true)
  assert.equal(again.body.error, 'This wallet has already received its USDX from the faucet. The faucet pays each asset once per wallet. To get more, trade for it in the wallet.')
  // In capitals, the same wallet.
  assert.equal((await s.post({ wallet: W(1).toUpperCase(), address: TB1(3), asset: 'USDX' })).body.reason, 'wallet')
  // Another asset, and another wallet, are paid.
  assert.equal((await s.post({ wallet: W(1), address: TB1(2), asset: 'EURX' })).status, 200)
  assert.equal((await s.post({ wallet: W(1), address: TB1(2) })).status, 200, 'tSEQ is one asset among the others')
  assert.equal((await s.post({ wallet: W(2), address: TB1(4), asset: 'USDX' })).status, 200)
  // What the wallet has received, without asking for a payout.
  assert.deepEqual((await s.get('/claimed?wallet=' + W(1))).body, { claimed: ['tSEQ', 'USDX', 'EURX'] })
  assert.deepEqual((await s.get('/claimed?wallet=' + W(3))).body, { claimed: [] })
  assert.deepEqual((await s.get('/claimed?address=' + TB1(4))).body, { claimed: ['USDX'] })
  assert.equal((await s.get('/claimed?wallet=nope')).status, 400)
  assert.equal((await s.get('/claimed')).status, 400)
  assert.equal((await s.post({ wallet: 'nope', address: TB1(5), asset: 'USDX' })).status, 400)
  assert.equal((await s.post({ wallet: 7, address: TB1(5), asset: 'USDX' })).status, 400)
})

test('an address is paid each asset once, with or without a wallet id', async t => {
  const s = await start(t, workdir(t))
  assert.equal((await s.post({ address: TB1(10), asset: 'GOLD' })).status, 200)
  const again = await s.post({ address: TB1(10), asset: 'GOLD' })
  assert.equal(again.status, 429)
  assert.equal(again.body.reason, 'address')
  assert.match(again.body.error, /^This address has already received its GOLD from the faucet\. .*trade for it/)
  assert.equal((await s.post({ wallet: W(11), address: TB1(10), asset: 'GOLD' })).body.reason, 'address')
})

test('a receive code\'s request names the wallet by its mailbox', async t => {
  assert.equal(mailboxOf(SHORT.toLowerCase()), 'ab'.repeat(32))
  assert.equal(mailboxOf('arca:' + Buffer.from(JSON.stringify({ kind: 'request', mailbox: 'cd'.repeat(32) })).toString('hex')), 'cd'.repeat(32))
  assert.equal(mailboxOf(SHORT.slice(0, -1) + 'Q'), null, 'a checksum that fails names nothing')
  const s = await start(t, workdir(t))
  assert.equal((await s.post({ address: code(20), asset: 'SILVR' })).status, 200)
  // Another address of the same wallet, in its next receive code.
  const again = await s.post({ address: code(21), asset: 'SILVR' })
  assert.equal(again.status, 429)
  assert.equal(again.body.reason, 'wallet')
})

test('an IP is paid each asset once per window', async t => {
  const s = await start(t, workdir(t), { FAUCET_IP_WINDOW_MS: '1500' })
  const ip = '198.18.0.7'
  assert.equal((await s.post({ wallet: W(30), address: TB1(30), asset: 'OILX' }, { ip })).status, 200)
  const same = await s.post({ wallet: W(31), address: TB1(31), asset: 'OILX' }, { ip })
  assert.equal(same.status, 429)
  assert.equal(same.body.reason, 'network')
  assert.equal(same.body.claimed, false)
  assert.match(same.body.error, /^The faucet has already paid OILX to a wallet on your network in the last day\. .*try again in 1 hour, or trade for OILX in your wallet\.$/)
  assert.equal((await s.post({ wallet: W(31), address: TB1(31), asset: 'USDX' }, { ip })).status, 200, 'another asset from the same IP')
  await new Promise(r => setTimeout(r, 1600))
  assert.equal((await s.post({ wallet: W(31), address: TB1(31), asset: 'OILX' }, { ip })).status, 200, 'the window has passed')
  // An IP's window never makes the wallet's own claim lapse.
  assert.equal((await s.post({ wallet: W(30), address: TB1(32), asset: 'OILX' })).body.reason, 'wallet')
})

test('the ledger survives a restart, and a line cut short by a crash', async t => {
  const dir = workdir(t)
  const file = path.join(dir, 'state', 'claims.jsonl')
  let s = await start(t, dir)
  assert.equal((await s.post({ wallet: W(40), address: TB1(40), asset: 'USDX' })).status, 200)
  assert.equal((await s.post({ address: code(41) })).status, 200)
  await s.stop()
  // A crash in the middle of a write leaves half a line.
  fs.appendFileSync(file, '{"t":1,"asset":"EURX","ke')
  s = await start(t, dir)
  assert.match(s.log(), /claims ledger .*: 2 payouts/)
  assert.equal((await s.post({ wallet: W(40), address: TB1(42), asset: 'USDX' })).body.reason, 'wallet')
  assert.equal((await s.post({ address: code(43) })).body.reason, 'wallet', 'the mailbox is remembered')
  assert.equal((await s.post({ address: TB1(40), asset: 'USDX' })).body.reason, 'address')
  assert.deepEqual((await s.get('/claimed?wallet=' + W(40))).body, { claimed: ['USDX'] })
  // The next claim is a line of its own, after the broken one.
  assert.equal((await s.post({ wallet: W(40), address: TB1(42), asset: 'EURX' })).status, 200)
  await s.stop()
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 4)
  assert.equal(JSON.parse(lines[3]).asset, 'EURX')
  assert.equal((fs.statSync(file).mode & 0o777), 0o600)
  assert.equal((fs.statSync(path.dirname(file)).mode & 0o777), 0o700)
  s = await start(t, dir)
  assert.equal((await s.post({ wallet: W(40), address: TB1(44), asset: 'EURX' })).body.reason, 'wallet')
  // The file holds no IP address in the clear.
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /203\.0\.113\./)
})

test('two requests in flight with a shared key never both pay', async t => {
  const s = await start(t, workdir(t), { FAKE_CLI_DELAY: '1' })
  const [a, b] = await Promise.all([
    s.post({ wallet: W(50), address: TB1(50), asset: 'USDX' }),
    s.post({ wallet: W(50), address: TB1(51), asset: 'USDX' })
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 429])
  const refused = a.status === 429 ? a : b
  assert.equal(refused.body.reason, 'busy')
  assert.match(refused.body.error, /already paying this wallet its USDX/)
  // Once the first is paid, the second is refused as claimed.
  assert.equal((await s.post({ wallet: W(50), address: TB1(51), asset: 'USDX' })).body.reason, 'wallet')
  // Requests that share no key are paid side by side.
  const [c, d] = await Promise.all([
    s.post({ wallet: W(52), address: TB1(52), asset: 'USDX' }),
    s.post({ wallet: W(53), address: TB1(53), asset: 'USDX' })
  ])
  assert.deepEqual([c.status, d.status], [200, 200])
})

test('a payout that fails is not recorded', async t => {
  const dir = workdir(t)
  const s = await start(t, dir, { FAKE_CLI_FAIL_ONCE: path.join(dir, 'failed') })
  const failed = await s.post({ wallet: W(60), address: TB1(60), asset: 'USDX' })
  assert.equal(failed.status, 502)
  assert.match(failed.body.error, /the node refused/)
  assert.deepEqual((await s.get('/claimed?wallet=' + W(60))).body, { claimed: [] })
  assert.equal((await s.post({ wallet: W(60), address: TB1(60), asset: 'USDX' })).status, 200)
})

test('our own tooling is never refused: the loopback, or the token', async t => {
  const dir = workdir(t)
  const token = path.join(dir, 'exempt.token')
  fs.writeFileSync(token, 'f'.repeat(64) + '\n', { mode: 0o600 })
  const s = await start(t, dir, { FAUCET_EXEMPT_TOKEN_FILE: token })
  // Straight to the loopback, with no front door in between.
  for (let i = 0; i < 2; i++) assert.equal((await s.post({ wallet: W(70), address: TB1(70), asset: 'USDX' }, { ip: null })).status, 200)
  // Through the front door, with the token.
  const pass = { 'x-faucet-exempt': 'f'.repeat(64) }
  for (let i = 0; i < 2; i++) assert.equal((await s.post({ wallet: W(70), address: TB1(70), asset: 'USDX' }, { ip: '198.18.1.1', headers: pass })).status, 200)
  // Neither is kept in the ledger, so the wallet's own claim is still open.
  assert.deepEqual((await s.get('/claimed?wallet=' + W(70))).body, { claimed: [] })
  // A wrong token, or none, through the front door: the rule applies.
  assert.equal((await s.post({ wallet: W(70), address: TB1(70), asset: 'USDX' }, { headers: { 'x-faucet-exempt': 'e'.repeat(64) } })).status, 200)
  assert.equal((await s.post({ wallet: W(70), address: TB1(71), asset: 'USDX' }, { headers: { 'x-faucet-exempt': 'f'.repeat(63) } })).body.reason, 'wallet')
  assert.equal((await s.post({ wallet: W(70), address: TB1(71), asset: 'USDX' }, { headers: { forwarded: 'for=1.2.3.4' } })).body.reason, 'wallet')
})

test('a token file that holds no token stops the faucet', async t => {
  const dir = workdir(t)
  const token = path.join(dir, 'exempt.token')
  fs.writeFileSync(token, 'short\n')
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...base(), FAUCET_PORT: String(await freePort()), FAUCET_CLI: '/bin/echo', FAUCET_LEDGER: path.join(dir, 'c.jsonl'), FAUCET_EXEMPT_TOKEN_FILE: token },
    stdio: 'ignore'
  })
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 1)
})
