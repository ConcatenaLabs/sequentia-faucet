'use strict'
// A wallet's receive code, read where an address is asked for.
//
//   BITCOIN:<ADDRESS>?ark=<ARK ADDRESS>&sequentia=<RECEIVE REQUEST>
//
// The format is the web wallet's (sequentia-web-wallet `pay-code.js`, which
// writes it and documents every part): a BIP321 payment request whose path is
// the wallet's own address, the same tb1 address on both chains; `ark` is its
// address on the Bitcoin ark and `sequentia` its single-use Sequentia receive
// request. Codes are written in upper case for the QR code; every bech32 part
// comes back here in lower case. The same reader is copied into the faucet
// page, Compages and Emissio: change them together.
//
// -> { address, ark, sequentia } (each a string or null) when `text` is a
// receive code, or null when it is not one (a plain address, for instance).
function readReceiveCode (text) {
  const s = String(text == null ? '' : text).trim()
  const m = /^bitcoin:([^?#]*)(?:\?([^#]*))?/i.exec(s)
  if (!m) return null
  const plain = v => { try { return decodeURIComponent(v.replace(/\+/g, '%20')) } catch (e) { return null } }
  // A bech32 string is all one case; anything else keeps its case.
  const lower = v => (v && (v === v.toUpperCase() || v === v.toLowerCase()) ? v.toLowerCase() : v)
  const out = { address: lower(plain(m[1])) || null, ark: null, sequentia: null }
  for (const part of (m[2] || '').split('&')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const key = part.slice(0, i).toLowerCase()
    if (key !== 'ark' && key !== 'sequentia') continue
    if (out[key] === null) out[key] = lower(plain(part.slice(i + 1))) || null
  }
  return out
}

// The address a receive code names, or `text` itself (trimmed) when it is not
// a receive code.
function addressOf (text) {
  const c = readReceiveCode(text)
  return c ? (c.address || '') : String(text == null ? '' : text).trim()
}

module.exports = { readReceiveCode, addressOf }

// ---- a receive request's mailbox ---------------------------------------------
//
// Every receive request one wallet makes names the same mailbox key (the
// wallet's own), so the faucet keys a wallet's leaf payouts by it. A request
// comes in the library's spelling (`<word>:<hex of its JSON>`) or, inside a
// receive code, in the web wallet's short form (`sqr1…`, bech32m, written by
// `pay-code.js` `compactRequest`: version, flags, operator and genesis
// prefixes of four bytes each, then owner, owner nonce and mailbox of 32 bytes
// each).
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
function polymod (values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i]
  }
  return chk >>> 0
}
// A bech32m string -> { hrp, bytes }, or null.
function bech32mDecode (text) {
  const s = String(text || '').toLowerCase()
  const at = s.lastIndexOf('1')
  if (at < 1 || s.length - at < 7) return null
  const hrp = s.slice(0, at)
  const data = []
  for (const c of s.slice(at + 1)) { const v = CHARSET.indexOf(c); if (v < 0) return null; data.push(v) }
  const expand = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31))
  if (polymod(expand.concat(data)) !== 0x2bc830a3) return null
  let acc = 0, bits = 0
  const bytes = []
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v; bits += 5
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff) }
  }
  return { hrp, bytes }
}

// -> the request's mailbox key (64 hex), or null when `text` is not a receive
// request in either spelling.
function mailboxOf (text) {
  const s = String(text == null ? '' : text).trim()
  const i = s.indexOf(':')
  if (i > 0 && /^[A-Za-z0-9-]+$/.test(s.slice(0, i))) {
    const h = s.slice(i + 1)
    if (!/^([0-9a-fA-F]{2})+$/.test(h)) return null
    try {
      const v = JSON.parse(Buffer.from(h, 'hex').toString('utf8'))
      return v && /^[0-9a-f]{64}$/.test(v.mailbox || '') ? v.mailbox : null
    } catch (e) { return null }
  }
  const d = bech32mDecode(s)
  if (!d || d.hrp !== 'sqr' || d.bytes.length < 112 || d.bytes[0] !== 1) return null
  return Buffer.from(d.bytes.slice(74, 106)).toString('hex')
}

module.exports.mailboxOf = mailboxOf
