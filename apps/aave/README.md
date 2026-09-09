# Aave

Supply assets, borrow against collateral and manage lending positions on
**Ethereum Core V3** and **Arbitrum V3** using the installed **EVM Wallet**.
Update EVM Wallet to **0.1.15** or newer for Aave-specific transaction review.
This is an independent Neutron integration of Aave, not an official Aave Labs
application. Protocol deployments, interfaces and source pins are documented in
[PROTOCOL.md](./PROTOCOL.md).

## User experience

The app combines a portfolio overview, supplied and borrowed positions,
searchable reserve markets, focused action dialogs and durable activity.
Positions show current balances, variable rates, borrowing capacity and health
factor. Quotes show the effect of an action on collateral and debt before the
Wallet presents each exact transaction for approval.

The interface follows Neutron's dark design system with a restrained purple
accent, responsive layouts and keyboard-accessible dialogs. Loading, empty,
unavailable, pending and confirmed states have distinct text. Contract identity
comes from the selected Pool's onchain reserve list; a copied token ticker does
not add an asset to a market.

## Operations

| Operation | Behavior |
| --- | --- |
| Supply | Supply an ERC20 or native ETH through the official WETH gateway |
| Withdraw | Withdraw a chosen amount or the entire supplied balance where protocol health and liquidity permit |
| Borrow | Open or increase variable-rate debt against the wallet's collateral |
| Repay | Repay part or all of a variable debt with the matching wallet asset or native ETH |
| Repay with supplied assets | Use the matching aToken balance to reduce the reserve's debt |
| Collateral | Enable or disable a supplied reserve as collateral, subject to current protocol checks |
| E-mode | Preview and select a deployed efficiency-mode category, or return to the default mode |
| Rewards | Discover and claim incentives supported by the selected market's rewards controller |

Debt and supplied balances accrue interest between a quote and execution. Full
repayment and full native withdrawal therefore use an explicit maximum payment
or approval budget where required. The Wallet reviews that bound. The protocol
uses the actual position at execution; a budget that becomes insufficient needs
a new reviewed operation rather than an implicit unlimited allowance. Native
repayment refunds excess ETH according to the gateway contract. Repayment with
supplied aTokens is capped by both supply and debt and may leave remaining debt.

For native ETH supply and repayment, **Max** subtracts the Wallet's observed
maximum network fee from the balance. If fees are unavailable, the entered
amount stays unchanged. Fees are checked again by Wallet before signing.
Withdrawals use the current supplied balance rather than the original deposit
amount. **Max** fills the observed amount; **Withdraw full supply**
selects the protocol's full-withdrawal behavior. If an exact amount exceeds the
current supply, the quote reports that balance and its observation block without
silently changing the requested amount.

APYs and prices are observations that can change. Health factor depends on
collateral prices, debt and liquidation thresholds; there is no universal safe
health factor. Protocol eligibility and transaction validation remain based on
the current Aave contracts. The app does not add a borrowing quota, cooldown or
custom minimum health-factor policy.

The integration targets the two named V3 markets. Other Aave markets, V4,
governance, Umbrella staking, liquidation bots, flash loans, swaps and leverage
automation are outside this release. The existing Curve and Uniswap apps remain
available for independent swaps through the same EVM Wallet.

## Wallet and recovery

Aave holds no private key and has no backend RPC or signing capability. Every
network read, estimate and transaction uses the exact public EVM Wallet tools
declared by the app manifest. Resident service invocations retain their caller
and Agent context through the invocation-scoped Kernel client.

Before any effect, the managed `aave@1` journal saves immutable original inputs,
wallet identity, caller, exact request IDs and dispatch uncertainty. Approval or
credit delegation alone does not complete a lending action: completion requires
the final matching transaction and a successful receipt. Interrupted replies
retain their IDs. Quotes with no outstanding Wallet request may be renewed
against current protocol state. A transaction already prepared in Wallet keeps
its original request ID after the quote expires: Aave calls have no transaction
deadline, so the owner must finish or reject that review before starting a fresh
operation. An interrupted Wallet preparation can resume the same request through
explicit continuation while the quote is fresh. A preparing status keeps its
dispatch uncertainty; expiry does not create a replacement request. Ambiguous
requests must first be reconciled.

A Wallet error triggers a status check of that same request before Aave reports
the outcome. Failed preparation, an unsigned review, signing, submission and a
mined receipt are reported separately; an estimation rejection is not described
as a lost reply. If the status check also fails, both errors remain visible and
the saved dispatch stays unresolved. Reverted receipts include their block and
observed finality. Continuing always retains the original Wallet request ID.
A tracking timeout preserves a final confirmation or rejection already saved in
the journal. A confirmed approval with a queued lending transaction remains
incomplete and keeps the original continuation identity.

Use **Continue in wallet** to resume a saved human operation. Agent callers
continue their own operation ID with the same original inputs. Status reads
report retained journal state; reconciliation reads current receipts and can
recover already approved signed transactions through Wallet. It does not request
a new approval or signature. Reorganizations and transaction replacements remain
observable.

The managed `aave@1` operation journal retains its released schema and lock
lineage. Release tests cover clean initialization, populated-root restoration
and non-destructive upgrade plans from published predecessor archives. EVM
Wallet's released `evm_wallet@1`, `evm_evidence@1` and `evm_decoders@1` roots remain
unchanged. The app uses the checked state-preserving Neutron install transaction;
a clean reinstall is not an upgrade path.

## Tools

- `aave_markets_v1`: fresh market reserves, account positions, E-mode and rewards.
- `aave_quote_v1`: read-only operation and health preview.
- `aave_fees_v1`: estimates for the exact transaction steps.
- `aave_execute_v1`: save and execute through the matching final receipt.
- `aave_continue_v1`: resume the originating caller's saved operation.
- `aave_reconcile_v1`: reconcile existing Wallet requests and chain receipts.
- `aave_status_v1`: read retained progress and original input.
- `aave_history_v1`: paginate saved operations and linked attempts.

Amounts use decimal atomic-unit strings. Chain IDs are `"1"` and `"42161"`.
The asset is the underlying reserve address, including WETH when `useNative`
selects the gateway. Reuse one 32-hex `operationId` for retries of the same
immutable intent. Tool descriptors provide closed schemas and exact defaults.

## Qualification and packaging

```sh
npm --workspace neutron-aave test
npm --workspace neutron-aave run test:contracts
npm --workspace neutron-aave run test:live
npm --workspace neutron-evm-wallet test
npx tsc -b apps/aave apps/evm_wallet --pretty false
npm run license:check
npm run security:check
```

Unit tests cover protocol encodings, market observations, amount precision,
health calculations, full-payment budgets, approvals and operation recovery.
Motoko tests exercise clean initialization and restoration of populated state.
Browser fixtures use the actual frontend, resident service, Wallet SDK and tool
validators with synthetic Kernel transport and chain observations. Contract
fixtures execute generated plans on pinned local forks of the official deployed
code with local fixture funds; production endpoints supply read-only data.

Build through `npm --workspace neutron-aave run package`. Aave uses
the shared `LICENSE.APP.USE`, application notice and offered-source workflow.
Publish and verify according to [package updates](../../doc/package-updates.md).
The [implementation checklist](../../doc/todo.aave.md) records completed
qualification and publication evidence. Publication makes updates discoverable;
it does not install them into existing Neutrons or change the Dispenser starter.
