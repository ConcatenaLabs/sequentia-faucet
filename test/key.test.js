'use strict'
// The drip tool's keys, with no node: `key --new` makes a mnemonic that `key`
// reads back to the same contract key, prints it on stdout only, and writes it
// only to a new file readable by its owner alone.
//
//   FAUCET_DRIP=drip/target/debug/faucet-drip npm test
//
// Without the variable the test is skipped.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DRIP = process.env.FAUCET_DRIP
const tool = (...a) => spawnSync(DRIP, a, { encoding: 'utf8' })

test('the drip tool makes a new key', { skip: !DRIP && 'set FAUCET_DRIP' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const printed = tool('key', '--new')
  assert.equal(printed.status, 0, printed.stderr)
  assert.equal(printed.stderr, '', 'nothing on stderr')
  const made = JSON.parse(printed.stdout)
  assert.deepEqual(Object.keys(made).sort(), ['faucet_key', 'mnemonic'])
  assert.equal(made.mnemonic.split(' ').length, 12)
  assert.match(made.faucet_key, /^[0-9a-f]{64}$/)
  const words = path.join(dir, 'printed.mnemonic')
  fs.writeFileSync(words, made.mnemonic + '\n')
  assert.equal(JSON.parse(tool('key', '--mnemonic-file', words).stdout).faucet_key, made.faucet_key)
  assert.notEqual(JSON.parse(tool('key', '--new').stdout).mnemonic, made.mnemonic, 'each mnemonic is new')

  // Written to a file, the mnemonic is not printed.
  const file = path.join(dir, 'faucet.mnemonic')
  const written = tool('key', '--new', '--mnemonic-file', file)
  assert.equal(written.status, 0, written.stderr)
  assert.deepEqual(Object.keys(JSON.parse(written.stdout)).sort(), ['faucet_key', 'mnemonic_file'])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const saved = fs.readFileSync(file, 'utf8')
  assert.equal(saved.trim().split(' ').length, 12)
  assert.ok(!written.stdout.includes(saved.trim()), 'the mnemonic is not printed')
  assert.equal(JSON.parse(tool('key', '--mnemonic-file', file).stdout).faucet_key, JSON.parse(written.stdout).faucet_key)

  // Never over an existing file.
  const again = tool('key', '--new', '--mnemonic-file', file)
  assert.equal(again.status, 1)
  assert.match(again.stderr, /never written over a file/)
  assert.equal(fs.readFileSync(file, 'utf8'), saved)
})
