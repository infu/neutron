# IC Wallet Ethereum and ck-token conversions

Wallet 0.3.18 adds automatic root-Agent Ethereum deposits and ck-token withdrawals, direct EVM Wallet/raw-address recipients in the UI, settlement progress, and the nine missing reviewed ckERC20 catalog pairs already present in the EVM/Uniswap token lists.

## State preservation

All five released v1 memory schema sources and their lock entries remain exact. `memory-audit.json` records their hashes. Only the new independent `wallet_bridge_provider@1` root initializes on upgrade. It distinguishes new provider-mediated Agent operations from existing direct-root bridge requests without changing their source schema or signing identity.

Direct withdrawals store an optional destination binding inside the existing transfer journal's opaque Candid context. Released contexts decode with an absent binding and retain Contacts validation. Tests cover old payloads, including zero-valued contact IDs, exact ledger-argument replay after lost replies, and ambiguous minter calls that must not be sent again. Archive checks preserve every predecessor root and initialize only missing journals.

## Validation

- `npm --workspace neutron-wallet test` passed: canonical package command, 198 TypeScript tests (1,579 assertions), all 15 required Motoko suites, and the managed-memory restoration program. See `wallet-release-tests.log`.
- Wallet app and scripts TypeScript checks passed; `git diff --check` passed.
- The actual withdrawal component, controller, shared EVM SDK and stylesheet passed 14 desktop/mobile browser checks. The fixture mocks Kernel transport and does not mount the entire Wallet app. The real parent polling/Contacts loader is separately covered in the release tests. See `browser/report.json` and `browser/validation.md`.
- New wrap tests exercise approval through deposit and exact IC mint, lost replies, cancelled requests, root/caller/account provenance, legacy-path separation and actual generated Candid argument binding.
- Anonymous mainnet minter, orchestrator and token-ledger queries verified the added catalog identities and decimals. See `verified-tokens.json`, `minter-info.json` and `orchestrator-info.json`.

All financial effects in tests used synthetic local fixtures and local compiled-canister runtimes. Public Ethereum/IC probes were read-only. No production wallet transaction, app installation, state reset or Dispenser update was performed.

## Scope and publication

Only IC Wallet changes. No Kernel, EVM Wallet, Uniswap, shared SDK or Dispenser package changes. The existing 32-method self-call inventory is retained: three unused frontend grants are replaced by new preparation/provider grants, while their legacy backend APIs remain available. New token catalog entries do not alter existing selected assets or fresh-install defaults.

`preflight.json` verifies the exact archive and offered source for all 18 production catalog packages. Wallet is the sole successor; the other 17 pairs exactly match the previous release. Publish and identical-byte no-op receipts are recorded alongside this file. Publication makes the update discoverable and does not install it into existing Neutrons.

Published Wallet 0.3.18 in atomic batch **59**. The identical second publication returned `batch_id: null`, with all 18 package/source pairs unchanged and every archive/source byte length and SHA-256 matching preflight. See `receipt-verification.json`.
