# Uniswap V4 and liquidity release qualification

Release date: 2026-09-06. New PR branch: `feat/uniswap-v4-liquidity`, based on merged PR24 (`a54883c`).

## Scope

- Uniswap **109 / 0.1.9**: direct V3/V4 swap selection; V3/V4 position discovery, mint/add/remove/collect/close; compact Swap/Liquidity UI; ten new Agent tools; shared durable action execution and receipt recovery.
- EVM Wallet **112 / 0.1.12**: exact V4 router, V3/V4 liquidity and Permit2 transaction presentation, shared between human and Agent reviews.
- No Kernel, IC Wallet, shared Wallet SDK, or Dispenser changes. Kernel remains **344 / 0.3.44**.
- Packaging scripts preserve audited SDK license material and use hashed real-build evidence to omit exact Solidity artifact dependencies that contribute no shipped bytes. Position wrappers use app-authored ABI definitions; SDK math and V4 planning remain.

## State preservation

`memory-audit.json` verifies exact prior source bytes for `uniswap@1`, `evm_wallet@1` and `evm_evidence@1`. Existing lock lineage remains intact. Uniswap adds an independently initialized `uniswap_actions@1` root; no old root is replaced or reset. Representative clean initialization, old swap/nonce/signed-byte restoration, new journal/references restoration, CAS retries and compact history pages passed Motoko execution. Package planning tests cover both same-version restoration and upgrades from released Uniswap schemas, including skipped app releases.

## Completed checks

| Check | Evidence/result |
| --- | --- |
| Canonical workspace packaging | `uniswap-package.log`, `evm-package.log` |
| Uniswap release tests | 212 passed, 0 failed; `uniswap-tests.log` |
| EVM Wallet release tests | 131 passed, 0 failed; `evm-tests.log` |
| Final archive compatibility | 10 passed, 0 failed; `package-tests.log` |
| Managed memory execution | `uniswap-memory.log`, `evm-memory.log` |
| Uniswap browser | 17 checks, no browser errors or metadata rejections; `uniswap-browser/report.json` |
| EVM Wallet browser | 22 checks passed; `evm-browser/results.json` |
| SDK notice/build proof regressions | 19 passed; `notice-tests.log` |
| TypeScript | Uniswap app/scripts, Wallet app/scripts, neutron-scripts all passed |
| Original local V3 swaps | `contracts.log` |
| Final V3/V4 liquidity and V4 swaps | Eight native/ERC20 lifecycle configurations on Ethereum/Arbitrum; `contracts-after-encoding.log` |
| Actual public deployment probes | Read-only quoters, StateView, router code and position reads; `public-v4-quotes.json`, `public-v4-positions.json` |
| Diff checks | Passed; no changes under Kernel, shared Wallet SDK or Dispenser |

Contract execution uses fresh unforked local nodes and fixture funds. Browser effects are mocked. No real financial transactions, production app installations or state resets were performed. Arbitrum-configured local tests prove contract behavior, not Nitro fee accounting or finality. Arbitrary hooks, global multi-hop routing and new-pool initialization are not covered by the no-hook local fixtures.

## Publication

`preflight.json` verifies all 18 package/offered-source pairs. Only Uniswap and EVM Wallet differ from the previous published catalog; the other 16 pairs match exactly. Production source is `233tv-xiaaa-aaaay-aacta-cai`.

Published Uniswap 0.1.9 and EVM Wallet 0.1.12 in atomic batch 58. The identical second publication returned `batch_id: null`; all 18 package/offered-source pairs were unchanged, and every local archive and source artifact matched its reviewed size and SHA-256. See `receipt-verification.json` and the two publication receipts alongside this file.

Publication makes the update discoverable; it does not install it or update the Dispenser starter.
