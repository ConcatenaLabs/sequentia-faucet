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
(`tsqb1`). Both are funded the same way, except tSEQ paid from the drip
covenant (below), which goes to transparent addresses only: a `tsqb1` address
gets a `400`, and a request made before the reserve's next interval a `429`.

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
| `FAUCET_DRIP` | unset | the `faucet-drip` command; set, tSEQ is paid from the drip covenant (below) |
| `FAUCET_DRIP_INSTANCE` | unset | with `FAUCET_DRIP`: the covenant's instance file |
| `FAUCET_DRIP_MNEMONIC` | unset | with `FAUCET_DRIP`: a file holding the mnemonic of the faucet key |
| `FAUCET_DRIP_TEMPLATE` | unset | with `FAUCET_DRIP`: the template directory; unset, the one the tool was built with |

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

With the drip covenant, the same table is held by the covenant and applies to
the reserve's own amount, and the faucet reads it from there.

The funding wallet must hold a balance of every asset the faucet offers, and
enough of each to pay its own fee, because Sequentia has no privileged fee asset
and every send names the asset that pays. tSEQ paid from the drip covenant comes
from the reserve instead, which pays its own fee in tSEQ.

## Paying tSEQ from the drip covenant

The faucet can pay tSEQ from a covenant instead of from a wallet: the
reserve sits in one output of the `sequentia/faucet-drip` template of
[sequentia-contracts](https://github.com/ConcatenaLabs/sequentia-contracts)
(`templates/faucet_drip`). A drip spends the reserve and re-creates it with the
rest, and the covenant enforces, whatever the faucet signs:

- at most one drip per interval, read from the reserve's own sequence, so each
  new reserve waits again;
- a drip of at most the tier for the reserve's amount, from the faucet's tier
  table above, in tSEQ, to any address but the covenant's own;
- a fee of at most the instance's fee cap, paid in tSEQ;
- a signature by the faucet key.

So a stolen faucet key takes at most one tier and one fee cap per interval. The
treasury key can take the whole reserve once it has gone the recovery delay
without a drip; each drip starts that delay again.

`drip/` is the tool that does it, `faucet-drip`, a Rust command built on
[Simplex for Sequentia](https://github.com/ConcatenaLabs/smplx). It reaches the
node through `sequentia-cli` and the data directory, as the faucet does, needs
no wallet and no transaction index, and signs with the faucet key alone.

```
cargo build --release --locked --manifest-path drip/Cargo.toml
drip/target/release/faucet-drip <command> ...
```

| command | does |
| --- | --- |
| `key --mnemonic-file F` | prints the contract key a mnemonic signs with, to name as a faucet or treasury key |
| `instance --asset A --faucet-key K --treasury-key K --interval N --fee-cap N --tiers F1,M1,F2,M2,F3,M3,M4 --recovery-delay N --cli C --datadir D` | prints the instance: the asset as an RPC prints it, the interval and recovery delay in units of 512 seconds, the fee cap and tiers in atoms; the chain is read from the node (or `--genesis G`) |
| `address --instance I` | prints the covenant's address on each chain, and each leaf |
| `status --instance I --cli C --datadir D` | lists the reserves at the address, each with its tier and the seconds until it can drip |
| `drip --instance I --mnemonic-file F --to ADDRESS [--amount N] [--fee-rate R] [--dry-run] --cli C --datadir D` | pays one drip: the tier, or `--amount` atoms up to it |
| `recover --instance I --mnemonic-file F --to ADDRESS [--fee-rate R] [--dry-run] --cli C --datadir D` | pays the whole reserve, less the fee, by the recovery leaf; `F` holds the treasury key's mnemonic |

Each command prints one JSON object. `drip` and `recover` refuse before they
sign anything the covenant or the node would refuse: an interval or delay that
has not passed (exit status 3), a drip above the tier, a key that is not the
instance's, a confidential address, an instance for another chain, and a fee
above the cap at the node's fee rate. They measure the transaction's weight on a
draft that differs only in amounts, run the program against the final
transaction, check its cost against the budget its witness earns, and ask the
node's mempool before they broadcast. The fee rate is the node's (its relay
floor, its mempool minimum and its estimate, whichever is highest) unless
`--fee-rate` gives one, in reference units per 1,000 vbytes.

The instance file holds public keys and amounts only. The mnemonic file is the
faucet key and stays on the server, readable by the faucet's user alone.

## Testing

```
npm install
npm test
```

runs the request path with `FAUCET_CLI` pointed at `echo`, and the drip
covenant's path with a stand-in for the tool, so no coins move. With a built
node and tool it also runs the tool against a local `elementsregtest` chain:

```
cargo build --manifest-path drip/Cargo.toml
FAUCET_REGTEST_BIN=/path/to/Sequentia/src FAUCET_DRIP=drip/target/debug/faucet-drip npm test
```

## Deploy

`deploy/sequentia-faucet.service` is the systemd unit. The box pulls this repo
from GitHub and runs it there; source is never edited on the server.
