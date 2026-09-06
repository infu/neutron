# EVM Wallet release qualification

Implemented, qualified and published on 2026-09-06. Production source batch **51**
atomically published Kernel 339, IC Wallet 315, Kitchen Sink 314, EVM Wallet 101
and Uniswap 102. The second canonical publication returned `batch_id: null`:
all 18 selected packages and offered sources were unchanged, with every version,
URL, path, size and SHA-256 matching the retained bytes.

## Scope

Separate EVM Wallet owns installation-scoped chain-key custody and confirmation
UI. Shared tools serve Kitchen Sink, Uniswap and direct root Agent workflows.
IC Wallet retains IC assets and ck-token bridge orchestration, with durable
Send/Withdraw/deposit journals and exact withdrawal fee/gas review. Existing
assertion keys and released memory schemas remain preserved.

## Verification

- All five canonical package commands and release suites passed. Kernel: 752
  TypeScript tests and 33 Motoko suites; Wallet: 157 tests and seven Motoko
  programs; EVM Wallet: 29 tests plus compiled backend/crypto/RPC and memory
  qualification; Kitchen Sink: 59 tests; Uniswap: 58 tests and six actual swaps
  using official contract bytecode. Shared SDK: 326 tests.
- Exact-archive checked upgrades passed 300 assertions. Current Wallet 312 and
  skipped Wallet 306 upgrade with preserved commands, settings and counters.
  EVM Wallet and Uniswap initialize correctly, then retain their pending
  journals through a further checked actor upgrade.
- Real browser scenarios passed against the exact published archives, actual
  Kernel, chain-key signing, released EVM RPC WASM and disposable Anvil balances:
  decline without effect; a signed transfer with deliberately lost reply and
  same-request reload recovery; missing installation identity rejected before
  effect; exact Uniswap approval, reload, swap, receipts, token balances,
  allowance and repeated reconciliation without another transaction.
- Three browser status waits were aligned with the existing 120-second recovery
  window. Only Uniswap was rerun; no app archive changed for this test fix.
- Exact production Kernel 336 browser-compiler compatibility, reverse compiler
  compatibility, Certified Assets qualification and binding, independent
  viem/noble crypto vectors, license checks and TypeScript checks passed.
- The real RPC probe confirmed scalar, block, transaction, mined receipt and
  null receipt responses through the corrected three-provider adapter.

The original local PocketIC instance, root key, topology, automatic progress and
HTTP gateway were preserved and restored. Test runtime cleanup is verified.
Publication did not install updates into production Neutrons or change the
Dispenser starter.

## Limits

One main account; Ethereum, Arbitrum One and Sepolia initially. Compatible
upgrades preserve the address; uninstall/reinstall rotates the custody namespace.
No private-key export or removed-namespace reassignment is provided. Uniswap
supports direct V3 exact-input routes; ck-token deposits use Ethereum mainnet.
Unprovable minter outcomes remain unresolved. Local fixtures do not emulate
Arbitrum sequencer settlement or establish funded production-network execution.

## Retained records

- [Release summary and exact changed artifacts](./release-summary.json)
- [Atomic publication receipt](./production-publish.json)
- [Verified no-op receipt](./production-publish-noop.json)
- [Local-byte and receipt verification](./receipt-verification.json)

Full per-suite logs, traces, screenshots, raw transaction evidence, predecessor
receipts and superseded private-candidate diagnostics are retained locally beside
these records; they are not all committed to Git. The general design checklist
was captured before final qualification; this release record contains the final
verification and publication outcome.
