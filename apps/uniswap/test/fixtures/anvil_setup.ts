import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, custom, encodeDeployData, getAddress,
  maxUint256, parseAbi, zeroAddress, type Address, type Hex,
} from "viem";
import { FACTORY, NETWORKS, QUOTER, ROUTER, TOKEN_ABI, quoteSwap, type Reader } from "../../src/swap.ts";

// This helper intentionally has no endpoint option. Never run fixture setup
// against an inferred browser wallet, public RPC endpoint, or mainnet fork.
const endpoint = new URL("http://127.0.0.1:8545/");
let rpcId = 0;
async function rpc<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
  assert.equal(endpoint.href, "http://127.0.0.1:8545/");
  const id = ++rpcId;
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.ok, true, `Local Anvil ${method}: HTTP ${response.status}`);
  const body = await response.json() as { jsonrpc?: string; id?: number; result?: T; error?: unknown };
  assert.equal(body.jsonrpc, "2.0"); assert.equal(body.id, id);
  if (body.error) throw new Error(`Local Anvil ${method}: ${JSON.stringify(body.error)}`);
  assert.ok("result" in body, `Local Anvil ${method} omitted its result`);
  return body.result as T;
}
async function assertLocalAnvil() {
  assert.match(await rpc<string>("web3_clientVersion"), /^anvil\b/iu);
  assert.equal(BigInt(await rpc<string>("eth_chainId")), 1n);
  const node = await rpc<{ forkConfig?: { forkUrl?: unknown; forkBlockNumber?: unknown } }>("anvil_nodeInfo");
  assert.equal(node.forkConfig?.forkUrl == null && node.forkConfig?.forkBlockNumber == null, true, "Fixture setup requires an unforked local Anvil chain");
}
await assertLocalAnvil();

const dependencyRoot = process.env.NEUTRON_UNISWAP_FIXTURE_DEPS;
if (!dependencyRoot) throw new Error("Set NEUTRON_UNISWAP_FIXTURE_DEPS to the isolated fixture dependency installation");
const fixtureRequire = createRequire(`${dependencyRoot}/package.json`);
const solc = fixtureRequire("solc");
const artifacts = {
  factory: fixtureRequire("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
  manager: fixtureRequire("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
  quoter: fixtureRequire("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json"),
  router: fixtureRequire("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json"),
};
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity", sources: { "Tokens.sol": { content: readFileSync(new URL("./Tokens.sol", import.meta.url), "utf8") } },
  settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
assert.deepEqual(compiled.errors?.filter((error: { severity: string }) => error.severity === "error") ?? [], []);
const tokenArtifact = (name: string) => ({ abi: compiled.contracts["Tokens.sol"][name].abi, bytecode: `0x${compiled.contracts["Tokens.sol"][name].evm.bytecode.object}` });

const transport = custom({ request: ({ method, params }) => rpc(method, params as unknown[] | undefined) });
const client = createPublicClient({ transport, pollingInterval: 250 });
const wallet = createWalletClient({ transport });
const accounts = await wallet.getAddresses();
assert.ok(accounts.length >= 2, "Fixture setup needs the provisioner's unlocked local development accounts");
const deployer = getAddress(accounts.at(-1)!);
const wrapped = NETWORKS["1"].wrapped;
const tokenA = getAddress("0x1000000000000000000000000000000000000011");
const tokenB = getAddress("0x1000000000000000000000000000000000000012");
const manager = getAddress("0x1000000000000000000000000000000000000013");

async function receipt(hash: Hex) {
  const result = await client.waitForTransactionReceipt({ hash });
  assert.equal(result.status, "success", `Local fixture transaction ${hash} reverted`);
  return result;
}
async function installAt(address: Address, artifact: { abi: any; bytecode: string }, args: unknown[] = []) {
  const initCode = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode as Hex, args });
  // Executing unmodified initcode at the final address preserves constructor
  // address(this), including the factory's NoDelegateCall immutable. Preview
  // with eth_call's local code override, run the constructor to persist its
  // storage, then replace initcode with exactly its returned runtime code.
  const runtime = await rpc<Hex>("eth_call", [
    { from: deployer, to: address, data: "0x", gas: "0x1c9c380" },
    "latest", { [address]: { code: initCode } },
  ]);
  assert.ok(runtime.length > 2);
  const existing = await client.getCode({ address });
  if (existing && existing !== "0x") {
    assert.equal(existing.toLowerCase(), runtime.toLowerCase(), `Refusing to overwrite a different local contract at ${address}`);
    return;
  }
  await assertLocalAnvil();
  await rpc("anvil_setCode", [address, initCode]);
  await receipt(await wallet.sendTransaction({ account: deployer, chain: null, to: address, data: "0x", gas: 30_000_000n }));
  await rpc("anvil_setCode", [address, runtime]);
  assert.equal((await client.getCode({ address }))?.toLowerCase(), runtime.toLowerCase());
}
async function write(address: Address, abi: any, functionName: string, args: unknown[] = [], value = 0n) {
  return receipt(await wallet.writeContract({ account: deployer, chain: null, address, abi, functionName, args, value, gas: 12_000_000n }));
}

await installAt(wrapped, tokenArtifact("WrappedEther"));
await installAt(tokenA, tokenArtifact("Token"));
await installAt(tokenB, tokenArtifact("Token"));
await installAt(FACTORY, artifacts.factory);
assert.equal(await client.readContract({ address: FACTORY, abi: artifacts.factory.abi, functionName: "owner" }), deployer);
assert.equal(await client.readContract({ address: FACTORY, abi: artifacts.factory.abi, functionName: "feeAmountTickSpacing", args: [3000] }), 60);
await installAt(manager, artifacts.manager, [FACTORY, wrapped, zeroAddress]);
await installAt(ROUTER, artifacts.router, [zeroAddress, FACTORY, manager, wrapped]);
await installAt(QUOTER, artifacts.quoter, [FACTORY, wrapped]);

const mintAbi = parseAbi(["function mint(address,uint256)", "function deposit() payable"]);
await write(wrapped, mintAbi, "deposit", [], 250n * 10n ** 18n);
for (const address of [tokenA, tokenB]) await write(address, mintAbi, "mint", [deployer, 1000n * 10n ** 18n]);
for (const address of [wrapped, tokenA, tokenB]) await write(address, TOKEN_ABI, "approve", [manager, maxUint256]);
const pools: Address[] = [];
for (const pair of [[wrapped, tokenA], [tokenA, tokenB]]) {
  const [token0, token1] = pair.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  await write(manager, artifacts.manager.abi, "createAndInitializePoolIfNecessary", [token0, token1, 3000, 2n ** 96n]);
  await write(manager, artifacts.manager.abi, "mint", [{
    token0, token1, fee: 3000, tickLower: -887220, tickUpper: 887220,
    amount0Desired: 100n * 10n ** 18n, amount1Desired: 100n * 10n ** 18n,
    amount0Min: 0n, amount1Min: 0n, recipient: deployer, deadline: maxUint256,
  }]);
  const pool = await client.readContract({ address: FACTORY, abi: artifacts.factory.abi, functionName: "getPool", args: [token0, token1, 3000] });
  assert.equal(typeof pool, "string"); assert.notEqual(pool, zeroAddress);
  pools.push(getAddress(pool as string));
}

const reader: Reader = async (chainId, address, data, tag) => {
  assert.equal(chainId, "1");
  const blockNumber = tag ? BigInt(tag) : await client.getBlockNumber({ cacheTime: 0 });
  const result = await client.call({ account: deployer, to: address, data, blockNumber });
  assert.ok(result.data);
  return { data: result.data, blockNumber: blockNumber.toString(), observedAtMs: Date.now() };
};
const quote = await quoteSwap(reader, {
  chainId: "1", accountId: "local-fixture", accountAddress: deployer, recipient: deployer,
  tokenIn: { chainId: "1", address: tokenA, symbol: "FIX", decimals: 18 },
  tokenOut: { chainId: "1", address: tokenB, symbol: "FIX", decimals: 18 },
  amountIn: "1000000000000000", slippageBps: 50,
  deadline: (BigInt((await client.getBlock()).timestamp) + 600n).toString(),
});
assert.equal(quote.fee, 3000); assert.equal(quote.pool, pools[1]); assert.notEqual(quote.priceImpactBps, null);
console.log(JSON.stringify({ chainId: "1", tokenA, tokenB, wrapped, router: ROUTER, quoter: QUOTER, factory: FACTORY, manager, deployer, pools, decimals: 18, fee: 3000, recommendedAmountAtoms: "1000000000000000", quotedOutputAtoms: quote.amountOut }));
