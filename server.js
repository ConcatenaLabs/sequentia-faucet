'use strict'
// The Sequentia testnet faucet.
//
// Serves its own page at GET / and sends coins at POST /. It is mounted at
// /faucet by the site front door, which strips that prefix, so the public
// contract stays GET /faucet and POST /faucet exactly as before.
//
// This used to live inside sequentia-explorer's serve-public.js. A faucet is
// not an explorer, and sharing a process is a deployment fact rather than a
// reason to share a repository.
const path = require('path')
const express = require('express')
const { execFile } = require('child_process')

const PORT = Number(process.env.FAUCET_PORT || 9960)
const HOST = process.env.FAUCET_HOST || '127.0.0.1'
const CLI = process.env.FAUCET_CLI || '/root/Sequentia/src/sequentia-cli'
const DATADIR = process.env.FAUCET_DATADIR || '/root/seq-testnet/node000'
const WALLET = process.env.FAUCET_WALLET || 'treasury2026'
const FIXED_AMOUNT = process.env.FAUCET_AMOUNT || ''   // set to pin the tSEQ amount; unset, it follows the treasury
const COOLDOWN_MS = Number(process.env.FAUCET_COOLDOWN_MS || 3600000)
const BALANCE_REFRESH_MS = Number(process.env.FAUCET_BALANCE_REFRESH_MS || 60000)

// The drip covenant. With FAUCET_DRIP set, tSEQ is paid by the drip tool from
// the faucet's covenant reserve instead of from the wallet: one drip per
// interval, at most the tier the covenant holds. The instance file names the
// covenant; the mnemonic file holds the faucet key, the only key the tool
// signs with. Other assets are still sent from the wallet.
const DRIP = process.env.FAUCET_DRIP || ''
const DRIP_INSTANCE = process.env.FAUCET_DRIP_INSTANCE || ''
const DRIP_MNEMONIC = process.env.FAUCET_DRIP_MNEMONIC || ''
const DRIP_TEMPLATE = process.env.FAUCET_DRIP_TEMPLATE || ''   // unset: the template the tool was built with
if (DRIP && !(DRIP_INSTANCE && DRIP_MNEMONIC)) {
  console.error('FAUCET_DRIP is set: FAUCET_DRIP_INSTANCE and FAUCET_DRIP_MNEMONIC must name the instance and the faucet key')
  process.exit(1)
}
// The drip tool reaches the node exactly as the faucet does.
const dripArgs = command => [command, '--instance', DRIP_INSTANCE, '--cli', CLI, '--datadir', DATADIR]
  .concat(DRIP_TEMPLATE ? ['--template', DRIP_TEMPLATE] : [])
// The tool exits 3 when the reserve's interval has not passed.
const DRIP_TOO_EARLY = 3

// The tSEQ amount follows what the treasury has left, so the faucet slows
// down as it drains instead of running dry at full speed. Each row is the
// smallest treasury balance at which that amount is handed out; the last row
// is the floor. The treasury is a wallet, so its balance is one RPC away.
const TIERS = [
  [100_000_000, '50000'],
  [10_000_000, '20000'],
  [1_000_000, '2000'],
  [0, '200'],
]
const tierFor = balance => TIERS.find(([floor]) => balance >= floor)[1]

// bech32/blech32 data charset. Sequentia is transparent by default (tb1); the
// blinded form (tsqb1) is opt-in and equally fundable.
const ADDR_RE = /^(tb1|tsqb1)[ac-hj-np-z02-9]{20,180}$/

// label -> amount. A fixed allowlist, so the asset can never be anything the
// operator did not put here.
//
// USDX is not like the others. It is the settlement currency the platforms on
// this testnet price things in, so what the faucet hands out is the ceiling on
// what anyone can demonstrate: a fee schedule written for a six-figure raise
// cannot be exercised with ten dollars, and an escrow funded with ten dollars
// makes every percentage of it look absurd. It pays enough to fund a realistic
// subscription. The others are commodity tokens, held to be seen and moved, and
// ten of each is the right amount of those.
const ASSETS = { USDX: '500000', EURX: '10', GOLD: '10', SILVR: '10', OILX: '10' }

const seen = new Map()                                   // key -> last-served epoch ms
const tooSoon = k => { const t = seen.get(k); return t && (Date.now() - t) < COOLDOWN_MS }
// Evict entries older than the cooldown so the map cannot grow without bound
// (one key per address/IP per asset would otherwise accumulate forever).
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_MS
  for (const [k, t] of seen) if (t < cutoff) seen.delete(k)
}, COOLDOWN_MS).unref()

// Last known treasury balance and the amount it implies. Refreshed on a
// timer rather than per request, so a burst of claims costs one RPC a
// minute, not one each. Until the first reading succeeds the floor applies:
// a faucet that cannot see its treasury should be stingy, not generous.
const treasury = { balance: null, amount: TIERS[TIERS.length - 1][1], at: 0 }

// Atoms, as the drip tool counts them, in whole coins as the page shows them.
function coins (atoms) {
  const n = BigInt(atoms)
  const frac = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '')
  return (n / 100000000n).toString() + (frac ? '.' + frac : '')
}

// With the drip covenant, what a request pays is the tier the covenant holds
// for the reserve that is ready to drip.
function refreshTier () {
  execFile(DRIP, dripArgs('status'), { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return console.error('drip status failed: ' + String(stderr || err.message).trim().split('\n').pop())
    let s
    try { s = JSON.parse(stdout) } catch (e) { return console.error('drip status unreadable') }
    if (s.tier_now === null || s.tier_now === undefined) return
    const amount = coins(s.tier_now)
    if (amount !== treasury.amount) console.log(`covenant reserve: faucet amount ${treasury.amount} -> ${amount}`)
    Object.assign(treasury, { amount, at: Date.now() })
  })
}

function refreshTreasury () {
  if (FIXED_AMOUNT) return
  if (DRIP) return refreshTier()
  const args = ['-datadir=' + DATADIR, '-rpcwallet=' + WALLET, 'getbalance', '*', '0', 'false', 'false', 'bitcoin']
  execFile(CLI, args, { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) return console.error('treasury balance check failed: ' + String(stderr || err.message).trim().split('\n').pop())
    const balance = Number(String(stdout).trim())
    if (!Number.isFinite(balance)) return console.error('treasury balance unreadable: ' + String(stdout).trim())
    const amount = tierFor(balance)
    if (amount !== treasury.amount) console.log(`treasury ${balance} tSEQ: faucet amount ${treasury.amount} -> ${amount}`)
    Object.assign(treasury, { balance, amount, at: Date.now() })
  })
}
const currentAmount = () => FIXED_AMOUNT || treasury.amount
refreshTreasury()
setInterval(refreshTreasury, BALANCE_REFRESH_MS).unref()

const app = express()
app.disable('x-powered-by')
// One trusted hop: the site front door proxies to us and forwards the original
// X-Forwarded-For unchanged, so req.ip is the real client rather than 127.0.0.1.
app.set('trust proxy', 1)

app.get('/healthz', (req, res) => res.json({ ok: true }))

// What a tSEQ request pays right now, so the page can say so before the click.
app.get('/amount', (req, res) => res.json({ amount: currentAmount(), asset: 'tSEQ' }))

// execFile (no shell) plus a strict address regex means the user-supplied address
// cannot inject anything; it is only ever one argv element. The optional asset is
// checked against the allowlist above, so it is injection-safe for the same reason.
// One drip at a time: the reserve is one coin, and a second spend of it while
// the first is unconfirmed could only be refused.
let dripping = false

function payFromCovenant (req, res, address, ip) {
  // The covenant polices explicit outputs only, so it pays a transparent
  // address; paying a confidential one in the clear would override the
  // recipient's choice.
  if (!address.startsWith('tb1'))
    return res.status(400).json({ error: 'tSEQ comes from the faucet\'s reserve, which pays transparent (tb1) addresses only.' })
  if (dripping)
    return res.status(429).json({ error: 'The faucet is paying another request; please try again in a moment.' })
  dripping = true
  const args = dripArgs('drip').concat(['--mnemonic-file', DRIP_MNEMONIC, '--to', address])
  execFile(DRIP, args, { timeout: 60000 }, (err, stdout, stderr) => {
    dripping = false
    const why = String(stderr || (err && err.message) || '').trim().split('\n').pop()
    if (err && err.code === DRIP_TOO_EARLY)
      return res.status(429).json({ error: 'The faucet pays tSEQ from its reserve once per interval; please try again in a few minutes.' })
    if (err) return res.status(502).json({ error: why || 'faucet drip failed' })
    let r
    try { r = JSON.parse(stdout) } catch (e) { return res.status(502).json({ error: 'faucet drip answer unreadable' }) }
    seen.set('a:tSEQ:' + address, Date.now()); seen.set('i:tSEQ:' + ip, Date.now())
    res.json({ txid: r.txid, amount: coins(r.amount), asset: 'tSEQ' })
    refreshTier()
  })
}

app.post('/', express.json({ limit: '4kb' }), (req, res) => {
  const address = String((req.body && req.body.address) || '').trim()
  if (!ADDR_RE.test(address)) return res.status(400).json({ error: 'Enter a valid Sequentia address.' })
  const asset = String((req.body && req.body.asset) || '').trim()   // '' = native tSEQ
  if (asset && !Object.prototype.hasOwnProperty.call(ASSETS, asset))
    return res.status(400).json({ error: 'Unknown faucet asset.' })
  const unit = asset || 'tSEQ'
  const amount = asset ? ASSETS[asset] : currentAmount()
  const ip = String(req.ip || req.socket.remoteAddress || '').trim()
  if (tooSoon('a:' + unit + ':' + address) || tooSoon('i:' + unit + ':' + ip))
    return res.status(429).json({ error: 'Already funded recently; please wait before requesting again.' })
  if (!asset && DRIP) return payFromCovenant(req, res, address, ip)

  // The open fee market means no asset is the default fee asset; the node requires
  // the fee asset to be NAMED. Pay it in the asset being sent (the fee-model default
  // for asset transfers), and in tSEQ for plain tSEQ requests ("bitcoin" is the
  // node's label for the policy asset). The faucet wallet holds every faucet asset.
  const args = ['-datadir=' + DATADIR, '-rpcwallet=' + WALLET, '-named', 'sendtoaddress',
    'address=' + address, 'amount=' + amount, 'fee_rate=2', 'fee_asset_label=' + (asset || 'bitcoin')]
  if (asset) args.push('assetlabel=' + asset)
  execFile(CLI, args, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(502).json({ error: String(stderr || err.message).trim().split('\n').pop() || 'faucet send failed' })
    seen.set('a:' + unit + ':' + address, Date.now()); seen.set('i:' + unit + ':' + ip, Date.now())
    res.json({ txid: stdout.trim(), amount, asset: unit })
  })
})

app.use(express.static(path.join(__dirname, 'public'), { setHeaders: r => r.setHeader('Cache-Control', 'no-cache') }))

app.listen(PORT, HOST, () => console.log(`sequentia-faucet listening on ${HOST}:${PORT}`))
