import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, custom, getAddress, maxUint256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { FACTORY, NETWORKS, QUOTER, ROUTER, TOKEN_ABI, prepareSwap, quoteSwap, swapTransaction, type QuoteInput, type Reader, type Token, type Transaction } from "../../src/swap";

const dependencyRoot = process.env.NEUTRON_UNISWAP_FIXTURE_DEPS;
if (!dependencyRoot) throw new Error("Run test/fixtures/run.sh, or set NEUTRON_UNISWAP_FIXTURE_DEPS to the isolated fixture installation.");
const fixtureRequire = createRequire(`${dependencyRoot}/package.json`);
const ganache = fixtureRequire("ganache");
const solc = fixtureRequire("solc");
const artifacts = {
  factory: fixtureRequire("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
  manager: fixtureRequire("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
  quoter: fixtureRequire("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json"),
  router: fixtureRequire("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json"),
};
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "Tokens.sol": { content: readFileSync(new URL("./Tokens.sol", import.meta.url), "utf8") } },
  settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
assert.deepEqual(compiled.errors?.filter((error: { severity: string }) => error.severity === "error") ?? [], []);
const tokenArtifact = (name: string) => ({ abi: compiled.contracts["Tokens.sol"][name].abi, bytecode: `0x${compiled.contracts["Tokens.sol"][name].evm.bytecode.object}` });
const mintAbi = parseAbi(["function mint(address,uint256)", "function deposit() payable"]);

for (const chainId of ["1", "42161"] as const) {
  const provider = ganache.provider({
    chain: { chainId: Number(chainId), hardfork: "shanghai" },
    wallet: { deterministic: true, totalAccounts: 3, defaultBalance: 1000 },
    logging: { quiet: true },
  });
  try {
    const transport = custom(provider);
    const client = createPublicClient({ transport });
    const wallet = createWalletClient({ transport });
    const [account, recipient] = (await wallet.getAddresses()).map((address) => getAddress(address)) as [Address, Address];
    const tx = async (request: { to: Address; data?: Hex; value?: bigint }, expected = "success") => {
      const hash = await wallet.sendTransaction({ account, chain: null, ...request, gas: 12_000_000n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, expected, `${chainId}: transaction ${hash}`);
      return receipt;
    };
    const deploy = async (artifact: { abi: any; bytecode: string }, args: unknown[] = []) => {
      const hash = await wallet.deployContract({ account, chain: null, abi: artifact.abi, bytecode: artifact.bytecode as Hex, args, gas: 15_000_000n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert.ok(receipt.contractAddress);
      return getAddress(receipt.contractAddress);
    };
    // Canonical addresses are part of the app's calldata. Copy only the
    // constructor-initialized runtime code to those addresses in this fresh,
    // disposable local EVM. Never rewrite the produced swap calldata.
    const copyRuntime = async (from: Address, to: Address) => {
      const code = await client.getCode({ address: from });
      assert.ok(code && code !== "0x");
      await provider.request({ method: "evm_setAccountCode", params: [to, code] });
    };
    const wrapped = NETWORKS[chainId].wrapped;
    await copyRuntime(await deploy(tokenArtifact("WrappedEther")), wrapped);
    const tokenA = await deploy(tokenArtifact("Token"));
    const tokenB = await deploy(tokenArtifact("Token"));
    const factory = await deploy(artifacts.factory);
    const manager = await deploy(artifacts.manager, [factory, wrapped, zeroAddress]);
    await copyRuntime(await deploy(artifacts.router, [zeroAddress, factory, manager, wrapped]), ROUTER);
    await copyRuntime(await deploy(artifacts.quoter, [factory, wrapped]), QUOTER);
    const write = async (address: Address, abi: any, functionName: string, args: unknown[] = [], value = 0n) => {
      const hash = await wallet.writeContract({ account, chain: null, address, abi, functionName, args, value, gas: 12_000_000n });
      assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    };
    await write(wrapped, mintAbi, "deposit", [], 250n * 10n ** 18n);
    for (const address of [tokenA, tokenB]) await write(address, mintAbi, "mint", [account, 1000n * 10n ** 18n]);
    for (const address of [wrapped, tokenA, tokenB]) await write(address, TOKEN_ABI, "approve", [manager, maxUint256]);
    for (const pair of [[wrapped, tokenA], [tokenA, tokenB]]) {
      const [token0, token1] = pair.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      await write(manager, artifacts.manager.abi, "createAndInitializePoolIfNecessary", [token0, token1, 3000, 2n ** 96n]);
      await write(manager, artifacts.manager.abi, "mint", [{
        token0, token1, fee: 3000, tickLower: -887220, tickUpper: 887220,
        amount0Desired: 100n * 10n ** 18n, amount1Desired: 100n * 10n ** 18n,
        amount0Min: 0n, amount1Min: 0n, recipient: account, deadline: maxUint256,
      }]);
    }
    const reader: Reader = async (requestedChainId, address, data, tag) => {
      assert.equal(requestedChainId, chainId);
      const blockNumber = tag ? BigInt(tag) : await client.getBlockNumber({ cacheTime: 0 });
      const result = await client.call({ account, to: address === FACTORY ? factory : address, data, blockNumber });
      assert.ok(result.data);
      return { data: result.data, blockNumber: blockNumber.toString(), observedAtMs: Date.now() };
    };
    const balance = async (token: Token) => token.address === null
      ? client.getBalance({ address: recipient })
      : client.readContract({ address: token.address, abi: TOKEN_ABI, functionName: "balanceOf", args: [recipient] });
    const submit = (request: Transaction, expected = "success") => tx({ to: request.to, data: request.data, value: BigInt(request.value) }, expected);
    const eth: Token = { chainId, address: null, symbol: "ETH", decimals: 18 };
    const a: Token = { chainId, address: tokenA, symbol: "A", decimals: 18 };
    const b: Token = { chainId, address: tokenB, symbol: "B", decimals: 18 };
    for (const [tokenIn, tokenOut] of [[eth, a], [a, b], [a, eth]] as const) {
      const input: QuoteInput = {
        chainId, accountId: "fixture-account", accountAddress: account, recipient,
        tokenIn, tokenOut, amountIn: (10n ** 15n).toString(), slippageBps: 50,
        deadline: (BigInt((await client.getBlock()).timestamp) + 600n).toString(),
      };
      const quote = await quoteSwap(reader, input);
      assert.equal(quote.fee, 3000);
      assert.ok(quote.pool && quote.pool !== zeroAddress);
      assert.notEqual(quote.priceImpactBps, null);
      const prepared = await prepareSwap(reader, quote);
      if (tokenIn.address !== null) {
        assert.ok(prepared.approval, "Insufficient allowance must request an approval");
        await submit(prepared.approval);
        assert.equal((await prepareSwap(reader, quote)).approval, null, "Confirmed allowance must suppress duplicate approval");
      } else assert.equal(prepared.approval, null);
      const before = await balance(tokenOut);
      const impossibleOutput = (BigInt(quote.amountOut) * 2n).toString();
      await submit(swapTransaction({ ...quote, amountOut: impossibleOutput, minimumOut: impossibleOutput, slippageBps: 0 }), "reverted");
      assert.equal(await balance(tokenOut), before, "Reverted slippage check must not transfer output");
      const expired = swapTransaction({ ...quote, deadline: "1" }, 0);
      await submit(expired, "reverted");
      assert.equal(await balance(tokenOut), before, "Expired deadline must not transfer output");
      await submit(prepared.swap);
      assert.equal((await balance(tokenOut)) - before, BigInt(quote.amountOut), "Official pool must deliver the quoted output to the actual recipient");
      assert.equal(await client.getBalance({ address: ROUTER }), 0n, "Router must retain no native input/refund value");
      assert.equal(await client.readContract({ address: wrapped, abi: TOKEN_ABI, functionName: "balanceOf", args: [ROUTER] }), 0n, "Native output must be unwrapped and sent to the recipient");
      console.log(`${chainId}: ${tokenIn.symbol} -> ${tokenOut.symbol}: quote, allowance, slippage revert, deadline revert and actual output passed`);
    }
  } finally {
    await provider.disconnect();
  }
}
console.log("Real Uniswap V3 contract fixture passed for Ethereum and Arbitrum configurations.");
