import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ContractFactory, getAddress, Interface, MaxUint256, ZeroAddress, type InterfaceAbi } from "ethers";
import { FACTORY, NETWORKS, QUOTER, ROUTER } from "../../../apps/uniswap/src/swap.ts";
import type { EvmNetworkFixture } from "./evm-wallet-network.ts";

const run = promisify(execFile);
const fixtureDirectory = fileURLToPath(new URL("../../../apps/uniswap/test/fixtures/", import.meta.url));
const tokenAbi = new Interface([
  "function mint(address,uint256)", "function deposit() payable", "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
]);
type Artifact = { abi: InterfaceAbi; bytecode: string };
export type UniswapNetworkFixture = {
  chainId: "1" | "42161"; tokenA: string; tokenB: string; wrapped: string;
  router: string; quoter: string; factory: string; manager: string; deployer: string; pools: string[];
  decimals: 18; fee: 3000;
  fund(address: string): Promise<void>;
  balance(token: string, address: string): Promise<bigint>;
  allowance(token: string, address: string): Promise<bigint>;
};
type MiningMode = { automine: boolean; interval: number | null };
export type UniswapQuoteMiningEvidence = {
  chainId: "1";
  original: MiningMode;
  paused: MiningMode | null;
  restored: MiningMode | null;
  blockBefore: string | null;
  blockAfter: string | null;
};

/** The coordinator authorizes this only during the exclusive Ethereum quote
 * window. The callback must contain read-only quoting and inspection grants;
 * restoration finishes before it can return to any approval/signing code.
 */
export async function withStableUniswapQuote<T>(
  network: EvmNetworkFixture,
  quote: () => Promise<T>,
  record: (evidence: UniswapQuoteMiningEvidence) => Promise<void>,
): Promise<T> {
  assert.equal(network.chainId, "1");
  assert.equal(new URL(network.rpcUrl).href, "http://127.0.0.1:8545/");
  assert.equal(network.nodeKind, "anvil");
  const { chain } = network;
  async function miningMode(): Promise<MiningMode> {
    const [automine, interval] = await Promise.all([
      chain.rpc<boolean>("anvil_getAutomine"),
      chain.rpc<number | null>("anvil_getIntervalMining"),
    ]);
    assert.equal(typeof automine, "boolean");
    assert.ok(interval === null || (Number.isSafeInteger(interval) && interval > 0));
    return { automine, interval };
  }
  const original = await miningMode();
  assert.deepEqual(original, { automine: false, interval: 1 }, "The coordinator's Ethereum fixture mining mode changed");
  const evidence: UniswapQuoteMiningEvidence = { chainId: "1", original, paused: null, restored: null, blockBefore: null, blockAfter: null };
  try {
    // The finally starts before either mutation: even a lost mining-control
    // reply cannot leave restoration skipped while a callback fails.
    await chain.rpc("evm_setIntervalMining", [0]);
    await chain.rpc("evm_setAutomine", [false]);
    evidence.paused = await miningMode();
    assert.deepEqual(evidence.paused, { automine: false, interval: null });
    evidence.blockBefore = BigInt(await chain.rpc<string>("eth_blockNumber")).toString();
    const result = await quote();
    evidence.blockAfter = BigInt(await chain.rpc<string>("eth_blockNumber")).toString();
    // A queued interval block may settle after the pause. Keep both observed
    // heads; the strict numeric app result verifies its quote/pool block match.
    return result;
  } finally {
    try {
      // Anvil's interval setter selects an entire mode. Restore instant mode
      // first, then the exact previously observed interval, and verify both.
      await chain.rpc("evm_setIntervalMining", [0]);
      await chain.rpc("evm_setAutomine", [original.automine]);
      if (original.interval !== null) await chain.rpc("evm_setIntervalMining", [original.interval]);
      evidence.restored = await miningMode();
      assert.deepEqual(evidence.restored, original);
    } finally {
      await record(evidence);
    }
  }
}

/** Official V3 bytecode with local test tokens. Chain 42161 is an Anvil EVM
 * fixture: it does not provide Nitro posting costs, sequencer or L1 finality.
 * Matches anvil_setup.ts's final-address constructor deployment without
 * resetting a chain, replacing a different contract, or touching wallet keys.
 */
export async function createUniswapNetworkFixture(network: EvmNetworkFixture): Promise<UniswapNetworkFixture> {
  const { chain, chainId } = network;
  async function assertLocalAnvil() {
    const endpoint = new URL(network.rpcUrl);
    assert.equal(endpoint.protocol, "http:"); assert.equal(endpoint.hostname, "127.0.0.1");
    assert.equal(endpoint.username + endpoint.password + endpoint.search + endpoint.hash, "");
    assert.equal(endpoint.pathname, "/");
    assert.match(await chain.rpc<string>("web3_clientVersion"), /^anvil\b/iu);
    assert.equal(BigInt(await chain.rpc<string>("eth_chainId")), BigInt(chainId));
    const node = await chain.rpc<{ forkConfig?: { forkUrl?: unknown; forkBlockNumber?: unknown } }>("anvil_nodeInfo");
    assert.equal(node.forkConfig?.forkUrl == null && node.forkConfig?.forkBlockNumber == null, true, "Uniswap fixture requires an unforked local Anvil node");
  }
  await assertLocalAnvil();
  let dependencies = process.env.NEUTRON_UNISWAP_FIXTURE_DEPS;
  let temporary: string | undefined;
  let artifacts: { factory: Artifact; manager: Artifact; quoter: Artifact; router: Artifact; token: Artifact; wrapped: Artifact };
  try {
    if (!dependencies) {
      temporary = await mkdtemp(path.join(os.tmpdir(), "neutron-uniswap-network-deps-"));
      dependencies = temporary;
      await Promise.all(["package.json", "package-lock.json"].map((filename) => copyFile(path.join(fixtureDirectory, filename), path.join(temporary!, filename))));
      await run("npm", ["--prefix", dependencies, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    }
    const fixtureRequire = createRequire(path.join(dependencies, "package.json"));
    const solc = fixtureRequire("solc");
    const compiled = JSON.parse(solc.compile(JSON.stringify({
      language: "Solidity", sources: { "Tokens.sol": { content: await readFile(path.join(fixtureDirectory, "Tokens.sol"), "utf8") } },
      settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
    })));
    assert.deepEqual(compiled.errors?.filter((error: { severity: string }) => error.severity === "error") ?? [], []);
    const token = (name: string): Artifact => ({ abi: compiled.contracts["Tokens.sol"][name].abi, bytecode: `0x${compiled.contracts["Tokens.sol"][name].evm.bytecode.object}` });
    artifacts = {
      factory: fixtureRequire("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
      manager: fixtureRequire("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
      quoter: fixtureRequire("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json"),
      router: fixtureRequire("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json"),
      token: token("Token"), wrapped: token("WrappedEther"),
    };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }

  const accounts = await chain.rpc<string[]>("eth_accounts");
  assert.ok(accounts.length >= 2, "Local fixture needs unlocked development accounts");
  const deployer = getAddress(accounts.at(-1)!);
  const wrapped = NETWORKS[chainId].wrapped;
  const tokenA = getAddress("0x1000000000000000000000000000000000000011");
  const tokenB = getAddress("0x1000000000000000000000000000000000000012");
  const manager = getAddress("0x1000000000000000000000000000000000000013");
  async function receipt(hash: string) {
    let result: { status: string } | null = null;
    const deadline = Date.now() + 30_000;
    while (result === null && Date.now() < deadline) {
      result = await chain.rpc("eth_getTransactionReceipt", [hash]);
      if (result === null) await delay(250);
    }
    assert.equal(result?.status, "0x1", `Local fixture transaction ${hash} did not settle`);
  }
  async function send(to: string, data: string, value = 0n, gas = "0xb71b00") {
    await receipt(await chain.rpc<string>("eth_sendTransaction", [{ from: deployer, to, data, value: `0x${value.toString(16)}`, gas }]));
  }
  async function installAt(address: string, artifact: Artifact, args: unknown[] = []) {
    const initCode = (await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args)).data;
    const runtime = await chain.rpc<string>("eth_call", [{ from: deployer, to: address, data: "0x", gas: "0x1c9c380" }, "latest", { [address]: { code: initCode } }]);
    assert.ok(runtime.length > 2);
    const existing = await chain.rpc<string>("eth_getCode", [address, "latest"]);
    if (existing !== "0x") {
      assert.equal(existing.toLowerCase(), runtime.toLowerCase(), `Refusing to overwrite another local contract at ${address}`);
      return;
    }
    await assertLocalAnvil();
    await chain.rpc("anvil_setCode", [address, initCode]);
    await send(address, "0x", 0n, "0x1c9c380");
    await chain.rpc("anvil_setCode", [address, runtime]);
    assert.equal((await chain.rpc<string>("eth_getCode", [address, "latest"])).toLowerCase(), runtime.toLowerCase());
  }
  async function write(address: string, abi: Interface, name: string, args: unknown[] = [], value = 0n) {
    await send(address, abi.encodeFunctionData(name, args), value);
  }
  async function read(address: string, abi: Interface, name: string, args: unknown[] = []) {
    const result = await chain.rpc<string>("eth_call", [{ to: address, data: abi.encodeFunctionData(name, args) }, "latest"]);
    return abi.decodeFunctionResult(name, result);
  }
  await installAt(wrapped, artifacts.wrapped);
  await installAt(tokenA, artifacts.token); await installAt(tokenB, artifacts.token);
  await installAt(FACTORY, artifacts.factory);
  const factoryAbi = new Interface(artifacts.factory.abi);
  assert.equal(getAddress((await read(FACTORY, factoryAbi, "owner"))[0]), deployer);
  await installAt(manager, artifacts.manager, [FACTORY, wrapped, ZeroAddress]);
  await installAt(ROUTER, artifacts.router, [ZeroAddress, FACTORY, manager, wrapped]);
  await installAt(QUOTER, artifacts.quoter, [FACTORY, wrapped]);
  await write(wrapped, tokenAbi, "deposit", [], 250n * 10n ** 18n);
  for (const token of [tokenA, tokenB]) await write(token, tokenAbi, "mint", [deployer, 1000n * 10n ** 18n]);
  for (const token of [wrapped, tokenA, tokenB]) await write(token, tokenAbi, "approve", [manager, MaxUint256]);
  const managerAbi = new Interface(artifacts.manager.abi);
  const pools: string[] = [];
  for (const pair of [[wrapped, tokenA], [tokenA, tokenB]]) {
    const [token0, token1] = pair.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    await write(manager, managerAbi, "createAndInitializePoolIfNecessary", [token0, token1, 3000, 2n ** 96n]);
    await write(manager, managerAbi, "mint", [{ token0, token1, fee: 3000, tickLower: -887220, tickUpper: 887220, amount0Desired: 100n * 10n ** 18n, amount1Desired: 100n * 10n ** 18n, amount0Min: 0n, amount1Min: 0n, recipient: deployer, deadline: MaxUint256 }]);
    const pool = getAddress((await read(FACTORY, factoryAbi, "getPool", [token0, token1, 3000]))[0]);
    assert.notEqual(pool, ZeroAddress); pools.push(pool);
  }
  const balance = async (token: string, address: string): Promise<bigint> => BigInt((await read(token, tokenAbi, "balanceOf", [getAddress(address)]))[0]);
  return {
    chainId, tokenA, tokenB, wrapped, router: ROUTER, quoter: QUOTER, factory: FACTORY, manager, deployer, pools, decimals: 18, fee: 3000,
    balance,
    async allowance(token, address) { return BigInt((await read(token, tokenAbi, "allowance", [getAddress(address), ROUTER]))[0]); },
    async fund(address) {
      const recipient = getAddress(address);
      await assertLocalAnvil(); await network.fund(recipient);
      for (const token of [tokenA, tokenB]) {
        const before = await balance(token, recipient);
        await write(token, tokenAbi, "mint", [recipient, 10n * 10n ** 18n]);
        assert.equal(await balance(token, recipient), before + 10n * 10n ** 18n);
      }
    },
  };
}
