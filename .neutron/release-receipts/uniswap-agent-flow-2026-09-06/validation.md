# Uniswap 107 Agent continuation release

This release changes only Uniswap. Kernel 343, Agent 317 and EVM Wallet 110 retain their previously published bytes. Published atomically in batch 56 to `233tv-xiaaa-aaaay-aacta-cai`. The identical-byte postflight returned `batch_id: null`; all 18 package/source pairs match local identities. See [preflight](preflight.json), [publication](production-publish.json), [no-op](production-publish-noop.json), and [verification](receipt-verification.json).

## Fix

Uniswap's Agent calls serialize nested Wallet requests using the existing invocation-scoped Kernel client. Independent pool/metadata/fee reads no longer overlap the Kernel's single pending permission decision. The normal connected tile retains concurrent reads. Cancellation and transport options survive the queue, and a failed pool does not block subsequent pool checks.

The additive `uniswap_next_action_v1` tool returns one exact next action for a saved Agent swap. It reconciles the original swap before another effect, verifies supplied transaction hashes with the existing public evidence and Wallet request-binding checks, and guides the root through approval, swap and receipt tracking. No nested root signing is introduced. Preparing, signed, submitted, uncertain and lost-response requests retain their original IDs. An expired unsigned swap with resolved approval gets fresh quote inputs preserving the original amount/assets/recipient/slippage and quote validity duration; actual allowance is checked again, so confirmed approval need not repeat. The Agent must continue to respect the owner's original constraints.

Quote and continuation tools report progress and use the existing long-running-tool annotation. No Kernel permission policy, Agent retry rule, signing capability, backend method, schema or memory migration changed.

## Validation

- [Permission regression before](permission-before.log): real unchanged Kernel `requestAgentConsent`, delayed asynchronous decisions, three failures. Only the first pool was checked; custom token symbol lookup collided; failure of that pool prevented a quote.
- [Permission regression after](permission-after.log): 20 isolated handler tests / 651 assertions passed, including all four tiers, both fee estimates, custom metadata, failure recovery, cancellation, and ordinary parallel UI dispatch.
- [Complete Uniswap Bun suite](release-tests.log): 109 tests / 970 assertions passed, including eight Agent continuation cases with real controller verification and mocked Wallet/RPC evidence. Covers expired 3 USDC approval reuse, lost swap reply, nonvisible transaction, preparing state and rejecting a false completion claim.
- App and scripts TypeScript checks passed; the complete workspace [package command](package.log) passed.
- [Memory program](memory-test.log) passed clean initialization and restoration. The sole `uniswap@1` root, all three backend modules and lock file match the released 106 baseline ([audit](memory-audit.json)); packaged 106-to-107 planning retains the root. No migration is required.

All financial observations in execution tests are mocked. No real-token transaction, production installation, state reset or Dispenser update was performed. V3 routing is unchanged; existing USDT allowance-reset behavior is outside this change.
