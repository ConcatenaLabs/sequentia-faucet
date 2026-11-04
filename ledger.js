'use strict'
// The faucet's claims ledger: which asset was paid under which key, kept in a
// file of the faucet's own so that a restart or a deploy forgets nothing.
//
// The faucet pays each asset once per wallet. A request names the wallet by
// several keys at once (its wallet id, its address, its receive request's
// mailbox, its address on the Bitcoin ark) and is refused when any of them was
// paid that asset before. The requester's IP counts too, but only for a window
// (a day by default) and only once it has been paid an asset for a number of
// different wallets (ten by default): that slows someone pasting fresh
// addresses into the page, lets a shared network (a meetup, an office) fund
// that many wallets, and holds it back for no longer than the window.
//
// Each payout is one line of JSON, appended and flushed to disk before the
// faucet answers: { "t": <ms>, "asset": "USDX", "keys": ["w:…", "a:…", "i:…"] }.
// A claim is written only once its payout succeeded, and a key held by a
// payout still in flight refuses every other request of that asset that
// carries it, so two requests sharing a key never both pay.
//
// Keys, each prefixed by its kind:
//   w:<wallet id>   the wallet's id, sha256("sequentia-faucet-wallet/1" ||
//                   the scriptPubKey of its first receive address), hex
//   a:<address>     the address paid (a Sequentia address, or a tb1 for BTC)
//   m:<mailbox>     a receive request's mailbox key, the same in every
//                   request one wallet makes
//   k:<ark address> the address on the Bitcoin ark paid
//   i:<hash>        the requester's IP, hashed, so the file holds no address
//                   of anyone's network
// A payout's wallet, for the IP's count, is its first key other than the IP's
// (the faucet lists them wallet id, mailbox, ark address, address).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ipKey = ip => 'i:' + crypto.createHash('sha256').update('sequentia-faucet-ip/1').update(String(ip)).digest('hex').slice(0, 32)

const walletOf = keys => keys.find(k => !k.startsWith('i:')) || null

function open (file, { ipWindowMs = 86400000, ipWallets = 10, log = console } = {}) {
  // Make the directory when it is missing; one that exists keeps its owner and mode.
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const paid = new Map()   // "<asset>|<key>" -> the time it was last paid, ms
  const byKey = new Map()  // a wallet's, address's, mailbox's or ark address's key -> the assets paid to it
  const byIp = new Map()   // "<asset>|<ip key>" -> Map(wallet -> the time it was last paid there)
  const note = (asset, k, t, wallet) => {
    if (k.startsWith('i:')) {
      const m = byIp.get(asset + '|' + k) || new Map()
      byIp.set(asset + '|' + k, m)
      const w = wallet || 't:' + t   // a payout naming no wallet counts as one of its own
      m.set(w, Math.max(m.get(w) || 0, t))
      return
    }
    paid.set(asset + '|' + k, t)
    if (!byKey.has(k)) byKey.set(k, new Set())
    byKey.get(k).add(asset)
  }
  let lines = 0
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let c
      // A line cut short by a crash mid-write is the only one that can fail to
      // parse; it was never answered as paid, so it is skipped.
      try { c = JSON.parse(line) } catch (e) { log.error('ledger: an unreadable line skipped'); continue }
      if (!c || typeof c.asset !== 'string' || !Array.isArray(c.keys)) continue
      const keys = c.keys.map(String)
      for (const k of keys) note(c.asset, k, Number(c.t) || 0, walletOf(keys))
      lines++
    }
    // A file that does not end in a newline was cut short: start the next
    // line on its own, so a good claim is never glued to the broken one.
    if (text.length && !text.endsWith('\n')) fs.appendFileSync(file, '\n')
  }
  const fd = fs.openSync(file, 'a', 0o600)
  const inflight = new Set()   // "<asset>|<key>" held by a payout not yet answered (an IP's apart)
  const inflightIp = new Map() // "<asset>|<ip key>" -> how many payouts from it are not yet answered

  // The times, within the window, at which the IP was paid `asset` for each
  // different wallet, oldest first.
  function ipTimes (asset, k, now) {
    const m = byIp.get(asset + '|' + k)
    if (!m) return []
    const ts = []
    for (const [w, t] of m) { if (now - t < ipWindowMs) ts.push(t); else m.delete(w) }
    return ts.sort((a, b) => a - b)
  }

  // Why `keys` may not be paid `asset`, or null: { key, t } for a key paid it
  // before; for an IP that has been paid it for `ipWallets` different wallets
  // in the window, { key, t, count, next } with `next` the time a request from
  // it can be paid again.
  function hit (asset, keys, now = Date.now()) {
    for (const k of keys) {
      if (k.startsWith('i:')) continue
      const t = paid.get(asset + '|' + k)
      if (t !== undefined) return { key: k, t }
    }
    for (const k of keys) {
      if (!k.startsWith('i:')) continue
      const ts = ipTimes(asset, k, now)
      if (ts.length >= ipWallets) return { key: k, t: ts[ts.length - 1], count: ts.length, next: ts[ts.length - ipWallets] + ipWindowMs }
    }
    return null
  }

  // Holds `keys` for `asset` while a payout runs. -> { busy: key } when one
  // of them is already held (an IP's: when its payouts in the window and in
  // flight would pass its count), else { release, commit }: commit() writes
  // the claim to disk and then releases, release() lets the keys go unpaid.
  function reserve (asset, keys, now = Date.now()) {
    for (const k of keys) {
      if (k.startsWith('i:')) {
        if (ipTimes(asset, k, now).length + (inflightIp.get(asset + '|' + k) || 0) >= ipWallets) return { busy: k }
      } else if (inflight.has(asset + '|' + k)) return { busy: k }
    }
    for (const k of keys) {
      if (k.startsWith('i:')) inflightIp.set(asset + '|' + k, (inflightIp.get(asset + '|' + k) || 0) + 1)
      else inflight.add(asset + '|' + k)
    }
    let done = false
    const release = () => {
      if (done) return
      done = true
      for (const k of keys) {
        if (!k.startsWith('i:')) { inflight.delete(asset + '|' + k); continue }
        const n = (inflightIp.get(asset + '|' + k) || 1) - 1
        if (n) inflightIp.set(asset + '|' + k, n); else inflightIp.delete(asset + '|' + k)
      }
    }
    const commit = () => {
      const t = Date.now()
      try {
        fs.writeSync(fd, JSON.stringify({ t, asset, keys }) + '\n')
        fs.fsyncSync(fd)
      } catch (e) {
        // The coins went out; the faucet keeps the claim in memory at least,
        // and says it could not keep it on disk.
        log.error('ledger: a claim could not be written: ' + e.message)
      }
      for (const k of keys) note(asset, k, t, walletOf(keys))
      release()
    }
    return { release, commit }
  }

  // The assets paid under `key`, permanently (never an IP's).
  const claimed = key => [...(byKey.get(key) || [])]

  return { hit, reserve, claimed, size: () => lines, file }
}

module.exports = { open, ipKey }
