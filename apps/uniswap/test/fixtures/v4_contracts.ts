import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, custom, encodeDeployData, getAddress, parseAbi, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import type { EvmAccount } from "neutron-tools/evm_wallet";
import { prepareLiquidity, V3_POSITION_MANAGER, type LiquidityInput } from "../../src/liquidity.ts";
import { readPosition } from "../../src/positions.ts";
import { prepareV4Swap, quoteV4Swap, v4SwapTransaction } from "../../src/v4_swap.ts";
import { v4Deployment, type V4PoolKey } from "../../src/v4_common.ts";
import { FACTORY, NETWORKS, QUOTER, ROUTER, TOKEN_ABI, prepareSwap, quoteSwap, type Reader, type Token, type Transaction } from "../../src/swap.ts";
import type { ActionPlan } from "../../src/action_types.ts";
import { v3IncreaseGasLimit } from "../../src/liquidity_gas.ts";
import { loadV4Artifacts } from "./v4_artifacts.ts";

const dependencyRoot = process.env.NEUTRON_UNISWAP_FIXTURE_DEPS;
if (!dependencyRoot) throw new Error("Run test/fixtures/run.sh, or set NEUTRON_UNISWAP_FIXTURE_DEPS to the isolated fixture installation.");
const require = createRequire(`${dependencyRoot}/package.json`);
const artifacts = await loadV4Artifacts(dependencyRoot);
const v3 = {
  factory: require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
  manager: require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
  quoter: require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json"),
  router: require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json"),
};
const compiled = JSON.parse(require("solc").compile(JSON.stringify({
  language: "Solidity", sources: { "Tokens.sol": { content: readFileSync(new URL("./Tokens.sol", import.meta.url), "utf8") } },
  settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
assert.deepEqual(compiled.errors?.filter((error: { severity: string }) => error.severity === "error") ?? [], []);
const tokenArtifact = (name: string) => ({ abi: compiled.contracts["Tokens.sol"][name].abi, bytecode: `0x${compiled.contracts["Tokens.sol"][name].evm.bytecode.object}` });
const anvil = require.resolve(`@foundry-rs/anvil-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}/bin/anvil`);
const permit2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const mintAbi = parseAbi(["function mint(address,uint256)"]);
const tokenA = getAddress("0x1000000000000000000000000000000000000011");
const tokenB = getAddress("0x1000000000000000000000000000000000000012");

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

for (const chainId of ["1", "42161"] as const) {
  const port = await freeLocalPort();
  // Always start an unforked, disposable node on a newly selected loopback port.
  // There is intentionally no RPC URL or account-key configuration to inherit.
  const processNode = spawn(anvil, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", chainId, "--hardfork", "cancun", "--silent"], { stdio: ["ignore", "pipe", "pipe"] });
  let nodeOutput = ""; processNode.stderr.on("data", chunk => { nodeOutput += chunk; });
  const endpoint = `http://127.0.0.1:${port}`;
  let rpcId = 0;
  const rpc = async (method: string, params: readonly unknown[] = []): Promise<any> => {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    const result = await response.json() as { result: unknown; error?: { message: string; data?: unknown } };
    if (result.error) throw new Error(`${method}: ${result.error.message} ${JSON.stringify(result.error.data ?? "")}`);
    return result.result;
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (processNode.exitCode !== null) throw new Error(`Fixture Anvil exited: ${nodeOutput}`);
      try { assert.match(await rpc("web3_clientVersion"), /^anvil\b/iu); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(ready, true, `Fixture Anvil did not start: ${nodeOutput}`);
    assert.equal(BigInt(await rpc("eth_chainId")), BigInt(chainId));
    const node = await rpc("anvil_nodeInfo"); assert.ok(node.forkConfig?.forkUrl == null && node.forkConfig?.forkBlockNumber == null);
    const transport = custom({ request: ({ method, params }) => rpc(method, params as unknown[] | undefined) });
    const client = createPublicClient({ transport, pollingInterval: 50 });
    const wallet = createWalletClient({ transport });
    const [owner, recipient] = (await wallet.getAddresses()).map(address => getAddress(address)) as [Address, Address];
    const account = { accountId: "fixture-account", address: owner } as EvmAccount;
    const deployment = v4Deployment(chainId);
    const receipt = async (hash: Hex, status = "success") => {
      const result = await client.waitForTransactionReceipt({ hash });
      assert.equal(result.status, status, `${chainId}: local transaction ${hash}`);
      return result;
    };
    const submit = (request: Transaction, status = "success", gas = 20_000_000n) => {
      assert.equal(request.chainId, chainId); assert.equal(request.accountId, account.accountId);
      return wallet.sendTransaction({ account: owner, chain: null, to: request.to, data: request.data, value: BigInt(request.value), gas }).then(hash => receipt(hash, status));
    };
    const write = (address: Address, abi: any, functionName: string, args: unknown[] = []) => wallet.writeContract({ account: owner, chain: null, address, abi, functionName, args, gas: 20_000_000n }).then(hash => receipt(hash));
    const installAt = async (address: Address, artifact: { abi: any; bytecode: string }, args: unknown[] = []) => {
      const init = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode as Hex, args });
      const runtime = await rpc("eth_call", [{ from: owner, to: address, data: "0x", gas: "0x1c9c380" }, "latest", { [address]: { code: init } }]);
      assert.ok(runtime.length > 2);
      assert.equal(await client.getCode({ address }), undefined, "Disposable fixture address must be unused");
      // Run the official constructor at its final address: PoolManager has a
      // NoDelegateCall immutable, and Permit2 caches its EIP-712 domain here.
      await rpc("anvil_setCode", [address, init]);
      await receipt(await wallet.sendTransaction({ account: owner, chain: null, to: address, data: "0x", gas: 30_000_000n }));
      await rpc("anvil_setCode", [address, runtime]);
    };
    await installAt(NETWORKS[chainId].wrapped, tokenArtifact("WrappedEther"));
    for (const token of [tokenA, tokenB]) { await installAt(token, tokenArtifact("Token")); await write(token, mintAbi, "mint", [owner, 1000n * 10n ** 18n]); }
    await installAt(permit2, artifacts.permit2);
    await installAt(deployment.poolManager, artifacts.manager, [owner]);
    await installAt(deployment.positionManager, artifacts.positionManager, [deployment.poolManager, permit2, 100000, zeroAddress, NETWORKS[chainId].wrapped]);
    await installAt(deployment.quoter, artifacts.quoter, [deployment.poolManager]);
    await installAt(deployment.stateView, artifacts.stateView, [deployment.poolManager]);
    await installAt(deployment.router, artifacts.router, [{ permit2, weth9: NETWORKS[chainId].wrapped, v2Factory: zeroAddress, v3Factory: zeroAddress,
      pairInitCodeHash: zeroHash, poolInitCodeHash: zeroHash, v4PoolManager: deployment.poolManager,
      v3NFTPositionManager: zeroAddress, v4PositionManager: deployment.positionManager, spokePool: zeroAddress }]);
    const read: Reader = async (requestedChainId, address, data, tag) => {
      assert.equal(requestedChainId, chainId);
      const blockNumber = tag ? BigInt(tag) : await client.getBlockNumber({ cacheTime: 0 });
      const response = await client.call({ account: owner, to: address, data, blockNumber }); assert.ok(response.data);
      return { data: response.data, blockNumber: blockNumber.toString(), observedAtMs: Number((await client.getBlock({ blockNumber })).timestamp) * 1000 };
    };
    const now = async () => Number((await client.getBlock()).timestamp) * 1000;
    const balance = (token: Address | null, holder: Address) => token === null ? client.getBalance({ address: holder }) : client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [holder] });
    const runPlan = async (plan: ActionPlan) => { for (const step of plan.steps) await submit(step.transaction); };
    const eth: Token = { chainId, address: null, decimals: 18, symbol: "ETH" };
    const a: Token = { chainId, address: tokenA, decimals: 18, symbol: "A" };
    const b: Token = { chainId, address: tokenB, decimals: 18, symbol: "B" };
    for (const [token0, token1] of [[a, b], [eth, a]] as const) {
      const key: V4PoolKey = { currency0: token0.address ?? zeroAddress, currency1: token1.address!, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
      await write(deployment.poolManager, artifacts.manager.abi, "initialize", [key, 2n ** 96n]);
      const tokenId = String(await client.readContract({ address: deployment.positionManager, abi: artifacts.positionManager.abi, functionName: "nextTokenId" }));
      const input: LiquidityInput = { operation: "mint", protocol: "v4", chainId, accountId: account.accountId, tokenA: token0.address, tokenB: token1.address,
        maxAmountA: (50n * 10n ** 18n).toString(), maxAmountB: (50n * 10n ** 18n).toString(), fee: 3000, tickSpacing: 60, slippageBps: 50 };
      const mint = await prepareLiquidity(read, account, input, await now());
      const preview = mint.details.preview as { amount0Max: string; amount1Max: string };
      assert.ok(BigInt(preview.amount0Max) <= BigInt(input.maxAmountA!) && BigInt(preview.amount1Max) <= BigInt(input.maxAmountB!));
      await runPlan(mint);
      const positionInput = { chainId, accountId: account.accountId, owner, protocol: "v4" as const, tokenId };
      const minted = await readPosition(read, positionInput); assert.ok(BigInt(minted.liquidity) > 0n);
      assert.equal(minted.tickLower, -887220); assert.equal(minted.tickUpper, 887220);
      assert.equal(await client.getBalance({ address: deployment.positionManager }), 0n, "Mint refunds unused native budget");

      for (const [tokenIn, tokenOut] of [[token0, token1], [token1, token0]] as const) {
        const quote = await quoteV4Swap(read, { chainId, accountId: account.accountId, accountAddress: owner, recipient, tokenIn, tokenOut,
          amountIn: (10n ** 16n).toString(), slippageBps: 50, deadline: String(BigInt(await now()) / 1000n + 600n) }, await now());
        assert.equal(quote.poolKey.fee, 3000);
        const plan = await prepareV4Swap(read, quote, await now());
        for (const step of plan.steps.slice(0, -1)) await submit(step.transaction);
        const before = await balance(tokenOut.address, recipient);
        const impossible = (BigInt(quote.amountOut) * 2n).toString();
        await submit(v4SwapTransaction({ ...quote, amountOut: impossible, minimumOut: impossible, slippageBps: 0 }, await now()), "reverted");
        assert.equal(await balance(tokenOut.address, recipient), before);
        await submit(v4SwapTransaction({ ...quote, deadline: "1" }, 0), "reverted");
        assert.equal(await balance(tokenOut.address, recipient), before);
        await submit(plan.steps.at(-1)!.transaction);
        assert.equal(await balance(tokenOut.address, recipient) - before, BigInt(quote.amountOut), "V4 output reaches explicit recipient");
        assert.equal(await client.getBalance({ address: deployment.router }), 0n, "V4 router refunds native input");
      }
      const accrued = await readPosition(read, positionInput);
      assert.ok(BigInt(accrued.fees0) > 0n && BigInt(accrued.fees1) > 0n, "Both swap directions accrue LP fees");
      // Make the added amount smaller than accrued fees. The increase therefore
      // owes the LP a positive delta, which SETTLE_PAIR cannot handle.
      assert.ok(BigInt(accrued.fees0) > 1000000n && BigInt(accrued.fees1) > 1000000n, "Fee credits exceed the added token budgets");
      const increase = await prepareLiquidity(read, account, { ...input, operation: "increase", tokenId, maxAmountA: "1000000", maxAmountB: "1000000" }, await now());
      await runPlan(increase);
      const increased = await readPosition(read, positionInput); assert.ok(BigInt(increased.liquidity) > BigInt(accrued.liquidity));
      assert.equal(increased.fees0, "0"); assert.equal(increased.fees1, "0");
      assert.equal(await client.getBalance({ address: deployment.positionManager }), 0n, "Increasing with accrued fees settles and refunds native currency");
      const remove: LiquidityInput = { operation: "decrease", protocol: "v4", chainId, accountId: account.accountId, tokenId, liquidityBps: 2500, recipient };
      const before0 = await balance(token0.address, recipient), before1 = await balance(token1.address, recipient);
      await runPlan(await prepareLiquidity(read, account, remove, await now()));
      const partial = await readPosition(read, positionInput);
      assert.equal(BigInt(partial.liquidity), BigInt(increased.liquidity) - BigInt(increased.liquidity) / 4n);
      assert.ok(await balance(token0.address, recipient) > before0 && await balance(token1.address, recipient) > before1, "Removal collects both currencies to recipient");
      await runPlan(await prepareLiquidity(read, account, { ...remove, operation: "collect", liquidityBps: undefined }, await now()));
      assert.equal((await readPosition(read, positionInput)).liquidity, partial.liquidity, "Fee collection preserves liquidity");
      await runPlan(await prepareLiquidity(read, account, { ...remove, operation: "close", liquidityBps: undefined }, await now()));
      await assert.rejects(() => readPosition(read, positionInput), "Closing burns the NFT after collecting principal and fees");
      console.log(`${chainId}: V4 ${token0.symbol}/${token1.symbol}: mint, exact-budget approvals, both swap directions, slippage/deadline reverts, fee-credit increase, partial remove, collect and close passed`);
    }
    await installAt(FACTORY, v3.factory);
    await installAt(V3_POSITION_MANAGER, v3.manager, [FACTORY, NETWORKS[chainId].wrapped, zeroAddress]);
    await installAt(QUOTER, v3.quoter, [FACTORY, NETWORKS[chainId].wrapped]);
    await installAt(ROUTER, v3.router, [zeroAddress, FACTORY, V3_POSITION_MANAGER, NETWORKS[chainId].wrapped]);
    for (const [tokenAInput, tokenBInput] of [[a, b], [eth, a]] as const) {
      const [currency0, currency1] = [tokenAInput.address ?? NETWORKS[chainId].wrapped, tokenBInput.address!].sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1);
      await write(V3_POSITION_MANAGER, v3.manager.abi, "createAndInitializePoolIfNecessary", [currency0, currency1, 3000, 2n ** 96n]);
      const input: LiquidityInput = { operation: "mint", protocol: "v3", chainId, accountId: account.accountId, tokenA: tokenAInput.address, tokenB: tokenBInput.address,
        maxAmountA: (50n * 10n ** 18n).toString(), maxAmountB: (50n * 10n ** 18n).toString(), fee: 3000, slippageBps: 50 };
      await runPlan(await prepareLiquidity(read, account, input, await now()));
      const tokenId = String(await client.readContract({ address: V3_POSITION_MANAGER, abi: v3.manager.abi, functionName: "tokenOfOwnerByIndex", args: [owner, 0n] }));
      const positionInput = { chainId, accountId: account.accountId, owner, protocol: "v3" as const, tokenId };
      const minted = await readPosition(read, positionInput); assert.ok(BigInt(minted.liquidity) > 0n);
      assert.equal(await client.getBalance({ address: V3_POSITION_MANAGER }), 0n, "V3 mint refunds unused ETH budget");
      const increase = await prepareLiquidity(read, account, { ...input, operation: "increase", tokenId, maxAmountA: "1000000000000000", maxAmountB: "1000000000000000" }, await now());
      for (const step of increase.steps.filter(step => step.kind === "approval")) await submit(step.transaction);
      const increaseTx = increase.steps.at(-1)!.transaction;
      const increaseCall = { account: owner, to: increaseTx.to, data: increaseTx.data, value: BigInt(increaseTx.value) };
      const estimateBeforeFees = await client.estimateGas(increaseCall);
      const oldGasLimit = estimateBeforeFees + (estimateBeforeFees + 4n) / 5n;
      const bufferedGasLimit = v3IncreaseGasLimit(oldGasLimit);
      await client.call({ ...increaseCall, gas: oldGasLimit });
      const quote = await quoteSwap(read, { chainId, accountId: account.accountId, accountAddress: owner, recipient,
        tokenIn: tokenAInput, tokenOut: tokenBInput, amountIn: (10n ** 16n).toString(), slippageBps: 50, deadline: String(BigInt(await now()) / 1000n + 600n) }, await now());
      const swap = await prepareSwap(read, quote, await now());
      if (swap.approval) await submit(swap.approval);
      await submit(swap.swap);
      // Fees in both currencies initialize additional pool/position storage.
      // This changes gas after a successful estimate without changing calldata,
      // allowance, recipient, budgets or slippage. All effects are local only.
      const reverse = await prepareSwap(read, await quoteSwap(read, { chainId, accountId: account.accountId, accountAddress: owner, recipient,
        tokenIn: tokenBInput, tokenOut: tokenAInput, amountIn: (10n ** 16n).toString(), slippageBps: 50, deadline: String(BigInt(await now()) / 1000n + 600n) }, await now()), await now());
      if (reverse.approval) await submit(reverse.approval);
      await submit(reverse.swap);
      const accrued = await readPosition(read, positionInput); assert.ok(BigInt(accrued.fees0) + BigInt(accrued.fees1) > 0n);
      await assert.rejects(() => client.call({ ...increaseCall, gas: oldGasLimit }), "Previously simulated 20% cap cannot cover the new storage costs");
      await client.call({ ...increaseCall, gas: bufferedGasLimit });
      const increasedReceipt = await submit(increaseTx, "success", bufferedGasLimit);
      assert.ok(increasedReceipt.gasUsed < bufferedGasLimit);
      console.log(`${chainId}: V3 increase gas: estimate ${estimateBeforeFees}, old cap ${oldGasLimit}, buffered cap ${bufferedGasLimit}, used ${increasedReceipt.gasUsed}`);
      const increased = await readPosition(read, positionInput); assert.ok(BigInt(increased.liquidity) > BigInt(minted.liquidity));
      const removal: LiquidityInput = { operation: "decrease", protocol: "v3", chainId, accountId: account.accountId, tokenId,
        tokenA: tokenAInput.address, tokenB: tokenBInput.address, liquidityBps: 2500, recipient };
      const beforeA = await balance(tokenAInput.address, recipient), beforeB = await balance(tokenBInput.address, recipient);
      await runPlan(await prepareLiquidity(read, account, removal, await now()));
      const partial = await readPosition(read, positionInput);
      assert.equal(BigInt(partial.liquidity), BigInt(increased.liquidity) - BigInt(increased.liquidity) / 4n);
      assert.ok(await balance(tokenAInput.address, recipient) > beforeA && await balance(tokenBInput.address, recipient) > beforeB, "V3 removal collects and unwraps directly to recipient");
      await runPlan(await prepareLiquidity(read, account, { ...removal, operation: "collect", liquidityBps: undefined }, await now()));
      assert.equal((await readPosition(read, positionInput)).liquidity, partial.liquidity);
      await runPlan(await prepareLiquidity(read, account, { ...removal, operation: "close", liquidityBps: undefined }, await now()));
      await assert.rejects(() => readPosition(read, positionInput));
      assert.equal(await client.getBalance({ address: V3_POSITION_MANAGER }), 0n);
      console.log(`${chainId}: V3 ${tokenAInput.symbol}/${tokenBInput.symbol}: app mint, swap fees, increase, remove-and-collect, native unwrap, collect and close passed`);
    }
  } finally {
    processNode.kill("SIGTERM");
    await new Promise<void>(resolve => processNode.exitCode !== null ? resolve() : processNode.once("exit", () => resolve()));
  }
}
console.log("Official V3/V4 liquidity and Universal Router 2.1.1 fixture passed for Ethereum and Arbitrum configurations.");
