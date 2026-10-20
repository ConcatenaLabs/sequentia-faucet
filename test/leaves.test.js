'use strict'
// Leaf payouts, with no coins moved: the leaf wallet is test/fake-arca.js,
// which answers as the `arca` command line does, and the treasury's balance
// comes from a stand-in node CLI.
//   npm test
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { decode, toAtoms, toCoins } = require('../leaves')

const ROOT = path.join(__dirname, '..')
const OPERATOR = 'bc81bdb7c27b11a7e60c40129dc5a17c1e27334913fed4f5c9ce90d462775fbb'
const GENESIS = '3ce8ab6c8f9836c0cebca304f3cbed3e824e6c53f4cacd2822f6f8441eed1a3e'
const X = '750627c5778222a49fc785933f4636964f010092b460b9bd16bf8c424e14366f'
const Y = '7fb7b8b9c62e1333ff1d39293fa23c8793ac1718467cf7227766408bea1baf00'
const Z = 'ab'.repeat(32)
const MEDIAN = 1800000000
const TB1 = 'tb1q' + 'q'.repeat(38)

// A receive request as `arca receive` hands it out, its fields changed by `edit`.
let n = 0
function request (edit = {}) {
  n++
  const k = String(n).padStart(64, '0')
  const v = { arca_request: 1, genesis_hash: GENESIS, operator: OPERATOR, owner: k, owner_nonce: k, mailbox: 'aa'.repeat(31) + String(n % 100).padStart(2, '0'), exit_delay_units: 2, until: MEDIAN + 27 * 86400, ...edit }
  for (const key of Object.keys(v)) if (v[key] === undefined) delete v[key]
  return 'arca:' + Buffer.from(JSON.stringify(v)).toString('hex')
}

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}
const base = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FAUCET_') && !k.startsWith('FAKE_')))

async function start (t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-leaves-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // The treasury holds 20,000,000 tSEQ: the 20,000 tier.
  const cli = path.join(dir, 'cli')
  fs.writeFileSync(cli, '#!/bin/sh\necho 20000000\n', { mode: 0o755 })
  const state = path.join(dir, 'arca-state')
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...base(), FAUCET_PORT: String(port), FAUCET_CLI: cli, FAUCET_DATADIR: '/nowhere',
      FAUCET_LEAF_ARCA: path.join(__dirname, 'fake-arca.js'), FAUCET_LEAF_DATADIR: path.join(dir, 'leaves'),
      FAUCET_LEAF_OPERATOR: OPERATOR, FAUCET_LEAF_ASSETS: `tSEQ=${X},USDX=${Y},EURX=${Z}`,
      FAKE_ARCA_STATE: state, FAKE_ARCA_OPERATOR: OPERATOR, FAKE_ARCA_MEDIAN: String(MEDIAN), ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  let log = ''
  child.stdout.on('data', d => { log += d })
  child.stderr.on('data', d => { log += d })
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('listening')) resolve() })
    child.once('exit', code => reject(new Error('the server exited ' + code + ': ' + log)))
  })
  const url = 'http://127.0.0.1:' + port
  const commands = () => { try { return fs.readFileSync(state + '.log', 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch (e) { return [] } }
  const s = {
    log: () => log,
    commands,
    stateFile: state,
    get: async p => (await fetch(url + p)).json(),
    post: async (body, ip) => {
      const r = await fetch(url + '/', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: JSON.stringify(body) })
      return { status: r.status, body: await r.json() }
    }
  }
  // Ready once the first sync has read the wallet's info and the treasury's tier is in.
  for (let i = 0; i < 100 && !(commands().some(c => c[0] === 'info') && (await s.get('/amount')).amount === '20000'); i++) await new Promise(r => setTimeout(r, 50))
  return s
}

test('amounts convert exactly between coins and atoms', () => {
  assert.equal(toAtoms('20000'), '2000000000000')
  assert.equal(toAtoms('0.01'), '1000000')
  assert.equal(toCoins('2000000000000'), '20000')
  assert.equal(toCoins('1000001'), '0.01000001')
  assert.throws(() => toAtoms('1.123456789'))
  assert.throws(() => decode('not a request'))
  assert.throws(() => decode('arca:zz'))
  assert.throws(() => decode('arca:' + Buffer.from('{"arca_swap_offer":1}').toString('hex')))
})

test('a receive request is paid as a leaf at the tier and amounts of on-chain payouts', async t => {
  const s = await start(t)
  // tSEQ: the treasury's tier, 20,000 tSEQ, into the request.
  const r = await s.post({ request: request() })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual({ amount: r.body.amount, asset: r.body.asset, atoms: r.body.leaf.atoms }, { amount: '20000', asset: 'tSEQ', atoms: '2000000000000' })
  const send = s.commands().find(c => c[0] === 'send')
  assert.deepEqual(send.slice(2), ['--amount', '2000000000000', '--asset', X])
  // A request for less is paid what it asks.
  const less = await s.post({ request: request({ value: '5000' }) }, '10.0.0.2')
  assert.equal(less.body.leaf.atoms, '5000')
  // Below the operator's smallest leaf, refused.
  const tiny = await s.post({ request: request({ value: '10' }) }, '10.0.0.3')
  assert.equal(tiny.status, 400)
  assert.match(tiny.body.error, /below the operator's smallest leaf/)
})

test('the same limits as on-chain payouts: per wallet and per IP, the IP shared with on-chain requests', async t => {
  const s = await start(t)
  const mailbox = 'cd'.repeat(32)
  assert.equal((await s.post({ request: request({ mailbox }) }, '10.0.1.1')).status, 200)
  // The same wallet (its mailbox key) from another IP, with a new request.
  let r = await s.post({ request: request({ mailbox }) }, '10.0.1.2')
  assert.equal(r.status, 429)
  // Another wallet from the same IP.
  r = await s.post({ request: request() }, '10.0.1.1')
  assert.equal(r.status, 429)
  // An on-chain tSEQ request from that IP, after its leaf.
  r = await s.post({ address: TB1 }, '10.0.1.1')
  assert.equal(r.status, 429)
  // Another asset is limited on its own.
  const before = s.commands().filter(c => c[0] === 'send').length
  r = await s.post({ request: request({ mailbox }), asset: 'USDX' }, '10.0.1.1')
  assert.notEqual(r.status, 429)
  assert.equal(s.commands().filter(c => c[0] === 'send').length, before + 1)
})

test('refused: a lapsed request, an unserved asset, another operator or chain, and malformed requests', async t => {
  const s = await start(t)
  const cases = [
    [{ request: request({ until: MEDIAN - 1 }) }, 400, /lapsed at 1799999999 .*chain's is 1800000000/],
    [{ request: request({ until: undefined }) }, 400, /names no lapse/],
    [{ request: request(), asset: 'EURX' }, 400, new RegExp(`operator does not serve EURX \\(${Z}\\)`)],
    [{ request: request(), asset: 'GOLD' }, 400, /does not pay GOLD into receive requests/],
    [{ request: request(), asset: 'NOPE' }, 400, /Unknown faucet asset/],
    [{ request: request({ asset: Y }) }, 400, /asks for asset 7fb7.*not tSEQ/],
    [{ request: request({ operator: 'ee'.repeat(32) }) }, 400, /is for operator eeee.*through operator bc81bdb7.* only/],
    [{ request: request({ genesis_hash: '00'.repeat(32) }) }, 400, /for another chain/],
    [{ request: request(), address: TB1 }, 400, /not both/],
    [{ request: 'arca:' + Buffer.from('{"arca_request":1}').toString('hex') }, 400, /has no operator/],
    [{ request: 'hello' }, 400, /no prefix/]
  ]
  for (const [body, status, why] of cases) {
    const r = await s.post(body, '10.0.2.' + (cases.indexOf(cases.find(c => c[0] === body)) + 1))
    assert.equal(r.status, status, JSON.stringify(body) + ' ' + JSON.stringify(r.body))
    assert.match(r.body.error, why)
  }
  assert.equal(s.commands().filter(c => c[0] === 'send').length, 0, 'nothing refused reached the wallet')
})

test('the wallet\'s own lapse check, against the chain now, refuses what the faucet\'s last reading let through', async t => {
  // The faucet read the median time at its last sync; the chain is an hour on.
  const s = await start(t, { FAKE_ARCA_SEND_MEDIAN: String(MEDIAN + 3600) })
  const r = await s.post({ request: request({ until: MEDIAN + 600 }) })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /^refused: the request lapsed at 1800000600 \(a median time; the chain's is 1800003600\)/)
  // Refused by the wallet, so nothing was paid and the wallet is not limited.
  assert.equal((await s.post({ request: request() })).status, 200)
  // The faucet's own margin: a request that lapses within a minute of its reading.
  const close = await s.post({ request: request({ until: MEDIAN + 60 }) }, '10.0.3.1')
  assert.equal(close.status, 400)
  assert.match(close.body.error, /lapsed at 1800000060/)
})

test('the leaf wallet syncs on its schedule, boards when low and refuses work on another operator', async t => {
  const s = await start(t, { FAUCET_LEAF_SYNC_MIN_MS: '100', FAUCET_LEAF_SYNC_MAX_MS: '200', FAKE_ARCA_NEXT: '0', FAKE_ARCA_LIVE: '0' })
  await new Promise(r => setTimeout(r, 900))
  const syncs = s.commands().filter(c => c[0] === 'sync').length
  assert.ok(syncs >= 3, `synced ${syncs} times`)
  // Boarded tSEQ (20 payouts of the tier) once, waited while it was pending,
  // and not again once it held 5 payouts or more.
  const boards = s.commands().filter(c => c[0] === 'board')
  assert.deepEqual(boards[0], ['board', X, String(20n * 2000000000000n)])
  assert.equal(boards.filter(b => b[1] === X).length, 1)
  // USDX's on-chain coins are none: nothing boarded, and the log says so.
  assert.equal(boards.filter(b => b[1] === Y).length, 0)
  assert.match(s.log(), /USDX in leaves is 0 and its on-chain coins \(0\) cannot board more/)

  const other = await start(t, { FAKE_ARCA_OPERATOR: 'ee'.repeat(32) })
  const r = await other.post({ request: request() })
  assert.equal(r.status, 503)
  assert.equal(other.commands().filter(c => c[0] === 'send').length, 0)
})

test('a low asset is looked at again soon, not at the schedule\'s longest wait, and boarded once its coins arrive', async t => {
  const s = await start(t, { FAUCET_LEAF_SYNC_MIN_MS: '100', FAUCET_LEAF_SYNC_MAX_MS: '60000', FAKE_ARCA_NEXT: '3600' })
  await new Promise(r => setTimeout(r, 700))
  // The wallet's schedule asks for its next sync in an hour; USDX is short, so
  // the faucet looks again at its shortest interval, and says so only once.
  const syncs = s.commands().filter(c => c[0] === 'sync').length
  assert.ok(syncs >= 3, `synced ${syncs} times`)
  assert.equal((s.log().match(/USDX in leaves is 0 and its on-chain coins \(0\) cannot board more/g) || []).length, 1)
  // Its on-chain coins arrive: boarded at the next look.
  let boarded = []
  for (let i = 0; i < 40 && !boarded.length; i++) {
    const st = JSON.parse(fs.readFileSync(s.stateFile, 'utf8'))
    if (!st.onchain[Y]) { st.onchain[Y] = '100000000000000000'; fs.writeFileSync(s.stateFile, JSON.stringify(st)) }
    await new Promise(r => setTimeout(r, 100))
    boarded = s.commands().filter(c => c[0] === 'board' && c[1] === Y)
  }
  assert.equal(boarded.length, 1)
})

test('without a leaf wallet, a receive request is refused and the page offers none', async t => {
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...base(), FAUCET_PORT: String(port), FAUCET_CLI: '/bin/echo', FAUCET_DATADIR: '/nowhere' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  await new Promise(resolve => child.stdout.on('data', d => { if (String(d).includes('listening')) resolve() }))
  const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: request() }) })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /does not pay receive requests/)
  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  assert.doesNotMatch(page, /arca|leaf|leaves|receive request/i)
})
