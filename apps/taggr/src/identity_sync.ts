// Reconciling the browser's copy of the Taggr key with the canister's.
//
// The canister is the source of truth: it is what survives clearing site data,
// which is the failure this exists to prevent. The browser origin keeps a cache
// so a cold start is one local read rather than a round trip, and so a
// self-call that fails does not take the app down with it.
//
// Precedence, in order:
//
//   1. The canister has a key — adopt it, refreshing the cache. An installation
//      restored into a fresh browser lands here.
//   2. The canister has none and the browser does — adopt the browser's and
//      push it up. Installations that predate this store land here exactly
//      once, and the account they already have is preserved.
//   3. Neither — create one, store it, cache it.
//
// A self-call that fails never causes a *new* key to replace a reachable old
// one: an unreadable canister falls back to the cache and says so, so the tile
// can report an account that is not yet safe rather than quietly orphan it.

import { Ed25519KeyIdentity } from "@dfinity/identity";
import {
  adoptSecretKey,
  IdentityStorageError,
  loadSettings,
  peekIdentity,
  saveSettings,
  secretKeyBytes,
  type TaggrSettings,
} from "./identity.ts";
import {
  IdentityStoreError,
  initializeStoredIdentity,
  readStored,
  writeStoredIdentity,
  writeStoredSettings,
  type StoredState,
} from "./identity_store.ts";

/** The store, injected so the reconciliation can be driven in a test. */
export type IdentityStore = {
  read: () => Promise<StoredState>;
  initializeIdentity: (secretKey: Uint8Array) => Promise<StoredState>;
  writeIdentity: (secretKey: Uint8Array) => Promise<StoredState>;
  writeSettings: (input: { canister: string; domain: string | null }) => Promise<StoredState>;
};

export const canisterStore: IdentityStore = {
  read: readStored,
  initializeIdentity: initializeStoredIdentity,
  writeIdentity: writeStoredIdentity,
  writeSettings: writeStoredSettings,
};

export type SyncState = {
  /** True once the key in use is the one the canister holds. */
  stored: boolean;
  /** Why it is not, in the owner's words, or null. */
  error: string | null;
};

let sync: SyncState = { stored: false, error: null };
export const identitySync = (): SyncState => sync;

// A late initial read must not replace a key that an import has just saved.
// Keep the browser cache and durable-key changes in their invocation order.
let identityWork: Promise<void> = Promise.resolve();
const serializeIdentity = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = identityWork.then(operation, operation);
  identityWork = result.then(() => undefined, () => undefined);
  return result;
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Brings the canister's copy into this background and returns the identity in
 * use. Idempotent: later calls re-read, so a background that started while the
 * canister was unreachable recovers on its next use.
 */
export const hydrateIdentity = async (
  store: IdentityStore = canisterStore,
): Promise<Ed25519KeyIdentity> => serializeIdentity(async () => {
  let stored: StoredState;
  try {
    stored = await store.read();
  } catch (error: unknown) {
    const local = peekIdentity();
    sync = {
      stored: false,
      error: error instanceof IdentityStoreError
        ? `Taggr could not read the saved account from this Neutron. ${local
            ? "It is using the copy in this browser."
            : "The saved account data has not been changed."} ${message(error)}`
        : local
        ? `This Neutron could not be reached, so Taggr is using the copy in this browser: ${message(error)}`
        : `This Neutron could not be reached and this browser has no saved Taggr identity. Reconnect to restore the existing account: ${message(error)}`,
    };
    // An unreachable store is not proof that it is empty. Creating a key here
    // would expose an account that the next successful restore could discard.
    if (!local) throw new IdentityStorageError(sync.error!);
    return local;
  }

  // Settings ride along: a restored browser should come back to the same
  // deployment and the same view, not just the same account.
  let settingsError: string | null = null;
  try {
    if (stored.canister !== null) {
      const local = loadSettings();
      if (local.canister !== stored.canister || local.domain !== stored.domain) {
        saveSettings({ canister: stored.canister, domain: stored.domain });
      }
    }
  } catch (error: unknown) {
    // A malformed display setting must not prevent restoration of the key.
    settingsError = `Taggr could not restore the saved display settings: ${message(error)}`;
  }

  if (stored.secretKey !== null) {
    sync = { stored: false, error: "Taggr could not refresh this browser's saved identity." };
    const identity = adoptSecretKey(stored.secretKey);
    sync = { stored: true, error: settingsError };
    return identity;
  }

  const existing = peekIdentity();
  const identity = existing ?? Ed25519KeyIdentity.generate();
  try {
    // Two fresh browsers can both read an empty store. The backend chooses the
    // first seed atomically, and both browsers adopt that returned identity.
    const initialized = await store.initializeIdentity(secretKeyBytes(identity));
    if (initialized.secretKey === null) {
      throw new IdentityStorageError("The Taggr backend did not confirm an initialized identity");
    }
    const adopted = adoptSecretKey(initialized.secretKey);
    sync = { stored: true, error: settingsError };
    return adopted;
  } catch (error: unknown) {
    sync = {
      stored: false,
      error: existing
        ? `Taggr could not save this account to your Neutron, so it lives only in this browser for now: ${message(error)}`
        : `Taggr could not confirm its account was saved. Reconnect before using a new identity: ${message(error)}`,
    };
    if (!existing) throw new IdentityStorageError(sync.error!);
    return existing;
  }
});

/** Replace an account only after the durable store confirms the new key. */
export const replaceStoredIdentity = (
  identity: Ed25519KeyIdentity,
  store: IdentityStore = canisterStore,
): Promise<Ed25519KeyIdentity> => serializeIdentity(async () => {
  const seed = secretKeyBytes(identity);
  try {
    const stored = await store.writeIdentity(seed);
    if (stored.secretKey === null || stored.secretKey.length !== seed.length ||
      stored.secretKey.some((byte, index) => byte !== seed[index])) {
      throw new IdentityStorageError("The Taggr backend did not confirm the requested identity");
    }
  } catch (error: unknown) {
    sync = {
      stored: false,
      error: `Taggr could not confirm the new account was saved. The current browser identity is unchanged: ${message(error)}`,
    };
    throw new IdentityStorageError(sync.error!);
  }
  sync = {
    stored: false,
    error: "The new Taggr account is saved in your Neutron, but this browser could not refresh its identity cache.",
  };
  const adopted = adoptSecretKey(seed);
  sync = { stored: true, error: null };
  return adopted;
});

/** Mirrors a settings change into the canister; the local write already ran. */
export const pushSettings = async (
  settings: TaggrSettings,
  store: IdentityStore = canisterStore,
): Promise<void> => {
  try {
    await store.writeSettings({ canister: settings.canister, domain: settings.domain });
  } catch {
    // Settings are recoverable from the UI, unlike the key. A failure here must
    // not turn a saved local change into an error the owner has to act on.
  }
};
