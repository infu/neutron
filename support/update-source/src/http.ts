import { createHash } from "node:crypto";
import { normalizeUpdateSourcePrincipal } from "neutron-tools/src/schema.ts";
import {
  REPOSITORY_LIMITS,
  parseRepositoryReleaseRecord,
  type RepositoryReleaseRecord,
} from "neutron-tools/src/repository.ts";
import { canisterOrigin } from "neutron-tools/src/runtime.ts";
import {
  PACKAGE_CACHE_CONTROL,
  PACKAGE_CONTENT_TYPE,
  RELEASE_CACHE_CONTROL,
  sha256Hex,
} from "./model.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export type CertifiedFetch = typeof fetch;

export type ReadAssetResult =
  | { status: "missing" }
  | {
      status: "found";
      bytes: Uint8Array;
      etag: string;
      response: Response;
    };

export function updateSourceOrigin(options: {
  canisterId: string;
}): string {
  const canisterId = normalizeUpdateSourcePrincipal(options.canisterId);
  return canisterOrigin({
    canisterId,
    local: false,
  });
}

export async function readReleaseAsset(options: {
  origin: string;
  path: string;
  fetch?: CertifiedFetch;
  timeoutMs?: number;
}): Promise<
  | { status: "missing" }
  | {
      status: "found";
      record: RepositoryReleaseRecord;
      bytes: Uint8Array;
      digest: string;
    }
> {
  const result = await readCertifiedAsset({
    ...options,
    maximumBytes: REPOSITORY_LIMITS.releaseJsonBytes,
    expectedContentType: "application/json",
    expectedCacheControl: RELEASE_CACHE_CONTROL,
    accept: "application/json",
    cache: "no-cache",
  });
  if (result.status === "missing") return result;
  const record = parseRepositoryReleaseRecord(result.bytes);
  const digest = sha256Hex(result.bytes);
  assertEtag(result.etag, digest, options.path);
  return { status: "found", record, bytes: result.bytes, digest };
}

export async function readPackageAsset(options: {
  origin: string;
  path: string;
  expectedDigest: string;
  expectedSize: number;
  fetch?: CertifiedFetch;
  timeoutMs?: number;
}): Promise<ReadAssetResult> {
  const result = await readCertifiedAsset({
    ...options,
    maximumBytes: REPOSITORY_LIMITS.packageBytes,
    expectedContentType: PACKAGE_CONTENT_TYPE,
    expectedCacheControl: PACKAGE_CACHE_CONTROL,
    accept: PACKAGE_CONTENT_TYPE,
    cache: "default",
    requireIdentityEncoding: true,
  });
  if (result.status === "missing") return result;
  if (result.bytes.byteLength !== options.expectedSize) {
    throw new Error(
      `Asset '${options.path}' has ${result.bytes.byteLength} bytes; expected ${options.expectedSize}`,
    );
  }
  const digest = sha256Hex(result.bytes);
  if (digest !== options.expectedDigest) {
    throw new Error(
      `Asset '${options.path}' has digest ${digest}; expected ${options.expectedDigest}`,
    );
  }
  assertEtag(result.etag, options.expectedDigest, options.path);
  return result;
}

export async function readCertifiedAsset(options: {
  origin: string;
  path: string;
  maximumBytes: number;
  expectedContentType: string;
  expectedCacheControl: string;
  accept: string;
  cache: RequestCache;
  requireIdentityEncoding?: boolean;
  fetch?: CertifiedFetch;
  timeoutMs?: number;
}): Promise<ReadAssetResult> {
  const origin = new URL(options.origin).origin;
  const url = new URL(options.path, `${origin}/`);
  if (url.origin !== origin || url.pathname !== options.path || url.search) {
    throw new Error(`Asset path '${options.path}' escapes the update source`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Certified asset request timed out")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: options.cache,
      headers: {
        Accept: options.accept,
        "Accept-Encoding": "identity",
      },
      signal: controller.signal,
    });
    if (response.url && new URL(response.url).origin !== origin) {
      throw new Error(`Asset '${options.path}' returned from the wrong origin`);
    }
    assertGatewayCertificationV2(response, options.path);
    if (response.status === 404) return { status: "missing" };
    if (response.status !== 200) {
      throw new Error(`Asset '${options.path}' returned HTTP ${response.status}`);
    }
    assertHeaderValue(
      response,
      "content-type",
      options.expectedContentType,
      options.path,
      true,
    );
    assertCacheControl(response, options.expectedCacheControl, options.path);
    assertHeaderValue(
      response,
      "access-control-allow-origin",
      "*",
      options.path,
    );
    assertHeaderValue(
      response,
      "x-content-type-options",
      "nosniff",
      options.path,
    );
    if (options.requireIdentityEncoding) {
      const encoding = response.headers.get("content-encoding");
      if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        throw new Error(`Asset '${options.path}' is not identity encoded`);
      }
    }
    const etag = response.headers.get("etag");
    if (!etag) throw new Error(`Asset '${options.path}' has no ETag`);
    const bytes = await readBoundedBody(response, options.maximumBytes);
    return { status: "found", bytes, etag, response };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Public `*.icp0.io` and local ICP gateways perform the cryptographic check.
 * Requiring the complete v2 proof envelope here prevents accidentally using a
 * raw/unverified response surface and catches gateways configured without
 * response verification.
 */
export function assertGatewayCertificationV2(
  response: Response,
  path: string,
): void {
  const certificate = response.headers.get("ic-certificate");
  const expression = response.headers.get("ic-certificateexpression");
  if (
    !certificate ||
    !/(?:^|[,;]\s*)certificate\s*=\s*:[A-Za-z0-9+/=_-]+:/i.test(certificate) ||
    !/(?:^|[,;]\s*)tree\s*=\s*:[A-Za-z0-9+/=_-]+:/i.test(certificate) ||
    !/(?:^|[,;]\s*)expr_path\s*=\s*:[A-Za-z0-9+/=_-]+:/i.test(certificate) ||
    !/(?:^|[,;]\s*)version\s*=\s*2(?:\s*[,;]|\s*$)/i.test(certificate) ||
    !expression?.trim() ||
    /\bno_certification\b/.test(expression)
  ) {
    throw new Error(`Asset '${path}' is missing a certified HTTP v2 proof`);
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new Error(`Certified asset exceeds the ${maximumBytes}-byte limit`);
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`Certified asset exceeds the ${maximumBytes}-byte limit`);
    }
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("body limit exceeded");
        throw new Error(`Certified asset exceeds the ${maximumBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertCacheControl(
  response: Response,
  expected: string,
  path: string,
): void {
  const actual = response.headers.get("cache-control");
  const expectedTokens = headerTokens(expected);
  const actualTokens = headerTokens(actual ?? "");
  for (const token of expectedTokens) {
    if (!actualTokens.has(token)) {
      throw new Error(`Asset '${path}' has the wrong Cache-Control policy`);
    }
  }
}

function headerTokens(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((token) => token.trim().toLowerCase().replace(/\s*=\s*/g, "="))
      .filter(Boolean),
  );
}

function assertHeaderValue(
  response: Response,
  name: string,
  expected: string,
  path: string,
  ignoreParameters = false,
): void {
  const raw = response.headers.get(name);
  const actual = ignoreParameters ? raw?.split(";", 1)[0] : raw;
  if (actual?.trim().toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Asset '${path}' has the wrong ${name} header`);
  }
}

function assertEtag(etag: string, digest: string, path: string): void {
  const normalized = etag.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  if (normalized.toLowerCase() !== digest) {
    throw new Error(`Asset '${path}' has an ETag that does not match its bytes`);
  }
}

export function streamingSha256(chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}
