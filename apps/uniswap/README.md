# Uniswap

An independent Neutron app for exact-input Uniswap V3 swaps on Ethereum (1) and
Arbitrum One (42161). It uses the separate **EVM Wallet** app for accounts, public
RPC reads, transaction review, signing, broadcasting, and receipts. It has no
signing capability, private key, browser wallet provider, embedded provider key,
or independent transaction sender.

## Supported route

The first release compares **direct, single-pool V3 routes** across the 0.01%,
0.05%, 0.3%, and 1% fee tiers. It uses `QuoterV2.quoteExactInputSingle` through
EVM Wallet's keyless `eth_call` RPC path and builds a deadline-protected
`SwapRouter02.multicall` containing `exactInputSingle`.

| Chain | QuoterV2 | SwapRouter02 | Wrapped native token |
| --- | --- | --- | --- |
| Ethereum | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| Arbitrum | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |

Deployments and interface definitions were verified against official sources on
2026-09-05:

- [Ethereum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments)
- [Arbitrum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments)
- [SwapRouter02 interface](https://github.com/Uniswap/swap-router-contracts/blob/550c0f20373a487996fcc957075377b67af9df07/contracts/interfaces/IV3SwapRouter.sol)
- [Deadline multicall](https://github.com/Uniswap/swap-router-contracts/blob/550c0f20373a487996fcc957075377b67af9df07/contracts/base/MulticallExtended.sol)
- [QuoterV2 interface](https://github.com/Uniswap/v3-periphery/blob/697c2474757ea89fec12a4e6db16a574fe259610/contracts/interfaces/IQuoterV2.sol)

Uniswap recommends Universal Router for broader current integrations. This
initial route deliberately uses the deployed V3 router's ordinary ERC20 approval
flow. **Permit2, EIP-2612, V4, split/multi-hop routing, liquidity provision, and
UniswapX are not used or represented as supported.** No API credential is needed.
The direct-pool quote is the best observed output among available fee tiers, not
an assertion that it is the globally best route. A missing pool or provider
failure is recorded as unavailable. If every quote fails, the app cannot prepare
a swap. Spot price impact excludes the pool fee and is unavailable when pool
state and quote cannot be observed at the same block.

## Use

1. Install EVM Wallet and Uniswap through the compatible Kernel update set.
   Connect EVM Wallet in the Uniswap tile and select Ethereum or Arbitrum.
2. Fund the EVM address on that network, including ETH for gas. IC cycles used
   by signing/RPC and EVM gas are separate balances.
3. Select ETH, USDC, WETH, or read a custom token contract. Token identity is its
   chain and full address; token-provided symbols are descriptive only.
4. Enter the input amount, recipient, slippage and deadline, then request a
   quote. Review the minimum output, fee tier, observation age, recipient and
   allowance, and separate approval and swap network-fee estimates. These
   read-only estimates use EVM Wallet's `evm_estimate_transaction_v1` with the
   exact sender, destination, value and calldata. The Quoter gas-unit estimate
   describes pool execution and is never substituted for a full network fee.
   Missing fees are shown as unavailable, with the provider's reason; a swap
   requiring approval may not simulate until that approval confirms. The total
   is unavailable until every required transaction has a complete estimate.
   EVM Wallet separately reviews live fees before each signature.
5. Save and review the exact approval when needed, then wait for its successful
   receipt before reviewing the swap. Approval and swap are separate EOA
   transactions and are not atomic. No approval is silently unlimited. Ordinary
   ERC20 allowance has no automatic expiry: it remains until spent or revoked;
   the swap deadline does not expire that approval.
6. Use **Check wallet status** after a pending or lost reply. A reload retains
   the saved intent and exact request IDs. An expired deadline requires a fresh
   quote for a new swap; the earlier approval remains visible and can be managed
   in EVM Wallet.

Fee arithmetic uses exact integer wei throughout. Ethereum estimates use the
observed base fee plus priority fee, with a separately displayed suggested
maximum. On a real Arbitrum Nitro RPC, the full `eth_estimateGas` result already
includes the L1 posting component in L2 gas units. The app uses that total once
and never adds another posting charge. An incomplete RPC estimate is explicitly
unavailable; a plain Anvil chain configured as `42161` only proves the arithmetic
and request path, not Nitro posting costs or finality. Quote refresh obtains new
fee observations. Before a saved swap is submitted, **Refresh network fees**
estimates its remaining transactions without changing the frozen requests or
signing anything. Original quote observations remain in the durable intent.

Native ETH input is sent as the transaction value; the router wraps it and
refunds any remainder in the same multicall. Native output goes to the router,
then `unwrapWETH9(minimum, recipient)` pays the intended recipient. Token output
is sent directly to that recipient. ETH↔WETH wrapping is not a pool swap.

The default ETH/USDC/WETH routes use ordinary ERC20 approvals. A custom token
requiring an allowance reset before approval (for example USDT-style behavior)
can reject a nonzero-to-nonzero change: explicitly revoke that spender allowance
in EVM Wallet, then quote again. The app does not silently introduce an extra
approval transaction. Fee-on-transfer/rebasing tokens can fail standard V3
assumptions and are not advertised as supported. Output ERC20 receipt transfers
are counted only for the selected token and intended recipient. Native transfers
have no ERC20 Transfer log; their destination/minimum are bound by the verified
router calldata and successful unwrap call.

## Durable recovery

The sole managed root, `uniswap` v1, owns complete quote-derived intents, wallet
identity (address, key fingerprint, namespace version), authenticated Agent caller
installation where applicable, exact approval and swap
request IDs/JSON, operation evidence, phases, revisions, and timestamps.
Local storage is not the source of truth. `uniswap_begin_v1` rejects a changed
intent under an existing ID. `uniswap_update_v1` requires the same stage request,
account and network and uses a revision check so stale tiles cannot overwrite a
newer observation. The app saves `*_requested` before awaiting EVM Wallet.

On resumption the consumer checks the same wallet identity and scoped operation
status. A known submitted, unknown, rejected, reverted, or completed operation is
not turned into a fresh send. A definitive absent operation may submit the same
saved request. Compatible app upgrades retain the published `uniswap` v1 root
unchanged. Optional fee observations and verified replacement evidence use the
existing quote/operation JSON fields; old records without those annotations
remain readable and retain their original request IDs. There is no fake schema
migration. A replacement EVM Wallet signing namespace is not treated as the
same account.

Receipt inclusion is shown separately from finality. An included Ethereum or
Arbitrum receipt can still be reorganized. The interface preserves the wallet's
reported finality instead of claiming immediate final settlement.

For a replacement transaction, the original Wallet request ID and transaction
hash remain intact. The app follows the Wallet's authenticated replacement link,
independently checks the replacement sender, destination, calldata and value,
and keeps its receipt separate. A successful exact replacement approval can
unblock the swap; a cancellation or changed payload never counts as that
approval or swap. Pending replacement evidence stays unresolved and is checked
again with the same saved request IDs. Agent results additionally require
`evm_replacement_transaction_v1` to prove the signed replacement belongs to the
saved original caller and request. The original `evm_transaction_v1` schema and
exact-request binding remain unchanged.

## Resident tools and Agent

| Tool | Behavior |
| --- | --- |
| `uniswap_quote_v1` | Live direct-pool quote with read-only fee observations; native token is `null`; amounts are atomic decimal strings |
| `uniswap_prepare_v1` | Validate the quote and save immutable approval/swap requests under the supplied 32-hex swap ID |
| `uniswap_status_v1` | Read one saved intent and progress |
| `uniswap_list_v1` | Read saved swaps |
| `uniswap_record_result_v1` | Bind a supplied wallet result to the saved request, then independently verify public transaction fields and receipt |

The root Agent obtains a quote and prepared requests, calls EVM Wallet's
`evm_send_transaction_root_v1` directly for the approval, reconciles that request
until confirmed, records it, then calls the swap request directly. Uniswap never
forwards a nested call as root or grants its consumer a signer.

Root-owned EVM Wallet commands are scoped to the Agent installation, so Uniswap
does not impersonate that installation to query its journal. The root supplies a
result as a hint; `uniswap_record_result_v1` uses public `evm_transaction_v1` to
verify chain, hash, sender, router/token destination, value and exact calldata. It
also asks EVM Wallet to match the hash to the exact saved caller installation and
request ID in its own journal; the boolean answer exposes no other private
command. Only a positive match can attach the evidence, preventing reuse of an
older identical transaction under a new swap request. It replaces the claimed
receipt/status with independently read chain evidence.
A result with no visible transaction remains unresolved. A supplied “success”
claim cannot complete a swap by itself.

## Validation

```sh
npm --workspace neutron-uniswap test
npm --workspace neutron-uniswap run test:contracts
npm --workspace neutron-uniswap run test:browser
bunx tsc -p apps/uniswap/tsconfig.app.json --noEmit
```

`test` performs the complete package workflow, TypeScript tests, and the Motoko
managed-memory/journal program. Unit tests independently decode ABI calldata and
cover both chain mappings, exact approvals, slippage, deadlines, unavailable
providers, and recipient/native behavior. Controller tests cover recovery and
wallet-identity/chain-evidence binding.

`test:contracts` uses an isolated temporary npm installation pinned by the fixture
lock. It deploys the official Uniswap factory, pools, position manager, QuoterV2
and SwapRouter02 bytecode on local EVM chains 1 and 42161. It executes native→token,
token→native and token→token swaps, compares actual recipient balances, checks
router refunds/unwraps, and proves expired deadlines/excessive minima revert.
It uses fixture funds only and does not send transactions to public networks.
Local chain 42161 validates contract semantics and chain binding; it does not
emulate the Arbitrum sequencer's fee calculation or settlement protocol.

The application uses the repository's `LICENSE.APP.USE` and matching offered
source workflow. It is independently developed, not an official Uniswap Labs UI.
