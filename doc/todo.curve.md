# Curve app implementation

Build an independent `curve` app with a user-friendly Swap, Pools/Liquidity,
and Activity interface, using the installed EVM Wallet exactly as Uniswap does.
Target Ethereum and Arbitrum. Preserve all existing production state and signing
identities. Use the shared `LICENSE.APP.USE` and offered-source workflow.

## Protocol and integration

- [x] Verify current official Curve deployments, pool families, quote and
  transaction interfaces, discovery APIs, and browser transport compatibility.
  Record pinned sources and the exact supported behavior.
- [x] Scaffold the format-3 app, resident service, managed v1 journal, package
  workflow, license notice, and repository build/test/typecheck registrations.
- [x] Use exact install-declared EVM Wallet tools for account discovery,
  balances, USD prices, contract reads, fee estimates, review, sending, and
  receipt/replacement reconciliation; preserve invocation-scoped Agent context.
- [x] Implement pool discovery with explicit incomplete/error states and
  onchain verification of executable pool and token identities.
- [x] Implement live exact-input swaps, explicit slippage and recipient,
  exact approvals, native/token handling where the selected contracts support
  it, and network-fee previews.
- [x] Implement position balances, liquidity deposit previews, deposits,
  proportional withdrawals, and single-coin withdrawals where supported.
- [x] Add Curve-aware EVM Wallet confirmation presentation derived from exact
  transaction bytes for the implemented contracts, shared by human and Agent
  review.

## Durable execution and interface

- [x] Persist immutable original inputs, wallet identity, exact request IDs,
  dispatch uncertainty, and progress before any Wallet effect.
- [x] Resume interrupted operations without duplicate effects, retain completed
  approvals, handle changed reviews, and require the matching final transaction
  and successful receipt before reporting completion.
- [x] Expose versioned quote, pool, position, execute, status, and history tools
  so Agent workflows can complete the same operations as the UI.
- [x] Build automatic quotes, searchable tokens/pools, balances and USD values,
  clear transaction steps, compact advanced details, helpful empty/error states,
  accessible controls, and responsive layouts matching the Neutron design system.

## Qualification and release

- [x] Test protocol encodings and amounts against independent ABI decoders,
  including approvals, recipients, slippage minima, and chain separation.
- [x] Test journal clean initialization and restoration with representative
  non-default and pending data; retain both released EVM Wallet roots unchanged.
- [x] Test replay, lost replies, cancellation, reload, replacement evidence,
  concurrent continuation, and failed or unavailable chain observations.
- [x] Execute generated transactions against official Curve contracts with
  local fixture funds and verify resulting balances and failing minima.
- [x] Exercise actual browser UI at desktop and narrow tile sizes, including
  approval progression, reload recovery, and provider failure.
- [x] Run full workspace packaging, release tests, TypeScript and applicable
  repository checks; review exact archives and offered-source artifacts.
- [x] Publish the compatible package set atomically through `npm run
  updates:publish`, repeat against identical bytes, and retain the verified
  receipt-v2 no-op. Leave Dispenser starter selection to a separate request.
- [x] Document supported operations, contracts, recovery, validation evidence,
  and release artifacts; mark this checklist from completed evidence.

## Qualification evidence

- `npm --workspace neutron-curve test`: full package, 28 unit tests, Motoko
  initialization/restoration, and real React/resident/Wallet SDK browser fixture.
- `npm --workspace neutron-evm-wallet test`: full package, 135 tests, Motoko
  memory restoration, and 25 sandbox browser checks passed.
- Official contract fixtures passed at Ethereum block 25922607 (six pools) and
  Arbitrum block 502541973 (five pools). Swaps, exact approvals, LP mint/burn,
  proportional and one-coin withdrawals, native ETH and recipient/minimum
  behavior were exercised using local fixture funds only.
- `node apps/curve/test/browser/live_reads.mjs`: all eight production discovery
  endpoints and both Wallet RPC endpoints passed from an opaque sandbox origin.
- `npx tsc -b apps/curve apps/evm_wallet packages/neutron-security --pretty false`,
  license checks, security checks and release-catalog tests passed. The security
  check's existing UNI/Uniswap token-display-name false positive was corrected
  only for the reviewed metadata tuple label; app identity branches still fail.
- Repository-wide `npm run typecheck` was also attempted. It still reports
  unrelated existing compiler-test project inclusion and Kitchen Sink fixture
  type errors. The changed app projects pass independently.
- Browser screenshots and result: `/tmp/neutron-curve-browser/`.
- Prepared catalog archive/source review: `.neutron/curve-release-review.json`.
- Release versions: Curve 100 (`0.1.0`), EVM Wallet 114 (`0.1.14`).
  EVM Wallet's two schema roots and released lock lineage are byte-identical
  to release 113; release tests also cover older production predecessors.

Publication batch `62` atomically published Curve 100 and EVM Wallet 114;
17 other selected packages were unchanged. The second identical-byte invocation
returned `batch_id: null` with all 19 packages and offered sources `unchanged`.
Every version, URL/path, size and SHA-256 matches the prepared review, the first
receipt and the retained local bytes.

Receipts: `.neutron/curve-publish-1.receipt.json` and
`.neutron/curve-publish-2.receipt.json`. Verified at 2026-09-07T03:22:04.813Z.
Existing Neutrons and the Dispenser starter were not modified.

## Follow-up: distinguish tokens with duplicate symbols

- [x] Replace symbol-based priority with exact network/contract list matching.
- [x] Show Listed/Unlisted labels, full contract links and token-list sources;
  retain identity information on the selected swap assets.
- [x] Clearly distinguish native Arbitrum USDC from bridged USDC.e, and USDT0.
- [x] Test symbol impersonation, exact-address searches, chain separation,
  browser selection and the narrow token menu.
- [x] Preserve the released `curve@1` root and release-100 archive/lineage;
  package and test release 101, then publish and verify the identical-byte no-op.

Release 101 (`0.1.1`) qualification: `npm --workspace neutron-curve test`
passed the full package command, 33 tests, Motoko clean initialization and
populated-root restoration, and the actual React/resident/Wallet SDK browser
flows. Duplicate USDC/USDT symbols cannot gain listing or priority from copied
metadata or high pool TVL. Exact/custom address search, selected unlisted labels,
Ethereum/Arbitrum explorer links, and native/bridged USDC were checked at 360px.
TypeScript, license and security checks passed. The released 100 archive digest,
schema module and complete lock lineage are unchanged; its upgrade plan keeps
`curve@1` without initialization or a migration.

Only Curve changed in publication batch `63`. The second invocation returned
`batch_id: null`; all 19 packages and offered sources were `unchanged`, matching
the prepared review, first receipt and local bytes by version, URL/path, size
and SHA-256. Verified at 2026-09-07T12:12:10.743159+00:00.

Evidence: `.neutron/curve-101-release-review.json`,
`.neutron/curve-101-publish-1.receipt.json`,
`.neutron/curve-101-publish-2.receipt.json`, and
`.neutron/curve-101-postflight.json`. Test log:
`/tmp/neutron-curve-101-release.log`; screenshots:
`/tmp/neutron-curve-browser/duplicate-tokens-narrow.png`,
`unlisted-selection-narrow.png`, and `arbitrum-usdc-narrow.png`.

The PR retains the release receipts, artifact digests, qualification logs and
selected screenshots in the [release evidence](../.neutron/release-receipts/curve-2026-09-07/validation.md).
