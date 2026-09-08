import {
  Delegation,
  DelegationChain,
  DelegationIdentity,
  ECDSAKeyIdentity,
  type JsonnableDelegationChain,
} from "@dfinity/identity";
import type { DerEncodedPublicKey, Signature, SignIdentity } from "@dfinity/agent";
import { KEYS, keystore } from "./keystore.ts";

/**
 * The session key is a single non-extractable ECDSA P-256 keypair. Email login
 * delegates the email auth principal to it; then OpenChat's identity canister
 * delegates the OpenChat principal to the same key. Every OpenChat call is then
 * signed locally by this key under the OpenChat delegation — no popup, no
 * kernel dialog, no further interaction until the delegation expires.
 */
let loadingSessionKey: Promise<ECDSAKeyIdentity> | null = null;

export function loadOrCreateSessionKey(): Promise<ECDSAKeyIdentity> {
  // Boot and login can both request the key before IndexedDB returns. They
  // must use the same signer: persisting one key while delegating to another
  // makes an otherwise valid session impossible to restore after a restart.
  loadingSessionKey ??= readOrCreateSessionKey().finally(() => {
    loadingSessionKey = null;
  });
  return loadingSessionKey;
}

async function readOrCreateSessionKey(): Promise<ECDSAKeyIdentity> {
  const kv = await keystore();
  const stored = await kv.get<CryptoKeyPair>(KEYS.sessionKeyPair);
  if (stored) {
    try {
      return await ECDSAKeyIdentity.fromKeyPair(stored);
    } catch {
      // fall through and regenerate
    }
  }
  const key = await ECDSAKeyIdentity.generate({
    extractable: false,
    keyUsages: ["sign", "verify"],
    subtleCrypto: globalThis.crypto.subtle,
  });
  await kv.set(KEYS.sessionKeyPair, key.getKeyPair());
  return key;
}

export function derPublicKey(key: ECDSAKeyIdentity): Uint8Array {
  return new Uint8Array(key.getPublicKey().toDer());
}

function matchesSessionKey(sessionKey: SignIdentity, publicKey: Uint8Array): boolean {
  const expected = new Uint8Array(sessionKey.getPublicKey().toDer());
  return publicKey.length === expected.length &&
    publicKey.every((byte, index) => byte === expected[index]);
}

/** Build a single-hop delegation identity from a canister-signed delegation. */
export function buildDelegationIdentity(
  sessionKey: SignIdentity,
  userKey: Uint8Array,
  delegationPubkey: Uint8Array,
  expiration: bigint,
  signature: Uint8Array,
): DelegationIdentity {
  if (!matchesSessionKey(sessionKey, delegationPubkey)) {
    throw new Error("The delegation does not match this session's signing key.");
  }
  const chain = DelegationChain.fromDelegations(
    [
      {
        delegation: new Delegation(delegationPubkey, expiration),
        signature: signature as unknown as Signature,
      },
    ],
    userKey as unknown as DerEncodedPublicKey,
  );
  return DelegationIdentity.fromDelegation(sessionKey, chain);
}

export type OcProfile = {
  ocPrincipal: string;
  userId?: string;
  username?: string;
  localUserIndex?: string;
  avatarUrl?: string | null;
};

export type StoredOcSession = {
  chain: JsonnableDelegationChain;
  expirationMs: number;
  profile: OcProfile;
};

export async function saveOcSession(session: StoredOcSession): Promise<void> {
  const kv = await keystore();
  await kv.set(KEYS.ocSession, session);
}

export async function clearOcSession(): Promise<void> {
  const kv = await keystore();
  await kv.del(KEYS.ocSession);
}

/**
 * Restore the logged-in OpenChat identity from storage, if present and not
 * expired. Returns null when the user must (re)authenticate.
 */
export async function restoreOcIdentity(
  sessionKey: ECDSAKeyIdentity,
): Promise<{ identity: DelegationIdentity; session: StoredOcSession } | null> {
  const kv = await keystore();
  const session = await kv.get<StoredOcSession>(KEYS.ocSession);
  if (!session) return null;
  try {
    const chain = DelegationChain.fromJSON(session.chain);
    const last = chain.delegations.at(-1);
    if (!last || !matchesSessionKey(sessionKey, last.delegation.pubkey)) {
      throw new Error("The stored delegation does not match this session's signing key.");
    }
    // expirationMs is cached display metadata. The signed chain is the
    // authority, including earlier hops in a multi-hop delegation.
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    let expiration = last.delegation.expiration;
    for (const { delegation } of chain.delegations) {
      if (delegation.expiration <= nowNs) throw new Error("The stored delegation has expired.");
      if (delegation.expiration < expiration) expiration = delegation.expiration;
    }
    const identity = DelegationIdentity.fromDelegation(sessionKey, chain);
    return { identity, session: { ...session, expirationMs: nsToMs(expiration) } };
  } catch {
    await kv.del(KEYS.ocSession);
    return null;
  }
}

/** Nanosecond IC timestamp -> JS milliseconds. */
export function nsToMs(ns: bigint): number {
  return Number(ns / 1_000_000n);
}

export type PendingEmail = {
  email: string;
  userKey: Uint8Array;
  expiration: bigint;
  code: string;
  createdAtMs: number;
};

export async function savePendingEmail(p: PendingEmail): Promise<void> {
  const kv = await keystore();
  await kv.set(KEYS.pendingEmail, p);
}

export async function loadPendingEmail(): Promise<PendingEmail | undefined> {
  const kv = await keystore();
  return kv.get<PendingEmail>(KEYS.pendingEmail);
}

export async function clearPendingEmail(): Promise<void> {
  const kv = await keystore();
  await kv.del(KEYS.pendingEmail);
}
