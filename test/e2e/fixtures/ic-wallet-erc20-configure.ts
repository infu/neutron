import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePackageInstall } from "neutron-compiler/src/install.js";
import { loadNdeployConfig, resolveLocalPackagePaths } from "../../../packages/neutron-provision/src/config.ts";
import { localFixtureCacheDirectory } from "../../../packages/neutron-provision/src/local_server.ts";
import { resolveLocalNeutronRuntime } from "../../../packages/neutron-provision/src/local_session.ts";
import { verifyPocketIcRuntime, type PocketIcRuntimeDescriptor } from "../../../packages/neutron-provision/src/pocketic_supervisor.ts";
import { readSession } from "../../../packages/neutron-provision/src/session.ts";
import { configureFreshErc20Protocol } from "./ic-wallet-erc20-provision.ts";

// Bun-only explicit setup command. Importing performs no runtime or financial
// action. Run only after the lifecycle owner grants the fresh Ethereum window.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type PackagePin = { path: string; id: string; version: number; size: number; sha256: string };

export async function configureErc20Qualification(configPath: string): Promise<string> {
  assert.equal(path.resolve(configPath), path.join(root, "evm-wallet-erc20-local.ndeploy.json"));
  const config = await loadNdeployConfig(configPath);
  assert(config.target.kind === "pocketic" && config.target.profile === "full_protocol_fixtures");
  const directory = path.join(root, ".neutron/release-receipts/evm-wallet-completion-2026-09-06/erc20-runtime");
  const readyPath = path.join(directory, "ready.json"), deploymentPath = path.join(directory, "first-deployment.json");
  const [readyBytes, deploymentBytes] = await Promise.all([readFile(readyPath), readFile(deploymentPath)]);
  const ready = JSON.parse(readyBytes.toString()) as { configSha256: string; descriptor: PocketIcRuntimeDescriptor; packagePins: PackagePin[] };
  const deployment = JSON.parse(deploymentBytes.toString()) as { configSha256: string; node: { canisterId: string }; deploymentId: string; packagePins: PackagePin[]; firstCreatedCanisterOnly: boolean; reinstallPermitted: boolean };
  const runtime = resolveLocalNeutronRuntime({ configPath });
  const journal = await readSession(runtime.sessionPath);
  assert(journal?.runtime.kind === "pocketic" && journal.current?.kind === "local" && !journal.active);
  assert.equal(journal.configSha256, config.configSha256);
  assert.equal(ready.configSha256, config.configSha256);
  assert.equal(deployment.configSha256, config.configSha256);
  assert.equal(deployment.firstCreatedCanisterOnly, true);
  assert.equal(deployment.reinstallPermitted, false);
  assert.equal(deployment.node.canisterId, runtime.canisterId);
  assert.equal(journal.current.deploymentId, deployment.deploymentId);
  assert.equal(ready.descriptor.stateDirectory, path.join(root, ".neutron/evm-wallet-erc20-pocketic"));
  assert.equal(runtime.controlUrl, ready.descriptor.controlUrl);
  assert.equal(runtime.instanceId, ready.descriptor.instanceId);
  assert.equal(runtime.gatewayUrl, ready.descriptor.gateway.url);
  assert.equal(journal.runtime.rootKeyBase64, ready.descriptor.rootKeyBase64);
  const pins: PackagePin[] = [];
  for (const filename of await resolveLocalPackagePaths(config)) {
    const bytes = await readFile(filename), parsed = preparePackageInstall(bytes);
    pins.push({ path: filename, id: parsed.manifest.id, version: parsed.manifest.version, size: bytes.length, sha256: sha256(bytes) });
  }
  assert.deepEqual(pins, ready.packagePins);
  assert.deepEqual(pins, deployment.packagePins);
  await verifyPocketIcRuntime(ready.descriptor);
  const protocol = await configureFreshErc20Protocol({
    gatewayUrl: runtime.gatewayUrl,
    expectedRootKeyBase64: ready.descriptor.rootKeyBase64,
    cacheDirectory: localFixtureCacheDirectory(ready.descriptor.stateDirectory),
  });
  await verifyPocketIcRuntime(ready.descriptor);
  const evidencePath = path.join(directory, `protocol-configured-${Date.now()}.json`);
  await writeFile(evidencePath, JSON.stringify({
    format: 1, configuredAt: new Date().toISOString(), configPath: path.relative(root, path.resolve(configPath)),
    configSha256: config.configSha256, canisterId: runtime.canisterId, deploymentId: deployment.deploymentId,
    descriptor: ready.descriptor, packagePins: pins, protocol,
    sourceEvidence: [readyPath, deploymentPath].map((filename, index) => ({ path: path.relative(root, filename), sha256: sha256([readyBytes, deploymentBytes][index]!) })),
    limitations: ["Official pinned helper and released minter/ledger protocols use disclosed local six-decimal ERC20 stand-ins; no production Circle/Tether contract execution is claimed."],
  }, null, 2) + "\n", { flag: "wx" });
  return evidencePath;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

if (import.meta.main) {
  const [command, configPath, ...extra] = process.argv.slice(2);
  assert.equal(command, "configure");
  assert(configPath && extra.length === 0, "Usage: bun ic-wallet-erc20-configure.ts configure evm-wallet-erc20-local.ndeploy.json");
  console.log(await configureErc20Qualification(configPath));
}
