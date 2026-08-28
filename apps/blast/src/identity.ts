import { ECDSAKeyIdentity } from "@dfinity/identity";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export const BLAST_KEYRING_DB_NAME = "neutron-blast-keyring-v1";
const BLAST_KEYRING_VERSION = 1;
const BLAST_IDENTITY_SLOT = 0;
const KEY_STORE = "keys" as const;
const KEY_PAIR_PROOF_CHALLENGE = "neutron.blast.local-identity-keypair.v1";

type StoredIdentityV1 = Readonly<{
  schema: 1;
  slot: typeof BLAST_IDENTITY_SLOT;
  createdAt: number;
  keyPair: CryptoKeyPair;
  publicKeyDer: Uint8Array;
  fingerprint: string;
  principal: string;
}>;

interface BlastKeyringSchema extends DBSchema {
  keys: {
    key: number;
    value: StoredIdentityV1;
  };
}

export type BlastLocalIdentity = Readonly<{
  slot: typeof BLAST_IDENTITY_SLOT;
  identity: ECDSAKeyIdentity;
  principal: string;
  createdAt: number;
  publicKeyFingerprint: string;
}>;

export type BlastPublicIdentity = Readonly<
  Omit<BlastLocalIdentity, "identity">
>;

export type BlastIdentityLoaderOptions = Readonly<{
  /** Test isolation seam. Production callers must use the default name. */
  databaseName?: string;
  /** Deterministic test seam. */
  now?: () => number;
}>;

/**
 * Load or atomically create Blast's one first-release local identity.
 *
 * The candidate is generated before opening a write transaction. The
 * transaction then rechecks slot zero, so concurrent first-use tabs serialize
 * on IndexedDB and both adopt the same winning key without replacing it.
 */
export async function loadOrCreateBlastLocalIdentity(
  options: BlastIdentityLoaderOptions = {},
): Promise<BlastLocalIdentity> {
  const databaseName = options.databaseName ?? BLAST_KEYRING_DB_NAME;
  if (databaseName.length === 0 || databaseName.length > 200) {
    throw new Error("Blast keyring database name is invalid");
  }
  const connection = await openKeyring(databaseName);
  try {
    connection.assertLive();
    const existing = await connection.database.get(
      KEY_STORE,
      BLAST_IDENTITY_SLOT,
    );
    connection.assertLive();
    if (existing !== undefined) return restoreIdentity(existing);

    const createdAt = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new Error("Blast identity creation time is invalid");
    }
    const candidate = await generateIdentityRecord(createdAt);
    connection.assertLive();

    const transaction = connection.database.transaction(KEY_STORE, "readwrite", {
      // The resident starts signing with this key as soon as the transaction
      // completes. Require the browser to durably commit the winning key first.
      durability: "strict",
    });
    const winner = await transaction.store.get(BLAST_IDENTITY_SLOT);
    if (winner === undefined) {
      await transaction.store.add(candidate);
      await transaction.done;
      connection.assertLive();
      return restoreIdentity(candidate);
    }
    await transaction.done;
    connection.assertLive();
    return restoreIdentity(winner);
  } finally {
    connection.database.close();
  }
}

export function blastPublicIdentity(
  local: BlastLocalIdentity,
): BlastPublicIdentity {
  return Object.freeze({
    slot: local.slot,
    principal: local.principal,
    createdAt: local.createdAt,
    publicKeyFingerprint: local.publicKeyFingerprint,
  });
}

async function generateIdentityRecord(
  createdAt: number,
): Promise<StoredIdentityV1> {
  assertWebCrypto();
  const identity = await ECDSAKeyIdentity.generate({
    extractable: false,
    keyUsages: ["sign", "verify"],
    subtleCrypto: globalThis.crypto.subtle,
  });
  const keyPair = identity.getKeyPair();
  assertP256KeyPair(keyPair);
  const publicKeyDer = new Uint8Array(identity.getPublicKey().toDer());
  const fingerprint = await sha256Hex(publicKeyDer);
  return Object.freeze({
    schema: 1,
    slot: BLAST_IDENTITY_SLOT,
    createdAt,
    keyPair,
    publicKeyDer,
    fingerprint,
    principal: identity.getPrincipal().toText(),
  });
}

async function restoreIdentity(
  value: StoredIdentityV1,
): Promise<BlastLocalIdentity> {
  assertStoredIdentity(value);
  assertWebCrypto();
  await assertMatchingKeyPair(value.keyPair);
  const identity = await ECDSAKeyIdentity.fromKeyPair(
    value.keyPair,
    globalThis.crypto.subtle,
  );
  const publicKeyDer = new Uint8Array(identity.getPublicKey().toDer());
  const fingerprint = await sha256Hex(publicKeyDer);
  const principal = identity.getPrincipal().toText();
  if (
    !equalBytes(publicKeyDer, value.publicKeyDer) ||
    fingerprint !== value.fingerprint ||
    principal !== value.principal
  ) {
    throw new Error("Blast keyring identity evidence does not match its key");
  }
  return Object.freeze({
    slot: BLAST_IDENTITY_SLOT,
    identity,
    principal,
    createdAt: value.createdAt,
    publicKeyFingerprint: fingerprint,
  });
}

function assertStoredIdentity(value: unknown): asserts value is StoredIdentityV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Blast keyring record is invalid");
  }
  const record = value as Partial<StoredIdentityV1>;
  if (
    record.schema !== 1 ||
    record.slot !== BLAST_IDENTITY_SLOT ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt ?? -1) < 0 ||
    typeof record.principal !== "string" ||
    typeof record.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.fingerprint) ||
    !(record.publicKeyDer instanceof Uint8Array) ||
    record.publicKeyDer.byteLength === 0 ||
    typeof record.keyPair !== "object" ||
    record.keyPair === null
  ) {
    throw new Error("Blast keyring record is invalid");
  }
  assertP256KeyPair(record.keyPair as CryptoKeyPair);
}

function assertP256KeyPair(keyPair: CryptoKeyPair): void {
  assertCryptoKey(keyPair.privateKey, "private", false, "sign");
  assertCryptoKey(keyPair.publicKey, "public", true, "verify");
}

async function assertMatchingKeyPair(keyPair: CryptoKeyPair): Promise<void> {
  // Matching algorithms/usages do not prove that two stored key handles form
  // one signer. Exercise the non-extractable private key before adopting it.
  const challenge = new TextEncoder().encode(KEY_PAIR_PROOF_CHALLENGE);
  try {
    const signature = await globalThis.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      challenge,
    );
    const matches = await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.publicKey,
      signature,
      challenge,
    );
    if (matches) return;
  } catch (cause) {
    throw new Error("Blast keyring private/public keys do not match", {
      cause,
    });
  }
  throw new Error("Blast keyring private/public keys do not match");
}

function assertCryptoKey(
  key: CryptoKey,
  type: KeyType,
  extractable: boolean,
  usage: KeyUsage,
): void {
  const algorithm = key?.algorithm as EcKeyAlgorithm | undefined;
  if (
    key?.type !== type ||
    key.extractable !== extractable ||
    algorithm?.name !== "ECDSA" ||
    algorithm.namedCurve !== "P-256" ||
    key.usages.length !== 1 ||
    key.usages[0] !== usage
  ) {
    throw new Error("Blast keyring contains an invalid P-256 key pair");
  }
}

type OpenKeyring = Readonly<{
  database: IDBPDatabase<BlastKeyringSchema>;
  assertLive(): void;
}>;

async function openKeyring(databaseName: string): Promise<OpenKeyring> {
  let database: IDBPDatabase<BlastKeyringSchema> | null = null;
  let terminated = false;
  let rejectBlocked!: (error: Error) => void;
  const blocked = new Promise<never>((_resolve, reject) => {
    rejectBlocked = reject;
  });
  const opened = openDB<BlastKeyringSchema>(
    databaseName,
    BLAST_KEYRING_VERSION,
    {
      upgrade(db, oldVersion) {
        if (oldVersion !== 0) {
          throw new Error("Blast keyring schema cannot be upgraded implicitly");
        }
        db.createObjectStore(KEY_STORE, { keyPath: "slot" });
      },
      blocked() {
        rejectBlocked(new Error("Blast keyring open is blocked by another tab"));
      },
      blocking() {
        terminated = true;
        database?.close();
      },
      terminated() {
        terminated = true;
      },
    },
  );

  try {
    database = await Promise.race([opened, blocked]);
  } catch (error) {
    void opened.then(
      (lateDatabase) => lateDatabase.close(),
      () => undefined,
    );
    throw error;
  }
  if (terminated) {
    database.close();
    throw new Error("Blast keyring connection terminated during open");
  }
  if (!database.objectStoreNames.contains(KEY_STORE)) {
    database.close();
    throw new Error("Blast keyring store is unavailable");
  }
  return Object.freeze({
    database,
    assertLive() {
      if (terminated) throw new Error("Blast keyring connection terminated");
    },
  });
}

function assertWebCrypto(): void {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Blast local identity requires WebCrypto");
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    copied.buffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
