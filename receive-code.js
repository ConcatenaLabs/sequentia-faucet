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
