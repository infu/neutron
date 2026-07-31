import msgpack5 from "msgpack5";
import { gzipSync } from "node:zlib";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAppVersion,
  formatAppVersion,
} from "neutron-tools/src/version.js";

export const FIXTURE_ARCHIVE_IDS = [
  "vetkeys_fixture",
  "vetkeys_fixture_peer",
] as const;

export type FixtureArchiveId = (typeof FIXTURE_ARCHIVE_IDS)[number];

type JsonRecord = Record<string, unknown>;
type ArchiveBuild = {
  id: FixtureArchiveId;
  version: number;
  filename: `${FixtureArchiveId}.v${string}.neutron`;
  bytes: Uint8Array;
};

const encoder = new TextEncoder();
const msgpack = msgpack5();

/**
 * Build both install archives without ever replacing the source manifest.
 * The peer has an explicit source manifest and lock. It reuses the already
 * compiled, content-addressed backend and web assets, while its packaged
 * manifest receives only the generated backend entry hash.
 */
export async function buildFixtureArchives(
  rootDir = fileURLToPath(new URL("..", import.meta.url)),
): Promise<ArchiveBuild[]> {
  const dist = await readRawTree(path.join(rootDir, "dist"));
  // The fixtures declare no managed memory. Never let a stale generated lock
  // from an older build leak into either archive.
  dist.delete("neutron.lock.json");
  const primaryManifest = parseJson(
    required(dist, "neutron.json"),
    "dist/neutron.json",
  );
  const primarySchema = parseJson(
    required(dist, "schema.json"),
    "dist/schema.json",
  );
  assertBaseMetadata(primaryManifest, primarySchema);

  const peerManifest = parseJson(
    await readFile(path.join(rootDir, "peer", "neutron.json")),
    "peer/neutron.json",
  );
  assertPeerMetadata(peerManifest);
  assertEquivalentDeclarations(primaryManifest, peerManifest);

  const entry = requiredString(primaryManifest.entry, "compiled entry");
  const version = requiredVersion(primaryManifest.version);
  const peerVersion = requiredVersion(peerManifest.version);
  if (version !== peerVersion) {
    throw new Error("Fixture archive versions must be identical");
  }

  const primaryFiles = new Map(dist);
  const peerFiles = new Map(dist);
  peerFiles.set(
    "neutron.json",
    jsonBytes({ ...peerManifest, entry }),
  );
  peerFiles.set(
    "schema.json",
    jsonBytes({
      ...primarySchema,
      app: {
        id: "vetkeys_fixture_peer",
        name: requiredString(peerManifest.name, "peer app name"),
        version: peerVersion,
      },
    }),
  );

  return [
    buildArchive("vetkeys_fixture", version, primaryFiles),
    buildArchive("vetkeys_fixture_peer", version, peerFiles),
  ];
}

export async function writeFixtureArchives(
  rootDir = fileURLToPath(new URL("..", import.meta.url)),
): Promise<ArchiveBuild[]> {
  const builds = await buildFixtureArchives(rootDir);
  for (const build of builds) {
    const destination = path.join(rootDir, build.filename);
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, build.bytes);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    for (const entry of await readdir(rootDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.startsWith(`${build.id}.v`) &&
        entry.name.endsWith(".neutron") &&
        entry.name !== build.filename
      ) {
        await rm(path.join(rootDir, entry.name));
      }
    }
    console.log(`Writing: ${build.filename}`);
    console.log(`Size: ${build.bytes.byteLength}`);
  }
  return builds;
}

function buildArchive(
  id: FixtureArchiveId,
  version: number,
  files: ReadonlyMap<string, Uint8Array>,
): ArchiveBuild {
  const compressed: Record<string, Uint8Array> = {};
  for (const [name, contents] of [...files].sort(([left], [right]) =>
    compareNames(left, right),
  )) {
    compressed[name] = gzipSync(contents, { level: 9 });
  }
  const encoded = msgpack.encode(compressed) as unknown as Uint8Array;
  const bytes = Uint8Array.from(encoded);
  return {
    id,
    version,
    filename: `${id}.v${formatAppVersion(version)}.neutron`,
    bytes,
  };
}

async function readRawTree(root: string): Promise<Map<string, Uint8Array>> {
  const output = new Map<string, Uint8Array>();
  await visit(root, root, output);
  return output;
}

async function visit(
  directory: string,
  root: string,
  output: Map<string, Uint8Array>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareNames(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(absolute, root, output);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported dist entry ${absolute}`);
    }
    output.set(path.relative(root, absolute).split(path.sep).join("/"), await readFile(absolute));
  }
}

function assertBaseMetadata(
  manifest: JsonRecord,
  schema: JsonRecord,
): void {
  if (manifest.id !== "vetkeys_fixture") {
    throw new Error("Primary dist metadata has an unexpected app id");
  }
  const schemaApp = record(schema.app, "primary schema app");
  if (schemaApp.id !== "vetkeys_fixture") {
    throw new Error("Primary schema has an unexpected app id");
  }
}

function assertPeerMetadata(manifest: JsonRecord): void {
  if (manifest.id !== "vetkeys_fixture_peer") {
    throw new Error("Peer source metadata has an unexpected app id");
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "entry")) {
    throw new Error("Peer source manifest must not contain a generated entry");
  }
}

function assertEquivalentDeclarations(
  primary: JsonRecord,
  peer: JsonRecord,
): void {
  const primarySlot = declaredSlot(primary);
  const peerSlot = declaredSlot(peer);
  if (primarySlot !== "mailbox" || peerSlot !== "mailbox") {
    throw new Error("Both fixtures must declare exactly the mailbox slot");
  }
  for (const field of ["format", "version", "src", "func"] as const) {
    if (JSON.stringify(primary[field]) !== JSON.stringify(peer[field])) {
      throw new Error(`Fixture manifests disagree on ${field}`);
    }
  }
}

function declaredSlot(manifest: JsonRecord): string {
  const capabilities = record(manifest.capabilities, "capabilities");
  const vetkeys = record(capabilities.vetkeys, "vetkeys capability");
  if (!Array.isArray(vetkeys.slots) || vetkeys.slots.length !== 1) {
    throw new Error("Fixture manifest must declare exactly one vetKeys slot");
  }
  return requiredString(record(vetkeys.slots[0], "vetKeys slot").id, "slot id");
}

function parseJson(bytes: Uint8Array, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error });
  }
  return record(value, label);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as JsonRecord;
}

function required(
  files: ReadonlyMap<string, Uint8Array>,
  name: string,
): Uint8Array {
  const value = files.get(name);
  if (!value) throw new Error(`Missing dist/${name}`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredVersion(value: unknown): number {
  assertAppVersion(value, "Fixture package version");
  return value;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  await writeFixtureArchives();
}
