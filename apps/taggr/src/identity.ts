// The app's own Taggr identity.
//
// Taggr identifies users by caller principal, so whatever key signs the calls
// *is* the account. This app keeps its own Ed25519 key rather than borrowing
// the Neutron's principal, which means the account is portable between clients
// and the kernel is never asked to sign anything on Taggr's behalf.
//
// This module owns the *browser* copy, in the resident background's persistent
// origin. A tile frame is credentialless and its storage partition does not
// survive a reload, so the background is the only surface where the key can
// live at all — and it is also the only surface that makes network calls, so
// the key never leaves it.
//
// The durable copy lives in this app's own canister memory; `identity_sync.ts`
// reconciles the two. What is here is a cache: it makes a cold start fast and
// keeps the app working when a self-call fails, but clearing site data no
// longer destroys the account.

import { Ed25519KeyIdentity } from "@dfinity/identity";

const IDENTITY_KEY = "taggr.identity.v1";
const SETTINGS_KEY = "taggr.settings.v1";

export const TAGGR_MAINNET_CANISTER = "6qfxa-ryaaa-aaaai-qbhsq-cai";

export type TaggrSettings = {
  canister: string;
  /**
   * The hostname to browse under, or `null` to follow whatever the deployment
   * registered — see `resolveDomain` in `domain.ts`. A browser front end uses
   * its own `location.hostname`; this app has none of Taggr's, so an unpinned
   * domain is resolved from the live list on every start and self-heals when a
   * deployment renames its domains.
   */
  domain: string | null;
};

export class IdentityStorageError extends Error {}

const storage = (): Storage => {
  try {
    const value = globalThis.localStorage;
    if (!value) throw new Error("no storage");
    return value;
  } catch (cause: unknown) {
    throw new IdentityStorageError(
      "This surface has no persistent storage. The Taggr identity lives in the resident background origin.",
    );
  }
};

/** `Ed25519KeyIdentity.toJSON()` is a two-element array of hex strings. */
const isIdentityJson = (value: unknown): value is [string, string] =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((entry) => typeof entry === "string" && entry.length > 0);

/** Validate the pair before either its principal or its seed becomes authoritative. */
const decodeIdentity = (parsed: [string, string]): Ed25519KeyIdentity => {
  // The SDK's JSON constructor accepts an arbitrary public/private pair and
  // does not validate the private-key length. Its signer uses the first 32
  // bytes of a legacy 64-byte secret, so preserve that portable backup format.
  const decoded = Ed25519KeyIdentity.fromJSON(JSON.stringify(parsed));
  const secret = new Uint8Array(decoded.getKeyPair().secretKey);
  if (secret.length !== 32 && secret.length !== 64) throw new Error("Invalid secret length");
  const identity = Ed25519KeyIdentity.fromSecretKey(secret.slice(0, 32));
  if (identity.getPrincipal().toText() !== decoded.getPrincipal().toText()) {
    throw new Error("The public key does not match the signing key");
  }
  return identity;
};

const readIdentity = (): Ed25519KeyIdentity | null => {
  const raw = storage().getItem(IDENTITY_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IdentityStorageError("The stored Taggr identity is not readable.");
  }
  if (!isIdentityJson(parsed)) {
    throw new IdentityStorageError("The stored Taggr identity has an unexpected shape.");
  }
  try {
    return decodeIdentity(parsed);
  } catch {
    throw new IdentityStorageError("The stored Taggr identity is not a valid Ed25519 key pair.");
  }
};

const writeIdentity = (identity: Ed25519KeyIdentity): void => {
  storage().setItem(IDENTITY_KEY, JSON.stringify(identity.toJSON()));
};

let cached: Ed25519KeyIdentity | null = null;

/**
 * The identity for this installation, created on first use and stable after
 * that. Cached in memory so repeated calls do not re-parse the key.
 */
export const loadIdentity = (): Ed25519KeyIdentity => {
  if (cached) return cached;
  const existing = readIdentity();
  if (existing) {
    cached = existing;
    return existing;
  }
  const created = Ed25519KeyIdentity.generate();
  writeIdentity(created);
  cached = created;
  return created;
};

export const identityPrincipal = (): string => loadIdentity().getPrincipal().toText();

/**
 * Drops the in-memory copy so the next read comes from storage again. The cache
 * is an optimisation over a `localStorage` read, not a second source of truth,
 * and anything that replaces what is in storage has to invalidate it.
 */
export const forgetCachedIdentity = (): void => {
  cached = null;
};

/** The cached or stored key, without creating one. */
export const peekIdentity = (): Ed25519KeyIdentity | null => cached ?? readIdentity();

/**
 * The raw 32-byte Ed25519 seed. This is the whole account: the public key and
 * the principal derive from it, and it is what the canister stores.
 */
export const secretKeyBytes = (identity: Ed25519KeyIdentity): Uint8Array =>
  new Uint8Array(identity.getKeyPair().secretKey);

/** Adopts a key from the canister, or one restored beside it. */
export const adoptSecretKey = (secretKey: Uint8Array): Ed25519KeyIdentity => {
  let identity: Ed25519KeyIdentity;
  try {
    identity = Ed25519KeyIdentity.fromSecretKey(secretKey);
  } catch {
    throw new IdentityStorageError("That is not a valid Ed25519 key.");
  }
  writeIdentity(identity);
  cached = identity;
  return identity;
};

/**
 * The portable backup of the account. Handing this string to another client
 * hands over the Taggr account, so it is only ever returned to this app's own
 * tile and is never written to a log or a tool result an agent can read.
 */
export const exportIdentity = (): string => JSON.stringify(loadIdentity().toJSON());

/** Parse an import without replacing the current browser identity. */
export const parseIdentityBackup = (serialized: string): Ed25519KeyIdentity => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized.trim());
  } catch {
    throw new IdentityStorageError("That is not a Taggr identity backup.");
  }
  if (!isIdentityJson(parsed)) {
    throw new IdentityStorageError("That backup has an unexpected shape.");
  }
  try {
    return decodeIdentity(parsed);
  } catch {
    throw new IdentityStorageError("That backup is not a valid Ed25519 key pair.");
  }
};

export const importIdentity = (serialized: string): string => {
  const identity = parseIdentityBackup(serialized);
  writeIdentity(identity);
  cached = identity;
  return identity.getPrincipal().toText();
};

/**
 * Replaces the key with a fresh one. The previous Taggr account becomes
 * unreachable from this installation unless it was exported first, so the UI
 * asks for confirmation before calling this.
 */
export const resetIdentity = (): string => {
  const created = Ed25519KeyIdentity.generate();
  writeIdentity(created);
  cached = created;
  return created.getPrincipal().toText();
};

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

const isSettings = (value: unknown): value is TaggrSettings =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as TaggrSettings).canister === "string" &&
  ((value as TaggrSettings).domain === null ||
    typeof (value as TaggrSettings).domain === "string");

const DEFAULTS: TaggrSettings = { canister: TAGGR_MAINNET_CANISTER, domain: null };

export const loadSettings = (): TaggrSettings => {
  const raw = storage().getItem(SETTINGS_KEY);
  if (!raw) return DEFAULTS;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Settings written before the domain became optional carry a literal
    // "localhost", which was this app's old default rather than a choice.
    if (isSettings(parsed)) {
      return parsed.domain === "localhost" ? { ...parsed, domain: null } : parsed;
    }
  } catch {
    // A corrupt settings record should not lock the app out of the network.
  }
  return DEFAULTS;
};

export const saveSettings = (settings: TaggrSettings): TaggrSettings => {
  const canister = settings.canister.trim();
  const domain = settings.domain === null ? null : settings.domain.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-cai$/.test(canister)) {
    throw new IdentityStorageError("That is not a canister id.");
  }
  if (domain !== null && (domain.length === 0 || domain.length > 64)) {
    throw new IdentityStorageError("A pinned feed domain must be 1 to 64 characters.");
  }
  const next: TaggrSettings = { canister, domain };
  storage().setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
};
