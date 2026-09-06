import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trustedInstallationContextFromRootKey, trustedInstallationNetworkIdHex } from "neutron-compiler/src/installation_context.js";
import {
  assertPreparedDeploymentMatchesExpectedArtifacts,
  inspectPinnedPackageArchives,
  prepareDeployment,
  snapshotExpectedPackageArtifacts,
  type PinnedPackageArtifact,
} from "../../../packages/neutron-provision/src/artifact.ts";
import { compiledActorCacheKey } from "../../../packages/neutron-provision/src/compiled_cache.ts";
import { compilerSourceFingerprint } from "../../../packages/neutron-provision/src/compiler_fingerprint.ts";
import { loadNdeployConfig, resolveLocalPackagePaths } from "../../../packages/neutron-provision/src/config.ts";
import { descriptorFromRuntime } from "../../../packages/neutron-provision/src/local_server.ts";
import { parsePocketIcRuntimeDescriptor, verifyPocketIcRuntime, type PocketIcRuntimeDescriptor } from "../../../packages/neutron-provision/src/pocketic_supervisor.ts";
import { readSession } from "../../../packages/neutron-provision/src/session.ts";

/**
 * Opt-in Bun compile-cache preparation; importing performs no actions.
 *
 * bun test/e2e/fixtures/evm-wallet-erc20-prewarm.ts prewarm <reviewed-descriptor.json>
 *
 * Descriptor fields: format = neutron-erc20-compile-prewarm-v1; configPath =
 * evm-wallet-erc20-local.ndeploy.json; configFileSha256 = exact config bytes;
 * currentRuntime = the complete, independently reviewed current isolated
 * PocketIC descriptor (journal.runtime without kind); archives = every ordered
 * {path: absolute, id, version, sha256, bytes}; evidenceDirectory = a NEW path
 * beneath .neutron/evm-wallet-qualification/.
 *
 * Final archive pins and execution require the coordinator's explicit grant.
 * This helper never creates a runtime/canister, borrows a gateway, calls a
 * provision/deployment operation, changes a journal, or performs financial
 * actions. Only compile-cache and separate prewarm evidence files are written.
 * Compilation uses the root key ACTUALLY observed at the verified current
 * gateway. A later fresh runtime must independently verify its own root key
 * and derive its own context; differing network identities naturally miss the
 * cache. This receipt is not evidence of deployment or installed app versions.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const POCKETIC_SHA256 = "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4";
const FORMAT = "neutron-erc20-compile-prewarm-v1";
export type Erc20PrewarmDescriptor = {
  format: typeof FORMAT;
  configPath: string;
  configFileSha256: string;
  currentRuntime: PocketIcRuntimeDescriptor;
  archives: readonly PinnedPackageArtifact[];
  evidenceDirectory: string;
};

/** Pure descriptor validation; intentionally does not manufacture archive pins. */
export function parseErc20PrewarmDescriptor(value: unknown, repositoryRoot = ROOT): Erc20PrewarmDescriptor {
  const root = path.resolve(repositoryRoot);
  assert(value && typeof value === "object" && !Array.isArray(value), "Explicit prewarm descriptor is required");
  const input = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(input).sort(), ["archives", "configFileSha256", "configPath", "currentRuntime", "evidenceDirectory", "format"]);
  assert.equal(input.format, FORMAT);
  assert.equal(input.configPath, "evm-wallet-erc20-local.ndeploy.json");
  assert(typeof input.configFileSha256 === "string" && /^[0-9a-f]{64}$/u.test(input.configFileSha256));
  const runtime = parsePocketIcRuntimeDescriptor(structuredClone(input.currentRuntime));
  assert.equal(runtime.profile, "full_protocol_fixtures");
  assert.equal(runtime.stateDirectory, path.join(root, ".neutron/evm-wallet-pocketic"));
  assert.equal(runtime.binarySha256, POCKETIC_SHA256);
  assert.notEqual(runtime.pid, 1_276_378, "Prewarm observes only the current isolated qualification runtime");
  assert.equal(runtime.instanceId, 0);
  const control = new URL(runtime.controlUrl);
  assert.equal(control.protocol, "http:");
  assert.equal(control.hostname, "127.0.0.1");
  assert(control.port && control.username === "" && control.password === "" && control.search === "" && control.hash === "" && control.pathname === "/");
  assert.equal(runtime.gateway.bind, "127.0.0.1");
  assert.equal(runtime.gateway.port, 8000);
  assert.equal(Buffer.from(runtime.rootKeyBase64, "base64").toString("base64"), runtime.rootKeyBase64);
  const archives = snapshotExpectedPackageArtifacts(input.archives);
  assert.equal(archives[0]!.id, "kernel");
  assert.deepEqual(archives.map(item => item.id).sort(), ["agent", "contacts", "evm_wallet", "kernel", "kitchensink", "uniswap", "wallet"]);
  for (const [index, archive] of archives.entries()) {
    assert.equal((input.archives as Array<{ path: string }>)[index]!.path, archive.path, "Archive paths must be canonical absolute paths");
    assert(archive.path.startsWith(`${path.join(root, "apps")}${path.sep}`), "Archives must be reviewed repository app packages");
  }
  assert(typeof input.evidenceDirectory === "string" && !path.isAbsolute(input.evidenceDirectory));
  const evidenceDirectory = path.resolve(root, input.evidenceDirectory);
  assert(evidenceDirectory.startsWith(`${path.join(root, ".neutron/evm-wallet-qualification")}${path.sep}`));
  return {
    format: FORMAT, configPath: input.configPath, configFileSha256: input.configFileSha256,
    currentRuntime: runtime, archives, evidenceDirectory,
  };
}

export async function prewarmErc20CompileCache(descriptorPath: string, repositoryRoot = ROOT): Promise<string> {
  const root = await realpath(path.resolve(repositoryRoot));
  const descriptorBytes = await readFile(path.resolve(root, descriptorPath));
  const descriptor = parseErc20PrewarmDescriptor(JSON.parse(descriptorBytes.toString("utf8")), root);
  const configPath = path.join(root, descriptor.configPath);
  const configBytes = await readFile(configPath);
  assert.equal(sha256(configBytes), descriptor.configFileSha256, "Config bytes differ from the explicitly reviewed descriptor");
  const config = await loadNdeployConfig(configPath);
  assert.equal(config.target.kind, "pocketic");
  assert.equal(config.target.kind === "pocketic" && config.target.profile, "full_protocol_fixtures");
  const packagePaths = await resolveLocalPackagePaths(config);
  assert.deepEqual(packagePaths, descriptor.archives.map(item => item.path), "Config archive order differs from the complete reviewed pin set");
  await inspectPinnedPackageArchives(descriptor.archives);
  const journalPath = path.join(root, "evm-wallet-local.ndeploy.session.json");
  const journalBytes = await readFile(journalPath);
  assert.equal(await optionalFile(config.sessionPath), null, "Fresh ERC20 deployment journal already exists; prewarm must precede that lifecycle");
  const journal = await readSession(journalPath);
  assert(journal?.runtime.kind === "pocketic");
  assert.deepEqual(descriptorFromRuntime(journal.runtime), descriptor.currentRuntime, "Reviewed current runtime differs from its existing session");
  const observedBefore = await verifyObservedRuntime(descriptor.currentRuntime);
  // Derive context from the verified response, never merely from the descriptor.
  const context = trustedInstallationContextFromRootKey(Buffer.from(observedBefore.rootKeyBase64, "base64"));
  const installationNetworkIdHex = trustedInstallationNetworkIdHex(context);
  const fingerprintBefore = await compilerSourceFingerprint(root);
  const cacheDirectory = path.join(root, ".neutron/cache/compiled");
  const cacheKey = compiledActorCacheKey({
    target: "local", compilerFingerprint: fingerprintBefore,
    packageArchiveSha256: descriptor.archives.map(item => item.sha256), installationNetworkIdHex,
  });
  const cacheEntryDirectory = path.join(cacheDirectory, "v3", cacheKey);
  await mkdir(path.dirname(descriptor.evidenceDirectory), { recursive: true, mode: 0o700 });
  assert.equal(await realpath(path.dirname(descriptor.evidenceDirectory)), path.dirname(descriptor.evidenceDirectory));
  await mkdir(descriptor.evidenceDirectory, { mode: 0o700 }); // never overwrite an earlier attempt
  const cacheLog: string[] = [];
  const common = {
    scope: "compile_cache_prewarm_not_deployment", descriptorSha256: sha256(descriptorBytes),
    configPath, configFileSha256: sha256(configBytes), configSha256: config.configSha256,
    archives: descriptor.archives, observedBefore, installationNetworkIdHex,
    compilerFingerprintBefore: fingerprintBefore, cacheKey, cacheEntryDirectory,
    journalBefore: { path: journalPath, sha256: sha256(journalBytes) },
    freshJournalBefore: { path: config.sessionPath, exists: false },
    limitations: [
      "No canister or app was installed by this helper; compiler deploymentId is an artifact identifier only.",
      "Future runtime must independently verify its actual root key and derive its network ID before cache use.",
      "Pre/post compiler fingerprints detect persistent edits, not an immutable source snapshot; keep compiler inputs fixed while compiling.",
    ],
  };
  await evidence(descriptor.evidenceDirectory, "started.json", { ...common, startedAt: new Date().toISOString() });
  let fingerprintAfter: string | undefined;
  try {
    const prepared = await prepareDeployment(packagePaths, {
      target: "local", expectedArtifacts: descriptor.archives, freshInstallationContext: context,
      localCompileCache: {
        directory: cacheDirectory, compilerFingerprint: fingerprintBefore, installationNetworkIdHex,
        logger: { log: (...items: unknown[]) => { const message = items.map(String).join(" "); cacheLog.push(message); console.log(message); } },
      },
    });
    assertPreparedDeploymentMatchesExpectedArtifacts(prepared, descriptor.archives);
    fingerprintAfter = await compilerSourceFingerprint(root);
    assert.equal(fingerprintAfter, fingerprintBefore, "Compiler source changed during prewarm; this cache entry is unqualified and needs inspection");
    assert.deepEqual(await readFile(configPath), configBytes, "Config changed during prewarm");
    await inspectPinnedPackageArchives(descriptor.archives);
    const observedAfter = await verifyObservedRuntime(descriptor.currentRuntime);
    assert.deepEqual(observedAfter, observedBefore, "Verified runtime identity changed during prewarm");
    assert.deepEqual(await readFile(journalPath), journalBytes, "Current provision journal changed during prewarm");
    assert.equal(await optionalFile(config.sessionPath), null, "Fresh provision journal appeared during prewarm");
    const metadataBytes = await readFile(path.join(cacheEntryDirectory, "metadata.json"));
    const metadata = JSON.parse(metadataBytes.toString("utf8"));
    assert.equal(metadata.format, 3);
    assert.equal(metadata.cacheKey, cacheKey);
    assert.equal(metadata.target, "local");
    assert.equal(metadata.compilerFingerprint, fingerprintBefore);
    assert.equal(metadata.installationNetworkIdHex, installationNetworkIdHex);
    assert.deepEqual(metadata.packageArchiveSha256, descriptor.archives.map(item => item.sha256));
    assert.equal(metadata.compilerId, prepared.compiled.compilerId);
    assert.equal(metadata.assemblerId, prepared.compiled.assemblerId);
    assert.equal(metadata.deploymentId, prepared.compiled.deploymentId);
    const outputs = [
      { kind: "wasm", file: "neutron.wasm", sha256: prepared.rawWasmSha256, bytes: prepared.compiled.wasm.byteLength },
      { kind: "candid", file: "neutron.did", sha256: prepared.candidSha256, bytes: Buffer.byteLength(prepared.compiled.candid) },
      { kind: "stable", file: "neutron.most", sha256: prepared.stableSha256, bytes: Buffer.byteLength(prepared.compiled.stable) },
    ];
    for (const output of outputs) {
      const bytes = await readFile(path.join(cacheEntryDirectory, output.file));
      assert.equal(bytes.byteLength, output.bytes);
      assert.equal(sha256(bytes), output.sha256);
      assert.deepEqual(metadata[output.kind], { file: output.file, bytes: output.bytes, sha256: output.sha256 });
    }
    const receiptPath = path.join(descriptor.evidenceDirectory, "completed-prewarm.json");
    await evidence(descriptor.evidenceDirectory, "completed-prewarm.json", {
      ...common, completedAt: new Date().toISOString(), compilerFingerprintAfter: fingerprintAfter,
      observedAfter, journalUnchanged: true, freshJournalStillAbsent: true, cacheLog,
      cacheMetadata: { path: path.join(cacheEntryDirectory, "metadata.json"), sha256: sha256(metadataBytes), bytes: metadataBytes.byteLength },
      compiledArtifact: { compilerId: prepared.compiled.compilerId, assemblerId: prepared.compiled.assemblerId,
        artifactDeploymentId: prepared.compiled.deploymentId, browserSurfaceOriginAppIds: prepared.compiled.browserSurfaceOriginAppIds,
        outputs, transportWasm: { bytes: prepared.transportWasm.byteLength, sha256: prepared.transportWasmSha256 }, wasmMetadata: prepared.wasmMetadata },
    });
    return receiptPath;
  } catch (error) {
    await evidence(descriptor.evidenceDirectory, "failed-prewarm.json", {
      ...common, failedAt: new Date().toISOString(), compilerFingerprintAfter: fingerprintAfter,
      cacheLog, qualified: false, failure: error instanceof Error ? error.message : String(error),
      cacheDisposition: "Preserved for inspection; this attempt does not qualify the entry for deployment.",
    });
    throw error;
  }
}

async function verifyObservedRuntime(runtime: PocketIcRuntimeDescriptor) {
  const executable = await readlink(`/proc/${runtime.pid}/exe`);
  const actualBinarySha256 = sha256(await readFile(`/proc/${runtime.pid}/exe`));
  assert.equal(actualBinarySha256, POCKETIC_SHA256, "Running executable differs from the pinned PocketIC 14 binary");
  await assertLoopbackListenerOwner(runtime.pid, Number(new URL(runtime.controlUrl).port));
  await assertLoopbackListenerOwner(runtime.pid, runtime.gateway.port);
  const attachment = await verifyPocketIcRuntime(runtime, { expectedBinarySha256: POCKETIC_SHA256 });
  const response = await fetch(new URL("http_gateway", runtime.controlUrl), { signal: AbortSignal.timeout(10_000), redirect: "error" });
  assert(response.ok, "Current runtime gateway listing failed");
  const gateways = await response.json() as Array<{ instance_id: number; port: number; forward_to: { PocketIcInstance: number } }>;
  const gateway = gateways.filter(item => item.port === runtime.gateway.port);
  assert.equal(gateway.length, 1);
  assert.equal(gateway[0]!.instance_id, runtime.gateway.id);
  assert.equal(gateway[0]!.forward_to.PocketIcInstance, runtime.instanceId);
  return {
    pid: runtime.pid, processIdentity: runtime.processIdentity, executable, actualBinarySha256,
    controlUrl: runtime.controlUrl, instanceId: runtime.instanceId, stateDirectory: runtime.stateDirectory,
    topology: runtime.topology, autoProgressVerified: true, gateway: runtime.gateway,
    rootKeyBase64: attachment.gatewayStatus.rootKeyBase64,
    rootKeySha256: sha256(Buffer.from(attachment.gatewayStatus.rootKeyBase64, "base64")),
  };
}

async function assertLoopbackListenerOwner(pid: number, port: number): Promise<void> {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const address = `0100007F:${portHex}`;
  const conflicting = new Set([address, `00000000:${portHex}`, `00000000000000000000000000000000:${portHex}`]);
  const listeners: string[][] = [];
  for (const filename of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (await readFile(filename, "utf8")).trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields[3] === "0A" && conflicting.has(fields[1]!)) listeners.push(fields);
    }
  }
  assert.equal(listeners.length, 1, `Expected one local IPv4 listener on ${port}`);
  assert.equal(listeners[0]![1], address);
  const socket = `socket:[${listeners[0]![9]}]`;
  const links = await Promise.all((await readdir(`/proc/${pid}/fd`)).map(async fd => {
    try { return await readlink(`/proc/${pid}/fd/${fd}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }));
  assert(links.includes(socket), `Listener ${port} is not owned by the reviewed current runtime PID`);
}

async function optionalFile(filename: string): Promise<Buffer | null> {
  try { const stat = await lstat(filename); assert(stat.isFile() && !stat.isSymbolicLink()); return await readFile(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function evidence(directory: string, filename: string, value: unknown): Promise<void> {
  await writeFile(path.join(directory, filename), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

if (import.meta.main) {
  const [action, descriptorPath, ...extra] = process.argv.slice(2);
  assert(action === "prewarm" && descriptorPath && extra.length === 0, "Usage: bun ...evm-wallet-erc20-prewarm.ts prewarm <reviewed-descriptor.json>");
  console.log(await prewarmErc20CompileCache(descriptorPath));
}
