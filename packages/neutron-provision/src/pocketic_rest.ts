import { Cbor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  parseLocalEnvironment,
  type LocalEnvironment,
} from "./local_environment.ts";

export const NEUTRON_POCKET_IC_GATEWAY_HOST = "localhost" as const;
export const NEUTRON_POCKET_IC_GATEWAY_IP = "127.0.0.1" as const;
export const NEUTRON_POCKET_IC_GATEWAY_PORT = 8000 as const;
export const NEUTRON_POCKET_IC_BITCOIND = "127.0.0.1:18444" as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CREATE_REQUEST_TIMEOUT_MS = 15 * 60_000;
const CANISTER_CALL_TIMEOUT_MS = 2 * 60_000;
const OPERATION_POLL_INTERVAL_MS = 10;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const NEUTRON_POCKET_IC_SUBNET_KINDS = [
  "Application",
  "NNS",
  "SNS",
  "II",
  "Fiduciary",
  "Bitcoin",
  "TestThresholdKeys",
] as const;

export type NeutronPocketIcSubnetKind =
  (typeof NEUTRON_POCKET_IC_SUBNET_KINDS)[number];

export type PocketIcSubnetSpec = {
  state_config: "New";
  instruction_config: "Production";
  subnet_admins: null;
  cost_schedule: "Normal";
};

export type PocketIcInstanceConfig = {
  subnet_config_set: {
    nns: PocketIcSubnetSpec | null;
    sns: PocketIcSubnetSpec | null;
    ii: PocketIcSubnetSpec;
    fiduciary: PocketIcSubnetSpec | null;
    bitcoin: PocketIcSubnetSpec | null;
    test_threshold_keys: PocketIcSubnetSpec;
    system: PocketIcSubnetSpec[];
    application: [PocketIcSubnetSpec];
    cloud_engine: PocketIcSubnetSpec[];
    verified_application: PocketIcSubnetSpec[];
  };
  http_gateway_config: {
    ip_addr: typeof NEUTRON_POCKET_IC_GATEWAY_IP;
    port: typeof NEUTRON_POCKET_IC_GATEWAY_PORT;
    domains: null;
    https_config: null;
    domain_custom_provider_local_file: null;
  };
  state_dir: string;
  icp_config: null;
  log_level: null;
  bitcoind_addr: string[] | null;
  dogecoind_addr: null;
  icp_features: {
    registry: "DefaultConfig" | null;
    cycles_minting: "DefaultConfig" | null;
    icp_token: "DefaultConfig" | null;
    cycles_token: "DefaultConfig" | null;
    nns_governance: "DefaultConfig" | null;
    sns: "DefaultConfig" | null;
    ii: "DefaultConfig";
    nns_ui: "DefaultConfig" | null;
    bitcoin: "DefaultConfig" | null;
    dogecoin: null;
    canister_migration: "DefaultConfig" | null;
  };
  incomplete_state: "Disabled";
  initial_time: {
    AutoProgress: {
      artificial_delay_ms: null;
    };
  };
  mainnet_nns_subnet_id: boolean;
  disable_ingress_validation: false;
};

export type PocketIcRawCanisterId = { canister_id: string };

export type PocketIcSubnetTopology = {
  subnet_kind: NeutronPocketIcSubnetKind;
  subnet_admins: null;
  cost_schedule: "Normal";
  subnet_seed: number[];
  instruction_config: "Production";
  canister_ranges: Array<{
    start: PocketIcRawCanisterId;
    end: PocketIcRawCanisterId;
  }>;
};

export type PocketIcTopology = {
  subnet_configs: Record<string, PocketIcSubnetTopology>;
  default_effective_canister_id: PocketIcRawCanisterId;
};

export type PocketIcTopologySummary = {
  digest: string;
  defaultEffectiveCanisterId: string;
  subnetIds: Partial<Record<NeutronPocketIcSubnetKind, string>>;
};

export type PocketIcInstanceCreation = {
  instanceId: number;
  gatewayId: number;
  gatewayPort: typeof NEUTRON_POCKET_IC_GATEWAY_PORT;
  topology: PocketIcTopology;
  topologySummary: PocketIcTopologySummary;
};

export type PocketIcGatewayStatus = {
  rootKeyBase64: string;
  replicaHealthStatus: "healthy";
};

export type PocketIcFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PocketIcRestClientOptions = {
  fetcher?: PocketIcFetch;
  requestTimeoutMs?: number;
};

export type PocketIcCanisterCall = {
  sender: Principal;
  canisterId: Principal;
  method: string;
  payload: Uint8Array;
  effectivePrincipal?: PocketIcRawEffectivePrincipal;
};

export type PocketIcIngressMessage = {
  effectivePrincipal: PocketIcRawEffectivePrincipal;
  messageId: string;
};

export type PocketIcRawEffectivePrincipal =
  | "None"
  | { CanisterId: string }
  | { SubnetId: string };

export function createNeutronPocketIcInstanceConfig({
  profile,
  stateDirectory,
  gatewayPort = NEUTRON_POCKET_IC_GATEWAY_PORT,
  bitcoindAddresses = [NEUTRON_POCKET_IC_BITCOIND],
}: {
  profile: LocalEnvironment;
  stateDirectory: string;
  gatewayPort?: number;
  bitcoindAddresses?: string[];
}): PocketIcInstanceConfig {
  parseLocalEnvironment(profile, "PocketIC profile");
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error("PocketIC state_dir must be an absolute path");
  }
  if (gatewayPort !== NEUTRON_POCKET_IC_GATEWAY_PORT) {
    throw new Error(
      `The Neutron local gateway is fixed at localhost:${NEUTRON_POCKET_IC_GATEWAY_PORT}`,
    );
  }
  if (profile === "full_protocol_fixtures" && bitcoindAddresses.length === 0) {
    throw new Error("The Neutron PocketIC topology requires a Bitcoin Core address");
  }
  const addresses =
    profile === "full_protocol_fixtures"
      ? bitcoindAddresses.map((address, index) =>
          canonicalSocketAddress(address, `bitcoindAddresses[${index}]`),
        )
      : [];
  if (new Set(addresses).size !== addresses.length) {
    throw new Error("PocketIC Bitcoin Core addresses must be unique");
  }

  return {
    subnet_config_set: {
      // Internet Identity verifies signed query subnet keys. A real NNS root
      // subnet is therefore part of even the lean topology; the optional NNS
      // canister fixtures remain disabled below for the minimal profile.
      nns: newSubnet(),
      sns: profile === "full_protocol_fixtures" ? newSubnet() : null,
      ii: newSubnet(),
      fiduciary: profile === "full_protocol_fixtures" ? newSubnet() : null,
      bitcoin: profile === "full_protocol_fixtures" ? newSubnet() : null,
      test_threshold_keys: newSubnet(),
      system: [],
      application: [newSubnet()],
      cloud_engine: [],
      verified_application: [],
    },
    http_gateway_config: {
      ip_addr: NEUTRON_POCKET_IC_GATEWAY_IP,
      port: NEUTRON_POCKET_IC_GATEWAY_PORT,
      domains: null,
      https_config: null,
      domain_custom_provider_local_file: null,
    },
    state_dir: path.normalize(stateDirectory),
    icp_config: null,
    log_level: null,
    bitcoind_addr:
      profile === "full_protocol_fixtures" ? addresses : null,
    dogecoind_addr: null,
    icp_features: {
      registry:
        profile === "full_protocol_fixtures" ? "DefaultConfig" : null,
      cycles_minting:
        profile === "full_protocol_fixtures" ? "DefaultConfig" : null,
      icp_token:
        profile === "full_protocol_fixtures" ? "DefaultConfig" : null,
      cycles_token:
        profile === "full_protocol_fixtures" ? "DefaultConfig" : null,
      nns_governance:
        profile === "full_protocol_fixtures" ? "DefaultConfig" : null,
      sns: profile === "full_protocol_fixtures" ? "DefaultConfig" : null,
      ii: "DefaultConfig",
      nns_ui:
        profile === "full_protocol_fixtures" ? "DefaultConfig" : null,
      bitcoin:
        profile === "full_protocol_fixtures" ? "DefaultConfig" : null,
      dogecoin: null,
      canister_migration:
        profile === "full_protocol_fixtures" ? "DefaultConfig" : null,
    },
    incomplete_state: "Disabled",
    initial_time: {
      AutoProgress: {
        artificial_delay_ms: null,
      },
    },
    mainnet_nns_subnet_id: profile === "full_protocol_fixtures",
    disable_ingress_validation: false,
  };
}

export function pocketIcInstanceConfigDigest(
  config: PocketIcInstanceConfig,
): string {
  return createHash("sha256")
    .update("neutron-pocketic-instance-config-v1\0")
    .update(canonicalJson(config))
    .digest("hex");
}

export class PocketIcRestClient {
  readonly controlUrl: string;
  readonly #fetcher: PocketIcFetch;
  readonly #requestTimeoutMs: number;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(controlUrl: string, options: PocketIcRestClientOptions = {}) {
    this.controlUrl = normalizePocketIcControlUrl(controlUrl);
    this.#fetcher = options.fetcher ?? fetch;
    this.#requestTimeoutMs = positiveTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  async assertServerHealthy(): Promise<void> {
    await this.#request("status", { method: "GET" }, false);
  }

  async listInstances(): Promise<string[]> {
    const value = await this.#requestJson("instances", { method: "GET" });
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error("PocketIC /instances response must be an array of states");
    }
    return value;
  }

  async createInstance(
    config: PocketIcInstanceConfig,
    profile: LocalEnvironment,
  ): Promise<PocketIcInstanceCreation> {
    const value = await this.#requestJson(
      "instances",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      },
      CREATE_REQUEST_TIMEOUT_MS,
    );
    return parseCreateInstanceResponse(value, profile);
  }

  async readTopology(
    instanceId: number,
    profile: LocalEnvironment,
  ): Promise<PocketIcTopology> {
    const id = canonicalInstanceId(instanceId);
    const value = await this.#requestJson(
      `instances/${id}/read/topology`,
      { method: "GET" },
    );
    return summarizePocketIcTopology(value, profile).topology;
  }

  async isAutoProgressEnabled(instanceId: number): Promise<boolean> {
    const id = canonicalInstanceId(instanceId);
    const value = await this.#requestJson(
      `instances/${id}/auto_progress`,
      { method: "GET" },
    );
    if (typeof value !== "boolean") {
      throw new Error("PocketIC auto-progress response must be a boolean");
    }
    return value;
  }

  async stopAutoProgress(instanceId: number): Promise<void> {
    const id = canonicalInstanceId(instanceId);
    await this.#requestJson(`instances/${id}/stop_progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(""),
    });
  }

  async stopGateway(gatewayId: number): Promise<void> {
    const id = canonicalInstanceId(gatewayId);
    await this.#requestJson(`http_gateway/${id}/stop`, { method: "POST" });
  }

  async deleteInstance(instanceId: number): Promise<void> {
    const id = canonicalInstanceId(instanceId);
    await this.#request(`instances/${id}`, { method: "DELETE" }, false);
  }

  async gatewayStatus(
    gatewayUrl = `http://${NEUTRON_POCKET_IC_GATEWAY_IP}:${NEUTRON_POCKET_IC_GATEWAY_PORT}/`,
  ): Promise<PocketIcGatewayStatus> {
    const base = normalizePocketIcGatewayUrl(gatewayUrl);
    const response = await this.#fetchWithTimeout(
      new URL("api/v2/status", base),
      { method: "GET", headers: { Accept: "application/cbor" } },
      this.#requestTimeoutMs,
    );
    if (!response.ok) {
      throw new Error(`PocketIC gateway health failed: HTTP ${response.status}`);
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
    if (!(status.root_key instanceof Uint8Array) || status.root_key.byteLength === 0) {
      throw new Error("PocketIC gateway status has no root_key");
    }
    if (status.replica_health_status !== "healthy") {
      throw new Error(
        `PocketIC gateway replica is not healthy: ${String(status.replica_health_status)}`,
      );
    }
    return {
      rootKeyBase64: Buffer.from(status.root_key).toString("base64"),
      replicaHealthStatus: "healthy",
    };
  }

  /**
   * Submit one ordinary ingress message through PocketIC's loopback control
   * API. This deliberately does not combine calls: local package restoration
   * still executes one `kernel_static` ingress per operation. Serializing only
   * the server-control operations avoids 409/busy retry storms when hundreds
   * of independent file calls are queued together.
   */
  async submitIngressMessage(
    instanceId: number,
    call: PocketIcCanisterCall,
  ): Promise<PocketIcIngressMessage> {
    const id = canonicalInstanceId(instanceId);
    const value = await this.#serializeOperation(() =>
      this.#operationJson(
        `instances/${id}/update/submit_ingress_message`,
        encodeCanisterCall(call),
        CANISTER_CALL_TIMEOUT_MS,
      ),
    );
    const result = canisterCallResult(value, "submit ingress");
    const record = exactRecord(
      result,
      ["effective_principal", "message_id"],
      "PocketIC submitted ingress",
    );
    return {
      effectivePrincipal: rawEffectivePrincipal(
        record.effective_principal,
        "PocketIC submitted ingress effective principal",
      ),
      messageId: base64Bytes(
        record.message_id,
        32,
        "PocketIC submitted ingress message ID",
      ),
    };
  }

  /** Await one previously submitted ingress and return its raw Candid reply. */
  async awaitIngressMessage(
    instanceId: number,
    message: PocketIcIngressMessage,
  ): Promise<Uint8Array> {
    const id = canonicalInstanceId(instanceId);
    const value = await this.#serializeOperation(() =>
      this.#operationJson(
        `instances/${id}/update/await_ingress_message`,
        {
          effective_principal: message.effectivePrincipal,
          message_id: message.messageId,
        },
        CANISTER_CALL_TIMEOUT_MS,
      ),
    );
    return canisterCallReply(value, "await ingress");
  }

  /** Execute one non-replicated query through the same pinned PocketIC. */
  async queryCanister(
    instanceId: number,
    call: PocketIcCanisterCall,
  ): Promise<Uint8Array> {
    const id = canonicalInstanceId(instanceId);
    const value = await this.#serializeOperation(() =>
      this.#operationJson(
        `instances/${id}/read/query`,
        encodeCanisterCall(call),
        CANISTER_CALL_TIMEOUT_MS,
      ),
    );
    return canisterCallReply(value, "query");
  }

  async #serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #operationJson(
    endpoint: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    const encodedBody = JSON.stringify(body);
    while (true) {
      const response = await this.#fetchWithTimeout(
        new URL(endpoint, this.controlUrl),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: encodedBody,
        },
        remainingTimeout(deadline, endpoint),
      );
      const value = await operationResponseJson(response, endpoint);
      const operation = operationReference(value);
      if (response.status === 409 && operation !== null) {
        await operationDelay(deadline, endpoint);
        continue;
      }
      if (response.status === 202 && operation !== null) {
        return this.#readOperationGraph(operation, deadline, endpoint);
      }
      if (!response.ok) {
        throw operationHttpError(response, endpoint, value);
      }
      assertNoPocketIcServerMessage(value, endpoint);
      return value;
    }
  }

  async #readOperationGraph(
    operation: { stateLabel: string; operationId: string },
    deadline: number,
    sourceEndpoint: string,
  ): Promise<unknown> {
    const endpoint = `read_graph/${encodeURIComponent(operation.stateLabel)}/${encodeURIComponent(operation.operationId)}`;
    while (true) {
      const response = await this.#fetchWithTimeout(
        new URL(endpoint, this.controlUrl),
        { method: "GET", headers: { Accept: "application/json" } },
        remainingTimeout(deadline, sourceEndpoint),
      );
      const value = await operationResponseJson(response, endpoint);
      const pending = operationReference(value);
      if (response.ok && pending === null) {
        assertNoPocketIcServerMessage(value, endpoint);
        return value;
      }
      if (pending !== null) {
        await operationDelay(deadline, sourceEndpoint);
        continue;
      }
      if (
        response.status !== 202 &&
        response.status !== 404 &&
        response.status !== 409
      ) {
        throw operationHttpError(response, endpoint, value);
      }
      await operationDelay(deadline, sourceEndpoint);
    }
  }

  async #requestJson(
    endpoint: string,
    init: RequestInit,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<unknown> {
    const response = await this.#request(endpoint, init, true, timeoutMs);
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > MAX_JSON_RESPONSE_BYTES) {
      throw new Error(`PocketIC ${endpoint} response exceeds the JSON limit`);
    }
    try {
      return JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error(`PocketIC ${endpoint} returned invalid JSON`, {
        cause: error,
      });
    }
  }

  async #request(
    endpoint: string,
    init: RequestInit,
    expectBody: boolean,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<Response> {
    const response = await this.#fetchWithTimeout(
      new URL(endpoint, this.controlUrl),
      {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      },
      timeoutMs,
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1024).trim();
      throw new Error(
        `PocketIC ${init.method ?? "GET"} /${endpoint} failed: HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
      );
    }
    if (expectBody && response.body === null) {
      throw new Error(`PocketIC /${endpoint} returned no response body`);
    }
    return response;
  }

  async #fetchWithTimeout(
    input: URL,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await this.#fetcher(input, { ...init, signal: controller.signal });
    } catch (error) {
      throw new Error(`Unable to reach PocketIC at ${input.origin}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function summarizePocketIcTopology(
  value: unknown,
  profile: LocalEnvironment,
): {
  topology: PocketIcTopology;
  summary: PocketIcTopologySummary;
} {
  const topology = record(value, "PocketIC topology");
  exactKeys(
    topology,
    ["subnet_configs", "default_effective_canister_id"],
    "PocketIC topology",
  );
  const subnetConfigs = record(
    topology.subnet_configs,
    "PocketIC topology.subnet_configs",
  );
  const entries = Object.entries(subnetConfigs);
  const expectedKinds = pocketIcSubnetKinds(profile);
  if (entries.length !== expectedKinds.length) {
    throw new Error(
      `PocketIC ${profile} topology must contain exactly ${expectedKinds.length} subnets`,
    );
  }

  const subnetIds: Partial<Record<NeutronPocketIcSubnetKind, string>> = {};
  for (const [rawSubnetId, rawConfig] of entries) {
    const subnetId = canonicalPrincipal(rawSubnetId, "PocketIC subnet ID");
    const config = record(rawConfig, `PocketIC subnet ${subnetId}`);
    exactKeys(
      config,
      [
        "subnet_kind",
        "subnet_admins",
        "cost_schedule",
        "subnet_seed",
        "instruction_config",
        "canister_ranges",
      ],
      `PocketIC subnet ${subnetId}`,
    );
    if (!isNeutronSubnetKind(config.subnet_kind)) {
      throw new Error(
        `PocketIC topology contains unexpected subnet kind ${String(config.subnet_kind)}`,
      );
    }
    if (!expectedKinds.includes(config.subnet_kind)) {
      throw new Error(
        `PocketIC ${profile} topology contains unexpected ${config.subnet_kind} subnet`,
      );
    }
    if (subnetIds[config.subnet_kind] !== undefined) {
      throw new Error(`PocketIC topology contains duplicate ${config.subnet_kind} subnets`);
    }
    if (config.subnet_admins !== null || config.cost_schedule !== "Normal") {
      throw new Error(`PocketIC ${config.subnet_kind} subnet has non-production settings`);
    }
    if (config.instruction_config !== "Production") {
      throw new Error(`PocketIC ${config.subnet_kind} subnet is not in Production mode`);
    }
    byteArray(config.subnet_seed, 32, `PocketIC ${config.subnet_kind} subnet seed`);
    if (!Array.isArray(config.canister_ranges) || config.canister_ranges.length === 0) {
      throw new Error(`PocketIC ${config.subnet_kind} subnet has no canister ranges`);
    }
    for (const [index, range] of config.canister_ranges.entries()) {
      const parsedRange = record(
        range,
        `PocketIC ${config.subnet_kind} canister range ${index}`,
      );
      exactKeys(
        parsedRange,
        ["start", "end"],
        `PocketIC ${config.subnet_kind} canister range ${index}`,
      );
      rawCanisterId(parsedRange.start, "PocketIC canister range start");
      rawCanisterId(parsedRange.end, "PocketIC canister range end");
    }
    subnetIds[config.subnet_kind] = subnetId;
  }
  for (const kind of expectedKinds) {
    if (subnetIds[kind] === undefined) {
      throw new Error(`PocketIC topology is missing its ${kind} subnet`);
    }
  }

  const defaultEffectiveCanisterId = rawCanisterId(
    topology.default_effective_canister_id,
    "PocketIC default effective canister ID",
  );
  const parsedTopology = value as PocketIcTopology;
  return {
    topology: parsedTopology,
    summary: {
      digest: pocketIcTopologyDigest(parsedTopology),
      defaultEffectiveCanisterId,
      subnetIds,
    },
  };
}

export function pocketIcTopologyDigest(topology: PocketIcTopology): string {
  return createHash("sha256")
    .update("neutron-pocketic-topology-v1\0")
    .update(canonicalJson(topology))
    .digest("hex");
}

export function assertTopologySummary(
  actual: PocketIcTopologySummary,
  expected: PocketIcTopologySummary,
  profile: LocalEnvironment,
): void {
  if (!SHA256_PATTERN.test(expected.digest) || actual.digest !== expected.digest) {
    throw new Error("PocketIC topology digest does not match the deployment session");
  }
  if (actual.defaultEffectiveCanisterId !== expected.defaultEffectiveCanisterId) {
    throw new Error("PocketIC default effective canister ID changed");
  }
  const expectedKinds = pocketIcSubnetKinds(profile);
  if (
    Object.keys(actual.subnetIds).length !== expectedKinds.length ||
    Object.keys(expected.subnetIds).length !== expectedKinds.length
  ) {
    throw new Error(`PocketIC ${profile} subnet inventory changed`);
  }
  for (const kind of expectedKinds) {
    if (actual.subnetIds[kind] !== expected.subnetIds[kind]) {
      throw new Error(`PocketIC ${kind} subnet ID changed`);
    }
  }
}

export function normalizePocketIcControlUrl(value: string): string {
  return normalizeLoopbackUrl(value, "PocketIC control URL", false);
}

export function normalizePocketIcGatewayUrl(value: string): string {
  const normalized = normalizeLoopbackUrl(value, "PocketIC gateway URL", true);
  const url = new URL(normalized);
  if (Number(url.port) !== NEUTRON_POCKET_IC_GATEWAY_PORT) {
    throw new Error(
      `PocketIC gateway URL must use port ${NEUTRON_POCKET_IC_GATEWAY_PORT}`,
    );
  }
  return normalized;
}

function parseCreateInstanceResponse(
  value: unknown,
  profile: LocalEnvironment,
): PocketIcInstanceCreation {
  const response = record(value, "PocketIC create-instance response");
  const keys = Object.keys(response);
  if (keys.length !== 1) {
    throw new Error("PocketIC create-instance response must have one result variant");
  }
  if (keys[0] === "Error") {
    const error = record(response.Error, "PocketIC create-instance error");
    exactKeys(error, ["message"], "PocketIC create-instance error");
    if (typeof error.message !== "string" || error.message.length === 0) {
      throw new Error("PocketIC create-instance error has no message");
    }
    throw new Error(`PocketIC could not create the Neutron instance: ${error.message}`);
  }
  if (keys[0] !== "Created") {
    throw new Error(`Unknown PocketIC create-instance result ${String(keys[0])}`);
  }
  const created = record(response.Created, "PocketIC Created response");
  exactKeys(
    created,
    ["instance_id", "topology", "http_gateway_info"],
    "PocketIC Created response",
  );
  const instanceId = canonicalInstanceId(created.instance_id);
  const gateway = record(created.http_gateway_info, "PocketIC gateway info");
  exactKeys(gateway, ["instance_id", "port"], "PocketIC gateway info");
  const gatewayId = canonicalInstanceId(gateway.instance_id);
  if (gateway.port !== NEUTRON_POCKET_IC_GATEWAY_PORT) {
    throw new Error(
      `PocketIC created gateway on unexpected port ${String(gateway.port)}`,
    );
  }
  const { topology, summary } = summarizePocketIcTopology(
    created.topology,
    profile,
  );
  return {
    instanceId,
    gatewayId,
    gatewayPort: NEUTRON_POCKET_IC_GATEWAY_PORT,
    topology,
    topologySummary: summary,
  };
}

function newSubnet(): PocketIcSubnetSpec {
  return {
    state_config: "New",
    instruction_config: "Production",
    subnet_admins: null,
    cost_schedule: "Normal",
  };
}

function canonicalSocketAddress(value: string, label: string): string {
  const match = value.match(/^127\.0\.0\.1:([1-9][0-9]{0,4})$/);
  if (match === null) {
    throw new Error(`${label} must be a localhost TCP socket address`);
  }
  const port = Number(match[1]);
  if (port > 65_535) throw new Error(`${label} has an invalid TCP port`);
  return value;
}

function normalizeLoopbackUrl(
  value: string,
  label: string,
  allowLocalhost: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} is not a valid URL`, { cause: error });
  }
  const allowedHosts = allowLocalhost
    ? new Set(["127.0.0.1", "localhost"])
    : new Set(["127.0.0.1"]);
  if (
    url.protocol !== "http:" ||
    !allowedHosts.has(url.hostname) ||
    url.port.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${label} must be a plain loopback HTTP origin with an explicit port`);
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} has an invalid port`);
  }
  return url.toString();
}

function rawCanisterId(value: unknown, label: string): string {
  const id = record(value, label);
  exactKeys(id, ["canister_id"], label);
  if (typeof id.canister_id !== "string" || id.canister_id.length === 0) {
    throw new Error(`${label}.canister_id must be base64`);
  }
  const decoded = Buffer.from(id.canister_id, "base64");
  if (
    decoded.byteLength === 0 ||
    decoded.toString("base64") !== id.canister_id
  ) {
    throw new Error(`${label}.canister_id must be canonical base64`);
  }
  return id.canister_id;
}

function byteArray(value: unknown, length: number, label: string): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some(
      (byte) => !Number.isSafeInteger(byte) || (byte as number) < 0 || (byte as number) > 255,
    )
  ) {
    throw new Error(`${label} must contain exactly ${length} bytes`);
  }
  return value as number[];
}

function base64Bytes(value: unknown, length: number, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be canonical base64 containing ${length} bytes`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== length || decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64 containing ${length} bytes`);
  }
  return value;
}

function encodeCanisterCall(call: PocketIcCanisterCall): Record<string, unknown> {
  if (call.method.length === 0 || Buffer.byteLength(call.method, "utf8") > 255) {
    throw new Error("PocketIC canister method must contain 1 through 255 UTF-8 bytes");
  }
  return {
    sender: principalBase64(call.sender),
    canister_id: principalBase64(call.canisterId),
    method: call.method,
    payload: Buffer.from(call.payload).toString("base64"),
    effective_principal: rawEffectivePrincipal(
      call.effectivePrincipal ?? "None",
      "PocketIC canister call effective principal",
    ),
  };
}

function principalBase64(principal: Principal): string {
  return Buffer.from(principal.toUint8Array()).toString("base64");
}

function canisterCallReply(value: unknown, label: string): Uint8Array {
  const result = canisterCallResult(value, label);
  if (typeof result !== "string") {
    throw new Error(`PocketIC ${label} reply must be canonical base64`);
  }
  const decoded = Buffer.from(result, "base64");
  if (decoded.toString("base64") !== result) {
    throw new Error(`PocketIC ${label} reply must be canonical base64`);
  }
  return new Uint8Array(decoded);
}

function canisterCallResult(value: unknown, label: string): unknown {
  const response = record(value, `PocketIC ${label} response`);
  const keys = Object.keys(response);
  if (keys.length !== 1 || (keys[0] !== "Ok" && keys[0] !== "Err")) {
    throw new Error(`PocketIC ${label} response must contain one Ok or Err result`);
  }
  if (keys[0] === "Ok") return response.Ok;
  const reject = record(response.Err, `PocketIC ${label} rejection`);
  const rejectMessage =
    typeof reject.reject_message === "string"
      ? reject.reject_message
      : "unknown rejection";
  throw new Error(
    `PocketIC ${label} failed: ${rejectMessage} (reject ${String(reject.reject_code)}, error ${String(reject.error_code)}, certified ${String(reject.certified)})`,
  );
}

function rawEffectivePrincipal(
  value: unknown,
  label: string,
): PocketIcRawEffectivePrincipal {
  if (value === "None") return value;
  const candidate = record(value, label);
  const keys = Object.keys(candidate);
  if (
    keys.length !== 1 ||
    (keys[0] !== "CanisterId" && keys[0] !== "SubnetId")
  ) {
    throw new Error(`${label} must be None, CanisterId, or SubnetId`);
  }
  const key = keys[0] as "CanisterId" | "SubnetId";
  const encoded = candidate[key];
  if (typeof encoded !== "string") {
    throw new Error(`${label}.${key} must be canonical base64`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== encoded) {
    throw new Error(`${label}.${key} must be canonical base64`);
  }
  return { [key]: encoded } as PocketIcRawEffectivePrincipal;
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  const result = record(value, label);
  exactKeys(result, fields, label);
  return result;
}

function operationReference(
  value: unknown,
): { stateLabel: string; operationId: string } | null {
  if (!isPlainRecord(value)) return null;
  if (!("state_label" in value) || !("op_id" in value)) return null;
  if (
    typeof value.state_label !== "string" ||
    !isCanonicalUrlSafeBase64(value.state_label, 16)
  ) {
    throw new Error("PocketIC operation state label is invalid");
  }
  const operationId = value.op_id;
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new Error("PocketIC operation ID is invalid");
  }
  return {
    stateLabel: value.state_label,
    operationId,
  };
}

function isCanonicalUrlSafeBase64(value: string, length: number): boolean {
  const decoded = Buffer.from(value, "base64url");
  const canonical = decoded
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return decoded.byteLength === length && canonical === value;
}

async function operationResponseJson(
  response: Response,
  endpoint: string,
): Promise<unknown> {
  const source = await response.text();
  if (Buffer.byteLength(source, "utf8") > MAX_JSON_RESPONSE_BYTES) {
    throw new Error(`PocketIC ${endpoint} response exceeds the JSON limit`);
  }
  if (source.length === 0) {
    throw new Error(`PocketIC ${endpoint} returned no JSON response`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`PocketIC ${endpoint} returned invalid JSON`, {
      cause: error,
    });
  }
}

function operationHttpError(
  response: Response,
  endpoint: string,
  value: unknown,
): Error {
  const detail = JSON.stringify(value).slice(0, 1024);
  return new Error(
    `PocketIC POST /${endpoint} failed: HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
  );
}

function assertNoPocketIcServerMessage(value: unknown, endpoint: string): void {
  if (
    isPlainRecord(value) &&
    typeof value.message === "string" &&
    value.message.length > 0
  ) {
    throw new Error(`PocketIC ${endpoint} failed: ${value.message}`);
  }
}

function remainingTimeout(deadline: number, endpoint: string): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) {
    throw new Error(`PocketIC ${endpoint} timed out`);
  }
  return remaining;
}

async function operationDelay(deadline: number, endpoint: string): Promise<void> {
  const remaining = remainingTimeout(deadline, endpoint);
  await new Promise<void>((resolve) =>
    setTimeout(resolve, Math.min(OPERATION_POLL_INTERVAL_MS, remaining)),
  );
}

function canonicalPrincipal(value: string, label: string): string {
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch (error) {
    throw new Error(`${label} is not a principal`, { cause: error });
  }
  if (principal.toText() !== value) {
    throw new Error(`${label} is not canonical`);
  }
  return value;
}

function canonicalInstanceId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("PocketIC instance ID must be a nonnegative safe integer");
  }
  return value as number;
}

function isNeutronSubnetKind(value: unknown): value is NeutronPocketIcSubnetKind {
  return (
    typeof value === "string" &&
    (NEUTRON_POCKET_IC_SUBNET_KINDS as readonly string[]).includes(value)
  );
}

export function pocketIcSubnetKinds(
  profile: LocalEnvironment,
): readonly NeutronPocketIcSubnetKind[] {
  parseLocalEnvironment(profile, "PocketIC profile");
  return profile === "full_protocol_fixtures"
    ? NEUTRON_POCKET_IC_SUBNET_KINDS
    : ["Application", "NNS", "II", "TestThresholdKeys"];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Cannot canonicalize undefined JSON");
  return encoded;
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > CREATE_REQUEST_TIMEOUT_MS) {
    throw new Error("PocketIC request timeout is out of range");
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
