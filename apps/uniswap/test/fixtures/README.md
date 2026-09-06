# Real Uniswap contract fixture

Run from the repository with its normal dependencies installed:

```sh
apps/uniswap/test/fixtures/run.sh
```

The runner installs the pinned fixture lockfile in a temporary directory, runs
the fixtures with Bun, and removes that directory on exit. It does not modify the
workspace lockfile or add EVM/Solidity tooling to the app's production
dependencies. Setup needs npm registry access and GitHub source downloads;
execution uses fresh Ganache and Anvil EVMs with deterministic test accounts. No live RPC endpoint,
credentials, IC calls, real funds, package publication, or production writes are
used. Ganache's native LevelDB dependency requires the host C++ runtime; on Nix,
include the installed GCC runtime's `lib` directory in `LD_LIBRARY_PATH`.

The fixture deploys **official published Uniswap artifacts**:

- `@uniswap/v3-core@1.0.1`: factory and the pools it creates.
- `@uniswap/v3-periphery@1.4.4`: position manager and QuoterV2.
- `@uniswap/swap-router-contracts@1.3.1`: SwapRouter02.

`Tokens.sol` supplies only local mintable ERC-20 and wrapped-ETH test assets;
`solc@0.8.24` compiles them. Liquidity is minted through the actual position
manager. The official router's constructor-initialized runtime is copied to
the canonical router address **in this disposable EVM**, so the app's generated
calldata is submitted unchanged, including the native-output recipient. WETH
and QuoterV2 runtime are installed at the app's network-specific addresses in
the same way. Read requests to the canonical factory address are mapped to the
locally deployed factory. No production address contains or receives funds.

For each Ethereum (`1`) and Arbitrum (`42161`) app configuration, it executes:

- ETH → ERC-20, ERC-20 → ERC-20, and ERC-20 → ETH through a real V3 pool.
- `quoteSwap` against the real QuoterV2; failed fee tiers are ignored.
- Insufficient allowance → exact approval → no duplicate approval.
- Excessive minimum output and expired deadline transactions, proving both
  revert without transferring recipient output.
- Successful app-generated calldata, proving the recipient receives exactly
  the quoted amount and the router retains no native ETH or wrapped ETH.

This checks contract compatibility and actual EVM effects. It is a deterministic
local fixture, not a mainnet fork or an Arbitrum node, and it does not exercise
Kernel permission routing, IC chain-key signing, EVM Wallet persistence, live
liquidity, RPC providers, or L2 fee estimation. Those need their own tests.

## V4 swaps and V3/V4 liquidity

`v4_contracts.ts` starts its own **unforked Anvil 1.7.1** process on an ephemeral
loopback port for each chain configuration. Cancun support is necessary for V4's
transient storage; Ganache does not provide it. There is no external RPC URL,
private key, inherited wallet, or shared development-node option. Each node is
stopped when its fixture finishes.

The fixture installs official contract constructors and their returned runtime
at the app's canonical addresses **only inside that disposable EVM**. Running
constructors at their final addresses preserves PoolManager's `NoDelegateCall`
immutable and Permit2's EIP-712 domain. Application calldata is submitted without
rewriting its target or arguments.

- PoolManager, PositionManager, Quoter and StateView use the official
  `@uniswap/v4-periphery@1.0.3` bundled Foundry artifacts.
- Universal Router **2.1.1** has no matching npm release. `v4_artifacts.ts`
  downloads tag commit `999d561c3ad58fb5cab91b602911f3c75591a9c7` and its pinned
  dependencies, verifies each source archive's SHA-256, and compiles it with
  `solc@0.8.26`. This tests its actual `minHopPriceX36` tuple instead of the
  incompatible older router ABI.
- Permit2 uses that router's pinned source commit
  `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219`, compiled with `solc@0.8.17`.
- Downloaded upstream sources and compiled artifacts stay in the temporary
  installation. They retain their upstream licenses and are not bundled into
  the Neutron app.

For both Ethereum and Arbitrum configurations, the app's `prepareLiquidity`,
`readPosition`, `quoteV4Swap` and `prepareV4Swap` execute against actual contracts:

- ERC-20/ERC-20 and native ETH/ERC-20 position creation within the entered budgets.
- Exact ERC-20 and Permit2 approvals followed by minting; unused native budget
  returns to the owner.
- V4 swaps in both directions, delivering exactly the quoted amount to a
  distinct recipient; excessive minimum output and expired deadlines revert.
- An increase smaller than both currencies' accrued fees. This forces positive
  fee deltas and verifies `CLOSE_CURRENCY`, which a plain `SETTLE_PAIR` cannot handle.
- Partial removal transfers both principal and fees; collection preserves the
  position; closing transfers remaining assets and burns its NFT.
- The same V3 liquidity lifecycle, including app-generated mint/increase,
  swap-accrued fees, remove-and-collect, ETH unwrapping and NFT burn.

The V4 cases use initialized pools without hooks. The fixture does not claim
coverage of arbitrary hook contracts, live routing liquidity, wallet signing,
permission dialogs, or indexer discovery.

For repeated development runs, install this directory's package/lock into a
separate prefix once, then run:

```sh
NEUTRON_UNISWAP_FIXTURE_DEPS=/absolute/path/to/fixture-prefix \
  bun apps/uniswap/test/fixtures/contracts.ts

NEUTRON_UNISWAP_FIXTURE_DEPS=/absolute/path/to/fixture-prefix \
  bun apps/uniswap/test/fixtures/v4_contracts.ts
```

The pinned artifacts retain their upstream licenses and are downloaded during
the test; their bytecode is not copied into the Neutron application package.
