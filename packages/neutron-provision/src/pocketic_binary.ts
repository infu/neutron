import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const POCKET_IC_SERVER_VERSION = "14.0.0" as const;
export const POCKET_IC_IDLE_TTL_SECONDS = 30 * 24 * 60 * 60;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_BINARY_BYTES = 1024 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

export type PocketIcArtifact = {
  version: typeof POCKET_IC_SERVER_VERSION;
  platform: "linux" | "darwin";
  architecture: "x64" | "arm64";
  url: string;
  archiveSha256: string;
  binarySha256: string;
};

/**
 * The archive digests are published on DFINITY's v14.0.0 GitHub release.
 * The executable digests are hashes of those verified archives after gzip
 * decompression. Keeping both means a cached executable is verified on every
 * use without needing a second metadata file.
 */
export const POCKET_IC_ARTIFACTS: readonly PocketIcArtifact[] = [
  {
    version: POCKET_IC_SERVER_VERSION,
    platform: "linux",
    architecture: "x64",
    url: "https://github.com/dfinity/pocketic/releases/download/14.0.0/pocket-ic-x86_64-linux.gz",
    archiveSha256: "292c0b7fb7066c19de57bb731281f664f6af1ece0ef1462274000075b0ae8a2b",
    binarySha256: "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4",
  },
  {
    version: POCKET_IC_SERVER_VERSION,
    platform: "linux",
    architecture: "arm64",
    url: "https://github.com/dfinity/pocketic/releases/download/14.0.0/pocket-ic-arm64-linux.gz",
    archiveSha256: "60624a206ab5132a17550c901472d1462eac1fd9c735b756222be676ba707760",
    binarySha256: "27bf169bec280524bc79ca56d545c2b7fd7d9fc5214f50fc5ba2985f94332d34",
  },
  {
    version: POCKET_IC_SERVER_VERSION,
    platform: "darwin",
    architecture: "x64",
    url: "https://github.com/dfinity/pocketic/releases/download/14.0.0/pocket-ic-x86_64-darwin.gz",
    archiveSha256: "9b0b8cc8196934aa2b87aa912567ba5cc8e92ece39b10f52983c963b8e259d4c",
    binarySha256: "5033db1974c7fb02395aae78042675d428a1f4f27ce26dd2efa84bc00cbcc85b",
  },
  {
    version: POCKET_IC_SERVER_VERSION,
    platform: "darwin",
    architecture: "arm64",
    url: "https://github.com/dfinity/pocketic/releases/download/14.0.0/pocket-ic-arm64-darwin.gz",
    archiveSha256: "bf9b05bfc663856d9b5e02ed72792c34d66b85be048cb12bb286a9e842744628",
    binarySha256: "2d5d70aa4c69a4399c65be05157d4f78c5186d45424d9299a694fb6bb8e99f51",
  },
] as const;

export type ResolvedPocketIcBinary = {
  path: string;
  version: typeof POCKET_IC_SERVER_VERSION;
  sha256: string;
  artifactUrl: string;
};

export type ResolvePocketIcBinaryOptions = {
  cacheDirectory: string;
  artifact?: PocketIcArtifact;
  platform?: NodeJS.Platform;
  architecture?: string;
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>;
};

export function pocketIcArtifactForHost(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): PocketIcArtifact {
  const artifact = POCKET_IC_ARTIFACTS.find(
    (candidate) =>
      candidate.platform === platform && candidate.architecture === architecture,
  );
  if (artifact === undefined) {
    throw new Error(
      `PocketIC ${POCKET_IC_SERVER_VERSION} has no pinned artifact for ${platform}/${architecture}`,
    );
  }
  return artifact;
}

export async function resolvePocketIcBinary(
  options: ResolvePocketIcBinaryOptions,
): Promise<ResolvedPocketIcBinary> {
  const artifact =
    options.artifact ??
    pocketIcArtifactForHost(options.platform, options.architecture);
  assertValidArtifact(artifact);

  const cacheDirectory = path.resolve(options.cacheDirectory);
  await ensureRealDirectory(cacheDirectory);
  const artifactDirectory = path.join(
    cacheDirectory,
    `pocket-ic-${artifact.version}-${artifact.platform}-${artifact.architecture}`,
  );
  await ensureRealDirectory(artifactDirectory);
  const binaryPath = path.join(artifactDirectory, "pocket-ic");

  const existing = await binaryState(binaryPath, artifact.binarySha256);
  if (existing === "valid") return resolved(binaryPath, artifact);
  if (existing === "symlink") {
    throw new Error(`Refusing symlink PocketIC executable ${binaryPath}`);
  }

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(artifact.url, {
    headers: { Accept: "application/gzip, application/octet-stream" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Unable to download PocketIC ${artifact.version}: HTTP ${response.status}`,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_ARCHIVE_BYTES)
  ) {
    throw new Error("PocketIC archive has an invalid or excessive Content-Length");
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("PocketIC archive is empty or exceeds the download limit");
  }
  assertDigest(archive, artifact.archiveSha256, "PocketIC release archive");

  let executable: Buffer;
  try {
    executable = gunzipSync(archive, { maxOutputLength: MAX_BINARY_BYTES });
  } catch (error) {
    throw new Error("Unable to decompress the verified PocketIC archive", {
      cause: error,
    });
  }
  if (executable.byteLength === 0) {
    throw new Error("The verified PocketIC archive contains an empty executable");
  }
  assertDigest(executable, artifact.binarySha256, "PocketIC executable");

  const temporaryPath = `${binaryPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o700);
    await handle.writeFile(executable);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o700);
    await rename(temporaryPath, binaryPath);
    await fsyncDirectory(artifactDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  await verifyPocketIcBinary(binaryPath, artifact.binarySha256);
  return resolved(binaryPath, artifact);
}

export async function verifyPocketIcBinary(
  binaryPath: string,
  expectedSha256: string,
): Promise<void> {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("PocketIC executable SHA-256 must be lowercase hexadecimal");
  }
  const resolvedPath = path.resolve(binaryPath);
  const metadata = await lstat(resolvedPath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing symlink PocketIC executable ${resolvedPath}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`PocketIC executable is not a regular file: ${resolvedPath}`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o111) === 0) {
    throw new Error(`PocketIC executable is not executable: ${resolvedPath}`);
  }
  const actualSha256 = await sha256File(resolvedPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `PocketIC executable checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
}

export function pocketIcServerArguments(
  portFile: string,
  idleTtlSeconds = POCKET_IC_IDLE_TTL_SECONDS,
): string[] {
  if (!Number.isSafeInteger(idleTtlSeconds) || idleTtlSeconds < 60) {
    throw new Error("PocketIC idle TTL must be an integer of at least 60 seconds");
  }
  if (!path.isAbsolute(portFile)) {
    throw new Error("PocketIC port file path must be absolute");
  }
  return [
    "--ttl",
    idleTtlSeconds.toString(),
    "--port-file",
    path.normalize(portFile),
    "--log-levels",
    "error",
  ];
}

export function assertPocketIcVersionOutput(output: string): void {
  const expected = `pocket-ic-server ${POCKET_IC_SERVER_VERSION}`;
  if (output.trim() !== expected) {
    throw new Error(`Expected ${expected}, got ${JSON.stringify(output.trim())}`);
  }
}

async function binaryState(
  filename: string,
  expectedSha256: string,
): Promise<"missing" | "valid" | "invalid" | "symlink"> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
  if (metadata.isSymbolicLink()) return "symlink";
  try {
    await verifyPocketIcBinary(filename, expectedSha256);
    return "valid";
  } catch {
    return "invalid";
  }
}

async function sha256File(filename: string): Promise<string> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(filename, constants.O_RDONLY | noFollow);
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  try {
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.byteLength,
        position,
      );
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

function assertDigest(
  bytes: Uint8Array,
  expectedSha256: string,
  label: string,
): void {
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${label} checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
}

function assertValidArtifact(artifact: PocketIcArtifact): void {
  if (artifact.version !== POCKET_IC_SERVER_VERSION) {
    throw new Error(
      `PocketIC artifact must be pinned to ${POCKET_IC_SERVER_VERSION}`,
    );
  }
  if (!SHA256_PATTERN.test(artifact.archiveSha256)) {
    throw new Error("PocketIC archive SHA-256 must be lowercase hexadecimal");
  }
  if (!SHA256_PATTERN.test(artifact.binarySha256)) {
    throw new Error("PocketIC executable SHA-256 must be lowercase hexadecimal");
  }
  const url = new URL(artifact.url);
  if (url.protocol !== "https:") {
    throw new Error("PocketIC artifact URL must use HTTPS");
  }
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`PocketIC cache path must be a real directory: ${directory}`);
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function resolved(
  binaryPath: string,
  artifact: PocketIcArtifact,
): ResolvedPocketIcBinary {
  return {
    path: binaryPath,
    version: artifact.version,
    sha256: artifact.binarySha256,
    artifactUrl: artifact.url,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
