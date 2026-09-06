import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePackageInstall } from "neutron-compiler/src/install.js";
import { prepareDeployment } from "../../../packages/neutron-provision/src/artifact.ts";
import { loadNdeployConfig, resolveLocalPackagePaths } from "../../../packages/neutron-provision/src/config.ts";
import { LocalProvisionClient } from "../../../packages/neutron-provision/src/local_client.ts";
import { runLocalReinstall } from "../../../packages/neutron-provision/src/local_deploy.ts";
import { localRuntimePaths, startLocalServer } from "../../../packages/neutron-provision/src/local_server.ts";
import { PocketIcRestClient, type PocketIcTopology } from "../../../packages/neutron-provision/src/pocketic_rest.ts";
import { nodePocketIcProcessHost, readLivePocketIcSupervisorOwner, servePocketIc, verifyPocketIcRuntime, type PocketIcServeHandle, type PocketIcRuntimeDescriptor } from "../../../packages/neutron-provision/src/pocketic_supervisor.ts";
import { readSession, type ProvisionJournal } from "../../../packages/neutron-provision/src/session.ts";
import { ensureErc20PocketIcFixtures, fundErc20PocketIcFixtures } from "./ic-wallet-erc20-provision.ts";

/**
 * Bun-only, opt-in ERC20 protocol fixture lifecycle. Importing runs no actions.
 * The ordinary isolated qualification must finish and restore PID1276378's
 * original gateway before `serve`. This wrapper borrows only that gateway;
 * retained instances, process, state and automatic progress remain untouched.
 *
 * bun test/e2e/fixtures/evm-wallet-erc20-runtime.ts serve <config> <retained-baseline>
 * bun test/e2e/fixtures/evm-wallet-erc20-runtime.ts deploy <config>
 *
 * `serve` requires a completely new state directory and journal. `deploy` is
 * first-install-only, even though the underlying provision API is named
 * runLocalReinstall. Existing app/ledger canisters are never reinstalled.
 * SIGINT/SIGTERM of this serve wrapper stops its own fresh runtime and restores
 * the previously observed gateway. Data remains on disk for inspection.
 * configureFreshErc20Protocol is a separate, explicitly coordinated Ethereum
 * setup step owned by the IC fixture; it is intentionally not called here.
 */
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RETAINED_PID = 1_276_378;
const POCKETIC_SHA256 = "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4";
export type Erc20RuntimeOptions = { configPath: string; repositoryRoot?: string };
export type Erc20RuntimeServeOptions = Erc20RuntimeOptions & { retainedBaselinePath: string; signal?: AbortSignal };
type Gateway = { instance_id: number; port: number; forward_to: { PocketIcInstance: number }; domains: null; https_config: null };
type RetainedBaseline = {
  pid: number; pidIdentity: string; binarySha256: string; controlUrl: string;
  topology: PocketIcTopology; autoProgress: boolean;
  gatewayStatus: { rootKeyBase64: string; replicaHealthStatus: string };
};
type ServeOwner = {
  schema: "neutron-erc20-fixture-serve-v1";
  wrapperPid: number; wrapperIdentity: string; configPath: string; configSha256: string;
  sessionPath: string; stateDirectory: string; descriptor: PocketIcRuntimeDescriptor;
};

export function erc20RuntimePaths(options: Erc20RuntimeOptions) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const configPath = path.resolve(repositoryRoot, options.configPath);
  assert.equal(configPath, path.join(repositoryRoot, "evm-wallet-erc20-local.ndeploy.json"), "ERC20 runtime requires its dedicated explicit config");
  const evidence = path.join(repositoryRoot, ".neutron/release-receipts/evm-wallet-completion-2026-09-06/erc20-runtime");
  return {
    repositoryRoot, configPath, evidence,
    stateDirectory: path.join(repositoryRoot, ".neutron/evm-wallet-erc20-pocketic"),
    serveOwner: path.join(evidence, "serve-owner.json"),
    serveLock: path.join(evidence, "serve.lock"), deployLock: path.join(evidence, "deploy.lock"),
  };
}

/** Pure precondition used again while the provisioner's session lock is held. */
export function assertErc20FirstDeployment(journal: ProvisionJournal | null, stateDirectory: string, configSha256: string): asserts journal is ProvisionJournal {
  assert(journal && journal.runtime.kind === "pocketic", "Fresh ERC20 server journal is missing");
  assert.equal(journal.runtime.stateDirectory, stateDirectory);
  assert.equal(journal.runtime.profile, "full_protocol_fixtures");
  assert.equal(journal.configSha256, configSha256, "Config changed after the ERC20 server was started");
  assert(!journal.current && !journal.origin && !journal.adoption && !journal.active && !journal.localFleet,
    "ERC20 deploy is first-install-only; retain and inspect every existing deployment or partial attempt");
}

/** Explicit lifecycle action. Resolves only after shutdown and restoration. */
export async function serveErc20QualificationRuntime(options: Erc20RuntimeServeOptions): Promise<void> {
  const paths = erc20RuntimePaths(options);
  const config = await checkedConfig(paths);
  const packagePins = await selectedPackagePins(config);
  assert(await missing(paths.stateDirectory), "ERC20 state already exists; it must be preserved, never reset or silently reused");
  assert(await missing(config.sessionPath), "ERC20 session already exists; it must be preserved, never replaced");
  const supervisorPath = localRuntimePaths(paths.stateDirectory).supervisorLockPath;
  assert.equal(await readLivePocketIcSupervisorOwner(supervisorPath), null, "Another isolated PocketIC supervisor is still active");
  const previousQualification = await readSession(path.join(paths.repositoryRoot, "evm-wallet-local.ndeploy.session.json"));
  if (previousQualification?.runtime.kind === "pocketic") {
    assert.notEqual(await nodePocketIcProcessHost.processIdentity(previousQualification.runtime.pid),
      previousQualification.runtime.processIdentity, "The previous isolated qualification runtime must stop before ERC20 qualification");
  }
  const baseline = await readRetainedBaseline(options.retainedBaselinePath);
  const retained = new PocketIcRestClient(baseline.controlUrl);
  await verifyRetained(baseline, retained);
  const gateways = await gatewayList(baseline.controlUrl);
  assert.equal(gateways.length, 1, "Original gateway must be restored before ERC20 qualification");
  const original = gateways[0]!;
  assert.equal(original.port, 8000);
  assert.equal(original.forward_to.PocketIcInstance, 0);
  assert.equal(original.domains, null);
  assert.equal(original.https_config, null);
  await assertGatewayListenerPid(baseline.pid);
  assert.equal((await retained.gatewayStatus()).rootKeyBase64, baseline.gatewayStatus.rootKeyBase64);
  const restoration = { forward_to: original.forward_to, port: 8000, ip_addr: "127.0.0.1", domains: null, https_config: null, domain_custom_provider_local_file: null };
  await mkdir(paths.evidence, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(paths.evidence), paths.evidence);
  await withTaskLock(paths.serveLock, async () => {
    assert(await missing(paths.stateDirectory) && await missing(config.sessionPath), "Fresh ERC20 state/session changed while acquiring lifecycle ownership");
    await writeEvidence(path.join(paths.evidence, "retained-before.json"), {
      observedAt: new Date().toISOString(), ...baseline, gateways, restoration,
      wrapperPid: process.pid, wrapperIdentity: await nodePocketIcProcessHost.processIdentity(process.pid),
      configPath: paths.configPath, configSha256: config.configSha256, packagePins,
    }, true);
    let borrowAttempted = false;
    let owned: PocketIcServeHandle | undefined;
    let stopping = options.signal?.aborted ?? false;
    let startupComplete = false;
    let stopPromise: Promise<void> | undefined;
    const requestStop = () => {
      stopping = true;
      if (startupComplete && owned && !stopPromise) stopPromise = owned.stop();
      // Preserve any failure for the awaited cleanup boundary.
      void stopPromise?.catch(() => undefined);
    };
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
    options.signal?.addEventListener("abort", requestStop, { once: true });
    const failures: unknown[] = [];
    try {
      if (stopping) return;
      await verifyRetained(baseline, retained);
      await assertGatewayListenerPid(baseline.pid);
      await writeEvidence(path.join(paths.evidence, "gateway-borrow-intent.json"), {
        at: new Date().toISOString(), retainedPid: baseline.pid, actualGatewayId: original.instance_id,
        retainedInstanceId: 0, restoration, stateDirectory: paths.stateDirectory,
      }, true);
      // Mark before awaiting: a lost stop response must still reconcile the
      // actual gateway and restore it in finally.
      borrowAttempted = true;
      await retained.stopGateway(original.instance_id);
      const handle = await startLocalServer({
        profile: config.target.profile, configSha256: config.configSha256,
        sessionPath: config.sessionPath, stateDirectory: paths.stateDirectory,
      }, {
        ensureFixtures: ensureErc20PocketIcFixtures,
        readSupervisorOwner: async lock => {
          assert.equal(await readLivePocketIcSupervisorOwner(lock), null, "Another supervisor appeared before fresh ERC20 creation");
          return null;
        },
        serve: async input => {
          assert.equal(input.previousDescriptor, undefined, "Fresh ERC20 serve must never attach or replace an existing runtime");
          assert.equal(input.stateDirectory, paths.stateDirectory);
          owned = await servePocketIc(input);
          assert.notEqual(owned.descriptor.pid, baseline.pid);
          return owned;
        },
      });
      assert(owned, "Fresh runtime has no owned lifecycle handle");
      startupComplete = true;
      await verifyRetained(baseline, retained);
      await assertGatewayListenerPid(handle.descriptor.pid);
      const wrapperIdentity = await nodePocketIcProcessHost.processIdentity(process.pid);
      assert(wrapperIdentity);
      const owner: ServeOwner = {
        schema: "neutron-erc20-fixture-serve-v1", wrapperPid: process.pid, wrapperIdentity,
        configPath: paths.configPath, configSha256: config.configSha256,
        sessionPath: config.sessionPath, stateDirectory: paths.stateDirectory, descriptor: handle.descriptor,
      };
      await writeEvidence(paths.serveOwner, owner, true);
      await writeEvidence(path.join(paths.evidence, "ready.json"), { readyAt: new Date().toISOString(), ...owner, packagePins }, true);
      console.log("FRESH_ERC20_PROTOCOL_RUNTIME_READY");
      if (stopping) requestStop();
      else await handle.wait();
    } catch (error) { failures.push(error); }
    finally {
      process.off("SIGINT", requestStop);
      process.off("SIGTERM", requestStop);
      options.signal?.removeEventListener("abort", requestStop);
      if (owned) {
        try {
          assert.notEqual(owned.descriptor.pid, baseline.pid);
          assert.equal(owned.descriptor.stateDirectory, paths.stateDirectory);
          await (stopPromise ?? owned.stop());
        } catch (error) { failures.push(error); }
      }
      if (borrowAttempted) {
        try {
          await verifyRetained(baseline, retained);
          const current = await gatewayList(baseline.controlUrl);
          let restorationResponse: unknown = { unchanged: true };
          if (current.length === 0) {
            assert.equal((await loopback8000Listeners()).length, 0, "Port8000 remains occupied; no unrelated process will be stopped");
            restorationResponse = await gatewayRequest(baseline.controlUrl, "http_gateway", restoration);
          } else {
            assert.equal(current.length, 1);
            assert.equal(current[0]!.port, 8000);
            assert.equal(current[0]!.forward_to.PocketIcInstance, 0);
          }
          await assertGatewayListenerPid(baseline.pid);
          const status = await retained.gatewayStatus();
          assert.equal(status.rootKeyBase64, baseline.gatewayStatus.rootKeyBase64);
          await verifyRetained(baseline, retained);
          await writeEvidence(path.join(paths.evidence, "retained-restored.json"), {
            restoredAt: new Date().toISOString(), retainedPid: baseline.pid, retainedInstanceId: 0,
            gateways: await gatewayList(baseline.controlUrl), restorationResponse, status, autoProgress: true,
          });
          console.log("RETAINED_ORIGINAL_GATEWAY_RESTORED");
        } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, "ERC20 runtime lifecycle needs inspection; all retained data was left intact");
  });
}

/** First-created application canister only; never permits reinstall mode. */
export async function deployFirstErc20QualificationNode(options: Erc20RuntimeOptions) {
  const paths = erc20RuntimePaths(options);
  const config = await checkedConfig(paths);
  const packagePins = await selectedPackagePins(config);
  const owner = JSON.parse(await readFile(paths.serveOwner, "utf8")) as ServeOwner;
  assert.equal(owner.schema, "neutron-erc20-fixture-serve-v1");
  assert.equal(owner.configPath, paths.configPath);
  assert.equal(owner.configSha256, config.configSha256);
  assert.equal(owner.sessionPath, config.sessionPath);
  assert.equal(owner.stateDirectory, paths.stateDirectory);
  assert.equal(await nodePocketIcProcessHost.processIdentity(owner.wrapperPid), owner.wrapperIdentity, "ERC20 serve wrapper is not active");
  assert.notEqual(owner.descriptor.pid, RETAINED_PID);
  assert.equal(owner.descriptor.stateDirectory, paths.stateDirectory);
  await verifyPocketIcRuntime(owner.descriptor);
  await assertGatewayListenerPid(owner.descriptor.pid);
  return withTaskLock(paths.deployLock, async () => {
    assertErc20FirstDeployment(await readSession(config.sessionPath), paths.stateDirectory, config.configSha256);
    const packagePaths = await resolveLocalPackagePaths(config);
    const created = new Set<string>();
    const result = await runLocalReinstall({
      configSha256: config.configSha256, sessionPath: config.sessionPath,
      developerIdentitySeed: config.target.developerIdentitySeed,
      nodeLabels: config.target.nodeLabels, authorizedPrincipals: config.target.authorizedPrincipals,
      packagePaths, repositoryRoot: paths.repositoryRoot,
      compileCacheDirectory: path.join(paths.repositoryRoot, ".neutron/cache/compiled"), profile: config.target.profile,
    }, {
      fundFixtures: fundErc20PocketIcFixtures,
      prepare: async (archives, compileOptions) => {
        // This hook runs while runLocalReinstall owns its session lock and
        // before it records a new local transaction. Recheck first-use there.
        assertErc20FirstDeployment(await readSession(config.sessionPath), paths.stateDirectory, config.configSha256);
        const deployment = await prepareDeployment(archives, compileOptions);
        assert.equal(deployment.packageArchives.length, packagePins.length);
        for (const [index, archive] of deployment.packageArchives.entries()) {
          assert.equal(sha256(archive), packagePins[index]!.sha256, "Selected package bytes changed before first deployment");
          assert.equal(archive.length, packagePins[index]!.size);
        }
        return deployment;
      },
      createClient: async input => {
        assert.equal(input.controlUrl, owner.descriptor.controlUrl);
        assert.equal(input.instanceId, owner.descriptor.instanceId);
        assert.equal(input.expectedRootKeyBase64, owner.descriptor.rootKeyBase64);
        const client = await LocalProvisionClient.create(input);
        const own = (id: string) => assert(created.has(id), "Refusing to modify any previously existing application canister");
        return {
          async createCanister() { assert.equal(created.size, 0, "This fixture creates exactly one first-use Neutron"); const id = await client.createCanister(); created.add(id); return id; },
          async operationalState(id) { own(id); return client.operationalState(id); },
          async ensureSelfController(id) { own(id); return client.ensureSelfController(id); },
          async installDeployment(request) {
            own(request.canisterId);
            assert.equal(request.mode, "install", "ERC20 fixture must never reinstall an existing canister");
            assert.equal((await client.operationalState(request.canisterId)).moduleHash, null, "Fresh target already contains a module");
            return client.installDeployment(request);
          },
          kernelActor(id) { own(id); return client.kernelActor(id); },
          async authorizeFreshPrincipals(id, principals) { own(id); return client.authorizeFreshPrincipals(id, principals); },
          async verifyAuthorizedPrincipals(id, principals) { own(id); return client.verifyAuthorizedPrincipals(id, principals); },
        };
      },
    });
    assert.equal(created.size, 1);
    assert(created.has(result.canisterId));
    await writeEvidence(path.join(paths.evidence, "first-deployment.json"), {
      completedAt: new Date().toISOString(), configPath: paths.configPath, configSha256: config.configSha256,
      packagePins, node: { canisterId: result.canisterId, url: result.url }, nodes: result.nodes,
      sessionPath: config.sessionPath, sessionSha256: sha256(await readFile(config.sessionPath)),
      deploymentId: result.deployment.compiled.deploymentId, firstCreatedCanisterOnly: true, reinstallPermitted: false,
    }, true);
    console.log(JSON.stringify({ firstDeployment: true, canisterId: result.canisterId, url: result.url }));
    return result;
  });
}

async function checkedConfig(paths: ReturnType<typeof erc20RuntimePaths>) {
  assert.equal(await realpath(paths.repositoryRoot), paths.repositoryRoot);
  const config = await loadNdeployConfig(paths.configPath);
  assert(config.target.kind === "pocketic" && config.target.profile === "full_protocol_fixtures", "ERC20 qualification needs full protocol fixtures");
  assert.equal(config.target.nodeLabels.length, 1, "ERC20 qualification config must select one fresh node");
  return { ...config, target: config.target };
}
async function selectedPackagePins(config: Awaited<ReturnType<typeof checkedConfig>>) {
  const pins = [];
  for (const filename of await resolveLocalPackagePaths(config)) {
    const bytes = await readFile(filename);
    const prepared = preparePackageInstall(bytes);
    pins.push({ path: filename, id: prepared.manifest.id, version: prepared.manifest.version, size: bytes.length, sha256: sha256(bytes) });
  }
  for (const id of ["kernel", "wallet", "evm_wallet", "kitchensink", "uniswap"]) assert(pins.some(pin => pin.id === id), `ERC20 config lacks ${id}`);
  return pins;
}
async function readRetainedBaseline(filename: string): Promise<RetainedBaseline> {
  const baseline = JSON.parse(await readFile(filename, "utf8")) as RetainedBaseline;
  assert.equal(baseline.pid, RETAINED_PID);
  assert.equal(baseline.pidIdentity, "linux:1276378:87571866");
  assert.equal(baseline.binarySha256, POCKETIC_SHA256);
  assert.equal(baseline.controlUrl, "http://127.0.0.1:39591/");
  assert.equal(baseline.autoProgress, true);
  assert(baseline.topology && baseline.gatewayStatus.rootKeyBase64);
  return baseline;
}
async function verifyRetained(baseline: RetainedBaseline, client: PocketIcRestClient): Promise<void> {
  assert.equal(await nodePocketIcProcessHost.processIdentity(baseline.pid), baseline.pidIdentity);
  assert.equal(sha256(await readFile(`/proc/${baseline.pid}/exe`)), baseline.binarySha256);
  assert.deepEqual(await client.readTopology(0, "minimal"), baseline.topology);
  assert.equal(await client.isAutoProgressEnabled(0), true);
}
async function gatewayList(controlUrl: string): Promise<Gateway[]> {
  const value = await gatewayRequest(controlUrl, "http_gateway");
  assert(Array.isArray(value));
  return value as Gateway[];
}
async function gatewayRequest(controlUrl: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(route, controlUrl), {
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Retained gateway ${route} failed: HTTP${response.status}`);
  return response.json();
}
async function loopback8000Listeners() {
  const listeners: Array<{ address: string; inode: string }> = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (await readFile(file, "utf8")).trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields[3] === "0A" && ["0100007F:1F40", "00000000:1F40", "00000000000000000000000000000000:1F40"].includes(fields[1] ?? "")) {
        listeners.push({ address: fields[1]!, inode: fields[9]! });
      }
    }
  }
  return listeners;
}
async function assertGatewayListenerPid(pid: number): Promise<void> {
  const listeners = await loopback8000Listeners();
  assert.equal(listeners.length, 1, "Expected one IPv4 loopback8000 gateway");
  assert.equal(listeners[0]!.address, "0100007F:1F40");
  const expected = `socket:[${listeners[0]!.inode}]`;
  const links = await Promise.all((await readdir(`/proc/${pid}/fd`)).map(async fd => {
    try { return await readlink(`/proc/${pid}/fd/${fd}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }));
  assert(links.includes(expected), "Gateway8000 does not belong to the expected runtime PID");
}
async function withTaskLock<T>(filename: string, action: () => Promise<T>): Promise<T> {
  const token = randomBytes(16).toString("hex");
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, identity: await nodePocketIcProcessHost.processIdentity(process.pid), token }));
    await handle.close();
    return await action();
  } finally {
    await handle.close();
    const owner = JSON.parse(await readFile(filename, "utf8")) as { token?: unknown };
    assert.equal(owner.token, token, "ERC20 lifecycle lock ownership changed");
    await unlink(filename);
  }
}
async function writeEvidence(filename: string, value: unknown, firstOnly = false): Promise<void> {
  if (firstOnly) assert(await missing(filename), "Existing lifecycle evidence must be preserved");
  const temporary = `${filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, filename);
}
async function missing(filename: string): Promise<boolean> {
  try { await lstat(filename); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

if (import.meta.main) {
  const [action, configPath, retainedBaselinePath, ...extra] = process.argv.slice(2);
  assert(configPath && extra.length === 0, "Usage: ...erc20-runtime.ts serve <config> <retained-baseline> | deploy <config>");
  if (action === "serve") {
    assert(retainedBaselinePath, "Serve requires the explicit recorded retained-runtime baseline");
    await serveErc20QualificationRuntime({ configPath, retainedBaselinePath });
  } else {
    assert(action === "deploy" && retainedBaselinePath === undefined, "Deploy takes only the explicit fresh config");
    await deployFirstErc20QualificationNode({ configPath });
  }
}
