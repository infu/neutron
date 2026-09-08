import { beforeEach, describe, expect, test } from "bun:test";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import * as identity from "../src/identity.ts";
import * as sync from "../src/identity_sync.ts";
import type { IdentityStore } from "../src/identity_sync.ts";
import type { StoredState } from "../src/identity_store.ts";

/**
 * The reconciliation between the browser's copy of the Taggr key and the
 * canister's.
 *
 * Every case here is about not losing an account: Taggr identifies users by
 * caller principal, so a key this app forgets is an account nobody can reach
 * again — its own principal-change flow needs the old key to authorise a move.
 */

const backing = new Map<string, string>();

const storage: Storage = {
  get length() {
    return backing.size;
  },
  clear: () => backing.clear(),
  getItem: (key) => backing.get(key) ?? null,
  key: (index) => [...backing.keys()][index] ?? null,
  removeItem: (key) => void backing.delete(key),
  setItem: (key, value) => void backing.set(key, value),
};

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

const emptyState = (): StoredState => ({
  secretKey: null,
  canister: null,
  domain: null,
  revision: 0,
});

/** A canister that answers, recording what it was asked to keep. */
const workingStore = (initial: StoredState = emptyState()) => {
  let state = { ...initial };
  const writes: string[] = [];
  const store: IdentityStore = {
    read: async () => ({ ...state }),
    initializeIdentity: async (secretKey) => {
      writes.push("initialize");
      if (state.secretKey === null) state = { ...state, secretKey, revision: state.revision + 1 };
      return { ...state };
    },
    writeIdentity: async (secretKey) => {
      writes.push("identity");
      state = { ...state, secretKey, revision: state.revision + 1 };
      return { ...state };
    },
    writeSettings: async (input) => {
      writes.push("settings");
      state = { ...state, ...input, revision: state.revision + 1 };
      return { ...state };
    },
  };
  return { store, writes, current: () => state };
};

/** A canister that cannot be reached at all. */
const brokenStore = (): IdentityStore => ({
  read: async () => {
    throw new Error("the Neutron did not answer");
  },
  initializeIdentity: async () => {
    throw new Error("the Neutron did not answer");
  },
  writeIdentity: async () => {
    throw new Error("the Neutron did not answer");
  },
  writeSettings: async () => {
    throw new Error("the Neutron did not answer");
  },
});

const seedOf = (identity: Ed25519KeyIdentity): Uint8Array =>
  new Uint8Array(identity.getKeyPair().secretKey);

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  backing.clear();
  // The in-memory copy is a cache over storage, so wiping storage has to wipe
  // it too or the next test reads a key that no longer exists anywhere.
  identity.forgetCachedIdentity();
});

describe("bringing the account into a background", () => {
  test("creates a key on a fresh install and keeps it in the canister", async () => {
    const canister = workingStore();

    const created = await sync.hydrateIdentity(canister.store);
    expect(canister.current().secretKey).toEqual(seedOf(created));
    expect(sync.identitySync()).toEqual({ stored: true, error: null });
    expect(canister.writes).toEqual(["initialize"]);
  });

  test("restores the account into a browser that has never seen it", async () => {
    // This is the case the whole store exists for: site data was cleared, or
    // the Neutron was opened somewhere else entirely.
    const existing = Ed25519KeyIdentity.generate();
    const canister = workingStore({ ...emptyState(), secretKey: seedOf(existing) });

    const restored = await sync.hydrateIdentity(canister.store);
    expect(restored.getPrincipal().toText()).toBe(existing.getPrincipal().toText());
    // And the browser cache now holds it, so the next start needs no round trip.
    expect(identity.peekIdentity()?.getPrincipal().toText()).toBe(
      existing.getPrincipal().toText(),
    );
    expect(canister.writes).toEqual([]);
  });

  test("adopts the key an older installation already had, rather than replacing it", async () => {
    // Installations that predate the store have an account in browser storage
    // only. Overwriting it with a new key would strand that account.
    const before = identity.loadIdentity();
    const canister = workingStore();

    const after = await sync.hydrateIdentity(canister.store);
    expect(after.getPrincipal().toText()).toBe(before.getPrincipal().toText());
    expect(canister.current().secretKey).toEqual(seedOf(before));
    expect(sync.identitySync().stored).toBe(true);
  });

  test("restores the deployment and domain alongside the key", async () => {
    const canister = workingStore({
      secretKey: seedOf(Ed25519KeyIdentity.generate()),
      canister: "bkyz2-fmaaa-aaaaa-qaaaq-cai",
      domain: "taggr.link",
      revision: 3,
    });

    await sync.hydrateIdentity(canister.store);
    expect(identity.loadSettings()).toEqual({
      canister: "bkyz2-fmaaa-aaaaa-qaaaq-cai",
      domain: "taggr.link",
    });
  });

  test("adopts the seed another browser initialized after the empty read", async () => {
    const winner = Ed25519KeyIdentity.generate();
    const store = workingStore({ ...emptyState(), secretKey: seedOf(winner) });
    store.store.read = async () => emptyState();
    const adopted = await sync.hydrateIdentity(store.store);
    expect(adopted.getPrincipal().toText()).toBe(winner.getPrincipal().toText());
    expect(identity.identityPrincipal()).toBe(winner.getPrincipal().toText());
    expect(store.writes).toEqual(["initialize"]);
  });

  test("restores a valid account even when its saved display settings are malformed", async () => {
    const existing = Ed25519KeyIdentity.generate();
    const canister = workingStore({
      ...emptyState(), secretKey: seedOf(existing), canister: "invalid-canister",
    });
    const restored = await sync.hydrateIdentity(canister.store);
    expect(restored.getPrincipal().toText()).toBe(existing.getPrincipal().toText());
    expect(sync.identitySync().stored).toBe(true);
    expect(sync.identitySync().error).toContain("display settings");
  });
});

describe("when the Neutron cannot be reached", () => {
  test("keeps using the browser's key rather than minting a new account", async () => {
    const before = identity.loadIdentity();

    const after = await sync.hydrateIdentity(brokenStore());
    expect(after.getPrincipal().toText()).toBe(before.getPrincipal().toText());
    expect(sync.identitySync().stored).toBe(false);
    expect(sync.identitySync().error).toContain("could not be reached");
  });

  test("does not mistake an unreachable store for an empty one", async () => {
    await expect(sync.hydrateIdentity(brokenStore())).rejects.toThrow(/Reconnect/);
    expect(identity.peekIdentity()).toBeNull();
    expect(backing.has("taggr.identity.v1")).toBe(false);
    expect(sync.identitySync().stored).toBe(false);
  });

  test("does not expose a fresh key before initialization is acknowledged", async () => {
    const store = brokenStore();
    store.read = async () => emptyState();
    await expect(sync.hydrateIdentity(store)).rejects.toThrow(/confirm/);
    expect(identity.peekIdentity()).toBeNull();
    expect(backing.has("taggr.identity.v1")).toBe(false);
  });

  test("recovers the same initialized account after a lost write acknowledgement", async () => {
    const canister = workingStore();
    const initialize = canister.store.initializeIdentity;
    canister.store.initializeIdentity = async (seed) => {
      await initialize(seed);
      throw new Error("reply lost");
    };
    await expect(sync.hydrateIdentity(canister.store)).rejects.toThrow(/confirm/);
    expect(identity.peekIdentity()).toBeNull();
    const committedSeed = canister.current().secretKey;
    expect(committedSeed).not.toBeNull();
    const restored = await sync.hydrateIdentity(canister.store);
    expect(identity.secretKeyBytes(restored)).toEqual(committedSeed!);
    expect(canister.writes).toEqual(["initialize"]);
  });

  test("keeps the older browser account when its first durable save fails", async () => {
    const before = identity.loadIdentity();
    const store = brokenStore();
    store.read = async () => emptyState();
    const after = await sync.hydrateIdentity(store);
    expect(after.getPrincipal().toText()).toBe(before.getPrincipal().toText());
    expect(sync.identitySync().stored).toBe(false);
  });

  test("does not turn a settings change into an error the owner must act on", async () => {
    // Settings are recoverable from the UI; the key is not.
    expect(
      sync.pushSettings({ canister: "6qfxa-ryaaa-aaaai-qbhsq-cai", domain: null }, brokenStore()),
    ).resolves.toBeUndefined();
  });
});

describe("replacing the account", () => {
  test("stores an imported key before the old one stops being used", async () => {
    const canister = workingStore({ ...emptyState(), secretKey: new Uint8Array(32).fill(7) });
    const replacement = Ed25519KeyIdentity.generate();

    await sync.replaceStoredIdentity(replacement, canister.store);
    expect(canister.current().secretKey).toEqual(seedOf(replacement));
    expect(sync.identitySync().stored).toBe(true);
  });

  test("keeps the current browser key if the replacement save fails", async () => {
    const original = identity.loadIdentity();
    const replacement = Ed25519KeyIdentity.generate();
    await expect(sync.replaceStoredIdentity(replacement, brokenStore())).rejects.toThrow(/unchanged/);
    expect(identity.identityPrincipal()).toBe(original.getPrincipal().toText());
    identity.forgetCachedIdentity();
    expect(identity.identityPrincipal()).toBe(original.getPrincipal().toText());
  });

  test("reconciles a committed replacement after its acknowledgement is lost", async () => {
    const original = identity.loadIdentity();
    const replacement = Ed25519KeyIdentity.generate();
    const canister = workingStore({ ...emptyState(), secretKey: seedOf(original) });
    const write = canister.store.writeIdentity;
    canister.store.writeIdentity = async (seed) => {
      await write(seed);
      throw new Error("reply lost");
    };
    await expect(sync.replaceStoredIdentity(replacement, canister.store)).rejects.toThrow(/confirm/);
    expect(identity.identityPrincipal()).toBe(original.getPrincipal().toText());
    expect(sync.identitySync().stored).toBe(false);
    const restored = await sync.hydrateIdentity(canister.store);
    expect(restored.getPrincipal().toText()).toBe(replacement.getPrincipal().toText());
    expect(canister.writes).toEqual(["identity"]);
  });

  test("does not mark an old browser cache as synchronized if its replacement write fails", async () => {
    const original = identity.loadIdentity();
    const replacement = Ed25519KeyIdentity.generate();
    const canister = workingStore({ ...emptyState(), secretKey: seedOf(original) });
    await sync.hydrateIdentity(canister.store);
    const setItem = storage.setItem;
    storage.setItem = () => { throw new Error("Storage is unavailable"); };
    try {
      await expect(sync.replaceStoredIdentity(replacement, canister.store)).rejects.toThrow(/Storage/);
      expect(sync.identitySync().stored).toBe(false);
      expect(identity.identityPrincipal()).toBe(original.getPrincipal().toText());
      expect(canister.current().secretKey).toEqual(seedOf(replacement));
    } finally {
      storage.setItem = setItem;
    }
    const restored = await sync.hydrateIdentity(canister.store);
    expect(restored.getPrincipal().toText()).toBe(replacement.getPrincipal().toText());
  });

  test("does not adopt a replacement from an unrelated successful write response", async () => {
    const original = identity.loadIdentity();
    const replacement = Ed25519KeyIdentity.generate();
    const store = workingStore();
    store.store.writeIdentity = async () => ({ ...emptyState(), secretKey: seedOf(original) });
    await expect(sync.replaceStoredIdentity(replacement, store.store)).rejects.toThrow(/confirm/);
    expect(identity.identityPrincipal()).toBe(original.getPrincipal().toText());
  });

  test("waits for durable confirmation before adopting a replacement", async () => {
    const original = identity.loadIdentity();
    const replacement = Ed25519KeyIdentity.generate();
    let confirm!: (state: StoredState) => void;
    const store = workingStore();
    store.store.writeIdentity = () => new Promise((resolve) => { confirm = resolve; });
    const pending = sync.replaceStoredIdentity(replacement, store.store);
    await Promise.resolve();
    expect(identity.identityPrincipal()).toBe(original.getPrincipal().toText());
    confirm({ ...emptyState(), secretKey: seedOf(replacement) });
    await pending;
    expect(identity.identityPrincipal()).toBe(replacement.getPrincipal().toText());
    expect(sync.identitySync()).toEqual({ stored: true, error: null });
  });

  test("serializes a late hydration with replacement so the cache cannot revert", async () => {
    const original = identity.loadIdentity();
    const replacement = Ed25519KeyIdentity.generate();
    const store = workingStore({ ...emptyState(), secretKey: seedOf(original) });
    let answerRead!: (state: StoredState) => void;
    store.store.read = () => new Promise((resolve) => { answerRead = resolve; });
    const hydrating = sync.hydrateIdentity(store.store);
    await Promise.resolve();
    const replacing = sync.replaceStoredIdentity(replacement, store.store);
    expect(store.writes).toEqual([]);
    answerRead({ ...emptyState(), secretKey: seedOf(original) });
    await Promise.all([hydrating, replacing]);
    expect(identity.identityPrincipal()).toBe(replacement.getPrincipal().toText());
    expect(store.current().secretKey).toEqual(seedOf(replacement));
    expect(sync.identitySync().stored).toBe(true);
  });

});
