/**
 * Stateful release qualification for the immutable v0.3.5, v0.3.6, and
 * v0.3.7 predecessor Kernels.
 *
 * This is opt-in because it launches the pinned 113 MB PocketIC binary and
 * performs hundreds of real ingress calls. Run it with:
 *
 *   NEUTRON_RUN_LEGACY_UPGRADE_POCKETIC=1 \
 *   NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 *   bun test packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts
 *
 * Qualify non-reuse across a real management snapshot restore with:
 *
 *   NEUTRON_RUN_BROWSER_ORIGIN_SNAPSHOT_POCKETIC=1 \
 *   NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 *   bun test packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts
 *
 * After the reviewed current Kernel archive exists, qualify those exact bytes
 * with:
 *
 *   NEUTRON_RUN_FINAL_KERNEL_CANDIDATE_POCKETIC=1 \
 *   NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256=<reviewed-lowercase-sha256> \
 *   NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 *   bun test packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts
 *
 * The runner owns a new temporary PocketIC state directory, initially installs
 * each supported predecessor, and then exercises only Neutron's checked
 * in-product upgrade transaction. It never invokes the provisioner's
 * reinstall path.
 *
 * This qualifies the current compiler/install client against the released
 * actors. It deliberately does not claim to exercise either old packaged
 * browser UI, file picker, IndexedDB state, or reload behavior; those remain
 * manual production-candidate checks in real predecessor browser sessions.
 */
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  cp,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import msgpack from "tiny-msgpack";
import { prepareDeterministicWasmTransport } from "../src/deployment_record.ts";
import { supportsBrowserSurfaceOrigins } from "../src/assemble.ts";
import {
  assertKernelPackageStateMatchesRuntime,
  buildPackagesInstallAssets,
  compileAndDeployPreparedPackages,
  compileFreshPackages,
  compilePackages,
  deployPreparedPackages,
  motokoFilesFromPreparedFiles,
  prepareCompleteDeploymentBuildRecord,
  preparePackageInstall,
  readKernelPackageState,
  recoverPendingInstall,
  uninstallApp,
  type AppInstance,
  type CompileResult,
  type DeployPreparedPackagesResult,
  type InstallStagedAsset,
  type KernelPackageState,
  type PreparedPackageInstall,
  type UnpackedNeutronPackage,
} from "../src/install.ts";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX,
  NEUTRON_PACKAGE_RECORD_PATH,
} from "neutron-tools/src/package_record.js";
import { assertSupportedCertificateVersions } from "neutron-tools/src/wasm_metadata.js";
import {
  LEGACY_KERNEL_RELEASES,
  PRODUCTION_KERNEL_V323_RELEASE,
  RETAINED_KERNEL_V321_RELEASE,
  assertLegacyUpgradeCompileInvariants,
  compileFinalCandidateLegacyKernelUpgradeFixture,
  compileFinalCandidateProductionKernelUpgradeFixture,
  compileFinalCandidateRetainedKernelUpgradeFixture,
  compileLegacyKernelUpgradeFixture,
  type LegacyUpgradeCompileFixture,
} from "./legacy_kernel_upgrade_fixture.ts";

const RUN = process.env.NEUTRON_RUN_LEGACY_UPGRADE_POCKETIC === "1";
const pocketIcTest = RUN ? test : test.skip;
const RUN_FINAL_CANDIDATE =
  process.env.NEUTRON_RUN_FINAL_KERNEL_CANDIDATE_POCKETIC === "1";
const finalCandidateTest = RUN_FINAL_CANDIDATE ? test : test.skip;
const RUN_BROWSER_ORIGIN_SNAPSHOT =
  process.env.NEUTRON_RUN_BROWSER_ORIGIN_SNAPSHOT_POCKETIC === "1";
const browserOriginSnapshotTest = RUN_BROWSER_ORIGIN_SNAPSHOT
  ? test
  : test.skip;
const PINNED_POCKET_IC_SHA256 =
  "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const execFile = promisify(execFileCallback);

type DirectPocketIcClient = {
  deleteInstance(instanceId: number): Promise<void>;
  queryCanister(
    instanceId: number,
    call: DirectCanisterCall,
  ): Promise<Uint8Array>;
  submitIngressMessage(
    instanceId: number,
    call: DirectCanisterCall,
  ): Promise<unknown>;
  awaitIngressMessage(
    instanceId: number,
    message: unknown,
  ): Promise<Uint8Array>;
};

type DirectCanisterCall = {
  sender: Principal;
  canisterId: Principal;
  method: string;
  payload: Uint8Array;
  effectivePrincipal?: { CanisterId: string };
};

type ObservedInstallDispatch = {
  inline?: Uint8Array;
  chunks: Array<{ content: Uint8Array; sha256: Uint8Array }>;
  chunkHashes?: Uint8Array[];
  moduleHash?: Uint8Array;
};

function observeInstallDispatch(
  actor: any,
  observed: ObservedInstallDispatch,
): any {
  return new Proxy(actor, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (property === "kernel_install_code") {
        return async (request: { wasm: Uint8Array }) => {
          observed.inline = Uint8Array.from(request.wasm);
          return Reflect.apply(original, target, [request]);
        };
      }
      if (property === "kernel_install_wasm_chunk") {
        return async (request: { chunk: Uint8Array; sha256: Uint8Array }) => {
          observed.chunks.push({
            content: Uint8Array.from(request.chunk),
            sha256: Uint8Array.from(request.sha256),
          });
          return Reflect.apply(original, target, [request]);
        };
      }
      if (property === "kernel_install_code_chunked") {
        return async (request: {
          chunk_hashes: Uint8Array[];
          wasm_module_hash: Uint8Array;
        }) => {
          observed.chunkHashes = request.chunk_hashes.map((hash) =>
            Uint8Array.from(hash),
          );
          observed.moduleHash = Uint8Array.from(request.wasm_module_hash);
          return Reflect.apply(original, target, [request]);
        };
      }
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
}

type PausedInstallDispatch = Readonly<{
  actor: any;
  reached: Promise<void>;
  release(): void;
  captured():
    | Readonly<{ kind: "inline"; request: any }>
    | Readonly<{
        kind: "chunked";
        chunks: readonly any[];
        request: any;
      }>;
}>;

function pauseInstallDispatch(actor: any): PausedInstallDispatch {
  let resolveReached!: () => void;
  let resolveRelease!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let intercepted = false;
  let inlineRequest: any;
  let chunkedRequest: any;
  const chunks: any[] = [];

  return {
    actor: new Proxy(actor, {
      get(target, property, receiver) {
        const original = Reflect.get(target, property, receiver);
        if (property === "kernel_install_wasm_chunk") {
          return async (request: any) => {
            chunks.push(structuredClone(request));
            return Reflect.apply(original, target, [request]);
          };
        }
        if (
          property === "kernel_install_code" ||
          property === "kernel_install_code_chunked"
        ) {
          return async (...args: unknown[]) => {
            if (intercepted) {
              throw new Error("Install dispatch pause was entered twice");
            }
            intercepted = true;
            if (property === "kernel_install_code") {
              inlineRequest = structuredClone(args[0]);
            } else {
              chunkedRequest = structuredClone(args[0]);
            }
            resolveReached();
            await released;
            return Reflect.apply(original, target, args);
          };
        }
        return typeof original === "function"
          ? original.bind(target)
          : original;
      },
    }),
    reached,
    release: resolveRelease,
    captured() {
      if (inlineRequest !== undefined && chunkedRequest === undefined) {
        return { kind: "inline", request: inlineRequest };
      }
      if (inlineRequest === undefined && chunkedRequest !== undefined) {
        return { kind: "chunked", chunks, request: chunkedRequest };
      }
      throw new Error("Paused install dispatch is unavailable or ambiguous");
    },
  };
}

async function resumeCapturedPendingInstall(
  actor: any,
  paused: PausedInstallDispatch,
  deploymentId: string,
): Promise<void> {
  const captured = paused.captured();
  if (captured.kind === "inline") {
    await actor.kernel_install_code(captured.request).catch(() => undefined);
  } else {
    await actor.kernel_install_wasm_chunks_clear({
      deployment_id: deploymentId,
    });
    for (const chunk of captured.chunks) {
      await actor.kernel_install_wasm_chunk(chunk);
    }
    await actor
      .kernel_install_code_chunked(captured.request)
      .catch(() => undefined);
  }
  expect(
    await recoverPendingInstall(actor, { timeoutMs: 120_000 }),
  ).toEqual({ status: "committed", deploymentId });
}

async function waitForPausedInstallDispatch<T>(
  paused: PausedInstallDispatch,
  deployment: Promise<T>,
): Promise<void> {
  await Promise.race([
    paused.reached,
    deployment.then(
      () => {
        throw new Error("Deployment completed before install dispatch paused");
      },
      (cause: unknown) => {
        throw cause;
      },
    ),
  ]);
}

function observedInstallTransport(
  observed: ObservedInstallDispatch,
): Uint8Array {
  if (observed.inline !== undefined) {
    if (observed.chunks.length !== 0 || observed.chunkHashes !== undefined) {
      throw new Error("Install dispatch mixed inline and chunked transport");
    }
    return observed.inline;
  }
  if (observed.chunkHashes === undefined || observed.moduleHash === undefined) {
    throw new Error("Install transport was not dispatched");
  }
  const contentByHash = new Map(
    observed.chunks.map(({ content, sha256: digest }) => [
      Buffer.from(digest).toString("hex"),
      content,
    ]),
  );
  const ordered = observed.chunkHashes.map((digest) => {
    const digestHex = Buffer.from(digest).toString("hex");
    const content = contentByHash.get(digestHex);
    if (content === undefined || sha256Hex(content) !== digestHex) {
      throw new Error(`Missing observed install chunk ${digestHex}`);
    }
    return content;
  });
  const transport = concatenateBytes(ordered);
  if (
    sha256Hex(transport) !== Buffer.from(observed.moduleHash).toString("hex")
  ) {
    throw new Error(
      "Observed chunked install module hash does not match bytes",
    );
  }
  return transport;
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

for (const release of LEGACY_KERNEL_RELEASES) {
  pocketIcTest(
    `generated v0.3.16 preserves durable state through the ${release.label} checked self-upgrade`,
    () =>
      runLegacyUpgradeQualification(() =>
        compileLegacyKernelUpgradeFixture(release.version),
      ),
    300_000,
  );

  finalCandidateTest(
    `the reviewed current Kernel archive preserves durable state through the ${release.label} checked self-upgrade`,
    () =>
      runLegacyUpgradeQualification(() =>
        compileFinalCandidateLegacyKernelUpgradeFixture({
          expectedSha256:
            process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
          legacyVersion: release.version,
        }),
      ),
    300_000,
  );
}

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the ${RETAINED_KERNEL_V321_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateRetainedKernelUpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V323_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelUpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

browserOriginSnapshotTest(
  "restored pre-begin and pending-dispatch branches never reuse browser origins",
  runBrowserOriginSnapshotQualification,
  900_000,
);

async function runBrowserOriginSnapshotQualification(): Promise<void> {
  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256Hex(new Uint8Array(await readFile(binary)))).toBe(
    PINNED_POCKET_IC_SHA256,
  );

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "neutron-browser-origin-snapshot-pocketic-"),
  );
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;

  try {
    const packages = await prepareBrowserOriginSnapshotPackages(temporaryRoot);
    const initialPackages = [
      packages.kernel.prepared,
      packages.authorityV100.prepared,
    ];
    const initial = await compileFreshPackages({ packages: initialPackages });

    const launched = await launchPocketIc(binary, temporaryRoot);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, {
      requestTimeoutMs: 120_000,
    }) as DirectPocketIcClient;
    const created = await createApplicationInstance(
      launched.controlUrl,
      path.join(temporaryRoot, "state"),
    );
    instanceId = created.instanceId;

    const deployer = testPrincipal(81);
    const direct = new DirectPocketIcCalls(client, instanceId);
    const canisterId = await direct.createCanister(
      deployer,
      created.defaultEffectiveCanisterId,
    );
    await direct.installInitial(canisterId, deployer, initial);
    await direct.setControllers(canisterId, deployer, [deployer, canisterId]);

    const actor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: deployer,
      client,
    });
    await provision.seedFreshKernel({
      actor,
      canisterId: canisterId.toText(),
      deployment: freshDeployment(
        [packages.kernel, packages.authorityV100],
        initial,
      ),
      concurrency: 32,
      logger: silentLogger,
    });

    const baselineState = freshPackageState(initialPackages, initial);
    const baselineRuntime = await actor.kernel_runtime_info();
    const baselineAuthority = requiredAppInstance(
      normalizeAppInstances(baselineRuntime.apps),
      "origin_authority",
    );
    expect(baselineAuthority.resident_frame_security).toBe(
      "credentialless_opaque_v1",
    );

    const snapshot = await direct.takeSnapshot(canisterId, deployer);

    const authorityBranch = await compileAndDeployPreparedPackages({
      actor,
      targetCanisterId: canisterId.toText(),
      packages: [packages.authorityV101.prepared],
      state: baselineState,
      expectedDeploymentId: initial.deploymentId,
      verifyTimeoutMs: 120_000,
    });
    const authorityState = advancePackageState(
      baselineState,
      [packages.authorityV101.prepared],
      authorityBranch,
    );
    const discardedAuthority = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "origin_authority",
    );
    expect(discardedAuthority.scope.installation_uid).toBe(
      baselineAuthority.scope.installation_uid,
    );
    expect(discardedAuthority.resident_frame_security).toBe(
      "credentialless_ephemeral_dedicated_v1",
    );
    expect(discardedAuthority.browser_origin_nonce).not.toBe(
      baselineAuthority.browser_origin_nonce,
    );

    const firstInstall = await compileAndDeployPreparedPackages({
      actor,
      targetCanisterId: canisterId.toText(),
      packages: [packages.hello.prepared],
      state: authorityState,
      expectedDeploymentId: authorityBranch.compiled.deploymentId,
      verifyTimeoutMs: 120_000,
    });
    const firstInstallState = advancePackageState(
      authorityState,
      [packages.hello.prepared],
      firstInstall,
    );
    const discardedFirstInstall = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "hello",
    );

    const uninstalled = await uninstallApp({
      actor,
      targetCanisterId: canisterId.toText(),
      state: firstInstallState,
      appId: "hello",
      expectedDeploymentId: firstInstall.compiled.deploymentId,
    });
    const uninstalledState = advancePackageState(
      firstInstallState,
      [],
      uninstalled,
      ["hello"],
    );
    expect(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps).some(
        ({ scope }) => scope.app_id === "hello",
      ),
    ).toBe(false);

    const reinstalled = await compileAndDeployPreparedPackages({
      actor,
      targetCanisterId: canisterId.toText(),
      packages: [packages.hello.prepared],
      state: uninstalledState,
      expectedDeploymentId: uninstalled.compiled.deploymentId,
      verifyTimeoutMs: 120_000,
    });
    const discardedReinstall = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "hello",
    );
    expect(discardedReinstall.scope.installation_uid).not.toBe(
      discardedFirstInstall.scope.installation_uid,
    );
    expect(discardedReinstall.browser_origin_nonce).not.toBe(
      discardedFirstInstall.browser_origin_nonce,
    );

    await direct.loadSnapshot(canisterId, deployer, snapshot.id);
    expect((await actor.kernel_runtime_info()).deployment_id).toBe(
      initial.deploymentId,
    );

    const restoredAuthorityBranch = await deployExactTransition({
      actor,
      canisterId,
      packages: [packages.authorityV101.prepared],
      state: baselineState,
      compiled: authorityBranch.compiled,
      expectedDeploymentId: initial.deploymentId,
    });
    const restoredAuthorityState = advancePackageState(
      baselineState,
      [packages.authorityV101.prepared],
      restoredAuthorityBranch,
    );
    const restoredAuthority = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "origin_authority",
    );
    expect(restoredAuthority.scope.installation_uid).toBe(
      baselineAuthority.scope.installation_uid,
    );
    expect(restoredAuthority.resident_frame_security).toBe(
      "credentialless_ephemeral_dedicated_v1",
    );
    expect(restoredAuthority.browser_origin_authority_epoch).not.toBe(
      discardedAuthority.browser_origin_authority_epoch,
    );
    expect(restoredAuthority.browser_origin_nonce).not.toBe(
      discardedAuthority.browser_origin_nonce,
    );
    expect(restoredAuthority.browser_origin_nonce).not.toBe(
      baselineAuthority.browser_origin_nonce,
    );

    const restoredInstallBranch = await deployExactTransition({
      actor,
      canisterId,
      packages: [packages.hello.prepared],
      state: restoredAuthorityState,
      compiled: firstInstall.compiled,
      expectedDeploymentId: authorityBranch.compiled.deploymentId,
    });
    const restoredInstall = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "hello",
    );
    expect(restoredInstall.scope.installation_uid).not.toBe(
      discardedFirstInstall.scope.installation_uid,
    );
    expect(restoredInstall.scope.installation_uid).not.toBe(
      discardedReinstall.scope.installation_uid,
    );
    expect(restoredInstall.browser_origin_nonce).not.toBe(
      discardedFirstInstall.browser_origin_nonce,
    );
    expect(restoredInstall.browser_origin_nonce).not.toBe(
      discardedReinstall.browser_origin_nonce,
    );

    const restoredFullState = advancePackageState(
      restoredAuthorityState,
      [packages.hello.prepared],
      restoredInstallBranch,
    );
    const paused = pauseInstallDispatch(actor);
    const pendingDeployment = compileAndDeployPreparedPackages({
      actor: paused.actor,
      targetCanisterId: canisterId.toText(),
      packages: [
        packages.authorityV102.prepared,
        packages.pendingOrigin.prepared,
      ],
      state: restoredFullState,
      expectedDeploymentId: restoredInstallBranch.compiled.deploymentId,
      verifyTimeoutMs: 120_000,
    });
    const pendingSnapshotState = await (async () => {
      try {
        // deployPreparedPackages awaits kernel_install_begin_checked before it
        // reaches either paused dispatch method. A present status therefore
        // proves the exact deployment journal is durable before the snapshot.
        await waitForPausedInstallDispatch(paused, pendingDeployment);
        const pendingStatus = await actor.kernel_install_status(null);
        expect(pendingStatus).not.toEqual([]);
        return {
          snapshot: await direct.takeSnapshot(canisterId, deployer),
          status: pendingStatus,
        };
      } finally {
        paused.release();
      }
    })();

    const discardedPendingBranch = await pendingDeployment;
    const discardedPendingApps = normalizeAppInstances(
      (await actor.kernel_runtime_info()).apps,
    );
    const discardedPendingAuthority = requiredAppInstance(
      discardedPendingApps,
      "origin_authority",
    );
    const discardedPendingInstall = requiredAppInstance(
      discardedPendingApps,
      "pending_origin",
    );
    expect(discardedPendingAuthority.scope.installation_uid).toBe(
      restoredAuthority.scope.installation_uid,
    );
    expect(discardedPendingAuthority.resident_frame_security).toBe(
      "credentialless_opaque_v1",
    );
    expect(discardedPendingAuthority.browser_origin_authority_epoch).not.toBe(
      restoredAuthority.browser_origin_authority_epoch,
    );

    await direct.loadSnapshot(
      canisterId,
      deployer,
      pendingSnapshotState.snapshot.id,
    );
    expect((await actor.kernel_runtime_info()).deployment_id).toBe(
      restoredInstallBranch.compiled.deploymentId,
    );
    expect(await actor.kernel_install_status(null)).toEqual(
      pendingSnapshotState.status,
    );

    // The restored journal already owns its complete staged snapshot. Resume
    // the exact captured inline/chunked dispatch instead of restaging through
    // the deliberately frozen public static API.
    await resumeCapturedPendingInstall(
      actor,
      paused,
      discardedPendingBranch.compiled.deploymentId,
    );
    const restoredPendingApps = normalizeAppInstances(
      (await actor.kernel_runtime_info()).apps,
    );
    const restoredPendingAuthority = requiredAppInstance(
      restoredPendingApps,
      "origin_authority",
    );
    const restoredPendingInstall = requiredAppInstance(
      restoredPendingApps,
      "pending_origin",
    );
    expect(restoredPendingInstall.scope.installation_uid).not.toBe(
      discardedPendingInstall.scope.installation_uid,
    );
    expect(restoredPendingInstall.browser_origin_nonce).not.toBe(
      discardedPendingInstall.browser_origin_nonce,
    );
    expect(restoredPendingAuthority.scope.installation_uid).toBe(
      discardedPendingAuthority.scope.installation_uid,
    );
    expect(restoredPendingAuthority.browser_origin_authority_epoch).not.toBe(
      discardedPendingAuthority.browser_origin_authority_epoch,
    );
    expect(restoredPendingAuthority.browser_origin_nonce).not.toBe(
      discardedPendingAuthority.browser_origin_nonce,
    );

    // One external install establishes the canister. Every branch transition
    // above goes through the Kernel's checked #upgrade/#keep transaction.
    expect(direct.externalInstallModes).toEqual(["install"]);
  } finally {
    if (client !== undefined && instanceId !== undefined) {
      await client.deleteInstance(instanceId).catch(() => undefined);
    }
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

type PreparedArchive = Readonly<{
  archive: Uint8Array;
  prepared: PreparedPackageInstall;
}>;

async function prepareBrowserOriginSnapshotPackages(
  temporaryRoot: string,
): Promise<
  Readonly<{
    kernel: PreparedArchive;
    authorityV100: PreparedArchive;
    authorityV101: PreparedArchive;
    authorityV102: PreparedArchive;
    hello: PreparedArchive;
    pendingOrigin: PreparedArchive;
  }>
> {
  const kernel = await prepareWorkingTreeKernelPackage(temporaryRoot);
  const authorityV100 = preparedTestArchive(
    residentAuthorityPackageFiles(100, false),
  );
  const authorityV101 = preparedTestArchive(
    residentAuthorityPackageFiles(101, true),
  );
  const authorityV102 = preparedTestArchive(
    residentAuthorityPackageFiles(102, false),
  );
  const pendingOrigin = preparedTestArchive(pendingOriginPackageFiles());
  const helloArchive = new Uint8Array(
    await readFile(
      new URL("../../../apps/hello/hello.v0.2.1.neutron", import.meta.url),
    ),
  );
  return {
    kernel,
    authorityV100,
    authorityV101,
    authorityV102,
    pendingOrigin,
    hello: {
      archive: helloArchive,
      prepared: preparePackageInstall(helloArchive),
    },
  };
}

function pendingOriginPackageFiles(): UnpackedNeutronPackage {
  const moduleContent = encoder.encode("module { public class Init() {} }");
  const entry = sha256Hex(moduleContent);
  const files: UnpackedNeutronPackage = {
    "neutron.json": encoder.encode(
      JSON.stringify({
        format: 3,
        id: "pending_origin",
        name: "Pending origin",
        version: 100,
        entry,
        tiles: [
          {
            id: "main",
            title: "Pending origin",
            path: "index.html",
            icon: "static/icon.svg",
          },
        ],
      }),
    ),
    "web/index.html": encoder.encode(
      "<!doctype html><title>Pending origin fixture</title>",
    ),
    "web/static/icon.svg": encoder.encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    ),
    [`mo/${entry}.mo`]: moduleContent,
  };
  addTestPackageRecord(files, false);
  return files;
}

async function prepareWorkingTreeKernelPackage(
  temporaryRoot: string,
): Promise<PreparedArchive> {
  // Keep the compiler project independent from the scripts project. These
  // computed imports exist only in this explicitly opted-in qualification.
  const scriptsSource = "../../neutron-scripts/src/";
  const [{ packageMotoko }, { parsePackageString }] = await Promise.all([
    import(scriptsSource + "mopack.ts"),
    import(scriptsSource + "walk.ts"),
  ]);
  const kernelRoot = fileURLToPath(
    new URL("../../../apps/kernel/", import.meta.url),
  );
  const temporaryKernel = path.join(temporaryRoot, "working-kernel");
  await cp(
    path.join(kernelRoot, "backend"),
    path.join(temporaryKernel, "backend"),
    { recursive: true },
  );
  await Promise.all([
    copyFile(
      path.join(kernelRoot, "neutron.json"),
      path.join(temporaryKernel, "neutron.json"),
    ),
    copyFile(
      path.join(kernelRoot, "neutron.lock.json"),
      path.join(temporaryKernel, "neutron.lock.json"),
    ),
  ]);

  const { stdout } = await execFile("mops", ["sources"], {
    cwd: kernelRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsedSourcePackages = parsePackageString(stdout) as Record<
    string,
    string
  >;
  const sourcePackages = Object.fromEntries(
    Object.entries(parsedSourcePackages).map(([name, sourcePath]) => [
      name,
      path.resolve(kernelRoot, sourcePath),
    ]),
  );
  await packageMotoko({ cwd: temporaryKernel, packages: sourcePackages });

  const dist = path.join(temporaryKernel, "dist");
  const files: UnpackedNeutronPackage = {
    "neutron.json": new Uint8Array(
      await readFile(path.join(dist, "neutron.json")),
    ),
    "neutron.lock.json": new Uint8Array(
      await readFile(path.join(dist, "neutron.lock.json")),
    ),
    "connection-providers.json": new Uint8Array(
      await readFile(
        path.join(kernelRoot, "connections/provider-support.generated.json"),
      ),
    ),
    "web/index.html": encoder.encode(
      "<!doctype html><title>Kernel test</title>",
    ),
  };
  const moduleRoot = path.join(dist, "mo");
  for (const filename of (await readdir(moduleRoot)).sort()) {
    files[`mo/${filename}`] = new Uint8Array(
      await readFile(path.join(moduleRoot, filename)),
    );
  }
  addTestPackageRecord(files, true);
  return preparedTestArchive(files);
}

function residentAuthorityPackageFiles(
  version: number,
  dedicated: boolean,
): UnpackedNeutronPackage {
  const moduleContent = encoder.encode("module { public class Init() {} }");
  const entry = sha256Hex(moduleContent);
  const files: UnpackedNeutronPackage = {
    "neutron.json": encoder.encode(
      JSON.stringify({
        format: 3,
        id: "origin_authority",
        name: "Origin authority",
        version,
        entry,
        background: { path: "service.html" },
        ...(dedicated
          ? {
              capabilities: {
                dedicated_resident_origin: {
                  api: 1,
                  surface: "background",
                  mode: "credentialless_ephemeral_v1",
                },
              },
            }
          : {}),
      }),
    ),
    "web/service.html": encoder.encode(
      "<!doctype html><title>Resident authority fixture</title>",
    ),
    [`mo/${entry}.mo`]: moduleContent,
  };
  addTestPackageRecord(files, false);
  return files;
}

function addTestPackageRecord(
  files: UnpackedNeutronPackage,
  isKernel: boolean,
): void {
  const manifest = JSON.parse(decoder.decode(files["neutron.json"]!)) as {
    id: string;
    version: number;
    memory?: Record<string, unknown>;
    package_features?: string[];
  };
  if (!isKernel) {
    manifest.package_features = [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE];
    files["neutron.json"] = encoder.encode(JSON.stringify(manifest));
  }
  const licensePath = isKernel
    ? "legal/LICENSE.test.txt"
    : `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.test.txt`;
  const noticePath = "legal/APPLICATION-NOTICE.txt";
  const license = encoder.encode("PocketIC qualification fixture license\n");
  const notice = encoder.encode("PocketIC qualification fixture\n");
  files[licensePath] = license;
  files[noticePath] = notice;

  let source: Uint8Array | undefined;
  if (!isKernel) {
    source = msgpack.encode({
      format: 1,
      package: { id: manifest.id, version: manifest.version },
      files: [
        {
          path: "neutron.json",
          mode: 0o644,
          content: files["neutron.json"]!,
        },
      ],
    });
    files[NEUTRON_APP_SOURCE_SNAPSHOT_PATH] = source;
  }

  const lock = files["neutron.lock.json"];
  files[NEUTRON_PACKAGE_RECORD_PATH] = encoder.encode(
    JSON.stringify({
      format: 1,
      ...(!isKernel
        ? { features: [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE] }
        : {}),
      package: {
        id: manifest.id,
        version: manifest.version,
        manifest: embeddedTestFile("neutron.json", files["neutron.json"]!),
      },
      license: {
        id: "LicenseRef-PocketIC-Test-1.0",
        texts: [
          {
            id: "LicenseRef-PocketIC-Test-1.0",
            ...embeddedTestFile(licensePath, license),
          },
        ],
      },
      source: isKernel
        ? { kind: "status", status: "not-provided" }
        : {
            kind: "embedded",
            revision: "browser-origin-snapshot-test",
            ...embeddedTestFile(NEUTRON_APP_SOURCE_SNAPSHOT_PATH, source!),
          },
      dependencies: [],
      notices: [embeddedTestFile(noticePath, notice)],
      memory:
        lock === undefined
          ? null
          : { lock: embeddedTestFile("neutron.lock.json", lock) },
      build: isKernel
        ? { inputs: [], commands: [] }
        : {
            inputs: [embeddedTestFile("neutron.json", files["neutron.json"]!)],
            commands: [
              {
                purpose: "package",
                cwd: ".",
                argv: ["npm", "run", "package"],
              },
            ],
          },
    }),
  );
}

function embeddedTestFile(pathname: string, content: Uint8Array) {
  return {
    path: pathname,
    sha256: sha256Hex(content),
    bytes: content.byteLength,
  };
}

function preparedTestArchive(files: UnpackedNeutronPackage): PreparedArchive {
  const archive = msgpack.encode(
    Object.fromEntries(
      Object.entries(files)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([pathname, content]) => [pathname, gzipSync(content)]),
    ),
  );
  return { archive, prepared: preparePackageInstall(archive) };
}

function freshDeployment(
  packages: readonly PreparedArchive[],
  compiled: CompileResult,
): unknown {
  const transportWasm = new Uint8Array(gzipSync(compiled.wasm));
  return {
    packages: packages.map(({ prepared }) => prepared),
    packageArchives: packages.map(({ archive }) => archive),
    packageArtifacts: packages.map(({ archive, prepared }) => ({
      path: `working-tree/${prepared.manifest.id}.neutron`,
      id: prepared.manifest.id,
      version: prepared.manifest.version,
      sha256: sha256Hex(archive),
      bytes: archive.byteLength,
    })),
    compiled,
    wasmMetadata: assertSupportedCertificateVersions(compiled.wasm),
    transportWasm,
    rawWasmSha256: sha256Hex(compiled.wasm),
    transportWasmSha256: sha256Hex(transportWasm),
    candidSha256: sha256Hex(encoder.encode(compiled.candid)),
    stableSha256: sha256Hex(encoder.encode(compiled.stable)),
    chunks: chunkWasm(transportWasm),
  };
}

function freshPackageState(
  packages: readonly PreparedPackageInstall[],
  compiled: CompileResult,
): KernelPackageState {
  const installed = buildPackagesInstallAssets({
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    packages: [...packages],
    candid: compiled.candid,
  });
  const kernel = packages.find(({ isKernel }) => isKernel);
  if (kernel?.connectionProviderSupport === undefined) {
    throw new Error("Working-tree Kernel has no connection-provider catalog");
  }
  return {
    registry: installed.apps,
    apps: installed.apps,
    browserSurfaceOriginAppIds: installed.browserSurfaceOriginAppIds,
    browserSurfaceOriginsSidecarPresent: true,
    existingConfigs: Object.fromEntries(
      packages.map(({ manifest }) => [manifest.id, manifest]),
    ),
    existingModules: motokoFilesFromPreparedFiles(
      packages.flatMap(({ files }) => files),
    ),
    previousStable: compiled.stable,
    connectionProviderSupport: kernel.connectionProviderSupport,
  };
}

function legacyPackageState(
  fixture: LegacyUpgradeCompileFixture,
): KernelPackageState {
  const connectionProviderSupport =
    fixture.legacyKernel.connectionProviderSupport;
  if (connectionProviderSupport === undefined) {
    throw new Error("Legacy Kernel has no connection-provider catalog");
  }
  return {
    registry: fixture.existingApps,
    apps: fixture.existingApps,
    browserSurfaceOriginAppIds: fixture.initial.browserSurfaceOriginAppIds,
    browserSurfaceOriginsSidecarPresent: supportsBrowserSurfaceOrigins(
      fixture.initial.assemblerId,
    ),
    existingConfigs: {
      kernel: fixture.legacyKernel.manifest,
      hello: fixture.hello.manifest,
    },
    existingModules: motokoFilesFromPreparedFiles([
      ...fixture.legacyKernel.files,
      ...fixture.hello.files,
    ]),
    previousStable: fixture.initial.stable,
    connectionProviderSupport,
  };
}

function advancePackageState(
  state: KernelPackageState,
  packages: readonly PreparedPackageInstall[],
  result: DeployPreparedPackagesResult,
  removedApps: readonly string[] = [],
): KernelPackageState {
  const removed = new Set(removedApps);
  const configs = Object.fromEntries(
    Object.entries(state.existingConfigs).filter(([id]) => !removed.has(id)),
  );
  for (const { manifest } of packages) configs[manifest.id] = manifest;

  const modules = new Map(
    state.existingModules.map((module) => [module.path, module]),
  );
  for (const module of motokoFilesFromPreparedFiles(
    packages.flatMap(({ files }) => files),
  )) {
    modules.set(module.path, module);
  }
  const retainedPaths = new Set(result.compiled.modulePaths);
  const existingModules = [...modules.values()].filter(({ path: modulePath }) =>
    retainedPaths.has(modulePath),
  );

  return {
    registry: result.apps,
    apps: result.apps,
    browserSurfaceOriginAppIds: result.compiled.browserSurfaceOriginAppIds,
    browserSurfaceOriginsSidecarPresent: true,
    existingConfigs: configs,
    existingModules,
    previousStable: result.compiled.stable,
    connectionProviderSupport: state.connectionProviderSupport,
  };
}

async function deployExactTransition({
  actor,
  canisterId,
  packages,
  state,
  compiled,
  expectedDeploymentId,
}: {
  actor: any;
  canisterId: Principal;
  packages: PreparedPackageInstall[];
  state: KernelPackageState;
  compiled: CompileResult;
  expectedDeploymentId: string;
}): Promise<DeployPreparedPackagesResult> {
  const deploymentBuildRecord = prepareCompleteDeploymentBuildRecord({
    targetCanisterId: canisterId.toText(),
    packages,
    state,
    compiled,
    expectedDeploymentId,
  }).record;
  return deployPreparedPackages({
    actor,
    targetCanisterId: canisterId.toText(),
    packages,
    compiled,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    previousModulePaths: state.existingModules.map(
      ({ path: modulePath }) => modulePath,
    ),
    deploymentBuildRecord,
    expectedDeploymentId,
    verifyTimeoutMs: 120_000,
  });
}

async function runLegacyUpgradeQualification(
  loadFixture: () => Promise<LegacyUpgradeCompileFixture>,
): Promise<void> {
  const fixture = await loadFixture();
  const candidateVersion = fixture.candidateKernel.manifest.version;
  assertLegacyUpgradeCompileInvariants(fixture);
  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256Hex(new Uint8Array(await readFile(binary)))).toBe(
    PINNED_POCKET_IC_SHA256,
  );

  const temporaryRoot = await mkdtemp(
    path.join(
      tmpdir(),
      `neutron-v${fixture.identity.package.version}-upgrade-pocketic-`,
    ),
  );
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;

  try {
    const launched = await launchPocketIc(binary, temporaryRoot);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, {
      requestTimeoutMs: 120_000,
    }) as DirectPocketIcClient;
    const created = await createApplicationInstance(
      launched.controlUrl,
      path.join(temporaryRoot, "state"),
    );
    instanceId = created.instanceId;

    const deployer = testPrincipal(71);
    const owner = testPrincipal(72);
    const backup = testPrincipal(73);
    const outsider = testPrincipal(74);
    const direct = new DirectPocketIcCalls(client, instanceId);
    const canisterId = await direct.createCanister(
      deployer,
      created.defaultEffectiveCanisterId,
    );
    await direct.installInitial(canisterId, deployer, fixture.initial);
    await direct.setControllers(canisterId, deployer, [deployer, canisterId]);

    const actor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: deployer,
      client,
    });
    const deployment = initialDeployment(fixture, fixture.initial);
    await provision.seedFreshKernel({
      actor,
      canisterId: canisterId.toText(),
      deployment,
      concurrency: 32,
      logger: silentLogger,
    });

    const initialRuntime = await actor.kernel_runtime_info();
    const initialAppInstances = normalizeAppInstances(initialRuntime.apps);
    expect(normalizeMemoryInventory(initialRuntime.memories)).toEqual([
      ["hello", "hello", 1],
      ["kernel", "kernel", 3],
      ["kernel", "kernel_activation", 1],
    ]);
    expect(
      initialRuntime.apps
        .map(({ scope }: { scope: { app_id: string } }) => scope.app_id)
        .sort(),
    ).toEqual(["hello", "kernel"]);
    const initialHelloInstance = requiredAppInstance(
      initialAppInstances,
      "hello",
    );
    const initialKernelInstance = requiredAppInstance(
      initialAppInstances,
      "kernel",
    );
    const compiledInitialHello = requiredCompiledAppInstance(
      fixture.initial.appInstanceInventory,
      "hello",
    );
    expect(initialHelloInstance.deployment_id).toBe(
      fixture.initial.deploymentId,
    );
    expect(BigInt(initialHelloInstance.scope.installation_uid)).toBeGreaterThan(
      0n,
    );
    expect(initialHelloInstance.capability_plan_fingerprint).toBe(
      compiledInitialHello.capability_plan_fingerprint,
    );
    expect(initialHelloInstance.resident_frame_security).toBe(
      compiledInitialHello.resident_frame_security,
    );
    expect(initialHelloInstance.browser_origin_nonce).toMatch(
      /^[a-f0-9]{32}$/u,
    );
    expect(initialHelloInstance.browser_origin_authority_epoch).toBe("1");

    const token = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const tokenHash = sha256(token);
    expect(
      await direct.kernelActivation(canisterId, deployer, {
        set: tokenHash,
      }),
    ).toEqual({ ready: null });
    expect(await direct.isAuthorized(canisterId, deployer)).toBe(false);
    expect(
      await direct.kernelActivation(canisterId, owner, { use: token }),
    ).toEqual({ authorized: null });
    expect(await direct.isAuthorized(canisterId, owner)).toBe(true);

    await direct.addController(canisterId, owner, owner);
    await direct.recoverAuthorization(canisterId, owner, backup);
    expect(await direct.isAuthorized(canisterId, backup)).toBe(true);
    expect(await direct.controllers(canisterId, owner)).toEqual(
      canonicalPrincipals([deployer, canisterId, owner]),
    );

    const durableHelloValue = `durable-v${fixture.identity.package.version}`;
    expect(await direct.helloWorld(canisterId, owner, durableHelloValue)).toBe(
      "Neutron",
    );
    const initialProvenance = await direct.readJsonAsset(
      canisterId,
      "/system/install-provenance.json",
    );
    expect(initialProvenance).toMatchObject({
      format: 1,
      apps: {
        hello: { kind: "provisioned" },
        kernel: { kind: "provisioned" },
      },
    });
    const initialRegistry = jsonObject(
      await direct.readJsonAsset(canisterId, "/system/apps.json"),
      "initial app registry",
    );

    expect(initialRegistry).toEqual(fixture.existingApps);
    const nextProvenance = {
      format: 1,
      apps: {
        ...(initialProvenance as { apps: Record<string, unknown> }).apps,
        kernel: {
          kind: "manual",
          acquisition: "file",
          package_digest: sha256Hex(fixture.candidateArchive),
        },
      },
    };
    const stagedAssets: InstallStagedAsset[] = [
      {
        target: "/system/install-provenance.json",
        content: encoder.encode(JSON.stringify(nextProvenance)),
        contentType: "application/json",
      },
    ];
    const ownerActor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: owner,
      client,
    });
    const installDispatch: ObservedInstallDispatch = { chunks: [] };
    const observedOwnerActor = observeInstallDispatch(
      ownerActor,
      installDispatch,
    );
    const initialState = legacyPackageState(fixture);
    const deploymentBuildRecord = prepareCompleteDeploymentBuildRecord({
      targetCanisterId: canisterId.toText(),
      packages: [fixture.candidateKernel],
      state: initialState,
      compiled: fixture.upgraded,
      expectedDeploymentId: fixture.initial.deploymentId,
    }).record;
    const steps: string[] = [];
    const deployed = await deployPreparedPackages({
      actor: observedOwnerActor,
      targetCanisterId: canisterId.toText(),
      packages: [fixture.candidateKernel],
      compiled: fixture.upgraded,
      existingApps: initialState.apps,
      existingBrowserSurfaceOriginAppIds:
        initialState.browserSurfaceOriginAppIds,
      previousModulePaths: initialState.existingModules.map(
        ({ path: modulePath }) => modulePath,
      ),
      expectedDeploymentId: fixture.initial.deploymentId,
      stagedAssets,
      deploymentBuildRecord,
      verifyTimeoutMs: 120_000,
      onStep: (step) => steps.push(step),
    });
    expect(steps).toEqual([
      "upload-modules",
      "stage-assets",
      "record-journal",
      "install-code",
      "verify-runtime",
      "commit-assets",
      "complete",
    ]);
    expect(await ownerActor.kernel_install_status(null)).toEqual([]);
    const expectedTransport = prepareDeterministicWasmTransport(
      fixture.upgraded.wasm,
    ).transportWasm;
    expect(observedInstallTransport(installDispatch)).toEqual(
      expectedTransport,
    );

    const upgradedRuntime = await ownerActor.kernel_runtime_info();
    expect(upgradedRuntime.deployment_id).toBe(fixture.upgraded.deploymentId);
    expect(normalizeMemoryInventory(upgradedRuntime.memories)).toEqual(
      normalizeMemoryInventory(initialRuntime.memories),
    );
    expect(
      upgradedRuntime.apps.map(
        ({
          scope,
          version,
        }: {
          scope: { app_id: string };
          version: number | bigint;
        }) => [scope.app_id, Number(version)],
      ),
    ).toEqual([
      ["hello", 201],
      ["kernel", candidateVersion],
    ]);
    const upgradedAppInstances = normalizeAppInstances(upgradedRuntime.apps);
    expect(requiredAppInstance(upgradedAppInstances, "hello")).toEqual({
      ...initialHelloInstance,
      deployment_id: fixture.upgraded.deploymentId,
    });
    const compiledKernelInstance = requiredCompiledAppInstance(
      fixture.upgraded.appInstanceInventory,
      "kernel",
    );
    expect(requiredAppInstance(upgradedAppInstances, "kernel")).toEqual({
      ...initialKernelInstance,
      version: candidateVersion,
      deployment_id: fixture.upgraded.deploymentId,
      capability_plan_fingerprint:
        compiledKernelInstance.capability_plan_fingerprint,
      resident_frame_security: compiledKernelInstance.resident_frame_security,
    });

    // Hello's v1 managed-memory value is the semantic state assertion: the
    // first post-upgrade call must return the value written by the predecessor.
    expect(await direct.helloWorld(canisterId, owner, "after-upgrade")).toBe(
      durableHelloValue,
    );
    expect(await direct.isAuthorized(canisterId, owner)).toBe(true);
    expect(await direct.isAuthorized(canisterId, backup)).toBe(true);
    expect(
      await direct.kernelActivation(canisterId, owner, { use: token }),
    ).toEqual({ already_authorized: null });
    expect(await direct.isAuthorized(canisterId, outsider)).toBe(false);
    expect(
      await direct.kernelActivation(canisterId, outsider, { use: token }),
    ).toEqual({ already_activated: null });
    expect(await direct.isAuthorized(canisterId, outsider)).toBe(false);
    expect(await direct.controllers(canisterId, owner)).toEqual(
      canonicalPrincipals([deployer, canisterId, owner]),
    );

    const finalProvenance = await direct.readJsonAsset(
      canisterId,
      "/system/install-provenance.json",
    );
    expect(finalProvenance).toEqual(nextProvenance);
    const finalRegistry = jsonObject(
      await direct.readJsonAsset(canisterId, "/system/apps.json"),
      "upgraded app registry",
    );
    expect(finalRegistry).toEqual(deployed.apps);
    expect(finalRegistry.hello).toEqual(initialRegistry.hello);
    expect(
      jsonObject(finalRegistry.kernel, "upgraded Kernel registry entry"),
    ).toMatchObject({ version: candidateVersion });
    expect(
      await ownerActor.kernel_static_query({ list: { prefix: "/pkg/legal/" } }),
    ).toContain("/pkg/legal/package-record.v1.json");
    expect(
      await direct.readJsonAsset(
        canisterId,
        "/pkg/legal/package-record.v1.json",
      ),
    ).toMatchObject({
      format: 1,
      package: { id: "kernel", version: candidateVersion },
    });

    const installedModuleContents = new Map(
      motokoFilesFromPreparedFiles([
        ...fixture.candidateKernel.files,
        ...fixture.hello.files,
      ]).map(({ path: modulePath, content }) => [`/mo/${modulePath}`, content]),
    );
    const recoveredState = await readKernelPackageState({
      listStatic: (prefix) =>
        ownerActor.kernel_static_query({ list: { prefix } }),
      fetchText: (assetPath) => {
        if (assetPath.startsWith("/mo/")) {
          const content = installedModuleContents.get(assetPath);
          if (content === undefined) {
            throw new Error(
              `Installed module ${assetPath} is absent from the candidate packages`,
            );
          }
          return Promise.resolve(content);
        }
        return direct.readTextAsset(canisterId, assetPath);
      },
      fetchJson: (assetPath, fallback) =>
        direct.readJsonAssetOr(canisterId, assetPath, fallback),
    });
    expect(finalRegistry).toEqual(recoveredState.apps);
    expect(
      recoveredState.existingModules.map(({ path: modulePath }) => modulePath),
    ).toEqual(fixture.upgraded.modulePaths);
    expect(recoveredState.previousStable).toBe(fixture.upgraded.stable);
    expect(() =>
      assertKernelPackageStateMatchesRuntime(recoveredState, upgradedRuntime),
    ).not.toThrow();

    const unchangedCompile = await compilePackages({
      packages: [],
      existingModules: recoveredState.existingModules,
      existingConfigs: recoveredState.existingConfigs,
      existingApps: recoveredState.apps,
      existingBrowserSurfaceOriginAppIds:
        recoveredState.browserSurfaceOriginAppIds,
      existingStable: recoveredState.previousStable,
      connectionProviderSupport: recoveredState.connectionProviderSupport,
      persistenceMode: fixture.release.persistenceMode,
    });
    expect(unchangedCompile.compatibilityDiagnostics).toEqual([]);
    expect(unchangedCompile.migrationPlan).toEqual(
      fixture.upgraded.migrationPlan,
    );
    expect(unchangedCompile.managedMemoryRetirements).toEqual([]);
    expect(unchangedCompile.appInstanceInventory).toEqual(
      fixture.upgraded.appInstanceInventory,
    );
    expect(unchangedCompile.managedMemoryInventory).toEqual(
      fixture.upgraded.managedMemoryInventory,
    );
    expect(unchangedCompile.previousManagedMemoryInventory).toEqual(
      unchangedCompile.managedMemoryInventory,
    );
    expect(unchangedCompile.deploymentId).toBe(fixture.upgraded.deploymentId);
    expect(unchangedCompile.compilerId).toBe(fixture.upgraded.compilerId);
    expect(unchangedCompile.deploymentNonce).toBeNull();
    expect(unchangedCompile.modulePaths).toEqual(fixture.upgraded.modulePaths);
    expect(unchangedCompile.candid).toBe(fixture.upgraded.candid);
    expect(unchangedCompile.stable).toBe(fixture.upgraded.stable);
    expect(unchangedCompile.wasm).toEqual(fixture.upgraded.wasm);
    expect(
      Buffer.from(await direct.moduleHash(canisterId, owner)).toString("hex"),
    ).toBe(sha256Hex(expectedTransport));

    // The harness makes exactly one external management installation: the
    // initial install. The second transition was dispatched by the running
    // Kernel's checked journal with its released persistence lineage.
    expect(direct.externalInstallModes).toEqual(["install"]);
  } finally {
    if (client !== undefined && instanceId !== undefined) {
      await client.deleteInstance(instanceId).catch(() => undefined);
    }
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const silentLogger = { log() {} };

async function loadProvisionHarness(): Promise<{
  PocketIcRestClient: new (
    controlUrl: string,
    options: { requestTimeoutMs: number },
  ) => DirectPocketIcClient;
  createDirectPocketIcKernelActor: (input: Record<string, unknown>) => any;
  seedFreshKernel: (input: Record<string, unknown>) => Promise<void>;
}> {
  // Keep this release runner in the compiler test project without making its
  // production package depend on the provisioner. The computed specifiers are
  // resolved only by this explicitly invoked test process.
  const provisionSource = "../../neutron-provision/src/";
  const [rest, kernel, provision] = await Promise.all([
    import(provisionSource + "pocketic_rest.ts"),
    import(provisionSource + "kernel.ts"),
    import(provisionSource + "provision.ts"),
  ]);
  return {
    PocketIcRestClient: rest.PocketIcRestClient,
    createDirectPocketIcKernelActor: kernel.createDirectPocketIcKernelActor,
    seedFreshKernel: provision.seedFreshKernel,
  };
}

class DirectPocketIcCalls {
  readonly externalInstallModes: string[] = [];
  readonly #managementMethods: Map<string, IDL.FuncClass>;

  constructor(
    readonly client: DirectPocketIcClient,
    readonly instanceId: number,
  ) {
    this.#managementMethods = new Map(testManagementIdl()._fields);
  }

  async createCanister(
    caller: Principal,
    effectiveCanisterId: string,
  ): Promise<Principal> {
    const result = (await this.managementCall(
      "provisional_create_canister_with_cycles",
      [
        {
          amount: [100_000_000_000_000n],
          settings: [emptySettings([caller])],
          specified_id: [],
          sender_canister_version: [],
        },
      ],
      caller,
      { CanisterId: effectiveCanisterId },
    )) as { canister_id: Principal };
    return result.canister_id;
  }

  async setControllers(
    canisterId: Principal,
    caller: Principal,
    controllers: Principal[],
  ): Promise<void> {
    await this.managementCall(
      "update_settings",
      [
        {
          canister_id: canisterId,
          settings: emptySettings(controllers),
          sender_canister_version: [],
        },
      ],
      caller,
      effectiveCanister(canisterId),
    );
  }

  async takeSnapshot(
    canisterId: Principal,
    caller: Principal,
  ): Promise<{
    id: Uint8Array;
    taken_at_timestamp: bigint;
    total_size: bigint;
  }> {
    await this.managementCall(
      "stop_canister",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    );
    try {
      return (await this.managementCall(
        "take_canister_snapshot",
        [
          {
            canister_id: canisterId,
            replace_snapshot: [],
            sender_canister_version: [],
            uninstall_code: [],
          },
        ],
        caller,
        effectiveCanister(canisterId),
      )) as {
        id: Uint8Array;
        taken_at_timestamp: bigint;
        total_size: bigint;
      };
    } finally {
      await this.managementCall(
        "start_canister",
        [{ canister_id: canisterId }],
        caller,
        effectiveCanister(canisterId),
      );
    }
  }

  async loadSnapshot(
    canisterId: Principal,
    caller: Principal,
    snapshotId: Uint8Array,
  ): Promise<void> {
    await this.managementCall(
      "stop_canister",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    );
    try {
      await this.managementCall(
        "load_canister_snapshot",
        [
          {
            canister_id: canisterId,
            snapshot_id: snapshotId,
            sender_canister_version: [],
          },
        ],
        caller,
        effectiveCanister(canisterId),
      );
    } finally {
      await this.managementCall(
        "start_canister",
        [{ canister_id: canisterId }],
        caller,
        effectiveCanister(canisterId),
      );
    }
  }

  async moduleHash(
    canisterId: Principal,
    caller: Principal,
  ): Promise<Uint8Array> {
    const status = (await this.managementCall(
      "canister_status",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    )) as { module_hash: [] | [Uint8Array] };
    const moduleHash = status.module_hash[0];
    if (!(moduleHash instanceof Uint8Array) || moduleHash.byteLength !== 32) {
      throw new Error("Management canister_status has no 32-byte module hash");
    }
    return moduleHash;
  }

  async installInitial(
    canisterId: Principal,
    caller: Principal,
    compiled: CompileResult,
  ): Promise<void> {
    const transport = new Uint8Array(gzipSync(compiled.wasm));
    const chunks = chunkWasm(transport);
    await this.managementCall(
      "clear_chunk_store",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    );
    for (const chunk of chunks) {
      const uploaded = (await this.managementCall(
        "upload_chunk",
        [{ canister_id: canisterId, chunk: chunk.bytes }],
        caller,
        effectiveCanister(canisterId),
      )) as { hash: Uint8Array };
      expect(Buffer.from(uploaded.hash).toString("hex")).toBe(chunk.hashHex);
    }
    this.externalInstallModes.push("install");
    await this.managementCall(
      "install_chunked_code",
      [
        {
          mode: { install: null },
          target_canister: canisterId,
          store_canister: [],
          chunk_hashes_list: chunks.map(({ hash }) => ({ hash })),
          wasm_module_hash: sha256(transport),
          arg: IDL.encode([], []),
          sender_canister_version: [],
        },
      ],
      caller,
      effectiveCanister(canisterId),
    );
    await this.managementCall(
      "clear_chunk_store",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    );
  }

  kernelActivation(
    canisterId: Principal,
    caller: Principal,
    request: { set: Uint8Array } | { use: Uint8Array },
  ): Promise<unknown> {
    const activation = IDL.Variant({
      set: IDL.Vec(IDL.Nat8),
      use: IDL.Vec(IDL.Nat8),
    });
    const result = IDL.Variant({
      ready: IDL.Null,
      authorized: IDL.Null,
      already_authorized: IDL.Null,
      already_set: IDL.Null,
      already_activated: IDL.Null,
      invalid: IDL.Null,
    });
    return this.actorCall(
      canisterId,
      caller,
      "kernel_activation",
      IDL.Func([activation], [result], []),
      [request],
    );
  }

  async isAuthorized(
    canisterId: Principal,
    caller: Principal,
  ): Promise<boolean> {
    return (await this.actorCall(
      canisterId,
      caller,
      "kernel_check_authorized",
      IDL.Func([IDL.Null], [IDL.Bool], ["query"]),
      [null],
    )) as boolean;
  }

  async addController(
    canisterId: Principal,
    caller: Principal,
    controller: Principal,
  ): Promise<void> {
    await this.actorCall(
      canisterId,
      caller,
      "kernel_controller_add",
      IDL.Func([IDL.Principal], [accessSnapshotType()], []),
      [controller],
    );
  }

  async recoverAuthorization(
    canisterId: Principal,
    caller: Principal,
    principal: Principal,
  ): Promise<void> {
    await this.actorCall(
      canisterId,
      caller,
      "kernel_authorized_recover",
      IDL.Func([IDL.Principal], [], []),
      [principal],
    );
  }

  async controllers(
    canisterId: Principal,
    caller: Principal,
  ): Promise<string[]> {
    const snapshot = (await this.actorCall(
      canisterId,
      caller,
      "kernel_access_snapshot",
      IDL.Func([IDL.Null], [accessSnapshotType()], []),
      [null],
    )) as { controllers: Principal[] };
    return canonicalPrincipals(snapshot.controllers);
  }

  async helloWorld(
    canisterId: Principal,
    caller: Principal,
    value: string,
  ): Promise<string> {
    return (await this.actorCall(
      canisterId,
      caller,
      physicalAppMethodName("hello", "hello_world"),
      IDL.Func([IDL.Text], [IDL.Text], []),
      [value],
    )) as string;
  }

  async readJsonAsset(canisterId: Principal, path: string): Promise<unknown> {
    const response = await this.readAsset(canisterId, path);
    expect(response.statusCode).toBe(200);
    return JSON.parse(decoder.decode(response.body));
  }

  async readJsonAssetOr<T>(
    canisterId: Principal,
    path: string,
    fallback: T,
  ): Promise<T> {
    const response = await this.readAsset(canisterId, path);
    if (response.statusCode === 404) return fallback;
    expect(response.statusCode).toBe(200);
    return JSON.parse(decoder.decode(response.body)) as T;
  }

  async readTextAsset(canisterId: Principal, path: string): Promise<string> {
    const response = await this.readAsset(canisterId, path);
    expect(response.statusCode).toBe(200);
    return decoder.decode(response.body);
  }

  private async readAsset(
    canisterId: Principal,
    path: string,
  ): Promise<{ statusCode: number; body: Uint8Array }> {
    const response = (await this.actorCall(
      canisterId,
      Principal.anonymous(),
      "http_request",
      httpRequestMethod(),
      [
        {
          method: "GET",
          url: path,
          headers: [["Host", `${canisterId.toText()}.localhost:8000`]],
          body: new Uint8Array(),
          certificate_version: [2],
        },
      ],
    )) as {
      body: Uint8Array;
      headers: Array<[string, string]>;
      streaming_strategy: unknown[];
      status_code: number;
    };
    expect(response.streaming_strategy).toEqual([]);
    const encoding = response.headers.find(
      ([name]) => name.toLowerCase() === "content-encoding",
    )?.[1];
    const body =
      encoding === "gzip"
        ? new Uint8Array(gunzipSync(response.body))
        : response.body;
    return { statusCode: response.status_code, body };
  }

  private async managementCall(
    name: string,
    args: unknown[],
    caller: Principal,
    effectivePrincipal: { CanisterId: string },
  ): Promise<unknown> {
    const method = this.#managementMethods.get(name);
    if (method === undefined)
      throw new Error(`Missing management method ${name}`);
    return this.call(
      Principal.fromText("aaaaa-aa"),
      caller,
      name,
      method,
      args,
      effectivePrincipal,
    );
  }

  private actorCall(
    canisterId: Principal,
    caller: Principal,
    name: string,
    method: IDL.FuncClass,
    args: unknown[],
  ): Promise<unknown> {
    return this.call(canisterId, caller, name, method, args);
  }

  private async call(
    canisterId: Principal,
    caller: Principal,
    name: string,
    method: IDL.FuncClass,
    args: unknown[],
    effectivePrincipal?: { CanisterId: string },
  ): Promise<unknown> {
    const payload = new Uint8Array(IDL.encode(method.argTypes, args));
    const request = {
      canisterId,
      sender: caller,
      method: name,
      payload,
      ...(effectivePrincipal ? { effectivePrincipal } : {}),
    };
    const response = method.annotations.includes("query")
      ? await this.client.queryCanister(this.instanceId, request)
      : await this.client.awaitIngressMessage(
          this.instanceId,
          await this.client.submitIngressMessage(this.instanceId, request),
        );
    const values = IDL.decode(method.retTypes, response);
    return values.length === 0 ? undefined : values[0];
  }
}

function initialDeployment(
  fixture: LegacyUpgradeCompileFixture,
  compiled: CompileResult,
): unknown {
  const transportWasm = new Uint8Array(gzipSync(compiled.wasm));
  return {
    packages: [fixture.legacyKernel, fixture.hello],
    packageArchives: [fixture.legacyArchive, fixture.helloArchive],
    packageArtifacts: [
      {
        path: `test-fixture/${fixture.release.archive.slice(2)}`,
        id: "kernel",
        version: fixture.identity.package.version,
        sha256: sha256Hex(fixture.legacyArchive),
        bytes: fixture.legacyArchive.byteLength,
      },
      {
        path: "test-fixture/hello.v0.2.1.neutron",
        id: "hello",
        version: 201,
        sha256: sha256Hex(fixture.helloArchive),
        bytes: fixture.helloArchive.byteLength,
      },
    ],
    compiled,
    wasmMetadata: assertSupportedCertificateVersions(compiled.wasm),
    transportWasm,
    rawWasmSha256: sha256Hex(compiled.wasm),
    transportWasmSha256: sha256Hex(transportWasm),
    candidSha256: sha256Hex(encoder.encode(compiled.candid)),
    stableSha256: sha256Hex(encoder.encode(compiled.stable)),
    chunks: chunkWasm(transportWasm),
  };
}

function emptySettings(controllers: Principal[]) {
  return {
    controllers: [controllers],
    compute_allocation: [],
    memory_allocation: [],
    freezing_threshold: [],
    reserved_cycles_limit: [],
    log_visibility: [],
    wasm_memory_limit: [],
    wasm_memory_threshold: [],
    environment_variables: [],
    snapshot_visibility: [],
    minimum_incoming_canister_call_cycles: [],
  };
}

function testManagementIdl(): IDL.ServiceClass {
  const settings = IDL.Record({
    controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
    compute_allocation: IDL.Opt(IDL.Nat),
    memory_allocation: IDL.Opt(IDL.Nat),
    freezing_threshold: IDL.Opt(IDL.Nat),
    reserved_cycles_limit: IDL.Opt(IDL.Nat),
    log_visibility: IDL.Opt(IDL.Empty),
    wasm_memory_limit: IDL.Opt(IDL.Nat),
    wasm_memory_threshold: IDL.Opt(IDL.Nat),
    environment_variables: IDL.Opt(
      IDL.Vec(IDL.Record({ name: IDL.Text, value: IDL.Text })),
    ),
    snapshot_visibility: IDL.Opt(IDL.Empty),
    minimum_incoming_canister_call_cycles: IDL.Opt(IDL.Nat),
  });
  const chunkHash = IDL.Record({ hash: IDL.Vec(IDL.Nat8) });
  const canister = IDL.Record({ canister_id: IDL.Principal });
  const snapshot = IDL.Record({
    id: IDL.Vec(IDL.Nat8),
    taken_at_timestamp: IDL.Nat64,
    total_size: IDL.Nat64,
  });
  return IDL.Service({
    provisional_create_canister_with_cycles: IDL.Func(
      [
        IDL.Record({
          amount: IDL.Opt(IDL.Nat),
          settings: IDL.Opt(settings),
          specified_id: IDL.Opt(IDL.Principal),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
    ),
    update_settings: IDL.Func(
      [
        IDL.Record({
          canister_id: IDL.Principal,
          settings,
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
    canister_status: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [IDL.Record({ module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)) })],
      [],
    ),
    stop_canister: IDL.Func([canister], [], []),
    start_canister: IDL.Func([canister], [], []),
    take_canister_snapshot: IDL.Func(
      [
        IDL.Record({
          canister_id: IDL.Principal,
          replace_snapshot: IDL.Opt(IDL.Vec(IDL.Nat8)),
          sender_canister_version: IDL.Opt(IDL.Nat64),
          uninstall_code: IDL.Opt(IDL.Bool),
        }),
      ],
      [snapshot],
      [],
    ),
    load_canister_snapshot: IDL.Func(
      [
        IDL.Record({
          canister_id: IDL.Principal,
          snapshot_id: IDL.Vec(IDL.Nat8),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
    clear_chunk_store: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
      [],
    ),
    upload_chunk: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal, chunk: IDL.Vec(IDL.Nat8) })],
      [chunkHash],
      [],
    ),
    install_chunked_code: IDL.Func(
      [
        IDL.Record({
          mode: IDL.Variant({
            install: IDL.Null,
            reinstall: IDL.Null,
            upgrade: IDL.Opt(
              IDL.Record({
                skip_pre_upgrade: IDL.Opt(IDL.Bool),
                wasm_memory_persistence: IDL.Opt(
                  IDL.Variant({ keep: IDL.Null, replace: IDL.Null }),
                ),
              }),
            ),
          }),
          target_canister: IDL.Principal,
          store_canister: IDL.Opt(IDL.Principal),
          chunk_hashes_list: IDL.Vec(chunkHash),
          wasm_module_hash: IDL.Vec(IDL.Nat8),
          arg: IDL.Vec(IDL.Nat8),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
  });
}

function accessSnapshotType() {
  return IDL.Record({
    snapshot_version: IDL.Nat,
    authorized_principals: IDL.Vec(IDL.Principal),
    controllers: IDL.Vec(IDL.Principal),
    self_principal: IDL.Principal,
    controller_limit: IDL.Nat,
  });
}

function httpRequestMethod(): IDL.FuncClass {
  const header = IDL.Tuple(IDL.Text, IDL.Text);
  const token = IDL.Record({
    key: IDL.Text,
    sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
    index: IDL.Nat,
    content_encoding: IDL.Text,
  });
  const callback = IDL.Func(
    [token],
    [IDL.Record({ token: IDL.Opt(token), body: IDL.Vec(IDL.Nat8) })],
    ["query"],
  );
  const response = IDL.Record({
    body: IDL.Vec(IDL.Nat8),
    headers: IDL.Vec(header),
    streaming_strategy: IDL.Opt(
      IDL.Variant({
        Callback: IDL.Record({ token, callback }),
      }),
    ),
    status_code: IDL.Nat16,
    upgrade: IDL.Opt(IDL.Bool),
  });
  const request = IDL.Record({
    method: IDL.Text,
    url: IDL.Text,
    headers: IDL.Vec(header),
    body: IDL.Vec(IDL.Nat8),
    certificate_version: IDL.Opt(IDL.Nat16),
  });
  return IDL.Func([request], [response], ["query"]);
}

function normalizeMemoryInventory(
  memories: Array<{ owner: string; id: string; version: number | bigint }>,
): Array<[string, string, number]> {
  return memories.map(({ owner, id, version }) => [owner, id, Number(version)]);
}

type AppInstanceSnapshot = Readonly<{
  scope: Readonly<{ app_id: string; installation_uid: string }>;
  version: number;
  deployment_id: string;
  capability_plan_fingerprint: string;
  browser_origin_nonce: string;
  browser_origin_authority_epoch: string;
  resident_frame_security: string;
}>;

function normalizeAppInstances(
  instances: AppInstance[],
): AppInstanceSnapshot[] {
  return instances
    .map((instance) => {
      const securityTags = Object.keys(instance.resident_frame_security);
      if (securityTags.length !== 1) {
        throw new Error("Runtime app instance has invalid frame security");
      }
      return {
        scope: {
          app_id: instance.scope.app_id,
          installation_uid: BigInt(instance.scope.installation_uid).toString(),
        },
        version: Number(instance.version),
        deployment_id: instance.deployment_id,
        capability_plan_fingerprint: instance.capability_plan_fingerprint,
        browser_origin_nonce: instance.browser_origin_nonce,
        browser_origin_authority_epoch: BigInt(
          instance.browser_origin_authority_epoch,
        ).toString(),
        resident_frame_security: securityTags[0]!,
      };
    })
    .sort((left, right) =>
      left.scope.app_id < right.scope.app_id
        ? -1
        : left.scope.app_id > right.scope.app_id
          ? 1
          : 0,
    );
}

function requiredAppInstance(
  instances: readonly AppInstanceSnapshot[],
  appId: string,
): AppInstanceSnapshot {
  const instance = instances.find(({ scope }) => scope.app_id === appId);
  if (instance === undefined) {
    throw new Error(`Runtime app instance ${appId} is missing`);
  }
  return instance;
}

function requiredCompiledAppInstance(
  instances: readonly Readonly<{
    app_id: string;
    capability_plan_fingerprint: string;
    resident_frame_security: string;
  }>[],
  appId: string,
): Readonly<{
  app_id: string;
  capability_plan_fingerprint: string;
  resident_frame_security: string;
}> {
  const instance = instances.find(({ app_id }) => app_id === appId);
  if (instance === undefined) {
    throw new Error(`Compiled app instance ${appId} is missing`);
  }
  return instance;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function canonicalPrincipals(principals: Principal[]): string[] {
  return principals
    .map((principal) => principal.toText())
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function effectiveCanister(canisterId: Principal): { CanisterId: string } {
  return {
    CanisterId: Buffer.from(canisterId.toUint8Array()).toString("base64"),
  };
}

function testPrincipal(seedByte: number): Principal {
  return Principal.selfAuthenticating(new Uint8Array(32).fill(seedByte));
}

function chunkWasm(wasm: Uint8Array): Array<{
  bytes: Uint8Array;
  hash: Uint8Array;
  hashHex: string;
}> {
  const chunks = [];
  for (let start = 0; start < wasm.byteLength; start += 1024 * 1024) {
    const bytes = wasm.slice(
      start,
      Math.min(wasm.byteLength, start + 1024 * 1024),
    );
    const hash = sha256(bytes);
    chunks.push({ bytes, hash, hashHex: Buffer.from(hash).toString("hex") });
  }
  return chunks;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredPocketIcBinary(): string {
  const value = process.env.NEUTRON_POCKETIC_BIN;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "NEUTRON_POCKETIC_BIN must name the pinned PocketIC 14.0.0 executable",
    );
  }
  return path.resolve(value);
}

async function launchPocketIc(
  binary: string,
  temporaryRoot: string,
): Promise<{
  server: ChildProcessWithoutNullStreams;
  controlUrl: string;
}> {
  const metadata = await stat(binary);
  if (!metadata.isFile()) throw new Error("PocketIC binary is not a file");
  const portFile = path.join(temporaryRoot, "control.port");
  const server = spawn(
    binary,
    ["--ttl", "120", "--port-file", portFile, "--log-levels", "error"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8_192);
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`PocketIC exited before startup: ${stderr}`);
    }
    try {
      const port = Number((await readFile(portFile, "utf8")).trim());
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        return { server, controlUrl: `http://127.0.0.1:${port}/` };
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await delay(25);
  }
  await stopPocketIc(server);
  throw new Error(`PocketIC did not publish its control port: ${stderr}`);
}

async function createApplicationInstance(
  controlUrl: string,
  stateDirectory: string,
): Promise<{ instanceId: number; defaultEffectiveCanisterId: string }> {
  const subnet = {
    state_config: "New",
    instruction_config: "Production",
    subnet_admins: null,
    cost_schedule: "Normal",
  };
  const config = {
    subnet_config_set: {
      nns: null,
      sns: null,
      ii: null,
      fiduciary: null,
      bitcoin: null,
      test_threshold_keys: null,
      system: [],
      application: [subnet],
      cloud_engine: [],
      verified_application: [],
    },
    http_gateway_config: null,
    state_dir: stateDirectory,
    icp_config: null,
    log_level: null,
    bitcoind_addr: null,
    dogecoind_addr: null,
    icp_features: {
      registry: null,
      cycles_minting: null,
      icp_token: null,
      cycles_token: null,
      nns_governance: null,
      sns: null,
      ii: null,
      nns_ui: null,
      bitcoin: null,
      dogecoin: null,
      canister_migration: null,
    },
    incomplete_state: "Disabled",
    initial_time: { AutoProgress: { artificial_delay_ms: null } },
    mainnet_nns_subnet_id: false,
    disable_ingress_validation: false,
  };
  const response = await fetch(new URL("instances", controlUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const body = (await response.json()) as {
    Created?: {
      instance_id: number;
      topology: {
        default_effective_canister_id: { canister_id: string };
      };
    };
  };
  if (!response.ok || body.Created === undefined) {
    throw new Error(
      `PocketIC instance creation failed: ${JSON.stringify(body)}`,
    );
  }
  return {
    instanceId: body.Created.instance_id,
    defaultEffectiveCanisterId:
      body.Created.topology.default_effective_canister_id.canister_id,
  };
}

async function stopPocketIc(
  server: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => server.once("exit", () => resolve(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited && server.exitCode === null) {
    server.kill("SIGKILL");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
