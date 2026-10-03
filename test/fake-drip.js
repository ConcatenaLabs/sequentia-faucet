#!/usr/bin/env node
'use strict'
// A stand-in for faucet-drip in the server's tests: it answers as the tool
// does, records the arguments it was given, and pays once, then reports the
// interval as not passed (exit 3), as the tool does until the next interval.
const fs = require('node:fs')
const state = process.env.FAKE_DRIP_STATE
const [command, ...args] = process.argv.slice(2)
fs.appendFileSync(state + '.log', JSON.stringify([command, ...args]) + '\n')
if (command === 'status') {
  process.stdout.write(JSON.stringify({ tier_now: 5000000000000, reserves: [] }) + '\n')
} else if (command === 'drip') {
  if (fs.existsSync(state)) {
    process.stderr.write('faucet-drip: the interval has not passed: the reserve can drip in 400 seconds\n')
    process.exit(3)
  }
  fs.writeFileSync(state, 'paid')
  process.stdout.write(JSON.stringify({ txid: 'ab'.repeat(32), amount: 5000000000000, fee: 581 }) + '\n')
} else {
  process.stderr.write('faucet-drip: unknown command\n')
  process.exit(1)
}
