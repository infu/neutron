import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { getAddress, Interface } from "ethers";
import { createLocalEvmChain } from "./evm-wallet-chain.ts";

const run = promisify(execFile);
const fixtureDirectory = fileURLToPath(new URL("../../../apps/uniswap/test/fixtures/", import.meta.url));
const tokenAbi = new Interface(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const FUND_TOKENS = 10n * 10n ** 18n;

export type LocalUniswapFixture = {
  chainId: "1";
  tokenA: string;
  tokenB: string;
  wrapped: string;
  router: string;
  quoter: string;
  factory: string;
  manager: string;
  deployer: string;
  pools: string[];
  decimals: 18;
  fee: 3000;
  recommendedAmountAtoms: string;
  quotedOutputAtoms: string;
  /** Adds ten fixture tokens of each kind and gives the real account 10 ETH. */
  fund(address: string): Promise<void>;
  balance(token: string, address: string): Promise<bigint>;
  allowance(token: string, address: string): Promise<bigint>;
};

/** Installs official contracts only on the pinned, unforked local Anvil node. */
export async function createLocalUniswapFixture(): Promise<LocalUniswapFixture> {
  const chain = await createLocalEvmChain();
  const node = await chain.rpc<{ forkConfig?: { forkUrl?: unknown; forkBlockNumber?: unknown } }>("anvil_nodeInfo");
  if (node.forkConfig?.forkUrl != null || node.forkConfig?.forkBlockNumber != null) throw new Error("Uniswap fixture requires an unforked local Anvil node");
  let dependencies = process.env.NEUTRON_UNISWAP_FIXTURE_DEPS;
  let temporary: string | undefined;
  let stdout: string;
  try {
    if (!dependencies) {
      temporary = await mkdtemp(path.join(os.tmpdir(), "neutron-uniswap-e2e-deps-"));
      dependencies = temporary;
      await Promise.all(["package.json", "package-lock.json"].map((filename) => copyFile(path.join(fixtureDirectory, filename), path.join(temporary!, filename))));
      await run("npm", ["--prefix", dependencies, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    }
    ({ stdout } = await run("bun", [path.join(fixtureDirectory, "anvil_setup.ts")], {
      env: { ...process.env, NEUTRON_UNISWAP_FIXTURE_DEPS: dependencies },
      timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    }));
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  const manifest = JSON.parse(stdout!.trim()) as Omit<LocalUniswapFixture, "fund" | "balance" | "allowance">;
  if (manifest.chainId !== "1" || manifest.decimals !== 18 || manifest.fee !== 3000) throw new Error("Unexpected Uniswap fixture manifest");
  for (const address of [manifest.tokenA, manifest.tokenB, manifest.wrapped, manifest.router, manifest.quoter, manifest.factory, manifest.manager, manifest.deployer, ...manifest.pools]) getAddress(address);

  async function balance(token: string, address: string): Promise<bigint> {
    const result = await chain.rpc<string>("eth_call", [{ to: getAddress(token), data: tokenAbi.encodeFunctionData("balanceOf", [getAddress(address)]) }, "latest"]);
    return BigInt(tokenAbi.decodeFunctionResult("balanceOf", result)[0]);
  }
  return {
    ...manifest, balance,
    async allowance(token, address) {
      const result = await chain.rpc<string>("eth_call", [{ to: getAddress(token), data: tokenAbi.encodeFunctionData("allowance", [getAddress(address), manifest.router]) }, "latest"]);
      return BigInt(tokenAbi.decodeFunctionResult("allowance", result)[0]);
    },
    async fund(address) {
      const recipient = getAddress(address);
      // This rechecks client and chain before any local balance manipulation.
      await chain.fund(recipient);
      for (const token of [manifest.tokenA, manifest.tokenB]) {
        const before = await balance(token, recipient);
        const hash = await chain.rpc<string>("eth_sendTransaction", [{ from: manifest.deployer, to: token, data: tokenAbi.encodeFunctionData("mint", [recipient, FUND_TOKENS]), gas: "0x186a0" }]);
        let receipt: { status?: string } | null = null;
        const deadline = Date.now() + 30_000;
        while (receipt === null && Date.now() < deadline) {
          receipt = await chain.rpc<{ status?: string } | null>("eth_getTransactionReceipt", [hash]);
          if (receipt === null) await delay(250);
        }
        if (receipt?.status !== "0x1" || await balance(token, recipient) !== before + FUND_TOKENS) throw new Error("Local fixture token funding did not settle");
      }
    },
  };
}
