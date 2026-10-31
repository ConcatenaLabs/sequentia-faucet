#!/usr/bin/env node
'use strict'
// A stand-in for the `arca` command line in the server's tests: it answers
// info, sync, balance, board and send as the leaf wallet does, records every
// command it is given, and keeps its balance in a state file.
//
//   FAKE_ARCA_STATE     the state file (and <state>.log, one command a line)
//   FAKE_ARCA_OPERATOR  the operator key its wallet is on
//   FAKE_ARCA_MEDIAN    the chain's median time
//   FAKE_ARCA_NEXT      seconds from now to the next sync the schedule asks
//   FAKE_ARCA_LIVE      what its wallet holds of X in leaves at first (atoms)
//   FAKE_ARCA_SEND_MEDIAN  the median time a send checks a lapse against, when
//                       the chain has moved on since the faucet's last reading
const fs = require('node:fs')
const stateFile = process.env.FAKE_ARCA_STATE
const X = '750627c5778222a49fc785933f4636964f010092b460b9bd16bf8c424e14366f'
const Y = '7fb7b8b9c62e1333ff1d39293fa23c8793ac1718467cf7227766408bea1baf00'
const GENESIS = '3ce8ab6c8f9836c0cebca304f3cbed3e824e6c53f4cacd2822f6f8441eed1a3e'
const args = process.argv.slice(2)
if (args[0] !== '--datadir') { process.stderr.write('no --datadir\n'); process.exit(2) }
const [command, ...rest] = args.slice(2)
fs.appendFileSync(stateFile + '.log', JSON.stringify([command, ...rest]) + '\n')
let state
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch (e) { state = { live: { [X]: process.env.FAKE_ARCA_LIVE || '100000000000000' }, onchain: { [X]: '100000000000000' }, pending: {} } }
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
const median = Number(process.env.FAKE_ARCA_MEDIAN || 1800000000)
const out = v => { process.stdout.write(JSON.stringify(v) + '\n') }
const fail = (kind, message, extra = {}) => { out({ error: { kind, message, ...extra } }); process.exit(1) }

if (command === 'bitcoin') {
  // The Bitcoin side, as Bark answers: `balance` and `send <destination> <n> sats`.
  const [, sub, dest, amount] = rest
  if (state.bark === undefined) state.bark = Number(process.env.FAKE_BARK_SATS || 5000000)
  if (sub === 'balance') out({ spendable_sat: state.bark, pending_board_sat: 0 })
  else if (sub === 'send') {
    const sats = Number(String(amount).replace(/ sats$/, ''))
    if (!(sats > 0)) { process.stderr.write('bad amount ' + amount + '\n'); process.exit(1) }
    if (sats > state.bark) { process.stderr.write('Error: Insufficient money available\n'); process.exit(1) }
    state.bark -= sats
    save()
    out(dest.startsWith('tark1') ? { amount_sat: sats } : { txid: 'c'.repeat(64) })
  } else { process.stderr.write('unknown bitcoin command ' + sub + '\n'); process.exit(2) }
} else if (command === 'info') {
  out({
    operator: process.env.FAKE_ARCA_OPERATOR, genesis_hash: GENESIS, tip: { height: 10, median_time: median },
    server_info: { assets: [{ asset: X, min_leaf: '1000' }, { asset: Y, min_leaf: '1000' }] }
  })
} else if (command === 'sync') {
  // A pending board is final by the next sync.
  for (const [a, v] of Object.entries(state.pending)) state.live[a] = (BigInt(state.live[a] || 0) + BigInt(v)).toString()
  state.pending = {}
  save()
  out({ schedule: { now: median, next_sync_at: median + Number(process.env.FAKE_ARCA_NEXT || 3600) } })
} else if (command === 'balance') {
  const arca = {}
  for (const a of new Set([...Object.keys(state.live), ...Object.keys(state.pending)])) {
    arca[a] = {}
    if (state.live[a]) arca[a].live = state.live[a]
    if (state.pending[a]) arca[a].pending = state.pending[a]
  }
  out({ arca, sequentia_onchain: state.onchain })
} else if (command === 'board') {
  const [asset, amount] = rest
  if (BigInt(state.onchain[asset] || 0) < BigInt(amount)) fail('refused', 'refused: not enough on-chain coins')
  state.onchain[asset] = (BigInt(state.onchain[asset]) - BigInt(amount)).toString()
  state.pending[asset] = amount
  save()
  out({ leaf_id: 'b'.repeat(64), state: 'pending' })
} else if (command === 'send') {
  const [request, , amount, , asset] = rest
  const r = JSON.parse(Buffer.from(request.slice(request.indexOf(':') + 1), 'hex').toString())
  const now = Number(process.env.FAKE_ARCA_SEND_MEDIAN || median)
  if (r.until <= now) fail('refused', `refused: the request lapsed at ${r.until} (a median time; the chain's is ${now}): ask the receiver for a new one`)
  if (BigInt(state.live[asset] || 0) < BigInt(amount)) fail('refused', `refused: not enough coins of asset ${asset}`)
  state.live[asset] = (BigInt(state.live[asset]) - BigInt(amount)).toString()
  save()
  out({ transfer: 'c'.repeat(64), paid: amount })
} else {
  fail('parse', 'no command ' + command)
}
