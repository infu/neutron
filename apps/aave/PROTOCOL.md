# Aave protocol integration

Research and deployed-contract review: 7 September 2026. This app integrates
the Aave V3 Ethereum **Core** and Arbitrum markets. Other Ethereum Aave markets,
V2, Aave V4, flash loans, liquidations, cross-asset collateral swaps, debt swaps,
and Safety Module staking are outside this release.

## Primary sources and deployment pins

- [Aave DAO address book](https://github.com/aave-dao/aave-address-book/tree/12963110f29699d214531b9ab4c7cfcec460c298),
  especially `src/AaveV3Ethereum.sol`, `src/AaveV3Arbitrum.sol`, and
  `src/ts/abis/IWrappedTokenGatewayV3.ts`.
- [Aave V3 Origin](https://github.com/aave-dao/aave-v3-origin/tree/cff15de6d1271b0c800fc001f4aea4c263e8a597),
  especially `IPool.sol`, `AaveProtocolDataProvider.sol`, `WrappedTokenGatewayV3.sol`,
  `ReserveConfiguration.sol`, `GenericLogic.sol`, `ValidationLogic.sol`,
  `BorrowLogic.sol`, and `IRewardsController.sol`.
- [Aave Pool integration reference](https://aave.com/docs/aave-v3/smart-contracts/pool).
- [Health factor and liquidations](https://aave.com/help/borrowing/liquidations).

`src/contracts.ts` contains the exact provider, Pool, data provider, oracle,
wrapped ETH gateway, WETH and default incentives controller for each network.
Contract calls are restricted by protocol membership, not by ticker: reserves
come directly from the official Pool's `getReservesList`. Onchain token names
are display metadata; a matching symbol does not register another token as a
reserve. Shared curated metadata only overrides display names by exact address.

Every market read verifies the provider's Pool, oracle and data provider, the
Pool's reverse provider identity, and the data provider's immutable Pool. A
native action additionally checks the gateway's immutable Pool and WETH. If an
address changes, the app reports the incompatible definition rather than
silently transacting through an unreviewed replacement. Governance upgrades to
the same Pool proxy remain possible, so effects are simulated against deployed
contracts and the preview identifies its observed block.

The current gateway ABI intentionally differs from older documentation:
`borrowETH(address,uint256,uint16)` and
`repayETH(address,uint256,address)` have **no interest-rate-mode argument**.
The deployment-pinned address book and actual contract fixtures determine
these selectors. The first legacy Pool argument is displayed and encoded as
the expected market Pool; the gateway itself uses its immutable Pool.

## Reads, amounts and rates

EVM Wallet performs all RPC reads and estimates. Standard Multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11` batches reads; it never receives a
signed transaction from this app. The first provider read chooses a block and
every subsequent batch, reserve balance, reward read and simulation is pinned
to that exact block. A mismatched block response is rejected.

Reserve configuration, aToken and variable-debt token addresses, total supply,
current accrued user supply/debt, wallet balances, prices, rates, caps and
available virtual liquidity come from the Pool, its data provider, tokens and
oracle. A failed required read does not become a zero balance. Optional reward
failure is reported separately; reserve/account totals are never constructed
from a silently incomplete reserve list.

All atomic amounts, base-currency values, WAD health factors, RAY rates and
transaction quantities remain decimal strings in saved JSON. Token decimals
come from reserve configuration. The supported markets use an oracle USD base
currency; its unit is read from the oracle. Zero prices are unavailable prices,
not promises that an asset is worth zero.

Displayed APY uses the annual RAY rate compounded per second over 31,536,000
seconds. It is a current-rate estimate, not a guaranteed yield. Unrepresentable
numeric APY is unavailable, never zero. The before-position is the Pool's
authoritative `getUserAccountData`; the after-position is an estimate using
current prices, per-reserve eMode eligibility and integer protocol math. Debt
conversion rounds up; borrowing power applies the integer weighted-average
LTV before computing capacity. Quotes can differ from final balances because
of interest, protocol rounding, prices or governance changes.

eMode discovery reads all IDs in the protocol's uint8 domain, including gaps.
It reads collateral and borrowable bitmaps, plus the newer zero-LTV and isolated
category fields where implemented. A category's borrowable bitmap governs
borrowing in that category independently of the normal borrowing flag. Legacy
isolation and siloed flags are shown from deployed configuration/data-provider
getters; a later protocol version deprecating them is not replaced by a new app
restriction.

## Supported effects and bounded authorization

- **Supply:** `Pool.supply`, with an exact token approval if needed. Native ETH
  uses the official gateway's `depositETH` and the exact transaction value.
- **Withdraw:** `Pool.withdraw`, including its MAX sentinel for all accrued
  supplied tokens. Native ETH uses `withdrawETH`, with a bounded approval of
  aWETH to the gateway. An all-withdrawal requires an explicitly reviewed
  maximum aWETH allowance to accommodate accrued interest.
- **Borrow:** variable interest-rate mode `2`. Native ETH uses `borrowETH`
  after an exact debt-token `approveDelegation` for this borrowing amount.
  The app never defaults to unlimited credit delegation.
- **Repay from wallet:** `Pool.repay` or native `repayETH`. Exact repayments
  spend at most the entered amount. **Repay all** uses Aave's MAX sentinel and
  an explicitly reviewed finite maximum-payment budget, covering current debt
  and interest before execution. ERC20 allowance is set to that exact budget,
  including reducing an existing larger allowance. Native repayment sends
  that budget as ETH; the gateway refunds the unused part. If accrued debt
  exceeds the budget, the call reverts and requires a refreshed review.
- **Repay from supplied tokens:** `repayWithATokens` burns supplied tokens of
  the **same underlying asset**, without an approval. Its MAX sentinel uses
  the lesser of accrued supplied balance and accrued debt. If supply is below
  debt, the preview says that debt remains. This does not swap collateral.
- **Collateral:** `setUserUseReserveAsCollateral` with a before/after position.
- **Efficiency mode:** `setUserEMode`, including category `0` to leave eMode.
- **Rewards:** discovery and `claimAllRewards` through the market's official
  default incentives controller, using actual aToken/debt-token addresses and
  paying the wallet itself. No positive claimable rewards means no claim is
  offered. Merit/offchain campaigns and other reward systems are outside this
  integration; a zero-incentive fixture account cannot prove positive rewards.

Existing sufficient allowance is reused for exact-amount effects. MAX-sentinel
effects must instead have an allowance equal to the reviewed budget; an older
unlimited allowance is reduced. Mainnet USDT resets a nonzero allowance to zero
before changing it. A successful repayment may leave a small unused bounded
allowance, which the review explains.

Frozen/paused reserves, supply and borrow caps, available liquidity, collateral
eligibility, isolation and siloed borrowing are checked using observed protocol
parameters. Borrow, withdraw, collateral changes, eMode changes and repayment
using aTokens are also simulated as the EVM Wallet address against the actual
Pool. Native borrow/withdraw simulate the corresponding Pool operation before
using the verified gateway. Protocol errors remain errors: the app does not
invent a health-factor floor, force a borrowing buffer, or require standing
unlimited approvals. Supply/repayment estimation can remain unavailable until
their prerequisite approval confirms; the effect transaction is still
estimated by EVM Wallet before signing.

## Qualification

`test/protocol.test.ts` checks independently declared calldata, atomic amounts,
bounded MAX repayment including pre-existing unlimited USDT approvals, native
gateway values, actual-simulation error propagation, sparse eMode IDs,
precision/rounding and block consistency. `test/fixtures/contracts.ts` exercises
generated plans against locally forked official deployments with fixture-only
funds. Browser tests run the actual app/service and Wallet SDK, while live reads
exercise real public RPCs from the application origin context. No fixture
transaction is sent to a production network.

The initial production read smoke observed 67 Ethereum Core reserves and 48
eMode categories, and 20 Arbitrum reserves and 10 eMode categories. These are
observations, not limits or hardcoded catalogs. Fork test pins are Ethereum
block 25,925,506 and Arbitrum block 502,679,266; the fixture evidence records
each tested action and final balances.
