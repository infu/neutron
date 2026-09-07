# Wallet 0.3.19 saved-deposit dismissal release

Wallet 319 adds Dismiss/Restore for saved Ethereum deposit reminders, including legacy approvals whose RPC reads fail. Dismiss persists a local preference without Ethereum checks or financial effects. It removes reminders and polling while preserving exact approval and deposit evidence for recovery. A token-keyed component keeps pending preferences scoped when switching assets.

All six released memory roots, schema bytes and lock lineage remain unchanged. The only new root is wallet_bridge_activity@1, an ID/timestamp preference map. Clean initialization and restoration from supported released predecessors, including immutable Wallet318, pass. Claim and record route through a combined frontend step method; the old backend endpoints remain available. There are still exactly 32 preapproved self methods. No Kernel change, state reset or destructive reinstall.

Validation completed before publication:

- npm --workspace neutron-wallet test: canonical full package, 198 TypeScript tests (1637 assertions), 16 Motoko backend suites and managed-memory restoration program passed.
- App and scripts TypeScript checks passed; git diff --check passed.
- Browser qualification: 12 checks at 375px and 700px, zero runtime errors. Covers legacy RPC failure, stuck background refresh, unknown/submitted deposits, exact record retention, reload and original-ID Restore. Final screenshots and mocked boundary traces are in browser/.
- Financial execution used local fixtures only. No real funds were moved or production app installed.

Publication:

- Root npm run updates:publish succeeded in atomic batch 60; only Wallet changed.
- Identical second publication returned receipt-v2 batch_id:null, all 18 package/source pairs unchanged with exact identity, size and SHA-256 verified by verify-receipts.ts.
- preflight.json records exact package and offered-source artifacts; receipt-verification.json verifies their bytes remain unchanged after publication.
- Wallet archive SHA-256: dc2bf1557ddc121fb25d38e2075ae8864aea0eba7fe5d55301b0b2bd707517f6 (804495 bytes).
- Offered source SHA-256: 27760b61c59a680598ca33f084c5fc494362bd49a364f9254c3301ae0324002a (709824 bytes).

Publication makes Wallet 0.3.19 discoverable. Existing Neutrons install it through the checked in-product update transaction. The Dispenser starter was not changed.
