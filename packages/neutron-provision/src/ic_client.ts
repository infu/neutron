import {
  Actor,
  CanisterStatus,
  HttpAgent,
  type ActorSubclass,
  type Identity,
} from "@dfinity/agent";
import { createHash } from "node:crypto";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { AccountIdentifier } from "@icp-sdk/canisters/ledger/icp";
import { Principal as IcpSdkPrincipal } from "@icp-sdk/core/principal";
import { kernelIdl, type KernelActor } from "./kernel.ts";
import type { WasmChunk } from "./artifact.ts";
import { toHex } from "./artifact.ts";
import {
  cmcIdl,
  icpLedgerIdl,
  kernelAccessIdl,
  managementIdl,
  type CmcActor,
  type IcpLedgerActor,
  type KernelAccessActor,
  type ManagementActor,
  type NotifyError,
} from "./idl.ts";

export const ICP_LEDGER_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
export const CMC_CANISTER_ID = "rkp4c-7iaaa-aaaaa-aaaca-cai";
export const MANAGEMENT_CANISTER_ID = "aaaaa-aa";
export const DEFAULT_IC_HOST = "https://icp-api.io";
export const CREATE_CANISTER_MEMO = new Uint8Array([
  0x43, 0x52, 0x45, 0x41, 0x00, 0x00, 0x00, 0x00,
]);
export const EMPTY_CANDID_ARGS = IDL.encode([], []);

export type ProvisionPreflight = {
  ledgerBalanceE8s: bigint;
  ledgerFeeE8s: bigint;
  estimatedCycles: bigint;
  xdrPermyriadPerIcp: bigint;
  targetIsDefault: boolean;
  targetHasSubnetType: boolean;
  targetIsAuthorized: boolean;
};

export type IcpFundingStatus = Pick<
  ProvisionPreflight,
  "ledgerBalanceE8s" | "ledgerFeeE8s"
>;

export type CertifiedCanisterState = {
  subnetId: string;
  controllers: string[];
  moduleHash: string | null;
};

export type CanisterRunState = "running" | "stopping" | "stopped";

export type CanisterOperationalState = {
  status: CanisterRunState;
  version: bigint;
  cycles: bigint;
  moduleHash: string | null;
  settingsFingerprint: string;
  controllers: string[];
};

export type KernelAccessSnapshot = {
  snapshotVersion: bigint;
  authorizedPrincipals: string[];
  controllers: string[];
  selfPrincipal: string;
  controllerLimit: bigint;
};

export type IcProvisionClientOptions = {
  host?: string;
  identity: Identity;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: Pick<Console, "log">;
};

export class IcpTransferBadFeeError extends Error {
  readonly expectedFeeE8s: bigint;

  constructor(expectedFeeE8s: bigint) {
    super(`ICP ledger requires fee ${expectedFeeE8s}`);
    this.name = "IcpTransferBadFeeError";
    this.expectedFeeE8s = expectedFeeE8s;
  }
}

export class IcProvisionClient {
  readonly host: string;
  readonly identity: Identity;
  readonly agent: HttpAgent;
  readonly ledger: ActorSubclass<IcpLedgerActor>;
  readonly cmc: ActorSubclass<CmcActor>;
  readonly deployer: Principal;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #logger: Pick<Console, "log">;

  private constructor(
    options: IcProvisionClientOptions,
    agent: HttpAgent,
  ) {
    this.host = options.host ?? DEFAULT_IC_HOST;
    this.identity = options.identity;
    this.agent = agent;
    this.deployer = options.identity.getPrincipal();
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#logger = options.logger ?? console;
    this.ledger = Actor.createActor<IcpLedgerActor>(icpLedgerIdl, {
      agent,
      canisterId: Principal.fromText(ICP_LEDGER_CANISTER_ID),
    });
    this.cmc = Actor.createActor<CmcActor>(cmcIdl, {
      agent,
      canisterId: Principal.fromText(CMC_CANISTER_ID),
    });
  }

  static async create(
    options: IcProvisionClientOptions,
  ): Promise<IcProvisionClient> {
    assertMainnetHost(options.host ?? DEFAULT_IC_HOST);
    const agent = await HttpAgent.create({
      host: options.host ?? DEFAULT_IC_HOST,
      identity: options.identity,
    });
    return new IcProvisionClient(options, agent);
  }

  async preflight({
    targetSubnet,
    amountE8s,
    requireTargetEligible = true,
  }: {
    targetSubnet: string;
    amountE8s: bigint;
    requireTargetEligible?: boolean;
  }): Promise<ProvisionPreflight> {
    const target = Principal.fromText(targetSubnet);
    const [funding, defaults, typed, authorized, rate] =
      await Promise.all([
        this.fundingStatus(),
        this.cmc.get_default_subnets(),
        this.cmc.get_subnet_types_to_subnets(),
        this.cmc.get_principals_authorized_to_create_canisters_to_subnets(),
        this.cmc.get_icp_xdr_conversion_rate(),
      ]);
    const { ledgerBalanceE8s, ledgerFeeE8s } = funding;

    const targetIsDefault = defaults.some((subnet) => subnet.compareTo(target) === "eq");
    const targetHasSubnetType = typed.data.some(([_type, subnets]) =>
      subnets.some((subnet) => subnet.compareTo(target) === "eq"),
    );
    const targetIsAuthorized = authorized.data.some(
      ([principal, subnets]) =>
        principal.compareTo(this.deployer) === "eq" &&
        subnets.some((subnet) => subnet.compareTo(target) === "eq"),
    );
    if (
      requireTargetEligible &&
      !targetIsDefault &&
      !targetHasSubnetType &&
      !targetIsAuthorized
    ) {
      throw new Error(
        `CMC does not currently allow ${this.deployer.toText()} to create on subnet ${targetSubnet}`,
      );
    }
    return {
      ledgerBalanceE8s,
      ledgerFeeE8s,
      xdrPermyriadPerIcp: rate.data.xdr_permyriad_per_icp,
      estimatedCycles: amountE8s * rate.data.xdr_permyriad_per_icp,
      targetIsDefault,
      targetHasSubnetType,
      targetIsAuthorized,
    };
  }

  async fundingStatus(): Promise<IcpFundingStatus> {
    const account = { owner: this.deployer, subaccount: [] as [] };
    const [ledgerBalanceE8s, ledgerFeeE8s] = await Promise.all([
      this.ledger.icrc1_balance_of(account),
      this.ledger.icrc1_fee(),
    ]);
    return { ledgerBalanceE8s, ledgerFeeE8s };
  }

  async transferCreationIcp({
    amountE8s,
    createdAtTimeNanos,
    feeE8s,
  }: {
    amountE8s: bigint;
    createdAtTimeNanos: bigint;
    feeE8s: bigint;
  }): Promise<bigint> {
    const response = await this.ledger.icrc1_transfer({
      from_subaccount: [],
      to: {
        owner: Principal.fromText(CMC_CANISTER_ID),
        subaccount: [principalSubaccount(this.deployer)],
      },
      amount: amountE8s,
      fee: [feeE8s],
      memo: [CREATE_CANISTER_MEMO],
      created_at_time: [createdAtTimeNanos],
    });
    if ("Ok" in response) return response.Ok;
    if ("Duplicate" in response.Err) return response.Err.Duplicate.duplicate_of;
    if ("BadFee" in response.Err) {
      throw new IcpTransferBadFeeError(response.Err.BadFee.expected_fee);
    }
    if ("TooOld" in response.Err) {
      throw new Error(
        "ICP creation transfer is too old to retry safely. Do not delete or replace the deployment session, and do not pay again until the original transaction has been reconciled on the ledger.",
      );
    }
    throw new Error(`ICP creation transfer failed: ${printVariant(response.Err)}`);
  }

  async notifyCreateCanister({
    blockIndex,
    targetSubnet,
    controllers,
    attempts = 30,
  }: {
    blockIndex: bigint;
    targetSubnet: string;
    controllers: string[];
    attempts?: number;
  }): Promise<string> {
    const target = Principal.fromText(targetSubnet);
    const controllerPrincipals = controllers.map((controller) =>
      Principal.fromText(controller),
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await this.cmc.notify_create_canister({
        block_index: blockIndex,
        controller: this.deployer,
        subnet_type: [],
        subnet_selection: [{ Subnet: { subnet: target } }],
        settings: [emptyCanisterSettings(controllerPrincipals)],
      });
      if ("Ok" in response) return response.Ok.toText();
      if ("Processing" in response.Err) {
        if (attempt === attempts) {
          throw new Error(
            `CMC is still processing ledger block ${blockIndex} after ${attempts} attempts`,
          );
        }
        await this.#sleep(Math.min(1000 * attempt, 5000));
        continue;
      }
      throw new Error(`CMC canister creation failed: ${notifyError(response.Err)}`);
    }
    throw new Error("CMC canister creation exhausted its retry budget");
  }

  async certifiedState(canisterId: string): Promise<CertifiedCanisterState> {
    const principal = Principal.fromText(canisterId);
    const status = await CanisterStatus.request({
      agent: this.agent,
      canisterId: principal,
      paths: ["subnet", "controllers", "module_hash"],
    });
    const subnet = status.get("subnet");
    const controllers = status.get("controllers");
    const moduleHash = status.get("module_hash");
    if (
      !subnet ||
      typeof subnet !== "object" ||
      !("subnetId" in subnet) ||
      typeof subnet.subnetId !== "string"
    ) {
      throw new Error(`Could not verify the certified subnet for ${canisterId}`);
    }
    if (!Array.isArray(controllers)) {
      throw new Error(`Could not verify the certified controllers for ${canisterId}`);
    }
    return {
      subnetId: subnet.subnetId,
      controllers: controllers
        .map((controller) => {
          if (!(controller instanceof Principal)) {
            throw new Error("Certified controller was not a Principal");
          }
          return controller.toText();
        })
        .sort(),
      moduleHash:
        moduleHash === null
          ? null
          : typeof moduleHash === "string"
            ? moduleHash.replace(/^0x/, "").toLowerCase()
            : (() => {
                throw new Error("Certified module hash had an unexpected type");
              })(),
    };
  }

  async operationalState(canisterId: string): Promise<CanisterOperationalState> {
    const canister = Principal.fromText(canisterId);
    const response = await this.managementActor(canisterId).canister_status({
      canister_id: canister,
    });
    const status: CanisterRunState =
      "running" in response.status
        ? "running"
        : "stopping" in response.status
          ? "stopping"
          : "stopped";
    const controllers = canonicalPrincipals(
      response.settings.controllers.map((controller) => controller.toText()),
    );
    const settingsFingerprint = settingsFingerprintForStatus(response.settings);
    return {
      status,
      version: response.version,
      cycles: response.cycles,
      moduleHash:
        response.module_hash.length === 0
          ? null
          : toHex(response.module_hash[0]!),
      settingsFingerprint,
      controllers,
    };
  }

  async ensureStopped(canisterId: string): Promise<CanisterOperationalState> {
    const before = await this.operationalState(canisterId);
    if (before.status !== "stopped") {
      try {
        await this.managementActor(canisterId).stop_canister({
          canister_id: Principal.fromText(canisterId),
        });
      } catch (error) {
        const reconciled = await this.operationalState(canisterId);
        if (reconciled.status !== "stopped") throw error;
        return reconciled;
      }
    }
    const after = await this.operationalState(canisterId);
    if (after.status !== "stopped") {
      throw new Error(`Canister ${canisterId} did not stop cleanly`);
    }
    return after;
  }

  async ensureRunning(canisterId: string): Promise<CanisterOperationalState> {
    const before = await this.operationalState(canisterId);
    if (before.status !== "running") {
      try {
        await this.managementActor(canisterId).start_canister({
          canister_id: Principal.fromText(canisterId),
        });
      } catch (error) {
        const reconciled = await this.operationalState(canisterId);
        if (reconciled.status !== "running") throw error;
        return reconciled;
      }
    }
    const after = await this.operationalState(canisterId);
    if (after.status !== "running") {
      throw new Error(`Canister ${canisterId} did not start cleanly`);
    }
    return after;
  }

  async deleteAllCanisterSnapshots(canisterId: string): Promise<number> {
    const canister = Principal.fromText(canisterId);
    const management = this.managementActor(canisterId);
    const snapshots = await management.list_canister_snapshots({
      canister_id: canister,
    });
    for (const snapshot of snapshots) {
      try {
        await management.delete_canister_snapshot({
          canister_id: canister,
          snapshot_id: snapshot.id,
        });
      } catch (error) {
        const remaining = await management.list_canister_snapshots({
          canister_id: canister,
        });
        if (remaining.some(({ id }) => toHex(id) === toHex(snapshot.id))) {
          throw error;
        }
      }
    }
    const remaining = await management.list_canister_snapshots({
      canister_id: canister,
    });
    if (remaining.length !== 0) {
      throw new Error(
        `Canister ${canisterId} still has ${remaining.length} snapshot(s) after cleanup`,
      );
    }
    return snapshots.length;
  }

  async ensureControllers({
    canisterId,
    initialControllers,
  }: {
    canisterId: string;
    initialControllers: string[];
  }): Promise<string[]> {
    const current = await this.certifiedState(canisterId);
    const initial = canonicalPrincipals(initialControllers);
    const final = canonicalPrincipals([...initialControllers, canisterId]);
    if (sameStrings(current.controllers, final)) return final;
    if (!sameStrings(current.controllers, initial)) {
      throw new Error(
        `Controller drift on ${canisterId}: expected ${initial.join(", ")} before self-controller setup, found ${current.controllers.join(", ")}`,
      );
    }

    const canister = Principal.fromText(canisterId);
    const management = this.managementActor(canisterId);
    await management.update_settings({
      canister_id: canister,
      settings: emptyCanisterSettings(
        final.map((controller) => Principal.fromText(controller)),
      ),
      sender_canister_version: [],
    });
    const verified = await this.certifiedState(canisterId);
    if (!sameStrings(verified.controllers, final)) {
      throw new Error(`Controller update for ${canisterId} did not take effect`);
    }
    return final;
  }

  async installChunkedWasm({
    canisterId,
    chunks,
    transportWasmHash,
  }: {
    canisterId: string;
    chunks: WasmChunk[];
    transportWasmHash: Uint8Array;
  }): Promise<void> {
    const expectedModuleHash = toHex(transportWasmHash);
    const before = await this.certifiedState(canisterId);
    const management = this.managementActor(canisterId);
    const canister = Principal.fromText(canisterId);
    if (before.moduleHash === expectedModuleHash) {
      await management.clear_chunk_store({ canister_id: canister });
      return;
    }
    if (before.moduleHash !== null) {
      throw new Error(
        `Refusing to overwrite unexpected module ${before.moduleHash} on ${canisterId}`,
      );
    }

    await this.uploadMissingChunks(canister, chunks, management);

    try {
      await management.install_chunked_code({
        mode: { install: null },
        target_canister: canister,
        store_canister: [],
        chunk_hashes_list: chunks.map(({ hash }) => ({ hash })),
        wasm_module_hash: transportWasmHash,
        arg: EMPTY_CANDID_ARGS,
        sender_canister_version: [],
      });
    } catch (error) {
      const reconciled = await this.certifiedState(canisterId);
      if (reconciled.moduleHash !== expectedModuleHash) throw error;
    }
    const installed = await this.certifiedState(canisterId);
    if (installed.moduleHash !== expectedModuleHash) {
      throw new Error(
        `Installed module hash ${installed.moduleHash ?? "none"} does not match ${expectedModuleHash}`,
      );
    }
    await management.clear_chunk_store({ canister_id: canister });
  }

  async stageWasmChunks({
    canisterId,
    chunks,
  }: {
    canisterId: string;
    chunks: WasmChunk[];
  }): Promise<void> {
    const canister = Principal.fromText(canisterId);
    const management = this.managementActor(canisterId);
    await management.clear_chunk_store({ canister_id: canister });
    await this.uploadMissingChunks(canister, chunks, management);
    const stored = new Set(
      (await management.stored_chunks({ canister_id: canister })).map(
        ({ hash }) => toHex(hash),
      ),
    );
    const missing = chunks.find(({ hashHex }) => !stored.has(hashHex));
    if (missing) {
      throw new Error(
        `Staged Wasm chunk ${missing.hashHex} is missing from ${canisterId}`,
      );
    }
  }

  async reinstallChunkedWasm({
    canisterId,
    chunks,
    transportWasmHash,
    previousModuleHash,
  }: {
    canisterId: string;
    chunks: WasmChunk[];
    transportWasmHash: Uint8Array;
    previousModuleHash: string;
  }): Promise<void> {
    const expectedModuleHash = toHex(transportWasmHash);
    if (expectedModuleHash === previousModuleHash) {
      throw new Error(
        "Reinstall Wasm must have a unique deployment hash distinct from the running module",
      );
    }
    const before = await this.certifiedState(canisterId);
    const management = this.managementActor(canisterId);
    const canister = Principal.fromText(canisterId);
    if (before.moduleHash === expectedModuleHash) {
      await management.clear_chunk_store({ canister_id: canister });
      return;
    }
    if (before.moduleHash !== previousModuleHash) {
      throw new Error(
        `Canister module drift before reinstall: expected ${previousModuleHash}, found ${before.moduleHash ?? "none"}`,
      );
    }

    await this.uploadMissingChunks(canister, chunks, management);
    try {
      await management.install_chunked_code({
        mode: { reinstall: null },
        target_canister: canister,
        store_canister: [],
        chunk_hashes_list: chunks.map(({ hash }) => ({ hash })),
        wasm_module_hash: transportWasmHash,
        arg: EMPTY_CANDID_ARGS,
        sender_canister_version: [],
      });
    } catch (error) {
      const reconciled = await this.certifiedState(canisterId);
      if (reconciled.moduleHash !== expectedModuleHash) throw error;
    }
    const installed = await this.certifiedState(canisterId);
    if (installed.moduleHash !== expectedModuleHash) {
      throw new Error(
        `Reinstalled module hash ${installed.moduleHash ?? "none"} does not match ${expectedModuleHash}`,
      );
    }
    await management.clear_chunk_store({ canister_id: canister });
  }

  private async uploadMissingChunks(
    canister: Principal,
    chunks: WasmChunk[],
    management: ActorSubclass<ManagementActor>,
  ): Promise<void> {
    const stored = new Set(
      (await management.stored_chunks({ canister_id: canister })).map(({ hash }) =>
        toHex(hash),
      ),
    );
    for (const chunk of chunks) {
      if (stored.has(chunk.hashHex)) continue;
      try {
        const uploaded = await management.upload_chunk({
          canister_id: canister,
          chunk: chunk.bytes,
        });
        const returned = toHex(uploaded.hash);
        if (returned !== chunk.hashHex) {
          throw new Error(
            `Management canister returned chunk hash ${returned}, expected ${chunk.hashHex}`,
          );
        }
        stored.add(returned);
      } catch (error) {
        const reconciled = await management.stored_chunks({
          canister_id: canister,
        });
        if (!reconciled.some(({ hash }) => toHex(hash) === chunk.hashHex)) {
          throw error;
        }
        stored.add(chunk.hashHex);
      }
      this.#logger.log(`Uploaded Wasm chunk ${chunk.hashHex.slice(0, 12)}`);
    }
  }

  kernelActor(canisterId: string): ActorSubclass<KernelActor> {
    return Actor.createActor<KernelActor>(kernelIdl, {
      agent: this.agent,
      canisterId: Principal.fromText(canisterId),
    });
  }

  async verifyInitialKernelAccess(canisterId: string): Promise<void> {
    const snapshot = await this.kernelAccessSnapshot(canisterId);
    assertInitialKernelAccess(
      this.deployer.toText(),
      snapshot.authorizedPrincipals,
    );
  }

  async kernelAccessSnapshot(
    canisterId: string,
  ): Promise<KernelAccessSnapshot> {
    const actor = Actor.createActor<KernelAccessActor>(
      kernelAccessIdl,
      {
        agent: this.agent,
        canisterId: Principal.fromText(canisterId),
      },
    );
    const snapshot = await actor.kernel_access_snapshot(null);
    return {
      snapshotVersion: snapshot.snapshot_version,
      authorizedPrincipals: canonicalPrincipals(
        snapshot.authorized_principals.map((principal) => principal.toText()),
      ),
      controllers: canonicalPrincipals(
        snapshot.controllers.map((principal) => principal.toText()),
      ),
      selfPrincipal: snapshot.self_principal.toText(),
      controllerLimit: snapshot.controller_limit,
    };
  }

  managementActor(canisterId: string): ActorSubclass<ManagementActor> {
    return Actor.createActor<ManagementActor>(managementIdl, {
      agent: this.agent,
      canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
      effectiveCanisterId: Principal.fromText(canisterId),
    });
  }
}

export function principalSubaccount(principal: Principal): Uint8Array {
  const bytes = principal.toUint8Array();
  if (bytes.byteLength > 29) throw new Error("Principal is too long for a subaccount");
  const subaccount = new Uint8Array(32);
  subaccount[0] = bytes.byteLength;
  subaccount.set(bytes, 1);
  return subaccount;
}

export function defaultIcpAccountIdentifier(principal: Principal): string {
  return AccountIdentifier.fromPrincipal({
    principal: IcpSdkPrincipal.fromText(principal.toText()),
  }).toHex();
}

export function canonicalPrincipals(principals: string[]): string[] {
  return [...new Set(principals.map((value) => Principal.fromText(value).toText()))].sort();
}

export function assertInitialKernelAccess(
  deployerPrincipal: string,
  kernelPrincipals: string[],
): void {
  const expected = [canonicalNonAnonymousPrincipal(deployerPrincipal, "Deployer")];
  const actual = canonicalPrincipals(kernelPrincipals);
  if (!sameStrings(actual, expected)) {
    throw new Error(
      `Initial kernel access verification failed: expected only icblast deployer ${expected[0]}, found ${actual.join(", ") || "none"}`,
    );
  }
}

export function canonicalNonAnonymousPrincipal(
  value: string,
  label: string,
): string {
  const principal = Principal.fromText(value);
  if (principal.isAnonymous()) {
    throw new Error(`${label} must not be the anonymous principal`);
  }
  return principal.toText();
}

export function formatIcp(e8s: bigint): string {
  const whole = e8s / 100_000_000n;
  const fraction = (e8s % 100_000_000n).toString().padStart(8, "0");
  return `${whole}.${fraction}`;
}

export function assertMainnetHost(host: string): void {
  const url = new URL(host);
  if (url.protocol !== "https:") {
    throw new Error("Production provisioning requires an HTTPS IC API host");
  }
}

function emptyCanisterSettings(controllers: Principal[]) {
  return {
    controllers: [controllers] as [Principal[]],
    compute_allocation: [] as [],
    memory_allocation: [] as [],
    freezing_threshold: [] as [],
    reserved_cycles_limit: [] as [],
    log_visibility: [] as [],
    wasm_memory_limit: [] as [],
    wasm_memory_threshold: [] as [],
    environment_variables: [] as [],
    snapshot_visibility: [] as [],
    minimum_incoming_canister_call_cycles: [] as [],
  };
}

function notifyError(error: NotifyError): string {
  return printVariant(error);
}

function printVariant(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function settingsFingerprintForStatus(settings: {
  controllers: Principal[];
  compute_allocation: bigint;
  memory_allocation: bigint;
  freezing_threshold: bigint;
  reserved_cycles_limit: bigint;
  log_visibility:
    | { controllers: null }
    | { public: null }
    | { allowed_viewers: Principal[] };
  snapshot_visibility:
    | { controllers: null }
    | { public: null }
    | { allowed_viewers: Principal[] };
  wasm_memory_limit: bigint;
  wasm_memory_threshold: bigint;
  minimum_incoming_canister_call_cycles: bigint;
  environment_variables: Array<{ name: string; value: string }>;
}): string {
  const visibility = (value: typeof settings.log_visibility) =>
    "controllers" in value
      ? { controllers: null }
      : "public" in value
        ? { public: null }
        : {
            allowed_viewers: canonicalPrincipals(
              value.allowed_viewers.map((viewer) => viewer.toText()),
            ),
          };
  const canonical = JSON.stringify({
    controllers: canonicalPrincipals(
      settings.controllers.map((controller) => controller.toText()),
    ),
    computeAllocation: settings.compute_allocation.toString(),
    memoryAllocation: settings.memory_allocation.toString(),
    freezingThreshold: settings.freezing_threshold.toString(),
    reservedCyclesLimit: settings.reserved_cycles_limit.toString(),
    logVisibility: visibility(settings.log_visibility),
    snapshotVisibility: visibility(settings.snapshot_visibility),
    wasmMemoryLimit: settings.wasm_memory_limit.toString(),
    wasmMemoryThreshold: settings.wasm_memory_threshold.toString(),
    minimumIncomingCanisterCallCycles:
      settings.minimum_incoming_canister_call_cycles.toString(),
    environmentVariables: [...settings.environment_variables]
      .map(({ name, value }) => ({ name, value }))
      .sort((left, right) =>
        left.name < right.name
          ? -1
          : left.name > right.name
            ? 1
            : left.value < right.value
              ? -1
              : left.value > right.value
                ? 1
                : 0,
      ),
  });
  return createHash("sha256")
    .update("neutron-canister-settings-v1\0")
    .update(canonical)
    .digest("hex");
}
