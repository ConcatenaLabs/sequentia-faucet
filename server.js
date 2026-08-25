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
const DATADIR = process.env.FAUCET_DATADIR || '/root/seq-testnet/node-gw'
const WALLET = process.env.FAUCET_WALLET || 'treasury2026'
const AMOUNT = process.env.FAUCET_AMOUNT || '50000'
const COOLDOWN_MS = Number(process.env.FAUCET_COOLDOWN_MS || 3600000)

// bech32/blech32 data charset. Sequentia is transparent by default (tb1); the
// blinded form (tsqb1) is opt-in and equally fundable.
const ADDR_RE = /^(tb1|tsqb1)[ac-hj-np-z02-9]{20,180}$/

// label -> amount. A fixed allowlist, so the asset can never be anything the
// operator did not put here.
const ASSETS = { USDX: '10', EURX: '10', GOLD: '10', SILVR: '10', OILX: '10' }

const seen = new Map()                                   // key -> last-served epoch ms
const tooSoon = k => { const t = seen.get(k); return t && (Date.now() - t) < COOLDOWN_MS }
// Evict entries older than the cooldown so the map cannot grow without bound
// (one key per address/IP per asset would otherwise accumulate forever).
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_MS
  for (const [k, t] of seen) if (t < cutoff) seen.delete(k)
}, COOLDOWN_MS).unref()

const app = express()
app.disable('x-powered-by')
// One trusted hop: the site front door proxies to us and forwards the original
// X-Forwarded-For unchanged, so req.ip is the real client rather than 127.0.0.1.
app.set('trust proxy', 1)

app.get('/healthz', (req, res) => res.json({ ok: true }))

// execFile (no shell) plus a strict address regex means the user-supplied address
// cannot inject anything; it is only ever one argv element. The optional asset is
// checked against the allowlist above, so it is injection-safe for the same reason.
app.post('/', express.json({ limit: '4kb' }), (req, res) => {
  const address = String((req.body && req.body.address) || '').trim()
  if (!ADDR_RE.test(address)) return res.status(400).json({ error: 'Enter a valid Sequentia address.' })
  const asset = String((req.body && req.body.asset) || '').trim()   // '' = native tSEQ
  if (asset && !Object.prototype.hasOwnProperty.call(ASSETS, asset))
    return res.status(400).json({ error: 'Unknown faucet asset.' })
  const unit = asset || 'tSEQ'
  const amount = asset ? ASSETS[asset] : AMOUNT
  const ip = String(req.ip || req.socket.remoteAddress || '').trim()
  if (tooSoon('a:' + unit + ':' + address) || tooSoon('i:' + unit + ':' + ip))
    return res.status(429).json({ error: 'Already funded recently; please wait before requesting again.' })

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
