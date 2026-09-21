# Wallet Ethereum withdrawal release

Wallet v0.3.34 fixes Ethereum withdrawals to the EVM Wallet account and entered
Ethereum addresses. The saved request previously exposed `request_id` through
a getter, which the self-call encoder rejected before backend preparation with
`Self-call records require enumerable data properties`. Each preparation now
receives a frozen plain record with fresh request-ID bytes, preserving the same
reviewed intent and ID across retries.

Validation completed before publication:

- `npm --workspace neutron-wallet run package`: passed.
- `bun test` from `apps/wallet`: 342 passed, zero failed.
- `npm --workspace neutron-wallet run test:motoko`: all 20 programs passed.
- `npm --workspace neutron-wallet run test:memory`: clean initialization and
  representative nonempty memory restoration passed.
- `npm --workspace neutron-wallet run test:browser`: all six browser suites passed.
- `npm exec tsc -- -b apps/wallet --pretty false`: passed.

The new regression reproduced the reported encoder error for ckETH, ckUSDC,
and ckUSDT before the fix. It now passes, together with lost preparation and
resume reply tests that preserve one withdrawal intent. Backend responses in
the frontend regression are fixtures; no production token transfer was used
for validation.

The backend, all eight v1 memory roots, immutable lock, capabilities and
dependencies are unchanged. Archive lineage tests include the exact v0.3.31,
v0.3.32 and v0.3.33 predecessors alongside earlier released roots. The final
archive retains the same 85 runtime, manifest and schema files exercised by
the release tests; the final source artifact also includes the test type fixes.

The exact [v0.3.34 archive](../../../../apps/wallet/wallet.v0.3.34.neutron) and
matching offered-source artifact are retained in the repository. Their paths,
sizes, SHA-256 digests and validation results are recorded in
[release-verification.json](./release-verification.json).

[Beta publication](./beta-publish.json) and [stable promotion](./stable-promote.json)
were each followed by a verified receipt-v2 no-op: [beta](./beta-repeat.json) and
[stable](./stable-repeat.json) both report `batch_id: null` and unchanged exact
package/source identities. Publication makes the update discoverable; existing
Neutrons install it through the normal state-preserving update transaction.
The Dispenser starter is unchanged.
