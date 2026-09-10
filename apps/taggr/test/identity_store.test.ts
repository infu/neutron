import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SelfCallValue } from "neutron-tools/src/protocol.ts";

/**
 * The self-call wire between the background and this app's own backend.
 *
 * The Kernel normalizes Candid options and Results. The transport integration
 * suite separately drives the real SDK and Candid adapter without these mocks.
 */

const calls: Array<{ kind: "query" | "update"; method: string; args: SelfCallValue[] }> = [];
let reply: SelfCallValue = null;
let failure: Error | null = null;

const answer = async (
  kind: "query" | "update",
  method: string,
  args: SelfCallValue[],
): Promise<SelfCallValue> => {
  calls.push({ kind, method, args });
  if (failure) throw failure;
  return reply;
};

await mock.module("neutron-tools/app", () => ({
  querySelf: (method: string, args: SelfCallValue[]) => answer("query", method, args),
  updateSelf: (method: string, args: SelfCallValue[]) => answer("update", method, args),
}));

const store = await import("../src/identity_store.ts");

const seed = new Uint8Array(32).fill(9);

const state = (over: Record<string, unknown> = {}) => ({
  secret_key: [seed],
  canister_id: ["6qfxa-ryaaa-aaaai-qbhsq-cai"],
  domain: ["taggr.link"],
  created_at: 1,
  updated_at: 2,
  revision: 3,
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  reply = null;
  failure = null;
});

describe("reading the stored account", () => {
  test("reads the key through a query, not an update", () => {
    // It runs on every background start; an update would cost consensus.
    reply = state() as unknown as SelfCallValue;
    return store.readStored().then(() => {
      expect(calls).toEqual([{ kind: "query", method: "taggr_state_read", args: [null] }]);
    });
  });

  test("unwraps the Candid options Taggr's backend returns", async () => {
    reply = state() as unknown as SelfCallValue;
    expect(await store.readStored()).toEqual({
      secretKey: seed,
      canister: "6qfxa-ryaaa-aaaai-qbhsq-cai",
      domain: "taggr.link",
      revision: 3,
    });
  });

  test("reads an empty store as empty rather than as a key of zero bytes", async () => {
    reply = state({ secret_key: [], canister_id: [], domain: [] }) as unknown as SelfCallValue;
    expect(await store.readStored()).toEqual({
      secretKey: null,
      canister: null,
      domain: null,
      revision: 3,
    });
  });

  test("reads omitted Candid options and a normalized Nat revision", async () => {
    reply = { created_at: "0", updated_at: "0", revision: "0" };
    expect(await store.readStored()).toEqual({ secretKey: null, canister: null, domain: null, revision: 0 });
  });

  test("an incomplete record is not proof of an empty identity store", async () => {
    for (const invalid of [{}, { revision: "0" }, state({ revision: "invalid" }), state({ created_at: null })]) {
      reply = invalid as SelfCallValue;
      await expect(store.readStored()).rejects.toThrow(/unexpected identity record/);
    }
  });

  test("accepts an already-unwrapped option, so a decoder change cannot silently empty the store", async () => {
    reply = state({ secret_key: seed, canister_id: "abc", domain: null }) as unknown as SelfCallValue;
    const result = await store.readStored();
    expect(result.secretKey).toEqual(seed);
    expect(result.canister).toBe("abc");
    expect(result.domain).toBeNull();
  });

  test("refuses a key of the wrong length instead of signing with it", async () => {
    // A truncated seed is a different principal, which is a different account.
    reply = state({ secret_key: [new Uint8Array(16)] }) as unknown as SelfCallValue;
    await expect(store.readStored()).rejects.toThrow(/unexpected length/);
  });

  test("refuses a reply that is not a record", async () => {
    reply = "nope";
    await expect(store.readStored()).rejects.toThrow(store.IdentityStoreError);
  });

  test("accepts wrapped and unwrapped numeric byte vectors", async () => {
    for (const secret_key of [[Array.from(seed)], Array.from(seed)]) {
      reply = state({ secret_key }) as unknown as SelfCallValue;
      expect((await store.readStored()).secretKey).toEqual(seed);
    }
  });

  test("never treats an undecodable present key as an empty store", async () => {
    for (const secret_key of ["bad", {}, [null], [seed, seed], [[1, -1]], [[]]]) {
      reply = state({ secret_key }) as unknown as SelfCallValue;
      await expect(store.readStored()).rejects.toThrow(store.IdentityStoreError);
    }
  });
});

describe("writing the stored account", () => {
  test("accepts the Kernel's already-unwrapped successful writes", async () => {
    reply = state({ secret_key: seed, revision: "3" }) as unknown as SelfCallValue;
    expect((await store.initializeStoredIdentity(seed)).secretKey).toEqual(seed);
    expect((await store.writeStoredIdentity(seed)).secretKey).toEqual(seed);
    expect((await store.writeStoredSettings({ canister: "abc", domain: null })).revision).toBe(3);
  });

  test("sends the raw seed to the update method", async () => {
    reply = { ok: state() } as unknown as SelfCallValue;
    await store.writeStoredIdentity(seed);
    expect(calls).toEqual([
      { kind: "update", method: "taggr_identity_write", args: [{ secret_key: seed }] },
    ]);
  });

  test("initializes conditionally and returns a concurrent browser's winning seed", async () => {
    const winner = new Uint8Array(32).fill(8);
    reply = { ok: state({ secret_key: [winner] }) } as unknown as SelfCallValue;
    expect((await store.initializeStoredIdentity(seed)).secretKey).toEqual(winner);
    expect(calls).toEqual([
      { kind: "update", method: "taggr_identity_initialize", args: [{ secret_key: seed }] },
    ]);
  });

  test("does not acknowledge a replacement whose returned key differs", async () => {
    for (const secret_key of [[], [new Uint8Array(32).fill(8)]]) {
      reply = { ok: state({ secret_key }) } as unknown as SelfCallValue;
      await expect(store.writeStoredIdentity(seed)).rejects.toThrow(/did not confirm/);
    }
  });

  test("requires a saved key after initialization", async () => {
    reply = { ok: state({ secret_key: [] }) } as unknown as SelfCallValue;
    await expect(store.initializeStoredIdentity(seed)).rejects.toThrow(/did not confirm/);
  });

  test("refuses to send a key the backend would reject anyway", async () => {
    await expect(store.writeStoredIdentity(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
    expect(calls).toEqual([]);
  });

  test("surfaces the backend's own refusal", async () => {
    reply = { err: "A Taggr key is 32 bytes" } as unknown as SelfCallValue;
    await expect(store.writeStoredIdentity(seed)).rejects.toThrow("A Taggr key is 32 bytes");
  });

  test("encodes a pinned domain directly and an unpinned one as null", async () => {
    reply = { ok: state() } as unknown as SelfCallValue;
    await store.writeStoredSettings({ canister: "abc", domain: "taggr.link" });
    await store.writeStoredSettings({ canister: "abc", domain: null });
    expect(calls.map((call) => call.args[0])).toEqual([
      { canister_id: "abc", domain: "taggr.link" },
      { canister_id: "abc", domain: null },
    ]);
  });

  test("clearing returns the state directly, because there is nothing to reject", async () => {
    reply = state({ secret_key: [] }) as unknown as SelfCallValue;
    expect((await store.clearStoredIdentity()).secretKey).toBeNull();
    expect(calls[0]).toEqual({ kind: "update", method: "taggr_identity_clear", args: [null] });
  });

  test("a call that fails is an error the caller sees, not a silent no-op", async () => {
    failure = new Error("the Neutron did not answer");
    await expect(store.readStored()).rejects.toThrow("the Neutron did not answer");
  });
});
