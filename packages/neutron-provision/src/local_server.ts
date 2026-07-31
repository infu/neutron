import path from "node:path";
import { ensureLocalChainServices } from "./local_chain_services.ts";
import { ensureLocalPocketIcFixtures } from "./local_fixtures.ts";
import { ensureLocalUpdateSource } from "./local_update_source.ts";
import {
  usesFullProtocolFixtures,
  type LocalEnvironment,
} from "./local_environment.ts";
import { resolvePocketIcBinary } from "./pocketic_binary.ts";
import {
  readLivePocketIcSupervisorOwner,
  servePocketIc,
  verifyPocketIcRuntime,
  type PocketIcRuntimeDescriptor,
  type PocketIcServeHandle,
} from "./pocketic_supervisor.ts";
import {
  createPocketIcJournal,
  readPocketIcRuntimeAttachment,
  readSession,
  replacePocketIcRuntime,
  withSessionLock,
  writeSession,
  type PocketIcRuntime,
  type ProvisionJournal,
} from "./session.ts";

export type LocalServerOptions = {
  profile: LocalEnvironment;
  configSha256: string;
  sessionPath: string;
  stateDirectory: string;
};

export type LocalServerDependencies = {
  ensureChainServices?: typeof ensureLocalChainServices;
  resolveBinary?: typeof resolvePocketIcBinary;
  serve?: typeof servePocketIc;
  ensureFixtures?: typeof ensureLocalPocketIcFixtures;
  ensureUpdateSource?: typeof ensureLocalUpdateSource;
  readSupervisorOwner?: typeof readLivePocketIcSupervisorOwner;
  verifyRuntime?: typeof verifyPocketIcRuntime;
  logger?: Pick<Console, "log">;
};

export async function startLocalServer(
  options: LocalServerOptions,
  dependencies: LocalServerDependencies = {},
): Promise<PocketIcServeHandle> {
  const logger = dependencies.logger ?? console;
  const paths = localRuntimePaths(options.stateDirectory);
  const attached = await attachLocalConfigToRunningServer(options, {
    ...(dependencies.readSupervisorOwner === undefined
      ? {}
      : { readSupervisorOwner: dependencies.readSupervisorOwner }),
    ...(dependencies.verifyRuntime === undefined
      ? {}
      : { verifyRuntime: dependencies.verifyRuntime }),
  });
  if (attached !== null) {
    if (usesFullProtocolFixtures(options.profile)) {
      logger.log("Verifying persistent Bitcoin and Ethereum services");
      await (dependencies.ensureChainServices ?? ensureLocalChainServices)({
        stateDirectory: options.stateDirectory,
        logger,
      });
    }
    logger.log(
      `Attached ${path.basename(options.sessionPath)} to the running PocketIC supervisor`,
    );
    return attachedServeHandle(
      attached,
      dependencies.verifyRuntime ?? verifyPocketIcRuntime,
    );
  }
  const previous = await withSessionLock(options.sessionPath, async () => {
    const journal = await readSession(options.sessionPath);
    if (journal === null) return undefined;
    assertLocalSession(journal);
    return descriptorFromRuntime(journal.runtime as PocketIcRuntime);
  });
  if (previous !== undefined && previous.profile !== options.profile) {
    throw new Error(
      "The stored PocketIC environment profile does not match this deployment config; recreate local state",
    );
  }

  if (usesFullProtocolFixtures(options.profile)) {
    logger.log("Preparing persistent Bitcoin and Ethereum services");
    await (dependencies.ensureChainServices ?? ensureLocalChainServices)({
      stateDirectory: options.stateDirectory,
      logger,
    });
  }
  logger.log("Resolving pinned PocketIC server");
  const binary = await (dependencies.resolveBinary ?? resolvePocketIcBinary)({
    cacheDirectory: paths.binaryCacheDirectory,
  });
  const handle = await (dependencies.serve ?? servePocketIc)({
    profile: options.profile,
    lockPath: paths.supervisorLockPath,
    ownerSessionPath: path.resolve(options.sessionPath),
    runtimeDirectory: paths.runtimeDirectory,
    stateDirectory: path.resolve(options.stateDirectory),
    binary,
    ...(previous === undefined ? {} : { previousDescriptor: previous }),
    publishDescriptor: async (descriptor) => {
      await withSessionLock(options.sessionPath, async () => {
        const existing = await readSession(options.sessionPath);
        const runtime = runtimeFromDescriptor(descriptor);
        const journal =
          existing === null
            ? createPocketIcJournal(options.configSha256, runtime)
            : existing;
        if (existing !== null) assertLocalSession(existing);
        replaceLocalRuntimeAndBindConfig(
          journal,
          runtime,
          options.configSha256,
        );
        await writeSession(options.sessionPath, journal);
      });
    },
  });
  let descriptor: PocketIcRuntimeDescriptor;
  try {
    logger.log("Preparing local platform fixtures");
    const fixtures = await (
      dependencies.ensureFixtures ?? ensureLocalPocketIcFixtures
    )({
      profile: options.profile,
      gatewayUrl: handle.descriptor.gateway.url,
      expectedRootKeyBase64: handle.descriptor.rootKeyBase64,
      cacheDirectory: localFixtureCacheDirectory(options.stateDirectory),
      logger,
    });
    logger.log("Preparing local update source");
    const updateSource = await (
      dependencies.ensureUpdateSource ?? ensureLocalUpdateSource
    )({
      gatewayUrl: handle.descriptor.gateway.url,
      expectedRootKeyBase64: handle.descriptor.rootKeyBase64,
      defaultEffectiveCanisterIdBase64:
        handle.descriptor.topology.defaultEffectiveCanisterId,
      cacheDirectory: localFixtureCacheDirectory(options.stateDirectory),
      ...(previous?.fixtures.update_source === undefined
        ? {}
        : { existingCanisterId: previous.fixtures.update_source }),
      recordCanisterId: async (canisterId) => {
        await recordLocalFixtureId(
          options.sessionPath,
          options.configSha256,
          "update_source",
          canisterId,
        );
      },
      logger,
    });
    descriptor = {
      ...handle.descriptor,
      fixtures: { ...fixtures, update_source: updateSource },
    };
  } catch (error) {
    await handle.stop().catch(() => undefined);
    throw error;
  }
  await withSessionLock(options.sessionPath, async () => {
    const journal = await readSession(options.sessionPath);
    if (journal === null) {
      throw new Error("PocketIC started without publishing its provision session");
    }
    assertLocalSession(journal);
    replaceLocalRuntimeAndBindConfig(
      journal,
      runtimeFromDescriptor(descriptor),
      options.configSha256,
    );
    await writeSession(options.sessionPath, journal);
  });
  logger.log(`PocketIC ${descriptor.serverVersion} is ready`);
  logger.log(`Browser gateway: ${descriptor.gateway.url}`);
  return {
    descriptor,
    wait: () => handle.wait(),
    stop: () => handle.stop(),
  };
}

export type AttachLocalConfigOptions = LocalServerOptions;

export type AttachLocalConfigDependencies = Pick<
  LocalServerDependencies,
  "readSupervisorOwner" | "verifyRuntime"
>;

/**
 * Copy the live supervisor runtime into another config's sole session. The
 * repository lock contains only the owning-session pointer; the owner session
 * remains the only source of the runtime descriptor.
 */
export async function attachLocalConfigToRunningServer(
  options: AttachLocalConfigOptions,
  dependencies: AttachLocalConfigDependencies = {},
): Promise<PocketIcRuntimeDescriptor | null> {
  const paths = localRuntimePaths(options.stateDirectory);
  const owner = await (
    dependencies.readSupervisorOwner ?? readLivePocketIcSupervisorOwner
  )(paths.supervisorLockPath);
  if (owner === null) return null;

  const ownerRuntime = await withSessionLock(
    owner.ownerSessionPath,
    () => readPocketIcRuntimeAttachment(owner.ownerSessionPath),
  );
  const descriptor = descriptorFromRuntime(ownerRuntime);
  if (descriptor.profile !== options.profile) {
    throw new Error(
      "The running PocketIC environment profile does not match this deployment config; recreate local state",
    );
  }
  if (descriptor.stateDirectory !== path.resolve(options.stateDirectory)) {
    throw new Error(
      "The live PocketIC supervisor belongs to a different repository state directory",
    );
  }
  await (dependencies.verifyRuntime ?? verifyPocketIcRuntime)(descriptor);

  await withSessionLock(options.sessionPath, async () => {
    const existing = await readSession(options.sessionPath);
    const runtime = runtimeFromDescriptor(descriptor);
    const journal =
      existing === null
        ? createPocketIcJournal(options.configSha256, runtime)
        : existing;
    if (existing !== null) assertLocalSession(existing);
    replaceLocalRuntimeAndBindConfig(journal, runtime, options.configSha256);
    await writeSession(options.sessionPath, journal);
  });
  return descriptor;
}

export async function readLocalServerStatus({
  profile,
  configSha256,
  sessionPath,
}: Pick<
  LocalServerOptions,
  "profile" | "configSha256" | "sessionPath"
>): Promise<{
  session: ProvisionJournal;
  descriptor: PocketIcRuntimeDescriptor;
  healthy: true;
}> {
  const session = await readSession(sessionPath);
  if (session === null) {
    throw new Error("No provision session exists for this config");
  }
  assertLocalSession(session);
  if (session.configSha256 !== configSha256) {
    throw new Error(
      "Local provision session does not match the selected deployment config; run reinstall",
    );
  }
  const descriptor = descriptorFromRuntime(session.runtime as PocketIcRuntime);
  if (descriptor.profile !== profile) {
    throw new Error(
      "PocketIC runtime profile does not match the selected deployment config",
    );
  }
  await verifyPocketIcRuntime(descriptor);
  return { session, descriptor, healthy: true };
}

export function localRuntimePaths(stateDirectory: string): {
  runtimeDirectory: string;
  binaryCacheDirectory: string;
  supervisorLockPath: string;
} {
  const neutronDirectory = path.dirname(path.resolve(stateDirectory));
  return {
    runtimeDirectory: path.join(neutronDirectory, "runtime"),
    binaryCacheDirectory: path.join(neutronDirectory, "cache", "bin"),
    supervisorLockPath: path.join(neutronDirectory, "pocketic-supervisor.lock"),
  };
}

export function localFixtureCacheDirectory(stateDirectory: string): string {
  const neutronDirectory = path.dirname(path.resolve(stateDirectory));
  return path.join(neutronDirectory, "cache", "fixtures");
}

function attachedServeHandle(
  descriptor: PocketIcRuntimeDescriptor,
  verifyRuntime: typeof verifyPocketIcRuntime,
): PocketIcServeHandle {
  let stopped = false;
  return {
    descriptor,
    async wait(): Promise<void> {
      while (!stopped) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        if (!stopped) await verifyRuntime(descriptor);
      }
    },
    async stop(): Promise<void> {
      // This process is an attachment, not the supervisor owner. Stopping it
      // must never tear down the shared PocketIC server.
      stopped = true;
    },
  };
}

export function runtimeFromDescriptor(
  descriptor: PocketIcRuntimeDescriptor,
): PocketIcRuntime {
  return { kind: "pocketic", ...descriptor };
}

export function descriptorFromRuntime(
  runtime: PocketIcRuntime,
): PocketIcRuntimeDescriptor {
  const { kind: _kind, ...descriptor } = runtime;
  return descriptor;
}

function assertLocalSession(journal: ProvisionJournal): void {
  if (journal.runtime.kind !== "pocketic") {
    throw new Error("The existing provision session targets the IC, not PocketIC");
  }
}

/**
 * Replace only the runtime attachment. A changed config is not considered
 * deployed until the full local reinstall commits its receipt. Likewise, a
 * runtime with a different persistent-state identity cannot retain a receipt
 * for a canister which belonged to the previous PocketIC state.
 */
function replaceLocalRuntimeAndBindConfig(
  journal: ProvisionJournal,
  runtime: PocketIcRuntime,
  configSha256: string,
): void {
  const previous = descriptorFromRuntime(journal.runtime as PocketIcRuntime);
  const sameState = samePocketIcStateIdentity(previous, descriptorFromRuntime(runtime));
  if (!sameState) {
    delete journal.current;
    delete journal.localFleet;
    delete journal.active;
  }
  replacePocketIcRuntime(journal, runtime);
  if (
    journal.configSha256 === configSha256 ||
    (journal.current === undefined && journal.active === undefined)
  ) {
    journal.configSha256 = configSha256;
  }
}

function samePocketIcStateIdentity(
  previous: PocketIcRuntimeDescriptor,
  next: PocketIcRuntimeDescriptor,
): boolean {
  return (
    previous.stateDirectory === next.stateDirectory &&
    previous.instanceId === next.instanceId &&
    previous.instanceConfigDigest === next.instanceConfigDigest &&
    previous.rootKeyBase64 === next.rootKeyBase64 &&
    previous.topology.digest === next.topology.digest &&
    previous.topology.defaultEffectiveCanisterId ===
      next.topology.defaultEffectiveCanisterId &&
    sameStringRecord(previous.topology.subnetIds, next.topology.subnetIds)
  );
}

function sameStringRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value,
    )
  );
}

async function recordLocalFixtureId(
  sessionPath: string,
  configSha256: string,
  name: string,
  canisterId: string,
): Promise<void> {
  await withSessionLock(sessionPath, async () => {
    const journal = await readSession(sessionPath);
    if (journal === null) {
      throw new Error("PocketIC started without publishing its provision session");
    }
    assertLocalSession(journal);
    const current = descriptorFromRuntime(journal.runtime as PocketIcRuntime);
    replacePocketIcRuntime(
      journal,
      runtimeFromDescriptor({
        ...current,
        fixtures: { ...current.fixtures, [name]: canisterId },
      }),
    );
    // Recording another fixture does not make a changed package config current.
    if (
      journal.configSha256 === configSha256 ||
      (journal.current === undefined && journal.active === undefined)
    ) {
      journal.configSha256 = configSha256;
    }
    await writeSession(sessionPath, journal);
  });
}
