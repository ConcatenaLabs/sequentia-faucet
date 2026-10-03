#!/usr/bin/env node
'use strict'
// A stand-in for faucet-drip in the server's tests: it answers as the tool
// does, records the arguments it was given, and pays once, then reports the
// interval as not passed (exit 3), as the tool does until the next interval.
//
// Like the tool, its status and its drip each scan the node's UTXO set, and the
// node runs one scan at a time: with FAKE_DRIP_SCAN_MS set, a scan takes that
// long and holds a lock, and a second scan meanwhile fails as scantxoutset
// does. With FAKE_DRIP_EVERY_TIME set, every drip pays.
const fs = require('node:fs')
const state = process.env.FAKE_DRIP_STATE
const scanMs = Number(process.env.FAKE_DRIP_SCAN_MS || 0)
const [command, ...args] = process.argv.slice(2)
fs.appendFileSync(state + '.log', JSON.stringify([command, ...args]) + '\n')

function scan () {
  if (!scanMs) return
  try { fs.writeFileSync(state + '.scan', String(process.pid), { flag: 'wx' }) } catch (e) {
    fs.appendFileSync(state + '.refused', command + '\n')
    process.stderr.write('faucet-drip: sequentia-cli scantxoutset: error code: -8\nerror message:\nScan already in progress, use action "abort" or "status"\n')
    process.exit(1)
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, scanMs)
  fs.unlinkSync(state + '.scan')
}

if (command === 'status') {
  scan()
  process.stdout.write(JSON.stringify({ tier_now: 5000000000000, reserves: [] }) + '\n')
} else if (command === 'drip') {
  scan()
  if (fs.existsSync(state) && !process.env.FAKE_DRIP_EVERY_TIME) {
    process.stderr.write('faucet-drip: the interval has not passed: the reserve can drip in 400 seconds\n')
    process.exit(3)
  }
  fs.writeFileSync(state, 'paid')
  process.stdout.write(JSON.stringify({ txid: 'ab'.repeat(32), amount: 5000000000000, fee: 581 }) + '\n')
} else {
  process.stderr.write('faucet-drip: unknown command\n')
  process.exit(1)
}
