# Isolated ckERC20 protocol qualification

The fresh `evm-wallet-erc20-local.ndeploy.json` deployment uses the real released
ckETH minter and ICRC ledgers. ckUSDC and ckUSDT ledgers name that minter in their
initial minting accounts. They are never converted from the older generic test
ledgers, whose minting accounts cannot be changed.

`../ic-wallet-erc20-provision.ts` supplies first-install fixture hooks and a
separate Ethereum setup function. `../evm-wallet-erc20-runtime.ts` owns the
isolated PocketIC lifecycle and the temporary gateway handoff. Its `serve` and
`deploy` commands require the explicit local config and retained-runtime evidence;
existing instances and journals must be retained. Ethereum setup runs only in the
fixture owner's reserved financial window, after other suites finish.

The helper source is DFINITY's
[ERC20DepositHelper.sol at the pinned minter release](https://github.com/dfinity/ic/blob/a47e5434753752c1d2972fbc4407d14f88964285/rs/ethereum/cketh/minter/ERC20DepositHelper.sol).
Its SHA-256 is
`2b6fbb45f42f3758cb6fb8ee1a7310a050f33546ba27b17e5cf2889f98ffcc57`.
`../ic-wallet-erc20-contracts.ts` verifies it and compiles it with the exact
`solc@0.8.20` dependency graph in this directory's lockfile. Optimizer settings
and the Paris EVM target are explicit in that source.

`ProtocolToken.sol` is a local six-decimal ERC20 test asset, not Circle's USDC
implementation or Tether's USDT implementation. It requires a zero approval
before replacing a nonzero allowance, so the bridge must actually perform its
reset/approval sequence. On unforked local Anvil, its runtime may be assigned to
the catalog's USDC/USDT addresses only when those addresses have no code. Existing
code must match the exact fixture; existing storage is never replaced. Funding
uses its real `mint` method and normal ERC20 transfers. No ledger mint or minter
event is injected.

After fresh runtime setup, run the actual browser protocol scenario:

```sh
NEUTRON_NDEPLOY_CONFIG=evm-wallet-erc20-local.ndeploy.json \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/run/current-system/sw/bin/google-chrome-stable \
PLAYWRIGHT_CHROMIUM_ARGS=--no-sandbox \
npx playwright test test/e2e/ic-wallet-erc20-bridge.spec.ts --workers=1
```

The scenario seeds an allowance through Kitchen Sink and EVM Wallet, wraps via
IC Wallet with a lost approval reply and reload, and checks the original
transaction identities, helper log, minter event, and exact ledger mint. Native
redemption verifies the asset burn, separate ckETH gas burn, actual minter status,
ERC20 payout, and recovery after another reload. PocketIC time remains on natural
auto-progress; only Anvil finality blocks are mined after real receipts appear.
