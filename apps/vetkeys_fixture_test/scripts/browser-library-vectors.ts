import {
  DerivedPublicKey,
  EncryptedVetKey,
  TransportSecretKey,
} from "@dfinity/vetkeys";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const BROWSER_LIBRARY_VECTOR_FILE =
  "test/vectors/vetkeys-browser-current-previous-v1.json";
export const BROWSER_LIBRARY_VECTOR_SCHEMA =
  "neutron.vetkeys.browser-library-vectors";
export const BROWSER_LIBRARY_VECTOR_VERSION = 1;

export const PINNED_VETKEYS_BROWSER_LIBRARY = Object.freeze({
  name: "@dfinity/vetkeys",
  version: "0.4.0",
  npmIntegrity:
    "sha512-MLa5UvseEOVB6HgcKYtIDOZc6De0tdRm61dZlmAVKKqjnZuXoUJqypDbMe30EnofH0JMjvGQP2jGvxGRKC6nGQ==",
});

// Updated only when the canonical checked-in vector is intentionally replaced.
export const PINNED_BROWSER_LIBRARY_VECTOR_SHA256 =
  "4a238085dd0fcf6d8222fbee00e5b69709aeec631480772d48d28869b18595ad";

const VECTOR_PROFILE = Object.freeze({
  appId: "mail",
  canisterPrincipal: "efadq-gl777-77774-aaaba-cai",
  environment: "local",
  keyName: "test_key_1",
  slotId: "mailbox",
  slotUid: "2",
  suite: "bls12_381_g2",
});
const VECTOR_GENERATIONS = Object.freeze({ current: "2", previous: "1" });
const VECTOR_TRANSPORT_SECRET_HEX =
  "15fbb76fd0a215cbedfb6200f9b791ad75db9252e3c89140a19a4ab62f8507c0";
const VECTOR_TRANSPORT_PUBLIC_HEX =
  "883ee92337ff75a80c7b53ba7024261ac53f3347c3c42e91baac43308335d7f0e0c617a07621ab5ce135dd9d0df67ade";
const MAX_VECTOR_BYTES = 64 * 1024;
const LOWER_HEX = /^[0-9a-f]+$/u;

export type BrowserLibraryGenerationVector = {
  decryptedVetKeyHex: string;
  derivationInputHex: string;
  encryptedVetKeyHex: string;
  generation: string;
  publicKeyHex: string;
  status: "current" | "previous";
};

export type BrowserLibraryVector = {
  capture: {
    appId: "mail";
    canisterPrincipal: "efadq-gl777-77774-aaaba-cai";
    environment: "local";
    keyName: "test_key_1";
    library: {
      name: "@dfinity/vetkeys";
      npmIntegrity: string;
      version: "0.4.0";
    };
    slotId: "mailbox";
    slotUid: "2";
    suite: "bls12_381_g2";
  };
  generations: {
    current: BrowserLibraryGenerationVector;
    previous: BrowserLibraryGenerationVector;
  };
  schema: "neutron.vetkeys.browser-library-vectors";
  transport: {
    publicKeyHex: string;
    secretKeyHex: string;
  };
  version: 1;
};

/** Parse a closed schema and require the one canonical JSON representation. */
export function parseBrowserLibraryVector(text: string): BrowserLibraryVector {
  if (Buffer.byteLength(text, "utf8") > MAX_VECTOR_BYTES) {
    throw new Error("vetKeys browser-library vector exceeds 64 KiB");
  }
  if (text.startsWith("\uFEFF")) {
    throw new Error("vetKeys browser-library vector must not use a BOM");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("vetKeys browser-library vector is not valid JSON", {
      cause: error,
    });
  }
  const vector = parseVector(decoded);
  if (text !== encodeBrowserLibraryVector(vector)) {
    throw new Error("vetKeys browser-library vector is not canonical JSON");
  }
  return vector;
}

export function encodeBrowserLibraryVector(
  vector: BrowserLibraryVector,
): string {
  return `${JSON.stringify(sortJson(vector), null, 2)}\n`;
}

/**
 * Decrypt and verify both frozen management-canister responses with the exact
 * official browser package. This function performs no network or actor call.
 */
export function verifyBrowserLibraryVector(vector: BrowserLibraryVector): void {
  const checked = parseVector(vector);
  const transportSecretBytes = fromHex(
    checked.transport.secretKeyHex,
    32,
    "transport secret key",
  );
  const transport = TransportSecretKey.deserialize(transportSecretBytes);
  assertHex(
    hex(transport.serialize()),
    VECTOR_TRANSPORT_SECRET_HEX,
    "serialized transport secret key",
  );
  assertHex(
    hex(transport.publicKeyBytes()),
    checked.transport.publicKeyHex,
    "transport public key",
  );

  verifyGeneration(checked.generations.current, "current");
  verifyGeneration(checked.generations.previous, "previous");

  const current = checked.generations.current;
  const previous = checked.generations.previous;
  for (const [label, left, right] of [
    ["generation", current.generation, previous.generation],
    ["derived public key", current.publicKeyHex, previous.publicKeyHex],
    ["derivation input", current.derivationInputHex, previous.derivationInputHex],
    ["encrypted VetKey", current.encryptedVetKeyHex, previous.encryptedVetKeyHex],
    ["decrypted VetKey", current.decryptedVetKeyHex, previous.decryptedVetKeyHex],
  ] as const) {
    if (left === right) {
      throw new Error(`Current and previous ${label} must differ`);
    }
  }
}

/** Prove both the dependency pin and the exact checked-in vector bytes. */
export async function assertPinnedBrowserLibraryEvidence(
  fixtureRoot: string,
  vectorText: string,
): Promise<void> {
  const packageJson = await readJson(resolve(fixtureRoot, "package.json"));
  const dependencies = record(packageJson.dependencies, "fixture dependencies");
  if (
    dependencies[PINNED_VETKEYS_BROWSER_LIBRARY.name] !==
    PINNED_VETKEYS_BROWSER_LIBRARY.version
  ) {
    throw new Error("Fixture must use the exact pinned vetKeys browser package");
  }

  const lock = await readJson(resolve(fixtureRoot, "../../package-lock.json"));
  const packages = record(lock.packages, "workspace lock packages");
  const fixture = record(
    packages["apps/vetkeys_fixture_test"],
    "workspace fixture lock entry",
  );
  const lockedDependencies = record(
    fixture.dependencies,
    "workspace fixture dependencies",
  );
  if (
    lockedDependencies[PINNED_VETKEYS_BROWSER_LIBRARY.name] !==
    PINNED_VETKEYS_BROWSER_LIBRARY.version
  ) {
    throw new Error("Workspace lock does not preserve the fixture vetKeys pin");
  }
  const installedLock = record(
    packages["node_modules/@dfinity/vetkeys"],
    "workspace vetKeys package",
  );
  if (
    installedLock.version !== PINNED_VETKEYS_BROWSER_LIBRARY.version ||
    installedLock.integrity !== PINNED_VETKEYS_BROWSER_LIBRARY.npmIntegrity
  ) {
    throw new Error("Workspace lock has the wrong vetKeys version or integrity");
  }

  const installedPackage = await readJson(
    resolve(fixtureRoot, "../../node_modules/@dfinity/vetkeys/package.json"),
  );
  if (installedPackage.version !== PINNED_VETKEYS_BROWSER_LIBRARY.version) {
    throw new Error("Installed vetKeys browser package does not match the pin");
  }

  const digest = createHash("sha256").update(vectorText, "utf8").digest("hex");
  if (digest !== PINNED_BROWSER_LIBRARY_VECTOR_SHA256) {
    throw new Error("Checked-in vetKeys browser-library vector digest changed");
  }
}

function verifyGeneration(
  vector: BrowserLibraryGenerationVector,
  status: "current" | "previous",
): void {
  const transport = TransportSecretKey.deserialize(
    fromHex(VECTOR_TRANSPORT_SECRET_HEX, 32, "transport secret key"),
  );
  const publicKey = DerivedPublicKey.deserialize(
    fromHex(vector.publicKeyHex, 96, `${status} derived public key`),
  );
  const encrypted = EncryptedVetKey.deserialize(
    fromHex(vector.encryptedVetKeyHex, 192, `${status} encrypted VetKey`),
  );
  const derivationInput = fromHex(
    vector.derivationInputHex,
    32,
    `${status} derivation input`,
  );
  const decrypted = encrypted.decryptAndVerify(
    transport,
    publicKey,
    derivationInput,
  );
  assertHex(
    hex(decrypted.serialize()),
    vector.decryptedVetKeyHex,
    `${status} decrypted VetKey`,
  );
}

function parseVector(value: unknown): BrowserLibraryVector {
  const source = exactRecord(
    value,
    ["capture", "generations", "schema", "transport", "version"],
    "vetKeys browser-library vector",
  );
  if (
    source.schema !== BROWSER_LIBRARY_VECTOR_SCHEMA ||
    source.version !== BROWSER_LIBRARY_VECTOR_VERSION
  ) {
    throw new Error("Unsupported vetKeys browser-library vector schema/version");
  }

  const capture = exactRecord(
    source.capture,
    [
      "appId",
      "canisterPrincipal",
      "environment",
      "keyName",
      "library",
      "slotId",
      "slotUid",
      "suite",
    ],
    "vetKeys browser-library capture",
  );
  const library = exactRecord(
    capture.library,
    ["name", "npmIntegrity", "version"],
    "vetKeys browser-library capture package",
  );
  for (const [field, expected] of Object.entries(VECTOR_PROFILE)) {
    if (capture[field] !== expected) {
      throw new Error(`vetKeys browser-library capture has the wrong ${field}`);
    }
  }
  if (
    library.name !== PINNED_VETKEYS_BROWSER_LIBRARY.name ||
    library.version !== PINNED_VETKEYS_BROWSER_LIBRARY.version ||
    library.npmIntegrity !== PINNED_VETKEYS_BROWSER_LIBRARY.npmIntegrity
  ) {
    throw new Error("vetKeys browser-library capture package does not match the pin");
  }

  const transport = exactRecord(
    source.transport,
    ["publicKeyHex", "secretKeyHex"],
    "vetKeys browser-library transport",
  );
  const publicKeyHex = fixedHex(
    transport.publicKeyHex,
    48,
    "transport public key",
  );
  const secretKeyHex = fixedHex(
    transport.secretKeyHex,
    32,
    "transport secret key",
  );
  if (
    publicKeyHex !== VECTOR_TRANSPORT_PUBLIC_HEX ||
    secretKeyHex !== VECTOR_TRANSPORT_SECRET_HEX
  ) {
    throw new Error("vetKeys browser-library vector changed its frozen transport");
  }

  const generations = exactRecord(
    source.generations,
    ["current", "previous"],
    "vetKeys browser-library generations",
  );
  return {
    capture: {
      ...VECTOR_PROFILE,
      library: { ...PINNED_VETKEYS_BROWSER_LIBRARY },
    },
    generations: {
      current: parseGeneration(generations.current, "current"),
      previous: parseGeneration(generations.previous, "previous"),
    },
    schema: BROWSER_LIBRARY_VECTOR_SCHEMA,
    transport: { publicKeyHex, secretKeyHex },
    version: BROWSER_LIBRARY_VECTOR_VERSION,
  };
}

function parseGeneration(
  value: unknown,
  status: "current" | "previous",
): BrowserLibraryGenerationVector {
  const source = exactRecord(
    value,
    [
      "decryptedVetKeyHex",
      "derivationInputHex",
      "encryptedVetKeyHex",
      "generation",
      "publicKeyHex",
      "status",
    ],
    `${status} browser-library generation`,
  );
  if (
    source.status !== status ||
    source.generation !== VECTOR_GENERATIONS[status]
  ) {
    throw new Error(`Invalid ${status} browser-library generation binding`);
  }
  return {
    decryptedVetKeyHex: fixedHex(
      source.decryptedVetKeyHex,
      48,
      `${status} decrypted VetKey`,
    ),
    derivationInputHex: fixedHex(
      source.derivationInputHex,
      32,
      `${status} derivation input`,
    ),
    encryptedVetKeyHex: fixedHex(
      source.encryptedVetKeyHex,
      192,
      `${status} encrypted VetKey`,
    ),
    generation: VECTOR_GENERATIONS[status],
    publicKeyHex: fixedHex(
      source.publicKeyHex,
      96,
      `${status} derived public key`,
    ),
    status,
  };
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

function fromHex(value: string, bytes: number, label: string): Uint8Array {
  fixedHex(value, bytes, label);
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function hex(value: Uint8Array | readonly number[]): string {
  return Buffer.from(value).toString("hex");
}

function assertHex(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`vetKeys browser-library ${label} mismatch`);
  }
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
    throw new Error(`Cannot read vetKeys pin evidence at ${path}`, {
      cause: error,
    });
  }
  try {
    return record(JSON.parse(text) as unknown, `JSON file ${path}`);
  } catch (error) {
    throw new Error(`Invalid vetKeys pin evidence at ${path}`, { cause: error });
  }
}
