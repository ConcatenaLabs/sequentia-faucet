#!/usr/bin/env bash
# Does the faucet still have what it pays? An asset whose leaf wallet runs dry is paid on the
# chain instead, after a block rather than in seconds, and nothing says so until a tester notices.
# This asks the faucet (/leaves) how many payouts of each asset its leaf wallet holds (in leaves,
# boarding, and what its on-chain coins can still board) and fails, naming each, when one holds
# fewer than the faucet's warning level (FAUCET_LEAF_WARN): early enough to fund it before it runs
# out.
#
#   deploy/faucet-check.sh                         # by hand: prints the verdict
#   faucet-check.timer                             # every 15 minutes
#
# A run by the timer (systemd sets INVOCATION_ID) tells a person when its verdict changes, once,
# through FAUCET_ALERT (a command taking the message as its arguments; by default the box's
# pignus-alert.sh when it is there), and keeps the last verdict in STATE_DIRECTORY.
# Exit 0 when every asset holds enough, 1 naming each that does not, 2 when the faucet does not
# answer.
set -uo pipefail
URL="${FAUCET_URL:-http://127.0.0.1:9960}"
ALERT="${FAUCET_ALERT:-/root/sequentia/pignus/deploy/pignus-alert.sh}"
STATE="${STATE_DIRECTORY:-}"

body=$(curl -sf --max-time 20 "$URL/leaves") || body=""
if [ -z "$body" ]; then
  verdict="faucet check FAILED: the faucet does not answer at $URL/leaves"; rc=2
else
  low=$(python3 -I -c '
import json,sys
j = json.loads(sys.argv[1]); w = j.get("warn")
for k, c in sorted((j.get("assets") or {}).items()):
    if c.get("low"): print("%s %d in leaves, %d boarding, %d on chain (under %s)" % (k, c["leaves"], c["boarding"], c["onchain"], w))
' "$body")
  if [ -n "$low" ]; then verdict="faucet check FAILED: fund the faucet's leaf wallet on-chain: $(paste -sd ';' <<<"$low" | sed 's/;/; /g')"; rc=1
  else verdict="faucet check passes: every asset holds enough payouts"; rc=0; fi
fi
echo "$verdict"
if [ -n "${INVOCATION_ID:-}" ] && [ -n "$STATE" ]; then
  was=$(cat "$STATE/verdict" 2>/dev/null || true)
  # A change of verdict is news; the same one again is not (the counts in it change every run).
  if [ "${was%%:*}" != "${verdict%%:*}" ]; then
    if [ -x "$ALERT" ]; then "$ALERT" "$verdict" || true; else echo "no alert command at $ALERT: the verdict is in the journal only"; fi
  fi
  printf '%s\n' "$verdict" > "$STATE/verdict"
fi
exit $rc
