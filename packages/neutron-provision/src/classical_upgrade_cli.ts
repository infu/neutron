#!/usr/bin/env bun

import type { Identity } from "@dfinity/agent";
import { Secp256k1KeyIdentity } from "@icp-sdk/core/identity/secp256k1";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  assertKernelPackageBaselineMatchesRuntime,
  compilePackages,
  createDeploymentNonce,
  deployPreparedPackages,
  prepareCompleteDeploymentBuildRecord,
  preparePackageInstall,
  type RetainedDeploymentPackageEvidence,
} from "neutron-compiler/src/install.js";
import { prepareDeterministicWasmTransport } from "neutron-compiler/src/deployment_record.js";
import { wasmCustomSections } from "neutron-tools/src/wasm_metadata.js";
import {
  controllerPersistenceUpgradeActor,
  type ControllerUpgradePersistence,
} from "./classical_upgrade.ts";
import { IcProvisionClient } from "./ic_client.ts";
import { assetUrl, readKernelPackageState } from "./kernel_state.ts";

type Options = Readonly<{
  canisterId: string;
  packagePath: string;
  expectedPackageSha256: string;
  identityPemPath: string;
  persistenceMode: ControllerUpgradePersistence;
  execute: boolean;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const INSTALL_PROVENANCE_PATH = "/system/install-provenance.json";

type InstalledProvenance = Readonly<{
  format: 1;
  apps: Readonly<
    Record<
      string,
      Readonly<Record<string, unknown> & { package_digest: string }>
    >
  >;
}>;

export async function runPersistenceUpgradeBridge(
  options: Options,
): Promise<void> {
  if (!SHA256.test(options.expectedPackageSha256)) {
    throw new Error("--expected-package-sha256 must be lowercase SHA-256");
  }

  const [archiveBuffer, pem] = await Promise.all([
    readFile(options.packagePath),
    readFile(options.identityPemPath, "utf8"),
  ]);
  const archive = new Uint8Array(archiveBuffer);
  const archiveSha256 = sha256Hex(archive);
  if (archiveSha256 !== options.expectedPackageSha256) {
    throw new Error(
      `Kernel archive SHA-256 ${archiveSha256} does not match reviewed ${options.expectedPackageSha256}`,
    );
  }
  const preparedPackage = preparePackageInstall(archive);
  if (!preparedPackage.isKernel) {
    throw new Error("The bridge accepts only a Kernel package");
  }

  // @icp-sdk/core and @dfinity/agent implement the same structural Identity
  // contract; the cast avoids coupling this one-time operational tool to two
  // copies of otherwise equivalent agent type declarations.
  const identity = Secp256k1KeyIdentity.fromPem(pem) as unknown as Identity;
  const client = await IcProvisionClient.create({ identity });
  if (client.deployer.toText() !== identity.getPrincipal().toText()) {
    throw new Error("Loaded identity principal changed during agent creation");
  }

  const actor = client.kernelActor(options.canisterId);
  const [beforeRuntime, beforeOperational, beforeAccess, pending] =
    await Promise.all([
      actor.kernel_runtime_info(),
      client.operationalState(options.canisterId),
      client.kernelAccessSnapshot(options.canisterId),
      actor.kernel_install_status(null),
    ]);
  if (pending.length !== 0) {
    throw new Error(
      `Canister has pending deployment ${pending[0]!.deployment_id}; finish or discard it first`,
    );
  }
  if (!beforeOperational.controllers.includes(client.deployer.toText())) {
    throw new Error("The selected identity is not a canister controller");
  }
  if (!beforeAccess.authorizedPrincipals.includes(client.deployer.toText())) {
    throw new Error("The selected controller is not Kernel-authorized");
  }

  const state = await readKernelPackageState({
    actor,
    canisterId: options.canisterId,
    host: client.host,
    local: false,
  });
  assertKernelPackageBaselineMatchesRuntime(state, beforeRuntime);
  const installedKernelVersion = state.existingConfigs.kernel?.version;
  if (installedKernelVersion === undefined) {
    throw new Error("Installed package state has no Kernel manifest");
  }
  if (preparedPackage.manifest.version <= installedKernelVersion) {
    throw new Error(
      `Kernel package v${preparedPackage.manifest.version} is not newer than installed v${installedKernelVersion}`,
    );
  }

  const compiled = await compilePackages({
    packages: [preparedPackage],
    existingModules: state.existingModules,
    existingConfigs: state.existingConfigs,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds:
      state.browserSurfaceOriginAppIds,
    existingStable: state.previousStable,
    connectionProviderSupport: state.connectionProviderSupport,
    deploymentNonce: createDeploymentNonce(),
    vetKeysEnvironment: "production",
    persistenceMode: options.persistenceMode,
    versionPolicy: "strict-upgrade",
  });
  assertStatePreservingPlan(compiled.migrationPlan);
  const enhancedPersistenceSections = wasmCustomSections(
    compiled.wasm,
    "icp:private enhanced-orthogonal-persistence",
  ).length;
  if (
    (options.persistenceMode === "enhanced" &&
      enhancedPersistenceSections !== 1) ||
    (options.persistenceMode === "classical" &&
      enhancedPersistenceSections !== 0)
  ) {
    throw new Error(
      `Compiled Kernel does not match requested ${options.persistenceMode} persistence`,
    );
  }

  const provenance = await readInstalledProvenance(options.canisterId);
  const retainedPackageEvidence = Object.freeze(
    Object.fromEntries(
      Object.entries(state.apps)
        .filter(([appId]) => appId !== "kernel")
        .map(([appId, app]) => {
          const digest = provenance.apps[appId]?.package_digest;
          return [
            appId,
            Object.freeze({
              version: app.version,
              archive: digest
                ? Object.freeze({
                    state: "outer_archive_digest_only" as const,
                    sha256: digest,
                  })
                : Object.freeze({ state: "legacy_unavailable" as const }),
              package_information: Object.freeze({
                state: "legacy_unavailable" as const,
              }),
            }),
          ];
        }),
    ) as Record<string, RetainedDeploymentPackageEvidence>,
  );
  const reviewed = prepareCompleteDeploymentBuildRecord({
    targetCanisterId: options.canisterId,
    packages: [preparedPackage],
    state,
    compiled,
    expectedDeploymentId: beforeRuntime.deployment_id,
    retainedPackageEvidence,
  });
  const expectedTransportSha256 = prepareDeterministicWasmTransport(
    compiled.wasm,
  ).wasmRecord.transport.sha256;

  console.log(
    JSON.stringify(
      {
        mode: options.execute ? "execute" : "dry-run",
        persistence_mode: options.persistenceMode,
        canister: options.canisterId,
        caller: client.deployer.toText(),
        installed_kernel_version: installedKernelVersion,
        target_kernel_version: preparedPackage.manifest.version,
        package_sha256: archiveSha256,
        previous_deployment_id: beforeRuntime.deployment_id,
        target_deployment_id: compiled.deploymentId,
        target_module_sha256: expectedTransportSha256,
        retained_apps: Object.keys(state.apps).filter((id) => id !== "kernel"),
        managed_memories: compiled.managedMemoryInventory,
      },
      null,
      2,
    ),
  );
  if (!options.execute) return;

  await verifyPublishedSourceOffer(preparedPackage.packageRecord?.source);
  const nextProvenance: InstalledProvenance = Object.freeze({
    format: 1,
    apps: Object.freeze({
      ...provenance.apps,
      kernel: Object.freeze({
        kind: "manual",
        acquisition: "file",
        package_digest: archiveSha256,
      }),
    }),
  });
  const bridgedActor = controllerPersistenceUpgradeActor({
    actor,
    management: client.managementActor(options.canisterId),
    targetCanisterId: options.canisterId,
    persistenceMode: options.persistenceMode,
  });
  await deployPreparedPackages({
    actor: bridgedActor,
    targetCanisterId: options.canisterId,
    packages: [preparedPackage],
    compiled,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds:
      state.browserSurfaceOriginAppIds,
    previousModulePaths: state.existingModules.map(({ path }) => path),
    stagedAssets: [
      {
        target: INSTALL_PROVENANCE_PATH,
        content: new TextEncoder().encode(JSON.stringify(nextProvenance)),
        contentType: "application/json",
      },
    ],
    deploymentBuildRecord: reviewed.record,
    expectedDeploymentId: beforeRuntime.deployment_id,
    onStep: (step) => console.log(`bridge:${step}`),
  });

  const [afterRuntime, afterOperational, afterPending] = await Promise.all([
    actor.kernel_runtime_info(),
    client.operationalState(options.canisterId),
    actor.kernel_install_status(null),
  ]);
  if (afterRuntime.deployment_id !== compiled.deploymentId) {
    throw new Error("Running deployment does not match the compiled target");
  }
  if (afterPending.length !== 0) {
    throw new Error("Install journal remained pending after bridge commit");
  }
  if (afterOperational.moduleHash !== expectedTransportSha256) {
    throw new Error(
      `Installed module ${afterOperational.moduleHash ?? "none"} does not match ${expectedTransportSha256}`,
    );
  }
  if (
    JSON.stringify(afterOperational.controllers) !==
    JSON.stringify(beforeOperational.controllers)
  ) {
    throw new Error("Canister controllers changed during bridge upgrade");
  }
  if (
    JSON.stringify(memoryIdentity(afterRuntime.memories)) !==
    JSON.stringify(memoryIdentity(beforeRuntime.memories))
  ) {
    throw new Error("Managed-memory identity changed during bridge upgrade");
  }
  if (
    JSON.stringify(appIdentity(afterRuntime.apps)) !==
    JSON.stringify(
      appIdentity(beforeRuntime.apps).map((app) =>
        app.id === "kernel"
          ? { ...app, version: preparedPackage.manifest.version }
          : app,
      ),
    )
  ) {
    throw new Error("Installed application identity changed unexpectedly");
  }
  console.log(
    `${options.persistenceMode} Kernel bridge committed and verified.`,
  );
}

function assertStatePreservingPlan(plan: {
  upgrades: Array<{ kind: string; owner: string; memoryId: string }>;
  removedApps: string[];
  destructiveMemoryRoots: Array<{ owner: string; memoryId: string }>;
}): void {
  if (
    plan.removedApps.length !== 0 ||
    plan.destructiveMemoryRoots.length !== 0 ||
    plan.upgrades.some(({ kind }) => kind !== "keep")
  ) {
    throw new Error(
      "Persistence bridge requires an all-keep managed-memory plan",
    );
  }
}

async function readInstalledProvenance(
  canisterId: string,
): Promise<InstalledProvenance> {
  const response = await fetch(
    assetUrl({
      canisterId,
      host: "https://icp-api.io",
      local: false,
      path: INSTALL_PROVENANCE_PATH,
    }),
    { cache: "no-store", redirect: "error" },
  );
  if (response.status === 404) {
    return Object.freeze({ format: 1, apps: Object.freeze({}) });
  }
  if (!response.ok) {
    throw new Error(`Failed to read installed provenance: ${response.status}`);
  }
  const value = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("format" in value) ||
    value.format !== 1 ||
    !("apps" in value) ||
    typeof value.apps !== "object" ||
    value.apps === null ||
    Array.isArray(value.apps)
  ) {
    throw new Error("Installed provenance has an unsupported format");
  }
  const apps = value.apps as Record<string, Record<string, unknown>>;
  for (const [appId, entry] of Object.entries(apps)) {
    if (
      typeof entry.package_digest !== "string" ||
      !SHA256.test(entry.package_digest)
    ) {
      throw new Error(
        `Installed provenance for ${appId} has an invalid digest`,
      );
    }
  }
  return Object.freeze({
    format: 1,
    apps: Object.freeze(apps),
  }) as InstalledProvenance;
}

async function verifyPublishedSourceOffer(source: unknown): Promise<void> {
  if (
    typeof source !== "object" ||
    source === null ||
    !("kind" in source) ||
    source.kind !== "https" ||
    !("url" in source) ||
    typeof source.url !== "string" ||
    !("sha256" in source) ||
    typeof source.sha256 !== "string" ||
    !("bytes" in source) ||
    typeof source.bytes !== "number"
  ) {
    throw new Error("Kernel package must carry an HTTPS source offer");
  }
  const response = await fetch(source.url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `Published Kernel source is unavailable: ${response.status}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== source.bytes || sha256Hex(bytes) !== source.sha256) {
    throw new Error(
      "Published Kernel source does not match its package record",
    );
  }
}

function memoryIdentity(
  memories: Array<{
    owner: string;
    id: string;
    version: number | bigint;
    schema: string;
  }>,
) {
  return memories
    .map(({ owner, id, version, schema }) => ({
      owner,
      id,
      version: Number(version),
      schema,
    }))
    .sort((left, right) =>
      `${left.owner}/${left.id}`.localeCompare(`${right.owner}/${right.id}`),
    );
}

function appIdentity(
  apps: Array<{
    scope: { app_id: string; installation_uid: bigint | number };
    version: number | bigint;
  }>,
) {
  return apps
    .map(({ scope, version }) => ({
      id: scope.app_id,
      installation_uid: String(scope.installation_uid),
      version: Number(version),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--execute") {
      execute = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  return {
    canisterId: required("--canister"),
    packagePath: required("--package"),
    expectedPackageSha256: required("--expected-package-sha256"),
    identityPemPath: required("--identity-pem"),
    persistenceMode: parsePersistenceMode(required("--persistence")),
    execute,
  };
}

function parsePersistenceMode(value: string): ControllerUpgradePersistence {
  if (value === "classical" || value === "enhanced") return value;
  throw new Error("--persistence must be classical or enhanced");
}

if (import.meta.main) {
  runPersistenceUpgradeBridge(parseOptions(process.argv.slice(2))).catch(
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
