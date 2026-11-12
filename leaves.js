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
// It also keeps its coins shallow. Each payout spends the change of the one
// before, one reassignment deeper each time, and the operator co-signs no new
// coin more reassignments from a round or a board than the depth limit it
// publishes (`server_info.depth_limit`). So between payouts, in a quiet
// moment, a coin within two reassignments of that limit (by the library's
// rule: hops + 3 > limit) is given up in the operator's next round
// (`arca participate --leaf`), and comes back as a coin of no depth. A
// payout refused for depth (code `depth_limit`, or kind `settle_first` from
// a library that names the coins itself) starts that refresh at once. While
// an asset's coins wait for their round, a payout of it goes out only if the
// asset's other live coins cover it: otherwise the wallet would take the
// refresh back to pay with the deep coin, and the operator refuse it again.
//
// Only one `arca` command runs at a time: the wallet is one store. A payout
// goes before the wallet's upkeep: it waits at most for the one upkeep
// command already running, never for upkeep queued behind it, and a sync
// (the one long upkeep command) does not start while payouts wait or within
// `payQuietMs` of the last one, since a wallet asks for several assets in a
// row. Payouts asked together wait their turn rather than being refused.
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
const refuse = (status, error, reason) => Object.assign(new Error(error), reason ? { status, reason } : { status })

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
  const { payQuietMs = 10000, maxWaiting = 20, now = Date.now } = cfg
  // How many payouts of an asset (its leaves, those boarding and what its on-chain coins can
  // still board) make it low: said in the log once, and by `left`, before it runs out.
  const { warn = 8 } = cfg
  // Payouts still possible from a coin before it is refreshed: the library's
  // rule, a coin with hops + 3 > limit (two reassignments of the limit).
  const ROOM = 3
  const run = (args, timeout = 120000) => new Promise(resolve => {
    execFile(arca, ['--datadir', datadir, ...args], { timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      let out = null
      try { out = JSON.parse(stdout) } catch (e) {}
      resolve({ err, out, stderr: String(stderr || '') })
    })
  })
  // One command at a time, payouts first. Each job is { f, what, at, ok, no };
  // `doing` is the job running now, with when it started.
  const payouts = []
  const upkeeps = []
  let doing = null
  let lastPaid = 0
  let later = null
  const secs = ms => (ms / 1000).toFixed(1)
  function pump () {
    if (doing) return
    let job = payouts.shift()
    if (!job && upkeeps.length) {
      // A sync waits for a quiet moment: no payout waiting, none just made.
      const quiet = upkeeps[0].long ? lastPaid + payQuietMs - now() : 0
      if (quiet > 0) {
        if (!later) { later = setTimeout(() => { later = null; pump() }, quiet); later.unref() }
        return
      }
      job = upkeeps.shift()
    }
    if (!job) return
    doing = { ...job, started: now() }
    Promise.resolve().then(() => job.f(doing)).then(job.ok, job.no).finally(() => {
      if (job.payout) lastPaid = now()
      doing = null
      pump()
    })
  }
  const queue = (list, job) => new Promise((ok, no) => { list.push({ ...job, at: now(), ok, no }); pump() })
  const upkeep = (what, f, long = false) => queue(upkeeps, { what, f, long })

  // What the leaf wallet last said of itself: its chain, its operator, the
  // chain's median time, and the assets the operator serves now.
  const state = { genesis: null, operator: null, medianTime: 0, served: new Map(), ready: false, error: 'not read yet', next: null, depthLimit: null }

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
    // The operator's depth limit, as it publishes it; none when it does not.
    const limit = i.server_info && i.server_info.depth_limit
    state.depthLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : null
    state.ready = true
    state.error = null
  }

  // Keeps each asset's leaves at `low` payouts or more, boarding `board`
  // payouts from the wallet's on-chain coins when it has them. A board waits
  // for its transaction to be final, which a sync sees, before its coin can
  // pay, so an asset with a board pending is left alone. -> { boarding, short }:
  // whether a board is pending (the next sync comes soon, to take it up) and
  // whether an asset is low with too few on-chain coins to board (its balance
  // is read again soon, with no sync: on-chain coins show without one).
  const short = new Set()
  // Each asset's payouts as last read: { leaves, boarding, onchain, low }.
  const left = new Map()
  const warned = new Set()
  function count (label, pay, spendable, pending, onchain) {
    const c = { leaves: Number(spendable / pay), boarding: Number(pending / pay), onchain: Number(onchain * 9n / 10n / pay) }
    c.low = c.leaves + c.boarding + c.onchain < warn
    left.set(label, c)
    if (c.low && !warned.has(label)) {
      warned.add(label)
      log.error(`leaf wallet: ${label} runs low: ${c.leaves} payout(s) in leaves, ${c.boarding} boarding, ${c.onchain} more on chain (warned under ${warn}); fund ${datadir} on-chain before it runs out`)
    } else if (!c.low && warned.has(label)) {
      warned.delete(label)
      log.log(`leaf wallet: ${label} holds ${c.leaves + c.boarding + c.onchain} payouts again`)
    }
  }
  async function topUp () {
    const res = { boarding: false, short: false }
    if (!low || !board) return res
    // The leaf wallet's own balance only: Bark, which holds the Bitcoin side,
    // lets one process at a time open its wallet, and btc.js runs it.
    const r = await upkeep('balance', () => run(['balance', '--without-bitcoin']))
    if (!r.out || r.out.error) { log.error('leaf wallet balance: ' + ((r.out && r.out.error && r.out.error.message) || r.stderr.trim())); res.short = true; return res }
    for (const [label, id] of assets) {
      let pay
      try { pay = BigInt(toAtoms(amountFor(label))) } catch (e) { continue }
      const held = (r.out.arca && r.out.arca[id]) || {}
      // A coin given up in a refresh that waits for its round is back by
      // the next sync: counted, never boarded for.
      const spendable = BigInt(held.live || 0) + BigInt(held['operator-confirmed'] || 0) + BigInt(held.given || 0)
      count(label, pay, spendable, BigInt(held.pending || 0), BigInt((r.out.sequentia_onchain && r.out.sequentia_onchain[id]) || 0))
      if (spendable >= pay * BigInt(low)) { short.delete(label); continue }
      if (BigInt(held.pending || 0) > 0n) { res.boarding = true; continue }
      const onchain = BigInt((r.out.sequentia_onchain && r.out.sequentia_onchain[id]) || 0)
      // What is left on the chain pays the board's fee, in the asset boarded.
      const amount = [pay * BigInt(board), onchain * 9n / 10n].reduce((a, b) => (a < b ? a : b))
      if (amount < pay) {
        res.short = true
        // Said once, not at every look.
        if (!short.has(label)) log.error(`leaf wallet: ${label} in leaves is ${toCoins(spendable)} and its on-chain coins (${toCoins(onchain)}) cannot board more; fund ${datadir} on-chain`)
        short.add(label)
        continue
      }
      short.delete(label)
      const b = await upkeep('board', () => run(['board', id, amount.toString()]))
      if (!b.out || b.out.error) { res.short = true; log.error(`leaf wallet: boarding ${toCoins(amount)} ${label}: ${(b.out && b.out.error && b.out.error.message) || b.stderr.trim()}`) }
      else { res.boarding = true; log.log(`leaf wallet: boarded ${toCoins(amount)} ${label}`) }
    }
    return res
  }

  // Each paid asset's coins as last read (`arca coin-places`, which reads the
  // wallet's own store and nothing on the chain): { live, settling, coins },
  // where `live` is what its live coins below the depth limit hold (what a
  // payout can spend), `settling` whether any coin waits in a refresh, and
  // `coins` each held coin's value, depth and state.
  const places = new Map()
  const ids = new Map([...assets].map(([label, id]) => [id, label]))
  async function readCoins () {
    const r = await run(['coin-places'])
    if (!r.out || r.out.error || !Array.isArray(r.out.coins)) {
      log.error('leaf wallet coins: ' + ((r.out && r.out.error && r.out.error.message) || r.stderr.trim().split('\n').pop()))
      return null
    }
    const limit = state.depthLimit
    const seen = new Map([...ids.keys()].map(id => [id, { live: 0n, settling: false, coins: [] }]))
    for (const c of r.out.coins) {
      const p = seen.get(c.asset)
      if (!p || c.channel || c.order) continue
      const hops = Number(c.hops) || 0
      p.coins.push({ leaf_id: c.leaf_id, value: String(c.value), hops, state: c.state })
      if (c.state === 'live' && (limit === null || hops < limit)) p.live += BigInt(c.value)
      if (c.state === 'given') p.settling = true
    }
    for (const [id, p] of seen) places.set(id, p)
    return seen
  }

  // One pass of keeping the coins shallow: reads the coins, and gives up in
  // the next round every live coin of a paid asset within two reassignments
  // of the depth limit, plus the coins a refusal named (`named`), or, for a
  // refusal that named none from an operator that publishes no limit, every
  // live coin of its asset paid out of round. One `arca` command at a time:
  // both run as one upkeep job. Unless `urgent`, it waits for a quiet moment
  // after the last payout, as a sync does. -> whether coins were given up.
  let shallowing = null
  let shallowAgain = null
  let refreshFailed = ''
  let refreshUnfunded = ''
  // What the operator can fund now of an asset for refreshes, by its `info`
  // row: `fundable`, within `in_flight_cap` less `in_flight` when it sets a
  // cap; null when it does not say.
  const fundable = row => {
    const n = k => (row && /^[0-9]+$/.test(String(row[k] ?? '')) ? BigInt(row[k]) : null)
    const f = n('fundable')
    if (f === null) return null
    const cap = n('in_flight_cap')
    if (cap === null) return f
    const room = cap - (n('in_flight') || 0n)
    return f < room ? f : (room > 0n ? room : 0n)
  }
  function keepShallow ({ urgent = false, named = [], asset = null } = {}) {
    if (shallowing) {
      // One pass at a time; what was asked meanwhile runs once after it.
      const a = shallowAgain || { urgent: false, named: [], assets: new Set() }
      a.urgent = a.urgent || urgent
      a.named.push(...named)
      if (asset) a.assets.add(asset)
      shallowAgain = a
      return shallowing
    }
    shallowing = upkeep('refresh', async () => {
      const seen = await readCoins()
      if (!seen) return false
      const limit = state.depthLimit
      const deep = []
      for (const [id, p] of seen) {
        for (const c of p.coins) {
          if (c.state !== 'live') continue
          if (named.includes(c.leaf_id) || (limit !== null && c.hops + ROOM > limit) ||
              (limit === null && asset === id && !named.length && c.hops > 0)) deep.push({ id, ...c })
        }
      }
      if (!deep.length) return false
      // The operator's info read again first: what it can fund changes with
      // every round, and a refresh given up on an old reading waits.
      await readInfo()
      // As far as the operator can fund it now, by the library's rule (what
      // `fundable` says a round can pay of the asset, within what its
      // in-flight cap leaves), when it publishes that: a refresh it cannot
      // fund waits, and the wallet takes it back, so it is left until it can.
      const room = new Map()
      const left = []
      const take = deep.filter(c => {
        if (!room.has(c.id)) room.set(c.id, fundable(state.served.get(c.id)))
        const r = room.get(c.id)
        if (r === null || r >= BigInt(c.value)) { if (r !== null) room.set(c.id, r - BigInt(c.value)); return true }
        left.push(c)
        return false
      })
      const unfunded = left.map(c => `${toCoins(c.value)} ${ids.get(c.id)} at ${c.hops} hops`).join(', ')
      if (unfunded && unfunded !== refreshUnfunded) log.error(`leaf wallet: not refreshing ${unfunded}: the operator cannot fund its refresh now`)
      refreshUnfunded = unfunded
      deep.splice(0, deep.length, ...take)
      if (!deep.length) return false
      const r = await run(['participate', ...deep.flatMap(c => ['--leaf', c.leaf_id])])
      const what = deep.map(c => `${toCoins(c.value)} ${ids.get(c.id)} at ${c.hops} hops`).join(', ')
      if (!r.out || r.out.error) {
        const m = (r.out && r.out.error && r.out.error.message) || r.stderr.trim().split('\n').pop()
        // Said once while it stays the same; tried again at every pass.
        if (m !== refreshFailed) log.error(`leaf wallet: refreshing ${what} (depth limit ${limit === null ? 'not published' : limit}): ${m}`)
        refreshFailed = m
        return false
      }
      refreshFailed = ''
      for (const c of deep) {
        const p = places.get(c.id)
        p.settling = true
        p.live -= BigInt(c.value)
        const listed = p.coins.find(x => x.leaf_id === c.leaf_id)
        if (listed) listed.state = 'given'
      }
      log.log(`leaf wallet: refreshing ${what} in the next round (depth limit ${limit === null ? 'not published' : limit})`)
      return true
    }, !urgent).finally(() => {
      shallowing = null
      if (shallowAgain) { const a = shallowAgain; shallowAgain = null; keepShallow({ urgent: a.urgent, named: a.named, asset: [...a.assets][0] || null }) }
    }).then(given => { if (given) wake(syncMinMs); return given })
    return shallowing
  }

  // The wallet's upkeep, one pass: a sync when one is due, its info, and a
  // top-up; -> how long until the next pass. A sync is due on the library's
  // schedule (`schedule.next_sync_at`), and within `syncMinMs` while a board
  // waits to be taken up; an asset too short to board only has its balance
  // read again at that pace.
  let nextSync = 0
  async function tick () {
    let synced = false
    if (now() >= nextSync) {
      synced = true
      let wait = syncMaxMs
      const s = await upkeep('sync', async () => {
        const t = now()
        const r = await run(['sync'], 600000)
        const took = now() - t
        if (took > 20000) {
          const steps = Object.entries((r.out && r.out.cost_by_step) || {}).map(([k, v]) => [k, (v && v.ms) || v]).filter(([, ms]) => Number(ms) >= 1000)
            .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, ms]) => `${k} ${secs(ms)} s`).join(', ')
          log.log(`leaf wallet: sync took ${secs(took)} s${steps ? ' (' + steps + ')' : ''}`)
        }
        return r
      }, true)
      if (s.out && s.out.schedule) {
        const sc = s.out.schedule
        if (sc.next_sync_at !== null && sc.next_sync_at !== undefined && sc.now) wait = (sc.next_sync_at - sc.now) * 1000
        const moved = ['participations', 'refreshed', 'released'].filter(k => Array.isArray(s.out[k]) && s.out[k].length)
        if (moved.length || sc.due) log.log(`leaf wallet: synced (${moved.join(', ') || 'due'}); next sync at median time ${sc.next_sync_at}`)
      } else {
        log.error('leaf wallet sync: ' + ((s.out && s.out.error && s.out.error.message) || s.stderr.trim().split('\n').pop()))
        wait = syncMinMs
      }
      nextSync = now() + Math.min(Math.max(wait, syncMinMs), syncMaxMs)
    }
    await upkeep('info', readInfo)
    // The coins looked at again when they can have changed outside a payout
    // (each payout looks by itself): after a sync, which takes rounds and
    // boards up and frees an asset whose refresh it finished, while a
    // refresh waits, and at the first pass.
    if (synced || !places.size || [...places.values()].some(p => p.settling)) await keepShallow()
    const t = await topUp()
    // A board, or a refresh waiting for its round, is taken up by a sync.
    const settling = [...places.values()].some(p => p.settling)
    if (t.boarding || settling) nextSync = Math.min(nextSync, now() + syncMinMs)
    let wait = nextSync - now()
    if (t.short) wait = Math.min(wait, syncMinMs)
    wait = Math.min(Math.max(wait, syncMinMs), syncMaxMs)
    state.next = now() + wait
    return wait
  }

  // The upkeep loop: one pass, then a wait. `wake(ms)` brings the next pass
  // forward to within `ms` (a refresh given up is taken up by a sync soon),
  // or, during a pass, its sync.
  let timer = null
  let due = Infinity
  let started = false
  const next = ms => { due = now() + ms; timer = setTimeout(loop, ms); timer.unref() }
  function loop () {
    timer = null
    due = Infinity
    tick().then(next).catch(e => { log.error('leaf wallet: ' + e.message); next(syncMinMs) })
  }
  function wake (ms) {
    nextSync = Math.min(nextSync, now() + ms)
    if (started && timer && due > now() + ms) { clearTimeout(timer); next(ms) }
  }
  function start () {
    started = true
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
  // lapse against the chain, the operator, the asset) before it signs. A
  // payout asked while another runs, or while the upkeep runs a command,
  // waits its turn; past `maxWaiting` payouts waiting, it is refused with a
  // 429 whose `reason` is `busy`. Every payout is logged with how long it
  // waited, behind what, and how long the send took.
  function pay (text, req, label) {
    const { id, atoms } = check(req, label)
    if (payouts.length >= maxWaiting) throw refuse(429, 'The faucet has many requests waiting; please try again in a minute.', 'busy')
    const behind = doing ? `${doing.what} (running ${secs(now() - doing.started)} s)` : 'nothing'
    const waiting = payouts.length
    return queue(payouts, {
      what: 'send',
      payout: true,
      f: async job => {
        const waited = job.started - job.at
        // While coins of the asset wait in a refresh, the wallet would take
        // that refresh back to pay from them when its other live coins fall
        // short, and the operator would refuse the deep coin again: paid only
        // when the live coins cover it, with room for the reassignment's margin.
        let p = places.get(id)
        const short = () => p && p.settling && p.live < BigInt(atoms) + BigInt(atoms) / 100n
        // Short as last read: read again (the wallet's own store, no chain),
        // since a round or a board may have brought a coin since.
        if (short()) { await readCoins(); p = places.get(id) }
        if (short()) {
          log.error(`leaf wallet: not paid ${toCoins(atoms)} ${label} into a receive request of owner ${req.owner}: its coins wait for a round (waited ${secs(waited)} s behind ${behind})`)
          throw refuse(503, `The faucet has no ${label} in leaves to pay now; please try again later.`)
        }
        const t = now()
        const r = await run(['send', text, '--amount', atoms, '--asset', id])
        const timing = `waited ${secs(waited)} s behind ${behind}${waiting ? ` and ${waiting} payout(s)` : ''}, sent in ${secs(now() - t)} s`
        if (r.out && !r.out.error) {
          log.log(`leaf wallet: paid ${toCoins(atoms)} ${label} into a receive request of owner ${req.owner} (${timing})`)
          if (p) p.live -= BigInt(atoms) + BigInt(atoms) / 100n
          // Its change is one reassignment deeper: looked at in the next quiet moment.
          keepShallow()
          return { asset: label, asset_id: id, amount: toCoins(atoms), atoms, payment: r.out }
        }
        const e = (r.out && r.out.error) || { message: r.stderr.trim().split('\n').pop() || 'the leaf wallet did not answer' }
        const m = String(e.message || '')
        log.error(`leaf wallet: not paid ${toCoins(atoms)} ${label} into a receive request of owner ${req.owner} (${timing}): ${m}`)
        // Refused for depth: by the operator (code `depth_limit`), or by a
        // library that names the coins to put through a round first (kind
        // `settle_first`). Those coins are refreshed now, in the background;
        // this payout goes on the chain, as for any leaf the faucet cannot pay.
        if (e.code === 'depth_limit' || e.kind === 'settle_first') {
          keepShallow({ urgent: true, named: Array.isArray(e.coins) ? e.coins : [], asset: id })
          throw refuse(503, `The faucet has no ${label} in leaves to pay now; please try again later.`)
        }
        if (/lapsed/.test(m) || e.code === 'request_lapsed') throw refuse(400, m)
        if (/not enough|insufficient|no coin|in live coins/i.test(m)) throw refuse(503, `The faucet has no ${label} in leaves to pay now; please try again later.`)
        if (e.kind === 'server_refused' && e.status >= 400 && e.status < 500) throw refuse(400, m)
        throw refuse(502, m)
      }
    })
  }

  // What each asset holds, in payouts, as last read, and the level that counts as low.
  // With each asset's coins: their value, depth and state, whether some wait
  // for a round, and whether a payout would go out as a leaf now.
  const holdings = () => {
    const out = {}
    for (const [label, id] of assets) {
      const c = left.get(label)
      const p = places.get(id)
      if (!c && !p) continue
      let pay = null
      try { pay = BigInt(toAtoms(amountFor(label))) } catch (e) {}
      const leafNow = !!(p && pay !== null && state.ready && state.served.has(id) && p.live >= pay + pay / 100n)
      out[label] = { ...(c || {}), ...(p ? { coins: p.coins.map(({ value, hops, state }) => ({ value: toCoins(value), hops, state })), settling: p.settling, leaf_now: leafNow } : {}) }
    }
    return { warn, depth_limit: state.depthLimit, assets: out }
  }

  // The command the wallet runs now (`send`, `sync`, `balance`...), or null.
  const busy = () => (doing ? doing.what : null)

  return { decode, check, pay, start, tick, state, holdings, doing: busy }
}

module.exports = { init, decode, toAtoms, toCoins }
