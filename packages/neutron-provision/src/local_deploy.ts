import { createHash } from "node:crypto";
import path from "node:path";
import type { Identity } from "@dfinity/agent";
import {
  trustedInstallationContextFromRootKey,
  trustedInstallationNetworkIdHex,
} from "neutron-compiler/src/installation_context.js";
import { supportsBrowserSurfaceOrigins } from "neutron-compiler/src/assemble.js";
import {
  assertBrowserSurfaceOriginAppIdsMatch,
  assertKernelPackageBaselineMatchesRuntime,
  assertKernelPackageStateMatchesRuntime,
  type KernelPackageInstaller,
} from "neutron-compiler/src/install.js";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { parseKernelRuntimeConfig } from "neutron-tools/src/runtime_config.js";
import { assertSupportedCertificateVersionsMetadata } from "neutron-tools/src/wasm_metadata.js";
import {
  assertPreparedDeploymentTarget,
  prepareDeployment,
  type PackageArtifact,
  type PreparedDeployment,
} from "./artifact.ts";
import { compilerSourceFingerprint } from "./compiler_fingerprint.ts";
import { canonicalNonAnonymousPrincipal } from "./ic_client.ts";
import { LocalProvisionClient } from "./local_client.ts";
import { fundLocalPocketIcFixtures } from "./local_fixtures.ts";
import {
  usesFullProtocolFixtures,
  type LocalEnvironment,
} from "./local_environment.ts";
import { localIdentityFromSeed } from "./kernel.ts";
import { readKernelPackageState } from "./kernel_state.ts";
import {
  INSTALL_PROVENANCE_PATH,
  assertFreshInstallProvenance,
  freshKernelAssetKeys,
  freshKernelModuleContents,
  seedFreshKernel,
} from "./provision.ts";
import {
  bindDeploymentRuntimeConfig,
  deploymentRuntimeConfig,
} from "./runtime_config.ts";
import {
  completeLocalReinstall,
  localDeploymentNodes,
  readSession,
  recordLocalCanister,
  recordLocalNodePhase,
  startLocalReinstall,
  withSessionLock,
  writeSession,
  type PocketIcRuntime,
  type ProvisionJournal,
  type LocalNodeDeploymentPhase,
  type LocalReinstallState,
} from "./session.ts";
import {
  verifyPocketIcRuntime,
  type PocketIcRuntimeAttachment,
  type PocketIcRuntimeDescriptor,
} from "./pocketic_supervisor.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type LocalReinstallOptions = {
  configSha256: string;
  sessionPath: string;
  developerIdentitySeed: number;
  nodeLabels: string[];
  authorizedPrincipals: string[];
  packagePaths: string[];
  repositoryRoot: string;
  compileCacheDirectory: string;
  profile: LocalEnvironment;
};

export type LocalReinstallResult = {
  canisterId: string;
  nodes: Array<{ label: string; canisterId: string; url: string }>;
  developerPrincipal: string;
  authorizedPrincipals: string[];
  deployment: PreparedDeployment;
  session: ProvisionJournal;
  url: string;
};

export type LocalDeploymentClient = Pick<
  LocalProvisionClient,
  | "createCanister"
  | "operationalState"
  | "ensureSelfController"
  | "installDeployment"
  | "kernelActor"
  | "authorizeFreshPrincipals"
  | "verifyAuthorizedPrincipals"
>;

export type LocalReinstallDependencies = {
  prepare?: typeof prepareDeployment;
  compilerFingerprint?: typeof compilerSourceFingerprint;
  verifyRuntime?: (
    descriptor: PocketIcRuntimeDescriptor,
  ) => Promise<PocketIcRuntimeAttachment>;
  identityFromSeed?: (seed: number) => Identity;
  createClient?: (input: {
    gatewayUrl: string;
    controlUrl: string;
    instanceId: number;
    identity: Identity;
    defaultEffectiveCanisterIdBase64: string;
    expectedRootKeyBase64: string;
    logger: Pick<Console, "log">;
  }) => Promise<LocalDeploymentClient>;
  bindRuntimeConfig?: typeof bindDeploymentRuntimeConfig;
  seed?: typeof seedFreshKernel;
  fundFixtures?: typeof fundLocalPocketIcFixtures;
  verify?: typeof verifyLocalFreshKernel;
  now?: () => Date;
  logger?: Pick<Console, "log">;
};

/**
 * Perform the sole supported local deployment operation: a complete actor
 * install on first use and a complete actor reinstall on every later use.
 */
export async function runLocalReinstall(
  options: LocalReinstallOptions,
  dependencies: LocalReinstallDependencies = {},
): Promise<LocalReinstallResult> {
  const configuredPrincipals = validateOptions(options);
  const logger = dependencies.logger ?? console;
  const now = dependencies.now ?? (() => new Date());

  return withSessionLock(options.sessionPath, async () => {
    const journal = await requireLocalJournal(options.sessionPath);
    const descriptor = descriptorFromRuntime(journal.runtime);
    if (descriptor.profile !== options.profile) {
      throw new Error(
        "The PocketIC runtime profile does not match this local deployment config",
      );
    }
    await (dependencies.verifyRuntime ?? verifyPocketIcRuntime)(descriptor);
    const installationContext = trustedInstallationContextFromRootKey(
      new Uint8Array(Buffer.from(descriptor.rootKeyBase64, "base64")),
    );
    const installationNetworkIdHex =
      trustedInstallationNetworkIdHex(installationContext);
    // Local intent is rebuildable and unpaid. A developer may add/remove apps
    // in the config without restarting the healthy shared PocketIC server.
    journal.configSha256 = options.configSha256;

    const [packagePaths, compilerFingerprint] = await Promise.all([
      Promise.resolve(options.packagePaths),
      (dependencies.compilerFingerprint ?? compilerSourceFingerprint)(
        options.repositoryRoot,
      ),
    ]);
    const deployment = await (dependencies.prepare ?? prepareDeployment)(
      packagePaths,
      {
        target: "local",
        localCompileCache: {
          directory: options.compileCacheDirectory,
          compilerFingerprint,
          installationNetworkIdHex,
          logger,
        },
        freshInstallationContext: installationContext,
      },
    );
    const inputFingerprint = localDeploymentFingerprint({
      configSha256: options.configSha256,
      deployment,
      nodeLabels: options.nodeLabels,
      installationNetworkIdHex,
      profile: options.profile,
    });
    const previousModuleHash =
      journal.current?.kind === "local"
        ? journal.current.transportWasmSha256
        : undefined;

    startLocalReinstall(
      journal,
      inputFingerprint,
      options.nodeLabels,
      now(),
    );
    await writeSession(options.sessionPath, journal, now());

    const identity = (
      dependencies.identityFromSeed ?? localIdentityFromSeed
    )(options.developerIdentitySeed);
    const client = await (
      dependencies.createClient ??
      ((input) => LocalProvisionClient.create(input))
    )({
      gatewayUrl: descriptor.gateway.url,
      controlUrl: descriptor.controlUrl,
      instanceId: descriptor.instanceId,
      identity,
      defaultEffectiveCanisterIdBase64:
        descriptor.topology.defaultEffectiveCanisterId,
      expectedRootKeyBase64: descriptor.rootKeyBase64,
      logger,
    });

    while (localDeploymentNodes(journal).length < options.nodeLabels.length) {
      const nodeIndex = localDeploymentNodes(journal).length;
      const canisterId = await client.createCanister();
      recordLocalCanister(
        journal,
        options.nodeLabels[nodeIndex]!,
        canisterId,
        now(),
      );
      await writeSession(options.sessionPath, journal, now());
      logger.log(
        `Created local Neutron ${options.nodeLabels[nodeIndex]} (${nodeIndex + 1}/${options.nodeLabels.length}): ${canisterId}`,
      );
    }

    const updateSourceCanisterId = requiredLocalUpdateSource(descriptor);
    let authorizedPrincipals: string[] | undefined;
    for (const [index, node] of localDeploymentNodes(journal).entries()) {
      const { canisterId, label } = node;
      try {
        assertPreparedDeploymentTarget(deployment, canisterId);
        let progress = localNodeProgress(journal, index);
        if (!phaseReached(progress.phase, "installed")) {
          const operational = await client.operationalState(canisterId);
          const installedModuleHash = operational.moduleHash;
          const expectedBeforeInstall = previousModuleHash;
          // A new hash proves an ambiguous install/reinstall committed. When
          // the previous and target hashes are equal, module status cannot
          // distinguish "RPC never ran" from "fresh reset committed"; issuing
          // the reinstall again is safe and preserves the promised clean state.
          const canReconcileInstalled =
            progress.phase === "installing" &&
            installedModuleHash === deployment.transportWasmSha256 &&
            expectedBeforeInstall !== deployment.transportWasmSha256;
          if (canReconcileInstalled) {
            recordLocalNodePhase(journal, index, "installed", now());
            await writeSession(options.sessionPath, journal, now());
          } else {
            // `reinstall` is the explicit destructive local-development path.
            // The browser may have legitimately installed an app update since
            // the previous provision receipt, so its whole-actor module hash
            // is not an ownership signal and must not strand the recorded
            // local canister. The exact supervised runtime and recorded
            // canister ID are verified before this point.
            const mode = installedModuleHash === null ? "install" : "reinstall";
            await client.ensureSelfController(canisterId);
            recordLocalNodePhase(journal, index, "installing", now());
            await writeSession(options.sessionPath, journal, now());
            logger.log(
              `${mode === "install" ? "Installing" : "Reinstalling"} ${label} (${index + 1}/${options.nodeLabels.length})`,
            );
            await client.installDeployment({ canisterId, deployment, mode });
            const installed = await client.operationalState(canisterId);
            if (
              installed.status !== "running" ||
              installed.moduleHash !== deployment.transportWasmSha256
            ) {
              throw new Error(
                `installed module verification expected ${deployment.transportWasmSha256}, found ${installed.moduleHash ?? "none"} (${installed.status})`,
              );
            }
            recordLocalNodePhase(journal, index, "installed", now());
            await writeSession(options.sessionPath, journal, now());
          }
        } else {
          const operational = await client.operationalState(canisterId);
          if (
            operational.status !== "running" ||
            operational.moduleHash !== deployment.transportWasmSha256
          ) {
            throw new Error(
              `recorded ${progress.phase} but live module is ${operational.moduleHash ?? "none"} (${operational.status})`,
            );
          }
        }

        // The actor Wasm is compiled once. Only package-owned static runtime
        // config is rebound before seeding each node's certified assets.
        (dependencies.bindRuntimeConfig ?? bindDeploymentRuntimeConfig)({
          deployment,
          canisterId,
          target: "pocketic",
          updateSourceCanisterId,
        });
        const actor = client.kernelActor(canisterId);
        progress = localNodeProgress(journal, index);
        if (!phaseReached(progress.phase, "seeded")) {
          await (dependencies.seed ?? seedFreshKernel)({
            actor,
            canisterId,
            deployment,
            concurrency: 512,
            logger,
          });
          recordLocalNodePhase(journal, index, "seeded", now());
          await writeSession(options.sessionPath, journal, now());
        }

        progress = localNodeProgress(journal, index);
        if (!phaseReached(progress.phase, "authorized")) {
          const nodeAuthorizedPrincipals =
            await client.authorizeFreshPrincipals(
              canisterId,
              configuredPrincipals,
            );
          authorizedPrincipals ??= nodeAuthorizedPrincipals;
          recordLocalNodePhase(journal, index, "authorized", now());
          await writeSession(options.sessionPath, journal, now());
        }
        const verifiedAuthorizedPrincipals =
          await client.verifyAuthorizedPrincipals(
            canisterId,
            configuredPrincipals,
          );
        authorizedPrincipals ??= verifiedAuthorizedPrincipals;

        progress = localNodeProgress(journal, index);
        if (
          usesFullProtocolFixtures(options.profile) &&
          !phaseReached(progress.phase, "funded")
        ) {
          await (dependencies.fundFixtures ?? fundLocalPocketIcFixtures)({
            gatewayUrl: descriptor.gateway.url,
            expectedRootKeyBase64: descriptor.rootKeyBase64,
            canisterId,
            stateDirectory: descriptor.stateDirectory,
            cacheDirectory: path.join(
              path.dirname(descriptor.stateDirectory),
              "cache",
              "fixtures",
            ),
            fundNativeChains: index === 0,
            logger,
          });
          recordLocalNodePhase(journal, index, "funded", now());
          await writeSession(options.sessionPath, journal, now());
        }

        await (dependencies.verify ?? verifyLocalFreshKernel)({
          actor,
          canisterId,
          gatewayUrl: descriptor.gateway.url,
          deployment,
          updateSourceCanisterId,
        });
        recordLocalNodePhase(journal, index, "verified", now());
        await writeSession(options.sessionPath, journal, now());
        logger.log(
          `Verified ${label} (${index + 1}/${options.nodeLabels.length})`,
        );
      } catch (error) {
        const phase = localNodeProgress(journal, index).phase;
        throw new Error(
          `Local fleet deployment stopped at ${label} (${canisterId}) after phase ${phase}. Completed node phases remain recorded; rerun the same pinned config to resume.`,
          { cause: error },
        );
      }
    }

    completeLocalReinstall(
      journal,
      {
        planFingerprint: inputFingerprint,
        deploymentId: deployment.compiled.deploymentId,
        wasmMetadata: assertSupportedCertificateVersionsMetadata(
          deployment.wasmMetadata,
          "local deployment.wasmMetadata",
        ),
        transportWasmSha256: deployment.transportWasmSha256,
        packages: deployment.packageArtifacts,
      },
      now(),
    );
    await writeSession(options.sessionPath, journal, now());

    const nodes = localDeploymentNodes(journal).map((node) => ({
      ...node,
      url: `${localCanisterOrigin(node.canisterId, descriptor.gateway.url)}/`,
    }));
    for (const node of nodes) {
      logger.log(`${node.label} is ready at ${node.url}`);
    }
    return {
      canisterId: nodes[0]!.canisterId,
      nodes,
      developerPrincipal: identity.getPrincipal().toText(),
      authorizedPrincipals: authorizedPrincipals ?? [],
      deployment,
      session: journal,
      url: nodes[0]!.url,
    };
  });
}

export function localDeploymentFingerprint({
  configSha256,
  deployment,
  nodeLabels,
  installationNetworkIdHex,
  profile,
}: {
  configSha256: string;
  deployment: PreparedDeployment;
  nodeLabels: readonly string[];
  installationNetworkIdHex: string;
  profile: LocalEnvironment;
}): string {
  if (!SHA256_PATTERN.test(configSha256)) {
    throw new Error("Local deployment config SHA-256 is invalid");
  }
  if (!SHA256_PATTERN.test(installationNetworkIdHex)) {
    throw new Error("Local installation network ID is invalid");
  }
  return createHash("sha256")
    .update("neutron-local-reinstall-v3\0")
    .update(
      JSON.stringify({
        configSha256,
        profile,
        nodeLabels,
        installationNetworkIdHex,
        packages: semanticPackages(deployment.packageArtifacts),
        compilerId: deployment.compiled.compilerId,
        deploymentId: deployment.compiled.deploymentId,
        rawWasmSha256: deployment.rawWasmSha256,
        wasmMetadata: assertSupportedCertificateVersionsMetadata(
          deployment.wasmMetadata,
          "local deployment.wasmMetadata",
        ),
        transportWasmSha256: deployment.transportWasmSha256,
        candidSha256: deployment.candidSha256,
        stableSha256: deployment.stableSha256,
      }),
    )
    .digest("hex");
}

export async function verifyLocalFreshKernel({
  actor,
  canisterId,
  gatewayUrl,
  deployment,
  updateSourceCanisterId,
  fetchImpl = fetch,
}: {
  actor: KernelPackageInstaller;
  canisterId: string;
  gatewayUrl: string;
  deployment: PreparedDeployment;
  updateSourceCanisterId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const [runtime, installedAssetKeys] = await Promise.all([
    actor.kernel_runtime_info(),
    actor.kernel_static_query({ list: { prefix: "" } }),
  ]);
  if (runtime.deployment_id !== deployment.compiled.deploymentId) {
    throw new Error(
      `Runtime deployment ${runtime.deployment_id} does not match ${deployment.compiled.deploymentId}`,
    );
  }
  if (runtime.compiler_id !== deployment.compiled.compilerId) {
    throw new Error(
      `Runtime compiler ${runtime.compiler_id} does not match ${deployment.compiled.compilerId}`,
    );
  }
  if (runtime.assembler_id !== deployment.compiled.assemblerId) {
    throw new Error(
      `Runtime assembler ${runtime.assembler_id} does not match ${deployment.compiled.assemblerId}`,
    );
  }
  const expectedAssetKeys = freshKernelAssetKeys(deployment);
  const actualAssetKeys = [...installedAssetKeys].sort();
  if (
    actualAssetKeys.length !== expectedAssetKeys.length ||
    actualAssetKeys.some((key, index) => key !== expectedAssetKeys[index])
  ) {
    const actualSet = new Set(actualAssetKeys);
    const expectedSet = new Set(expectedAssetKeys);
    const missing = expectedAssetKeys.filter(
      (key) => !actualSet.has(key),
    );
    const unexpected = actualAssetKeys.filter(
      (key) => !expectedSet.has(key),
    );
    throw new Error(
      `Fresh local asset inventory mismatch: missing ${missing.join(", ") || "none"}; unexpected ${unexpected.join(", ") || "none"}`,
    );
  }
  const state = await readKernelPackageState({
    actor,
    canisterId,
    host: gatewayUrl,
    local: true,
    expectedModuleContents: freshKernelModuleContents(deployment),
    fetchImpl,
  });
  if (supportsBrowserSurfaceOrigins(deployment.compiled.assemblerId)) {
    assertKernelPackageStateMatchesRuntime(state, runtime);
  } else {
    assertKernelPackageBaselineMatchesRuntime(state, runtime);
  }
  assertBrowserSurfaceOriginAppIdsMatch(
    state.apps,
    state.browserSurfaceOriginAppIds,
    deployment.compiled.browserSurfaceOriginAppIds,
  );

  const origin = localCanisterOrigin(canisterId, gatewayUrl);
  const [id, candid, stable, provenance, runtimeConfigSource, browserHtml] = await Promise.all([
    fetchJson<{ id?: unknown }>(fetchImpl, origin, "/pkg/id.json"),
    fetchText(fetchImpl, origin, "/pkg/neutron.did"),
    fetchText(fetchImpl, origin, "/pkg/neutron.most"),
    fetchJson<unknown>(fetchImpl, origin, INSTALL_PROVENANCE_PATH),
    fetchText(fetchImpl, origin, "/system/runtime-config.json"),
    fetchText(fetchImpl, origin, "/"),
  ]);
  if (id.id !== canisterId) {
    throw new Error("Certified local /pkg/id.json is incorrect");
  }
  if (candid !== deployment.compiled.candid) {
    throw new Error("Certified local Candid does not match the compiled actor");
  }
  if (stable !== deployment.compiled.stable) {
    throw new Error(
      "Certified local stable-memory schema does not match the compile",
    );
  }
  assertFreshInstallProvenance(provenance, deployment);
  const runtimeConfig = parseKernelRuntimeConfig(runtimeConfigSource);
  const expectedRuntimeConfig = deploymentRuntimeConfig({
    deployment,
    canisterId,
    target: "pocketic",
    updateSourceCanisterId,
  });
  if (JSON.stringify(runtimeConfig) !== JSON.stringify(expectedRuntimeConfig)) {
    throw new Error(
      "Certified runtime config does not match the PocketIC deployment",
    );
  }
  if (browserHtml.trim().length === 0) {
    throw new Error("Certified local Neutron browser entrypoint is empty");
  }
}

function requiredLocalUpdateSource(
  descriptor: PocketIcRuntimeDescriptor,
): string {
  const canisterId = descriptor.fixtures.update_source;
  if (canisterId === undefined) {
    throw new Error(
      "PocketIC runtime is missing its provision-owned update-source fixture",
    );
  }
  return canisterId;
}

function descriptorFromRuntime(runtime: PocketIcRuntime): PocketIcRuntimeDescriptor {
  const { kind: _kind, ...descriptor } = runtime;
  return descriptor;
}

async function requireLocalJournal(
  sessionPath: string,
): Promise<ProvisionJournal & { runtime: PocketIcRuntime }> {
  const journal = await readSession(sessionPath);
  if (journal === null) {
    throw new Error(
      "No PocketIC runtime is recorded for this config; run the serve command first",
    );
  }
  if (journal.runtime.kind !== "pocketic") {
    throw new Error("Local reinstall requires a PocketIC provision session");
  }
  return journal as ProvisionJournal & { runtime: PocketIcRuntime };
}

function semanticPackages(packages: PackageArtifact[]) {
  return packages.map(({ id, version, sha256, bytes }) => ({
    id,
    version,
    sha256,
    bytes,
  }));
}

async function fetchText(
  fetchImpl: typeof fetch,
  origin: string,
  assetPath: string,
): Promise<string> {
  const url = new URL(assetPath, `${origin}/`).href;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  origin: string,
  assetPath: string,
): Promise<T> {
  const url = new URL(assetPath, `${origin}/`).href;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.json() as Promise<T>;
}

function validateOptions(options: LocalReinstallOptions): string[] {
  if (!SHA256_PATTERN.test(options.configSha256)) {
    throw new Error("Local deployment config SHA-256 is invalid");
  }
  if (options.sessionPath.length === 0) {
    throw new Error("Local deployment session path is required");
  }
  if (
    !path.isAbsolute(options.repositoryRoot) ||
    !path.isAbsolute(options.compileCacheDirectory)
  ) {
    throw new Error("Local repository and compile cache paths must be absolute");
  }
  if (
    !Number.isSafeInteger(options.developerIdentitySeed) ||
    options.developerIdentitySeed < 0 ||
    options.developerIdentitySeed > 255
  ) {
    throw new Error("Local developer identity seed must be from 0 through 255");
  }
  if (
    !Array.isArray(options.nodeLabels) ||
    options.nodeLabels.length < 1 ||
    options.nodeLabels.length > 16 ||
    new Set(options.nodeLabels).size !== options.nodeLabels.length ||
    options.nodeLabels.some(
      (label) =>
        typeof label !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}$/u.test(label),
    )
  ) {
    throw new Error(
      "Local node labels must contain 1 through 16 unique lowercase labels",
    );
  }
  if (!Array.isArray(options.packagePaths) || options.packagePaths.length < 1) {
    throw new Error("Local deployment requires pinned package archives");
  }
  if (!Array.isArray(options.authorizedPrincipals)) {
    throw new Error("Local authorized principals must be an array");
  }
  const authorizedPrincipals = options.authorizedPrincipals.map(
    (principal, index) =>
      canonicalNonAnonymousPrincipal(
        principal,
        `Local authorized principal ${index}`,
      ),
  );
  if (new Set(authorizedPrincipals).size !== authorizedPrincipals.length) {
    throw new Error("Local authorized principals must be unique");
  }
  return authorizedPrincipals;
}

function localNodeProgress(
  journal: ProvisionJournal,
  nodeIndex: number,
) {
  if (
    journal.active?.kind !== "local-reinstall" ||
    !("nodes" in journal.active.state)
  ) {
    throw new Error("Local deployment has no schema-3 node progress");
  }
  const progress = (journal.active.state as LocalReinstallState).nodes[nodeIndex];
  if (progress === undefined || progress.nodeIndex !== nodeIndex) {
    throw new Error(`Local deployment has no progress for node ${nodeIndex}`);
  }
  return progress;
}

function phaseReached(
  actual: LocalNodeDeploymentPhase,
  expected: LocalNodeDeploymentPhase,
): boolean {
  const phases: LocalNodeDeploymentPhase[] = [
    "pending",
    "allocated",
    "installing",
    "installed",
    "seeded",
    "authorized",
    "funded",
    "verified",
  ];
  return phases.indexOf(actual) >= phases.indexOf(expected);
}
