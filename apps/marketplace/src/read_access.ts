import { IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR, requestIdOf, type Signature } from "@dfinity/agent";
import { Delegation, DelegationChain, DelegationIdentity, type Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytes, unwrap, type Kernel, type StoredState } from "./store.ts";

// The root key is derived by Neutron's existing app-ID custody slot, so it
// survives app uninstall. Only the browser signing key lives in app memory.
// Its delegation is restricted to the configured Marketplace, whose protocol
// grants this principal reads only. Revocation is enforced by that protocol.
export const READ_DELEGATION_EXPIRATION = (1n << 64n) - 1n;
const SECP_DER_PREFIX = Uint8Array.from([0x30, 0x56, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a, 0x03, 0x42, 0x00]);
type PublicCache = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Reply = { publicKey: unknown; sessionPublicKey: unknown; signature: unknown; expiration: unknown; target: unknown };
const hex = (value: Uint8Array) => [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);
function browserCache(): PublicCache | null { try { return globalThis.localStorage ?? null; } catch { return null; } }
function derPublicKey(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33) throw new Error("Marketplace returned an invalid permanent read key.");
  const uncompressed = secp256k1.ProjectivePoint.fromHex(compressed).toRawBytes(false);
  return new Uint8Array([...SECP_DER_PREFIX, ...uncompressed]);
}
export async function delegationIdentity(reply: Reply, root: Uint8Array, inner: Ed25519KeyIdentity, target: string): Promise<DelegationIdentity> {
  const publicKey = bytes(reply.publicKey), sessionPublicKey = bytes(reply.sessionPublicKey), signature = bytes(reply.signature);
  if (!equal(publicKey, root) || !equal(sessionPublicKey, inner.getPublicKey().toDer()) ||
      String(reply.target) !== target || BigInt(String(reply.expiration)) !== READ_DELEGATION_EXPIRATION || signature.length !== 64) {
    throw new Error("Marketplace read access does not match this Neutron and browser.");
  }
  const delegation = new Delegation(sessionPublicKey, READ_DELEGATION_EXPIRATION, [Principal.fromText(target)]);
  const challenge = new Uint8Array([...IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR, ...requestIdOf({ ...delegation })]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", challenge));
  if (!secp256k1.verify(signature, digest, root, { lowS: false, prehash: false })) throw new Error("Marketplace read delegation signature is invalid.");
  return DelegationIdentity.fromDelegation(inner, DelegationChain.fromDelegations([{ delegation, signature: signature as Signature }], derPublicKey(root)));
}

export async function readAccess(kernel: Kernel, state: StoredState, inner: Ed25519KeyIdentity, cache: PublicCache | null = browserCache()): Promise<DelegationIdentity> {
  if (!state.canisterId) throw new Error("Choose a marketplace in Settings.");
  // Ask the live Neutron for the root, never trust a browser-cache root when
  // registering access. The Kernel caches the threshold public key itself.
  const root = bytes(unwrap(await kernel.updateSelf("marketplace_read_key", [null])));
  const sessionPublicKey = inner.getPublicKey().toDer();
  const key = `marketplace.read-access.v1:${state.owner}:${state.canisterId}:${hex(sessionPublicKey)}`;
  try {
    const saved = cache?.getItem(key);
    if (saved) return await delegationIdentity(JSON.parse(saved), root, inner, state.canisterId);
  } catch { try { cache?.removeItem(key); } catch { /* Storage is optional. */ } }
  const reply = unwrap(await kernel.updateSelf("marketplace_read_identity", [{ publicKey: sessionPublicKey }])) as Reply;
  const identity = await delegationIdentity(reply, root, inner, state.canisterId);
  // This cache contains only PUBLIC keys and their signed delegation. The
  // private session seed remains in the existing managed app-memory root.
  try { cache?.setItem(key, JSON.stringify({ publicKey: [...root], sessionPublicKey: [...sessionPublicKey], signature: [...bytes(reply.signature)], expiration: String(reply.expiration), target: String(reply.target) })); } catch { /* A fresh browser can request the same identity again. */ }
  return identity;
}
