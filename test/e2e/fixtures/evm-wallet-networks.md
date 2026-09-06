# EVM Wallet network qualification

`../evm-wallet-networks.spec.ts` drives the installed Kitchen Sink and EVM
Wallet through the actual Kernel and its chain-key signer. It runs the same
matrix on chain IDs 1 and 42161:

- Account/network discovery and native balances returned by the Wallet SDK.
- A Kitchen Sink native transfer with one Wallet decision, exact recipient
  balance change, fee debit, nonce, raw signed bytes and canonical receipt.
- A Wallet contract call storing a value greater than JavaScript's exact integer
  range, read back through the SDK and independently from EVM storage.
- Personal UTF-8, rich EIP-712 and ERC-2612 permit signatures, independently
  hashed and recovered by both ethers and viem. The rich EIP-712 request carries
  an unquoted full-width JSON integer and must preserve its original text.

These tests use unforked local Anvil execution fixtures. Chain 42161 demonstrates
network routing and chain-bound signing/transaction behavior. It does **not**
demonstrate Nitro's parent posting charges, sequencer behavior, reorg rules or
parent finality. No production account is funded or used.

The storage contract is installed as fixture setup with `anvil_setCode`; the
subsequent app transaction executes its bytecode normally. App keys never leave
the actual Kernel signer. The tests do not stub app bundles, RPC responses,
signatures, submitted transactions or receipts.

## Runtime coordination

Use the dedicated `evm-wallet-local.ndeploy.json` deployment. The fixture manager
owns canister installation and the EVM RPC canister's temporary provider routing
through `evm-wallet-rpc-routing.ts`. Do not independently redeploy its canisters
or alter that routing while another scenario is active.

Ethereum stays on `http://127.0.0.1:8545`, shared with the IC bridge fixture.
Arbitrum uses a separate `http://127.0.0.1:8546` node managed by
[`evm-wallet-anvil.ts`](./evm-wallet-anvil.ts), whose Bun CLI supports
`start`, `status` and `stop`. `NEUTRON_EVM_ARBITRUM_RPC_URL` may explicitly
select another loopback port.
Never switch the chain ID of, reset, or replace the Ethereum node.

Run financial tests one at a time on each chain, coordinating with IC bridge,
Uniswap and allowance qualification. They share the Wallet account and assert
its nonce and balance. Signature cases also require a quiet account interval
because they assert no on-chain effect. Other fixture setup may mine blocks
without affecting the account; a receipt is checked against the canonical block
at observation, not asserted permanently final.

```sh
NEUTRON_NDEPLOY_CONFIG=evm-wallet-local.ndeploy.json \
  npx playwright test test/e2e/evm-wallet-networks.spec.ts --workers=1
```

For a reserved partial window, use Playwright's `--grep`, for example
`--grep 'chain 42161: personal'` or `--grep 'chain 1: live balances'`.
Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when the host browser is required.

An explicitly coordinated exploratory signature smoke may set
`NEUTRON_EVM_SIGNATURE_SMOKE_ONLY=1` and select only a signature case. This
retains nonce checks but permits an unrelated incoming redemption to change
the account balance. Its attachments are marked exploratory; it is not final
candidate qualification. Final matrix runs must leave this variable unset.

Keep the Playwright JSON attachments with the exact installed package/version
and artifact digest record supplied by the deployment coordinator. A run on
published packages can diagnose the harness, but does not qualify a later
candidate: rerun against the exact candidate set. The matrix attaches actual
canister ID, chain/client identity, operation/request IDs, signed raw bytes,
receipts, contract state and independent signature recovery evidence.

## Provider broadcast reply loss

The separate root protocol swap scenario owns the opt-in provider failure test.
It starts `startLocalEvmRpcRoutingProxy({ port: 18549,
enableBroadcastReplyLoss: true })` from `evm-wallet-rpc-routing.ts` and uses its
local `/__fixture_control/arm`, `/__fixture_control/state` and
`/__fixture_control/release` endpoints. After Anvil accepts the signed bytes and
its returned transaction hash matches `keccak256(raw)`, the proxy suppresses
provider replies for those exact bytes with HTTP 503 until the scenario releases
the fault in `finally`. It does not fabricate acceptance, a signature or a
receipt. This checks a lost provider broadcast reply, which differs from the
Uniswap browser fixture dropping a successful consumer MessagePort reply.

Restore the EVM RPC canister's original provider override using the identical
canister WASM before stopping the routing proxy, chain node or runtime. The
coordinator owns this restoration and its evidence; the ordinary network matrix
does not enable this fault or duplicate the root protocol scenario.
