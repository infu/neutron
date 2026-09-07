# Saved deposit dismissal browser qualification

Run from the Neutron checkout with its installed dependencies:

```sh
node /tmp/neutron-bridge-dismiss-browser/check.mjs
```

The harness bundles the current `WalletBridgeDeposit`, bridge client, Ethereum execution and EVM bridge adapter from source. Only Neutron self-call and EVM tool boundaries are mocked. The fake canister persists complete original legacy deposit records and a separate dismissed preference in local storage so a full browser reload exercises restoration. Ethereum reads fail, and one background progress request deliberately never returns.

The three synthetic records represent a confirmed token approval followed by a ready deposit, an unknown deposit with its original operation ID, and a submitted deposit with its original transaction hash. Dismissing/restoring must issue exactly one local `wallet_bridge_step_v2` preference write, preserve all original journal bytes and never call an Ethereum provider, prepare a new deposit or send a transaction. Hidden deposits stay out of reminders and Activity across reload, stop background refresh and remain recoverable by their original IDs.

Checks run in Chromium at 375px and 700px with external network requests blocked. Screenshots cover the RPC error with Dismiss visible, the cleared form, expanded Dismissed history and the restored original deposit. The harness also checks non-nested buttons, horizontal fit and readable amount/date layout. `results.json` reports assertions; `*-calls.json` records every synthetic boundary call.

This is an isolated browser qualification, not a real canister integration or a real-funds transaction test. Backend durability and migration are covered separately by the app release tests.
