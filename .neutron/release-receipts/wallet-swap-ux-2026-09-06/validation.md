# EVM Wallet 110 / Uniswap 106 release

Published atomically to `233tv-xiaaa-aaaay-aacta-cai` in batch 55. The identical-byte second publication returned `batch_id: null`; all 18 catalog packages and offered sources match the reviewed local identities. Only EVM Wallet and Uniswap changed. See [preflight](preflight.json), [publication](production-publish.json), [no-op](production-publish-noop.json), and [verification](receipt-verification.json).

## Changes

- Compact Wallet and Uniswap layouts, secondary icon buttons with tooltips and accessible names, collapsed technical details, and visible primary approval actions.
- Shared preloaded token metadata: Ethereum ETH plus 12 ERC-20s, Arbitrum ETH plus four ERC-20s. Bundled CC0 icons where available; initials otherwise. Existing custom metadata wins without modifying managed memory. [Contract verification](verified-token-contracts.json).
- Automatic quotes, balance/history updates, approval-to-swap progression, and saved-request continuation. Existing approvals recover without another signature; expired unsubmitted swaps require a fresh quote and owner action. Connect includes saved-transaction tracking alongside read tools; fresh signing still requires review.
- Wallet summarizes supported Uniswap calldata as input and minimum output amounts. Browser observations store required block identifiers rather than full transaction lists, fixing the reported self-call metadata overflow while retaining receipt logs.

## Validation

- Both complete workspace package commands passed; app and scripts TypeScript checks passed for both apps.
- Wallet/package/catalog focused tests: 53 passed / 885 assertions. Additional Wallet read/provider UI helpers: 48 passed / 236 assertions. Uniswap's complete Bun suite: 101 passed / 897 assertions. Logs are alongside this record.
- Existing Wallet browser harness: 22 passed. Uniswap browser harness: eight flow and responsive-layout cases passed, including automatic progression and lost-reply recovery with no additional signature. [Browser summary](browser-summary.json), [Wallet confirmation](wallet-confirmation-375.png), [Uniswap picker](uniswap-375.png).
- Both existing `test:memory` programs passed once ([memory audit](memory-audit.json)). Against verified published EVM109 and Uniswap105 offered sources, all 23 backend files, complete memory declarations, schemas and locks remain identical. Roots remain `evm_wallet@1`, `evm_evidence@1`, `uniswap@1`; no migration or Kernel change is required.
- No production installation, state reset, real-token transaction or Dispenser starter update. Browser tests use mocked RPC/backend responses; token-contract verification is read-only. This frontend/service release did not rerun the earlier combined-canister upgrade qualification.

## Remaining behavior

Uniswap still uses V3 direct-pool routes. Ethereum USDT with an insufficient existing nonzero allowance needs an allowance reset; a first approval from zero works. Automatically journaling both a reset and a subsequent approval is not part of this release.
