# SNS Governance Candid compiler release

SNS Governance v0.1.18 packages the Candid compiler Wasm and resolves its URL
beside the resident service bundle. Both UI and agent custom proposals use that
service. A browser regression reproduced `Unable to load Candid compiler Wasm
(404)` before the fix and compiled exact payload bytes successfully afterwards.

Validation completed before publication:

- `npm --workspace neutron-snsgov test`: 362 passed, zero failed, eight optional
  mainnet tests skipped; the managed-memory initialization/restoration test passed.
- `npm --workspace neutron-snsgov run verify:write-path`: passed against genuine
  SNS Governance and Ledger canisters in isolated PocketIC, including custom
  function registration, validation, execution and invalid-payload rejection.
- `npx tsc -b apps/snsgov --pretty false`: passed.
- Final browser, package and memory-lineage regression checks: 17 passed.

The backend, capabilities and both v1 memory roots are unchanged. The retained
v0.1.15 and v0.1.16 archives supply predecessor evidence for the memory tests.
No released schema or lock lineage was changed.

The exact [v0.1.18 archive](../../../../apps/snsgov/snsgov.v0.1.18.neutron) and
its matching offered-source artifact are retained in the repository. Their
paths, sizes and SHA-256 digests are recorded in
[release-verification.json](./release-verification.json).

[Beta publication](./beta-publish.json) and [stable promotion](./stable-promote.json)
were each followed by a verified receipt-v2 no-op: [beta](./beta-repeat.json) and
[stable](./stable-repeat.json) both report `batch_id: null` and unchanged exact
package/source identities. Publication does not install the update into existing
Neutrons or change the Dispenser starter.
