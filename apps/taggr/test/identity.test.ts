import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Ed25519KeyIdentity } from "@dfinity/identity";

/**
 * `identity.ts` reads `globalThis.localStorage` lazily, so a fake standing in
 * for the resident background's persistent origin is enough to exercise it.
 * Each test re-imports the module so its in-memory cache starts empty.
 */
const installStorage = (): Map<string, string> => {
  const backing = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key) => backing.get(key) ?? null,
    key: (index) => [...backing.keys()][index] ?? null,
    removeItem: (key) => {
      backing.delete(key);
    },
    setItem: (key, value) => {
      backing.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: fake,
  });
  return backing;
};

const freshModule = async () =>
  import(`../src/identity.ts?cache=${Math.random()}`) as Promise<
    typeof import("../src/identity.ts")
  >;

let backing: Map<string, string>;

beforeEach(() => {
  backing = installStorage();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("identity", () => {
  test("creates a key on first use and keeps it afterwards", async () => {
    const first = await freshModule();
    const principal = first.identityPrincipal();
    expect(principal).toMatch(/^[a-z0-9-]+$/);
    expect(first.identityPrincipal()).toBe(principal);

    // A fresh module instance reads the stored key rather than making a new one,
    // which is what keeps the Taggr account stable across reloads.
    const second = await freshModule();
    expect(second.identityPrincipal()).toBe(principal);
  });

  test("stores the key under a versioned name", async () => {
    const module = await freshModule();
    module.identityPrincipal();
    expect([...backing.keys()]).toEqual(["taggr.identity.v1"]);
  });

  test("exports a backup that restores the same account elsewhere", async () => {
    const source = await freshModule();
    const principal = source.identityPrincipal();
    const backup = source.exportIdentity();

    backing.clear();
    const target = await freshModule();
    expect(target.identityPrincipal()).not.toBe(principal);
    expect(target.importIdentity(backup)).toBe(principal);
    expect(target.identityPrincipal()).toBe(principal);
  });

  test("rejects a backup that is not an identity", async () => {
    const module = await freshModule();
    expect(() => module.importIdentity("nonsense")).toThrow(module.IdentityStorageError);
    expect(() => module.importIdentity('{"a":1}')).toThrow(module.IdentityStorageError);
    expect(() => module.importIdentity('["only-one"]')).toThrow(module.IdentityStorageError);
  });

  test("rejects mismatched signing keys without replacing the current account", async () => {
    const module = await freshModule();
    const before = module.identityPrincipal();
    const publicIdentity = Ed25519KeyIdentity.generate();
    const other = Ed25519KeyIdentity.generate();
    const mixed = JSON.stringify([publicIdentity.toJSON()[0], other.toJSON()[1]]);
    expect(() => module.importIdentity(mixed)).toThrow(module.IdentityStorageError);
    expect(module.identityPrincipal()).toBe(before);
    expect((await freshModule()).identityPrincipal()).toBe(before);
  });

  test("rejects truncated seeds even when the SDK can deserialize their public key", async () => {
    const module = await freshModule();
    const pair = Ed25519KeyIdentity.generate().toJSON();
    for (const secret of ["12", pair[1].slice(0, 62), `${pair[1]}00`]) {
      expect(() => module.parseIdentityBackup(JSON.stringify([pair[0], secret]))).toThrow(
        module.IdentityStorageError,
      );
    }
    expect(backing.has("taggr.identity.v1")).toBe(false);
  });

  test("parses without adopting and preserves legacy 64-byte signing-key backups", async () => {
    const module = await freshModule();
    const before = module.identityPrincipal();
    const imported = Ed25519KeyIdentity.generate();
    const [publicKey, seed] = imported.toJSON();
    const publicRaw = Array.from(imported.getPublicKey().toRaw(), (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
    const parsed = module.parseIdentityBackup(JSON.stringify([publicKey, seed + publicRaw]));
    expect(parsed.getPrincipal().toText()).toBe(imported.getPrincipal().toText());
    expect(module.secretKeyBytes(parsed)).toHaveLength(32);
    expect(module.identityPrincipal()).toBe(before);
    const message = new Uint8Array([1, 2, 3]);
    expect(Ed25519KeyIdentity.verify(
      await parsed.sign(message), message, imported.getPublicKey().toRaw(),
    )).toBe(true);
  });

  test("replaces the key on reset", async () => {
    const module = await freshModule();
    const before = module.identityPrincipal();
    const after = module.resetIdentity();
    expect(after).not.toBe(before);
    expect(module.identityPrincipal()).toBe(after);
  });

  test("reports a corrupt stored key instead of silently starting a new account", async () => {
    backing.set("taggr.identity.v1", "{not json");
    const module = await freshModule();
    expect(() => module.identityPrincipal()).toThrow(module.IdentityStorageError);
  });

  test("preserves empty or mismatched stored bytes for recovery instead of replacing them", async () => {
    const first = Ed25519KeyIdentity.generate().toJSON();
    const second = Ed25519KeyIdentity.generate().toJSON();
    for (const raw of ["", JSON.stringify([first[0], second[1]])]) {
      backing.set("taggr.identity.v1", raw);
      const module = await freshModule();
      expect(() => module.identityPrincipal()).toThrow(module.IdentityStorageError);
      expect(backing.get("taggr.identity.v1")).toBe(raw);
    }
  });

  test("names the missing surface when there is no persistent storage", async () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    const module = await freshModule();
    expect(() => module.identityPrincipal()).toThrow(/resident background/);
  });
});

describe("settings", () => {
  test("defaults to mainnet Taggr and no pinned domain", async () => {
    const module = await freshModule();
    // A null domain means "follow whatever this deployment registered", which
    // the background resolves from the live list.
    expect(module.loadSettings()).toEqual({
      canister: module.TAGGR_MAINNET_CANISTER,
      domain: null,
    });
  });

  test("unpins a domain that was only ever this app's old default", async () => {
    // Installations configured before the domain became optional carry a
    // literal "localhost", which was never a choice the owner made.
    backing.set(
      "taggr.settings.v1",
      JSON.stringify({ canister: "6qfxa-ryaaa-aaaai-qbhsq-cai", domain: "localhost" }),
    );
    const module = await freshModule();
    expect(module.loadSettings().domain).toBeNull();
  });

  test("keeps a domain the owner did pin", async () => {
    backing.set(
      "taggr.settings.v1",
      JSON.stringify({ canister: "6qfxa-ryaaa-aaaai-qbhsq-cai", domain: "taggr.link" }),
    );
    const module = await freshModule();
    expect(module.loadSettings().domain).toBe("taggr.link");
  });

  test("saves and reloads a different deployment", async () => {
    const module = await freshModule();
    const saved = module.saveSettings({
      canister: "  bkyz2-fmaaa-aaaaa-qaaaq-cai ",
      domain: " taggr.link ",
    });
    expect(saved).toEqual({ canister: "bkyz2-fmaaa-aaaaa-qaaaq-cai", domain: "taggr.link" });
    expect((await freshModule()).loadSettings()).toEqual(saved);
  });

  test("rejects a canister id that is not one", async () => {
    const module = await freshModule();
    expect(() => module.saveSettings({ canister: "not-a-canister", domain: "localhost" })).toThrow(
      module.IdentityStorageError,
    );
  });

  test("rejects an empty or over-long feed domain", async () => {
    const module = await freshModule();
    const canister = module.TAGGR_MAINNET_CANISTER;
    expect(() => module.saveSettings({ canister, domain: "  " })).toThrow(
      module.IdentityStorageError,
    );
    expect(() => module.saveSettings({ canister, domain: "d".repeat(65) })).toThrow(
      module.IdentityStorageError,
    );
  });

  test("falls back to the defaults rather than locking the app out on corrupt settings", async () => {
    backing.set("taggr.settings.v1", "{not json");
    const module = await freshModule();
    expect(module.loadSettings().domain).toBeNull();
  });
});
