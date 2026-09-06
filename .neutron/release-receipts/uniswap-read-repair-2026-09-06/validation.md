# Browser RPC release — 2026-09-06

The final intended catalog set is Kernel 0.3.43, EVM Wallet 0.1.9, and Uniswap 0.1.5. Every EVM JSON-RPC read and signed-transaction broadcast now uses one direct browser connection to PublicNode. The backend retains chain-key custody and durable wallet state, with no EVM RPC canister capability. No MetaMask is needed.

Uniswap requests one exact group of six read-tool grants per connected caller/provider session. Reconnecting either endpoint renews that permission. Transaction/signature requests still show their own owner review. Independent quote tiers and fee reads run concurrently; quotes render before optional fee observations complete. Wallet preparation is visible immediately, and Approve/Decline remain visible on narrow screens.

## Memory and compatibility

The released Kernel memory roots (kernel@4 and kernel_activation@1), EVM roots (evm_wallet@1 and evm_evidence@1), and Uniswap root (uniswap@1) retain their schemas and complete lock lineage. No migration or memory reset was introduced. Existing public wallet-tool shapes remain compatible; new browser observation methods are additive.

## Validation already completed

- Kernel: 755 JavaScript tests and 33 Motoko programs; refreshed certified-assets qualification; final archive/metadata checks 35 tests, 523 assertions.
- SDK: 338 tests, 3,045 assertions.
- Uniswap: 94 unit tests, clean/restore memory test, and 25 sandbox UI cases.
- EVM backend: 9 tests including compiled Motoko programs; browser helper/provider tests covered live generated Candid inputs, approval revisions, nonce changes and saved-byte recovery. Final 0.1.9 package checks: 7 tests, 338 assertions.
- EVM approval UI: 22 sandbox cases, including narrow-screen review controls.
- Actual opaque-origin Chromium → live Candid bridge → production backend with test custody → isolated Anvil: native and ERC-20 recipient balances verified, exactly two signatures/two browser broadcasts. An accepted broadcast with a lost response survived browser/backend reload and reconciled the same hash without another signature or broadcast. This uses a deterministic local fixture key and unforked test balances, not production funds.
- PublicNode CORS reads succeeded for Ethereum, Arbitrum and Sepolia from an opaque iframe. These were read-only public-network checks.

Per the user's explicit request, publication proceeded before the remaining checked-upgrade runtime qualification. The first exact-package compile then found that four anonymous argument names generated invalid Motoko input aliases in EVM 0.1.8. Its package/source bytes and batch53 receipt remain immutable. EVM 0.1.9 changes those four argument names to valid named arguments, and both combined-successor and separate clean-target compilation passed before correction publication. The initial failure is preserved in checked-upgrade/initial-failure.json; final runtime evidence is in checked-upgrade-109.

## Diagnostic scope and remaining issue

The reported anonymous unsafe-schema and self-call argument errors could not be reproduced from the exact published EVM/Uniswap service bundles. Errors now identify the actual tool or installed app/method, without logging argument contents. This improves diagnosis rather than claiming an unverified root cause.

A source review identified a remaining rare reorg recovery edge: if an original transaction wins, its replacement is marked replaced, and that original is later reorged out, refreshing only the replacement can retain the stale classification. Refreshing the original first resolves it. This release does not add a new predecessor-discovery API to address that case.

Publishing changes update discoverability only. No production Neutron was installed/reset, no Dispenser starter was changed, and no production EVM transfer was submitted.

Final exact checked-upgrade and clean-initialization qualification passed: 288 assertions in 89.9 seconds. All 12 installed roots were kept; account/install identities, signed raw bytes and hashes, token evidence and journals survived. Browser recovery used zero additional signatures and zero legacy RPC calls. The original transaction reserved nonce 9; the next unsigned candidate used 10. See checked-upgrade-109/qualification-summary.json.
