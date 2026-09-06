# Real Uniswap contract fixture

Run from the repository with its normal dependencies installed:

```sh
apps/uniswap/test/fixtures/run.sh
```

The runner installs the pinned fixture lockfile in a temporary directory, runs
the fixture with Bun, and removes that directory on exit. It does not modify the
workspace lockfile or add Ganache/Solidity tooling to the app's production
dependencies. The first stage needs npm registry access; execution uses a fresh
in-process Ganache EVM with deterministic test accounts. No live RPC endpoint,
credentials, IC calls, real funds, package publication, or production writes are
used. Ganache's native LevelDB dependency requires the host C++ runtime; on Nix,
include the installed GCC runtime's `lib` directory in `LD_LIBRARY_PATH`.
The lockfile marks Ganache's bundled `fsevents` as optional, matching its parent
Chokidar declaration; Ganache's published bundle metadata otherwise makes
`npm ci` try to install that macOS-only optional watcher on Linux.

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

For repeated development runs, install this directory's package/lock into a
separate prefix once, then run:

```sh
NEUTRON_UNISWAP_FIXTURE_DEPS=/absolute/path/to/fixture-prefix \
  bun apps/uniswap/test/fixtures/contracts.ts
```

The pinned artifacts retain their upstream licenses and are downloaded during
the test; their bytecode is not copied into the Neutron application package.
