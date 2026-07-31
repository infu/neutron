import {
  KernelPolicyError,
  VET_KEYS_ERROR_CODES,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type KernelPolicyErrorCode,
  type VetKeysErrorCode,
  type VetKeyGenerationSummary,
  type VetKeyPublicInfo,
  type VetKeySlotSummary,
} from "neutron-tools/protocol";
import type { RegisteredEndpoint } from "../frame_context.ts";
import { sameAppScope } from "../app_scope.ts";

const MAX_PENDING_PER_APP = 8;
const MAX_PENDING_GLOBAL = 64;
const MAX_DISPATCH_GLOBAL = 4;
const MAX_TERMINAL_CHALLENGES = 256;
const CHALLENGE_TTL_MS = 60_000;
const MAX_U64 = 18_446_744_073_709_551_615n;

export type VetKeysManifestProjection = {
  version: number;
  installationUid?: string;
  slots: Array<{ id: string; purpose: string }>;
};

export type VetKeysAuthProjection = {
  logged: boolean;
  authorized: boolean;
  principal: string;
};

export type VetKeysLifecycleAction =
  | { action: "reserve" | "enable" | "disable" | "rotate" | "retireSlot"; slot: string }
  | { action: "retireGeneration"; slot: string; generation: string }
  | { action: "transfer"; slot: string; newHolder: string };

export type VetKeysBrokerBackend = {
  list(appId: string): Promise<unknown>;
  binding(appId: string, slot: string): Promise<string>;
  lifecycle(appId: string, action: VetKeysLifecycleAction): Promise<unknown>;
  publicKey(appId: string, slot: string, generation: string): Promise<unknown>;
  derive(
    appId: string,
    slot: string,
    generation: string,
    transportPublicKey: number[],
    expectedSlotUid: string,
  ): Promise<unknown>;
};

export type VetKeysBrokerDependencies = {
  backend: VetKeysBrokerBackend;
  manifest(appId: string): VetKeysManifestProjection | null;
  auth(): VetKeysAuthProjection;
  endpoint(endpointId: string): RegisteredEndpoint | null;
  authorityCommitted?: () => boolean;
  authorizeLifecycle(input: {
    endpoint: RegisteredEndpoint;
    action: VetKeysLifecycleAction;
    manifest: VetKeysManifestProjection;
  }): Promise<void>;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  digest?: (value: Uint8Array) => Promise<Uint8Array>;
};

const VET_KEYS_SAFE_MESSAGES: Record<VetKeysErrorCode, string> = {
  not_declared: "The app no longer declares this key slot",
  not_reserved: "This key slot has not been reserved",
  manifest_suspended: "This key slot is suspended",
  disabled: "This key slot is disabled",
  generation_unavailable: "This key generation is unavailable",
  invalid_request: "The key request is invalid",
  challenge_expired: "The key challenge expired",
  challenge_consumed: "The key challenge was already consumed",
  busy: "The key service is busy",
  low_cycles: "Neutron does not have enough cycles for key recovery",
  key_unavailable: "The key is unavailable",
  management_failure: "The threshold key service is unavailable",
  source_gone: "The key request source is unavailable",
  owner_required: "An authorized Neutron principal is required",
};

const KERNEL_POLICY_TO_VET_KEYS_ERROR = {
  UI_BUSY: "busy",
  APP_PAUSED: "source_gone",
  REQUEST_EXPIRED: "challenge_expired",
  REQUEST_CANCELLED: "source_gone",
  OWNER_REQUIRED: "owner_required",
  USER_INTERACTION_REQUIRED: "source_gone",
  INVOCATION_INVALID: "invalid_request",
  INVALID_REQUEST: "invalid_request",
  SCOPED_CONTEXT_REQUIRED: "invalid_request",
  VETKEYS_UNAVAILABLE: "key_unavailable",
  AGENT_CONSENT_DENIED: "source_gone",
  AGENT_CONSENT_TIMEOUT: "source_gone",
  AGENT_CONSENT_LIMIT: "busy",
  AGENT_MODE_REVOKED: "source_gone",
  AGENT_MODE_LIMIT: "busy",
} as const satisfies Record<KernelPolicyErrorCode, VetKeysErrorCode>;

/** Serialize the vetKeys trust boundary without exposing browser/backend stacks. */
export function serializeVetKeysActionError(error: unknown): JsonObject {
  if (error instanceof Error) {
    const details = error as Error & {
      code?: unknown;
    };
    const code = details.code;
    if (
      typeof code === "string" &&
      (VET_KEYS_ERROR_CODES as readonly string[]).includes(code)
    ) {
      return {
        name: "VetKeysError",
        message: VET_KEYS_SAFE_MESSAGES[code as VetKeysErrorCode],
        code,
      };
    }
  }
  if (error instanceof KernelPolicyError) {
    const code = KERNEL_POLICY_TO_VET_KEYS_ERROR[error.code];
    return serializeVetKeysActionError(vetKeysError(code));
  }
  return {
    name: "VetKeysError",
    message: "App-isolated key operation failed",
    code: "key_unavailable",
  };
}

type Challenge = {
  id: string;
  appId: string;
  appVersion: number;
  installationUid?: string;
  slot: string;
  generation: string;
  slotUid: string;
  requesterEndpoint: RegisteredEndpoint;
  requesterEndpointId: string;
  requesterSessionId: string;
  requesterRole: "tile" | "background";
  transportPublicKey: number[];
  transportPublicKeyHash: Uint8Array;
  requestNonce: number[];
  requesterPrincipal: string;
  expiresAt: number;
  state: "pending" | "dispatched";
  timer: ReturnType<typeof setTimeout>;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
};

type TerminalChallenge = {
  state: "expired" | "consumed";
  retainUntil: number;
};

export class VetKeysBrowserBroker {
  readonly #dependencies: VetKeysBrokerDependencies;
  readonly #challenges = new Map<string, Challenge>();
  readonly #terminalChallenges = new Map<string, TerminalChallenge>();
  readonly #publicKeyRequests = new Map<string, Promise<unknown>>();
  readonly #dispatchingApps = new Set<string>();
  #dispatching = 0;

  constructor(dependencies: VetKeysBrokerDependencies) {
    this.#dependencies = dependencies;
  }

  async list(payload: JsonValue, endpoint: RegisteredEndpoint): Promise<JsonObject> {
    parseAppRequest(() => assertEmptyObject(payload, "vetKeys list"));
    const manifest = this.#requireManifest(endpoint);
    const requesterPrincipal = this.#requireAuthorizedPrincipal().principal;
    const sessionId = requireSession(endpoint);
    const raw = await this.#dependencies.backend.list(endpoint.context.appId);
    this.#revalidateEndpoint(endpoint, sessionId);
    this.#requireManifestById(endpoint.context.appId, manifest.version);
    if (this.#requireAuthorizedPrincipal().principal !== requesterPrincipal) {
      throw vetKeysError("owner_required");
    }
    const slots = parseSlotList(raw, manifest);
    return { slots };
  }

  async request(
    payload: JsonValue,
    endpoint: RegisteredEndpoint,
    context: { focused: boolean; delegated: boolean; agentActive: boolean },
  ): Promise<JsonObject> {
    const action = parseAppRequest(() => parseLifecycleAction(payload));
    const manifest = this.#requireManifest(endpoint, action.slot);
    const requesterPrincipal = this.#requireAuthorizedPrincipal().principal;
    if (
      endpoint.context.role !== "tile" ||
      !context.focused ||
      context.delegated ||
      context.agentActive
    ) {
      throw vetKeysError("source_gone");
    }
    const endpointSessionId = requireSession(endpoint);
    await this.#dependencies.authorizeLifecycle({ endpoint, action, manifest });
    this.#revalidateEndpoint(endpoint, endpointSessionId);
    this.#requireManifest(endpoint, action.slot);
    if (this.#requireAuthorizedPrincipal().principal !== requesterPrincipal) {
      throw vetKeysError("owner_required");
    }

    const raw = await this.#dependencies.backend.lifecycle(
      endpoint.context.appId,
      action,
    );
    this.#revalidateEndpoint(endpoint, endpointSessionId);
    this.#requireManifest(endpoint, action.slot);
    if (this.#requireAuthorizedPrincipal().principal !== requesterPrincipal) {
      throw vetKeysError("owner_required");
    }
    if (action.action === "retireSlot") {
      unwrapVetKeysOperationResult(raw, "vetKeys slot retirement");
      return { slot: null, retired: true };
    }
    return {
      slot: parseSlotSummary(
        unwrapVetKeysOperationResult(raw, "vetKeys lifecycle operation"),
        manifest,
      ),
      retired: false,
    };
  }

  async publicKey(payload: JsonValue, endpoint: RegisteredEndpoint): Promise<JsonObject> {
    const request = parseAppRequest(() => parsePublicKeyRequest(payload));
    const manifest = this.#requireManifest(endpoint, request.slot);
    const requesterPrincipal = this.#requireAuthorizedPrincipal().principal;
    const sessionId = requireSession(endpoint);
    const requestKey = `${endpoint.context.appId}\0${endpoint.appScope?.installationUid ?? "unscoped"}\0${request.slot}\0${request.generation}`;
    let pending = this.#publicKeyRequests.get(requestKey);
    if (!pending) {
      if (this.#publicKeyRequests.size >= MAX_PENDING_GLOBAL) {
        throw vetKeysError("busy");
      }
      pending = this.#dependencies.backend.publicKey(
        endpoint.context.appId,
        request.slot,
        request.generation,
      );
      this.#publicKeyRequests.set(requestKey, pending);
      void pending.then(
        () => {
          if (this.#publicKeyRequests.get(requestKey) === pending) {
            this.#publicKeyRequests.delete(requestKey);
          }
        },
        () => {
          if (this.#publicKeyRequests.get(requestKey) === pending) {
            this.#publicKeyRequests.delete(requestKey);
          }
        },
      );
    }
    const raw = await pending;
    this.#revalidateEndpoint(endpoint, sessionId);
    this.#requireManifestById(
      endpoint.context.appId,
      manifest.version,
      request.slot,
    );
    if (this.#requireAuthorizedPrincipal().principal !== requesterPrincipal) {
      throw vetKeysError("owner_required");
    }
    return parsePublicInfo(unwrapVetKeysOperationResult(raw, "vetKeys public key"));
  }

  async begin(
    payload: JsonValue,
    endpoint: RegisteredEndpoint,
    reportProgress: ((value: JsonValue) => void) | undefined,
    _context: { delegated: boolean; agentActive: boolean },
  ): Promise<JsonValue> {
    const request = parseAppRequest(() => parseDeriveRequest(payload));
    const manifest = this.#requireManifest(endpoint, request.slot);
    const requesterPrincipal = this.#requireAuthorizedPrincipal().principal;
    // Recovery is app-internal work. A delegated tool invocation has already
    // crossed the kernel's cross-app permission boundary, so it does not add a
    // second vetKeys consent gate here.
    if (endpoint.context.role === "tray" || !reportProgress) {
      throw vetKeysError("source_gone");
    }
    const requesterSessionId = requireSession(endpoint);
    this.#pruneExpired();
    const appPending = [...this.#challenges.values()].filter(
      (challenge) => challenge.appId === endpoint.context.appId,
    ).length;
    if (appPending >= MAX_PENDING_PER_APP || this.#challenges.size >= MAX_PENDING_GLOBAL) {
      throw vetKeysError("busy");
    }
    if (
      [...this.#challenges.values()].some(
        (challenge) => challenge.requesterEndpointId === endpoint.endpointId,
      )
    ) {
      throw vetKeysError("busy");
    }

    const slots = parseSlotList(
      await this.#dependencies.backend.list(endpoint.context.appId),
      manifest,
    );
    const slot = slots.find((candidate) => candidate.slot === request.slot);
    if (!slot) {
      throw vetKeysError("not_reserved");
    }
    if (slot.status === "manifest_suspended") {
      throw vetKeysError("manifest_suspended");
    }
    if (slot.status === "disabled") {
      throw vetKeysError("disabled");
    }
    if (!slot.generations.some((entry) => entry.generation === request.generation)) {
      throw vetKeysError("generation_unavailable");
    }
    const slotUid = natural(
      await this.#dependencies.backend.binding(
        endpoint.context.appId,
        request.slot,
      ),
      "slot binding",
    );

    const transportBytes = Uint8Array.from(request.transportPublicKey);
    const transportPublicKeyHash = await (
      this.#dependencies.digest ?? sha256
    )(transportBytes);
    this.#revalidateEndpoint(endpoint, requesterSessionId);
    this.#requireManifest(endpoint, request.slot);
    if (this.#requireAuthorizedPrincipal().principal !== requesterPrincipal) {
      throw vetKeysError("owner_required");
    }

    const challengeId = this.#uniqueChallengeId();
    const expiresAt = this.#now() + CHALLENGE_TTL_MS;
    let resolve!: (value: JsonValue) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<JsonValue>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const challenge: Challenge = {
      id: challengeId,
      appId: endpoint.context.appId,
      appVersion: endpoint.appVersion ?? manifest.version,
      ...(endpoint.appScope
        ? { installationUid: endpoint.appScope.installationUid }
        : {}),
      slot: request.slot,
      generation: request.generation,
      slotUid,
      requesterEndpoint: endpoint,
      requesterEndpointId: endpoint.endpointId,
      requesterSessionId,
      requesterRole: endpoint.context.role,
      transportPublicKey: request.transportPublicKey,
      transportPublicKeyHash,
      requestNonce: request.requestNonce,
      requesterPrincipal,
      expiresAt,
      state: "pending",
      timer: setTimeout(() => {
        this.#rememberTerminalChallenge(challengeId, "expired");
        this.#failChallenge(
          challengeId,
          vetKeysError("challenge_expired"),
        );
      }, CHALLENGE_TTL_MS),
      resolve,
      reject,
    };
    this.#challenges.set(challengeId, challenge);
    try {
      reportProgress({
        type: "challenge",
        challengeId,
        expiresAt: String(expiresAt),
      });
    } catch (error) {
      this.#failChallenge(
        challengeId,
        error instanceof Error ? error : new Error("Unable to deliver key challenge"),
      );
    }
    return completion;
  }

  approve(
    payload: JsonValue,
    endpoint: RegisteredEndpoint,
    _context: {
      focused: boolean;
      userActivated: boolean;
      delegated: boolean;
      agentActive: boolean;
    },
  ): JsonObject {
    const challengeId = parseAppRequest(() => parseChallengeApproval(payload));
    this.#pruneExpired();
    const challenge = this.#challenges.get(challengeId);
    if (!challenge) {
      throw vetKeysError(
        this.#terminalChallenges.get(challengeId)?.state === "expired"
          ? "challenge_expired"
          : "challenge_consumed",
      );
    }
    if (challenge.state !== "pending") {
      throw vetKeysError("challenge_consumed");
    }
    // This is a protocol confirmation by the requester itself, not a user
    // approval. Exact endpoint object/session binding prevents another tile,
    // resident, tray, or app from consuming the challenge.
    if (
      endpoint !== challenge.requesterEndpoint ||
      endpoint.endpointId !== challenge.requesterEndpointId ||
      endpoint.context.role === "tray"
    ) {
      throw vetKeysError("source_gone");
    }
    const auth = this.#requireAuthorizedPrincipal();
    if (auth.principal !== challenge.requesterPrincipal) {
      throw vetKeysError("owner_required");
    }
    this.#revalidateRequester(challenge);
    this.#requireManifest(endpoint, challenge.slot);
    if (
      this.#dispatching >= MAX_DISPATCH_GLOBAL ||
      this.#dispatchingApps.has(challenge.appId)
    ) {
      throw vetKeysError("busy");
    }

    // Consume and reserve concurrency before the first backend await.
    challenge.state = "dispatched";
    this.#rememberTerminalChallenge(challenge.id, "consumed");
    clearTimeout(challenge.timer);
    this.#dispatching += 1;
    this.#dispatchingApps.add(challenge.appId);
    void this.#complete(challenge);
    return { approved: true };
  }

  reconcileEndpoints(): void {
    for (const challenge of [...this.#challenges.values()]) {
      try {
        this.#revalidateRequester(challenge);
      } catch (error) {
        this.#failChallenge(
          challenge.id,
          error instanceof Error ? error : new Error("Key requester disappeared"),
        );
      }
    }
  }

  snapshot(): { pending: number; dispatched: number } {
    this.#pruneExpired();
    return { pending: this.#challenges.size, dispatched: this.#dispatching };
  }

  async #complete(challenge: Challenge): Promise<void> {
    try {
      // Recompute the stored binding before dispatch. It is intentionally not
      // included in logs, errors, stable state, or any response.
      const actualHash = await (this.#dependencies.digest ?? sha256)(
        Uint8Array.from(challenge.transportPublicKey),
      );
      if (!constantTimeEqual(actualHash, challenge.transportPublicKeyHash)) {
        throw vetKeysError("source_gone");
      }
      this.#revalidateRequester(challenge);
      const auth = this.#requireAuthorizedPrincipal();
      if (auth.principal !== challenge.requesterPrincipal) {
        throw vetKeysError("owner_required");
      }
      this.#requireManifestById(
        challenge.appId,
        challenge.appVersion,
        challenge.slot,
        challenge.installationUid,
      );
      const raw = await this.#dependencies.backend.derive(
        challenge.appId,
        challenge.slot,
        challenge.generation,
        challenge.transportPublicKey,
        challenge.slotUid,
      );

      // The backend revalidates authorization and stable slot state after its
      // await; the browser broker separately revalidates the exact authorized
      // requester principal and live requester session.
      this.#revalidateRequester(challenge);
      if (
        this.#requireAuthorizedPrincipal().principal !==
          challenge.requesterPrincipal
      ) {
        throw vetKeysError("owner_required");
      }
      this.#requireManifestById(
        challenge.appId,
        challenge.appVersion,
        challenge.slot,
        challenge.installationUid,
      );
      const result = parseDeriveOutput(
        unwrapVetKeysOperationResult(raw, "vetKeys derivation"),
        challenge.slot,
        challenge.generation,
      );
      this.#challenges.delete(challenge.id);
      challenge.resolve(result);
    } catch (error) {
      this.#failChallenge(
        challenge.id,
        error instanceof Error ? error : new Error("Key derivation failed"),
      );
    } finally {
      this.#dispatching = Math.max(0, this.#dispatching - 1);
      this.#dispatchingApps.delete(challenge.appId);
    }
  }

  #requireManifest(
    endpoint: RegisteredEndpoint,
    slot?: string,
  ): VetKeysManifestProjection {
    const manifest = this.#requireManifestById(
      endpoint.context.appId,
      endpoint.appVersion,
      slot,
      endpoint.appScope?.installationUid,
    );
    if (endpoint.context.role === "tray" && slot !== undefined) {
      throw vetKeysError("source_gone");
    }
    return manifest;
  }

  #requireManifestById(
    appId: string,
    expectedVersion: number | undefined,
    slot?: string,
    expectedInstallationUid?: string,
  ): VetKeysManifestProjection {
    const manifest = this.#dependencies.manifest(appId);
    if (
      !manifest ||
      (expectedVersion !== undefined && manifest.version !== expectedVersion) ||
      (expectedInstallationUid !== undefined &&
        manifest.installationUid !== expectedInstallationUid)
    ) {
      throw vetKeysError("source_gone");
    }
    if (slot !== undefined && !manifest.slots.some((entry) => entry.id === slot)) {
      throw vetKeysError("not_declared");
    }
    return manifest;
  }

  #requireAuthorizedPrincipal(): VetKeysAuthProjection {
    const auth = this.#dependencies.auth();
    if (!auth.logged || !auth.authorized || !isPrincipal(auth.principal)) {
      throw vetKeysError("owner_required");
    }
    return auth;
  }

  #revalidateEndpoint(endpoint: RegisteredEndpoint, sessionId: string): void {
    if (this.#dependencies.authorityCommitted?.() === false) {
      throw vetKeysError("source_gone");
    }
    const current = this.#dependencies.endpoint(endpoint.endpointId);
    if (
      current !== endpoint ||
      current.sessionId !== sessionId ||
      (endpoint.appScope !== undefined &&
        !sameAppScope(endpoint.appScope, current.appScope))
    ) {
      throw vetKeysError("source_gone");
    }
  }

  #revalidateRequester(challenge: Challenge): void {
    if (this.#dependencies.authorityCommitted?.() === false) {
      throw vetKeysError("source_gone");
    }
    const endpoint = this.#dependencies.endpoint(challenge.requesterEndpointId);
    if (
      !endpoint ||
      endpoint !== challenge.requesterEndpoint ||
      endpoint.sessionId !== challenge.requesterSessionId ||
      endpoint.context.appId !== challenge.appId ||
      endpoint.context.role !== challenge.requesterRole ||
      (endpoint.appVersion ?? challenge.appVersion) !== challenge.appVersion ||
      (challenge.installationUid !== undefined &&
        endpoint.appScope?.installationUid !== challenge.installationUid)
    ) {
      throw vetKeysError("source_gone");
    }
  }

  #failChallenge(id: string, error: Error): void {
    const challenge = this.#challenges.get(id);
    if (!challenge) return;
    clearTimeout(challenge.timer);
    this.#challenges.delete(id);
    challenge.reject(error);
  }

  #pruneExpired(): void {
    const now = this.#now();
    this.#pruneTerminalChallenges(now);
    for (const challenge of [...this.#challenges.values()]) {
      if (challenge.state === "pending" && challenge.expiresAt <= now) {
        this.#rememberTerminalChallenge(challenge.id, "expired");
        this.#failChallenge(
          challenge.id,
          vetKeysError("challenge_expired"),
        );
      }
    }
  }

  #rememberTerminalChallenge(
    id: string,
    state: TerminalChallenge["state"],
  ): void {
    const now = this.#now();
    this.#pruneTerminalChallenges(now);
    this.#terminalChallenges.delete(id);
    this.#terminalChallenges.set(id, {
      state,
      retainUntil: now + CHALLENGE_TTL_MS,
    });
    while (this.#terminalChallenges.size > MAX_TERMINAL_CHALLENGES) {
      const oldest = this.#terminalChallenges.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#terminalChallenges.delete(oldest);
    }
  }

  #pruneTerminalChallenges(now = this.#now()): void {
    for (const [id, terminal] of this.#terminalChallenges) {
      if (terminal.retainUntil <= now) this.#terminalChallenges.delete(id);
    }
  }

  #uniqueChallengeId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = `vkc_${hex((this.#dependencies.randomBytes ?? secureRandomBytes)(16))}`;
      if (!this.#challenges.has(id) && !this.#terminalChallenges.has(id)) {
        return id;
      }
    }
    throw new Error("Unable to allocate a key challenge");
  }

  #now(): number {
    return this.#dependencies.now?.() ?? Date.now();
  }
}

function parseLifecycleAction(value: JsonValue): VetKeysLifecycleAction {
  const record = object(value, "vetKeys lifecycle request");
  const action = record.action;
  const slot = slotId(record.slot);
  if (["reserve", "enable", "disable", "rotate", "retireSlot"].includes(String(action))) {
    exactKeys(record, ["action", "slot"], "vetKeys lifecycle request");
    return { action: action as "reserve" | "enable" | "disable" | "rotate" | "retireSlot", slot };
  }
  if (action === "retireGeneration") {
    exactKeys(record, ["action", "slot", "generation"], "vetKeys lifecycle request");
    return { action, slot, generation: u64(record.generation, "generation") };
  }
  if (action === "transfer") {
    exactKeys(record, ["action", "slot", "newHolder"], "vetKeys lifecycle request");
    const newHolder = principal(record.newHolder, "new holder");
    return { action, slot, newHolder };
  }
  throw new Error("Invalid vetKeys lifecycle action");
}

function parsePublicKeyRequest(value: JsonValue): { slot: string; generation: string } {
  const record = object(value, "vetKeys public-key request");
  exactKeys(record, ["slot", "generation"], "vetKeys public-key request");
  return { slot: slotId(record.slot), generation: u64(record.generation, "generation") };
}

function parseDeriveRequest(value: JsonValue): {
  slot: string;
  generation: string;
  transportPublicKey: number[];
  requestNonce: number[];
} {
  const record = object(value, "vetKeys derivation request");
  exactKeys(
    record,
    ["slot", "generation", "transportPublicKey", "requestNonce"],
    "vetKeys derivation request",
  );
  return {
    slot: slotId(record.slot),
    generation: u64(record.generation, "generation"),
    transportPublicKey: byteArray(record.transportPublicKey, 48, "transport public key"),
    requestNonce: byteArray(record.requestNonce, 32, "request nonce"),
  };
}

function parseChallengeApproval(value: JsonValue): string {
  const record = object(value, "vetKeys approval request");
  exactKeys(record, ["challengeId"], "vetKeys approval request");
  if (typeof record.challengeId !== "string" || !/^vkc_[0-9a-f]{32}$/u.test(record.challengeId)) {
    throw new Error("Invalid vetKeys challenge id");
  }
  return record.challengeId;
}

function parseSlotList(
  value: unknown,
  manifest: VetKeysManifestProjection,
): VetKeySlotSummary[] {
  if (!Array.isArray(value) || value.length > manifest.slots.length || value.length > 4) {
    throw new Error("Invalid vetKeys slot list");
  }
  const slots = value.map((entry) => parseSlotSummary(entry, manifest));
  if (new Set(slots.map((slot) => slot.slot)).size !== slots.length) {
    throw new Error("Invalid duplicate vetKeys slot summary");
  }
  return slots;
}

function parseSlotSummary(
  value: unknown,
  manifest: VetKeysManifestProjection,
): VetKeySlotSummary {
  const record = unknownObject(value, "vetKeys slot summary");
  exactKeys(record, [
    "slot", "purpose", "key_holder", "status", "environment",
    "current_generation", "previous_generation", "generations", "created_at",
    "updated_at", "last_used_at", "total_derivations", "approximate_cycle_spend",
  ], "vetKeys slot summary", ["previous_generation", "last_used_at"]);
  const slot = slotId(record.slot);
  const declaration = manifest.slots.find((entry) => entry.id === slot);
  if (!declaration || record.purpose !== declaration.purpose) {
    throw new Error("Invalid vetKeys slot declaration projection");
  }
  if (!Array.isArray(record.generations) || record.generations.length < 1 || record.generations.length > 2) {
    throw new Error("Invalid vetKeys generation list");
  }
  const generations: VetKeyGenerationSummary[] = record.generations.map((entry) => {
    const generation = unknownObject(entry, "vetKeys generation summary");
    exactKeys(
      generation,
      ["generation", "status", "key_name", "public_fingerprint"],
      "vetKeys generation summary",
      ["public_fingerprint"],
    );
    return {
      generation: u64(generation.generation, "generation"),
      status: variantTag(generation.status, ["current", "previous"], "generation status"),
      keyName: keyName(generation.key_name),
      publicFingerprint: optionalBytes(generation.public_fingerprint, 32, "public fingerprint"),
    };
  });
  const currentGeneration = u64(record.current_generation, "current generation");
  const previousGeneration = optionalU64(record.previous_generation, "previous generation");
  if (!generations.some((entry) => entry.status === "current" && entry.generation === currentGeneration)) {
    throw new Error("Invalid current vetKeys generation summary");
  }
  if (
    (previousGeneration === null) !== !generations.some((entry) => entry.status === "previous") ||
    (previousGeneration !== null && !generations.some(
      (entry) => entry.status === "previous" && entry.generation === previousGeneration,
    ))
  ) {
    throw new Error("Invalid previous vetKeys generation summary");
  }
  return {
    slot,
    purpose: declaration.purpose,
    keyHolder: principal(record.key_holder, "key holder"),
    status: variantTag(record.status, ["enabled", "disabled", "manifest_suspended"], "slot status"),
    environment: variantTag(record.environment, ["production", "local"], "environment"),
    currentGeneration,
    previousGeneration,
    generations,
    createdAt: u64(record.created_at, "created time"),
    updatedAt: u64(record.updated_at, "updated time"),
    lastUsedAt: optionalU64(record.last_used_at, "last-used time"),
    totalDerivations: natural(record.total_derivations, "total derivations"),
    approximateCycleSpend: natural(record.approximate_cycle_spend, "cycle spend"),
  };
}

function parsePublicInfo(value: unknown): VetKeyPublicInfo {
  const record = unknownObject(value, "vetKeys public information");
  exactKeys(record, [
    "canister_principal", "slot", "generation", "suite", "key_name",
    "public_key", "public_fingerprint", "derivation_input",
  ], "vetKeys public information");
  if (record.suite !== "bls12_381_g2") throw new Error("Invalid vetKeys suite");
  return {
    canisterPrincipal: principal(record.canister_principal, "canister principal"),
    slot: slotId(record.slot),
    generation: u64(record.generation, "generation"),
    suite: "bls12_381_g2",
    keyName: keyName(record.key_name),
    publicKey: bytes(record.public_key, 96, "public key"),
    publicFingerprint: bytes(record.public_fingerprint, 32, "public fingerprint"),
    derivationInput: bytes(record.derivation_input, 32, "derivation input"),
  };
}

function parseDeriveOutput(value: unknown, slot: string, generation: string): JsonObject {
  const record = unknownObject(value, "vetKeys derivation output");
  exactKeys(record, ["encrypted_key", "public_info"], "vetKeys derivation output");
  const publicInfo = parsePublicInfo(record.public_info);
  if (publicInfo.slot !== slot || publicInfo.generation !== generation) {
    throw new Error("Invalid vetKeys derivation binding");
  }
  return {
    encryptedKey: bytes(record.encrypted_key, 192, "encrypted key"),
    publicInfo,
  };
}

export function unwrapVetKeysOperationResult(
  value: unknown,
  label: string,
): unknown {
  const result = unknownObject(value, `${label} result`);
  const entries = Object.entries(result);
  if (entries.length !== 1) throw new Error(`Invalid ${label} result`);
  const [tag, payload] = entries[0]!;
  if (tag === "ok") return payload;
  if (tag !== "err") throw new Error(`Invalid ${label} result`);
  throw operationError(payload);
}

function operationError(value: unknown): Error {
  const error = unknownObject(value, "vetKeys error");
  const entries = Object.entries(error);
  if (entries.length !== 1) return new Error("App-isolated key operation failed");
  const [tag, payload] = entries[0]!;
  const mapped = VET_KEYS_SAFE_MESSAGES[tag as VetKeysErrorCode];
  if (!mapped || payload !== null) return new Error("App-isolated key operation failed");
  return vetKeysError(tag as VetKeysErrorCode);
}

function vetKeysError(
  code: VetKeysErrorCode,
): Error {
  const error = new Error(VET_KEYS_SAFE_MESSAGES[code]);
  error.name = "VetKeysError";
  Object.defineProperty(error, "code", {
    configurable: true,
    enumerable: true,
    value: code,
  });
  return error;
}

function parseAppRequest<Value>(parse: () => Value): Value {
  try {
    return parse();
  } catch (error) {
    if (
      error instanceof Error &&
      typeof (error as Error & { code?: unknown }).code === "string" &&
      (VET_KEYS_ERROR_CODES as readonly string[]).includes(
        (error as Error & { code: string }).code,
      )
    ) {
      throw error;
    }
    throw vetKeysError("invalid_request");
  }
}

function object(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function unknownObject(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
  optional: string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const optionalKeys = new Set(optional);
  if (
    actual.some((key) => !wanted.includes(key)) ||
    wanted.some((key) => !optionalKeys.has(key) && !Object.hasOwn(value, key))
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertEmptyObject(value: JsonValue, label: string): void {
  const record = object(value, label);
  if (Object.keys(record).length !== 0) throw new Error(`Invalid ${label}`);
}

function slotId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,39}$/u.test(value)) {
    throw new Error("Invalid vetKeys slot");
  }
  return value;
}

function u64(value: unknown, label: string): string {
  const text = natural(value, label);
  const parsed = BigInt(text);
  if (parsed < 1n || parsed > MAX_U64) throw new Error(`Invalid vetKeys ${label}`);
  return text;
}

function optionalU64(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return u64(value, label);
  if (value.length === 0) return null;
  if (value.length !== 1) throw new Error(`Invalid vetKeys ${label}`);
  return u64(value[0], label);
}

function natural(value: unknown, label: string): string {
  const text = typeof value === "bigint" ? value.toString() :
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (
    typeof text !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(text) ||
    BigInt(text) > MAX_U64
  ) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return text;
}

function principal(value: unknown, label: string): string {
  if (typeof value !== "string" || !isPrincipal(value)) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return value;
}

function isPrincipal(value: string): boolean {
  return value.length >= 5 && value.length <= 80 && /^[a-z0-9-]+$/u.test(value);
}

function keyName(value: unknown): "key_1" | "test_key_1" {
  if (value !== "key_1" && value !== "test_key_1") throw new Error("Invalid vetKeys key name");
  return value;
}

function variantTag<const Tag extends string>(
  value: unknown,
  allowed: readonly Tag[],
  label: string,
): Tag {
  const record = unknownObject(value, `vetKeys ${label}`);
  const entries = Object.entries(record);
  if (entries.length !== 1 || entries[0]![1] !== null || !allowed.includes(entries[0]![0] as Tag)) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return entries[0]![0] as Tag;
}

function bytes(value: unknown, length: number, label: string): number[] {
  const array = typeof value === "string"
    ? hexBytes(value, length, label)
    : value instanceof Uint8Array
      ? [...value]
      : value;
  return byteArray(array, length, label);
}

function hexBytes(value: string, length: number, label: string): number[] {
  if (
    value.length !== length * 2 ||
    !/^[0-9a-f]+$/u.test(value)
  ) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return Array.from(
    { length },
    (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function optionalBytes(value: unknown, length: number, label: string): number[] | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return bytes(value, length, label);
  if (!Array.isArray(value)) return bytes(value, length, label);
  if (value.length === 0) return null;

  // icblast/@dfinity represent `opt vec nat8` as []/[Uint8Array]. Keep
  // accepting an already-unwrapped number[] vector, but never reinterpret a
  // malformed multi-value option as a byte vector.
  if (value.length === 1 && (value[0] instanceof Uint8Array || Array.isArray(value[0]))) {
    return bytes(value[0], length, label);
  }
  return bytes(value, length, label);
}

function byteArray(value: unknown, length: number, label: string): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)
  ) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return value.slice() as number[];
}

function secureRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure randomness is unavailable");
  const value = new Uint8Array(length);
  globalThis.crypto.getRandomValues(value);
  return value;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure hashing is unavailable");
  const bytes = Uint8Array.from(value);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function requireSession(endpoint: RegisteredEndpoint): string {
  if (!endpoint.sessionId) {
    throw vetKeysError("source_gone");
  }
  return endpoint.sessionId;
}
