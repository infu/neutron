import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { InterfaceAbi } from "ethers";

const run = promisify(execFile);
const fixtureDirectory = fileURLToPath(new URL("./erc20-contracts/", import.meta.url));
const HELPER_SOURCE_URL = "https://raw.githubusercontent.com/dfinity/ic/a47e5434753752c1d2972fbc4407d14f88964285/rs/ethereum/cketh/minter/ERC20DepositHelper.sol";
const HELPER_SOURCE_SHA256 = "2b6fbb45f42f3758cb6fb8ee1a7310a050f33546ba27b17e5cf2889f98ffcc57";
const COMPILER_VERSION = "0.8.20+commit.a1b79de6.Emscripten.clang";

type ContractArtifact = {
  abi: InterfaceAbi;
  bytecode: string;
  sourceSha256: string;
  compilerVersion: string;
};
export type Erc20ContractArtifacts = {
  helper: ContractArtifact;
  token: ContractArtifact & { runtimeBytecode: string };
};
type CompilerContract = {
  abi: InterfaceAbi;
  evm: { bytecode: { object: string }; deployedBytecode: { object: string } };
};
type CompilerOutput = {
  contracts?: Record<string, Record<string, CompilerContract>>;
  errors?: { severity: string; formattedMessage: string }[];
};
type Compiler = { version(): string; compile(input: string): string };

/** Compile the exact released protocol helper and a local six-decimal token.
 * The token is a test stand-in with zero-reset approval behavior, not Circle's
 * USDC contract. This function never contacts an EVM node or changes its state.
 */
export async function prepareErc20ContractArtifacts(): Promise<Erc20ContractArtifacts> {
  const response = await fetch(HELPER_SOURCE_URL, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Pinned ERC20 helper source returned HTTP ${response.status}`);
  const helperSource = await response.text();
  if (digest(helperSource) !== HELPER_SOURCE_SHA256) throw new Error("Pinned ERC20 helper source SHA-256 mismatch");
  const tokenSource = await readFile(path.join(fixtureDirectory, "ProtocolToken.sol"), "utf8");
  const dependencies = await mkdtemp(path.join(os.tmpdir(), "neutron-erc20-contract-deps-"));
  try {
    await Promise.all(["package.json", "package-lock.json"].map((filename) => copyFile(path.join(fixtureDirectory, filename), path.join(dependencies, filename))));
    await run("npm", ["--prefix", dependencies, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    const fixtureRequire = createRequire(path.join(dependencies, "package.json"));
    const compiler = fixtureRequire("solc") as Compiler;
    const compilerVersion = compiler.version();
    if (compilerVersion !== COMPILER_VERSION) throw new Error(`Unexpected fixture Solidity compiler ${compilerVersion}`);
    const compiled = JSON.parse(compiler.compile(JSON.stringify({
      language: "Solidity",
      sources: {
        "ERC20DepositHelper.sol": { content: helperSource },
        "ProtocolToken.sol": { content: tokenSource },
      },
      settings: {
        evmVersion: "paris",
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
      },
    }))) as CompilerOutput;
    const errors = compiled.errors?.filter((error) => error.severity === "error") ?? [];
    if (errors.length) throw new Error(`ERC20 fixture compilation failed:\n${errors.map((error) => error.formattedMessage).join("\n")}`);
    function contract(filename: string, name: string): CompilerContract {
      const output = compiled.contracts?.[filename]?.[name];
      if (!output || !Array.isArray(output.abi)) throw new Error(`Solidity compiler omitted ${filename}:${name}`);
      return output;
    }
    const helper = contract("ERC20DepositHelper.sol", "CkErc20Deposit");
    const token = contract("ProtocolToken.sol", "ProtocolToken");
    return {
      helper: { abi: helper.abi, bytecode: bytecode(helper.evm.bytecode.object), sourceSha256: HELPER_SOURCE_SHA256, compilerVersion },
      token: { abi: token.abi, bytecode: bytecode(token.evm.bytecode.object), runtimeBytecode: bytecode(token.evm.deployedBytecode.object), sourceSha256: digest(tokenSource), compilerVersion },
    };
  } finally {
    await rm(dependencies, { recursive: true, force: true });
  }
}

function digest(source: string): string { return createHash("sha256").update(source).digest("hex"); }
function bytecode(value: string): string {
  if (!/^(?:[0-9a-f]{2})+$/iu.test(value)) throw new Error("Solidity compiler returned empty or unlinked bytecode");
  return `0x${value}`;
}
