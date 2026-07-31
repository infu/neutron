import {
  VET_KEYS_ERROR_CODES,
  isJsonObject,
  type JsonValue,
} from "neutron-tools/protocol";

const OPERATION_METHODS = new Set([
  "kernel_vetkeys_binding",
  "kernel_vetkeys_reserve",
  "kernel_vetkeys_enable",
  "kernel_vetkeys_disable",
  "kernel_vetkeys_rotate",
  "kernel_vetkeys_retire_generation",
  "kernel_vetkeys_transfer",
  "kernel_vetkeys_retire_slot",
  "kernel_vetkeys_public_key",
  "kernel_vetkeys_derive",
]);

/**
 * icblast unwraps any two-arm Ok/Err Candid variant. Restore the explicit
 * result envelope expected by the source-bound broker. This also accepts an
 * unwrapped @dfinity result so tests and non-icblast callers remain usable.
 */
export function normalizeVetKeysIcblastSuccess(
  method: string,
  value: JsonValue,
): JsonValue {
  if (!OPERATION_METHODS.has(method) || isOperationResult(value)) return value;
  return { ok: value };
}

/**
 * icblast throws the Err payload rather than an Error. Only reconstruct a
 * result for the closed vetKeys error union; unknown rejects stay rejected and
 * are redacted by the outer kernel boundary.
 */
export function normalizeVetKeysIcblastFailure(
  method: string,
  value: unknown,
): JsonValue | null {
  if (!OPERATION_METHODS.has(method) || !isJsonObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1) return null;
  const [tag, payload] = entries[0]!;
  if (!(VET_KEYS_ERROR_CODES as readonly string[]).includes(tag)) return null;

  if (payload !== null) return null;
  return { err: { [tag]: null } };
}

function isOperationResult(value: JsonValue): boolean {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === "ok" || keys[0] === "err");
}
