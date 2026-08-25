# Sequentia testnet faucet

Free testnet coins: tSEQ and the sample assets (USDX, EURX, GOLD, SILVR, OILX),
sent to any Sequentia address so they can be used from a full node, the desktop
wallet, Ambra on Android or Chromium, or the web wallet.

Live at [sequentiatestnet.com/faucet](https://sequentiatestnet.com/faucet).

## API

`POST /faucet`

```json
{ "address": "tb1...", "asset": "USDX" }
```

`asset` is optional; omitting it sends tSEQ. On success the response carries the
txid:

```json
{ "txid": "...", "amount": "10", "asset": "USDX" }
```

Errors are `400` for an address that is not a valid Sequentia address or an
asset that is not on the faucet's list, `429` when the same address or IP asked
too recently, and `502` when the node refused the send (the node's own message
is passed through).

Addresses may be transparent (`tb1`, the default on Sequentia) or blinded
(`tsqb1`). Both are funded the same way.

## Running it

```
npm install
node server.js
```

It listens on `127.0.0.1:9960` and is meant to sit behind the site front door,
which proxies `/faucet` to it and strips that prefix. Configuration is by
environment variable:

| variable | default | meaning |
| --- | --- | --- |
| `FAUCET_PORT` | `9960` | port to listen on |
| `FAUCET_HOST` | `127.0.0.1` | address to bind |
| `FAUCET_CLI` | `/root/Sequentia/src/sequentia-cli` | node CLI used to send |
| `FAUCET_DATADIR` | `/root/seq-testnet/node000` | node data directory |
| `FAUCET_WALLET` | `treasury2026` | wallet the coins come from |
| `FAUCET_AMOUNT` | `50000` | tSEQ per request |
| `FAUCET_COOLDOWN_MS` | `3600000` | per address and per IP, per asset |

The funding wallet must hold a balance of every asset the faucet offers, and
enough of each to pay its own fee, because Sequentia has no privileged fee asset
and every send names the asset that pays.

## Deploy

`deploy/sequentia-faucet.service` is the systemd unit. The box pulls this repo
from GitHub and runs it there; source is never edited on the server.
