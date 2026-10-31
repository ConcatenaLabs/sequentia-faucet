'use strict'
// Receive codes in place of an address, and BTC payouts from the faucet's
// Bitcoin side (test/fake-arca.js answers as Bark does).
//   npm test
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { readReceiveCode, addressOf } = require('../receive-code')
const { tierFor, btc, spendableOf } = require('../btc')

const ROOT = path.join(__dirname, '..')
const ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const ARK = 'tark1pnglpcr3zqqpqrp6tlztdfmchlyn76tqvxhg8xguspymp8hg4f0jf445aq3yz4p3zqypejs78mq2ctzc8rzmdcclka7j4fe273dlxs87ud70zv3kxdzvl9nq3ywvye'
const CODE = `BITCOIN:${ADDR.toUpperCase()}?ark=${ARK.toUpperCase()}&sequentia=SQR1QQQQ`

test('a receive code is read for its parts, in lower case; anything else is not a code', () => {
  assert.deepEqual(readReceiveCode(CODE), { address: ADDR, ark: ARK, sequentia: 'sqr1qqqq' })
  assert.deepEqual(readReceiveCode('bitcoin:' + ADDR), { address: ADDR, ark: null, sequentia: null })
  assert.deepEqual(readReceiveCode(' bitcoin:?ark=' + ARK + ' '), { address: null, ark: ARK, sequentia: null })
  assert.equal(readReceiveCode(ADDR), null)
  assert.equal(addressOf(CODE), ADDR)
  assert.equal(addressOf(' ' + ADDR + ' '), ADDR)
  // a mixed-case (base58) address keeps its case
  assert.equal(addressOf('bitcoin:mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'), 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')
})

test('BTC tiers follow what the faucet can send, and amounts read as BTC', () => {
  assert.equal(tierFor(5_000_000), 100_000)
  assert.equal(tierFor(600_000), 50_000)
  assert.equal(tierFor(100_000), 20_000)
  assert.equal(tierFor(99_999), 0)
  assert.equal(btc(100000), '0.001')
  assert.equal(spendableOf({ spendable_sat: 123 }), 123)
  assert.equal(spendableOf({ ark: { spendable_sat: 7 } }), 7)
  assert.equal(spendableOf('nonsense'), 0)
})

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}
const base = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FAUCET_') && !k.startsWith('FAKE_')))

async function start (t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-btc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const state = path.join(dir, 'state.json')
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...base(), FAUCET_PORT: String(port), FAUCET_CLI: '/bin/echo', FAUCET_DATADIR: '/nowhere',
      FAUCET_BTC_ARCA: path.join(__dirname, 'fake-arca.js'), FAUCET_BTC_DATADIR: dir, FAKE_ARCA_STATE: state, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('listening')) resolve() })
    child.once('exit', code => reject(new Error('the server exited ' + code)))
  })
  const url = 'http://127.0.0.1:' + port
  const commands = () => { try { return fs.readFileSync(state + '.log', 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch (e) { return [] } }
  const s = {
    commands,
    get: async p => (await fetch(url + p)).json(),
    post: async (body, ip) => {
      const r = await fetch(url + '/', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: JSON.stringify(body) })
      return { status: r.status, body: await r.json() }
    }
  }
  for (let i = 0; i < 100 && (await s.get('/amount?asset=BTC')).amount === '0'; i++) await new Promise(r => setTimeout(r, 50))
  return s
}

test('an asset asked for with a receive code goes to the code\'s address', async t => {
  const s = await start(t)
  const r = await s.post({ address: CODE, asset: 'USDX' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.match(r.body.txid, new RegExp('address=' + ADDR))
  const bad = await s.post({ address: 'BITCOIN:?ark=' + ARK.toUpperCase(), asset: 'USDX' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'That receive code names no Sequentia address.')
})

test('BTC goes to a receive code\'s Bitcoin ark address, at the tier, once per cooldown', async t => {
  const s = await start(t)
  assert.deepEqual(await s.get('/amount?asset=BTC'), { amount: '0.001', asset: 'BTC' })
  const r = await s.post({ address: CODE, asset: 'BTC' }, '10.0.0.1')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, { amount: '0.001', asset: 'BTC', ark: true, txid: null })
  const send = s.commands().find(c => c[0] === 'bitcoin' && c[2] === 'send')
  assert.deepEqual(send, ['bitcoin', '--quiet', 'send', ARK, '100000 sats'])
  assert.equal((await s.post({ address: CODE, asset: 'BTC' }, '10.0.0.2')).status, 429, 'the same code again')
  assert.equal((await s.post({ address: 'bitcoin:' + ADDR, asset: 'BTC' }, '10.0.0.1')).status, 429, 'the same IP again')
})

test('BTC to a plain tb1 address is paid on chain; anything else is refused', async t => {
  const s = await start(t)
  const r = await s.post({ address: ADDR, asset: 'BTC' }, '10.0.0.3')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ark, false)
  assert.equal(r.body.txid, 'c'.repeat(64))
  const blinded = await s.post({ address: 'tsqb1qqqqqqqqqqqqqqqqqqqqqqqqqqqqq', asset: 'BTC' }, '10.0.0.4')
  assert.equal(blinded.status, 400)
  assert.equal(blinded.body.error, 'BTC is paid to a receive code or to a tb1 address.')
})

test('a faucet low on BTC pays nothing, and says so', async t => {
  const s = await start(t, { FAKE_BARK_SATS: '50000' })
  await new Promise(r => setTimeout(r, 300))
  assert.deepEqual(await s.get('/amount?asset=BTC'), { amount: '0', asset: 'BTC' })
  const r = await s.post({ address: CODE, asset: 'BTC' }, '10.0.0.5')
  assert.equal(r.status, 503)
  assert.match(r.body.error, /no BTC to hand out right now/)
})

test('without a Bitcoin side, BTC is refused', async t => {
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...base(), FAUCET_PORT: String(port), FAUCET_CLI: '/bin/echo', FAUCET_DATADIR: '/nowhere' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  await new Promise(resolve => child.stdout.on('data', d => { if (String(d).includes('listening')) resolve() }))
  const r = await fetch('http://127.0.0.1:' + port + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: CODE, asset: 'BTC' }) })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'This faucet does not pay BTC.')
})
