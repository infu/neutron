import {
  Actor,
  HttpAgent,
  type ActorSubclass,
  type Identity,
} from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import type { PreparedDeployment, WasmChunk } from "./artifact.ts";
import { chunkWasm, sha256, toHex } from "./artifact.ts";
import {
  EMPTY_CANDID_ARGS,
  MANAGEMENT_CANISTER_ID,
  canonicalNonAnonymousPrincipal,
  canonicalPrincipals,
} from "./ic_client.ts";
import {
  kernelAccessIdl,
  localManagementIdl,
  type KernelAccessActor,
  type LocalManagementActor,
} from "./idl.ts";
import {
  createDirectPocketIcKernelActor,
  type KernelActor,
} from "./kernel.ts";

export const LOCAL_CANISTER_CYCLES = 100_000_000_000_000n;

export type LocalProvisionClientOptions = {
  gatewayUrl: string;
  /** Required only when the caller needs the direct local kernel actor. */
  controlUrl?: string;
  instanceId?: number;
  identity: Identity;
  defaultEffectiveCanisterIdBase64: string;
  expectedRootKeyBase64: string;
  logger?: Pick<Console, "log">;
};

/** Direct PocketIC management adapter. It never invokes `icp` or reads `.icp`. */
export class LocalProvisionClient {
  readonly gatewayUrl: string;
  readonly identity: Identity;
  readonly principal: string;
  readonly agent: HttpAgent;
  readonly defaultEffectiveCanisterId: Principal;
  readonly #controlUrl: string | undefined;
  readonly #instanceId: number | undefined;
  readonly #logger: Pick<Console, "log">;

  private constructor(
    options: LocalProvisionClientOptions,
    agent: HttpAgent,
    defaultEffectiveCanisterId: Principal,
  ) {
    this.gatewayUrl = normalizeLocalProvisionGateway(options.gatewayUrl);
    this.identity = options.identity;
    this.principal = options.identity.getPrincipal().toText();
    this.agent = agent;
    this.defaultEffectiveCanisterId = defaultEffectiveCanisterId;
    this.#controlUrl = options.controlUrl;
    this.#instanceId = options.instanceId;
    this.#logger = options.logger ?? console;
  }

  static async create(
    options: LocalProvisionClientOptions,
  ): Promise<LocalProvisionClient> {
    const gatewayUrl = normalizeLocalProvisionGateway(options.gatewayUrl);
    const defaultEffectiveCanisterId = principalFromCanonicalBase64(
      options.defaultEffectiveCanisterIdBase64,
      "PocketIC default effective canister ID",
    );
    const agent = await HttpAgent.create({
      host: gatewayUrl,
      identity: options.identity,
      verifyQuerySignatures: false,
    });
    const fetchedRootKey = await agent.fetchRootKey();
    const actualRootKeyBase64 = Buffer.from(fetchedRootKey).toString("base64");
    if (actualRootKeyBase64 !== options.expectedRootKeyBase64) {
      throw new Error(
        "PocketIC gateway root key does not match the supervised provision session",
      );
    }
    return new LocalProvisionClient(options, agent, defaultEffectiveCanisterId);
  }

  async createCanister(): Promise<string> {
    const controller = Principal.fromText(this.principal);
    const result = await this.managementActor(
      this.defaultEffectiveCanisterId,
    ).provisional_create_canister_with_cycles({
      amount: [LOCAL_CANISTER_CYCLES],
      settings: [emptySettings([controller])],
      specified_id: [],
      sender_canister_version: [],
    });
    return result.canister_id.toText();
  }

  async hasInstalledModule(canisterId: string): Promise<boolean> {
    return (await this.operationalState(canisterId)).moduleHash !== null;
  }

  async operationalState(canisterId: string): Promise<{
    moduleHash: string | null;
    controllers: string[];
    status: "running" | "stopping" | "stopped";
  }> {
    const canister = Principal.fromText(canisterId);
    const response = await this.managementActor(canister).canister_status({
      canister_id: canister,
    });
    return {
      moduleHash:
        response.module_hash.length === 0
          ? null
          : toHex(response.module_hash[0]!),
      controllers: canonicalPrincipals(
        response.settings.controllers.map((controller) => controller.toText()),
      ),
      status:
        "running" in response.status
          ? "running"
          : "stopping" in response.status
            ? "stopping"
            : "stopped",
    };
  }

  async ensureSelfController(canisterId: string): Promise<void> {
    const canister = Principal.fromText(canisterId);
    const initial = canonicalPrincipals([this.principal]);
    const expected = canonicalPrincipals([this.principal, canisterId]);
    const before = await this.operationalState(canisterId);
    if (sameStrings(before.controllers, expected)) return;
    if (!sameStrings(before.controllers, initial)) {
      throw new Error(
        `PocketIC controller drift on ${canisterId}: found ${before.controllers.join(", ")}`,
      );
    }
    await this.managementActor(canister).update_settings({
      canister_id: canister,
      settings: emptySettings(
        expected.map((controller) => Principal.fromText(controller)),
      ),
      sender_canister_version: [],
    });
    const after = await this.operationalState(canisterId);
    if (!sameStrings(after.controllers, expected)) {
      throw new Error(`PocketIC self-controller update failed for ${canisterId}`);
    }
  }

  async installDeployment({
    canisterId,
    deployment,
    mode,
  }: {
    canisterId: string;
    deployment: PreparedDeployment;
    mode: "install" | "reinstall";
  }): Promise<void> {
    const canister = Principal.fromText(canisterId);
    const management = this.managementActor(canister);
    await management.clear_chunk_store({ canister_id: canister });
    await uploadChunks(management, canister, deployment.chunks, this.#logger);
    const transportWasmHash = sha256(deployment.transportWasm);
    await management.install_chunked_code({
      mode: mode === "install" ? { install: null } : { reinstall: null },
      target_canister: canister,
      store_canister: [],
      chunk_hashes_list: deployment.chunks.map(({ hash }) => ({ hash })),
      wasm_module_hash: transportWasmHash,
      arg: EMPTY_CANDID_ARGS,
      sender_canister_version: [],
    });
    const installed = await this.operationalState(canisterId);
    const expectedHash = toHex(transportWasmHash);
    if (installed.moduleHash !== expectedHash) {
      throw new Error(
        `PocketIC installed module hash ${installed.moduleHash ?? "none"} does not match ${expectedHash}`,
      );
    }
    await management.clear_chunk_store({ canister_id: canister });
  }

  /**
   * Installs a checksum-selected fixture module into an empty local canister.
   * A different installed module is treated as fixture drift rather than being
   * silently replaced.
   */
  async ensurePinnedModule({
    canisterId,
    wasm,
    arg,
    label,
  }: {
    canisterId: string;
    wasm: Uint8Array;
    arg: Uint8Array;
    label: string;
  }): Promise<void> {
    if (wasm.byteLength === 0) {
      throw new Error(`${label} Wasm is empty`);
    }
    const expectedHash = toHex(sha256(wasm));
    const before = await this.operationalState(canisterId);
    if (before.moduleHash === expectedHash) return;
    if (before.moduleHash !== null) {
      throw new Error(
        `${canisterId} contains an unexpected ${label} module; clear the PocketIC state instead of replacing fixtures in place`,
      );
    }

    const canister = Principal.fromText(canisterId);
    const management = this.managementActor(canister);
    const chunks = chunkWasm(wasm);
    await management.clear_chunk_store({ canister_id: canister });
    try {
      await uploadChunks(management, canister, chunks, this.#logger);
      await management.install_chunked_code({
        mode: { install: null },
        target_canister: canister,
        store_canister: [],
        chunk_hashes_list: chunks.map(({ hash }) => ({ hash })),
        wasm_module_hash: sha256(wasm),
        arg,
        sender_canister_version: [],
      });
    } finally {
      await management.clear_chunk_store({ canister_id: canister });
    }
    const after = await this.operationalState(canisterId);
    if (after.moduleHash !== expectedHash) {
      throw new Error(
        `${label} installed module hash ${after.moduleHash ?? "none"} does not match ${expectedHash}`,
      );
    }
  }

  kernelActor(canisterId: string): KernelActor {
    if (this.#controlUrl === undefined || this.#instanceId === undefined) {
      throw new Error("Direct PocketIC kernel access requires its control URL and instance ID");
    }
    return createDirectPocketIcKernelActor({
      controlUrl: this.#controlUrl,
      instanceId: this.#instanceId,
      canisterId,
      caller: this.identity.getPrincipal(),
    });
  }

  async authorizeFreshPrincipals(
    canisterId: string,
    principalTexts: string[],
  ): Promise<string[]> {
    const configured = principalTexts.map((principal, index) =>
      canonicalNonAnonymousPrincipal(
        principal,
        `Configured authorization principal ${index}`,
      ),
    );
    if (new Set(configured).size !== configured.length) {
      throw new Error("Configured authorization principals must be unique");
    }
    const expected = canonicalPrincipals([this.principal, ...configured]);
    const authorized = await this.recoverPrincipals(canisterId, configured);
    if (!sameStrings(authorized, expected)) {
      throw new Error(
        `Fresh PocketIC authorization expected ${expected.join(", ")}, found ${authorized.join(", ") || "none"}`,
      );
    }
    return authorized;
  }

  /** Read-only postflight for the exact configured fresh authorization set. */
  async verifyAuthorizedPrincipals(
    canisterId: string,
    principalTexts: string[],
  ): Promise<string[]> {
    const configured = principalTexts.map((principal, index) =>
      canonicalNonAnonymousPrincipal(
        principal,
        `Configured authorization principal ${index}`,
      ),
    );
    if (new Set(configured).size !== configured.length) {
      throw new Error("Configured authorization principals must be unique");
    }
    const actor = Actor.createActor<KernelAccessActor>(kernelAccessIdl, {
      agent: this.agent,
      canisterId: Principal.fromText(canisterId),
    });
    const snapshot = await actor.kernel_access_snapshot(null);
    if (
      snapshot.self_principal.toText() !==
      Principal.fromText(canisterId).toText()
    ) {
      throw new Error("PocketIC access snapshot belongs to a different canister");
    }
    const controllers = canonicalPrincipals(
      snapshot.controllers.map((entry) => entry.toText()),
    );
    const expectedControllers = canonicalPrincipals([
      this.principal,
      canisterId,
    ]);
    if (!sameStrings(controllers, expectedControllers)) {
      throw new Error(
        `PocketIC controllers expected ${expectedControllers.join(", ")}, found ${controllers.join(", ") || "none"}`,
      );
    }
    const authorized = canonicalPrincipals(
      snapshot.authorized_principals.map((entry) => entry.toText()),
    );
    const expected = canonicalPrincipals([this.principal, ...configured]);
    if (!sameStrings(authorized, expected)) {
      throw new Error(
        `Fresh PocketIC authorization expected ${expected.join(", ")}, found ${authorized.join(", ") || "none"}`,
      );
    }
    return authorized;
  }

  async authorizePrincipal(
    canisterId: string,
    principalText: string,
  ): Promise<string[]> {
    const canonicalTarget = canonicalNonAnonymousPrincipal(
      principalText,
      "Authorization principal",
    );
    const authorized = await this.recoverPrincipals(canisterId, [
      canonicalTarget,
    ]);
    if (
      !authorized.includes(this.principal) ||
      !authorized.includes(canonicalTarget)
    ) {
      throw new Error(
        `PocketIC authorization verification did not find signer ${this.principal} and target ${canonicalTarget}`,
      );
    }
    return authorized;
  }

  private async recoverPrincipals(
    canisterId: string,
    principalTexts: string[],
  ): Promise<string[]> {
    const actor = Actor.createActor<KernelAccessActor>(kernelAccessIdl, {
      agent: this.agent,
      canisterId: Principal.fromText(canisterId),
    });
    const signer = Principal.fromText(this.principal);
    await actor.kernel_authorized_recover(signer);
    for (const principalText of principalTexts) {
      const principal = Principal.fromText(principalText);
      if (principal.compareTo(signer) !== "eq") {
        await actor.kernel_authorized_recover(principal);
      }
    }
    const snapshot = await actor.kernel_access_snapshot(null);
    const authorized = canonicalPrincipals(
      snapshot.authorized_principals.map((entry) => entry.toText()),
    );
    if (
      snapshot.self_principal.toText() !==
      Principal.fromText(canisterId).toText()
    ) {
      throw new Error("PocketIC access snapshot belongs to a different canister");
    }
    const controllers = canonicalPrincipals(
      snapshot.controllers.map((entry) => entry.toText()),
    );
    const expectedControllers = canonicalPrincipals([
      this.principal,
      canisterId,
    ]);
    if (!sameStrings(controllers, expectedControllers)) {
      throw new Error(
        `PocketIC controllers expected ${expectedControllers.join(", ")}, found ${controllers.join(", ") || "none"}`,
      );
    }
    return authorized;
  }

  private managementActor(
    effectiveCanisterId: Principal,
  ): ActorSubclass<LocalManagementActor> {
    return Actor.createActor<LocalManagementActor>(localManagementIdl, {
      agent: this.agent,
      canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
      effectiveCanisterId,
    });
  }
}

async function uploadChunks(
  management: ActorSubclass<LocalManagementActor>,
  canister: Principal,
  chunks: WasmChunk[],
  logger: Pick<Console, "log">,
): Promise<void> {
  for (const chunk of chunks) {
    const result = await management.upload_chunk({
      canister_id: canister,
      chunk: chunk.bytes,
    });
    if (toHex(result.hash) !== chunk.hashHex) {
      throw new Error(
        `PocketIC returned the wrong hash for Wasm chunk ${chunk.hashHex}`,
      );
    }
    logger.log(`Uploaded Wasm chunk ${chunk.hashHex.slice(0, 12)}`);
  }
}

function emptySettings(
  controllers: Principal[],
): Parameters<LocalManagementActor["update_settings"]>[0]["settings"] {
  return {
    controllers: [controllers] as [Principal[]],
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

export function principalFromCanonicalBase64(
  value: string,
  label: string,
): Principal {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  try {
    return Principal.fromUint8Array(bytes);
  } catch (error) {
    throw new Error(`${label} is not a valid raw canister ID`, { cause: error });
  }
}

export function normalizeLocalProvisionGateway(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" &&
      !isCanonicalIpv4Loopback(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error("PocketIC gateway must be a bare loopback HTTP origin");
  }
  return url.href;
}

function isCanonicalIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) =>
        /^(?:0|[1-9][0-9]{0,2})$/u.test(octet) &&
        Number(octet) <= 255,
    )
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
