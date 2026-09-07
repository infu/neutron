# Curve and EVM Wallet release qualification

Curve 101 (`0.1.1`) adds swaps, liquidity management and durable activity through
EVM Wallet on Ethereum and Arbitrum, with contract-address-based token listing.
EVM Wallet 114 (`0.1.14`) adds Curve transaction presentation for human and Agent
review. The implementation and token-selection follow-up were qualified before
publication; this directory retains the evidence with the PR.

## Validation

- `npm --workspace neutron-curve test`: complete package, 33 tests, Motoko clean
  initialization/populated-root restoration and the actual React/resident/Wallet
  SDK browser fixture passed. See `curve-release-tests.log` and
  `browser-result.json`.
- `npm --workspace neutron-evm-wallet test`: complete package, 135 tests, Motoko
  memory restoration and 25 sandbox browser checks passed. See
  `evm-wallet-release-tests.log`.
- Official contract fixtures passed on local Ethereum block 25922607 and
  Arbitrum block 502541973 forks. They exercised swaps, approvals, deposits,
  proportional and one-coin withdrawals, recipients, native ETH, LP burns/mints
  and reverting minima. See `contracts-ethereum.log` and
  `contracts-arbitrum.log`. Transactions used local fixture funds only.
- Production discovery and Wallet RPC reads passed from an opaque browser
  origin. See `live-browser-reads.json`.
- Focused TypeScript builds for Curve, EVM Wallet and neutron-security, license
  checks and security checks passed. The final Curve follow-up also passed its
  focused TypeScript build.
- Repository-wide `npm run typecheck` reported existing compiler-test project
  inclusion and Kitchen Sink fixture errors; see `repository-typecheck.log`.

## Memory and release evidence

Curve's `curve@1` root was introduced in release 100. Release 101 retains the
exact schema and lock lineage, and its package test verifies a `keep` upgrade
from the immutable release-100 archive. Wallet retains both released v1 roots,
with archive tests against release 113 and restoration coverage for older
supported production releases. No migration or clean reinstall is required.

Publication batch 62 atomically published Curve 100 and EVM Wallet 114. Batch
63 published Curve 101. Both publications were repeated against the same bytes;
each second receipt reports `batch_id: null` and all 19 packages and offered
sources unchanged. See the matching `*-publish.json` and `*-noop.json` receipts.
The final receipt verification is in `curve-101-postflight.json`.

`artifacts.json` records all three retained archives and their exact offered
source artifacts, checked by byte length and SHA-256. Publication made the
updates discoverable; existing installations and the Dispenser starter were
not modified.

The screenshots use the browser fixture's synthetic account and balances.
