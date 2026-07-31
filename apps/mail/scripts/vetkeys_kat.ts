import {
  DerivedPublicKey,
  EncryptedVetKey,
  TransportSecretKey,
} from "@dfinity/vetkeys";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const MAIL_REAL_VETKEYS_KAT_SCHEMA = "neutron.mail.real-vetkeys-kat";
export const MAIL_REAL_VETKEYS_KAT_VERSION = 1;
export const MAIL_REAL_VETKEYS_KAT_FILE =
  "test/vectors/vetkeys-local-current-previous-v1.json";

export const PINNED_VETKEYS_PACKAGE = Object.freeze({
  name: "@dfinity/vetkeys",
  version: "0.4.0",
  npmIntegrity:
    "sha512-MLa5UvseEOVB6HgcKYtIDOZc6De0tdRm61dZlmAVKKqjnZuXoUJqypDbMe30EnofH0JMjvGQP2jGvxGRKC6nGQ==",
});

// Public, non-secret test material. It was generated once with
// TransportSecretKey.random() from the pinned package and is deliberately
// reused only so a captured management-canister response remains a KAT.
export const MAIL_REAL_VETKEYS_KAT_TRANSPORT_SECRET_HEX =
  "15fbb76fd0a215cbedfb6200f9b791ad75db9252e3c89140a19a4ab62f8507c0";
export const MAIL_REAL_VETKEYS_KAT_TRANSPORT_PUBLIC_HEX =
  "883ee92337ff75a80c7b53ba7024261ac53f3347c3c42e91baac43308335d7f0e0c617a07621ab5ce135dd9d0df67ade";
export const MAIL_REAL_VETKEYS_KAT_IDENTITY_SEED = 2;
export const MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL =
  "ugnk3-oybq3-qsesh-kfxvo-pl2rt-y2h2x-bbtku-g6n4j-7xkvx-7l2u3-kae";
export const MAIL_REAL_VETKEYS_KAT_APP_ID = "mail";
export const MAIL_REAL_VETKEYS_KAT_SLOT_ID = "mailbox";
export const MAIL_REAL_VETKEYS_KAT_SUITE = "bls12_381_g2";
export const MAIL_REAL_VETKEYS_KAT_KEY_NAME = "test_key_1";

const MAX_VECTOR_BYTES = 64 * 1024;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const LOWER_HEX = /^[0-9a-f]+$/u;

export type RealVetKeysKatPublicInfo = {
  canisterPrincipal: string;
  derivationInputHex: string;
  generation: string;
  keyName: string;
  publicFingerprintHex: string;
  publicKeyHex: string;
  slot: string;
  suite: string;
};

export type RealVetKeysKatGeneration = {
  decryptedVetKeyHex: string;
  derivePublicInfo: RealVetKeysKatPublicInfo;
  encryptedVetKeyHex: string;
  generation: string;
  publicInfo: RealVetKeysKatPublicInfo;
  status: "current" | "previous";
};

export type RealVetKeysKatVector = {
  capture: {
    environment: "local";
    identityPrincipal: string;
    identitySeed: 2;
    keyName: "test_key_1";
    library: {
      name: "@dfinity/vetkeys";
      npmIntegrity: string;
      version: "0.4.0";
    };
  };
  generations: {
    current: RealVetKeysKatGeneration;
    previous: RealVetKeysKatGeneration;
  };
  neutron: {
    appId: "mail";
    canisterPrincipal: string;
    slotId: "mailbox";
    slotUid: string;
  };
  schema: "neutron.mail.real-vetkeys-kat";
  transport: {
    publicKeyHex: string;
    secretKeyHex: string;
  };
  version: 1;
};

/** Parse, close-schema validate, and require the checked-in canonical form. */
export function parseRealVetKeysKat(text: string): RealVetKeysKatVector {
  if (Buffer.byteLength(text, "utf8") > MAX_VECTOR_BYTES) {
    throw new Error("Real vetKeys KAT exceeds its 64 KiB bound");
  }
  if (text.startsWith("\uFEFF")) throw new Error("Real vetKeys KAT must not use a BOM");
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Real vetKeys KAT is not valid JSON", { cause: error });
  }
  const vector = parseVector(decoded);
  if (text !== encodeRealVetKeysKat(vector)) {
    throw new Error("Real vetKeys KAT is not canonical JSON");
  }
  return vector;
}

export function encodeRealVetKeysKat(vector: RealVetKeysKatVector): string {
  return `${JSON.stringify(sortJson(vector), null, 2)}\n`;
}

/**
 * Verify the frozen response using only the pinned browser library and the
 * vector. No actor, replica, DNS, HTTP, or other network surface is touched.
 */
export function verifyRealVetKeysKat(vector: RealVetKeysKatVector): void {
  const reparsed = parseVector(vector);
  const transportSecret = fromHex(
    reparsed.transport.secretKeyHex,
    32,
    "transport secret key",
  );
  const transport = TransportSecretKey.deserialize(transportSecret);
  assertEqualHex(
    hex(transport.serialize()),
    MAIL_REAL_VETKEYS_KAT_TRANSPORT_SECRET_HEX,
    "serialized transport secret key",
  );
  assertEqualHex(
    hex(transport.publicKeyBytes()),
    reparsed.transport.publicKeyHex,
    "derived transport public key",
  );

  verifyGeneration(reparsed, reparsed.generations.current, "current");
  verifyGeneration(reparsed, reparsed.generations.previous, "previous");

  const current = reparsed.generations.current;
  const previous = reparsed.generations.previous;
  for (const [label, left, right] of [
    ["generation", current.generation, previous.generation],
    ["public key", current.publicInfo.publicKeyHex, previous.publicInfo.publicKeyHex],
    [
      "public fingerprint",
      current.publicInfo.publicFingerprintHex,
      previous.publicInfo.publicFingerprintHex,
    ],
    [
      "derivation input",
      current.publicInfo.derivationInputHex,
      previous.publicInfo.derivationInputHex,
    ],
    ["encrypted VetKey", current.encryptedVetKeyHex, previous.encryptedVetKeyHex],
    ["decrypted VetKey", current.decryptedVetKeyHex, previous.decryptedVetKeyHex],
  ] as const) {
    if (left === right) {
      throw new Error(`Real vetKeys KAT current and previous ${label} must differ`);
    }
  }
}

/** Verify package declarations and the npm tarball integrity pin offline. */
export async function assertPinnedVetKeysInstallation(mailRoot: string): Promise<void> {
  const packageJson = await readJson(resolve(mailRoot, "package.json"));
  const dependencies = record(packageJson.dependencies, "Mail dependencies");
  if (dependencies[PINNED_VETKEYS_PACKAGE.name] !== PINNED_VETKEYS_PACKAGE.version) {
    throw new Error(
      `Mail must pin ${PINNED_VETKEYS_PACKAGE.name} exactly to ${PINNED_VETKEYS_PACKAGE.version}`,
    );
  }

  const lock = await readJson(resolve(mailRoot, "../../package-lock.json"));
  const packages = record(lock.packages, "workspace lock packages");
  const mail = record(packages["apps/mail"], "workspace Mail lock entry");
  const lockedMailDependencies = record(
    mail.dependencies,
    "workspace Mail locked dependencies",
  );
  if (
    lockedMailDependencies[PINNED_VETKEYS_PACKAGE.name] !==
    PINNED_VETKEYS_PACKAGE.version
  ) {
    throw new Error("Workspace lock does not preserve Mail's exact vetKeys version");
  }
  const installed = record(
    packages["node_modules/@dfinity/vetkeys"],
    "workspace vetKeys lock entry",
  );
  if (
    installed.version !== PINNED_VETKEYS_PACKAGE.version ||
    installed.integrity !== PINNED_VETKEYS_PACKAGE.npmIntegrity
  ) {
    throw new Error("Workspace lock does not match the pinned vetKeys version/integrity");
  }

  const installedPackage = await readJson(
    resolve(mailRoot, "../../node_modules/@dfinity/vetkeys/package.json"),
  );
  if (installedPackage.version !== PINNED_VETKEYS_PACKAGE.version) {
    throw new Error("Installed vetKeys package does not match Mail's version pin");
  }
}

function verifyGeneration(
  vector: RealVetKeysKatVector,
  generation: RealVetKeysKatGeneration,
  expectedStatus: "current" | "previous",
): void {
  if (generation.status !== expectedStatus) {
    throw new Error(`Real vetKeys KAT ${expectedStatus} status is inconsistent`);
  }
  assertExactPublicInfo(
    generation.derivePublicInfo,
    generation.publicInfo,
    `${expectedStatus} derive/public response`,
  );
  const info = generation.publicInfo;
  if (
    info.canisterPrincipal !== vector.neutron.canisterPrincipal ||
    info.slot !== vector.neutron.slotId ||
    info.generation !== generation.generation
  ) {
    throw new Error(`Real vetKeys KAT ${expectedStatus} public binding is inconsistent`);
  }
  const publicKey = fromHex(info.publicKeyHex, 96, `${expectedStatus} public key`);
  const fingerprint = fromHex(
    info.publicFingerprintHex,
    32,
    `${expectedStatus} public fingerprint`,
  );
  const digest = createHash("sha256").update(publicKey).digest();
  if (!Buffer.from(fingerprint).equals(digest)) {
    throw new Error(`Real vetKeys KAT ${expectedStatus} public fingerprint is invalid`);
  }
  const derivationInput = fromHex(
    info.derivationInputHex,
    32,
    `${expectedStatus} derivation input`,
  );
  const encrypted = fromHex(
    generation.encryptedVetKeyHex,
    192,
    `${expectedStatus} encrypted VetKey`,
  );
  const transport = TransportSecretKey.deserialize(
    fromHex(vector.transport.secretKeyHex, 32, "transport secret key"),
  );
  const decrypted = EncryptedVetKey.deserialize(encrypted).decryptAndVerify(
    transport,
    DerivedPublicKey.deserialize(publicKey),
    derivationInput,
  );
  const actual = hex(decrypted.serialize());
  assertEqualHex(actual, generation.decryptedVetKeyHex, `${expectedStatus} VetKey`);
  if (actual.length !== 96) {
    throw new Error(`Real vetKeys KAT ${expectedStatus} VetKey must be 48 bytes`);
  }
}

function parseVector(value: unknown): RealVetKeysKatVector {
  const source = exactRecord(
    value,
    ["capture", "generations", "neutron", "schema", "transport", "version"],
    "real vetKeys KAT",
  );
  if (
    source.schema !== MAIL_REAL_VETKEYS_KAT_SCHEMA ||
    source.version !== MAIL_REAL_VETKEYS_KAT_VERSION
  ) {
    throw new Error("Unsupported real vetKeys KAT schema/version");
  }

  const capture = exactRecord(
    source.capture,
    ["environment", "identityPrincipal", "identitySeed", "keyName", "library"],
    "real vetKeys KAT capture",
  );
  const library = exactRecord(
    capture.library,
    ["name", "npmIntegrity", "version"],
    "real vetKeys KAT library",
  );
  if (
    capture.environment !== "local" ||
    capture.identitySeed !== MAIL_REAL_VETKEYS_KAT_IDENTITY_SEED ||
    capture.identityPrincipal !== MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL ||
    capture.keyName !== MAIL_REAL_VETKEYS_KAT_KEY_NAME ||
    library.name !== PINNED_VETKEYS_PACKAGE.name ||
    library.version !== PINNED_VETKEYS_PACKAGE.version ||
    library.npmIntegrity !== PINNED_VETKEYS_PACKAGE.npmIntegrity
  ) {
    throw new Error("Real vetKeys KAT capture metadata does not match the frozen profile");
  }

  const neutron = exactRecord(
    source.neutron,
    ["appId", "canisterPrincipal", "slotId", "slotUid"],
    "real vetKeys KAT Neutron binding",
  );
  if (
    neutron.appId !== MAIL_REAL_VETKEYS_KAT_APP_ID ||
    neutron.slotId !== MAIL_REAL_VETKEYS_KAT_SLOT_ID
  ) {
    throw new Error("Real vetKeys KAT is not bound to Mail's mailbox slot");
  }
  const canisterPrincipal = principal(
    neutron.canisterPrincipal,
    "real vetKeys KAT canister principal",
  );
  const slotUid = positiveDecimal(neutron.slotUid, "real vetKeys KAT slot UID");

  const transport = exactRecord(
    source.transport,
    ["publicKeyHex", "secretKeyHex"],
    "real vetKeys KAT transport",
  );
  const secretKeyHex = fixedHex(
    transport.secretKeyHex,
    32,
    "real vetKeys KAT transport secret",
  );
  const publicKeyHex = fixedHex(
    transport.publicKeyHex,
    48,
    "real vetKeys KAT transport public key",
  );
  if (
    secretKeyHex !== MAIL_REAL_VETKEYS_KAT_TRANSPORT_SECRET_HEX ||
    publicKeyHex !== MAIL_REAL_VETKEYS_KAT_TRANSPORT_PUBLIC_HEX
  ) {
    throw new Error("Real vetKeys KAT does not use the frozen transport key");
  }

  const generations = exactRecord(
    source.generations,
    ["current", "previous"],
    "real vetKeys KAT generations",
  );
  const current = parseGeneration(generations.current, "current");
  const previous = parseGeneration(generations.previous, "previous");
  if (current.generation === previous.generation) {
    throw new Error("Real vetKeys KAT must contain distinct current and previous generations");
  }

  return {
    capture: {
      environment: "local",
      identityPrincipal: MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
      identitySeed: MAIL_REAL_VETKEYS_KAT_IDENTITY_SEED,
      keyName: MAIL_REAL_VETKEYS_KAT_KEY_NAME,
      library: { ...PINNED_VETKEYS_PACKAGE },
    },
    generations: { current, previous },
    neutron: {
      appId: MAIL_REAL_VETKEYS_KAT_APP_ID,
      canisterPrincipal,
      slotId: MAIL_REAL_VETKEYS_KAT_SLOT_ID,
      slotUid,
    },
    schema: MAIL_REAL_VETKEYS_KAT_SCHEMA,
    transport: { publicKeyHex, secretKeyHex },
    version: MAIL_REAL_VETKEYS_KAT_VERSION,
  };
}

function parseGeneration(
  value: unknown,
  expectedStatus: "current" | "previous",
): RealVetKeysKatGeneration {
  const source = exactRecord(
    value,
    [
      "decryptedVetKeyHex",
      "derivePublicInfo",
      "encryptedVetKeyHex",
      "generation",
      "publicInfo",
      "status",
    ],
    `real vetKeys KAT ${expectedStatus} generation`,
  );
  if (source.status !== expectedStatus) {
    throw new Error(`Real vetKeys KAT ${expectedStatus} generation has the wrong status`);
  }
  const generation = positiveDecimal(
    source.generation,
    `real vetKeys KAT ${expectedStatus} generation number`,
  );
  const publicInfo = parsePublicInfo(source.publicInfo, generation, expectedStatus);
  const derivePublicInfo = parsePublicInfo(
    source.derivePublicInfo,
    generation,
    `${expectedStatus} derive`,
  );
  return {
    decryptedVetKeyHex: fixedHex(
      source.decryptedVetKeyHex,
      48,
      `real vetKeys KAT ${expectedStatus} decrypted VetKey`,
    ),
    derivePublicInfo,
    encryptedVetKeyHex: fixedHex(
      source.encryptedVetKeyHex,
      192,
      `real vetKeys KAT ${expectedStatus} encrypted VetKey`,
    ),
    generation,
    publicInfo,
    status: expectedStatus,
  };
}

function parsePublicInfo(
  value: unknown,
  generation: string,
  label: string,
): RealVetKeysKatPublicInfo {
  const source = exactRecord(
    value,
    [
      "canisterPrincipal",
      "derivationInputHex",
      "generation",
      "keyName",
      "publicFingerprintHex",
      "publicKeyHex",
      "slot",
      "suite",
    ],
    `real vetKeys KAT ${label} public info`,
  );
  if (
    source.generation !== generation ||
    source.keyName !== MAIL_REAL_VETKEYS_KAT_KEY_NAME ||
    source.slot !== MAIL_REAL_VETKEYS_KAT_SLOT_ID ||
    source.suite !== MAIL_REAL_VETKEYS_KAT_SUITE
  ) {
    throw new Error(`Real vetKeys KAT ${label} public info has an invalid profile`);
  }
  return {
    canisterPrincipal: principal(
      source.canisterPrincipal,
      `real vetKeys KAT ${label} canister principal`,
    ),
    derivationInputHex: fixedHex(
      source.derivationInputHex,
      32,
      `real vetKeys KAT ${label} derivation input`,
    ),
    generation,
    keyName: MAIL_REAL_VETKEYS_KAT_KEY_NAME,
    publicFingerprintHex: fixedHex(
      source.publicFingerprintHex,
      32,
      `real vetKeys KAT ${label} public fingerprint`,
    ),
    publicKeyHex: fixedHex(
      source.publicKeyHex,
      96,
      `real vetKeys KAT ${label} public key`,
    ),
    slot: MAIL_REAL_VETKEYS_KAT_SLOT_ID,
    suite: MAIL_REAL_VETKEYS_KAT_SUITE,
  };
}

function assertExactPublicInfo(
  actual: RealVetKeysKatPublicInfo,
  expected: RealVetKeysKatPublicInfo,
  label: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Real vetKeys KAT ${label} does not match exactly`);
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const source = value as Record<string, unknown>;
  const actual = Object.keys(source);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw new Error(`Invalid ${label} fields`);
  }
  return source;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function positiveDecimal(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !DECIMAL.test(value) ||
    value === "0" ||
    value.length > 40
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function principal(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  try {
    const parsed = Principal.fromText(value).toText();
    if (parsed !== value) throw new Error("noncanonical");
    return parsed;
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error });
  }
}

function fixedHex(value: unknown, bytes: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length !== bytes * 2 ||
    !LOWER_HEX.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function fromHex(value: string, bytes: number, label: string): Uint8Array {
  fixedHex(value, bytes, label);
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export function hex(value: Uint8Array | readonly number[]): string {
  return Buffer.from(value).toString("hex");
}

function assertEqualHex(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`Real vetKeys KAT ${label} mismatch`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, sortJson(source[key])]),
  );
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read pinned-package evidence at ${path}`, { cause: error });
  }
  try {
    return record(JSON.parse(text) as unknown, `JSON file ${path}`);
  } catch (error) {
    throw new Error(`Invalid pinned-package evidence at ${path}`, { cause: error });
  }
}
