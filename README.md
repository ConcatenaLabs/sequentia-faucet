# Sequentia testnet faucet

Free testnet coins: tSEQ and the sample assets (USDX, EURX, GOLD, SILVR, OILX),
sent to any Sequentia address, so they can be used from a full node or from any
Sequentia wallet.

USDX is the settlement currency the platforms here price things in, so it is
handed out in the amounts those platforms deal in rather than in samples: a raise
that the fee schedule was written for has to be fundable from this page. The
other assets are commodity tokens, sent in tens so they can be seen and moved.

Live at [sequentiatestnet.com/faucet](https://sequentiatestnet.com/faucet).

## API

`POST /faucet`

```json
{ "address": "tb1...", "asset": "USDX" }
```

`asset` is optional; omitting it sends tSEQ. On success the response carries the
txid:

```json
{ "txid": "...", "amount": "500000", "asset": "USDX" }
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
| `FAUCET_AMOUNT` | unset | pins the tSEQ amount per request; unset, it follows the treasury balance (below) |
| `FAUCET_BALANCE_REFRESH_MS` | `60000` | how often the treasury balance is read |
| `FAUCET_COOLDOWN_MS` | `3600000` | per address and per IP, per asset |

## How much tSEQ a request pays

The tSEQ amount follows what the funding wallet has left, so the faucet slows
down as the treasury drains rather than running dry at full speed. The balance
is read from the node once a minute; until the first reading succeeds the
smallest amount applies.

| treasury balance | tSEQ per request |
| --- | --- |
| 100,000,000 or more | 50,000 |
| 10,000,000 to 100,000,000 | 20,000 |
| 1,000,000 to 10,000,000 | 2,000 |
| under 1,000,000 | 200 |

`GET /faucet/amount` returns the amount in force, and the page shows it under
the tSEQ button. The other assets are sent in fixed amounts.

The funding wallet must hold a balance of every asset the faucet offers, and
enough of each to pay its own fee, because Sequentia has no privileged fee asset
and every send names the asset that pays.

## Deploy

`deploy/sequentia-faucet.service` is the systemd unit. The box pulls this repo
from GitHub and runs it there; source is never edited on the server.
