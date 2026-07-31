import {
  Cbor,
  type ActorMethod,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import type { PreparedDeployment } from "neutron-provision/src/artifact.js";
import {
  sha256,
  toHex,
} from "neutron-provision/src/artifact.js";
import {
  EMPTY_CANDID_ARGS,
  MANAGEMENT_CANISTER_ID,
  canonicalPrincipals,
} from "neutron-provision/src/ic_client.js";
import {
  kernelAccessIdl,
  localManagementIdl,
  type KernelAccessActor,
  type LocalManagementActor,
} from "neutron-provision/src/idl.js";
import {
  LOCAL_CANISTER_CYCLES,
  LocalProvisionClient,
  principalFromCanonicalBase64,
} from "neutron-provision/src/local_client.js";
import type { LocalEnvironment } from "neutron-provision/src/local_environment.js";
import {
  POCKET_IC_SERVER_VERSION,
  pocketIcServerArguments,
  resolvePocketIcBinary,
  type ResolvedPocketIcBinary,
} from "neutron-provision/src/pocketic_binary.js";
import {
  PocketIcRestClient,
  createNeutronPocketIcInstanceConfig,
  summarizePocketIcTopology,
  type PocketIcRawEffectivePrincipal,
  type PocketIcInstanceConfig,
  type PocketIcTopology,
  type PocketIcTopologySummary,
} from "neutron-provision/src/pocketic_rest.js";
import { localIdentityFromSeed } from "neutron-provision/src/kernel.js";
import {
  CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS,
} from "./physical_population.ts";

const QUALIFICATION_PROFILE = "minimal" as const satisfies LocalEnvironment;
const QUALIFICATION_CONTROLLER_SEED = 0xc7;
const LIVE_DEVELOPMENT_GATEWAY_IP = "127.0.0.1";
const QUALIFICATION_GATEWAY_IP = "127.0.0.2";
const QUALIFICATION_GATEWAY_PORT = 8000;
const SERVER_READY_TIMEOUT_MS = 30_000;
const INSTANCE_READY_TIMEOUT_MS = 15 * 60_000;
const GATEWAY_READY_TIMEOUT_MS = 3 * 60_000;
const CONTROL_OPERATION_TIMEOUT_MS = 2 * 60_000;
const PROCESS_STOP_TIMEOUT_MS = 10_000;
const SERVER_TTL_SECONDS = 24 * 60 * 60;
const SERVER_LOG_LIMIT_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TIME_ADVANCE_NS = 30n * 24n * 60n * 60n * 1_000_000_000n;
export const QUALIFICATION_INITIAL_TIME_NS =
  1_735_689_600_000_000_000n;
const QUALIFICATION_BOOTSTRAP_TIME_NS =
  QUALIFICATION_INITIAL_TIME_NS - 60n * 1_000_000_000n;
const QUALIFICATION_WALL_CLOCK_SAFETY_MARGIN_NS =
  5n * 60n * 1_000_000_000n;
const QUALIFICATION_STATE_DIRECTORY_FINGERPRINT_SENTINEL =
  "<source-owned-ephemeral-state>";

type QualificationInstanceConfig = Omit<
  PocketIcInstanceConfig,
  "http_gateway_config" | "initial_time"
> & {
  http_gateway_config: Omit<
    PocketIcInstanceConfig["http_gateway_config"],
    "ip_addr" | "port"
  > & {
    /**
     * Certified local authorities include port 8000. A distinct loopback IP
     * keeps that authority without touching the developer gateway.
     */
    ip_addr: typeof QUALIFICATION_GATEWAY_IP;
    port: typeof QUALIFICATION_GATEWAY_PORT;
  };
  initial_time: {
    Timestamp: {
      nanos_since_epoch: number;
    };
  };
};

export type QualificationInstanceCreation = {
  instanceId: number;
  gatewayId: number;
  gatewayPort: number;
  topology: PocketIcTopology;
  topologySummary: PocketIcTopologySummary;
};

export type QualificationManagementStatus = {
  installedTransportWasmSha256: string | null;
  controllers: string[];
  status: "running" | "stopping" | "stopped";
  canisterVersion: bigint;
};

export type QualificationManagementStatusWire = {
  status:
    | { running: null }
    | { stopping: null }
    | { stopped: null };
  version: bigint;
  settings: { controllers: Principal[] };
  module_hash: [] | [Uint8Array];
};

export function qualificationManagementStatusFromWire(
  response: QualificationManagementStatusWire,
): QualificationManagementStatus {
  return {
    installedTransportWasmSha256:
      response.module_hash.length === 0
        ? null
        : toHex(response.module_hash[0]!),
    controllers: canonicalPrincipals(
      response.settings.controllers.map((controller) =>
        controller.toText()
      ),
    ),
    status:
      "running" in response.status
        ? "running"
        : "stopping" in response.status
          ? "stopping"
          : "stopped",
    canisterVersion: response.version,
  };
}

export type QualificationInstallResult = {
  before: QualificationManagementStatus;
  after: QualificationManagementStatus;
  installedTransportWasmSha256: string;
  installChunkedCodeCall: QualificationManagementCallTranscript;
};

export type QualificationManagementCallTranscript = {
  mode: "update";
  method: "install_chunked_code";
  request: Uint8Array;
  reply: Uint8Array;
};

export type QualificationTimeAdvance = {
  beforeNs: string;
  requestedDeltaNs: string;
  afterNs: string;
};

export type QualificationWallClockNormalization = {
  beforeNs: string;
  targetHostWallNs: string;
  afterNs: string;
  autoProgressBefore: false;
  autoProgressAfter: true;
};

export type IsolatedQualificationPocketIc = {
  readonly profile: typeof QUALIFICATION_PROFILE;
  readonly serverVersion: typeof POCKET_IC_SERVER_VERSION;
  readonly binarySha256: string;
  readonly instanceConfigSha256: string;
  readonly controllerPrincipal: string;
  readonly controlUrl: string;
  readonly gatewayTransportIp: typeof QUALIFICATION_GATEWAY_IP;
  readonly gatewayTransportOrigin: string;
  readonly instanceId: number;
  readonly gatewayId: number;
  readonly rootKeyBase64: string;
  readonly topology: PocketIcTopology;
  readonly topologySummary: PocketIcTopologySummary;
  readonly provision: LocalProvisionClient;
  canonicalCertifiedOrigin(canisterId: string): string;
  createCanister(): Promise<string>;
  readManagementStatus(
    canisterId: string,
  ): Promise<QualificationManagementStatus>;
  installTransportWasm(
    canisterId: string,
    deployment: Pick<
      PreparedDeployment,
      "chunks" | "transportWasm" | "transportWasmSha256"
    >,
    arg?: Uint8Array,
  ): Promise<QualificationInstallResult>;
  reinstallSameTransportWasm(
    canisterId: string,
    deployment: Pick<
      PreparedDeployment,
      "chunks" | "transportWasm" | "transportWasmSha256"
    >,
    arg?: Uint8Array,
  ): Promise<QualificationInstallResult>;
  upgradeSameTransportWasm(
    canisterId: string,
    deployment: Pick<
      PreparedDeployment,
      "chunks" | "transportWasm" | "transportWasmSha256"
    >,
    arg?: Uint8Array,
  ): Promise<QualificationInstallResult>;
  ensureQualificationSelfController(canisterId: string): Promise<void>;
  authorizeQualificationController(canisterId: string): Promise<void>;
  verifyQualificationController(canisterId: string): Promise<void>;
  readReplicaTimeNs(): Promise<string>;
  advanceTimeAndTick(
    nanoseconds: bigint,
  ): Promise<QualificationTimeAdvance>;
  normalizeToWallAndStartAutoProgress():
    Promise<QualificationWallClockNormalization>;
  stop(): Promise<void>;
};

/**
 * Start one source-owned, disposable qualification environment.
 *
 * This API intentionally has no attach URL, state-directory, binary,
 * gateway-port, fixture-driver, or transport override. It resolves the pinned
 * PocketIC binary, creates a new private state directory, and owns the exact
 * child process it later stops. In particular, it cannot attach to the
 * repository's long-lived localhost:8000 development environment.
 */
export async function launchIsolatedQualificationPocketIc(input: {
  repositoryRoot: string;
}): Promise<IsolatedQualificationPocketIc> {
  const repositoryRoot = canonicalAbsoluteDirectory(
    input.repositoryRoot,
    "repositoryRoot",
  );
  const binary = await resolvePocketIcBinary({
    cacheDirectory: path.join(repositoryRoot, ".neutron", "cache", "bin"),
  });
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "neutron-ca-qualification-"),
  );
  await chmod(temporaryRoot, 0o700);
  const stateDirectory = path.join(temporaryRoot, "state");
  const runtimeDirectory = path.join(temporaryRoot, "runtime");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(runtimeDirectory, { mode: 0o700 });
  const portFile = path.join(runtimeDirectory, "pocketic.port");

  let ownedProcess: OwnedPocketIcProcess | undefined;
  let control: PocketIcRestClient | undefined;
  let creation: QualificationInstanceCreation | undefined;
  try {
    await assertQualificationGatewayAvailable();
    ownedProcess = await launchOwnedPocketIc(binary, portFile);
    const controlPort = await waitForControlPort(portFile, ownedProcess);
    assertQualificationControlPort(controlPort);
    const controlUrl = `http://127.0.0.1:${controlPort}/`;
    control = new PocketIcRestClient(controlUrl);
    await retryUntilHealthy(
      () => control!.assertServerHealthy(),
      ownedProcess,
      SERVER_READY_TIMEOUT_MS,
      "The isolated PocketIC control server did not become healthy",
    );

    const instanceConfig =
      createIsolatedQualificationInstanceConfig(stateDirectory);
    creation = await createQualificationInstance(
      controlUrl,
      instanceConfig,
      ownedProcess,
    );
    if (await control.isAutoProgressEnabled(creation.instanceId)) {
      throw new Error(
        "The isolated PocketIC qualification instance unexpectedly enabled automatic progress",
      );
    }
    const gatewayTransportOrigin =
      `http://${QUALIFICATION_GATEWAY_IP}:${creation.gatewayPort}`;
    const gatewayStatus = await retryUntilHealthy(
      () => readQualificationGatewayStatus(gatewayTransportOrigin),
      ownedProcess,
      GATEWAY_READY_TIMEOUT_MS,
      "The isolated PocketIC gateway did not become healthy",
    );
    const identity = localIdentityFromSeed(QUALIFICATION_CONTROLLER_SEED);
    const provision = await LocalProvisionClient.create({
      gatewayUrl: `${gatewayTransportOrigin}/`,
      controlUrl,
      instanceId: creation.instanceId,
      identity,
      defaultEffectiveCanisterIdBase64:
        creation.topologySummary.defaultEffectiveCanisterId,
      expectedRootKeyBase64: gatewayStatus.rootKeyBase64,
      logger: { log: () => undefined },
    });
    await normalizeQualificationInitialTime({
      controlUrl,
      instanceId: creation.instanceId,
      process: ownedProcess,
      control,
      provision,
      effectiveCanisterId: principalFromCanonicalBase64(
        creation.topologySummary.defaultEffectiveCanisterId,
        "Qualification default effective canister ID",
      ),
    });
    await rm(portFile, { force: true });

    return new IsolatedQualificationPocketIcImpl({
      binary,
      temporaryRoot,
      ownedProcess,
      control,
      creation,
      instanceConfig,
      gatewayTransportOrigin,
      rootKeyBase64: gatewayStatus.rootKeyBase64,
      provision,
    });
  } catch (error) {
    const cleanupFailures = await cleanupPartialEnvironment({
      temporaryRoot,
      ...(ownedProcess === undefined ? {} : { ownedProcess }),
      ...(control === undefined ? {} : { control }),
      ...(creation === undefined ? {} : { creation }),
    });
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "The isolated PocketIC qualification environment failed to start and did not clean up completely",
      );
    }
    throw error;
  }
}

/**
 * Derive the exact minimal-profile instance request on an isolated loopback
 * alias. The local certified authority remains port 8000.
 */
export function createIsolatedQualificationInstanceConfig(
  stateDirectory: string,
): QualificationInstanceConfig {
  assertQualificationHostWallSafety(hostWallTimeNs());
  const base = createNeutronPocketIcInstanceConfig({
    profile: QUALIFICATION_PROFILE,
    stateDirectory: canonicalAbsoluteDirectory(
      stateDirectory,
      "qualification stateDirectory",
    ),
  });
  return {
    ...base,
    initial_time: {
      Timestamp: {
        nanos_since_epoch: Number(QUALIFICATION_BOOTSTRAP_TIME_NS),
      },
    },
    http_gateway_config: {
      ...base.http_gateway_config,
      ip_addr: QUALIFICATION_GATEWAY_IP,
      port: QUALIFICATION_GATEWAY_PORT,
    },
  };
}

async function normalizeQualificationInitialTime(input: {
  controlUrl: string;
  instanceId: number;
  process: OwnedPocketIcProcess;
  control: PocketIcRestClient;
  provision: LocalProvisionClient;
  effectiveCanisterId: Principal;
}): Promise<void> {
  if (await input.control.isAutoProgressEnabled(input.instanceId)) {
    throw new Error(
      "Qualification initial-time normalization requires automatic progress to be disabled",
    );
  }
  const before = await readQualificationTimeNs(
    input.controlUrl,
    input.instanceId,
    input.process,
  );
  if (before >= QUALIFICATION_INITIAL_TIME_NS) {
    throw new Error(
      `Qualification bootstrap clock ${before} must precede fixed start ${QUALIFICATION_INITIAL_TIME_NS}`,
    );
  }
  await executeQualificationControlOperation({
    controlUrl: input.controlUrl,
    endpoint: `instances/${input.instanceId}/update/set_time`,
    body:
      `{"nanos_since_epoch":${QUALIFICATION_INITIAL_TIME_NS.toString()}}`,
    process: input.process,
  });
  await executeQualificationControlOperation({
    controlUrl: input.controlUrl,
    endpoint: `instances/${input.instanceId}/update/tick`,
    body: '{"blockmakers":null}',
    process: input.process,
  });
  const after = await readQualificationTimeNs(
    input.controlUrl,
    input.instanceId,
    input.process,
  );
  if (after !== QUALIFICATION_INITIAL_TIME_NS) {
    throw new Error(
      `Qualification initial-time normalization expected ${QUALIFICATION_INITIAL_TIME_NS}, found ${after}`,
    );
  }
  await input.provision.agent.syncTime(input.effectiveCanisterId);
}

export function assertQualificationHostWallSafety(
  hostWallNs: bigint,
): void {
  if (typeof hostWallNs !== "bigint" || hostWallNs < 0n) {
    throw new Error(
      "Qualification host wall time must be nonnegative nanoseconds",
    );
  }
  const minimumExclusive =
    QUALIFICATION_INITIAL_TIME_NS +
    (CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS + 1n) +
    QUALIFICATION_WALL_CLOCK_SAFETY_MARGIN_NS;
  if (hostWallNs <= minimumExclusive) {
    throw new Error(
      `Qualification host wall time must be later than ${minimumExclusive}ns`,
    );
  }
}

export function parseQualificationInstanceCreation(
  value: unknown,
): QualificationInstanceCreation {
  const response = exactRecord(
    value,
    ["Created"],
    "PocketIC create-instance response",
    true,
  );
  if ("Error" in response) {
    const failure = exactRecord(
      response.Error,
      ["message"],
      "PocketIC create-instance error",
    );
    if (
      typeof failure.message !== "string" ||
      failure.message.length === 0
    ) {
      throw new Error("PocketIC create-instance error has no message");
    }
    throw new Error(
      `PocketIC could not create the isolated qualification instance: ${failure.message}`,
    );
  }
  const created = exactRecord(
    response.Created,
    ["instance_id", "topology", "http_gateway_info"],
    "PocketIC Created response",
  );
  const gateway = exactRecord(
    created.http_gateway_info,
    ["instance_id", "port"],
    "PocketIC gateway info",
  );
  const instanceId = nonnegativeInteger(
    created.instance_id,
    "PocketIC instance ID",
  );
  const gatewayId = nonnegativeInteger(
    gateway.instance_id,
    "PocketIC gateway ID",
  );
  const gatewayPort = nonnegativeInteger(
    gateway.port,
    "PocketIC gateway port",
  );
  if (gatewayPort !== QUALIFICATION_GATEWAY_PORT) {
    throw new Error(
      `PocketIC gateway port must be ${QUALIFICATION_GATEWAY_PORT}`,
    );
  }
  const { topology, summary } = summarizePocketIcTopology(
    created.topology,
    QUALIFICATION_PROFILE,
  );
  return {
    instanceId,
    gatewayId,
    gatewayPort,
    topology,
    topologySummary: summary,
  };
}

export function qualificationInstanceConfigSha256(
  config: QualificationInstanceConfig,
): string {
  const fingerprintConfig: QualificationInstanceConfig = {
    ...config,
    state_dir: QUALIFICATION_STATE_DIRECTORY_FINGERPRINT_SENTINEL,
  };
  return createHash("sha256")
    .update("neutron-certified-assets-qualification-instance-config-v2\0")
    .update(canonicalJson(fingerprintConfig))
    .digest("hex");
}

function qualificationTargetCanisterRanges(
  topology: PocketIcTopology,
): readonly Readonly<{ start: Principal; end: Principal }>[] {
  const targets = Object.values(topology.subnet_configs).filter(
    ({ subnet_kind: kind }) => kind === "Application",
  );
  if (targets.length !== 1 || targets[0]!.canister_ranges.length === 0) {
    throw new Error(
      "Minimal PocketIC topology must contain one Application subnet with canister ranges",
    );
  }
  return targets[0]!.canister_ranges.map(({ start, end }, index) => {
    const parsedStart = principalFromCanonicalBase64(
      start.canister_id,
      `PocketIC qualification-target range ${index} start`,
    );
    const parsedEnd = principalFromCanonicalBase64(
      end.canister_id,
      `PocketIC qualification-target range ${index} end`,
    );
    if (!parsedStart.ltEq(parsedEnd)) {
      throw new Error(
        `PocketIC qualification-target range ${index} is reversed`,
      );
    }
    return Object.freeze({ start: parsedStart, end: parsedEnd });
  });
}

class IsolatedQualificationPocketIcImpl
  implements IsolatedQualificationPocketIc
{
  readonly profile = QUALIFICATION_PROFILE;
  readonly serverVersion = POCKET_IC_SERVER_VERSION;
  readonly binarySha256: string;
  readonly instanceConfigSha256: string;
  readonly controllerPrincipal: string;
  readonly controlUrl: string;
  readonly gatewayTransportIp = QUALIFICATION_GATEWAY_IP;
  readonly gatewayTransportOrigin: string;
  readonly instanceId: number;
  readonly gatewayId: number;
  readonly rootKeyBase64: string;
  readonly topology: PocketIcTopology;
  readonly topologySummary: PocketIcTopologySummary;
  readonly provision: LocalProvisionClient;
  readonly #temporaryRoot: string;
  readonly #ownedProcess: OwnedPocketIcProcess;
  readonly #control: PocketIcRestClient;
  readonly #controller: Principal;
  readonly #targetEffectiveCanisterId: Principal;
  readonly #targetCanisterRanges: readonly Readonly<{
    start: Principal;
    end: Principal;
  }>[];
  #autoProgressStarted = false;
  #stopPromise: Promise<void> | undefined;

  constructor(input: {
    binary: ResolvedPocketIcBinary;
    temporaryRoot: string;
    ownedProcess: OwnedPocketIcProcess;
    control: PocketIcRestClient;
    creation: QualificationInstanceCreation;
    instanceConfig: QualificationInstanceConfig;
    gatewayTransportOrigin: string;
    rootKeyBase64: string;
    provision: LocalProvisionClient;
  }) {
    this.binarySha256 = input.binary.sha256;
    this.instanceConfigSha256 = qualificationInstanceConfigSha256(
      input.instanceConfig,
    );
    this.controllerPrincipal = input.provision.principal;
    this.controlUrl = input.control.controlUrl;
    this.gatewayTransportOrigin = input.gatewayTransportOrigin;
    this.instanceId = input.creation.instanceId;
    this.gatewayId = input.creation.gatewayId;
    this.rootKeyBase64 = input.rootKeyBase64;
    this.topology = input.creation.topology;
    this.topologySummary = input.creation.topologySummary;
    this.provision = input.provision;
    this.#controller = Principal.fromText(input.provision.principal);
    this.#targetCanisterRanges =
      qualificationTargetCanisterRanges(input.creation.topology);
    this.#targetEffectiveCanisterId =
      this.#targetCanisterRanges[0]!.start;
    this.#temporaryRoot = input.temporaryRoot;
    this.#ownedProcess = input.ownedProcess;
    this.#control = input.control;
  }

  async #callManagement<Method extends keyof LocalManagementActor>(
    method: Method,
    args: Parameters<LocalManagementActor[Method]>,
    effectiveCanisterId: Principal,
  ): Promise<Awaited<ReturnType<LocalManagementActor[Method]>>> {
    return await executeQualificationCanisterCall({
      control: this.#control,
      instanceId: this.instanceId,
      sender: this.#controller,
      canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
      effectiveCanisterId,
      idl: localManagementIdl,
      method: String(method),
      args,
    }) as Awaited<ReturnType<LocalManagementActor[Method]>>;
  }

  async #callManagementStatus(
    args: Parameters<
      QualificationManagementStatusActor["canister_status"]
    >,
    effectiveCanisterId: Principal,
  ): Promise<QualificationManagementStatusWire> {
    return await executeQualificationCanisterCall({
      control: this.#control,
      instanceId: this.instanceId,
      sender: this.#controller,
      canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
      effectiveCanisterId,
      idl: qualificationManagementStatusIdl,
      method: "canister_status",
      args,
    }) as QualificationManagementStatusWire;
  }

  async #callKernelAccess<Method extends keyof KernelAccessActor>(
    canisterId: Principal,
    method: Method,
    args: Parameters<KernelAccessActor[Method]>,
  ): Promise<Awaited<ReturnType<KernelAccessActor[Method]>>> {
    return await executeQualificationCanisterCall({
      control: this.#control,
      instanceId: this.instanceId,
      sender: this.#controller,
      canisterId,
      idl: kernelAccessIdl,
      method: String(method),
      args,
    }) as Awaited<ReturnType<KernelAccessActor[Method]>>;
  }

  async createCanister(): Promise<string> {
    // The lean NNS subnet is the certificate root, so qualification canisters
    // stay on the ordinary Application subnet and carry real delegated
    // certificates without installing optional NNS canister fixtures.
    const request: Parameters<
      LocalManagementActor["provisional_create_canister_with_cycles"]
    >[0] = {
      amount: [LOCAL_CANISTER_CYCLES],
      settings: [{
        controllers: [[this.#controller]],
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
      }],
      specified_id: [],
      sender_canister_version: [],
    };
    const result = await this.#callManagement(
      "provisional_create_canister_with_cycles",
      [request],
      this.#targetEffectiveCanisterId,
    );
    if (
      !this.#targetCanisterRanges.some(
        ({ start, end }) =>
          start.ltEq(result.canister_id) && end.gtEq(result.canister_id),
      )
    ) {
      throw new Error(
        "PocketIC created the qualification canister outside its Application subnet",
      );
    }
    return result.canister_id.toText();
  }

  canonicalCertifiedOrigin(canisterId: string): string {
    const canister = canonicalCanister(canisterId);
    return `http://${canister.toText()}.localhost:${QUALIFICATION_GATEWAY_PORT}`;
  }

  async readManagementStatus(
    canisterId: string,
  ): Promise<QualificationManagementStatus> {
    const canister = canonicalCanister(canisterId);
    const response = await this.#callManagementStatus(
      [{ canister_id: canister }],
      canister,
    );
    return qualificationManagementStatusFromWire(response);
  }

  installTransportWasm(
    canisterId: string,
    deployment: Pick<
      PreparedDeployment,
      "chunks" | "transportWasm" | "transportWasmSha256"
    >,
    arg: Uint8Array = EMPTY_CANDID_ARGS,
  ): Promise<QualificationInstallResult> {
    return this.#installTransportWasm(
      canisterId,
      deployment,
      "install",
      arg,
    );
  }

  reinstallSameTransportWasm(
    canisterId: string,
    deployment: Pick<
      PreparedDeployment,
      "chunks" | "transportWasm" | "transportWasmSha256"
    >,
    arg: Uint8Array = EMPTY_CANDID_ARGS,
  ): Promise<QualificationInstallResult> {
    return this.#installTransportWasm(
      canisterId,
      deployment,
      "reinstall",
      arg,
    );
  }

  upgradeSameTransportWasm(
    canisterId: string,
    deployment: Pick<
      PreparedDeployment,
      "chunks" | "transportWasm" | "transportWasmSha256"
    >,
    arg: Uint8Array = EMPTY_CANDID_ARGS,
  ): Promise<QualificationInstallResult> {
    return this.#installTransportWasm(
      canisterId,
      deployment,
      "upgrade",
      arg,
    );
  }

  async #installTransportWasm(
    canisterId: string,
    deployment: Pick<
      PreparedDeployment,
      "chunks" | "transportWasm" | "transportWasmSha256"
    >,
    mode: "install" | "reinstall" | "upgrade",
    arg: Uint8Array,
  ): Promise<QualificationInstallResult> {
    const canister = canonicalCanister(canisterId);
    if (!(arg instanceof Uint8Array)) {
      throw new Error(
        "Qualification transport-Wasm install argument must be bytes",
      );
    }
    const expectedHash = toHex(sha256(deployment.transportWasm));
    if (deployment.transportWasmSha256 !== expectedHash) {
      throw new Error(
        "Qualification transport-Wasm digest does not match its bytes",
      );
    }
    const before = await this.readManagementStatus(canisterId);
    if (
      before.status !== "running" ||
      !before.controllers.includes(this.controllerPrincipal)
    ) {
      throw new Error(
        `${mode} requires a running canister controlled by the qualification identity`,
      );
    }
    if (
      (mode === "install" &&
        before.installedTransportWasmSha256 !== null) ||
      (mode !== "install" &&
        before.installedTransportWasmSha256 !== expectedHash)
    ) {
      throw new Error(
        `${mode} expected ${
          mode === "install"
            ? "an empty canister"
            : `installed transport Wasm ${expectedHash}`
        }, found ${before.installedTransportWasmSha256 ?? "none"}`,
      );
    }

    const installRequest: Parameters<
      LocalManagementActor["install_chunked_code"]
    >[0] = {
      mode:
        mode === "install"
          ? { install: null }
          : mode === "reinstall"
            ? { reinstall: null }
            : {
                upgrade: [{
                  skip_pre_upgrade: [],
                  wasm_memory_persistence: [{ keep: null }],
                }],
              },
      target_canister: canister,
      store_canister: [],
      chunk_hashes_list: deployment.chunks.map(({ hash }) => ({ hash })),
      wasm_module_hash: sha256(deployment.transportWasm),
      arg,
      sender_canister_version: [],
    };
    const installChunkedCodeCall =
      encodeQualificationInstallChunkedCodeCall(installRequest);
    await this.#callManagement(
      "clear_chunk_store",
      [{ canister_id: canister }],
      canister,
    );
    try {
      for (const chunk of deployment.chunks) {
        if (toHex(chunk.hash) !== chunk.hashHex) {
          throw new Error(
            `Qualification transport-Wasm chunk metadata disagrees for ${chunk.hashHex}`,
          );
        }
        const uploaded = await this.#callManagement(
          "upload_chunk",
          [{
            canister_id: canister,
            chunk: chunk.bytes,
          }],
          canister,
        );
        if (toHex(uploaded.hash) !== chunk.hashHex) {
          throw new Error(
            `PocketIC returned the wrong hash for transport-Wasm chunk ${chunk.hashHex}`,
          );
        }
      }
      await this.#callManagement(
        "install_chunked_code",
        [installRequest],
        canister,
      );
    } finally {
      await this.#callManagement(
        "clear_chunk_store",
        [{ canister_id: canister }],
        canister,
      );
    }
    const after = await this.readManagementStatus(canisterId);
    if (
      after.installedTransportWasmSha256 !== expectedHash ||
      after.status !== "running" ||
      after.canisterVersion <= before.canisterVersion ||
      after.controllers.length !== before.controllers.length ||
      after.controllers.some(
        (controller, index) => controller !== before.controllers[index],
      )
    ) {
      throw new Error(
        `${mode} postflight expected running transport Wasm ${expectedHash}, an advanced canister version, and unchanged controllers; found ${after.status} ${after.installedTransportWasmSha256 ?? "none"} at version ${after.canisterVersion}`,
      );
    }
    return {
      before,
      after,
      installedTransportWasmSha256: expectedHash,
      installChunkedCodeCall,
    };
  }

  async ensureQualificationSelfController(
    canisterId: string,
  ): Promise<void> {
    const canister = canonicalCanister(canisterId);
    const initial = canonicalPrincipals([this.controllerPrincipal]);
    const expected = canonicalPrincipals([
      this.controllerPrincipal,
      canisterId,
    ]);
    const before = await this.readManagementStatus(canisterId);
    if (sameStrings(before.controllers, expected)) return;
    if (!sameStrings(before.controllers, initial)) {
      throw new Error(
        `Qualification controller drift on ${canisterId}: found ${before.controllers.join(", ")}`,
      );
    }
    const settings: Parameters<
      LocalManagementActor["update_settings"]
    >[0]["settings"] = {
      controllers: [[this.#controller, canister]],
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
    await this.#callManagement(
      "update_settings",
      [{
        canister_id: canister,
        settings,
        sender_canister_version: [],
      }],
      canister,
    );
    const after = await this.readManagementStatus(canisterId);
    if (!sameStrings(after.controllers, expected)) {
      throw new Error(
        `Qualification self-controller update failed for ${canisterId}`,
      );
    }
  }

  async authorizeQualificationController(
    canisterId: string,
  ): Promise<void> {
    const canister = canonicalCanister(canisterId);
    await this.#callKernelAccess(
      canister,
      "kernel_authorized_recover",
      [this.#controller],
    );
    await this.#assertQualificationControllerAuthorization(canister);
  }

  async verifyQualificationController(
    canisterId: string,
  ): Promise<void> {
    await this.#assertQualificationControllerAuthorization(
      canonicalCanister(canisterId),
    );
  }

  async #assertQualificationControllerAuthorization(
    canister: Principal,
  ): Promise<void> {
    const snapshot = await this.#callKernelAccess(
      canister,
      "kernel_access_snapshot",
      [null],
    );
    if (snapshot.self_principal.toText() !== canister.toText()) {
      throw new Error(
        "Qualification access snapshot belongs to a different canister",
      );
    }
    const controllers = canonicalPrincipals(
      snapshot.controllers.map((entry) => entry.toText()),
    );
    const expectedControllers = canonicalPrincipals([
      this.controllerPrincipal,
      canister.toText(),
    ]);
    if (!sameStrings(controllers, expectedControllers)) {
      throw new Error(
        `Qualification controllers expected ${expectedControllers.join(", ")}, found ${controllers.join(", ") || "none"}`,
      );
    }
    const authorized = canonicalPrincipals(
      snapshot.authorized_principals.map((entry) => entry.toText()),
    );
    if (!sameStrings(authorized, [this.controllerPrincipal])) {
      throw new Error(
        `Qualification authorization expected ${this.controllerPrincipal}, found ${authorized.join(", ") || "none"}`,
      );
    }
  }

  async advanceTimeAndTick(
    nanoseconds: bigint,
  ): Promise<QualificationTimeAdvance> {
    if (
      typeof nanoseconds !== "bigint" ||
      nanoseconds < 1n ||
      nanoseconds > MAX_TIME_ADVANCE_NS
    ) {
      throw new Error(
        "Qualification time advance must be from 1ns through 30 days",
      );
    }
    if (
      this.#autoProgressStarted ||
      await this.#control.isAutoProgressEnabled(this.instanceId)
    ) {
      throw new Error(
        "Qualification manual time advance requires automatic progress to be disabled",
      );
    }
    const before = await readQualificationTimeNs(
      this.controlUrl,
      this.instanceId,
      this.#ownedProcess,
    );
    const target = before + nanoseconds;
    if (target > 18_446_744_073_709_551_615n) {
      throw new Error("Qualification time advance exceeds the PocketIC clock");
    }
    await executeQualificationControlOperation({
      controlUrl: this.controlUrl,
      endpoint: `instances/${this.instanceId}/update/set_time`,
      body: `{"nanos_since_epoch":${target.toString()}}`,
      process: this.#ownedProcess,
    });
    await executeQualificationControlOperation({
      controlUrl: this.controlUrl,
      endpoint: `instances/${this.instanceId}/update/tick`,
      body: '{"blockmakers":null}',
      process: this.#ownedProcess,
    });
    const after = await readQualificationTimeNs(
      this.controlUrl,
      this.instanceId,
      this.#ownedProcess,
    );
    if (after !== target) {
      throw new Error(
        `PocketIC clock postflight expected exactly ${target}, found ${after}`,
      );
    }
    if (await this.#control.isAutoProgressEnabled(this.instanceId)) {
      throw new Error(
        "Qualification automatic progress started during a manual time advance",
      );
    }
    await this.provision.agent.syncTime(
      this.#targetEffectiveCanisterId,
    );
    return {
      beforeNs: before.toString(),
      requestedDeltaNs: nanoseconds.toString(),
      afterNs: after.toString(),
    };
  }

  async normalizeToWallAndStartAutoProgress():
    Promise<QualificationWallClockNormalization> {
    if (this.#autoProgressStarted) {
      throw new Error(
        "Qualification automatic progress has already been started",
      );
    }
    const autoProgressBefore =
      await this.#control.isAutoProgressEnabled(this.instanceId);
    if (autoProgressBefore) {
      throw new Error(
        "Qualification automatic progress was enabled before wall-clock normalization",
      );
    }
    const before = await readQualificationTimeNs(
      this.controlUrl,
      this.instanceId,
      this.#ownedProcess,
    );
    const wall = hostWallTimeNs();
    if (wall <= before) {
      throw new Error(
        `Qualification host wall time ${wall} must be later than replica time ${before}`,
      );
    }
    await executeQualificationControlOperation({
      controlUrl: this.controlUrl,
      endpoint: `instances/${this.instanceId}/update/set_time`,
      body: `{"nanos_since_epoch":${wall.toString()}}`,
      process: this.#ownedProcess,
    });
    await executeQualificationControlOperation({
      controlUrl: this.controlUrl,
      endpoint: `instances/${this.instanceId}/update/tick`,
      body: '{"blockmakers":null}',
      process: this.#ownedProcess,
    });
    const normalized = await readQualificationTimeNs(
      this.controlUrl,
      this.instanceId,
      this.#ownedProcess,
    );
    if (normalized < wall) {
      throw new Error(
        `PocketIC wall-clock normalization expected at least ${wall}, found ${normalized}`,
      );
    }
    await executeQualificationControlOperation({
      controlUrl: this.controlUrl,
      endpoint: `instances/${this.instanceId}/auto_progress`,
      body: '{"artificial_delay_ms":null}',
      process: this.#ownedProcess,
    });
    const autoProgressAfter =
      await this.#control.isAutoProgressEnabled(this.instanceId);
    if (!autoProgressAfter) {
      throw new Error(
        "Qualification automatic progress did not start",
      );
    }
    this.#autoProgressStarted = true;
    const autoProgressObserved =
      await readQualificationTimeNs(
        this.controlUrl,
        this.instanceId,
        this.#ownedProcess,
      );
    if (autoProgressObserved < normalized) {
      throw new Error(
        `Qualification automatic progress clock ${autoProgressObserved} preceded normalized time ${normalized}`,
      );
    }
    const observedWall = hostWallTimeNs();
    const wallDistance = autoProgressObserved > observedWall
      ? autoProgressObserved - observedWall
      : observedWall - autoProgressObserved;
    if (wallDistance > 60n * 1_000_000_000n) {
      throw new Error(
        `Qualification automatic progress clock ${autoProgressObserved} is not within 60 seconds of host wall ${observedWall}`,
      );
    }
    await this.provision.agent.syncTime(
      this.#targetEffectiveCanisterId,
    );
    return {
      beforeNs: before.toString(),
      targetHostWallNs: wall.toString(),
      afterNs: normalized.toString(),
      autoProgressBefore: false,
      autoProgressAfter: true,
    };
  }

  async readReplicaTimeNs(): Promise<string> {
    return (
      await readQualificationTimeNs(
        this.controlUrl,
        this.instanceId,
        this.#ownedProcess,
      )
    ).toString();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    const failures = await cleanupPartialEnvironment({
      temporaryRoot: this.#temporaryRoot,
      ownedProcess: this.#ownedProcess,
      control: this.#control,
      creation: {
        instanceId: this.instanceId,
        gatewayId: this.gatewayId,
      },
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "The isolated PocketIC qualification environment did not stop cleanly",
      );
    }
  }
}

type OwnedPocketIcProcess = {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exitState(): { code: number | null; signal: NodeJS.Signals | null } | null;
  stderr(): string;
};

async function assertQualificationGatewayAvailable(): Promise<void> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(
        new Error(
          `The isolated qualification gateway ${QUALIFICATION_GATEWAY_IP}:${QUALIFICATION_GATEWAY_PORT} is unavailable; refusing to attach to any existing listener`,
          { cause: error },
        ),
      );
    };
    server.once("error", onError);
    server.listen(
      {
        host: QUALIFICATION_GATEWAY_IP,
        port: QUALIFICATION_GATEWAY_PORT,
        exclusive: true,
      },
      () => {
        server.close((error) => {
          server.off("error", onError);
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      },
    );
  });
}

async function launchOwnedPocketIc(
  binary: ResolvedPocketIcBinary,
  portFile: string,
): Promise<OwnedPocketIcProcess> {
  if (binary.version !== POCKET_IC_SERVER_VERSION) {
    throw new Error(
      `Qualification requires PocketIC ${POCKET_IC_SERVER_VERSION}`,
    );
  }
  const child = spawn(
    binary.path,
    [
      ...pocketIcServerArguments(portFile, SERVER_TTL_SECONDS),
      "--port",
      "0",
      "--hard-ttl",
      String(SERVER_TTL_SECONDS),
      "--ip-addr",
      "127.0.0.1",
    ],
    {
      detached: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let exit:
    | { code: number | null; signal: NodeJS.Signals | null }
    | null = null;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-SERVER_LOG_LIMIT_BYTES);
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return {
    child,
    exited,
    exitState: () => exit,
    stderr: () => stderr.trim(),
  };
}

async function waitForControlPort(
  portFile: string,
  process: OwnedPocketIcProcess,
): Promise<number> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertOwnedProcessRunning(process, "before writing its control port");
    try {
      const source = await readFile(portFile, "utf8");
      const match = source.match(/^([1-9][0-9]{0,4})\n$/u);
      if (match === null) {
        if (source.length > 0) {
          throw new Error("PocketIC control port file is malformed");
        }
      } else {
        const port = Number(match[1]);
        assertQualificationControlPort(port);
        return port;
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error(
    `PocketIC did not write its control port within ${SERVER_READY_TIMEOUT_MS}ms`,
  );
}

async function createQualificationInstance(
  controlUrl: string,
  config: QualificationInstanceConfig,
  process: OwnedPocketIcProcess,
): Promise<QualificationInstanceCreation> {
  assertOwnedProcessRunning(process, "before instance creation");
  const response = await fetchWithTimeout(
    new URL("instances", controlUrl),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    },
    INSTANCE_READY_TIMEOUT_MS,
  );
  const source = await boundedResponseText(
    response,
    MAX_JSON_BYTES,
    "PocketIC create-instance response",
  );
  if (!response.ok) {
    throw new Error(
      `PocketIC instance creation failed: HTTP ${response.status}${source.length === 0 ? "" : `: ${source.slice(0, 1024)}`}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("PocketIC create-instance response is not JSON", {
      cause: error,
    });
  }
  return parseQualificationInstanceCreation(value);
}

async function readQualificationGatewayStatus(
  gatewayTransportOrigin: string,
): Promise<{ rootKeyBase64: string }> {
  if (
    gatewayTransportOrigin !==
    `http://${QUALIFICATION_GATEWAY_IP}:${QUALIFICATION_GATEWAY_PORT}`
  ) {
    throw new Error(
      "PocketIC qualification gateway transport origin is not isolated",
    );
  }
  const response = await fetchWithTimeout(
    new URL("api/v2/status", `${gatewayTransportOrigin}/`),
    { method: "GET", headers: { Accept: "application/cbor" } },
    SERVER_READY_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(
      `PocketIC gateway health failed: HTTP ${response.status}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let decoded: unknown;
  try {
    decoded = Cbor.decode<unknown>(bytes);
  } catch (error) {
    throw new Error("PocketIC gateway returned invalid CBOR status", {
      cause: error,
    });
  }
  const status = record(decoded, "PocketIC gateway status");
  if (
    !(status.root_key instanceof Uint8Array) ||
    status.root_key.byteLength === 0
  ) {
    throw new Error("PocketIC gateway status has no root_key");
  }
  if (status.replica_health_status !== "healthy") {
    throw new Error("PocketIC gateway is not healthy");
  }
  return {
    rootKeyBase64: Buffer.from(status.root_key).toString("base64"),
  };
}

async function readQualificationTimeNs(
  controlUrl: string,
  instanceId: number,
  process: OwnedPocketIcProcess,
): Promise<bigint> {
  const endpoint = `instances/${instanceId}/read/get_time`;
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertOwnedProcessRunning(process, "while reading its clock");
    const response = await fetchWithTimeout(
      new URL(endpoint, controlUrl),
      { method: "GET", headers: { Accept: "application/json" } },
      remainingMilliseconds(deadline, endpoint),
    );
    if (response.status === 409) {
      await delay(20);
      continue;
    }
    const source = await boundedResponseText(
      response,
      1024,
      "PocketIC get_time response",
    );
    if (!response.ok) {
      throw new Error(
        `PocketIC get_time failed: HTTP ${response.status}${source.length === 0 ? "" : `: ${source}`}`,
      );
    }
    const match = source.match(
      /^\{"nanos_since_epoch":([0-9]+)\}$/u,
    );
    if (match === null) {
      throw new Error("PocketIC get_time returned an invalid clock");
    }
    const nanoseconds = BigInt(match[1]!);
    if (nanoseconds > 18_446_744_073_709_551_615n) {
      throw new Error("PocketIC get_time exceeded its u64 clock");
    }
    return nanoseconds;
  }
  throw new Error("PocketIC get_time remained busy");
}

async function executeQualificationControlOperation(input: {
  controlUrl: string;
  endpoint: string;
  body: string;
  process: OwnedPocketIcProcess;
}): Promise<void> {
  const deadline = Date.now() + CONTROL_OPERATION_TIMEOUT_MS;
  while (true) {
    assertOwnedProcessRunning(
      input.process,
      `while executing ${input.endpoint}`,
    );
    const response = await fetchWithTimeout(
      new URL(input.endpoint, input.controlUrl),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: input.body,
      },
      remainingMilliseconds(deadline, input.endpoint),
    );
    const value = await boundedJson(
      response,
      4096,
      `PocketIC ${input.endpoint} response`,
    );
    const operation = qualificationOperationReference(value);
    if (response.status === 409 && operation !== null) {
      await delay(10);
      continue;
    }
    if (response.status === 202 && operation !== null) {
      await awaitQualificationControlOperation({
        controlUrl: input.controlUrl,
        operation,
        deadline,
        sourceEndpoint: input.endpoint,
        process: input.process,
      });
      return;
    }
    assertSuccessfulNoOutput(response, value, input.endpoint);
    return;
  }
}

async function awaitQualificationControlOperation(input: {
  controlUrl: string;
  operation: { stateLabel: string; operationId: string };
  deadline: number;
  sourceEndpoint: string;
  process: OwnedPocketIcProcess;
}): Promise<void> {
  const endpoint = `read_graph/${encodeURIComponent(input.operation.stateLabel)}/${encodeURIComponent(input.operation.operationId)}`;
  while (true) {
    assertOwnedProcessRunning(
      input.process,
      `while awaiting ${input.sourceEndpoint}`,
    );
    const response = await fetchWithTimeout(
      new URL(endpoint, input.controlUrl),
      { method: "GET", headers: { Accept: "application/json" } },
      remainingMilliseconds(input.deadline, input.sourceEndpoint),
    );
    const value = await boundedJson(
      response,
      4096,
      `PocketIC ${endpoint} response`,
    );
    if (
      response.status === 202 ||
      response.status === 404 ||
      response.status === 409 ||
      qualificationOperationReference(value) !== null
    ) {
      await delay(10);
      continue;
    }
    assertSuccessfulNoOutput(response, value, endpoint);
    return;
  }
}

function qualificationOperationReference(
  value: unknown,
): { stateLabel: string; operationId: string } | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("state_label" in value) ||
    !("op_id" in value)
  ) {
    return null;
  }
  const operation = value as Record<string, unknown>;
  const stateLabel = operation.state_label;
  const operationId = operation.op_id;
  if (
    typeof stateLabel !== "string" ||
    Buffer.from(stateLabel, "base64url").byteLength !== 16 ||
    typeof operationId !== "string" ||
    operationId.length < 1 ||
    operationId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(operationId)
  ) {
    throw new Error("PocketIC operation reference is invalid");
  }
  const canonicalStateLabel = Buffer.from(
    stateLabel,
    "base64url",
  ).toString("base64url");
  if (
    canonicalStateLabel !== stateLabel &&
    `${canonicalStateLabel}==` !== stateLabel
  ) {
    throw new Error("PocketIC operation state label is not canonical");
  }
  return { stateLabel, operationId };
}

function assertSuccessfulNoOutput(
  response: Response,
  value: unknown,
  endpoint: string,
): void {
  if (!response.ok) {
    throw new Error(
      `PocketIC ${endpoint} failed: HTTP ${response.status}: ${JSON.stringify(value).slice(0, 1024)}`,
    );
  }
  if (value !== null) {
    const message =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).message === "string"
        ? String((value as Record<string, unknown>).message)
        : JSON.stringify(value).slice(0, 1024);
    throw new Error(`PocketIC ${endpoint} returned unexpected output: ${message}`);
  }
}

async function boundedJson(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  const source = await boundedResponseText(response, maximumBytes, label);
  if (source.length === 0) {
    throw new Error(`${label} was empty`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} was not JSON`, { cause: error });
  }
}

function remainingMilliseconds(deadline: number, endpoint: string): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) {
    throw new Error(`PocketIC ${endpoint} timed out`);
  }
  return remaining;
}

async function retryUntilHealthy<T>(
  operation: () => Promise<T>,
  process: OwnedPocketIcProcess,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    assertOwnedProcessRunning(process, "during startup");
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw new Error(message, { cause: lastError });
}

async function cleanupPartialEnvironment(input: {
  temporaryRoot: string;
  ownedProcess?: OwnedPocketIcProcess;
  control?: PocketIcRestClient;
  creation?: Pick<QualificationInstanceCreation, "instanceId" | "gatewayId">;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  const processExited = input.ownedProcess?.exitState() !== null;
  if (
    input.control !== undefined &&
    input.creation !== undefined &&
    !processExited
  ) {
    for (const operation of [
      () => input.control!.stopAutoProgress(input.creation!.instanceId),
      () => input.control!.stopGateway(input.creation!.gatewayId),
      () => input.control!.deleteInstance(input.creation!.instanceId),
    ]) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  let stopped = input.ownedProcess === undefined;
  if (input.ownedProcess !== undefined) {
    try {
      await stopOwnedProcess(input.ownedProcess);
      stopped = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (stopped) {
    try {
      await rm(input.temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function stopOwnedProcess(process: OwnedPocketIcProcess): Promise<void> {
  if (process.exitState() !== null) return;
  process.child.kill("SIGTERM");
  if (
    await settlesBefore(
      process.exited,
      PROCESS_STOP_TIMEOUT_MS,
    )
  ) {
    return;
  }
  process.child.kill("SIGKILL");
  if (!(await settlesBefore(process.exited, PROCESS_STOP_TIMEOUT_MS))) {
    throw new Error(
      "The owned PocketIC child did not exit after SIGTERM and SIGKILL",
    );
  }
}

async function settlesBefore<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([promise.then(() => true as const), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

export function encodeQualificationInstallChunkedCodeCall(
  request: Parameters<
    LocalManagementActor["install_chunked_code"]
  >[0],
): QualificationManagementCallTranscript {
  const service = localManagementIdl({ IDL });
  const field = service._fields.find(
    ([method]) => method === "install_chunked_code",
  );
  if (field === undefined) {
    throw new Error(
      "Qualification management IDL omits install_chunked_code",
    );
  }
  const method = field[1];
  if (
    method.argTypes.length !== 1 ||
    method.retTypes.length !== 0 ||
    method.annotations.length !== 0
  ) {
    throw new Error(
      "Qualification management install_chunked_code signature drifted",
    );
  }
  return {
    mode: "update",
    method: "install_chunked_code",
    request: IDL.encode(method.argTypes, [request]),
    reply: IDL.encode(method.retTypes, []),
  };
}

type QualificationManagementStatusActor = {
  canister_status: ActorMethod<
    [{ canister_id: Principal }],
    QualificationManagementStatusWire
  >;
};

const qualificationManagementStatusIdl: IDL.InterfaceFactory = ({
  IDL,
}) =>
  IDL.Service({
    canister_status: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [
        IDL.Record({
          status: IDL.Variant({
            running: IDL.Null,
            stopping: IDL.Null,
            stopped: IDL.Null,
          }),
          version: IDL.Nat64,
          settings: IDL.Record({
            controllers: IDL.Vec(IDL.Principal),
          }),
          module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
        }),
      ],
      [],
    ),
  });

async function executeQualificationCanisterCall(input: {
  control: Pick<
    PocketIcRestClient,
    "submitIngressMessage" | "awaitIngressMessage" | "queryCanister"
  >;
  instanceId: number;
  sender: Principal;
  canisterId: Principal;
  effectiveCanisterId?: Principal;
  idl: IDL.InterfaceFactory;
  method: string;
  args: readonly unknown[];
}): Promise<unknown> {
  const service = input.idl({ IDL });
  const field = service._fields.find(
    ([method]) => method === input.method,
  );
  if (field === undefined) {
    throw new Error(
      `Qualification Candid interface omits ${input.method}`,
    );
  }
  const method = field[1];
  const call = {
    sender: input.sender,
    canisterId: input.canisterId,
    method: input.method,
    payload: new Uint8Array(
      IDL.encode(method.argTypes, [...input.args]),
    ),
    ...(input.effectiveCanisterId === undefined
      ? {}
      : {
          effectivePrincipal:
            qualificationEffectiveCanisterId(
              input.effectiveCanisterId,
            ),
        }),
  };
  const reply = method.annotations.some(
      (annotation) =>
        annotation === "query" || annotation === "composite_query"
    )
    ? await input.control.queryCanister(input.instanceId, call)
    : await input.control.awaitIngressMessage(
        input.instanceId,
        await input.control.submitIngressMessage(
          input.instanceId,
          call,
        ),
      );
  const decoded = IDL.decode(method.retTypes, reply);
  if (
    decoded.length !== method.retTypes.length ||
    decoded.length > 1
  ) {
    throw new Error(
      `Qualification ${input.method} returned the wrong Candid arity`,
    );
  }
  return decoded.length === 0 ? undefined : decoded[0];
}

function qualificationEffectiveCanisterId(
  canister: Principal,
): PocketIcRawEffectivePrincipal {
  return {
    CanisterId: Buffer.from(
      canister.toUint8Array(),
    ).toString("base64"),
  };
}

function canonicalCanister(value: string): Principal {
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch (error) {
    throw new Error("Qualification canister ID is invalid", { cause: error });
  }
  if (
    principal.isAnonymous() ||
    principal.compareTo(Principal.managementCanister()) === "eq"
  ) {
    throw new Error(
      "Qualification target must be a non-anonymous, non-management canister",
    );
  }
  if (principal.toText() !== value) {
    throw new Error("Qualification canister ID is not canonical");
  }
  return principal;
}

function assertQualificationControlPort(port: number): void {
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    port === QUALIFICATION_GATEWAY_PORT
  ) {
    throw new Error(
      `PocketIC control port must be a non-${LIVE_DEVELOPMENT_GATEWAY_IP}:${QUALIFICATION_GATEWAY_PORT} loopback port from 1 through 65535`,
    );
  }
}

function assertOwnedProcessRunning(
  process: OwnedPocketIcProcess,
  context: string,
): void {
  const exit = process.exitState();
  if (exit === null) return;
  const detail = process.stderr();
  throw new Error(
    `The owned PocketIC process exited ${context} (code ${String(exit.code)}, signal ${String(exit.signal)})${detail.length === 0 ? "" : `: ${detail}`}`,
  );
}

async function fetchWithTimeout(
  input: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new Error(`${label} has an invalid or excessive Content-Length`);
  }
  const source = await response.text();
  if (Buffer.byteLength(source, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  return source;
}

function canonicalAbsoluteDirectory(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  allowErrorVariant = false,
): Record<string, unknown> {
  const candidate = record(value, label);
  const actual = Object.keys(candidate).sort();
  if (
    allowErrorVariant &&
    actual.length === 1 &&
    actual[0] === "Error"
  ) {
    return candidate;
  }
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
  return candidate;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value as number;
}

function hostWallTimeNs(): bigint {
  const milliseconds = Date.now();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "Qualification host wall clock is not a nonnegative safe millisecond timestamp",
    );
  }
  return BigInt(milliseconds) * 1_000_000n;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Cannot canonicalize undefined qualification JSON");
  }
  return encoded;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
