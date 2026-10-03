'use strict'
// The faucet's request path, with no coins moved: FAUCET_CLI is echo, so a
// send "succeeds" with the arguments it would have run, and the drip tool is a
// stand-in that pays once and then reports the interval as not passed.
//   npm test
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TB1 = n => 'tb1q' + String(n).padStart(4, '0').replace(/[1bio]/g, 'q') + 'q'.repeat(34)

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

// The environment without the faucet's own settings, so that each server
// runs on what its test gives it and nothing the shell happens to set.
const base = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FAUCET_')))

async function start (t, env) {
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...base(), FAUCET_PORT: String(port), FAUCET_CLI: '/bin/echo', FAUCET_DATADIR: '/nowhere', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('listening')) resolve() })
    child.once('exit', code => reject(new Error('the server exited ' + code)))
  })
  const url = 'http://127.0.0.1:' + port
  return {
    get: async p => (await fetch(url + p)).json(),
    post: async body => {
      const r = await fetch(url + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, body: await r.json() }
    }
  }
}

test('requests are checked and rate limited', async t => {
  const s = await start(t, {})
  assert.deepEqual(await s.get('/healthz'), { ok: true })
  assert.equal((await s.post({ address: 'not-an-address' })).status, 400)
  assert.equal((await s.post({ address: TB1(1), asset: 'NOPE' })).status, 400)
  const usdx = await s.post({ address: TB1(1), asset: 'USDX' })
  assert.equal(usdx.status, 200)
  assert.equal(usdx.body.asset, 'USDX')
  assert.match(usdx.body.txid, /sendtoaddress/)
  assert.match(usdx.body.txid, /fee_asset_label=USDX/, 'an asset pays its own fee')
  assert.equal((await s.post({ address: TB1(1), asset: 'USDX' })).status, 429)
  const tseq = await s.post({ address: TB1(2) })
  assert.equal(tseq.status, 200)
  assert.match(tseq.body.txid, /fee_asset_label=bitcoin/)
  // echo is no balance, so the floor applies.
  assert.deepEqual(await s.get('/amount'), { amount: '200', asset: 'tSEQ' })
})

test('the drip covenant pays tSEQ, once per interval, to transparent addresses', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-server-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const state = path.join(dir, 'state')
  const s = await start(t, {
    FAUCET_DRIP: path.join(__dirname, 'fake-drip.js'),
    FAUCET_DRIP_INSTANCE: path.join(dir, 'instance.json'),
    FAUCET_DRIP_MNEMONIC: path.join(dir, 'faucet.mnemonic'),
    FAKE_DRIP_STATE: state,
    // A short cooldown, so that a second address from this one IP reaches the reserve.
    FAUCET_COOLDOWN_MS: '50'
  })
  for (let i = 0; i < 50 && (await s.get('/amount')).amount !== '50000'; i++) await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(await s.get('/amount'), { amount: '50000', asset: 'tSEQ' }, 'the tier the covenant holds')

  const paid = await s.post({ address: TB1(3) })
  assert.equal(paid.status, 200)
  assert.deepEqual(paid.body, { txid: 'ab'.repeat(32), amount: '50000', asset: 'tSEQ' })
  const calls = fs.readFileSync(state + '.log', 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const drip = calls.find(c => c[0] === 'drip')
  const after = flag => drip[drip.indexOf(flag) + 1]
  assert.equal(after('--to'), TB1(3))
  assert.equal(after('--mnemonic-file'), path.join(dir, 'faucet.mnemonic'))
  assert.equal(after('--instance'), path.join(dir, 'instance.json'))
  assert.equal(after('--cli'), '/bin/echo')
  assert.equal(after('--datadir'), '/nowhere')

  // The reserve's next interval has not passed: another address waits.
  await new Promise(r => setTimeout(r, 100))
  const early = await s.post({ address: TB1(4) })
  assert.equal(early.status, 429)
  assert.match(early.body.error, /once per interval/)
  // The covenant pays explicit outputs only.
  const blinded = await s.post({ address: 'tsqb1q' + 'q'.repeat(60) })
  assert.equal(blinded.status, 400)
  assert.match(blinded.body.error, /transparent/)
  // Other assets still come from the wallet.
  const usdx = await s.post({ address: TB1(5), asset: 'USDX' })
  assert.equal(usdx.status, 200)
  assert.match(usdx.body.txid, /assetlabel=USDX/)
})

test('the drip covenant needs its instance and its key', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...base(), FAUCET_PORT: String(await freePort()), FAUCET_DRIP: '/bin/true' },
    stdio: 'ignore'
  })
  const code = await new Promise(resolve => child.once('exit', resolve))
  assert.equal(code, 1)
})
