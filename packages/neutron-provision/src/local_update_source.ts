import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  Actor,
  type ActorMethod,
  type ActorSubclass,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { sha256, sha256Hex, toHex } from "./artifact.ts";
import { LocalProvisionClient } from "./local_client.ts";

const UPDATE_SOURCE_IDENTITY_DOMAIN = "neutron-pocketic-update-source-v1";
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_WASM_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_FILES = 256;
const ASSET_CHUNK_BYTES = 1_900_000;
const LIST_PAGE_SIZE = 100n;

export const LOCAL_UPDATE_SOURCE_ASSETS_DIRECTORY = path.resolve(
  import.meta.dir,
  "../../../support/update-source/assets",
);

export type LocalUpdateSourceWasmArtifact = {
  release: string;
  name: string;
  url: string;
  archiveSha256: string;
  moduleSha256: string;
};

/** The exact asset canister selected by support/update-source/icp.yaml. */
export const UPDATE_SOURCE_WASM_ARTIFACT: LocalUpdateSourceWasmArtifact = {
  release: "dfinity-sdk-0.32.0",
  name: "assetstorage.wasm.gz",
  url: "https://github.com/dfinity/sdk/releases/download/0.32.0/assetstorage.wasm.gz",
  archiveSha256:
    "04e565b3425fe7510ee16b02adcfe3f01abc9a2725c82a21cb08969241debd62",
  moduleSha256:
    "763ae81b8e134067a1d622e1f2c561d60a0a538b5cc95cad804097f8ea6fa8c0",
};

export type PreparedLocalUpdateSourceWasm = {
  wasm: Uint8Array;
  moduleHashHex: string;
};

export type LocalUpdateSourceAsset = {
  key: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: Uint8Array;
  sha256Hex: string;
};

export type LocalUpdateSourceConnection = {
  gatewayUrl: string;
  expectedRootKeyBase64: string;
  defaultEffectiveCanisterIdBase64: string;
};

export type EnsureLocalUpdateSourceOptions = LocalUpdateSourceConnection & {
  cacheDirectory: string;
  existingCanisterId?: string;
  assetsDirectory?: string;
  /** Called immediately after a new dynamic ID is allocated. */
  recordCanisterId?: (canisterId: string) => Promise<void>;
  logger?: Pick<Console, "log">;
};

export type LocalUpdateSourceClient = {
  createCanister(): Promise<string>;
  ensureInstalled(
    canisterId: string,
    artifact: PreparedLocalUpdateSourceWasm,
  ): Promise<void>;
  synchronizeAssets(
    canisterId: string,
    assets: readonly LocalUpdateSourceAsset[],
  ): Promise<boolean>;
  verifyHealth(
    canisterId: string,
    asset: LocalUpdateSourceAsset,
  ): Promise<void>;
};

export type EnsureLocalUpdateSourceDependencies = {
  createClient?: typeof createLocalUpdateSourceClient;
  resolveWasm?: typeof resolveLocalUpdateSourceWasm;
  loadAssets?: typeof loadLocalUpdateSourceAssets;
};

/**
 * Installs and seeds the one provision-owned local update source. The returned
 * principal belongs in runtime.fixtures.update_source and must be passed back
 * as existingCanisterId on later serves.
 */
export async function ensureLocalUpdateSource(
  options: EnsureLocalUpdateSourceOptions,
  dependencies: EnsureLocalUpdateSourceDependencies = {},
): Promise<string> {
  const logger = options.logger ?? console;
  const [artifact, assets] = await Promise.all([
    (dependencies.resolveWasm ?? resolveLocalUpdateSourceWasm)({
      cacheDirectory: options.cacheDirectory,
      logger,
    }),
    (dependencies.loadAssets ?? loadLocalUpdateSourceAssets)(
      options.assetsDirectory ?? LOCAL_UPDATE_SOURCE_ASSETS_DIRECTORY,
    ),
  ]);
  const health = assets.find(({ key }) => key === "/health.txt");
  if (health === undefined) {
    throw new Error("Local update-source assets must contain /health.txt");
  }

  const client = await (
    dependencies.createClient ?? createLocalUpdateSourceClient
  )({
    gatewayUrl: options.gatewayUrl,
    expectedRootKeyBase64: options.expectedRootKeyBase64,
    defaultEffectiveCanisterIdBase64:
      options.defaultEffectiveCanisterIdBase64,
    logger,
  });
  let canisterId: string;
  if (options.existingCanisterId === undefined) {
    canisterId = canonicalCanisterId(await client.createCanister());
    await options.recordCanisterId?.(canisterId);
  } else {
    canisterId = canonicalCanisterId(options.existingCanisterId);
  }

  await client.ensureInstalled(canisterId, artifact);
  const changed = await client.synchronizeAssets(canisterId, assets);
  await client.verifyHealth(canisterId, health);
  logger.log(
    `Local update source ${canisterId} is ready${changed ? " (assets synchronized)" : ""}`,
  );
  return canisterId;
}

export async function createLocalUpdateSourceClient({
  gatewayUrl,
  expectedRootKeyBase64,
  defaultEffectiveCanisterIdBase64,
  logger = console,
  fetcher = fetch,
}: LocalUpdateSourceConnection & {
  logger?: Pick<Console, "log">;
  fetcher?: typeof fetch;
}): Promise<LocalUpdateSourceClient> {
  const identity = localUpdateSourceIdentity();
  const provision = await LocalProvisionClient.create({
    gatewayUrl,
    identity,
    defaultEffectiveCanisterIdBase64,
    expectedRootKeyBase64,
    logger,
  });
  return new DirectLocalUpdateSourceClient({
    provision,
    gatewayUrl,
    identity,
    fetcher,
  });
}

class DirectLocalUpdateSourceClient implements LocalUpdateSourceClient {
  readonly #provision: LocalProvisionClient;
  readonly #gatewayUrl: string;
  readonly #identity: Ed25519KeyIdentity;
  readonly #fetcher: typeof fetch;

  constructor({
    provision,
    gatewayUrl,
    identity,
    fetcher,
  }: {
    provision: LocalProvisionClient;
    gatewayUrl: string;
    identity: Ed25519KeyIdentity;
    fetcher: typeof fetch;
  }) {
    this.#provision = provision;
    this.#gatewayUrl = normalizeGateway(gatewayUrl);
    this.#identity = identity;
    this.#fetcher = fetcher;
  }

  createCanister(): Promise<string> {
    return this.#provision.createCanister();
  }

  async ensureInstalled(
    canisterId: string,
    artifact: PreparedLocalUpdateSourceWasm,
  ): Promise<void> {
    if (sha256Hex(artifact.wasm) !== artifact.moduleHashHex) {
      throw new Error("Prepared local update-source Wasm hash is inconsistent");
    }
    await this.#provision.ensurePinnedModule({
      canisterId,
      wasm: artifact.wasm,
      arg: encodeAssetCanisterInitArgs(this.#identity.getPrincipal()),
      label: "local update-source asset canister",
    });
  }

  synchronizeAssets(
    canisterId: string,
    assets: readonly LocalUpdateSourceAsset[],
  ): Promise<boolean> {
    const actor = Actor.createActor<LocalAssetCanisterActor>(assetCanisterIdl, {
      agent: this.#provision.agent,
      canisterId: Principal.fromText(canisterId),
    });
    return synchronizeLocalUpdateSourceAssets(actor, assets);
  }

  async verifyHealth(
    canisterId: string,
    asset: LocalUpdateSourceAsset,
  ): Promise<void> {
    const response = await this.#fetcher(
      localCanisterAssetUrl(this.#gatewayUrl, canisterId, asset.key),
      { redirect: "manual", cache: "no-store" },
    );
    if (response.status !== 200) {
      throw new Error(
        `Local update source ${asset.key} returned HTTP ${response.status}`,
      );
    }
    const certificate = response.headers.get("ic-certificate");
    if (
      certificate === null ||
      !certificate.includes("certificate=:") ||
      !certificate.includes("tree=:")
    ) {
      throw new Error("Local update-source health response is not certified");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];
    if (contentType?.trim().toLowerCase() !== asset.contentType) {
      throw new Error(
        `Local update-source health content type is ${contentType ?? "missing"}, expected ${asset.contentType}`,
      );
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength !== asset.bytes.byteLength || toHex(sha256(body)) !== asset.sha256Hex) {
      throw new Error("Local update-source health response bytes do not match the seed");
    }
  }
}

export async function resolveLocalUpdateSourceWasm({
  cacheDirectory,
  logger = console,
  fetcher = fetch,
  artifact = UPDATE_SOURCE_WASM_ARTIFACT,
}: {
  cacheDirectory: string;
  logger?: Pick<Console, "log">;
  fetcher?: typeof fetch;
  artifact?: LocalUpdateSourceWasmArtifact;
}): Promise<PreparedLocalUpdateSourceWasm> {
  assertWasmArtifact(artifact);
  const directory = path.join(path.resolve(cacheDirectory), artifact.release);
  await ensureRealDirectory(path.resolve(cacheDirectory));
  await ensureRealDirectory(directory);
  const archivePath = path.join(directory, artifact.name);
  let archive = await readVerifiedArchiveIfPresent(
    archivePath,
    artifact.archiveSha256,
  );
  if (archive === null) {
    logger.log(`Downloading pinned ${artifact.name}`);
    const response = await fetcher(artifact.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(
        `Unable to download ${artifact.name}: HTTP ${response.status}`,
      );
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      Number.isFinite(Number(declaredLength)) &&
      Number(declaredLength) > MAX_ARCHIVE_BYTES
    ) {
      throw new Error(`${artifact.name} exceeds the archive size limit`);
    }
    archive = new Uint8Array(await response.arrayBuffer());
    if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`${artifact.name} has an invalid archive size`);
    }
    assertDigest(archive, artifact.archiveSha256, `${artifact.name} archive`);
    await atomicWriteFile(archivePath, archive);
  }
  const wasm = new Uint8Array(
    gunzipSync(archive, { maxOutputLength: MAX_WASM_BYTES }),
  );
  if (wasm.byteLength === 0) {
    throw new Error(`${artifact.name} decompressed to an empty module`);
  }
  assertDigest(wasm, artifact.moduleSha256, `${artifact.name} module`);
  return { wasm, moduleHashHex: artifact.moduleSha256 };
}

export async function loadLocalUpdateSourceAssets(
  assetsDirectory: string,
): Promise<LocalUpdateSourceAsset[]> {
  const root = path.resolve(assetsDirectory);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Update-source asset root must be a real directory: ${root}`);
  }
  const files: string[] = [];
  await collectAssetFiles(root, root, files);
  if (files.length === 0) {
    throw new Error("Local update-source asset directory is empty");
  }
  if (files.length > MAX_ASSET_FILES) {
    throw new Error(`Local update source has more than ${MAX_ASSET_FILES} assets`);
  }
  const assets: LocalUpdateSourceAsset[] = [];
  let totalBytes = 0;
  for (const filename of files.sort()) {
    const bytes = await readRegularFile(filename, MAX_ASSET_BYTES);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
      throw new Error("Local update-source assets exceed their total size limit");
    }
    const relative = path.relative(root, filename);
    const key = `/${relative.split(path.sep).join("/")}`;
    const digest = sha256(bytes);
    assets.push({
      key,
      contentType: assetContentType(filename),
      bytes,
      sha256: digest,
      sha256Hex: toHex(digest),
    });
  }
  return assets;
}

export async function synchronizeLocalUpdateSourceAssets(
  actor: LocalAssetCanisterActor,
  assets: readonly LocalUpdateSourceAsset[],
): Promise<boolean> {
  assertUniqueAssets(assets);
  const existing = new Map(
    (await listAllAssets(actor)).map((asset) => [asset.key, asset]),
  );
  const desired = new Map(assets.map((asset) => [asset.key, asset]));
  const removed = [...existing.keys()]
    .filter((key) => !desired.has(key))
    .sort();
  const changed = assets.filter(
    (asset) => !sameAsset(existing.get(asset.key), asset),
  );
  if (removed.length === 0 && changed.length === 0) return false;

  const { batch_id: batchId } = await actor.create_batch({});
  let committed = false;
  try {
    const uploaded = new Map<string, bigint[]>();
    for (const asset of changed) {
      const chunks: bigint[] = [];
      if (asset.bytes.byteLength === 0) {
        chunks.push(
          (await actor.create_chunk({ batch_id: batchId, content: asset.bytes }))
            .chunk_id,
        );
      } else {
        for (
          let offset = 0;
          offset < asset.bytes.byteLength;
          offset += ASSET_CHUNK_BYTES
        ) {
          chunks.push(
            (
              await actor.create_chunk({
                batch_id: batchId,
                content: asset.bytes.slice(offset, offset + ASSET_CHUNK_BYTES),
              })
            ).chunk_id,
          );
        }
      }
      uploaded.set(asset.key, chunks);
    }

    const operations: LocalAssetBatchOperation[] = removed.map((key) => ({
      DeleteAsset: { key },
    }));
    for (const asset of changed) {
      if (existing.has(asset.key)) {
        operations.push({ DeleteAsset: { key: asset.key } });
      }
      operations.push(
        {
          CreateAsset: {
            key: asset.key,
            content_type: asset.contentType,
            headers: [],
            allow_raw_access: [false],
            max_age: [],
            enable_aliasing: [false],
          },
        },
        {
          SetAssetContent: {
            key: asset.key,
            sha256: [asset.sha256],
            chunk_ids: uploaded.get(asset.key)!,
            content_encoding: "identity",
            last_chunk: [],
          },
        },
      );
    }
    await actor.commit_batch({ batch_id: batchId, operations });
    committed = true;
    return true;
  } finally {
    if (!committed) {
      await actor.delete_batch({ batch_id: batchId }).catch(() => undefined);
    }
  }
}

export function localUpdateSourceIdentity(): Ed25519KeyIdentity {
  const seed = createHash("sha256")
    .update(UPDATE_SOURCE_IDENTITY_DOMAIN)
    .digest();
  return Ed25519KeyIdentity.generate(new Uint8Array(seed));
}

export function encodeAssetCanisterInitArgs(
  controller: Principal,
): Uint8Array {
  const permissions = IDL.Record({
    prepare: IDL.Vec(IDL.Principal),
    commit: IDL.Vec(IDL.Principal),
    manage_permissions: IDL.Vec(IDL.Principal),
  });
  const argumentsType = IDL.Opt(
    IDL.Variant({
      Init: IDL.Record({ set_permissions: IDL.Opt(permissions) }),
      Upgrade: IDL.Record({ set_permissions: IDL.Opt(permissions) }),
    }),
  );
  const setPermissions = {
    prepare: [controller],
    commit: [controller],
    manage_permissions: [controller],
  };
  return new Uint8Array(
    IDL.encode([argumentsType], [[{ Init: { set_permissions: [setPermissions] } }]]),
  );
}

type LocalAssetEncoding = {
  content_encoding: string;
  sha256: [] | [Uint8Array];
  length: bigint;
};

type LocalAssetMetadata = {
  key: string;
  content_type: string;
  encodings: LocalAssetEncoding[];
};

type LocalAssetBatchOperation =
  | { DeleteAsset: { key: string } }
  | {
      CreateAsset: {
        key: string;
        content_type: string;
        headers: [] | [Array<[string, string]>];
        allow_raw_access: [] | [boolean];
        max_age: [] | [bigint];
        enable_aliasing: [] | [boolean];
      };
    }
  | {
      SetAssetContent: {
        key: string;
        sha256: [] | [Uint8Array];
        chunk_ids: bigint[];
        content_encoding: string;
        last_chunk: [] | [Uint8Array];
      };
    };

export type LocalAssetCanisterActor = {
  list: ActorMethod<
    [{ start: [] | [bigint]; length: [] | [bigint] }],
    LocalAssetMetadata[]
  >;
  create_batch: ActorMethod<[Record<string, never>], { batch_id: bigint }>;
  create_chunk: ActorMethod<
    [{ batch_id: bigint; content: Uint8Array }],
    { chunk_id: bigint }
  >;
  commit_batch: ActorMethod<
    [{ batch_id: bigint; operations: LocalAssetBatchOperation[] }],
    undefined
  >;
  delete_batch: ActorMethod<[{ batch_id: bigint }], undefined>;
};

const assetCanisterIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const header = IDL.Tuple(IDL.Text, IDL.Text);
  const createAsset = IDL.Record({
    key: IDL.Text,
    content_type: IDL.Text,
    headers: IDL.Opt(IDL.Vec(header)),
    allow_raw_access: IDL.Opt(IDL.Bool),
    max_age: IDL.Opt(IDL.Nat64),
    enable_aliasing: IDL.Opt(IDL.Bool),
  });
  const setAssetContent = IDL.Record({
    key: IDL.Text,
    sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
    chunk_ids: IDL.Vec(IDL.Nat),
    content_encoding: IDL.Text,
    last_chunk: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const operation = IDL.Variant({
    DeleteAsset: IDL.Record({ key: IDL.Text }),
    CreateAsset: createAsset,
    SetAssetContent: setAssetContent,
  });
  const encoding = IDL.Record({
    content_encoding: IDL.Text,
    sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
    length: IDL.Nat,
    modified: IDL.Int,
  });
  const asset = IDL.Record({
    key: IDL.Text,
    content_type: IDL.Text,
    encodings: IDL.Vec(encoding),
    max_age: IDL.Opt(IDL.Nat64),
    headers: IDL.Opt(IDL.Vec(header)),
    allow_raw_access: IDL.Opt(IDL.Bool),
    is_aliased: IDL.Opt(IDL.Bool),
  });
  return IDL.Service({
    list: IDL.Func(
      [IDL.Record({ start: IDL.Opt(IDL.Nat), length: IDL.Opt(IDL.Nat) })],
      [IDL.Vec(asset)],
      ["query"],
    ),
    create_batch: IDL.Func(
      [IDL.Record({})],
      [IDL.Record({ batch_id: IDL.Nat })],
      [],
    ),
    create_chunk: IDL.Func(
      [IDL.Record({ batch_id: IDL.Nat, content: IDL.Vec(IDL.Nat8) })],
      [IDL.Record({ chunk_id: IDL.Nat })],
      [],
    ),
    commit_batch: IDL.Func(
      [IDL.Record({ batch_id: IDL.Nat, operations: IDL.Vec(operation) })],
      [],
      [],
    ),
    delete_batch: IDL.Func(
      [IDL.Record({ batch_id: IDL.Nat })],
      [],
      [],
    ),
  });
};

async function listAllAssets(
  actor: LocalAssetCanisterActor,
): Promise<LocalAssetMetadata[]> {
  const assets: LocalAssetMetadata[] = [];
  for (let start = 0n; ; start += LIST_PAGE_SIZE) {
    const page = await actor.list({ start: [start], length: [LIST_PAGE_SIZE] });
    if (page.length === 0) break;
    assets.push(...page);
    if (page.length < Number(LIST_PAGE_SIZE)) break;
    if (assets.length > MAX_ASSET_FILES * 2) {
      throw new Error("Local update source returned too many assets");
    }
  }
  return assets.sort((left, right) => left.key.localeCompare(right.key));
}

function sameAsset(
  existing: LocalAssetMetadata | undefined,
  desired: LocalUpdateSourceAsset,
): boolean {
  if (existing === undefined || existing.content_type !== desired.contentType) {
    return false;
  }
  if (existing.encodings.length !== 1) return false;
  const encoding = existing.encodings[0]!;
  return (
    encoding.content_encoding === "identity" &&
    encoding.length === BigInt(desired.bytes.byteLength) &&
    encoding.sha256.length === 1 &&
    toHex(encoding.sha256[0]!) === desired.sha256Hex
  );
}

function assertUniqueAssets(assets: readonly LocalUpdateSourceAsset[]): void {
  const keys = new Set<string>();
  for (const asset of assets) {
    if (!asset.key.startsWith("/") || asset.key.includes("\\")) {
      throw new Error(`Invalid local update-source asset key ${asset.key}`);
    }
    if (keys.has(asset.key)) {
      throw new Error(`Duplicate local update-source asset key ${asset.key}`);
    }
    keys.add(asset.key);
    if (asset.sha256Hex !== toHex(asset.sha256)) {
      throw new Error(`Asset ${asset.key} has inconsistent SHA-256 metadata`);
    }
  }
}

async function collectAssetFiles(
  root: string,
  directory: string,
  files: string[],
): Promise<void> {
  for (const name of (await readdir(directory)).sort()) {
    const filename = path.join(directory, name);
    const relative = path.relative(root, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Update-source asset escapes its root: ${filename}`);
    }
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing symlink update-source asset: ${filename}`);
    }
    if (metadata.isDirectory()) {
      await collectAssetFiles(root, filename, files);
    } else if (metadata.isFile()) {
      files.push(filename);
    } else {
      throw new Error(`Update-source asset is not a regular file: ${filename}`);
    }
  }
}

async function readVerifiedArchiveIfPresent(
  filename: string,
  expectedSha256: string,
): Promise<Uint8Array | null> {
  try {
    const bytes = await readRegularFile(filename, MAX_ARCHIVE_BYTES);
    return sha256Hex(bytes) === expectedSha256 ? bytes : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRegularFile(
  filename: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(filename, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new Error(`File is not a bounded regular file: ${filename}`);
    }
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function atomicWriteFile(
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Update-source cache path must be a real directory: ${directory}`);
  }
}

function assertWasmArtifact(artifact: LocalUpdateSourceWasmArtifact): void {
  if (artifact.release !== "dfinity-sdk-0.32.0") {
    throw new Error("Local update source must use DFINITY SDK 0.32.0");
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.archiveSha256)) {
    throw new Error("Update-source archive SHA-256 must be lowercase hexadecimal");
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.moduleSha256)) {
    throw new Error("Update-source module SHA-256 must be lowercase hexadecimal");
  }
  const url = new URL(artifact.url);
  if (url.protocol !== "https:") {
    throw new Error("Update-source artifact URL must use HTTPS");
  }
}

function assertDigest(
  bytes: Uint8Array,
  expectedSha256: string,
  label: string,
): void {
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(
      `${label} checksum mismatch: expected ${expectedSha256}, got ${actual}`,
    );
  }
}

function localCanisterAssetUrl(
  gatewayUrl: string,
  canisterId: string,
  key: string,
): URL {
  const url = new URL(normalizeGateway(gatewayUrl));
  url.hostname = `${canonicalCanisterId(canisterId)}.${url.hostname}`;
  url.pathname = key;
  url.search = "";
  url.hash = "";
  return url;
}

function normalizeGateway(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Local update source requires a loopback HTTP gateway");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function canonicalCanisterId(value: string): string {
  const canonical = Principal.fromText(value).toText();
  if (canonical !== value) {
    throw new Error("Local update-source canister ID must be canonical");
  }
  return canonical;
}

function assetContentType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
