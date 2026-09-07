# EVM Wallet 0.1.13 and Uniswap 0.1.10 USD pricing release

The EVM Wallet resident browser service owns one volatile, keyless DefiLlama cache shared by both apps and agent price reads. It batches exact chain/contract identifiers, reuses ETH for canonical WETH, and retains source observation/fetch timestamps. Stablecoins and wstETH use their own market prices. No account address, signature or canister HTTP outcall is involved. Public provider references are documented in apps/evm_wallet/README.md.

A shared UI observer refreshes about once per minute only when its document is visible and focused, with immediate cached display and refocus freshness labels. Inactive workspace tiles can stay mounted, so document visibility alone is insufficient. Agent calls refresh on demand, with no resident polling timer. Missing values remain unavailable; prior values survive transient errors as explicitly stale estimates. These values never modify balances, transaction amounts, approvals, swap quotes or liquidity execution.

Both apps preserve every existing memory declaration, immutable schema and lock byte. The final archives prove clean initialization and restoration from published EVM Wallet 112 and Uniswap 109, in addition to the earlier supported release fixtures. No migration, Kernel, backend, IC Wallet or Dispenser change belongs to this pricing release. Wallet 319 dismissal was already published in batch 60 and remains byte-for-byte unchanged.

Final validation before publication:

- Shared pricing/SDK lifecycle: 63 tests passed, including concurrent cache reads, 60-second refresh/negative caching, 5-second optional-price timeout, cancellation isolation, stale/missing data, identity binding, inactive-app polling and refocus labels.
- EVM Wallet: 131 tests and the managed-memory program passed; the complete browser sandbox passed 25 checks, including send/sign/replace recovery and the new USD cases.
- Uniswap: 212 tests and its managed-memory program passed; the complete browser suite passed 17 checks, including legacy approved-swap recovery and liquidity flows. Focused USD qualification passed 11 checks at 375/700px.
- Both app TypeScript checks, shared source/test TypeScript and git diff --check passed.
- Initial broad browser assertions assumed pre-USD balance text and counted all public calls as financial calls. The fixtures now distinguish the new read-only price calls; complete browser reruns passed. The original EVM workspace log retains this first fixture failure; evm-browser-tests.log records the successful corrected run.
- Final canonical workspace package commands ran after the fixture updates and refocus-label fix. The final exact archives passed 10 package/install/schema tests with 390 assertions, including published-predecessor memory retention.
- Local fixtures moved no real funds. The read-only public provider smoke covered 18 catalog rows in 145 ms with one unavailable asset (OCT); this is one observed response time, not a latency guarantee.

Publication:

- Root npm run updates:publish committed the two app/source successors atomically in batch 61. The other 16 catalog entries, including Wallet 319, remained unchanged.
- The identical second command returned receipt-v2 batch_id:null and all 18 package/source pairs unchanged.
- verify-receipts.ts checked package identity, versions, paths, source URLs, byte sizes and SHA-256, and rehashed all local artifacts after publication.
- Publishing makes the updates discoverable; it neither installs into existing Neutrons nor changes the Dispenser starter.

Exact artifacts:

- evm_wallet release 113: b20f0cf65d4086037b5fb88d0368863fa5f629a20f736d736134dbb1019b200c (599887 bytes); offered source c8ff722f02f767e23be8e49cbffc17456a65b845df7d155b93a8440617a55599 (634832 bytes).
- uniswap release 110: 5973ffc69dc0ee99f8cc2d32046595827448eb3b7ca5879ea6a943d98acd6c37 (1000137 bytes); offered source 171cca7bb40ef1b621f11634d55042967b1f5274027b6aa7a6c3a1c9e8307d2b (595351 bytes).
