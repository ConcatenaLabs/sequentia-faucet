#!/usr/bin/env node
'use strict'
// A stand-in for the `arca` command line in the server's tests: it answers
// info, sync, balance, coin-places, board, send and participate as the leaf
// wallet does, records every command it is given, and keeps its coins in a
// state file.
//
// Each coin has a depth (`hops`): reassignments since a round or a board. A
// send spends the largest coins first and its change is one deeper than the
// deepest coin it spends; the operator co-signs no new coin deeper than its
// depth limit, and refuses as it does (`server_refused`, code `depth_limit`).
// `participate --leaf` gives coins up for the next round, which the next sync
// finishes: each asset's coins come back as one coin of no depth. A send its
// live coins fall short for takes back the refreshes that wait first, as the
// library does, and pays from their coins too.
//
//   FAKE_ARCA_STATE     the state file (and <state>.log, one command a line)
//   FAKE_ARCA_OPERATOR  the operator key its wallet is on
//   FAKE_ARCA_MEDIAN    the chain's median time
//   FAKE_ARCA_NEXT      seconds from now to the next sync the schedule asks
//   FAKE_ARCA_LIVE      what its wallet holds of X in leaves at first (atoms)
//   FAKE_ARCA_HOPS      the depth of that first coin (0)
//   FAKE_ARCA_DEPTH_LIMIT  the operator's depth limit (5); `none` publishes none
//   <state>.hold       while it exists, no round is built: refreshes wait
//   FAKE_ARCA_FUNDABLE  what the operator says it can fund of X for refreshes
//                       (unpublished unless set; <state>.fundable overrides)
//   FAKE_ARCA_SETTLE_FIRST  1: a send answers as a library with arca #785
//                       does: a coin at the limit leaves the selection, and a
//                       spend that then falls short is refused `settle_first`
//                       naming those coins
//   FAKE_ARCA_SEND_MEDIAN  the median time a send checks a lapse against, when
//                       the chain has moved on since the faucet's last reading
//   FAKE_ARCA_SYNC_MS, FAKE_ARCA_SEND_MS  how long a sync and a send take
//
// Each command is also written to <state>.times with when it started and
// ended (milliseconds), for the tests of what waits for what.
const fs = require('node:fs')
const stateFile = process.env.FAKE_ARCA_STATE
const X = '750627c5778222a49fc785933f4636964f010092b460b9bd16bf8c424e14366f'
const Y = '7fb7b8b9c62e1333ff1d39293fa23c8793ac1718467cf7227766408bea1baf00'
const GENESIS = '3ce8ab6c8f9836c0cebca304f3cbed3e824e6c53f4cacd2822f6f8441eed1a3e'
const args = process.argv.slice(2)
if (args[0] !== '--datadir') { process.stderr.write('no --datadir\n'); process.exit(2) }
const [command, ...rest] = args.slice(2)
fs.appendFileSync(stateFile + '.log', JSON.stringify([command, ...rest]) + '\n')
const began = Date.now()
process.on('exit', () => fs.appendFileSync(stateFile + '.times', JSON.stringify({ command, began, ended: Date.now() }) + '\n'))
const sleep = ms => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
let state
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch (e) {
  state = { coins: [], onchain: { [X]: '100000000000000' }, pending: {}, parts: [], n: 0 }
  const live = process.env.FAKE_ARCA_LIVE || '100000000000000'
  if (BigInt(live) > 0n) state.coins.push({ leaf_id: '0'.repeat(63) + '1', asset: X, value: live, hops: Number(process.env.FAKE_ARCA_HOPS || 0), state: 'live', kind: 'board' })
  state.n = 1
}
// Written whole, by a rename, so a test reading the file never sees half of it.
const save = () => { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state)); fs.renameSync(stateFile + '.tmp', stateFile) }
const LIMIT = process.env.FAKE_ARCA_DEPTH_LIMIT === 'none' ? null : Number(process.env.FAKE_ARCA_DEPTH_LIMIT || 5)
const coin = (asset, value, hops, kind) => {
  state.n++
  const c = { leaf_id: state.n.toString(16).padStart(64, '0'), asset, value: String(value), hops, state: 'live', kind }
  state.coins.push(c)
  return c
}
const live = asset => state.coins.filter(c => c.asset === asset && c.state === 'live')
const sum = cs => cs.reduce((a, c) => a + BigInt(c.value), 0n)
const median = Number(process.env.FAKE_ARCA_MEDIAN || 1800000000)
const out = v => { process.stdout.write(JSON.stringify(v) + '\n') }
const fail = (kind, message, extra = {}) => { out({ error: { kind, message, ...extra } }); process.exit(1) }

if (command === 'bitcoin') {
  // The Bitcoin side, as Bark answers: `balance` and `send <destination> <n> sats`.
  const [, sub, dest, amount] = rest
  if (state.bark === undefined) state.bark = Number(process.env.FAKE_BARK_SATS || 5000000)
  // FAKE_BARK_HELD: the first sends find the wallet held by another process, as Bark says.
  if (sub === 'send' && Number(process.env.FAKE_BARK_HELD || 0) > (state.held || 0)) {
    state.held = (state.held || 0) + 1; save()
    process.stderr.write('Error: failed to lock wallet database: another process holds it\n'); process.exit(1)
  }
  if (sub === 'balance') out({ spendable_sat: state.bark, pending_board_sat: 0 })
  else if (sub === 'send') {
    const sats = Number(String(amount).replace(/ sats$/, ''))
    if (!(sats > 0)) { process.stderr.write('bad amount ' + amount + '\n'); process.exit(1) }
    if (sats > state.bark) { process.stderr.write('Error: Insufficient money available\n'); process.exit(1) }
    // FAKE_BARK_EXPIRED: the wallet's coins are past their Ark expiry, as the operator answers.
    if (process.env.FAKE_BARK_EXPIRED) {
      process.stderr.write("Error: code: 'Client specified an invalid argument', message: \"bad user input: vtxo " + 'ab'.repeat(32) + ':0 expired at height 160402 (tip = 161130)\"\n')
      process.exit(1)
    }
    state.bark -= sats
    save()
    out(dest.startsWith('tark1') ? { amount_sat: sats } : { txid: 'c'.repeat(64) })
  } else { process.stderr.write('unknown bitcoin command ' + sub + '\n'); process.exit(2) }
} else if (command === 'info') {
  // What the operator can fund of X for refreshes now: FAKE_ARCA_FUNDABLE, or
  // the file <state>.fundable when a test changes it; unpublished unless set.
  let fundable = process.env.FAKE_ARCA_FUNDABLE
  try { fundable = fs.readFileSync(stateFile + '.fundable', 'utf8').trim() } catch (e) {}
  out({
    operator: process.env.FAKE_ARCA_OPERATOR, genesis_hash: GENESIS, tip: { height: 10, median_time: median },
    server_info: {
      assets: [{ asset: X, min_leaf: '1000', ...(fundable ? { fundable } : {}) }, { asset: Y, min_leaf: '1000' }],
      ...(LIMIT === null ? {} : { depth_limit: LIMIT })
    }
  })
} else if (command === 'sync') {
  sleep(Number(process.env.FAKE_ARCA_SYNC_MS || 0))
  // A pending board is final by the next sync, and so is the round of
  // every refresh that waits: each asset's coins given up come back as one
  // coin of no depth.
  // While <state>.hold exists, the operator builds no round: refreshes wait.
  const changed = Object.keys(state.pending).length > 0 || (state.parts.length > 0 && !fs.existsSync(stateFile + '.hold'))
  for (const [a, v] of Object.entries(state.pending)) coin(a, v, 0, 'board')
  state.pending = {}
  const refreshed = []
  if (!fs.existsSync(stateFile + '.hold')) {
    for (const p of state.parts) {
      const given = state.coins.filter(c => p.coins.includes(c.leaf_id) && c.state === 'given')
      for (const c of given) c.state = 'spent'
      if (given.length) refreshed.push(coin(p.asset, sum(given), 0, 'round').leaf_id)
    }
    state.parts = []
  }
  if (changed || !fs.existsSync(stateFile)) save()
  out({ schedule: { now: median, next_sync_at: median + Number(process.env.FAKE_ARCA_NEXT || 3600) }, ...(refreshed.length ? { refreshed } : {}) })
} else if (command === 'balance') {
  // By standing, as the wallet says it: a coin paid out of round (a
  // transfer, its change too) is `operator-confirmed`, one given up in a
  // refresh that waits is `given`.
  const arca = {}
  const add = (a, k, v) => { arca[a] = arca[a] || {}; arca[a][k] = (BigInt(arca[a][k] || 0) + BigInt(v)).toString() }
  for (const c of state.coins) {
    if (c.state === 'live') add(c.asset, c.kind === 'transfer' ? 'operator-confirmed' : 'live', c.value)
    else if (c.state === 'given') add(c.asset, 'given', c.value)
  }
  for (const [a, v] of Object.entries(state.pending)) add(a, 'pending', v)
  out({ arca, sequentia_onchain: state.onchain })
} else if (command === 'coin-places') {
  const held = state.coins.filter(c => c.state !== 'spent')
  out({
    instant_limit: null,
    coins: held.map(c => ({ leaf_id: c.leaf_id, asset: c.asset, value: c.value, state: c.state, kind: c.kind, lineage: 'own', place: 'settled', hops: c.hops })),
    totals: {},
    spendable: {}
  })
} else if (command === 'participate') {
  const leaves = []
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--leaf') leaves.push(rest[++i])
  if (!leaves.length) fail('parse', 'the fake refreshes named coins only')
  const given = leaves.map(id => state.coins.find(c => c.leaf_id === id))
  const bad = leaves.find((id, i) => !given[i] || given[i].state !== 'live')
  if (bad) fail('refused', `refused: coin ${bad} is not live`)
  const participations = []
  for (const a of new Set(given.map(c => c.asset))) {
    const mine = given.filter(c => c.asset === a)
    for (const c of mine) c.state = 'given'
    state.n++
    const pid = state.n.toString(16).padStart(64, 'f')
    state.parts.push({ pid, asset: a, coins: mine.map(c => c.leaf_id) })
    participations.push({ participation: pid, asset: a, given: mine.map(c => c.leaf_id) })
  }
  save()
  out({ participations })
} else if (command === 'board') {
  const [asset, amount] = rest
  if (BigInt(state.onchain[asset] || 0) < BigInt(amount)) fail('refused', 'refused: not enough on-chain coins')
  state.onchain[asset] = (BigInt(state.onchain[asset]) - BigInt(amount)).toString()
  state.pending[asset] = (BigInt(state.pending[asset] || 0) + BigInt(amount)).toString()
  save()
  out({ leaf_id: 'b'.repeat(64), state: 'pending' })
} else if (command === 'send') {
  sleep(Number(process.env.FAKE_ARCA_SEND_MS || 0))
  const [request, , amount, , asset] = rest
  const r = JSON.parse(Buffer.from(request.slice(request.indexOf(':') + 1), 'hex').toString())
  const now = Number(process.env.FAKE_ARCA_SEND_MEDIAN || median)
  if (r.until <= now) fail('refused', `refused: the request lapsed at ${r.until} (a median time; the chain's is ${now}): ask the receiver for a new one`)
  const need = BigInt(amount)
  const settleFirst = process.env.FAKE_ARCA_SETTLE_FIRST === '1'
  const usable = () => live(asset).filter(c => !(settleFirst && LIMIT !== null && c.hops >= LIMIT))
  // Live coins short: every refresh of the asset that waits is taken back first.
  if (sum(usable()) < need) {
    for (const p of state.parts.filter(p => p.asset === asset)) {
      for (const c of state.coins) if (p.coins.includes(c.leaf_id) && c.state === 'given') c.state = 'live'
    }
    state.parts = state.parts.filter(p => p.asset !== asset)
    save()
  }
  if (sum(usable()) < need) {
    const deep = live(asset).filter(c => LIMIT !== null && c.hops >= LIMIT)
    if (settleFirst && deep.length && sum(live(asset)) >= need) {
      fail('settle_first', `the coins of asset ${asset} that would pay ${amount} must go through a round first`, { asset, coins: deep.map(c => c.leaf_id) })
    }
    fail('refused', `refused: not enough coins of asset ${asset}`)
  }
  // The largest coins first.
  const chosen = []
  for (const c of usable().sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1))) {
    if (sum(chosen) >= need) break
    chosen.push(c)
  }
  const hops = 1 + Math.max(...chosen.map(c => c.hops))
  if (LIMIT !== null && hops > LIMIT) {
    fail('server_refused', `the server refused cosign_transfer (422 depth_limit): the new coins would be ${hops} reassignments from a round or a board; the limit is ${LIMIT}: refresh in a round first`, { code: 'depth_limit', status: 422 })
  }
  for (const c of chosen) c.state = 'spent'
  const change = sum(chosen) - need
  if (change > 0n) coin(asset, change, hops, 'transfer')
  save()
  out({ transfer: 'c'.repeat(64), paid: amount })
} else {
  fail('parse', 'no command ' + command)
}
