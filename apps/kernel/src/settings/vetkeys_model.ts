import type { Principal } from "@dfinity/principal";
import { isValidAppId } from "neutron-tools/src/app_ids.js";

export type VetKeysEnvironment = "production" | "local";
export type VetKeysSlotStatus = "enabled" | "disabled" | "manifest_suspended";
export type VetKeysGenerationStatus = "current" | "previous";

export type VetKeysGeneration = {
  generation: string;
  status: VetKeysGenerationStatus;
  keyName: "key_1" | "test_key_1";
  publicFingerprint: number[] | null;
};

export type VetKeysAdminSlot = {
  appId: string;
  installationUid: string;
  slotUid: string;
  slot: string;
  purpose: string | null;
  keyHolder: string;
  status: VetKeysSlotStatus;
  currentGeneration: string;
  previousGeneration: string | null;
  generations: VetKeysGeneration[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastUsedAt: string | null;
  totalDerivations: string;
  approximateCycleSpend: string;
};

export type VetKeysAuditEntry = {
  at: string;
  appId: string;
  installationUid: string;
  slotUid: string | null;
  slot: string;
  generation: string | null;
  action:
    | "reserve"
    | "enable"
    | "disable"
    | "rotate"
    | "retire_generation"
    | "transfer"
    | "retire_slot"
    | "uninstall"
    | "derive"
    | "public_key"
    | "manifest_suspend";
  principal: string;
  outcome:
    | "ok"
    | "denied"
    | "busy"
    | "low_cycles"
    | "unavailable"
    | "failed";
};

export type VetKeysAdminSnapshot = {
  environment: VetKeysEnvironment | null;
  slots: VetKeysAdminSlot[];
  audit: VetKeysAuditEntry[];
};

export type VetKeysSlotControlPolicy = {
  owns: boolean;
  showEnable: boolean;
  showDisable: boolean;
  canEnable: boolean;
  canDisable: boolean;
  canRotate: boolean;
  canRetireGeneration: boolean;
  canRetireSlot: boolean;
  canTransfer: boolean;
};

const ACTIONS = [
  "reserve",
  "enable",
  "disable",
  "rotate",
  "retire_generation",
  "transfer",
  "retire_slot",
  "uninstall",
  "derive",
  "public_key",
  "manifest_suspend",
] as const;
const OUTCOMES = [
  "ok",
  "denied",
  "busy",
  "low_cycles",
  "unavailable",
  "failed",
] as const;

export function validateVetKeysAdminSnapshot(value: unknown): VetKeysAdminSnapshot {
  const record = object(value, "vetKeys administrative snapshot");
  const slots = array(record.slots, 128, "vetKeys slots").map(validateSlot);
  if (new Set(slots.map(({ slotUid }) => slotUid)).size !== slots.length) {
    throw new Error("Duplicate vetKeys slot identity");
  }
  return {
    environment: optional(record.environment, (entry) =>
      variant(entry, ["production", "local"], "vetKeys environment"),
    ),
    slots: slots.sort((left, right) =>
      `${left.appId}\0${left.slot}`.localeCompare(`${right.appId}\0${right.slot}`),
    ),
    audit: array(record.audit, 256, "vetKeys audit").map(validateAudit),
  };
}

export function assertVetKeysOperation(value: unknown): void {
  const result = object(value, "vetKeys operation result");
  const entries = Object.entries(result);
  if (entries.length !== 1) throw new Error("Invalid vetKeys operation result");
  const [tag, payload] = entries[0]!;
  if (tag === "ok") return;
  if (tag !== "err") throw new Error("Invalid vetKeys operation result");
  const error = object(payload, "vetKeys operation error");
  const errorEntries = Object.entries(error);
  if (errorEntries.length !== 1) throw new Error("Private-key operation failed");
  const [code, detail] = errorEntries[0]!;
  const messages: Record<string, string> = {
    not_declared: "This app no longer declares the private-key slot",
    not_reserved: "This private-key slot is not active",
    manifest_suspended: "This private-key slot is suspended",
    disabled: "This private-key slot is disabled",
    generation_unavailable: "This private-key generation is unavailable",
    invalid_request: "The private-key request is invalid",
    busy: "Another private-key operation is running",
    low_cycles: "Neutron does not have enough cycles for private-key recovery",
    key_unavailable: "The private key is unavailable",
    management_failure: "The threshold-key service is unavailable",
    source_gone: "The private-key slot changed; refresh and try again",
    owner_required: "Only the slot key manager can make this lifecycle change",
  };
  if (detail !== null && !(Array.isArray(detail) && detail.length === 0)) {
    throw new Error("Private-key operation failed");
  }
  throw new Error(messages[code] ?? "Private-key operation failed");
}

export function shortenFingerprint(value: number[] | null): string {
  if (!value) return "Not cached";
  const full = value.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${full.slice(0, 10)}…${full.slice(-8)}`;
}

export function vetKeysSlotControlPolicy(
  slot: VetKeysAdminSlot,
  currentPrincipal: string,
  busy = false,
): VetKeysSlotControlPolicy {
  const owns = slot.keyHolder === currentPrincipal;
  const available = owns && !busy;
  const showDisable = slot.status === "enabled";
  const showEnable =
    slot.status === "disabled" ||
    (slot.status === "manifest_suspended" && slot.purpose !== null);
  return {
    owns,
    showEnable,
    showDisable,
    canEnable: available && showEnable,
    canDisable: available && showDisable,
    canRotate:
      available &&
      slot.status === "enabled" &&
      slot.previousGeneration === null,
    canRetireGeneration:
      available && slot.status !== "manifest_suspended",
    canRetireSlot: available,
    canTransfer: available && slot.status !== "manifest_suspended",
  };
}

export function vetKeysSlotsByHolder(
  slots: readonly VetKeysAdminSlot[],
): Record<string, string[]> {
  const heldSlots: Record<string, string[]> = {};
  for (const slot of slots) {
    (heldSlots[slot.keyHolder] ??= []).push(`${slot.appId}/${slot.slot}`);
  }
  return heldSlots;
}

function validateSlot(value: unknown): VetKeysAdminSlot {
  const record = object(value, "vetKeys slot");
  const generations = array(record.generations, 2, "vetKeys generations").map(
    validateGeneration,
  );
  if (generations.length < 1) throw new Error("Missing vetKeys generation");
  return {
    appId: appId(record.app_id, "app id"),
    installationUid: positiveNat(
      record.installation_uid,
      "installation identity",
    ),
    slotUid: nat(record.slot_uid, "slot identity"),
    slot: identifier(record.slot, 40, "slot id"),
    purpose: optional(record.purpose, (entry) => text(entry, 280, "slot purpose")),
    keyHolder: principal(record.key_holder, "key holder"),
    status: variant(
      record.status,
      ["enabled", "disabled", "manifest_suspended"],
      "slot status",
    ),
    currentGeneration: nat(record.current_generation, "current generation"),
    previousGeneration: optional(record.previous_generation, (entry) =>
      nat(entry, "previous generation"),
    ),
    generations,
    createdAt: nat(record.created_at, "created time"),
    createdBy: principal(record.created_by, "creator"),
    updatedAt: nat(record.updated_at, "updated time"),
    updatedBy: principal(record.updated_by, "updater"),
    lastUsedAt: optional(record.last_used_at, (entry) =>
      nat(entry, "last-used time"),
    ),
    totalDerivations: nat(record.total_derivations, "total derivations"),
    approximateCycleSpend: nat(record.approximate_cycle_spend, "cycle spend"),
  };
}

function validateGeneration(value: unknown): VetKeysGeneration {
  const record = object(value, "vetKeys generation");
  const keyName = record.key_name;
  if (keyName !== "key_1" && keyName !== "test_key_1") {
    throw new Error("Invalid vetKeys key name");
  }
  return {
    generation: nat(record.generation, "generation"),
    status: variant(record.status, ["current", "previous"], "generation status"),
    keyName,
    publicFingerprint: optional(record.public_fingerprint, (entry) =>
      bytes(entry, 32, "public fingerprint"),
    ),
  };
}

function validateAudit(value: unknown): VetKeysAuditEntry {
  const record = object(value, "vetKeys audit entry");
  const scope = object(record.scope, "vetKeys audit app scope");
  return {
    at: nat(record.at, "audit time"),
    appId: appId(scope.app_id, "audit app id"),
    installationUid: positiveNat(
      scope.installation_uid,
      "audit installation identity",
    ),
    slotUid: optional(record.slot_uid, (entry) => nat(entry, "audit slot identity")),
    slot: identifier(record.slot_id, 40, "audit slot id"),
    generation: optional(record.generation, (entry) =>
      nat(entry, "audit generation"),
    ),
    action: variant(record.action, ACTIONS, "audit action"),
    principal: principal(record.principal, "audit principal"),
    outcome: variant(record.outcome, OUTCOMES, "audit outcome"),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optional<T>(value: unknown, parse: (entry: unknown) => T): T | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    // icblast unwraps options while @dfinity/agent preserves []/[value]. A
    // vector is itself an array, so first allow the value parser to recognize
    // an already-unwrapped vector before interpreting the array as an option.
    try {
      return parse(value);
    } catch {
      // Continue with the canonical Candid option representation.
    }
    if (value.length !== 1) throw new Error("Invalid Candid option");
    return parse(value[0]);
  }
  return parse(value);
}

function nat(value: unknown, label: string): string {
  const normalized =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : value;
  if (
    typeof normalized !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(normalized) ||
    BigInt(normalized) > 18_446_744_073_709_551_615n
  ) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return normalized;
}

function positiveNat(value: unknown, label: string): string {
  const valueText = nat(value, label);
  if (valueText === "0") throw new Error(`Invalid ${label}`);
  return valueText;
}

function principal(value: unknown, label: string): string {
  const normalized =
    typeof value === "string"
      ? value
      : typeof (value as Principal | undefined)?.toText === "function"
        ? (value as Principal).toText()
        : null;
  if (!normalized || !/^[a-z0-9-]{5,80}$/u.test(normalized)) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return normalized;
}

function appId(value: unknown, label: string): string {
  if (!isValidAppId(value)) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return value;
}

function identifier(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[a-z0-9_]+$/u.test(value)
  ) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return value;
}

function text(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u.test(
      value,
    )
  ) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return value;
}

function variant<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value === "string" && allowed.includes(value as T)) {
    return value as T;
  }
  const record = object(value, label);
  const entries = Object.entries(record);
  if (
    entries.length !== 1 ||
    !allowed.includes(entries[0]![0] as T) ||
    (entries[0]![1] !== null &&
      !(Array.isArray(entries[0]![1]) && entries[0]![1].length === 0))
  ) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return entries[0]![0] as T;
}

function bytes(value: unknown, length: number, label: string): number[] {
  const normalized = value instanceof Uint8Array ? [...value] : value;
  if (
    !Array.isArray(normalized) ||
    normalized.length !== length ||
    normalized.some(
      (entry) => !Number.isInteger(entry) || entry < 0 || entry > 255,
    )
  ) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return normalized.slice() as number[];
}
