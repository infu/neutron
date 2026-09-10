import { describe, expect, test } from "bun:test";
import { parseState, readIdentity, saveIntent, validateHost, type Kernel } from "../src/store.ts";
const owner = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const state = { owner, canister: null, seed: null, host: "https://icp-api.io", revision: "0" };

describe("durable marketplace browser access", () => {
  test("supports typed and legacy optional blobs without changing the identity", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
    for (const encoding of [seed, [seed], [...seed], [[...seed]]]) expect(parseState({ ...state, seed: encoding }).seed).toEqual(seed);
    expect(() => parseState({ ...state, seed: "secret" })).toThrow("binary");
    expect(() => parseState({ ...state, seed: new Uint8Array(31) })).toThrow("invalid");
  });
  test("an unavailable durable store never generates a replacement read key", async () => {
    let writes = 0;
    const kernel = { querySelf: async () => { throw new Error("offline"); }, updateSelf: async () => { writes++; } } as unknown as Kernel;
    await expect(readIdentity(kernel)).rejects.toThrow("offline");
    expect(writes).toBe(0);
  });
  test("fresh browsers adopt the seed returned by atomic initialization", async () => {
    const winner = new Uint8Array(32).fill(7);
    const kernel = { querySelf: async () => state, updateSelf: async () => ({ ...state, seed: winner }) } as unknown as Kernel;
    const saved = await readIdentity(kernel);
    expect(saved.state.seed).toEqual(winner);
    expect(new Uint8Array(saved.identity.getKeyPair().secretKey).slice(0, 32)).toEqual(winner);
  });
  test("intent persistence propagates immutable-intent rejection before dispatch", async () => {
    const kernel = { updateSelf: async () => ({ err: "already belongs to a different saved intent" }) } as unknown as Kernel;
    await expect(saveIntent(kernel, "same-id", { amount: "12" })).rejects.toThrow("different saved intent");
  });
  test("only local testing may fetch a root key from an HTTP replica", () => {
    expect(validateHost("http://127.0.0.1:4943")).toBe("http://127.0.0.1:4943");
    expect(validateHost("https://icp-api.io/")).toBe("https://icp-api.io");
    for (const host of ["http://example.com", "https://user:secret@example.com", "https://example.com/?key=secret"]) expect(() => validateHost(host)).toThrow();
  });
});
