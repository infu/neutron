# Aave application implementation

Create an independent Aave app on Ethereum Core V3 and Arbitrum V3, using the
installed EVM Wallet and the same review, managed-memory, packaging and release
workflow as Curve and Uniswap. Use the shared `LICENSE.APP.USE` license.

## Research and protocol

- [x] Verify current official Pool, data provider, oracle, WETH gateway and
  rewards deployments, protocol versions and exact interfaces. Pin sources and
  distinguish protocol constraints from app policy.
- [x] Read market reserves and account positions at a consistent block, including
  supply/borrow rates, liquidity, collateral settings, caps, isolation/siloed
  borrowing, E-mode eligibility, debt and health factor.
- [x] Implement supply, withdrawal, variable borrowing and repayment, collateral
  toggles and E-mode changes with onchain validation and before/after previews.
- [x] Support native ETH through the official gateway, explicit bounded budgets
  for full repayment/withdrawal, repayment with supplied aTokens, and reward
  claiming where the selected deployments support them.

## Wallet, memory and service

- [x] Scaffold the app and immutable v1 operation journal, complete manifest,
  workspace registrations, license notice and offered-source workflow.
- [x] Use only the installed EVM Wallet's exact public tools for reads, fee
  estimates, human/Agent review, sending and receipt reconciliation.
- [x] Persist original inputs, authenticated caller, signing identity, exact
  request IDs and dispatch uncertainty before effects. Recover without duplicate
  operations and require the final matching successful transaction.
- [x] Expose versioned market, quote, fees, execution, continuation, status and
  history tools for Agent callers with the same authorization behavior as the UI.
- [x] Add exact-calldata Aave presentation to Wallet review while preserving both
  released Wallet memory roots and signing identities.

## Interface

- [x] Build a responsive portfolio, supplied and borrowed positions, searchable
  markets, action dialogs and activity with the established Neutron design.
- [x] Show changing rates, wallet balances, protocol liquidity/caps, current and
  projected debt/health, and understandable collateral/E-mode consequences.
- [x] Make network and contract identity explicit. Keep unavailable/partial data
  distinct from zero balances, and show recoverable pending/review states.
- [x] Verify keyboard navigation, modal focus, narrow layouts, empty/loading/error
  states, amount precision and complete approval-to-final-action flows.

## Qualification and release

- [x] Test independent ABI decoding, protocol constraints, financial arithmetic,
  debt accrual and bounded approval semantics.
- [x] Test clean initialization, populated journal restoration, lost replies,
  replay, caller isolation, concurrent continuation, replacements and reorgs.
- [x] Execute generated operations on pinned local forks of the official
  Ethereum/Arbitrum contracts, validating resulting supplies, debts, balances,
  collateral/health and reverting invalid actions. Use local fixture funds only.
- [x] Exercise the actual frontend, resident service and Wallet SDK in browser
  fixtures, plus production read endpoints from an opaque origin.
- [x] Package Aave 100 and a compatible higher Wallet release; run full release
  tests, focused TypeScript, license and security checks, and review archives
  with exact offered-source artifacts.
- [x] Publish through the production catalog transaction and repeat identical
  bytes to verify receipt-v2 `batch_id: null`, all packages/sources unchanged.
- [x] Document the supported scope, limitations, memory contract, validation and
  release evidence. Preserve existing installations and Dispenser starter.

## Completed evidence — 7 September 2026

- Aave 100 (`0.1.0`) and EVM Wallet 115 (`0.1.15`) published atomically in
  production batch **64**. The identical second publication returned
  `batch_id: null`; all **20 packages and 20 offered sources** were verified
  unchanged against local versions, paths, sizes and SHA-256.
- Complete release commands passed: **30 Aave tests**, **157 Wallet tests**,
  clean/populated memory restoration, all Aave browser flows and **25 Wallet
  sandbox checks**. Focused TypeScript, license, security and catalog checks
  passed.
- Generated operations passed on local official-contract forks at Ethereum
  block **25925506** and Arbitrum block **502679266**, including accrued debt,
  bounded full-payment approvals, actual over-budget reverts, USDT resets,
  native gateway balances and exact Pool position reconstruction.
- Full live market reads through the actual Wallet browser RPC and SDK passed
  from an opaque origin: **67/20 reserves**, **48/10 E-mode categories**. The
  complete payloads passed the existing transport validators.
- Positive reward payouts remain unqualified because the pinned fixture
  accounts accrued no incentives. Reward discovery, encoding and simulated
  browser claiming are covered. Other markets, V4, governance, Umbrella,
  flash loans, swaps and leverage automation remain outside this release.
- [Release qualification and retained receipts](../.neutron/release-receipts/aave-2026-09-07/validation.md)
  contain the logs, screenshots, artifact ledger and verified postflight.
  Existing installations and the Dispenser starter were not modified.
