'use strict'
// Leaf payouts: the faucet pays a test asset into a receive request, out of
// round, from a wallet of its own on an Arca operator (the `arca` command
// line), instead of to an address on the chain.
//
// The leaf wallet is the faucet's alone: never the drip covenant's reserve and
// never the treasury. It is funded by boarding its own on-chain coins, which
// the operator sends it like any other address; the faucet boards more by
// itself when what it holds in leaves runs low. It runs `arca sync` on the
// schedule the library gives (`schedule.next_sync_at`, never more than an hour
// apart here), which reads its mailbox, moves its boards and refreshes its
// coins before their exit deadline, so the wallet keeps itself alive.
//
// Only one `arca` command runs at a time: the wallet is one store.
const { execFile } = require('child_process')

const HEX64 = /^[0-9a-f]{64}$/

function toAtoms (coins) {
  const [w, f = ''] = String(coins).split('.')
  if (!/^[0-9]+$/.test(w) || !/^[0-9]{0,8}$/.test(f)) throw new Error('not an amount: ' + coins)
  return (BigInt(w) * 100000000n + BigInt((f + '00000000').slice(0, 8))).toString()
}
function toCoins (atoms) {
  const n = BigInt(atoms)
  const frac = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '')
  return (n / 100000000n).toString() + (frac ? '.' + frac : '')
}

// A refusal for the caller, with its HTTP status.
const refuse = (status, error) => Object.assign(new Error(error), { status })

// A receive request as a wallet hands it out: a prefix word, a colon, and the
// hex of its JSON, which says it is one (`kind: "request"`, or, made by an
// older wallet, `arca_request: 1`).
function decode (text) {
  const s = String(text || '').trim()
  if (s.length > 4096) throw refuse(400, 'The receive request is too long.')
  const i = s.indexOf(':')
  if (i < 1 || !/^[A-Za-z0-9-]+$/.test(s.slice(0, i))) throw refuse(400, 'Not a receive request: it has no prefix.')
  const h = s.slice(i + 1)
  if (!/^([0-9a-f]{2})+$/.test(h)) throw refuse(400, 'Not a receive request: it is not hex after its prefix.')
  let v
  try { v = JSON.parse(Buffer.from(h, 'hex').toString('utf8')) } catch (e) { throw refuse(400, 'Not a receive request: it holds no JSON.') }
  if (!v || typeof v !== 'object' || (v.kind !== 'request' && v.arca_request !== 1)) throw refuse(400, 'Not a receive request.')
  for (const k of ['operator', 'genesis_hash', 'owner', 'mailbox']) {
    if (!HEX64.test(v[k] || '')) throw refuse(400, `The receive request has no ${k}.`)
  }
  if (v.asset !== undefined && !HEX64.test(v.asset)) throw refuse(400, 'The receive request names an asset that is not an asset id.')
  if (v.until !== undefined && !Number.isSafeInteger(v.until)) throw refuse(400, 'The receive request\'s lapse is not a time.')
  if (v.value !== undefined && !/^[0-9]{1,19}$/.test(String(v.value))) throw refuse(400, 'The receive request\'s value is not an amount.')
  return v
}

function init (cfg) {
  const { arca, datadir, operator, assets, amountFor, syncMinMs = 60000, syncMaxMs = 3600000, low = 5, board = 20, log = console } = cfg
  const run = (args, timeout = 120000) => new Promise(resolve => {
    execFile(arca, ['--datadir', datadir, ...args], { timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      let out = null
      try { out = JSON.parse(stdout) } catch (e) {}
      resolve({ err, out, stderr: String(stderr || '') })
    })
  })
  // One command at a time, in the order asked.
  let queue = Promise.resolve()
  const serial = f => { const p = queue.then(f, f); queue = p.catch(() => {}); return p }
  let busy = false

  // What the leaf wallet last said of itself: its chain, its operator, the
  // chain's median time, and the assets the operator serves now.
  const state = { genesis: null, operator: null, medianTime: 0, served: new Map(), ready: false, error: 'not read yet', next: null }

  async function readInfo () {
    const r = await run(['info'])
    if (!r.out || r.out.error) { state.error = 'arca info: ' + ((r.out && r.out.error && r.out.error.message) || r.stderr.trim().split('\n').pop()); return }
    const i = r.out
    if (i.operator !== operator) {
      state.ready = false
      state.error = `the leaf wallet is on operator ${i.operator}, not the configured ${operator}`
      return
    }
    state.genesis = i.genesis_hash
    state.operator = i.operator
    state.medianTime = (i.tip && i.tip.median_time) || state.medianTime
    const served = (i.server_info && i.server_info.assets) || null
    if (served) state.served = new Map(served.map(a => [a.asset, a]))
    state.ready = true
    state.error = null
  }

  // Keeps each asset's leaves at `low` payouts or more, boarding `board`
  // payouts from the wallet's on-chain coins when it has them. A board waits
  // for its transaction to be final before its coin can pay, so an asset
  // with a board pending is left alone. Returns true while an asset is low:
  // a board is pending, or one is waiting for on-chain coins. The wallet's
  // own schedule says nothing of either, so the faucet looks again soon
  // rather than at its longest interval.
  const short = new Set()
  async function topUp () {
    if (!low || !board) return false
    // The leaf wallet's own balance only: Bark, which holds the Bitcoin side,
    // lets one process at a time open its wallet, and btc.js runs it.
    const r = await run(['balance', '--without-bitcoin'])
    if (!r.out || r.out.error) { log.error('leaf wallet balance: ' + ((r.out && r.out.error && r.out.error.message) || r.stderr.trim())); return true }
    let wanting = false
    for (const [label, id] of assets) {
      let pay
      try { pay = BigInt(toAtoms(amountFor(label))) } catch (e) { continue }
      const held = (r.out.arca && r.out.arca[id]) || {}
      const spendable = BigInt(held.live || 0) + BigInt(held['operator-confirmed'] || 0)
      if (spendable >= pay * BigInt(low)) { short.delete(label); continue }
      wanting = true
      if (BigInt(held.pending || 0) > 0n) continue
      const onchain = BigInt((r.out.sequentia_onchain && r.out.sequentia_onchain[id]) || 0)
      // What is left on the chain pays the board's fee, in the asset boarded.
      const amount = [pay * BigInt(board), onchain * 9n / 10n].reduce((a, b) => (a < b ? a : b))
      if (amount < pay) {
        // Said once, not at every look.
        if (!short.has(label)) log.error(`leaf wallet: ${label} in leaves is ${toCoins(spendable)} and its on-chain coins (${toCoins(onchain)}) cannot board more; fund ${datadir} on-chain`)
        short.add(label)
        continue
      }
      short.delete(label)
      const b = await run(['board', id, amount.toString()])
      if (!b.out || b.out.error) log.error(`leaf wallet: boarding ${toCoins(amount)} ${label}: ${(b.out && b.out.error && b.out.error.message) || b.stderr.trim()}`)
      else log.log(`leaf wallet: boarded ${toCoins(amount)} ${label}`)
    }
    return wanting
  }

  // One sync, the wallet's info and a top-up; when the next sync is due.
  async function tick () {
    let wait = syncMaxMs
    await serial(async () => {
      const s = await run(['sync'], 600000)
      if (s.out && s.out.schedule) {
        const sc = s.out.schedule
        if (sc.next_sync_at !== null && sc.next_sync_at !== undefined && sc.now) wait = (sc.next_sync_at - sc.now) * 1000
        const moved = ['participations', 'refreshed', 'released'].filter(k => Array.isArray(s.out[k]) && s.out[k].length)
        if (moved.length || sc.due) log.log(`leaf wallet: synced (${moved.join(', ') || 'due'}); next sync at median time ${sc.next_sync_at}`)
      } else {
        log.error('leaf wallet sync: ' + ((s.out && s.out.error && s.out.error.message) || s.stderr.trim().split('\n').pop()))
        wait = syncMinMs
      }
      await readInfo()
      if (await topUp()) wait = Math.min(wait, syncMinMs)
    })
    wait = Math.min(Math.max(wait, syncMinMs), syncMaxMs)
    state.next = Date.now() + wait
    return wait
  }

  let timer = null
  function start () {
    const loop = () => tick().then(w => { timer = setTimeout(loop, w); timer.unref() })
      .catch(e => { log.error('leaf wallet: ' + e.message); timer = setTimeout(loop, syncMinMs); timer.unref() })
    loop()
  }

  // Checks a decoded request against the faucet's operator, its chain, the
  // asset asked for and its lapse; returns the atoms to pay.
  function check (req, label) {
    if (!state.ready) throw refuse(503, 'The faucet cannot pay receive requests now; please try again later.')
    const id = assets.get(label)
    if (!id) throw refuse(400, `The faucet does not pay ${label} into receive requests.`)
    if (req.operator !== operator) throw refuse(400, `The receive request is for operator ${req.operator}; this faucet pays through operator ${operator} only.`)
    if (req.genesis_hash !== state.genesis) throw refuse(400, 'The receive request is for another chain.')
    if (req.asset !== undefined && req.asset !== id) throw refuse(400, `The receive request asks for asset ${req.asset}, not ${label} (${id}).`)
    const served = state.served.get(id)
    if (!served) throw refuse(400, `The operator does not serve ${label} (${id}).`)
    if (req.until === undefined) throw refuse(400, 'The receive request names no lapse; ask the wallet for a new one.')
    if (req.until <= state.medianTime + 60) throw refuse(400, `The receive request lapsed at ${req.until} (a median time; the chain's is ${state.medianTime}); ask the wallet for a new one.`)
    let atoms = BigInt(toAtoms(amountFor(label)))
    if (req.value !== undefined && BigInt(req.value) < atoms) atoms = BigInt(req.value)
    if (served.min_leaf !== undefined && atoms < BigInt(served.min_leaf)) throw refuse(400, `The receive request asks ${req.value}, below the operator's smallest leaf in ${label}, ${served.min_leaf}.`)
    return { id, atoms: atoms.toString() }
  }

  // Pays the request, out of round. The wallet checks it all again (the
  // lapse against the chain, the operator, the asset) before it signs.
  function pay (text, req, label) {
    const { id, atoms } = check(req, label)
    if (busy) throw refuse(429, 'The faucet is paying another request; please try again in a moment.')
    busy = true
    return serial(async () => {
      try {
        const r = await run(['send', text, '--amount', atoms, '--asset', id])
        if (r.out && !r.out.error) {
          log.log(`leaf wallet: paid ${toCoins(atoms)} ${label} into a receive request of owner ${req.owner}`)
          return { asset: label, asset_id: id, amount: toCoins(atoms), atoms, payment: r.out }
        }
        const e = (r.out && r.out.error) || { message: r.stderr.trim().split('\n').pop() || 'the leaf wallet did not answer' }
        const m = String(e.message || '')
        if (/lapsed/.test(m) || e.code === 'request_lapsed') throw refuse(400, m)
        if (/not enough|insufficient|no coin|in live coins/i.test(m)) throw refuse(503, `The faucet has no ${label} in leaves to pay now; please try again later.`)
        if (e.kind === 'server_refused' && e.status >= 400 && e.status < 500) throw refuse(400, m)
        throw refuse(502, m)
      } finally { busy = false }
    })
  }

  return { decode, check, pay, start, tick, state }
}

module.exports = { init, decode, toAtoms, toCoins }
