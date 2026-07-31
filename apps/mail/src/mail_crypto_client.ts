import {
  callTool,
  listVetKeys,
  loadTileContext,
  requestVetKeys,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
  type VetKeySlotSummary,
  type VetKeysLifecycleResult,
} from "neutron-tools/app";
import {
  getMailCryptoStatus,
  rotateMailCrypto,
  setupMailCrypto,
  type MailBackendCryptoProgress,
} from "./backend.ts";
import {
  MAIL_CRYPTO_SESSION_TOOL,
  MAIL_VETKEY_SLOT,
  type MailCryptoSessionErrorCode,
  type MailCryptoSessionSnapshot,
} from "./mail_crypto_session.ts";

const TILE_READINESS_CALL_TIMEOUT_SECONDS = 70;

export type MailCryptoTilePort = {
  status(): Promise<MailCryptoSessionSnapshot>;
};

type MailCryptoBinding = {
  currentEpoch: string | null;
  previousEpoch: string | null;
};

export class MailCryptoTileFault extends Error {
  constructor(
    readonly code: MailCryptoSessionErrorCode,
    cause?: unknown,
  ) {
    super(mailCryptoReadinessErrorMessage(code), { cause });
    this.name = "MailCryptoTileFault";
  }
}

/**
 * Read an exact post-lifecycle resident binding. The second bounded read
 * handles an older in-flight status call that was correctly invalidated by a
 * rotate/retire transition; neither read accepts a stale generation pair.
 */
export async function recoverMailCryptoSessionForBinding(
  expected: MailCryptoBinding,
  port: MailCryptoTilePort,
): Promise<MailCryptoSessionSnapshot> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const session = await port.status();
      if (
        session.lockState === "unlocked" &&
        session.currentUnlocked &&
        session.currentEpoch === expected.currentEpoch &&
        session.previousEpoch === expected.previousEpoch &&
        (expected.previousEpoch === null || session.previousUnlocked)
      ) return session;
      if (attempt === 0) continue;
      throw new MailCryptoTileFault("capability_changed");
    } catch (error) {
      if (attempt === 0 && isBindingTransitionFault(error)) continue;
      throw error;
    }
  }
  throw new MailCryptoTileFault("capability_changed");
}

export class MailCryptoTileClient implements MailCryptoTilePort {
  readonly #target: MsgBusEndpointId;

  constructor(target = defaultResidentTarget()) {
    this.#target = target;
  }

  async status(): Promise<MailCryptoSessionSnapshot> {
    try {
      return parseSession(await callTool({
        target: this.#target,
        name: MAIL_CRYPTO_SESSION_TOOL,
        arguments: {},
      }, TILE_READINESS_CALL_TIMEOUT_SECONDS));
    } catch (error) {
      throw mailCryptoTileReadinessError(error);
    }
  }
}

export type ActivatePrivateMailDependencies = {
  list?: () => Promise<{ slots: VetKeySlotSummary[] }>;
  reserve: () => Promise<VetKeysLifecycleResult>;
  setup: () => Promise<MailBackendCryptoProgress>;
  status: () => Promise<MailBackendCryptoProgress | null>;
};

const defaultActivationDependencies: ActivatePrivateMailDependencies = {
  list: listVetKeys,
  reserve: () => requestVetKeys({ action: "reserve", slot: MAIL_VETKEY_SLOT }),
  setup: setupMailCrypto,
  status: getMailCryptoStatus,
};

/** Must be started synchronously from the focused tile's activation click. */
export async function activatePrivateMail(
  dependencies: ActivatePrivateMailDependencies = defaultActivationDependencies,
): Promise<MailBackendCryptoProgress> {
  // Reuse an existing slot regardless of which authorized principal manages
  // its lifecycle. Reserve is a one-time lifecycle action, not a read gate.
  const listed = dependencies.list
    ? await dependencies.list().catch(() => ({ slots: [] }))
    : { slots: [] };
  let slot = listed.slots.find((candidate) => candidate.slot === MAIL_VETKEY_SLOT) ?? null;
  if (slot === null) {
    const reserved = await dependencies.reserve();
    slot = reserved.retired ? null : reserved.slot;
  }
  if (slot === null || slot.slot !== MAIL_VETKEY_SLOT) {
    throw new Error("Neutron did not provide the private Mail key slot");
  }
  if (slot.status === "disabled") {
    throw new Error("The private Mail key slot is disabled in Neutron Settings");
  }
  if (slot.status === "manifest_suspended") {
    throw new Error("The private Mail key declaration is suspended");
  }
  try {
    return await dependencies.setup();
  } catch (error) {
    // The setup update may commit just before its browser response is lost or
    // times out. Reconcile only the exact slot generation we just reserved;
    // never turn an unrelated or stale configuration into apparent success.
    const configured = await dependencies.status().catch(() => null);
    if (
      configured !== null &&
      configured.currentEpoch === slot.currentGeneration
    ) {
      return configured;
    }
    throw error;
  }
}

export type MailRotationLifecycleDependencies = {
  request: (input:
    | { action: "rotate"; slot: string }
    | { action: "retireGeneration"; slot: string; generation: string }
  ) => Promise<VetKeysLifecycleResult>;
  reconcile: () => Promise<MailBackendCryptoProgress>;
};

const defaultRotationDependencies: MailRotationLifecycleDependencies = {
  request: (input) => requestVetKeys(input),
  reconcile: rotateMailCrypto,
};

export async function loadMailCryptoProgress(): Promise<MailBackendCryptoProgress | null> {
  return getMailCryptoStatus();
}

/** Must be invoked directly by a focused-tile click handler. */
export async function startMailKeyRotation(
  before: MailBackendCryptoProgress,
  dependencies: MailRotationLifecycleDependencies = defaultRotationDependencies,
): Promise<MailBackendCryptoProgress> {
  if (before.previousEpoch !== null || before.readyToRetire) {
    throw new Error("Finish the current Mail key rotation first");
  }
  // Create the trusted lifecycle request before the first await so the kernel
  // can verify focused-tile transient activation.
  const lifecycle = dependencies.request({ action: "rotate", slot: MAIL_VETKEY_SLOT });
  try {
    const result = await lifecycle;
    const slot = result.slot;
    if (
      result.retired ||
      slot === null ||
      slot.slot !== MAIL_VETKEY_SLOT ||
      slot.currentGeneration === before.currentEpoch ||
      slot.previousGeneration !== before.currentEpoch
    ) throw new Error("Neutron returned an invalid Mail key rotation");
  } catch (error) {
    // A prior trusted rotation may have committed before Mail cached its public
    // generation. Reconciliation is idempotent and makes that interruption
    // recoverable without requesting a third generation.
    const recovered = await dependencies.reconcile();
    if (
      recovered.previousEpoch === before.currentEpoch &&
      recovered.currentEpoch !== before.currentEpoch
    ) return recovered;
    throw error;
  }
  const progress = await dependencies.reconcile();
  if (
    progress.previousEpoch !== before.currentEpoch ||
    progress.currentEpoch === before.currentEpoch
  ) throw new Error("Mail could not reconcile its new key generation");
  return progress;
}

/** Must be invoked directly by a focused-tile click handler. */
export async function retireMailPreviousGeneration(
  before: MailBackendCryptoProgress,
  dependencies: MailRotationLifecycleDependencies = defaultRotationDependencies,
): Promise<MailBackendCryptoProgress> {
  const previous = before.previousEpoch;
  if (!before.readyToRetire || previous === null || before.previousReferences.total !== "0") {
    throw new Error("Mail still has records protected by the previous key");
  }
  const lifecycle = dependencies.request({
    action: "retireGeneration",
    slot: MAIL_VETKEY_SLOT,
    generation: previous,
  });
  try {
    const result = await lifecycle;
    if (
      result.retired ||
      result.slot === null ||
      result.slot.slot !== MAIL_VETKEY_SLOT ||
      result.slot.currentGeneration !== before.currentEpoch ||
      result.slot.previousGeneration !== null
    ) throw new Error("Neutron returned an invalid Mail key retirement");
  } catch (error) {
    const recovered = await dependencies.reconcile();
    if (
      recovered.currentEpoch === before.currentEpoch &&
      recovered.previousEpoch === null
    ) return recovered;
    throw error;
  }
  const progress = await dependencies.reconcile();
  if (progress.currentEpoch !== before.currentEpoch || progress.previousEpoch !== null) {
    throw new Error("Mail could not finish previous-key retirement");
  }
  return progress;
}

export function mailCryptoReadinessErrorMessage(
  code: MailCryptoSessionErrorCode,
): string {
  switch (code) {
    case "not_configured":
      return "Set up private Mail first.";
    case "owner_required":
      return "Sign in with a principal authorized for this Neutron.";
    case "challenge_expired":
      return "Private Mail key recovery expired. Try again.";
    case "busy":
      return "Private Mail is still preparing. Try again shortly.";
    case "low_cycles":
      return "Neutron needs more cycles before private Mail is available.";
    case "capability_changed":
      return "Mail key access changed. Review it in Neutron Settings, then retry.";
    case "unavailable":
      return "Private Mail is temporarily unavailable. Try again.";
  }
}

/** Convert the resident's deliberately terse fault code into bounded UX. */
export function mailCryptoTileReadinessError(error: unknown): Error {
  const message = error instanceof Error ? error.message.trim() : "";
  if (isMailCryptoSessionErrorCode(message)) {
    return new MailCryptoTileFault(message, error);
  }
  return new MailCryptoTileFault("unavailable", error);
}

function isBindingTransitionFault(error: unknown): boolean {
  return error instanceof MailCryptoTileFault
    ? error.code === "capability_changed"
    : error instanceof Error && error.message.trim() === "capability_changed";
}

export function parseSession(value: unknown): MailCryptoSessionSnapshot {
  const record = exactObject(value, [
    "version",
    "lockState",
    "currentEpoch",
    "previousEpoch",
    "currentUnlocked",
    "previousUnlocked",
    "inactivityExpiresAt",
  ], "Mail crypto session");
  if (record.version !== 1) throw new Error("Invalid Mail crypto session");
  if (
    record.lockState !== "not_configured" &&
    record.lockState !== "locked" &&
    record.lockState !== "unlocked"
  ) {
    throw new Error("Invalid Mail crypto session");
  }
  const currentEpoch = nullableDecimal(record.currentEpoch, "Mail current key epoch");
  const previousEpoch = nullableDecimal(record.previousEpoch, "Mail previous key epoch");
  if (
    typeof record.currentUnlocked !== "boolean" ||
    typeof record.previousUnlocked !== "boolean"
  ) throw new Error("Invalid Mail crypto session");
  const inactivityExpiresAt = nullableDecimal(
    record.inactivityExpiresAt,
    "Mail inactivity expiry",
  );
  if (
    (record.lockState === "not_configured") !== (currentEpoch === null) ||
    (record.lockState === "not_configured" &&
      (previousEpoch !== null || inactivityExpiresAt !== null ||
        record.currentUnlocked || record.previousUnlocked)) ||
    (record.lockState === "unlocked") !== record.currentUnlocked ||
    record.previousUnlocked && previousEpoch === null ||
    (inactivityExpiresAt === null) !==
      (!record.currentUnlocked && !record.previousUnlocked) ||
    currentEpoch === "0" ||
    previousEpoch === "0" ||
    (currentEpoch !== null && currentEpoch === previousEpoch)
  ) {
    throw new Error("Invalid Mail crypto session");
  }
  return {
    version: 1,
    lockState: record.lockState,
    currentEpoch,
    previousEpoch,
    currentUnlocked: record.currentUnlocked,
    previousUnlocked: record.previousUnlocked,
    inactivityExpiresAt,
  };
}

function defaultResidentTarget(): MsgBusEndpointId {
  const context = loadTileContext();
  return `app:${context.app ?? "mail"}:background` as MsgBusEndpointId;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): JsonObject {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw new Error(`Invalid ${label}`);
  }
  return value as JsonObject;
}

function nullableDecimal(value: JsonValue | undefined, label: string): string | null {
  return value === null ? null : requiredDecimal(value, label);
}

function requiredDecimal(value: JsonValue | undefined, label: string): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(value) ||
    value.length > 20 ||
    BigInt(value) > ((1n << 64n) - 1n)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isMailCryptoSessionErrorCode(value: string): value is MailCryptoSessionErrorCode {
  return value === "not_configured" ||
    value === "owner_required" ||
    value === "challenge_expired" ||
    value === "busy" ||
    value === "low_cycles" ||
    value === "capability_changed" ||
    value === "unavailable";
}
