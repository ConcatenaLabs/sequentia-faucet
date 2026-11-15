#!/usr/bin/env bash
# Keeps the faucet's leaf wallet funded, so payouts go out as leaves (in seconds) and the wallet
# never runs down to the slower on-chain payout while nobody is looking.
#
# It asks the faucet (/leaves) how many payouts of each asset its leaf wallet holds (in leaves,
# boarding, and what its on-chain coins can still board). An asset that holds fewer than TOPUP_AT
# is sent what brings it to TOPUP_TO, on the chain, to the leaf wallet's own address, from the
# wallet the faucet itself pays from (FAUCET_WALLET in the faucet's unit: named there, never
# chosen here). The faucet boards the coins by itself.
#
#   deploy/faucet-topup.sh                         # by hand: prints what it did
#   faucet-topup.timer                             # every 15 minutes
#
# Bounds, so a fault or an abuser cannot empty the source through it:
# - one send of an asset is at most half of what the source holds of it;
# - an asset is sent at most TOPUP_DAILY times a UTC day, and not again within TOPUP_GAP_MIN
#   minutes of its last send (the faucet needs a block and a reading to count the coins);
# - tSEQ is never sent: the drip covenant pays it.
# Every send is kept as a file in the state directory (<day>-<asset>-<n>.txid, the n-th that day).
#
# Settings are the faucet's own, read from its unit (FAUCET_CLI, FAUCET_DATADIR, FAUCET_WALLET,
# FAUCET_LEAF_ARCA, FAUCET_LEAF_DATADIR, FAUCET_LEAF_ASSETS), so the two cannot disagree.
# Prints no key and no password. Exit 0 when nothing was owed or every send went out (an asset
# left short by a bound is said, and deploy/faucet-check.sh is what fails on it); 1 when a send
# or a reading failed; 2 when the faucet does not answer.
set -Eeuo pipefail
shopt -s inherit_errexit
export LC_ALL=C

: "${FAUCET_URL:=http://127.0.0.1:9960}"
: "${UNIT:=sequentia-faucet.service}"
: "${TOPUP_AT:=12}"
: "${TOPUP_TO:=30}"
: "${TOPUP_DAILY:=3}"
: "${TOPUP_GAP_MIN:=45}"
: "${TOPUP_SKIP:=tSEQ}"
STATE="${STATE_DIRECTORY:-${TOPUP_STATE:-}}"
[ -n "$STATE" ] || { echo "faucet top-up: name where its records are kept: TOPUP_STATE=<directory>"; exit 1; }
mkdir -p "$STATE"
exec 9> "$STATE/lock"
flock -n 9 || { echo "faucet top-up: already running"; exit 0; }
# For a test: the unit's environment from elsewhere.
: "${ENVS:=$(systemctl show -p Environment --value "$UNIT")}"
getenv() { tr ' ' '\n' <<<"$ENVS" | sed -n "s/^$1=//p" | tail -n 1; }

CLI=$(getenv FAUCET_CLI); CLI=${CLI:-/root/Sequentia/src/sequentia-cli}
DATADIR=$(getenv FAUCET_DATADIR); DATADIR=${DATADIR:-/root/seq-testnet/node000}
WALLET=$(getenv FAUCET_WALLET); WALLET=${WALLET:-treasury2026}
ARCA=$(getenv FAUCET_LEAF_ARCA); LEAF=$(getenv FAUCET_LEAF_DATADIR); IDS=$(getenv FAUCET_LEAF_ASSETS)
[ -x "$CLI" ] || { echo "faucet top-up: no node command line at $CLI"; exit 1; }
[ -x "$ARCA" ] && [ -d "$LEAF" ] || { echo "faucet top-up: the faucet's unit names no leaf wallet; nothing to fund"; exit 0; }
src() { "$CLI" -datadir="$DATADIR" -rpcwallet="$WALLET" "$@" < /dev/null; }
idof() { tr ',' '\n' <<<"$IDS" | sed -n "s/^$1=//p"; }
# The running faucet holds the leaf store now and then: a read of it is tried again.
leaf() { local out i; for i in 1 2 3 4 5 6; do out=$("$ARCA" --datadir "$LEAF" "$@" 2>/dev/null) && { echo "$out"; return 0; }; sleep "${TOPUP_RETRY_S:-5}"; done; return 1; }

body=$(curl -sf --max-time 20 "$FAUCET_URL/leaves") || { echo "faucet top-up FAILED: the faucet does not answer at $FAUCET_URL/leaves"; exit 2; }
# One line an asset that is owed something: label, payouts held, payouts owed, one payout in atoms.
owed=$(python3 -I -c '
import json, sys
j = json.loads(sys.argv[1]); at, to = int(sys.argv[2]), int(sys.argv[3]); skip = set(sys.argv[4].split())
for label, c in sorted((j.get("assets") or {}).items()):
    if label in skip or c.get("payout") is None or "leaves" not in c: continue
    held = c["leaves"] + c["boarding"] + c["onchain"]
    if held >= at: continue
    w, _, f = str(c["payout"]).partition(".")
    print(label, held, to - held, int(w) * 10**8 + int((f + "00000000")[:8]))
' "$body" "$TOPUP_AT" "$TOPUP_TO" "$TOPUP_SKIP") || { echo "faucet top-up FAILED: $FAUCET_URL/leaves could not be read"; exit 1; }
if [ -z "$owed" ]; then echo "faucet top-up: every asset holds $TOPUP_AT payouts or more; nothing sent"; exit 0; fi

DAY=$(date -u +%F)
NOW=$(date +%s)
rc=0
ADDR=""
while read -r label held need pay; do
  id=$(idof "$label")
  if [ "$(printf '%s' "$id" | wc -c)" != 64 ]; then echo "faucet top-up FAILED: the faucet's leaf assets name no id of $label"; rc=1; continue; fi
  shopt -s nullglob; recs=("$STATE/$DAY-$label-"*.txid); shopt -u nullglob
  last=0; for f in "$STATE"/*-"$label"-*.txid; do [ -e "$f" ] || continue; m=$(stat -c %Y "$f"); [ "$m" -gt "$last" ] && last=$m; done
  if [ $(( NOW - last )) -lt $(( TOPUP_GAP_MIN * 60 )) ]; then
    echo "faucet top-up: $label holds $held payouts; sent $(( (NOW - last) / 60 )) minutes ago, not again within $TOPUP_GAP_MIN"; continue
  fi
  if [ "${#recs[@]}" -ge "$TOPUP_DAILY" ]; then
    echo "faucet top-up: $label holds $held payouts and was sent $TOPUP_DAILY times today already: not again before tomorrow (UTC)"; continue
  fi
  have=$(src getbalance '*' 0 false false "$id") || { echo "faucet top-up FAILED: $WALLET's balance of $label could not be read"; rc=1; continue; }
  # What is owed, at most half of what the source holds, in whole payouts; printed as coins.
  amount=$(python3 -I -c '
import sys
from decimal import Decimal
need, pay = int(sys.argv[1]), int(sys.argv[2]); half = int(Decimal(sys.argv[3]) * 10**8) // 2
n = min(need, half // pay)
print("" if n < 1 else "%d.%08d" % divmod(n * pay, 10**8))
' "$need" "$pay" "$have")
  if [ -z "$amount" ]; then
    echo "faucet top-up: $label holds $held payouts, and half of what $WALLET holds ($have) is less than one payout: not sent; fund $WALLET"; continue
  fi
  if [ -z "$ADDR" ]; then
    ADDR=$(leaf address | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["address"])') || ADDR=""
    [ -n "$ADDR" ] || { echo "faucet top-up FAILED: the leaf wallet gave no address"; exit 1; }
  fi
  # Each asset pays its own fee, named by its id.
  if txid=$(src -named sendtoaddress address="$ADDR" amount="$amount" fee_rate=2 fee_asset_label="$id" assetlabel="$id" comment="faucet leaves $label top-up"); then
    rec="$STATE/$DAY-$label-$(( ${#recs[@]} + 1 )).txid"
    echo "$txid" > "$rec.tmp"; mv "$rec.tmp" "$rec"
    echo "faucet top-up: $label held $held payouts; sent $amount from $WALLET (it held $have) to the leaf wallet: $txid"
  else
    echo "faucet top-up FAILED: sending $amount $label from $WALLET"; rc=1
  fi
done <<<"$owed"
exit $rc
