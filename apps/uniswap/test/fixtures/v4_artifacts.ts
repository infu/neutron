import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Universal Router 2.1.1 has no matching npm release. Build its exact tag and
// pinned submodules instead of accidentally testing the older npm ABI.
const sources = [
  ["router", "Uniswap/universal-router", "999d561c3ad58fb5cab91b602911f3c75591a9c7", "92fca3e755543848ddd2ae71e1e18c77de7a8237879e84f5ed96b16529a6e379"],
  ["v4-periphery", "Uniswap/v4-periphery", "3231810e39b8c4d569b9d66907fa4ef8cd2cec22", "8d638567fa2a568cecc04ea64a8241ee1aebe7d5caf9bca660d0e98056e9f918"],
  ["v3-periphery", "Uniswap/v3-periphery", "b325bb0905d922ae61fcc7df85ee802e8df5e96c", "75ee4e66a66503c21fdd8a9cdf32dfec1dd63b7ddcf0dfa569936bfe25b64f3b"],
  ["permit2", "Uniswap/permit2", "cc56ad0f3439c502c246fc5cfcc3db92bb8b7219", "1f0da63e66c69fa85f2a68af7f598aca8f3354f87e7703aa3abe6522685e9f04"],
  ["solmate", "transmissions11/solmate", "8d910d876f51c3b2585c9109409d601f600e68e1", "c5dabbbb15de9fc375281e336bce798c910e7dd6a172940556918767f5974c91"],
] as const;

export async function loadV4Artifacts(dependencyRoot: string) {
  const require = createRequire(`${dependencyRoot}/package.json`);
  const cache = join(dependencyRoot, "v4-contract-cache");
  mkdirSync(cache, { recursive: true });
  const bundledPeriphery = join(dependencyRoot, "node_modules/@uniswap/v4-periphery");
  const artifact = (path: string) => {
    const value = require(`${bundledPeriphery}/foundry-out/${path}`);
    assert.deepEqual(value.bytecode.linkReferences, {});
    return { abi: value.abi, bytecode: value.bytecode.object as `0x${string}` };
  };
  const artifacts = {
    manager: artifact("PoolManager.sol/PoolManager.default.json"),
    positionManager: artifact("PositionManager.sol/PositionManager.json"),
    quoter: artifact("V4Quoter.sol/V4Quoter.json"),
    stateView: artifact("StateView.sol/StateView.json"),
  };
  const compiledPath = join(cache, "compiled-router-2.1.1-permit2.json");
  if (existsSync(compiledPath)) return { ...artifacts, ...JSON.parse(readFileSync(compiledPath, "utf8")) };
  for (const [name, repository, commit, digest] of sources) {
    const path = join(cache, name);
    if (existsSync(join(path, ".verified-source"))) continue;
    const response = await fetch(`https://codeload.github.com/${repository}/tar.gz/${commit}`);
    assert.equal(response.ok, true, `Pinned ${repository} download`);
    const archive = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(archive).digest("hex"), digest, `Pinned ${repository} source checksum`);
    const archivePath = join(cache, `${name}.tgz`);
    writeFileSync(archivePath, archive);
    mkdirSync(path, { recursive: true });
    execFileSync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", path]);
    writeFileSync(join(path, ".verified-source"), commit);
  }
  const mappings = [
    ["@uniswap/v4-periphery/", join(cache, "v4-periphery")],
    ["@uniswap/v3-periphery/", join(cache, "v3-periphery")],
    ["@uniswap/v4-core/", join(bundledPeriphery, "lib/v4-core")],
    ["permit2/", join(cache, "permit2")],
    ["solmate/", join(cache, "solmate")],
    ["contracts/", join(cache, "router/contracts")],
    ["", join(dependencyRoot, "node_modules")],
  ];
  const imports = (path: string) => {
    const mapping = mappings.find(([prefix]) => path.startsWith(prefix));
    if (!mapping) return { error: `Unmapped official source import: ${path}` };
    try { return { contents: readFileSync(join(mapping[1], path.slice(mapping[0].length)), "utf8") }; }
    catch { return { error: `Missing official source import: ${path}` }; }
  };
  const compile = (compiler: string, source: string, contract: string, evmVersion: string) => {
    const input = {
      language: "Solidity",
      sources: { [source]: { content: imports(source).contents } },
      settings: { evmVersion, viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { [source]: { [contract]: ["abi", "evm.bytecode.object"] } } },
    };
    const result = JSON.parse(require(compiler).compile(JSON.stringify(input), { import: imports }));
    assert.deepEqual(result.errors?.filter((item: { severity: string }) => item.severity === "error") ?? [], [], `${contract} compilation`);
    const output = result.contracts[source][contract];
    return { abi: output.abi, bytecode: `0x${output.evm.bytecode.object}` };
  };
  console.log("Compiling pinned Universal Router 2.1.1 and Permit2 for the disposable local EVM.");
  const compiled = {
    router: compile("solc-v4", "contracts/UniversalRouter.sol", "UniversalRouter", "cancun"),
    permit2: compile("solc-permit2", "permit2/src/Permit2.sol", "Permit2", "london"),
  };
  writeFileSync(compiledPath, JSON.stringify(compiled));
  return { ...artifacts, ...compiled };
}
