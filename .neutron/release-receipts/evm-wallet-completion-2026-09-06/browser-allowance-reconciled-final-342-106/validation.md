# Preserved Wallet approval replacement failure

**FAIL — demonstrated backend estimate/simulation state mismatch.** The corrected full allowance test on installed Kernel 342 / EVM Wallet 106 failed in 157.286 seconds, with no retry, starting 2026-09-06T13:26:01.633Z. The browser timed out waiting for the replacement review because the backend had already failed replacement operation 29 during simulation. This is a real backend failure; it is not classified as a selector-only failure or a successful replacement.

The exact executed source and preflight pin are preserved. At evidence assembly the current `test/e2e/evm-wallet-allowance.spec.ts` matched them byte-for-byte: SHA-256 `dedacaf17446cb364448f4bd024ad1fe10452870fde1a9d5bb2e72bec9dd80be` (24719 bytes). `preflight.json` binds the actual installed Kernel 342 / EVM Wallet 106 deployment and archive identities.

## Failed replacement and observed cause

`replacement-preparation-diagnosis.json` is the saved authenticated backend history response, retaining normalized operation fields and raw Candid bytes. It records:

- Operation `29`, request `db244aad991030715bcdf1a1a4b06e29`, chain 42161, status `failed`, review revision `0`.
- Replacement of original operation `28`, with `cancel: false`, max fee 2,000,000,029 wei and priority fee 2,000,000,001 wei.
- Error: `Simulation failed` with JSON-RPC `-32603`, `EVM error OutOfGas`.
- No review, prepared transaction, signature, transaction hash or receipt for operation 29. The failure occurred before its review and signing.

`replacement-estimate-exact-call-state-mismatch.json` preserves a read-only historical reproduction using all backend transaction-object fields: from, to, value, approval calldata, nonce 8, type 2, empty access list, and the exact replacement fees.

| Historical state / simulation | Recorded result |
| --- | --- |
| Estimate before inclusion, block `0x9b1d` (39709) | `0xad22` = 44,322 gas |
| Estimate at inclusion, block `0x9b1e` (39710) | `0x5f75` = 24,437 gas |
| Default estimate after mining | 24,437 gas |
| Simulate 24,437 gas at pre-inclusion state | `OutOfGas` |
| Simulate 44,322 gas at pre-inclusion state | Success (`true`) |
| Simulate 24,437 gas at inclusion state | Success (`true`) |

These matched historical-state calls demonstrate why estimating against one state and simulating against the other can reject this valid replacement. The saved backend failure plus reproduction supports that diagnosis. There is no saved live raw RPC transcript directly exposing operation 29's chosen estimate/block, so the exact state-pair explanation is a reproduction rather than directly observed per-RPC telemetry. The smaller preliminary reproduction is also retained; the complete-field reproduction is the authoritative diagnostic artifact.

## Original effect and subsequent cleanup

The failed full test had already deployed/minted its dedicated local token, funded its local Wallet fixture and temporarily paused both interval mining and automining. Its effect checkpoints show original operation 28 request `e684525dadd08e5e84d04a3fbc14156c` and hash `0x3032768ec5203cde01a39220c5aa0eff28b6be997b25c4f646a29836b63afd95` saved before replacement, then restoration of the original automining false / interval 1 mode in `finally`.

`original-same-hash-reconciliation.json` records the already-signed original at nonce 8 with the same raw bytes/hash, a canonical successful receipt in block 39710 (`0x3b0f789589adc95fe05fc6a733dfc42beaea00736f2cbf65c2a1c541ecc72625`), the hash appearing once in that block, latest/pending nonce 9, allowance 7e18 and token balance 10e18. No replacement signature/hash was produced. Natural restored interval mining included the original once; it was not replayed as a new request.

The separately preserved run `../browser-allowance-second-recovery-final-342-106/` then passed in 59.448 seconds. It recovered original operation 28 in Activity and explicitly reviewed a single `approve(spender, 0)` cleanup: request `e9b33d49752236d0e50150b3b5ba82b7`, hash `0xeff4bcc63f076355091ac0ef4bb119285b3cd3e1058cb98ad08704f30c4ebd6a`, signed nonce 9, final latest/pending nonce 10, and zero allowance at UI block 40046. That cleanup performed no funding, deployment or mining changes and does not turn this replacement failure into a pass.

## Evidence preservation

`artifact-index.json` records the original preflight/source/report/trace/checkpoints, authenticated history diagnosis, both saved estimate reproductions, same-hash reconciliation and this classification. Exact source snapshots, reports, checkpoints, traces and reproduction JSON files are unmodified. The linked cleanup report/checkpoints are indexed separately as related evidence.

No browser, RPC, mining, financial action or source change was performed while assembling this classification/index. This evidence does not qualify the future replacement fix or the full approval → successful speed-up → discovery → revocation regression.
