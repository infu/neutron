# EVM Wallet release qualification

Completed and published on 2026-09-06. The separate EVM Wallet, consumer SDK,
Kitchen Sink example, IC Wallet recovery/bridge integration and Uniswap app are
qualified. [Batch 52](production-publish.json) published all five updated packages
and offered sources atomically. [The exact-byte postflight](production-publish-noop.json)
returned `batch_id: null`; all 18 catalog package/source pairs were unchanged and
[their complete identities were verified](receipt-verification.json).

All wallet transfers, swaps, approvals, minting and withdrawals used local Anvil
and PocketIC with disposable test balances. No real ETH/USDC or production-wallet
funds were used. Publication changes the production update catalog; it does not
install packages into existing Neutrons or change the Dispenser starter.

## Published packages

| App | Version | Completed package qualification |
| --- | --- | --- |
| Kernel | 342 | 753 TypeScript tests / 6,506 assertions; 33 Motoko suites; certified assets and browser compiler compatibility |
| IC Wallet | 316 | 171 tests / 1,184 assertions; 12 Motoko programs; memory and TypeScript |
| Kitchen Sink | 315 | 66 tests / 1,655 assertions; seven resident checks / 72 assertions; memory and TypeScript |
| EVM Wallet | 107 | 60 tests / 592 assertions; 20 sandbox browser cases; memory and both TypeScript projects |
| Uniswap | 104 | 92 tests / 880 assertions; 22 browser checks; memory and both TypeScript projects |

The shared SDK passed 336 tests / 3,026 assertions and both TypeScript projects.
Existing closed response schemas remain unchanged; added methods and tools are
explicitly versioned.

[Exact package pins](candidate-pins.json) and [all 18 catalog package/source
pairs](preflight.json) identify the exact published bytes. All 1,511
files and modes in the five offered-source snapshots match the [immutable
implementation commit](implementation-commit-342-107-104.json). Later release
receipts and documentation closure are separate from that build-input snapshot.
Older prepared candidates and their offered sources remain immutable.

## State preservation

All nine affected published managed-memory roots retain their released schema
and migration history. Two new independent roots hold EVM review evidence and IC
bridge replacement ancestry. Existing installation identities, account keys,
commands, signed bytes and bridge/swap journals survive checked updates.

[Four archived-package actor upgrade scenarios](upgrades/final/qualification-summary.json)
passed 739 assertions: signed EVM 101 pending state, Wallet 312 with Kernel 336,
skipped Wallet 306, and nonempty Wallet 315 bridge/transfer journals. These cases
used exact 341/316/315/103/103 archives. Later source/layout comparisons and checked
updates extend that evidence; they are not relabeled as 739 tests of later bytes.

The exact Kernel 336 and Kernel 342 browser compilers passed [144 compatibility
assertions](../evm-wallet-next/compatibility/kernel342-final-compiler-summary.json).
Actual checked browser updates retained the same installation IDs and saved
state through [Kernel 342](portable-evidence/checked-upgrades-kernel342.json),
[EVM 107](portable-evidence/checked-upgrades-evm107.json) and
[Uniswap 104](portable-evidence/checked-upgrades-uniswap104.json).
[The observed final installation](installed-final-candidates.json) matches all
five selected packages. No production installation or Dispenser change is made
by publication.

## Runtime evidence

- [Six actual signatures and chain 42161 execution](portable-evidence/crypto105-case-outcomes.json)
  used Kernel 341 / EVM 105, with independent Ethereum signature/transaction checks.
  The chain 1 fixture interruption retains its original failure and
  [same-hash reconciliation](browser-crypto-chain1-financial-evm105/same-hash-reconciliation.json).
- [Activity pagination and original operation 22 recovery](browser-history-recovery-final-342-106/result.json)
  passed on 342/106 with all 25 records retained and no new signature or nonce.
- [Pending same-nonce approval replacement, reload/discovery and revocation](browser-allowance-final-342-107/validation.md)
  passed on 342/107, leaving allowance zero and no pending transaction.
- [Direct-root Uniswap](browser-root-uniswap-final/qualification-summary.json)
  completed on 342/106/103 through the same saved requests after a test-helper
  interruption. Three RPC replies were suppressed for one accepted raw
  transaction; recovery added zero broadcasts. Human and descendant attempts
  did not gain root authority. This deterministic root fixture tests the actual
  Kernel/SDK protocol, not model reasoning.
- [Both external 42161 swaps](browser-uniswap-42161-evm103/qualification-summary.json)
  passed on 341/103/103. The [Ethereum native case](browser-uniswap-chain1-final106-quote300/qualification-summary.json)
  passed on 342/106/103; that report separately retains the token case's original
  history-size failure. The [final 342/107/104 token case](browser-uniswap-token-replacement-final107-uni104/qualification-summary.json)
  passed with numeric price impact, a replaced approval adopted by Uniswap,
  separate swap approval, exact recipient effects, reload recovery and zero
  remaining allowance.
- [IC Wallet native bridging and redemption](browser-ic-final/qualification-summary.json)
  passed on 341/316/103, including direct-root authorization, lost consumer reply,
  unrelated incoming transfer, exact helper/minter/IC-mint correlation, saved
  request recovery and native withdrawal payout. The [fresh ckUSDC deposit proof](portable-evidence/erc20-deposit-proof-index.json)
  separately binds the final 342/316/315/107/104 installation, lost approval reply,
  unchanged saved requests, helper log 2, minter events 23/24 and exact 20,000,000-atom
  ledger mint 0. The [initial full case](browser-ic-erc20-final/initial-interruption.json) stopped
  before withdrawal confirmation because the fresh minter had no cached fee
  estimate. Wallet correctly disabled withdrawal. A separate ordinary donor
  withdrawal initialized the cache through the released protocol; the
  [redemption-only continuation](browser-ic-erc20-final/qualification-summary.json)
  then passed. It verified the quoted ckETH budget, ckUSDC burn 2/gas burn 7,
  identical saved withdrawal after reload, finalized 5-USDC recipient payout
  and durable Wallet settlement. The original 20-USDC deposit was never repeated.

[Known findings](known-findings.json) distinguish fixed app bugs from the
pre-existing manual package chooser startup race reported for follow-up. The
fixed failures include own-wallet review routing, large RPC equality, growing
history responses, the lifetime two-decision Agent consent quota, gas estimates
using different state from simulation, and Uniswap whole-history reads.

## Evidence scope and release verification

Local EVM fixtures use unforked disposable balances and actual Kernel signatures.
Chain 42161 proves chain routing and contract effects; it does not reproduce Nitro
posting, sequencing or parent-chain settlement. The ERC20 fixtures use explicit
local token stand-ins, not production Circle/Tether bytecode. Sandbox-browser
qualifications identify their mocked transport scope. Large raw receipts/traces
remain local; portable projections retain their hashes and actual version scope.

[The requirement map](requirements.json) closes all 64 original clauses without
removing requirements. [The runtime summary](runtime-summary.json) records 13
qualified cases and preserves four resolved historical attempts at their actual
versions. The [original local runtime was restored](final-runtime-restoration.json)
with its identity, gateway, root key, state and automatic progress verified;
isolated fixtures were stopped with their state retained.

The first post-publication no-op attempt timed out reading a certified asset.
[The same-byte retry](publication-verification-attempts.json) passed without a
rebuild, version change or second publication batch. The verifier checks every
selected version, package/source path, source URL, size and SHA-256, including
the exact local artifact bytes. The other 13 catalog packages remained unchanged.
