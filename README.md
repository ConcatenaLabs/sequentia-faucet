# Sequentia testnet faucet

Free testnet coins: BTC (testnet4), tSEQ and the sample assets (USDX, EURX,
GOLD, SILVR, OILX), sent to a wallet's receive code or to any Sequentia address,
so they can be used from the web wallet, from a full node or from any Sequentia
wallet.

Every asset is handed out in the amounts the platforms here deal in rather than
in samples, so a raise that their fee schedules were written for is fundable
from this page. Each request pays about the same value: 500,000 of USDX and EURX
(the test dollar and the test euro), and of each commodity token a round amount
worth about as much at its market price.

| asset | per request |
| --- | --- |
| USDX | 500,000 |
| EURX | 500,000 |
| GOLD | 125 |
| SILVR | 10,000 |
| OILX | 5,000 |

The amounts are fixed, not repriced as the market moves. tSEQ follows its own
table (below).

## Once per wallet

The faucet pays each asset once per wallet. A wallet that has received its
USDX gets no more USDX from the faucet, and gets more by trading for it; it can
still ask for each asset it has not received. The rule is meant for people
using a wallet or this page, and does not try to stop someone who sets out to
get around it.

Every payout is kept in a claims ledger (`FAUCET_LEDGER`), under each key the
request carried:

| key | from |
| --- | --- |
| the wallet's id | `wallet` in the request (below) |
| the address | the address paid, or a receive code's address |
| the wallet's mailbox | the receive request's `mailbox`, the same in every request one wallet makes, whether sent as `request` or inside a receive code |
| the Bitcoin ark address | a receive code's `ark` part, for BTC |
| the requester's IP | counted by wallets, for a day only: up to ten different wallets per asset (`FAUCET_IP_WALLETS`, `FAUCET_IP_WINDOW_MS`) |

A request is refused with a `429` when any of its keys but the IP was paid
that asset before. An IP is refused an asset once it has been paid it for ten
different wallets in the last day, so a shared network (a meetup, an office)
funds ten wallets, and a script pasting fresh addresses gets no further; a
wallet here is the request's wallet id, or its mailbox, ark address or address
when it sends none. The refusal then says when the next request from that
network can be paid. Payouts in flight count against the IP too.

The ledger is a file outside the checkout,
read when the faucet starts and written, and flushed to disk, before it
answers, so a restart or a deploy forgets nothing. A payout is recorded only
once it succeeded, and while one is being paid, any other request for the same
asset that shares a key with it is refused, so two requests in flight never
both pay. The file holds addresses, wallet ids and mailbox keys, which a
payment to them would show anyway, and each IP only as a hash.

A wallet's id is the hex of
`sha256("sequentia-faucet-wallet/1" || scriptPubKey)`, where `scriptPubKey` is
that of the wallet's first Sequentia receive address (index 0), the bytes of
the script. Every wallet made from one phrase has the same id, on any device
and after a restore, and the id says nothing a payment to that address would
not. The web wallet, Ambra browser and Ambra mobile send it with every request,
BTC included.

`GET /faucet/claimed?wallet=<id>` (or `?address=<address>`) answers which
assets that wallet has already received, so a wallet can show it without
asking for a payout:

```json
{ "claimed": ["BTC", "USDX"] }
```

Our own services and scripts are never refused. A request that reaches the
faucet directly on the loopback (`http://127.0.0.1:9960/`), with no proxy's
forwarding header, comes from the box itself: the site front door always adds
`X-Forwarded-For`, so no outside request looks like one. Tooling that runs
elsewhere sends the token held in `FAUCET_EXEMPT_TOKEN_FILE` as the header
`X-Faucet-Exempt`. Neither kind is checked against the ledger or kept in it.

Live at [sequentiatestnet.com/faucet](https://sequentiatestnet.com/faucet).

## API

`POST /faucet`

```json
{ "address": "tb1...", "asset": "USDX", "wallet": "<64 hex>" }
```

`asset` is optional; omitting it sends tSEQ. `wallet` is the wallet's id
(above); a request without one is held to its other keys. `address` may be a wallet's
receive code (`BITCOIN:<ADDRESS>?ark=…&sequentia=…`, the web wallet's format,
written by its `pay-code.js`) in place of an address: the faucet reads the part
it pays (`receive-code.js`), the code's address for every asset and, for BTC,
its address on the Bitcoin ark. On success the response carries the txid:

```json
{ "txid": "...", "amount": "500000", "asset": "USDX" }
```

Errors are `400` for an address that is not a valid Sequentia address, an
asset that is not on the faucet's list or a `wallet` that is not 64 hex digits,
`429` when the request is refused under the rule above, and `502` when the node
refused the send (the node's own message is passed through). A `429` says why
in words a person can act on, and in `reason`:

```json
{ "asset": "USDX", "claimed": true, "reason": "wallet",
  "error": "This wallet has already received its USDX from the faucet. The faucet pays each asset once per wallet. To get more, trade for it in the wallet." }
```

| `reason` | `claimed` | means |
| --- | --- | --- |
| `wallet` | true | the wallet's id, mailbox or Bitcoin ark address was paid this asset |
| `address` | true | the address was paid this asset |
| `network` | false | the IP was paid this asset for ten different wallets in the last day; the message says how long until it can ask again, and `next` gives that time |
| `busy` | false | a payout to one of the same keys is being paid now, or more leaf payouts wait their turn than the faucet queues (`FAUCET_LEAF_MAX_WAITING`) |

Addresses may be transparent (`tb1`, the default on Sequentia) or blinded
(`tsqb1`). Both are funded the same way, except tSEQ paid from the drip
covenant (below), which goes to transparent addresses only: a `tsqb1` address
gets a `400`, and a request made before the reserve's next interval a `429`.

### Asking for a leaf

A wallet on an Arca operator can be funded without any coin on the chain: in
place of `address` it sends the receive request it hands out (the `arca:…`
text of `arca receive`, with its lapse), and the faucet pays the asset into it
as a leaf, out of round, from a wallet of its own on the operator (see "Paying
leaves" below):

```json
{ "request": "arca:7b22617263615f72657175657374223a31…", "asset": "USDX" }
```

```json
{ "amount": "500000", "asset": "USDX", "leaf": { "asset": "<asset id>", "atoms": "50000000000000", "owner": "<the request's key>" } }
```

The coin is in the wallet's mailbox once the faucet answers: the wallet's
`arca mailbox` takes it in at once (so does its next `arca sync`).
The amount is the one an on-chain request of the asset pays now (for tSEQ the
tier in force), or the request's own value when it asks for less. The same
rule applies: once per wallet per asset (its `wallet` id and the request's
mailbox key, which every request of a wallet carries), and per IP by its count,
and a leaf and an on-chain payout of one asset count together. Refused with a
`400`: a request that has lapsed or names no lapse, one for another operator
or another chain, an asset the operator does not serve or the faucet does not
pay as a leaf, a request naming another asset than the one asked, and anything
that is not a receive request. A `503` says the faucet has no leaves of the
asset to pay now, and a faucet without a leaf wallet answers every receive
request with a `400`. The page itself sends what is pasted, a receive code or an
address.

### BTC

`{ "address": "<receive code or tb1 address>", "asset": "BTC" }` pays testnet4
bitcoin from the Bitcoin side of the faucet's own `arca` wallet (Bark's wallet
for the Bitcoin ark, `btc.js`). A receive code with an `ark` part is paid
there, which is where the web wallet holds BTC, and it arrives in seconds; a
plain `tb1` address is paid on chain. The response is
`{ "amount": "0.001", "asset": "BTC", "ark": true, "txid": null }` (`txid` set
for an on-chain payment). The amount follows what the wallet can send now:

| BTC the faucet can send | BTC per request |
| --- | --- |
| 0.02 or more | 0.001 |
| 0.005 to 0.02 | 0.0005 |
| 0.001 to 0.005 | 0.0002 |
| under 0.001 | nothing (`503`) |

`GET /faucet/amount?asset=BTC` returns the amount in force. The same rule
applies: once per wallet, address and ark address, and per IP by its count. The wallet is
the faucet's alone; the operator keeps it topped up from the testnet4 service
wallet (sequentia-testnet-ops, consumer `faucet-btc`). A faucet without
`FAUCET_BTC_ARCA` answers BTC requests with a `400`.

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
| `FAUCET_LEDGER` | `/root/sequentia/faucet-state/claims.jsonl` | the claims ledger (above); its directory is made, mode 700, when missing |
| `FAUCET_IP_WALLETS` | `10` | how many different wallets one IP is paid each asset for in the window |
| `FAUCET_IP_WINDOW_MS` | `86400000` | the window an IP's count of wallets is kept for |
| `FAUCET_EXEMPT_TOKEN_FILE` | unset | a file holding the token (32 characters or more) that exempts our own tooling, sent as `X-Faucet-Exempt`; unset, only loopback requests are exempt |
| `FAUCET_DRIP` | unset | the `faucet-drip` command; set, tSEQ is paid from the drip covenant (below) |
| `FAUCET_DRIP_INSTANCE` | unset | with `FAUCET_DRIP`: the covenant's instance file |
| `FAUCET_DRIP_MNEMONIC` | unset | with `FAUCET_DRIP`: a file holding the mnemonic of the faucet key |
| `FAUCET_DRIP_TEMPLATE` | unset | with `FAUCET_DRIP`: the template directory; unset, the one in Cargo's cache (below) |
| `SEQC_HELPERS` | unset | with `FAUCET_DRIP`: the helpers directory the template includes; unset, the one in Cargo's cache (below) |
| `FAUCET_LEAF_ARCA` | unset | the `arca` command line; set, receive requests are paid as leaves (below) |
| `FAUCET_LEAF_DATADIR` | unset | with `FAUCET_LEAF_ARCA`: the leaf wallet's directory |
| `FAUCET_LEAF_OPERATOR` | unset | with `FAUCET_LEAF_ARCA`: the operator key the leaf wallet must be on; a request for another operator is refused |
| `FAUCET_LEAF_ASSETS` | unset | with `FAUCET_LEAF_ARCA`: the assets paid as leaves, `label=asset id,…` (`tSEQ=<id>,USDX=<id>`) |
| `FAUCET_LEAF_LOW` | `5` | board more of an asset when the leaves hold fewer payouts of it than this (`0`: never board) |
| `FAUCET_LEAF_WARN` | `8` | an asset whose leaves, boards under way and on-chain coins together hold fewer payouts than this is low: the log says so once, and `/leaves` and the check say so until it is funded |
| `FAUCET_LEAF_BOARD` | `20` | how many payouts of an asset one board brings in |
| `FAUCET_BTC_ARCA` | unset | the `arca` command line; set, BTC is paid from its wallet's Bitcoin side (Bark's `bark` named by `ARCA_BARK_EXEC`) |
| `FAUCET_BTC_DATADIR` | unset | with `FAUCET_BTC_ARCA`: the `arca` wallet's directory, whose `bitcoin/` holds the Bitcoin side |
| `FAUCET_BTC_REFRESH_MS` | `60000` | how often the Bitcoin side's balance is read |
| `FAUCET_BTC_LOCK_WAIT_MS` | `3000` | the wait before a Bark command that found the wallet held by another process is tried again (five times at most) |
| `FAUCET_LEAF_SYNC_MIN_MS`, `FAUCET_LEAF_SYNC_MAX_MS` | `60000`, `3600000` | the bounds on the time between two syncs of the leaf wallet |
| `FAUCET_LEAF_PAY_QUIET_MS` | `10000` | no sync of the leaf wallet starts within this long of the last leaf payout |
| `FAUCET_LEAF_MAX_WAITING` | `20` | the most leaf payouts that wait their turn; one more is refused as `busy` |

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

The tool reads the `faucet_drip` template, and the helpers it includes, at run
time. Unset, it reads them from Cargo's checkout of `sequentia-contracts` at the
commit `drip/Cargo.lock` pins, and Cargo's cache cleaning deletes a checkout no
build has used for a month, after which every drip fails with "descriptor.json:
No such file". A deployment therefore keeps a git checkout of that commit of its
own and points the faucet at it:

```
REV=$(sed -n 's/^source = "git+https:\/\/github.com\/ConcatenaLabs\/sequentia-contracts?rev=[0-9a-f]*#\([0-9a-f]*\)"$/\1/p' drip/Cargo.lock)
git clone https://github.com/ConcatenaLabs/sequentia-contracts /root/sequentia/sequentia-contracts-faucet
git -C /root/sequentia/sequentia-contracts-faucet checkout --detach "$REV"
```

with `FAUCET_DRIP_TEMPLATE=/root/sequentia/sequentia-contracts-faucet/templates/faucet_drip`
and `SEQC_HELPERS=/root/sequentia/sequentia-contracts-faucet/helpers` in the
faucet's environment. When `drip/Cargo.lock` moves to another commit, check the
checkout out at that commit too.

| command | does |
| --- | --- |
| `key --mnemonic-file F` | prints the contract key a mnemonic signs with, to name as a faucet or treasury key |
| `key --new [--mnemonic-file F]` | makes a new twelve-word mnemonic and prints its contract key; the mnemonic is printed once on stdout, or with `--mnemonic-file` written to `F`, a new file readable by its owner alone, and not printed |
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
faucet key and stays on the server, readable by the faucet's user alone: make it
there with `key --new --mnemonic-file F`, so the words never cross a terminal.
Make the treasury's mnemonic away from the server and keep it offline.

`status` and `drip` both find the reserve with the node's `scantxoutset`, which
runs one scan at a time. The faucet therefore never runs them together: its
periodic status check is skipped while a drip is paying, and a request that
arrives during a status check waits for it to end.

## Paying leaves

With `FAUCET_LEAF_ARCA` set, the faucet pays receive requests from a wallet
of its own on an Arca operator: the `arca` command line
([arca](https://github.com/ConcatenaLabs/arca), `bark-cli`) on the directory
`FAUCET_LEAF_DATADIR`. That wallet is the faucet's alone, never the drip
covenant's reserve and never the treasury: it is funded by boarding its own
on-chain coins, which are sent to it like to any address (`arca address`).

- **A payout** is `arca send REQUEST --amount N --asset ID`, one command at a
  time on the wallet, and before any of the wallet's upkeep: a payout waits
  only for the one upkeep command already running, and payouts asked together
  wait their turn (up to `FAUCET_LEAF_MAX_WAITING` of them; past that one is
  refused with a `429`, `reason` `busy`). Each payout's log line says how long
  it waited, behind what, and how long its send took. Before it, the faucet checks the request's operator (`FAUCET_LEAF_OPERATOR`),
  its chain, the asset and its lapse against the chain's median time at the
  wallet's last sync, with a minute's margin; the wallet then checks the lapse,
  the operator and the asset again against the chain now before it signs.
- **Syncs** follow the library's schedule: after each `arca sync` the faucet
  runs the next when `schedule.next_sync_at` says, within
  `FAUCET_LEAF_SYNC_MIN_MS` and `FAUCET_LEAF_SYNC_MAX_MS`, and within
  `FAUCET_LEAF_SYNC_MIN_MS` while a board waits to be taken up. A sync is the
  one long command (a round it takes part in can hold it a minute or more), so
  it never starts while a payout waits or within `FAUCET_LEAF_PAY_QUIET_MS` of
  the last one, and one that takes over 20 seconds is logged with its slowest
  steps. A sync reads the
  wallet's mailbox, moves its boards on and refreshes its coins in their free
  window before their exit deadline, so the wallet's coins stay alive by
  themselves.
- **Boards**: at each pass of the upkeep, an asset whose leaves hold fewer than
  `FAUCET_LEAF_LOW` payouts, and none boarding, is boarded with
  `FAUCET_LEAF_BOARD` payouts from the wallet's on-chain coins, at most nine
  tenths of them (the rest pays the board's fee, in the asset boarded). When
  the on-chain coins cannot cover a payout the log says so: fund the wallet's
  address. The faucet then reads the wallet's balance again every
  `FAUCET_LEAF_SYNC_MIN_MS`, without a sync, and boards once the coins show.
- **Before it runs out**: at each reading of the balance the faucet counts each
  asset's payouts (in leaves, boarding, and what its on-chain coins can still
  board, at nine tenths). Under `FAUCET_LEAF_WARN` of them the log says once
  `leaf wallet: <ASSET> runs low: …; fund <datadir> on-chain before it runs
  out`, and again when it holds enough. `GET /leaves` answers the same counts:

  ```json
  { "warn": 8, "assets": { "USDX": { "leaves": 2, "boarding": 0, "onchain": 17, "low": false } } }
  ```

  `deploy/faucet-check.sh`, run every 15 minutes by `faucet-check.timer`,
  fails naming each low asset, and tells a person once when its verdict
  changes, through `FAUCET_ALERT` (by default the box's `pignus-alert.sh`).
  An asset that runs out is paid on the chain instead, after a block rather
  than in seconds, so funding it early keeps the receive card's "in seconds"
  true.

Setting it up on the operator's chain:

```
arca --datadir /var/lib/sequentia-faucet/leaves create --server https://<host>/arca \
  --node-url http://127.0.0.1:<rpc port> --node-cookie <cookie file>
arca --datadir /var/lib/sequentia-faucet/leaves address    # fund it with each asset to pay as leaves
```

then set `FAUCET_LEAF_ARCA`, `FAUCET_LEAF_DATADIR`, `FAUCET_LEAF_OPERATOR` (the
key `create` printed and pinned) and `FAUCET_LEAF_ASSETS`, and restart the
faucet. The node must run with `-txindex` and `-validateanchor`, as for any
Arca wallet.

## Testing

```
npm install
npm test
```

runs the request path with `FAUCET_CLI` pointed at `echo` or a stand-in, the
once-per-wallet rule (`test/once.test.js`: each key, the IP window, a restart,
a line cut short, two requests in flight, the exemption), the drip
covenant's path with a stand-in for the tool, and the leaf path with a
stand-in for `arca` (`test/fake-arca.js`), so no coins move; the stand-in
refuses a second scan while one is running, as the node does. With a built tool
it also checks `key --new`, and with a built node it runs the tool against a
local `elementsregtest` chain:

```
cargo build --manifest-path drip/Cargo.toml
FAUCET_REGTEST_BIN=/path/to/Sequentia/src FAUCET_DRIP=drip/target/debug/faucet-drip npm test
```

CI (`.github/workflows/tests.yml`) builds the tool and runs `npm test` with `FAUCET_DRIP` on
every pull request and on `main`; the local-chain test needs a node and is not run there.

## Deploy

`deploy/sequentia-faucet.service` is the systemd unit; `deploy/faucet-check.service`
and `deploy/faucet-check.timer` run the payouts-left check (above). The box pulls this repo
from GitHub and runs it there; source is never edited on the server. The claims
ledger lives outside the checkout, so a deploy never touches it; keep it in
the box's backups.
