#!/usr/bin/env bash
# Regenerate the SNS Candid bindings from a dfinity/ic checkout.
#
#   IC_REPO=/path/to/ic ./scripts/gen-candid.sh
#
# Bindings are checked in deliberately: the app must build without a network
# fetch, and a diff on regeneration is how we notice an SNS interface changed.
set -euo pipefail
IC="${IC_REPO:-/tmp/snsresearch/ic}"
[ -d "$IC" ] || { echo "set IC_REPO to a dfinity/ic checkout" >&2; exit 1; }
OUT="$(cd "$(dirname "$0")/.." && pwd)/src/candid"
mkdir -p "$OUT"

gen() {
  local name="$1" did="$2" tmp
  tmp="$(mktemp -d)"
  npx --yes @icp-sdk/bindgen@0.4.0 --did-file "$did" --out-dir "$tmp" \
    --actor-disabled --declarations-flat >/dev/null
  cp "$(ls "$tmp"/*.did.js | head -1)"   "$OUT/$name.did.js"
  cp "$(ls "$tmp"/*.did.d.ts | head -1)" "$OUT/$name.did.d.ts"
  rm -rf "$tmp"
  echo "  $name"
}

gen sns_governance "$IC/rs/sns/governance/canister/governance.did"
gen sns_root       "$IC/rs/sns/root/canister/root.did"
gen sns_swap       "$IC/rs/sns/swap/canister/swap.did"
gen sns_wasm       "$IC/rs/nns/sns-wasm/canister/sns-wasm.did"
gen icrc_ledger    "$IC/rs/ledger_suite/icrc1/ledger/ledger.did"
gen icrc_index     "$IC/rs/ledger_suite/icrc1/index-ng/index-ng.did"

REV="$(git -C "$IC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
OUT="$OUT" REV="$REV" python3 -c '
import glob, os
out, rev = os.environ["OUT"], os.environ["REV"]
hdr = ("// GENERATED FILE - do not edit.\n"
       "// Source: dfinity/ic %s, regenerate with `npm run candid:gen`.\n"
       "// Imports are rewritten to @dfinity/* so the bundle carries exactly one\n"
       "// Candid codec; two copies produce non-interoperable IDL instances.\n" % rev)
for f in glob.glob(out + "/*.did.js") + glob.glob(out + "/*.did.d.ts"):
    s = open(f).read()
    s = (s.replace("@icp-sdk/core/candid", "@dfinity/candid")
          .replace("@icp-sdk/core/principal", "@dfinity/principal")
          .replace("@icp-sdk/core/agent", "@dfinity/agent"))
    if not s.startswith("// GENERATED FILE"):
        s = hdr + s
    open(f, "w").write(s)
'
echo "done"
