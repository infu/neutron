// The durable home of the Taggr account, in this app's own canister memory.
//
// The account is an Ed25519 key: Taggr identifies users by caller principal, so
// whatever signs the calls owns the account. Keeping that key only in the
// background's browser origin meant clearing site data destroyed it, because
// Taggr's own principal-change flow needs the *old* key to authorise a move.
//
// So the canister holds it. `preapproved_self_calls` lets this app's own
// background reach these five methods with no per-call dialog, and no other app
// can reach them at all — they are owner-authorized methods on this app's
// backend, not a shared service. The browser copy becomes a cache: it makes a
// cold start fast and keeps the app usable if a self-call fails, but the
// canister is what survives.

import { querySelf, updateSelf, type SelfCallObject, type SelfCallValue } from "neutron-tools/app";

/** Raw Ed25519 seed length, as `backend/main.mo` enforces. */
export const SECRET_KEY_BYTES = 32;

export class IdentityStoreError extends Error {}

export type StoredState = {
  secretKey: Uint8Array | null;
  canister: string | null;
  domain: string | null;
  revision: number;
};

const record = (value: SelfCallValue, label: string): SelfCallObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IdentityStoreError(`The Taggr backend returned an unexpected ${label}`);
  }
  return value as SelfCallObject;
};

/**
 * Candid `opt` arrives as a one-or-zero element array from the self-call wire,
 * and a bare value when the encoder has already unwrapped it. Accept both
 * rather than guessing one.
 */
const optional = (value: SelfCallValue): SelfCallValue => {
  if (Array.isArray(value)) {
    if (value.length > 1) throw new IdentityStoreError("The Taggr backend returned an unexpected option");
    return value.length === 0 ? null : (value[0] as SelfCallValue);
  }
  return value ?? null;
};

const optionalText = (value: SelfCallValue): string | null => {
  const inner = optional(value);
  return typeof inner === "string" && inner.length > 0 ? inner : null;
};

const optionalBytes = (value: SelfCallValue): Uint8Array | null => {
  if (value === null || (Array.isArray(value) && value.length === 0)) return null;
  // Accept both the typed self-call blob and a plain byte vector; never turn
  // an undecodable present key into an empty store that hydration overwrites.
  const inner = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (inner instanceof Uint8Array) return new Uint8Array(inner);
  if (inner instanceof ArrayBuffer) return new Uint8Array(inner.slice(0));
  if (Array.isArray(inner) && inner.every((byte) =>
    typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(inner as number[]);
  }
  throw new IdentityStoreError("The stored Taggr key has an unexpected encoding");
};

const parseState = (value: SelfCallValue): StoredState => {
  const state = record(value, "identity record");
  const secretKey = optionalBytes(state.secret_key as SelfCallValue);
  if (secretKey !== null && secretKey.length !== SECRET_KEY_BYTES) {
    throw new IdentityStoreError("The stored Taggr key has an unexpected length");
  }
  return {
    secretKey,
    canister: optionalText(state.canister_id as SelfCallValue),
    domain: optionalText(state.domain as SelfCallValue),
    revision: typeof state.revision === "number" ? state.revision : 0,
  };
};

/** `#ok`/`#err` arrives as a one-key object; an `#err` is the backend's own text. */
const unwrap = (value: SelfCallValue, label: string): SelfCallValue => {
  const result = record(value, label);
  if ("err" in result) {
    throw new IdentityStoreError(
      typeof result.err === "string" ? result.err : `The Taggr backend rejected the ${label}`,
    );
  }
  if ("ok" in result) return result.ok as SelfCallValue;
  throw new IdentityStoreError(`The Taggr backend returned an unexpected ${label}`);
};

export const readStored = async (): Promise<StoredState> =>
  parseState(await querySelf<SelfCallValue>("taggr_state_read", [null]));

/** First creation is conditional: a concurrent browser may already have won. */
export const initializeStoredIdentity = async (secretKey: Uint8Array): Promise<StoredState> => {
  if (secretKey.length !== SECRET_KEY_BYTES) throw new IdentityStoreError("A Taggr key is 32 bytes");
  const state = parseState(unwrap(
    await updateSelf<SelfCallValue>("taggr_identity_initialize", [{ secret_key: secretKey }]),
    "identity initialization",
  ));
  if (state.secretKey === null) {
    throw new IdentityStoreError("The Taggr backend did not confirm an initialized identity");
  }
  return state;
};

export const writeStoredIdentity = async (secretKey: Uint8Array): Promise<StoredState> => {
  if (secretKey.length !== SECRET_KEY_BYTES) {
    throw new IdentityStoreError("A Taggr key is 32 bytes");
  }
  const state = parseState(
    unwrap(
      await updateSelf<SelfCallValue>("taggr_identity_write", [{ secret_key: secretKey }]),
      "identity write",
    ),
  );
  if (state.secretKey === null || state.secretKey.some((byte, index) => byte !== secretKey[index])) {
    throw new IdentityStoreError("The Taggr backend did not confirm the requested identity");
  }
  return state;
};

export const clearStoredIdentity = async (): Promise<StoredState> =>
  parseState(await updateSelf<SelfCallValue>("taggr_identity_clear", [null]));

export const writeStoredSettings = async (input: {
  canister: string;
  domain: string | null;
}): Promise<StoredState> =>
  parseState(
    unwrap(
      await updateSelf<SelfCallValue>("taggr_settings_write", [
        // Candid `opt` on the self-call wire is a zero-or-one element array.
        { canister_id: input.canister, domain: input.domain === null ? [] : [input.domain] },
      ]),
      "settings write",
    ),
  );
