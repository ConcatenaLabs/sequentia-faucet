'use strict'
// BTC payouts: testnet4 bitcoin, paid from the Bitcoin side of the faucet's
// own `arca` wallet (Bark's wallet for the Bitcoin ark, in <datadir>/bitcoin,
// made once by `arca bitcoin create`). A receive code with an `ark` part is
// paid there, where a web wallet holds its BTC, and arrives in seconds; a
// plain address is paid on chain.
//
// The wallet is the faucet's alone and holds only what it hands out: the
// operator tops it up from the testnet4 service wallet that funds the site's
// other services (sequentia-testnet-ops, consumer `faucet-btc`), never from a
// reserve, bridge or treasury wallet.
//
// One Bark command at a time: Bark's wallet takes an exclusive lock.
const { execFile } = require('child_process')

// What a request pays, by what the wallet can send now: each row is the least
// it must hold (sats) for that payout. Enough for a few trades at the top,
// and stingier as it drains, so it slows down before it runs dry.
const TIERS = [
  [2_000_000, 100_000],
  [500_000, 50_000],
  [100_000, 20_000],
]
const tierFor = sats => { const row = TIERS.find(([floor]) => sats >= floor); return row ? row[1] : 0 }

// Sats as BTC, the way wallets show it ("0.001").
function btc (sats) {
  const n = BigInt(sats)
  const frac = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '')
  return (n / 100000000n).toString() + (frac ? '.' + frac : '')
}

const refuse = (status, error) => Object.assign(new Error(error), { status })

// What Bark says it can send now, in sats, from its balance JSON: its
// `spendable_sat` when it gives one, else nothing (the faucet then pays
// nothing rather than guess).
function spendableOf (b) {
  if (!b || typeof b !== 'object') return 0
  const ark = b.ark && typeof b.ark === 'object' ? b.ark : b
  const v = ark.spendable_sat !== undefined ? ark.spendable_sat : ark.spendable
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function init ({ arca, datadir, refreshMs = 60000, log = console }) {
  const run = (args, timeout = 120000) => new Promise(resolve => {
    execFile(arca, ['--datadir', datadir, 'bitcoin', '--quiet', ...args], { timeout, maxBuffer: 1 << 22 }, (err, stdout, stderr) => {
      let out = null
      try { out = JSON.parse(stdout) } catch (e) {}
      resolve({ err, out, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
  let queue = Promise.resolve()
  const serial = f => { const p = queue.then(f, f); queue = p.catch(() => {}); return p }
  const why = r => (r.out && r.out.error && (r.out.error.message || r.out.error)) || r.stderr.trim().split('\n').pop() || (r.err && r.err.message) || 'Bark did not answer'

  // Last known spendable sats, read on a timer: a burst of requests costs one
  // read a minute. Until the first reading the faucet pays nothing.
  const state = { sats: 0, at: 0, error: 'not read yet' }
  async function refresh () {
    const r = await serial(() => run(['balance'], 300000))
    if (r.err || !r.out) { state.error = 'bark balance: ' + why(r); return state }
    state.sats = spendableOf(r.out); state.at = Date.now(); state.error = null
    return state
  }
  let timer = null
  function start () {
    const loop = () => refresh().catch(e => { state.error = e.message }).then(() => { timer = setTimeout(loop, refreshMs); timer.unref() })
    loop()
  }

  // What a request pays now, in sats (0: nothing to pay).
  const amount = () => tierFor(state.sats)

  let busy = false
  // Pays `sats` to the ark address when there is one, else on chain to the
  // address. -> { amount (BTC), sats, ark, txid? }
  function pay ({ address, ark }) {
    const sats = amount()
    if (!sats) throw refuse(503, 'The faucet has no BTC to hand out right now; please try again in an hour.')
    if (busy) throw refuse(429, 'The faucet is paying another request; please try again in a moment.')
    busy = true
    const dest = ark || address
    return serial(async () => {
      try {
        const r = await run(['send', dest, sats + ' sats'], 300000)
        if (r.err) {
          const m = String(why(r))
          if (/insufficient|not enough|balance/i.test(m)) throw refuse(503, 'The faucet has no BTC to hand out right now; please try again in an hour.')
          throw refuse(502, m)
        }
        state.sats = Math.max(0, state.sats - sats)
        log.log(`btc: paid ${sats} sats ${ark ? 'on the Bitcoin ark' : 'on chain'}`)
        const txid = r.out && (r.out.txid || (r.out.onchain && r.out.onchain.txid))
        return { amount: btc(sats), sats, ark: !!ark, txid: txid || null }
      } finally { busy = false }
    })
  }

  return { start, refresh, amount, pay, state }
}

module.exports = { init, tierFor, btc, spendableOf, TIERS }
