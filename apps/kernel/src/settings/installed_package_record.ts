import { readPackageManifest, type AppRegistry } from "neutron-compiler/src/install.js";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { assertSafeRelativeAssetPath } from "neutron-tools/src/schema.js";
import {
  NEUTRON_APP_SOURCE_MEDIA_TYPE,
  NEUTRON_APP_SOURCE_TRANSPORT_LIMITS,
  NEUTRON_PACKAGE_RECORD_LIMITS,
  NEUTRON_PACKAGE_RECORD_PATH,
  assertNeutronPackageRecordManifestContext,
  discoverNeutronPackageRecordEmbeddedPaths,
  isNeutronPackageArchiveOnlyPath,
  neutronAppSourceArchiveFilename,
  parseNeutronPackageRecordStructure,
  type NeutronPackageHttpsSourceOfferV1,
  type NeutronPackageRecordV1,
} from "neutron-tools/package_record.js";

const MIB = 1024 * 1024;

/** Keep user-initiated source verification within a predictable browser budget. */
export const HTTPS_SOURCE_BROWSER_DOWNLOAD_MAX_BYTES =
  NEUTRON_APP_SOURCE_TRANSPORT_LIMITS.compressedBytes;

export type InstalledPackageRecordInspection =
  | Readonly<{ status: "loading" }>
  | Readonly<{
      status: "legacy";
      recordPath: string;
    }>
  | Readonly<{
      status: "invalid";
      recordPath: string;
      message: string;
    }>
  | Readonly<{
      status: "unavailable";
      recordPath: string;
      message: string;
    }>
  | Readonly<{
      status: "declared";
      assetBasePath: string;
      recordPath: string;
      /** Exact bounded sidecar bytes whose digest and parsed value follow. */
      recordBytes: Uint8Array;
      recordSha256: string;
      record: NeutronPackageRecordV1;
    }>;

export type InstalledPackageRecordInventory = Readonly<
  Record<string, InstalledPackageRecordInspection>
>;

export type InstalledPackageAssetReader = (
  path: string,
  maximumBytes: number,
) => Promise<Uint8Array | undefined>;

/**
 * Digest claim for an embedded file that is expected to be an installed
 * static asset. Reserved archive-only legal/source paths are rejected by the
 * installed-asset readers below.
 */
export type InstalledPackageEmbeddedFileClaim = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
}>;

export type InstalledPackageDownloadEnvironment = Readonly<{
  createObjectUrl(content: Uint8Array): string;
  triggerDownload(objectUrl: string, filename: string): void;
  revokeObjectUrl(objectUrl: string): void;
}>;

export type HttpsSourceOfferFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type HttpsSourceOfferFetchOptions = Readonly<{
  fetch?: HttpsSourceOfferFetcher;
  maxBytes?: number;
  signal?: AbortSignal;
}>;

/**
 * Inspect every installed package independently. One corrupt or temporarily
 * unreadable app record must not hide the status of the other installed apps.
 */
export async function loadInstalledPackageRecordInventory(
  apps: AppRegistry,
  readAsset: InstalledPackageAssetReader = readInstalledPackageAsset,
): Promise<InstalledPackageRecordInventory> {
  const entries = await Promise.all(
    Object.entries(apps).map(async ([id, entry]) => {
      const inspection = await loadInstalledPackageRecord(
        { id, version: entry.version },
        readAsset,
      );
      return [id, inspection] as const;
    }),
  );
  return Object.freeze(Object.fromEntries(entries));
}

export async function loadInstalledPackageRecord(
  expected: Readonly<{ id: string; version: number }>,
  readAsset: InstalledPackageAssetReader = readInstalledPackageAsset,
): Promise<InstalledPackageRecordInspection> {
  const assetBasePath = installedPackageAssetBasePath(expected.id);
  const recordPath = `${assetBasePath}${NEUTRON_PACKAGE_RECORD_PATH}`;
  let recordContent: Uint8Array | undefined;
  try {
    recordContent = await readAsset(
      recordPath,
      NEUTRON_PACKAGE_RECORD_LIMITS.jsonBytes,
    );
  } catch (error) {
    return Object.freeze({
      status: "unavailable" as const,
      recordPath,
      message: errorMessage(error),
    });
  }
  if (recordContent === undefined) {
    return Object.freeze({ status: "legacy" as const, recordPath });
  }

  let record: NeutronPackageRecordV1;
  let manifestPath: string;
  try {
    record = parseNeutronPackageRecordStructure(recordContent);
    const manifestPaths = discoverNeutronPackageRecordEmbeddedPaths(
      recordContent,
      { include: ["manifest"] },
    );
    if (manifestPaths.length !== 1 || manifestPaths[0] !== "neutron.json") {
      throw new Error("Package record did not declare exactly neutron.json");
    }
    manifestPath = manifestPaths[0];
  } catch (error) {
    return invalidInspection(recordPath, error);
  }

  let manifestContent: Uint8Array | undefined;
  try {
    manifestContent = await readAsset(
      `${assetBasePath}${manifestPath}`,
      NEUTRON_PACKAGE_RECORD_LIMITS.jsonBytes * 4,
    );
  } catch (error) {
    return Object.freeze({
      status: "unavailable" as const,
      recordPath,
      message: errorMessage(error),
    });
  }
  if (manifestContent === undefined) {
    return invalidInspection(
      recordPath,
      new Error(`Referenced package asset ${manifestPath} was not found`),
    );
  }
  const files = Object.freeze({ [manifestPath]: manifestContent });

  try {
    const manifest = readPackageManifest(files);
    if (manifest.id !== expected.id) {
      throw new Error(
        `Installed neutron.json id ${manifest.id} does not match registry id ${expected.id}`,
      );
    }
    if (manifest.version !== expected.version) {
      throw new Error(
        `Installed neutron.json version ${manifest.version} does not match registry version ${expected.version}`,
      );
    }
    assertNeutronPackageRecordManifestContext(record, {
      files,
      manifest,
    });
    return Object.freeze({
      status: "declared" as const,
      assetBasePath,
      recordPath,
      recordBytes: recordContent,
      recordSha256: hashContent(recordContent),
      record,
    });
  } catch (error) {
    return invalidInspection(recordPath, error);
  }
}

export function installedPackageAssetBasePath(appId: string): string {
  if (!isValidAppId(appId)) {
    throw new Error(`Invalid installed app id ${String(appId)}`);
  }
  return appId === "kernel" ? "/pkg/" : `/app/${appId}/pkg/`;
}

/**
 * User-initiated only. Read one declared installed file under its exact byte
 * ceiling, then verify both length and digest before returning any bytes. The
 * package-only legal and source material is deliberately unavailable here.
 */
export async function fetchAndVerifyInstalledPackageFile(
  assetBasePath: string,
  file: InstalledPackageEmbeddedFileClaim,
  readAsset: InstalledPackageAssetReader = readInstalledPackageAsset,
): Promise<Uint8Array> {
  assertInstalledAssetBasePath(assetBasePath);
  assertSafeRelativeAssetPath(file.path, "embedded package file path");
  if (isNeutronPackageArchiveOnlyPath(file.path)) {
    throw new Error(
      "This legal or source material is retained only in the original package archive and is not installed as a public asset",
    );
  }
  if (/[\s%?#]/u.test(file.path)) {
    throw new Error("Embedded package file path is HTTP-ambiguous");
  }
  if (
    typeof file.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(file.sha256)
  ) {
    throw new Error("Embedded package file SHA-256 is invalid");
  }
  if (
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 1 ||
    file.bytes > NEUTRON_PACKAGE_RECORD_LIMITS.embeddedSourceBytes
  ) {
    throw new Error("Embedded package file byte length is invalid");
  }

  const installedPath = `${assetBasePath}${file.path}`;
  const content = await readAsset(installedPath, file.bytes);
  if (content === undefined) {
    throw new Error(`Embedded package file ${file.path} was not found`);
  }
  if (content.byteLength !== file.bytes) {
    throw new Error(
      `Embedded package file ${file.path} has ${content.byteLength} bytes; expected ${file.bytes}`,
    );
  }
  const digest = hashContent(content);
  if (digest !== file.sha256) {
    throw new Error(
      `Embedded package file ${file.path} SHA-256 does not match its package record`,
    );
  }
  return content;
}

/**
 * Fetch, verify, and only then create an inert Blob download. No package bytes
 * are navigated to or interpreted as same-origin HTML.
 */
export async function downloadAndVerifyInstalledPackageFile({
  assetBasePath,
  environment = browserDownloadEnvironment,
  file,
  readAsset = readInstalledPackageAsset,
}: Readonly<{
  assetBasePath: string;
  environment?: InstalledPackageDownloadEnvironment;
  file: InstalledPackageEmbeddedFileClaim;
  readAsset?: InstalledPackageAssetReader;
}>): Promise<void> {
  const content = await fetchAndVerifyInstalledPackageFile(
    assetBasePath,
    file,
    readAsset,
  );
  const objectUrl = environment.createObjectUrl(content);
  try {
    environment.triggerDownload(objectUrl, downloadFilename(file.path));
  } finally {
    environment.revokeObjectUrl(objectUrl);
  }
}

/**
 * User-initiated only. Fetch an HTTPS source offer without credentials,
 * redirects, or referrer leakage, then verify its exact length and digest.
 */
export async function fetchAndVerifyHttpsSourceOffer(
  source: NeutronPackageHttpsSourceOfferV1,
  options: HttpsSourceOfferFetchOptions = {},
): Promise<Uint8Array> {
  const sourceUrl = parseHttpsSourceOfferUrl(source.url);
  if (!/^[a-f0-9]{64}$/u.test(source.sha256)) {
    throw new Error("HTTPS source offer SHA-256 is invalid");
  }
  if (
    !Number.isSafeInteger(source.bytes) ||
    source.bytes < 1 ||
    source.bytes > NEUTRON_PACKAGE_RECORD_LIMITS.declaredSourceBytes
  ) {
    throw new Error("HTTPS source offer byte length is invalid");
  }
  const maxBytes =
    options.maxBytes ?? HTTPS_SOURCE_BROWSER_DOWNLOAD_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("HTTPS source download byte limit is invalid");
  }
  if (source.bytes > maxBytes) {
    throw new Error(
      `Source offer is larger than the ${formatByteLimit(maxBytes)} in-browser verification limit`,
    );
  }

  const fetchSource = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchSource(sourceUrl.href, {
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: `${NEUTRON_APP_SOURCE_MEDIA_TYPE}, application/octet-stream;q=0.9, */*;q=0.1`,
      },
      method: "GET",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(
      "Could not download the source offer. Check its availability and CORS settings; redirects are not accepted.",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(`Source-offer download failed (HTTP ${response.status})`);
  }
  if (response.redirected) {
    throw new Error("The source offer redirected; use its final immutable URL");
  }
  if (response.url) {
    const responseUrl = parseHttpsSourceOfferUrl(response.url);
    if (responseUrl.href !== sourceUrl.href) {
      throw new Error("The source offer redirected; use its final immutable URL");
    }
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding !== "identity") {
    throw new Error(
      "The source offer must return its exact archive bytes without HTTP content encoding",
    );
  }

  const content = await readBoundedResponse(
    response,
    "HTTPS source offer",
    source.bytes,
  );
  if (content.byteLength !== source.bytes) {
    throw new Error(
      `HTTPS source offer has ${content.byteLength} bytes; expected ${source.bytes}`,
    );
  }
  const digest = hashContent(content);
  if (digest !== source.sha256) {
    throw new Error(
      "HTTPS source offer SHA-256 does not match its package record",
    );
  }
  return content;
}

/** Verify first, then expose the inert source bytes as a browser download. */
export async function downloadAndVerifyHttpsSourceOffer({
  environment = browserDownloadEnvironment,
  fetch: fetchSource,
  maxBytes,
  signal,
  source,
}: Readonly<{
  environment?: InstalledPackageDownloadEnvironment;
  fetch?: HttpsSourceOfferFetcher;
  maxBytes?: number;
  signal?: AbortSignal;
  source: NeutronPackageHttpsSourceOfferV1;
}>): Promise<void> {
  const content = await fetchAndVerifyHttpsSourceOffer(source, {
    ...(fetchSource ? { fetch: fetchSource } : {}),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(signal ? { signal } : {}),
  });
  const objectUrl = environment.createObjectUrl(content);
  try {
    environment.triggerDownload(
      objectUrl,
      neutronAppSourceArchiveFilename(source.sha256),
    );
  } finally {
    environment.revokeObjectUrl(objectUrl);
  }
}

async function readInstalledPackageAsset(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array | undefined> {
  if (
    !path.startsWith("/") ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1
  ) {
    throw new Error("Invalid installed package asset request");
  }
  const response = await fetch(path);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Could not fetch ${path}: HTTP ${response.status}`);
  }

  return readBoundedResponse(response, path, maximumBytes);
}

async function readBoundedResponse(
  response: Response,
  label: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  const contentEncoding = response.headers.get("content-encoding");
  if (
    contentLength !== null &&
    (contentEncoding === null || contentEncoding === "identity")
  ) {
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > maximumBytes
    ) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte read limit`);
    }
  }

  if (!response.body) {
    const content = new Uint8Array(await response.arrayBuffer());
    if (content.byteLength > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte read limit`);
    }
    return content;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read has already failed closed.
        }
        throw new Error(`${label} exceeds the ${maximumBytes}-byte read limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function parseHttpsSourceOfferUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error("HTTPS source offer URL is invalid", { cause });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "HTTPS source offer URL must use HTTPS without credentials, query, or fragment",
    );
  }
  return url;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

function formatByteLimit(bytes: number): string {
  const mebibytes = bytes / MIB;
  return Number.isInteger(mebibytes) ? `${mebibytes} MiB` : `${bytes} bytes`;
}

const browserDownloadEnvironment: InstalledPackageDownloadEnvironment =
  Object.freeze({
    createObjectUrl(content: Uint8Array): string {
      const bytes = content.slice().buffer;
      return URL.createObjectURL(
        new Blob([bytes], { type: "application/octet-stream" }),
      );
    },
    triggerDownload(objectUrl: string, filename: string): void {
      const anchor = document.createElement("a");
      anchor.download = filename;
      anchor.href = objectUrl;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
    },
    revokeObjectUrl(objectUrl: string): void {
      URL.revokeObjectURL(objectUrl);
    },
  });

function assertInstalledAssetBasePath(value: string): void {
  if (value === "/pkg/") return;
  const match = /^\/app\/([^/]+)\/pkg\/$/u.exec(value);
  if (!match || !isValidAppId(match[1])) {
    throw new Error("Invalid installed package asset base path");
  }
}

function downloadFilename(path: string): string {
  const filename = path.split("/").at(-1);
  if (!filename) throw new Error("Embedded package file has no filename");
  return filename;
}

function invalidInspection(
  recordPath: string,
  error: unknown,
): InstalledPackageRecordInspection {
  return Object.freeze({
    status: "invalid" as const,
    recordPath,
    message: errorMessage(error),
  });
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Errors are rendered as React text, never markup. Keep the trusted surface
  // concise even when a lower layer includes a long app-authored value.
  const normalized = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  return Array.from(normalized).slice(0, 500).join("") || "Unknown error";
}
