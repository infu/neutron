import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import {
  parseLocalEnvironment,
  type LocalEnvironment,
} from "./local_environment.ts";
import {
  POCKET_IC_ARTIFACTS,
  POCKET_IC_IDLE_TTL_SECONDS,
  POCKET_IC_SERVER_VERSION,
  pocketIcServerArguments,
  type ResolvedPocketIcBinary,
} from "./pocketic_binary.ts";
import {
  NEUTRON_POCKET_IC_GATEWAY_HOST,
  NEUTRON_POCKET_IC_GATEWAY_IP,
  NEUTRON_POCKET_IC_GATEWAY_PORT,
  PocketIcRestClient,
  assertTopologySummary,
  createNeutronPocketIcInstanceConfig,
  normalizePocketIcControlUrl,
  pocketIcInstanceConfigDigest,
  pocketIcSubnetKinds,
  summarizePocketIcTopology,
  type NeutronPocketIcSubnetKind,
  type PocketIcFetch,
  type PocketIcGatewayStatus,
  type PocketIcInstanceConfig,
  type PocketIcTopology,
  type PocketIcTopologySummary,
} from "./pocketic_rest.ts";

const LOCK_SCHEMA = 1;
const LOCK_MAX_BYTES = 8 * 1024;
const FIXTURE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FIXTURES = 64;
const DEFAULT_SERVER_READY_TIMEOUT_MS = 30_000;
const DEFAULT_GATEWAY_READY_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_HEALTH_INTERVAL_MS = 1_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export type PocketIcRuntimeDescriptor = {
  profile: LocalEnvironment;
  serverVersion: typeof POCKET_IC_SERVER_VERSION;
  binarySha256: string;
  pid: number;
  processIdentity: string;
  startedAt: string;
  idleTtlSeconds: typeof POCKET_IC_IDLE_TTL_SECONDS;
  controlUrl: string;
  instanceId: number;
  instanceConfigDigest: string;
  stateDirectory: string;
  gateway: {
    id: number;
    url: `http://${typeof NEUTRON_POCKET_IC_GATEWAY_HOST}:${typeof NEUTRON_POCKET_IC_GATEWAY_PORT}/`;
    bind: typeof NEUTRON_POCKET_IC_GATEWAY_IP;
    port: typeof NEUTRON_POCKET_IC_GATEWAY_PORT;
  };
  rootKeyBase64: string;
  topology: PocketIcTopologySummary;
  fixtures: Record<string, string>;
};

export type PocketIcProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type LaunchedPocketIcProcess = {
  pid: number;
  exited: Promise<PocketIcProcessExit>;
};

export type PocketIcProcessHost = {
  launch(command: string, args: readonly string[]): Promise<LaunchedPocketIcProcess>;
  processIdentity(pid: number): Promise<string | null>;
  terminate(pid: number): Promise<void>;
};

export type PocketIcRuntimeAttachment = {
  descriptor: PocketIcRuntimeDescriptor;
  client: PocketIcRestClient;
  topology: PocketIcTopology;
  gatewayStatus: PocketIcGatewayStatus;
};

export type VerifyPocketIcRuntimeOptions = {
  fetcher?: PocketIcFetch;
  processHost?: PocketIcProcessHost;
  expectedBinarySha256?: string;
  expectedInstanceConfig?: PocketIcInstanceConfig;
};

export type ServePocketIcOptions = {
  profile: LocalEnvironment;
  lockPath: string;
  ownerSessionPath: string;
  runtimeDirectory: string;
  stateDirectory: string;
  binary: ResolvedPocketIcBinary;
  previousDescriptor?: unknown;
  fixtures?: Record<string, string>;
  publishDescriptor?: (descriptor: PocketIcRuntimeDescriptor) => Promise<void>;
  fetcher?: PocketIcFetch;
  processHost?: PocketIcProcessHost;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  serverReadyTimeoutMs?: number;
  gatewayReadyTimeoutMs?: number;
  healthIntervalMs?: number;
  stopTimeoutMs?: number;
};

export type PocketIcServeHandle = {
  descriptor: PocketIcRuntimeDescriptor;
  /** Remains pending while the supervised PocketIC process is healthy. */
  wait(): Promise<void>;
  /** Stops progress/gateway/instance, terminates the server, and releases the lock. */
  stop(): Promise<void>;
};

type PocketIcSupervisorLock = {
  path: string;
  release(): Promise<void>;
};

type SupervisorLockContents = {
  schema: typeof LOCK_SCHEMA;
  pid: number;
  processIdentity: string;
  ownerSessionPath: string;
  nonce: string;
  acquiredAt: string;
};

export type PocketIcSupervisorOwner = Pick<
  SupervisorLockContents,
  "pid" | "processIdentity" | "ownerSessionPath"
>;

export async function servePocketIc(
  options: ServePocketIcOptions,
): Promise<PocketIcServeHandle> {
  const processHost = options.processHost ?? nodePocketIcProcessHost;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const lock = await acquirePocketIcSupervisorLock(
    options.lockPath,
    options.ownerSessionPath,
    processHost.processIdentity,
    now,
  );
  let launched: LaunchedPocketIcProcess | undefined;
  let portFile: string | undefined;

  try {
    assertResolvedBinary(options.binary);
    await ensurePrivateDirectory(path.resolve(options.runtimeDirectory));
    const stateDirectory = path.resolve(options.stateDirectory);
    await ensurePrivateDirectory(stateDirectory);
    const instanceConfig = createNeutronPocketIcInstanceConfig({
      profile: options.profile,
      stateDirectory,
    });

    if (options.previousDescriptor !== undefined) {
      const previous = parsePocketIcRuntimeDescriptor(options.previousDescriptor);
      if (previous.profile !== options.profile) {
        throw new Error(
          "The running PocketIC environment profile does not match this deployment config; recreate local state",
        );
      }
      if (previous.binarySha256 !== options.binary.sha256) {
        throw new Error(
          "The running PocketIC binary does not match the pinned binary for this supervisor",
        );
      }
      if (
        previous.instanceConfigDigest !==
        pocketIcInstanceConfigDigest(instanceConfig)
      ) {
        throw new Error(
          "The running PocketIC instance does not match the requested Neutron local state directory",
        );
      }
      try {
        const attachment = await verifyPocketIcRuntime(previous, {
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
          processHost,
          expectedBinarySha256: options.binary.sha256,
          expectedInstanceConfig: instanceConfig,
        });
        return new PocketIcServeHandleImpl({
          attachment,
          lock,
          processHost,
          sleep,
          healthIntervalMs: positiveDuration(
            options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
            "PocketIC health interval",
          ),
          stopTimeoutMs: positiveDuration(
            options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
            "PocketIC stop timeout",
          ),
        });
      } catch (error) {
        const identity = await processHost.processIdentity(previous.pid);
        if (identity === previous.processIdentity) {
          await processHost.terminate(previous.pid);
          await waitForProcessToDisappear(
            previous.pid,
            previous.processIdentity,
            processHost,
            sleep,
            options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
          );
        }
        // A recorded runtime which is no longer alive is stale. A live runtime
        // with a different process identity is never killed.
        if (identity !== null && identity !== previous.processIdentity) {
          throw new Error(
            "Refusing to replace PocketIC because its recorded PID now belongs to another process",
            { cause: error },
          );
        }
      }
    }

    const runtimeDirectory = path.resolve(options.runtimeDirectory);
    portFile = path.join(
      runtimeDirectory,
      `pocketic-${process.pid}-${randomBytes(8).toString("hex")}.port`,
    );
    launched = await processHost.launch(
      options.binary.path,
      pocketIcServerArguments(portFile),
    );
    const port = await waitForPortFile(
      portFile,
      launched,
      sleep,
      positiveDuration(
        options.serverReadyTimeoutMs ?? DEFAULT_SERVER_READY_TIMEOUT_MS,
        "PocketIC server readiness timeout",
      ),
    );
    const controlUrl = normalizePocketIcControlUrl(`http://127.0.0.1:${port}/`);
    const client = new PocketIcRestClient(controlUrl, {
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
    await retryUntil(
      () => client.assertServerHealthy(),
      sleep,
      options.serverReadyTimeoutMs ?? DEFAULT_SERVER_READY_TIMEOUT_MS,
      "PocketIC server did not become healthy",
      launched,
    );

    const created = await client.createInstance(instanceConfig, options.profile);
    if (!(await client.isAutoProgressEnabled(created.instanceId))) {
      throw new Error("PocketIC did not enable automatic progress for the new instance");
    }
    const gatewayStatus = await retryUntil(
      () => client.gatewayStatus(),
      sleep,
      positiveDuration(
        options.gatewayReadyTimeoutMs ?? DEFAULT_GATEWAY_READY_TIMEOUT_MS,
        "PocketIC gateway readiness timeout",
      ),
      "PocketIC browser gateway did not become healthy",
      launched,
    );
    const processIdentity = await processHost.processIdentity(launched.pid);
    if (processIdentity === null) {
      throw new Error("PocketIC exited before its process identity could be recorded");
    }

    const descriptor: PocketIcRuntimeDescriptor = {
      profile: options.profile,
      serverVersion: POCKET_IC_SERVER_VERSION,
      binarySha256: options.binary.sha256,
      pid: launched.pid,
      processIdentity,
      startedAt: now().toISOString(),
      idleTtlSeconds: POCKET_IC_IDLE_TTL_SECONDS,
      controlUrl,
      instanceId: created.instanceId,
      instanceConfigDigest: pocketIcInstanceConfigDigest(instanceConfig),
      stateDirectory,
      gateway: {
        id: created.gatewayId,
        url: `http://${NEUTRON_POCKET_IC_GATEWAY_HOST}:${NEUTRON_POCKET_IC_GATEWAY_PORT}/`,
        bind: NEUTRON_POCKET_IC_GATEWAY_IP,
        port: NEUTRON_POCKET_IC_GATEWAY_PORT,
      },
      rootKeyBase64: gatewayStatus.rootKeyBase64,
      topology: created.topologySummary,
      fixtures: canonicalFixtures(options.fixtures ?? {}),
    };
    assertPocketIcRuntimeDescriptor(descriptor);
    await options.publishDescriptor?.(descriptor);
    const attachment: PocketIcRuntimeAttachment = {
      descriptor,
      client,
      topology: created.topology,
      gatewayStatus,
    };
    await rm(portFile, { force: true });
    portFile = undefined;
    return new PocketIcServeHandleImpl({
      attachment,
      lock,
      processHost,
      sleep,
      healthIntervalMs: positiveDuration(
        options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
        "PocketIC health interval",
      ),
      stopTimeoutMs: positiveDuration(
        options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
        "PocketIC stop timeout",
      ),
    });
  } catch (error) {
    if (launched !== undefined) {
      await processHost.terminate(launched.pid).catch(() => undefined);
    }
    if (portFile !== undefined) {
      await rm(portFile, { force: true }).catch(() => undefined);
    }
    await lock.release().catch(() => undefined);
    throw error;
  }
}

export async function verifyPocketIcRuntime(
  value: unknown,
  options: VerifyPocketIcRuntimeOptions = {},
): Promise<PocketIcRuntimeAttachment> {
  const descriptor = parsePocketIcRuntimeDescriptor(value);
  if (
    options.expectedBinarySha256 !== undefined &&
    descriptor.binarySha256 !== options.expectedBinarySha256
  ) {
    throw new Error("PocketIC binary checksum does not match the active supervisor");
  }
  if (
    options.expectedInstanceConfig !== undefined &&
    descriptor.instanceConfigDigest !==
      pocketIcInstanceConfigDigest(options.expectedInstanceConfig)
  ) {
    throw new Error("PocketIC instance config does not match the deployment session");
  }
  const processHost = options.processHost ?? nodePocketIcProcessHost;
  const identity = await processHost.processIdentity(descriptor.pid);
  if (identity !== descriptor.processIdentity) {
    throw new Error("PocketIC process identity does not match the deployment session");
  }

  const client = new PocketIcRestClient(descriptor.controlUrl, {
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  await client.assertServerHealthy();
  const [instances, topology, autoProgress, gatewayStatus] = await Promise.all([
    client.listInstances(),
    client.readTopology(descriptor.instanceId, descriptor.profile),
    client.isAutoProgressEnabled(descriptor.instanceId),
    client.gatewayStatus(
      `http://${descriptor.gateway.bind}:${descriptor.gateway.port}/`,
    ),
  ]);
  const instanceState = instances[descriptor.instanceId];
  // Automatic progress briefly reports Busy while advancing time or ticking
  // canisters. That is normal healthy activity, not an unavailable instance.
  if (
    instanceState !== "Available" &&
    !(typeof instanceState === "string" && instanceState.startsWith("Busy("))
  ) {
    throw new Error(
      `PocketIC instance ${descriptor.instanceId} is not available (${String(instanceState)})`,
    );
  }
  if (!autoProgress) {
    throw new Error(`PocketIC instance ${descriptor.instanceId} is not progressing`);
  }
  const summary = summarizePocketIcTopology(
    topology,
    descriptor.profile,
  ).summary;
  assertTopologySummary(summary, descriptor.topology, descriptor.profile);
  if (gatewayStatus.rootKeyBase64 !== descriptor.rootKeyBase64) {
    throw new Error("PocketIC gateway root key does not match the deployment session");
  }
  return { descriptor, client, topology, gatewayStatus };
}

export function parsePocketIcRuntimeDescriptor(
  value: unknown,
): PocketIcRuntimeDescriptor {
  assertPocketIcRuntimeDescriptor(value);
  return value;
}

export function assertPocketIcRuntimeDescriptor(
  value: unknown,
): asserts value is PocketIcRuntimeDescriptor {
  const descriptor = record(value, "PocketIC runtime descriptor");
  exactKeys(
    descriptor,
    [
      "profile",
      "serverVersion",
      "binarySha256",
      "pid",
      "processIdentity",
      "startedAt",
      "idleTtlSeconds",
      "controlUrl",
      "instanceId",
      "instanceConfigDigest",
      "stateDirectory",
      "gateway",
      "rootKeyBase64",
      "topology",
      "fixtures",
    ],
    "PocketIC runtime descriptor",
  );
  parseLocalEnvironment(descriptor.profile, "PocketIC runtime profile");
  if (descriptor.serverVersion !== POCKET_IC_SERVER_VERSION) {
    invalidDescriptor(`serverVersion must be ${POCKET_IC_SERVER_VERSION}`);
  }
  sha256(descriptor.binarySha256, "binarySha256");
  const pinnedHashes = new Set(POCKET_IC_ARTIFACTS.map((artifact) => artifact.binarySha256));
  if (!pinnedHashes.has(descriptor.binarySha256 as string)) {
    invalidDescriptor("binarySha256 is not a pinned PocketIC release executable");
  }
  positiveInteger(descriptor.pid, "pid");
  if (
    typeof descriptor.processIdentity !== "string" ||
    descriptor.processIdentity.length === 0 ||
    descriptor.processIdentity.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(descriptor.processIdentity)
  ) {
    invalidDescriptor("processIdentity must be a short printable string");
  }
  canonicalTimestamp(descriptor.startedAt, "startedAt");
  if (descriptor.idleTtlSeconds !== POCKET_IC_IDLE_TTL_SECONDS) {
    invalidDescriptor(`idleTtlSeconds must be ${POCKET_IC_IDLE_TTL_SECONDS}`);
  }
  const controlUrl = normalizePocketIcControlUrl(string(descriptor.controlUrl, "controlUrl"));
  if (controlUrl !== descriptor.controlUrl) invalidDescriptor("controlUrl is not canonical");
  nonnegativeInteger(descriptor.instanceId, "instanceId");
  sha256(descriptor.instanceConfigDigest, "instanceConfigDigest");
  const stateDirectory = string(descriptor.stateDirectory, "stateDirectory");
  if (!path.isAbsolute(stateDirectory) || path.normalize(stateDirectory) !== stateDirectory) {
    invalidDescriptor("stateDirectory must be a normalized absolute path");
  }
  const expectedConfigDigest = pocketIcInstanceConfigDigest(
    createNeutronPocketIcInstanceConfig({
      profile: descriptor.profile as LocalEnvironment,
      stateDirectory,
    }),
  );
  if (descriptor.instanceConfigDigest !== expectedConfigDigest) {
    invalidDescriptor("instanceConfigDigest does not match stateDirectory and profile");
  }

  const gateway = record(descriptor.gateway, "PocketIC runtime descriptor.gateway");
  exactKeys(gateway, ["id", "url", "bind", "port"], "PocketIC runtime descriptor.gateway");
  nonnegativeInteger(gateway.id, "gateway.id");
  if (
    gateway.url !==
    `http://${NEUTRON_POCKET_IC_GATEWAY_HOST}:${NEUTRON_POCKET_IC_GATEWAY_PORT}/`
  ) {
    invalidDescriptor("gateway.url must be the fixed localhost browser origin");
  }
  if (gateway.bind !== NEUTRON_POCKET_IC_GATEWAY_IP) {
    invalidDescriptor(`gateway.bind must be ${NEUTRON_POCKET_IC_GATEWAY_IP}`);
  }
  if (gateway.port !== NEUTRON_POCKET_IC_GATEWAY_PORT) {
    invalidDescriptor(`gateway.port must be ${NEUTRON_POCKET_IC_GATEWAY_PORT}`);
  }
  canonicalBase64(descriptor.rootKeyBase64, "rootKeyBase64");

  const topology = record(
    descriptor.topology,
    "PocketIC runtime descriptor.topology",
  );
  exactKeys(
    topology,
    ["digest", "defaultEffectiveCanisterId", "subnetIds"],
    "PocketIC runtime descriptor.topology",
  );
  sha256(topology.digest, "topology.digest");
  canonicalBase64(
    topology.defaultEffectiveCanisterId,
    "topology.defaultEffectiveCanisterId",
  );
  const subnetIds = record(topology.subnetIds, "PocketIC topology subnetIds");
  const subnetKinds = pocketIcSubnetKinds(
    descriptor.profile as LocalEnvironment,
  );
  exactKeys(subnetIds, subnetKinds, "PocketIC topology subnetIds");
  for (const kind of subnetKinds) {
    canonicalPrincipal(subnetIds[kind], `topology.subnetIds.${kind}`);
  }

  canonicalFixtures(descriptor.fixtures);
}

export async function acquirePocketIcSupervisorLock(
  lockPath: string,
  ownerSessionPath: string,
  processIdentity: (pid: number) => Promise<string | null> =
    nodePocketIcProcessHost.processIdentity,
  now: () => Date = () => new Date(),
): Promise<PocketIcSupervisorLock> {
  const resolvedPath = path.resolve(lockPath);
  const resolvedOwnerSessionPath = canonicalAbsolutePath(
    ownerSessionPath,
    "PocketIC supervisor owner session path",
  );
  await ensurePrivateDirectory(path.dirname(resolvedPath));
  const currentIdentity = await processIdentity(process.pid);
  if (currentIdentity === null) {
    throw new Error("Unable to determine the PocketIC supervisor process identity");
  }
  const contents: SupervisorLockContents = {
    schema: LOCK_SCHEMA,
    pid: process.pid,
    processIdentity: currentIdentity,
    ownerSessionPath: resolvedOwnerSessionPath,
    nonce: randomBytes(16).toString("hex"),
    acquiredAt: now().toISOString(),
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(resolvedPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(contents)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      let released = false;
      return {
        path: resolvedPath,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          const current = await readSupervisorLock(resolvedPath).catch(() => null);
          if (current?.nonce === contents.nonce) {
            await rm(resolvedPath, { force: true });
          }
        },
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }

    const existing = await readSupervisorLock(resolvedPath);
    const existingIdentity = await processIdentity(existing.pid);
    if (existingIdentity === existing.processIdentity) {
      throw new Error(
        `A PocketIC supervisor is already running (PID ${existing.pid}); use the recorded local runtime instead of starting another server`,
      );
    }
    const stalePath = `${resolvedPath}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      await rename(resolvedPath, stalePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    const retired = await readSupervisorLock(stalePath);
    if (retired.nonce !== existing.nonce) {
      // Another contender replaced the stale lock after our read but before
      // the rename. Put that exact live lock back instead of silently deleting
      // its ownership record. The hard link is atomic and cannot overwrite a
      // third contender which may already have published a lock in the gap.
      try {
        await link(stalePath, resolvedPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      await rm(stalePath, { force: true });
      throw new Error(
        `PocketIC supervisor lock changed while retiring stale owner: ${resolvedPath}`,
      );
    }
    await rm(stalePath, { force: true });
  }
  throw new Error("PocketIC supervisor lock changed repeatedly; try again");
}

/**
 * Resolve the one session owned by the live repository supervisor. The lock is
 * only an ownership pointer; the session remains the sole runtime descriptor.
 */
export async function readLivePocketIcSupervisorOwner(
  lockPath: string,
  processIdentity: (pid: number) => Promise<string | null> =
    nodePocketIcProcessHost.processIdentity,
): Promise<PocketIcSupervisorOwner | null> {
  const resolvedPath = path.resolve(lockPath);
  let lock: SupervisorLockContents;
  try {
    lock = await readSupervisorLock(resolvedPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const currentIdentity = await processIdentity(lock.pid);
  if (currentIdentity !== lock.processIdentity) {
    return null;
  }
  return {
    pid: lock.pid,
    processIdentity: lock.processIdentity,
    ownerSessionPath: lock.ownerSessionPath,
  };
}

export const nodePocketIcProcessHost: PocketIcProcessHost = {
  async launch(
    command: string,
    args: readonly string[],
  ): Promise<LaunchedPocketIcProcess> {
    if (!path.isAbsolute(command)) {
      throw new Error("PocketIC executable path must be absolute");
    }
    const child = spawn(command, [...args], {
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    });
    const exited = new Promise<PocketIcProcessExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid === undefined) {
      throw new Error("PocketIC process started without a PID");
    }
    child.unref();
    return { pid: child.pid, exited };
  },

  async processIdentity(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    if (process.platform === "linux") {
      let source: string;
      try {
        source = await readFile(`/proc/${pid}/stat`, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return null;
        throw error;
      }
      const commandEnd = source.lastIndexOf(")");
      if (commandEnd < 0) throw new Error(`Unable to parse process identity for PID ${pid}`);
      const fields = source.slice(commandEnd + 2).trim().split(/\s+/);
      const startTime = fields[19];
      if (startTime === undefined || !/^\d+$/.test(startTime)) {
        throw new Error(`Unable to parse process start time for PID ${pid}`);
      }
      return `linux:${pid}:${startTime}`;
    }
    if (process.platform === "darwin") {
      const startedAt = await processStartFromPs(pid);
      return startedAt === null ? null : `darwin:${pid}:${startedAt}`;
    }
    // No PocketIC release is pinned for other platforms. Do not silently
    // downgrade the PID/start-identity guarantee if this process host is used
    // independently of the resolver.
    throw new Error(
      `PocketIC process identity is unsupported on ${process.platform}`,
    );
  },

  async terminate(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("Refusing to terminate an invalid PocketIC PID");
    }
    try {
      if (process.platform === "win32") process.kill(pid, "SIGTERM");
      else process.kill(-pid, "SIGTERM");
    } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") return;
      throw error;
    }
  },
};

function processStartFromPs(pid: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-o", "lstart=", "-p", pid.toString()],
      { encoding: "utf8", maxBuffer: 4096 },
      (error, stdout) => {
        if (error !== null) {
          if (error.code === 1) resolve(null);
          else reject(error);
          return;
        }
        const value = stdout.trim().replace(/\s+/g, " ");
        if (value.length === 0 || value.length > 128) {
          reject(new Error(`Unable to parse process start time for PID ${pid}`));
          return;
        }
        resolve(value);
      },
    );
  });
}

class PocketIcServeHandleImpl implements PocketIcServeHandle {
  readonly descriptor: PocketIcRuntimeDescriptor;
  readonly #attachment: PocketIcRuntimeAttachment;
  readonly #lock: PocketIcSupervisorLock;
  readonly #processHost: PocketIcProcessHost;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #healthIntervalMs: number;
  readonly #stopTimeoutMs: number;
  #stopRequested = false;
  #stopPromise: Promise<void> | undefined;
  #waitPromise: Promise<void> | undefined;

  constructor({
    attachment,
    lock,
    processHost,
    sleep,
    healthIntervalMs,
    stopTimeoutMs,
  }: {
    attachment: PocketIcRuntimeAttachment;
    lock: PocketIcSupervisorLock;
    processHost: PocketIcProcessHost;
    sleep: (milliseconds: number) => Promise<void>;
    healthIntervalMs: number;
    stopTimeoutMs: number;
  }) {
    this.descriptor = attachment.descriptor;
    this.#attachment = attachment;
    this.#lock = lock;
    this.#processHost = processHost;
    this.#sleep = sleep;
    this.#healthIntervalMs = healthIntervalMs;
    this.#stopTimeoutMs = stopTimeoutMs;
  }

  wait(): Promise<void> {
    this.#waitPromise ??= this.#supervise();
    return this.#waitPromise;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #supervise(): Promise<void> {
    let consecutiveHealthFailures = 0;
    try {
      while (!this.#stopRequested) {
        const identity = await this.#processHost.processIdentity(this.descriptor.pid);
        if (identity !== this.descriptor.processIdentity) {
          throw new Error("The supervised PocketIC process exited or changed identity");
        }
        try {
          await this.#attachment.client.assertServerHealthy();
          consecutiveHealthFailures = 0;
        } catch (error) {
          consecutiveHealthFailures += 1;
          if (consecutiveHealthFailures >= 3) {
            throw new Error("The supervised PocketIC server failed three health checks", {
              cause: error,
            });
          }
        }
        await this.#sleep(this.#healthIntervalMs);
      }
    } finally {
      if (!this.#stopRequested) await this.#lock.release();
    }
  }

  async #stop(): Promise<void> {
    this.#stopRequested = true;
    const failures: unknown[] = [];
    for (const operation of [
      () => this.#attachment.client.stopAutoProgress(this.descriptor.instanceId),
      () => this.#attachment.client.stopGateway(this.descriptor.gateway.id),
      () => this.#attachment.client.deleteInstance(this.descriptor.instanceId),
    ]) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      const identity = await this.#processHost.processIdentity(this.descriptor.pid);
      if (identity === this.descriptor.processIdentity) {
        await this.#processHost.terminate(this.descriptor.pid);
        await waitForProcessToDisappear(
          this.descriptor.pid,
          this.descriptor.processIdentity,
          this.#processHost,
          this.#sleep,
          this.#stopTimeoutMs,
        );
      } else if (identity !== null) {
        failures.push(
          new Error("Refusing to terminate a PID whose process identity changed"),
        );
      }
    } catch (error) {
      failures.push(error);
    } finally {
      await this.#lock.release();
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "PocketIC did not stop cleanly");
    }
  }
}

async function waitForPortFile(
  portFile: string,
  launched: LaunchedPocketIcProcess,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMs: number,
): Promise<number> {
  let exit: PocketIcProcessExit | undefined;
  void launched.exited.then((result) => {
    exit = result;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exit !== undefined) {
      throw new Error(
        `PocketIC exited before writing its port (code ${String(exit.code)}, signal ${String(exit.signal)})`,
      );
    }
    try {
      const source = await readFile(portFile, "utf8");
      const match = source.match(/^([1-9][0-9]{0,4})\n$/);
      if (match !== null) {
        const port = Number(match[1]);
        if (port <= 65_535) return port;
        throw new Error(`PocketIC wrote invalid control port ${port}`);
      }
      if (source.length > 0) throw new Error("PocketIC port file is malformed");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    await sleep(20);
  }
  throw new Error(`PocketIC did not write its port file within ${timeoutMs}ms`);
}

async function retryUntil<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMs: number,
  timeoutMessage: string,
  launched?: LaunchedPocketIcProcess,
): Promise<T> {
  let exit: PocketIcProcessExit | undefined;
  void launched?.exited.then((result) => {
    exit = result;
  });
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (exit !== undefined) {
      throw new Error(
        `PocketIC exited during startup (code ${String(exit.code)}, signal ${String(exit.signal)})`,
      );
    }
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await sleep(50);
    }
  }
  throw new Error(timeoutMessage, { cause: lastError });
}

async function waitForProcessToDisappear(
  pid: number,
  processIdentity: string,
  processHost: PocketIcProcessHost,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + positiveDuration(timeoutMs, "PocketIC stop timeout");
  while (Date.now() < deadline) {
    const current = await processHost.processIdentity(pid);
    if (current === null || current !== processIdentity) return;
    await sleep(50);
  }
  throw new Error(`PocketIC process ${pid} did not exit after SIGTERM`);
}

async function readSupervisorLock(
  filename: string,
): Promise<SupervisorLockContents> {
  const metadata = await lstat(filename);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`PocketIC supervisor lock must be a real file: ${filename}`);
  }
  if (metadata.size > LOCK_MAX_BYTES) {
    throw new Error(`PocketIC supervisor lock is too large: ${filename}`);
  }
  const source = await readFile(filename, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`PocketIC supervisor lock is not valid JSON: ${filename}`, {
      cause: error,
    });
  }
  const lock = record(value, "PocketIC supervisor lock");
  exactKeys(
    lock,
    [
      "schema",
      "pid",
      "processIdentity",
      "ownerSessionPath",
      "nonce",
      "acquiredAt",
    ],
    "PocketIC supervisor lock",
  );
  if (lock.schema !== LOCK_SCHEMA) throw new Error("Unknown PocketIC lock schema");
  positiveInteger(lock.pid, "PocketIC lock PID");
  if (typeof lock.processIdentity !== "string" || lock.processIdentity.length === 0) {
    throw new Error("PocketIC lock has no process identity");
  }
  canonicalAbsolutePath(
    lock.ownerSessionPath,
    "PocketIC lock owner session path",
  );
  if (typeof lock.nonce !== "string" || !/^[0-9a-f]{32}$/.test(lock.nonce)) {
    throw new Error("PocketIC lock has an invalid nonce");
  }
  canonicalTimestamp(lock.acquiredAt, "PocketIC lock acquisition time");
  return lock as SupervisorLockContents;
}

function canonicalAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const normalized = path.normalize(value);
  if (normalized !== value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`PocketIC path must be a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`PocketIC directory is not owned by the current user: ${directory}`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`PocketIC directory must not be group/world-writable: ${directory}`);
  }
}

function canonicalFixtures(value: unknown): Record<string, string> {
  const fixtures = record(value, "PocketIC runtime descriptor.fixtures");
  const entries = Object.entries(fixtures);
  if (entries.length > MAX_FIXTURES) invalidDescriptor("fixtures contains too many entries");
  const result: Record<string, string> = {};
  for (const [name, canisterId] of entries) {
    if (!FIXTURE_NAME_PATTERN.test(name)) {
      invalidDescriptor(`fixture name ${JSON.stringify(name)} is invalid`);
    }
    result[name] = canonicalPrincipal(canisterId, `fixtures.${name}`);
  }
  return result;
}

function assertResolvedBinary(binary: ResolvedPocketIcBinary): void {
  if (binary.version !== POCKET_IC_SERVER_VERSION) {
    throw new Error(`PocketIC binary must be version ${POCKET_IC_SERVER_VERSION}`);
  }
  if (!path.isAbsolute(binary.path)) {
    throw new Error("Resolved PocketIC binary path must be absolute");
  }
  if (!POCKET_IC_ARTIFACTS.some((artifact) => artifact.binarySha256 === binary.sha256)) {
    throw new Error("Resolved PocketIC binary does not have a pinned release checksum");
  }
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") invalidDescriptor(`${label} must be a timestamp`);
  const milliseconds = Date.parse(value as string);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    invalidDescriptor(`${label} must be a canonical ISO timestamp`);
  }
  return value as string;
}

function canonicalBase64(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidDescriptor(`${label} must be nonempty base64`);
  }
  const decoded = Buffer.from(value as string, "base64");
  if (decoded.byteLength === 0 || decoded.toString("base64") !== value) {
    invalidDescriptor(`${label} must be canonical base64`);
  }
  return value as string;
}

function canonicalPrincipal(value: unknown, label: string): string {
  if (typeof value !== "string") invalidDescriptor(`${label} must be a principal`);
  let principal: Principal;
  try {
    principal = Principal.fromText(value as string);
  } catch (error) {
    throw new Error(`Invalid PocketIC runtime descriptor: ${label} is not a principal`, {
      cause: error,
    });
  }
  if (principal.toText() !== value) invalidDescriptor(`${label} is not canonical`);
  return value as string;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalidDescriptor(`${label} must be lowercase SHA-256 hexadecimal`);
  }
  return value as string;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalidDescriptor(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidDescriptor(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60_000) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidDescriptor(`${label} must be a nonempty string`);
  }
  return value as string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(
      `${label} fields must be exactly ${sortedExpected.join(", ")}; got ${actual.join(", ")}`,
    );
  }
}

function invalidDescriptor(detail: string): never {
  throw new Error(`Invalid PocketIC runtime descriptor: ${detail}`);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
