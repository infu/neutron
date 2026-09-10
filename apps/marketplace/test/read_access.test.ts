import { expect, test } from "bun:test";
import { IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR, requestIdOf } from "@dfinity/agent";
import { Delegation, Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { secp256k1 } from "@noble/curves/secp256k1";
import { delegationIdentity, readAccess, READ_DELEGATION_EXPIRATION } from "../src/read_access.ts";
import type { Kernel, StoredState } from "../src/store.ts";

const owner = "rrkah-fqaaa-aaaaa-aaaaq-cai", target = "sj2r4-haaaa-aaaay-aadgq-cai";
const rootSecret = new Uint8Array(32).fill(11), root = secp256k1.getPublicKey(rootSecret);
const inner = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(7));
const state: StoredState = { owner, canisterId: target, host: "https://icp-api.io", revision: 2, seed: new Uint8Array(32).fill(7) };
async function signed(publicKey = inner.getPublicKey().toDer(), selected = target) {
  const delegation = new Delegation(publicKey, READ_DELEGATION_EXPIRATION, [Principal.fromText(selected)]);
  const challenge = new Uint8Array([...IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR, ...requestIdOf({ ...delegation })]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", challenge));
  return { publicKey: root, sessionPublicKey: publicKey, expiration: String(READ_DELEGATION_EXPIRATION), target: selected,
    signature: secp256k1.sign(digest, rootSecret, { prehash: false }).toCompactRawBytes() };
}
function fixture() {
  const calls: string[] = [], entries = new Map<string, string>();
  const cache = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
  const kernel = { updateSelf: async (method: string, args: unknown[]) => {
    calls.push(method);
    if (method === "marketplace_read_key") return { ok: root };
    if (method === "marketplace_read_identity") return { ok: await signed((args[0] as { publicKey: Uint8Array }).publicKey) };
    throw new Error(`Unexpected ${method}`);
  } } as unknown as Kernel;
  return { calls, entries, cache, kernel };
}

test("fresh installation and reinstall use the same root principal with different browser seeds", async () => {
  const f = fixture();
  const first = await readAccess(f.kernel, state, inner, f.cache);
  const afterUninstall = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(9));
  const restored = await readAccess(f.kernel, { ...state, seed: new Uint8Array(32).fill(9) }, afterUninstall, null);
  expect(first.getPrincipal().toText()).toBe(restored.getPrincipal().toText());
  expect(first.getPrincipal().toText()).not.toBe(inner.getPrincipal().toText());
  expect(first.getDelegation().delegations[0]?.delegation.targets?.map(p => p.toText())).toEqual([target]);
  expect(first.getDelegation().delegations[0]?.delegation.expiration).toBe(READ_DELEGATION_EXPIRATION);
});

test("reload reuses a verified public delegation without another threshold signature", async () => {
  const f = fixture();
  const first = await readAccess(f.kernel, state, inner, f.cache);
  const second = await readAccess(f.kernel, state, inner, f.cache);
  expect(first.getPrincipal().toText()).toBe(second.getPrincipal().toText());
  expect(f.calls).toEqual(["marketplace_read_key", "marketplace_read_identity", "marketplace_read_key"]);
  const saved = JSON.parse([...f.entries.values()][0]!);
  expect(Object.keys(saved).sort()).toEqual(["expiration", "publicKey", "sessionPublicKey", "signature", "target"]);
  expect(saved.seed).toBeUndefined();
});

test("corrupt or differently bound cache is discarded and replaced after verifying the live root", async () => {
  for (const field of ["target", "sessionPublicKey", "publicKey", "signature", "expiration"]) {
    const f = fixture();
    await readAccess(f.kernel, state, inner, f.cache);
    const [key, value] = [...f.entries.entries()][0]!;
    const saved = JSON.parse(value);
    saved[field] = field === "target" ? owner : field === "expiration" ? "1" : new Array(field === "signature" ? 64 : field === "publicKey" ? 33 : 44).fill(0);
    f.entries.set(key, JSON.stringify(saved));
    await readAccess(f.kernel, state, inner, f.cache);
    expect(f.calls.filter(call => call === "marketplace_read_identity")).toHaveLength(2);
  }
});

test("cache never bypasses an unavailable or disabled Neutron custody key", async () => {
  const f = fixture();
  await readAccess(f.kernel, state, inner, f.cache);
  const unavailable = { updateSelf: async () => ({ err: "read key disabled" }) } as unknown as Kernel;
  await expect(readAccess(unavailable, state, inner, f.cache)).rejects.toThrow("disabled");
});

test("a valid signature for another target, browser key or root cannot authorize this connection", async () => {
  const reply = await signed();
  await expect(delegationIdentity(await signed(inner.getPublicKey().toDer(), owner), root, inner, target)).rejects.toThrow("does not match");
  await expect(delegationIdentity(reply, secp256k1.getPublicKey(new Uint8Array(32).fill(12)), inner, target)).rejects.toThrow("does not match");
  await expect(delegationIdentity(reply, root, Ed25519KeyIdentity.generate(new Uint8Array(32).fill(1)), target)).rejects.toThrow("does not match");
  await expect(delegationIdentity({ ...reply, signature: new Uint8Array(64) }, root, inner, target)).rejects.toThrow("signature");
});

test("browser storage denial does not prevent authenticated direct access", async () => {
  const f = fixture();
  const denied = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  expect((await readAccess(f.kernel, state, inner, denied)).getPrincipal().isAnonymous()).toBe(false);
});
