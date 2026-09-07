# EVM app bug-fix audit

Scope: inspect EVM Wallet, Uniswap, Curve and Aave for demonstrated bugs, fix
reproduced failures, preserve every released memory root, qualify the changed
packages and publish one compatible update set. Speculative policy restrictions
and unrelated feature work are excluded.

## Confirmed fixes

| App | Failure and correction |
| --- | --- |
| Wallet | Refresh merged only the first history page, leaving older statuses stale and skipping rows after enough new requests. Refresh and Load more now serialize reads of a contiguous loaded window and retry shifting offsets. |
| Wallet | Interrupted unsigned preparation reused old automatic fees after the head changed. The same request refreshes automatic fees and requires a fresh simulation revision; explicit fees and approved/signed candidates stay exact. |
| Wallet | Token and nested V3 decoding accepted noncanonical or trailing calldata. Complete ABI reencoding is now required. V3 recipient flags resolve to their actual sender/router meaning. |
| Wallet | Shared ERC-20/ERC-721 methods could label NFT ID zero as revocation. Unknown interfaces now show exact allowance-or-token-ID values, including in preparation, Agent review and token observations. The zero-allowance action requires a valid allowance response before opening Wallet review. |
| Wallet | Changing a decoder in one tile left another tile using stale definitions. Settings and Activity subscribe to the existing app-state events; mutations publish them. Manual refresh retries unavailable metadata. |
| Uniswap | Lost retry replies, concurrent quote renewal and cancellation during persistence could lose dispatch evidence or still open review. Recovery preserves the original request, reserves renewal with existing journal revisions and propagates cancellation. |
| Uniswap | Completed unified actions reused cached confirmation without rechecking receipts. Reconciliation now rechecks the final dispatched transaction. |
| Uniswap | Recipient addresses 1 and 2 have protocol-specific meanings in some router/manager calls. New requests reject destinations that the contract would remap; historical records retain their original bytes and remain readable. |
| Uniswap | Price impact could combine unknown or different block observations. It is shown only from corresponding observations. Late custom-token/balance responses cannot populate another chain or account view. |
| Curve | WETH routing could not use supported native ETH pool paths. Router wrapping/unwrapping now works in both directions. Hidden unfinished liquidity fields no longer block the other action. |
| Aave | Expired plans could create a successor while the original Wallet request remained signable, allowing duplicate lending. Recovery retains unresolved requests and checks existing predecessor attempts, with warnings preserved on reload. |
| Aave | Market/balance/quote reads could show another account beneath the old header. Account polling and scope checks keep the view and review coherent. |
| Aave | Health factor 0.999 rounded to 1.00; missing oracle prices produced misleading borrowing capacity/Max; failed rewards reads appeared as zero; completed Activity lacked receipt rechecks. Display, optional Max calculation, errors and reconciliation now preserve these distinctions. |

## Release checklist

- [x] Add concrete unit, actor and browser reproductions and fixes.
- [x] Preserve all seven managed roots and four released lock files exactly.
- [x] Run each app's clean initialization and populated memory restoration tests.
- [x] Increase packed versions: Wallet 117, Uniswap 111, Curve 102, Aave 101.
- [x] Complete each app's full package and release tests, plus browser and relevant contract checks.
- [x] Verify predecessor archive digests, schema closures, method contracts and upgrade plans.
- [x] Inspect the four changed archives and offered sources; preserve the other 16 catalog packages.
- [x] Publish one production catalog transaction, repeat with exact bytes, require receipt-v2 no-op.

Evidence is retained in `.neutron/release-receipts/evm-bugfixes-2026-09-07/`.
The Curve WETH path executed successfully against the pinned Ethereum stETH pool
in a local fork. The equivalent Arbitrum fork could not read an archived storage
node; both-network calldata tests passed. Public chain reads and local fork
transactions do not spend production funds or install updates into existing
Neutrons. Publication makes the compatible updates available in Installed Apps.

Completed: 567 app unit/package tests, all four browser suites (including 31
Wallet checks), memory tests, and the contract checks described above passed.
The final Wallet run includes unchanged ingress-concurrency assertions and
idempotent preparation recovery. Published all four updates in batch 66; the
second receipt has `batch_id: null`, all 20 packages and 20 offered sources
unchanged, with exact local version, path, URL, size and SHA-256 matches.
