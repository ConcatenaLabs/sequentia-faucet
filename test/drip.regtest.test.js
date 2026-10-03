'use strict'
// The drip tool against a real node: a local elementsregtest chain with
// Simplicity active from genesis. It funds a faucet_drip covenant from the
// node's wallet, as the treasury would, then drips from it with the tool: a
// drip before the interval is refused, a drip confirms at the weight and fee the
// tool estimated, the successor is spent by the next drip, every refusal the
// tool makes before it signs is made, and the treasury recovers what is left
// once the recovery delay has passed.
//
//   FAUCET_REGTEST_BIN=/path/to/Sequentia/src FAUCET_DRIP=drip/target/debug/faucet-drip npm test
//
// Without both variables the test is skipped. The node's data directory is a
// fresh temporary directory, removed when the test ends.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { execFileSync, spawn, spawnSync } = require('node:child_process')

const BIN = process.env.FAUCET_REGTEST_BIN
const DRIP = process.env.FAUCET_DRIP

// Public test mnemonics, never funded anywhere but a local chain.
const FAUCET_MNEMONIC = 'exist carry drive collect lend cereal occur much tiger just involve mean'
const TREASURY_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

// The faucet's tier table scaled to a chain of 21 million coins: floors of
// 1,000,000, 100,000 and 10,000 coins, drips of 500, 200, 20 and 2.
const COIN = 100_000_000n
const TIERS = [1_000_000n, 500n, 100_000n, 200n, 10_000n, 20n, 2n].map(n => (n * COIN).toString())
const RESERVE = 2_000_000n * COIN
const FEE_CAP = 100_000n
const INTERVAL = 1        // units of 512 seconds
const RECOVERY = 2

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

test('the drip tool on a local chain', { skip: !(BIN && DRIP) && 'set FAUCET_REGTEST_BIN and FAUCET_DRIP' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-drip-'))
  const [port, rpcport] = [await freePort(), await freePort()]
  fs.writeFileSync(path.join(dir, 'elements.conf'), [
    'chain=elementsregtest', '[elementsregtest]', 'server=1', 'listen=0', `port=${port}`, `rpcport=${rpcport}`,
    'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1', 'initialfreecoins=2100000000000000', 'anyonecanspendaremine=1',
    'blindedaddresses=0', 'con_default_blinded_addresses=0', 'validatepegin=0', 'con_parent_chain_signblockscript=51',
    'con_any_asset_fees=1', 'evbparams=simplicity:-1:::', 'par=1', 'fallbackfee=0.0001', 'maxtxfee=100', ''
  ].join('\n'))
  const node = spawn(path.join(BIN, 'sequentiad'), [`-datadir=${dir}`], { stdio: 'ignore' })
  const cliArgs = [`-datadir=${dir}`]
  const cli = (...a) => execFileSync(path.join(BIN, 'sequentia-cli'), [...cliArgs, ...a], { encoding: 'utf8' }).trim()
  const json = (...a) => JSON.parse(cli(...a))
  t.after(() => {
    try { cli('stop') } catch (e) { node.kill() }
    return new Promise(resolve => {
      const done = () => { fs.rmSync(dir, { recursive: true, force: true }); resolve() }
      if (node.exitCode !== null) done(); else node.once('exit', done)
    })
  })
  for (let i = 0; ; i++) {
    try { cli('getblockchaininfo'); break } catch (e) {
      if (i > 120) throw new Error('the node did not start')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  const nodeArgs = ['--cli', path.join(BIN, 'sequentia-cli'), '--datadir', dir]
  const files = {}
  for (const [name, words] of Object.entries({ faucet: FAUCET_MNEMONIC, treasury: TREASURY_MNEMONIC, other: OTHER_MNEMONIC })) {
    files[name] = path.join(dir, name + '.mnemonic')
    fs.writeFileSync(files[name], words + '\n', { mode: 0o600 })
  }
  const tool = (cmd, ...a) => {
    const r = spawnSync(DRIP, [cmd, ...a], { encoding: 'utf8' })
    return { status: r.status, out: r.stdout ? (() => { try { return JSON.parse(r.stdout) } catch (e) { return r.stdout } })() : null, err: r.stderr }
  }
  const ok = (cmd, ...a) => {
    const r = tool(cmd, ...a)
    assert.equal(r.status, 0, `${cmd}: ${r.err}`)
    return r.out
  }
  const refused = (want, status, cmd, ...a) => {
    const r = tool(cmd, ...a)
    assert.equal(r.status, status, `${cmd} should exit ${status}: ${r.err}`)
    assert.match(r.err, want)
    return r.err
  }

  // The chain and its coins, as the regtest harness boots them.
  cli('createwallet', 'treasury')
  const mine = n => cli('generatetoaddress', String(n), cli('getnewaddress'))
  mine(101)
  // The initial free coins sit in the genesis block, before the wallet existed.
  cli('rescanblockchain')
  cli('-named', 'sendtoaddress', `address=${cli('getnewaddress')}`, 'amount=1000000', 'fee_asset_label=bitcoin')
  mine(1)
  const policy = json('getsidechaininfo').pegged_asset
  // The node keeps no transaction index, as the faucet's need not: a
  // confirmed transaction is read from the block that holds it.
  const minedTx = txid => json('getrawtransaction', txid, 'true', cli('getbestblockhash'))
  const advance = seconds => {
    const tip = json('getblockheader', cli('getbestblockhash'))
    cli('setmocktime', String(tip.time + seconds + 60))
    mine(12)
  }

  // The instance: the faucet's key from its mnemonic, the treasury's from its own.
  const faucetKey = ok('key', '--mnemonic-file', files.faucet).faucet_key
  const treasuryKey = ok('key', '--mnemonic-file', files.treasury).faucet_key
  const inst = ok('instance', '--asset', policy, '--faucet-key', faucetKey, '--treasury-key', treasuryKey,
    '--interval', String(INTERVAL), '--fee-cap', FEE_CAP.toString(), '--tiers', TIERS.join(','),
    '--recovery-delay', String(RECOVERY), ...nodeArgs)
  assert.equal(inst.params.ASSET, Buffer.from(policy, 'hex').reverse().toString('hex'), 'the asset in internal byte order')
  const instPath = path.join(dir, 'instance.json')
  fs.writeFileSync(instPath, JSON.stringify(inst, null, 2))
  const where = ok('address', '--instance', instPath)
  const covenant = where.address.elementsregtest
  assert.equal(json('getaddressinfo', covenant).scriptPubKey, where.script_pubkey)

  // The treasury funds the reserve from its wallet.
  cli('-named', 'sendtoaddress', `address=${covenant}`, `amount=${(RESERVE / COIN).toString()}`, 'fee_asset_label=bitcoin')
  mine(1)
  let status = ok('status', '--instance', instPath, ...nodeArgs)
  assert.equal(status.reserves.length, 1)
  assert.equal(BigInt(status.reserves[0].amount), RESERVE)
  assert.ok(status.reserves[0].drip_in_seconds > 0)

  const dest = cli('getnewaddress', '', 'bech32')
  const drip = (...a) => ['--instance', instPath, '--mnemonic-file', files.faucet, '--to', dest, ...a, ...nodeArgs]

  // Before the interval: refused, exit 3.
  refused(/the interval has not passed/, 3, 'drip', ...drip())
  advance(INTERVAL * 512)

  // What the tool refuses before it signs.
  refused(/above the tier/, 1, 'drip', ...drip('--amount', (BigInt(TIERS[1]) + 1n).toString()))
  refused(/not the instance's faucet key/, 1, 'drip', '--instance', instPath, '--mnemonic-file', files.other, '--to', dest, ...nodeArgs)
  refused(/confidential address/, 1, 'drip', '--instance', instPath, '--mnemonic-file', files.faucet,
    '--to', cli('getnewaddress', '', 'blech32'), ...nodeArgs)
  refused(/allows at most/, 1, 'drip', ...drip('--fee-rate', '1000000'))
  const elsewhere = path.join(dir, 'elsewhere.json')
  fs.writeFileSync(elsewhere, JSON.stringify({ ...inst, genesis: '00'.repeat(32) }))
  refused(/the instance is for the chain/, 1, 'drip', '--instance', elsewhere, '--mnemonic-file', files.faucet, '--to', dest, ...nodeArgs)
  const dry = ok('drip', ...drip('--dry-run'))
  assert.equal(dry.broadcast, false)
  assert.equal(json('getrawmempool').length, 0)

  // The first drip: the tier for the reserve, at the weight and fee estimated.
  const first = ok('drip', ...drip())
  assert.equal(first.amount, Number(TIERS[1]))
  assert.ok(first.fee > 0 && first.fee <= Number(FEE_CAP), String(first.fee))
  assert.ok(json('getrawmempool').includes(first.txid))
  mine(1)
  const onChain = minedTx(first.txid)
  assert.equal(onChain.weight, first.weight)
  assert.equal(onChain.vsize, first.vsize)
  assert.equal(onChain.vout[1].scriptPubKey.address, dest)
  assert.equal(Math.round(onChain.vout[1].value * 1e8), first.amount)
  assert.ok(first.cost_bound_milli_wu <= first.budget_wu * 1000)
  status = ok('status', '--instance', instPath, ...nodeArgs)
  assert.equal(status.reserves.length, 1)
  assert.equal(status.reserves[0].txid, first.txid)
  assert.equal(BigInt(status.reserves[0].amount), RESERVE - BigInt(first.amount) - BigInt(first.fee))

  // The successor waits its own interval, then the next drip spends it.
  refused(/the interval has not passed/, 3, 'drip', ...drip())
  advance(INTERVAL * 512)
  const second = ok('drip', ...drip('--amount', '123456789'))
  assert.equal(second.reserve.txid, first.txid)
  assert.equal(second.amount, 123456789)
  mine(1)
  assert.ok(minedTx(second.txid).confirmations >= 1)

  // The recovery: refused before its delay, then the treasury takes the rest.
  const back = cli('getnewaddress', '', 'bech32')
  const recover = ['--instance', instPath, '--mnemonic-file', files.treasury, '--to', back, ...nodeArgs]
  refused(/recovery delay has not passed/, 3, 'recover', ...recover)
  refused(/not the instance's treasury key/, 1, 'recover', '--instance', instPath, '--mnemonic-file', files.faucet, '--to', back, ...nodeArgs)
  advance(RECOVERY * 512)
  const rec = ok('recover', ...recover)
  mine(1)
  const recTx = minedTx(rec.txid)
  assert.equal(recTx.vout[0].scriptPubKey.address, back)
  assert.equal(Math.round(recTx.vout[0].value * 1e8), Number(RESERVE) - first.amount - first.fee - second.amount - second.fee - rec.fee)
  status = ok('status', '--instance', instPath, ...nodeArgs)
  assert.equal(status.reserves.length, 0)
  t.diagnostic(`drip: ${first.vsize} vB, weight ${first.weight}, fee ${first.fee}, cost bound ${first.cost_bound_milli_wu} milli-WU, budget ${first.budget_wu} WU; recovery: ${rec.vsize} vB`)
})
