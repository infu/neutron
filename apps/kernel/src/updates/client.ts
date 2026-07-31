import { hashContent } from "neutron-tools/src/hash.js";
import {
  parseRepositoryReleaseRecord,
  repositoryPackagePath,
  repositoryReleasePath,
  type RepositoryReleaseRecord,
} from "neutron-tools/repository";
import {
  canisterIdFromUrl,
  canisterOrigin,
} from "neutron-tools/src/runtime.js";
import { normalizeUpdateSourcePrincipal } from "neutron-tools/src/schema.js";
import {
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
} from "neutron-compiler/src/install.js";
import {
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_RELEASE_MAX_BYTES,
  UpdateCheckError,
  type FetchedRelease,
} from "./model.ts";
import { getRuntimeDeployment } from "../runtime_deployment.ts";

export type UpdateHttpClientOptions = Readonly<{
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export async function fetchUpdateRelease(
  source: string,
  appId: string,
  options: UpdateHttpClientOptions = {},
): Promise<FetchedRelease | null> {
  const origin = sourceOrigin(source);
  const url = new URL(repositoryReleasePath(appId), origin);
  const response = await boundedGet(url, {
    ...options,
    accept: "application/json",
    cache: "no-cache",
    maxBytes: UPDATE_RELEASE_MAX_BYTES,
    notFound: true,
    validateResponse: (response) =>
      assertContentType(response, "application/json"),
  });
  if (response === null) return null;
  let record: RepositoryReleaseRecord;
  try {
    record = parseRepositoryReleaseRecord(response.bytes);
  } catch (cause) {
    throw new UpdateCheckError(
      "malformed_record",
      "The update source returned an invalid release record.",
      { cause },
    );
  }
  if (record.id !== appId) {
    throw new UpdateCheckError(
      "wrong_id",
      "The update source returned a release for a different app.",
    );
  }
  return Object.freeze({
    source,
    record,
    releaseDigest: hashContent(response.bytes),
  });
}

export async function fetchUpdatePackage(
  source: string,
  release: RepositoryReleaseRecord,
  options: UpdateHttpClientOptions = {},
): Promise<Uint8Array> {
  const origin = sourceOrigin(source);
  const url = new URL(repositoryPackagePath(release.sha256), origin);
  const response = await boundedGet(url, {
    ...options,
    accept:
      "application/vnd.neutron.package, application/octet-stream, application/x-neutron",
    cache: "default",
    maxBytes: REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS.maxRawBytes,
    notFound: false,
    validateResponse: assertPackageResponse,
  });
  if (response === null) {
    throw new UpdateCheckError("unavailable", "The update package was not found.");
  }
  if (response.bytes.byteLength !== release.size) {
    throw new UpdateCheckError(
      "malformed_record",
      "The update package size does not match its release record.",
    );
  }
  if (hashContent(response.bytes) !== release.sha256) {
    throw new UpdateCheckError(
      "malformed_record",
      "The update package digest does not match its release record.",
    );
  }
  return response.bytes;
}

type BoundedGetOptions = UpdateHttpClientOptions &
  Readonly<{
    accept: string;
    cache: RequestCache;
    maxBytes: number;
    notFound: boolean;
    validateResponse?: (response: Response) => void;
  }>;

async function boundedGet(
  url: URL,
  options: BoundedGetOptions,
): Promise<{ bytes: Uint8Array; response: Response } | null> {
  const fetchValue = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Update-check timeout is invalid");
  }
  const timeoutController = new AbortController();
  let timedOut = false;
  const onAbort = () => timeoutController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetchValue(url.href, {
      cache: options.cache,
      credentials: "omit",
      headers: { accept: options.accept },
      method: "GET",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: timeoutController.signal,
    });
  } catch (cause) {
    if (options.signal?.aborted) throw abortError();
    if (timedOut) {
      throw new UpdateCheckError(
        "timed_out",
        "The update source took too long to respond.",
        { cause },
      );
    }
    throw new UpdateCheckError(
      "unavailable",
      "The update source is unavailable.",
      { cause },
    );
  } finally {
    globalThis.clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  assertGatewayCertificationV2(response);
  if (response.status === 404 && options.notFound) return null;
  if (!response.ok) {
    throw new UpdateCheckError(
      "unavailable",
      `The update source returned HTTP ${response.status}.`,
    );
  }
  if (response.redirected) {
    throw new UpdateCheckError(
      "redirected",
      "The update source redirected the request.",
    );
  }
  if (response.url) {
    let finalUrl: URL;
    try {
      finalUrl = new URL(response.url);
    } catch (cause) {
      throw new UpdateCheckError(
        "wrong_origin",
        "The update response has an invalid origin.",
        { cause },
      );
    }
    if (finalUrl.href !== url.href) {
      throw new UpdateCheckError(
        "wrong_origin",
        "The update response came from a different origin.",
      );
    }
  }

  options.validateResponse?.(response);

  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared.trim())) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > options.maxBytes) {
      throw new UpdateCheckError(
        "too_large",
        "The update response exceeds Neutron's size limit.",
      );
    }
  }
  if (options.signal?.aborted) throw abortError();
  timedOut = false;
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const bodyTimer = globalThis.setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  try {
    const bytes = await readBoundedBody(
      response,
      options.maxBytes,
      timeoutController.signal,
    );
    if (options.signal?.aborted) throw abortError();
    if (timedOut) {
      throw new UpdateCheckError(
        "timed_out",
        "The update source took too long to respond.",
      );
    }
    return { bytes, response };
  } catch (cause) {
    if (options.signal?.aborted) throw abortError();
    if (timedOut) {
      throw new UpdateCheckError(
        "timed_out",
        "The update source took too long to respond.",
        { cause },
      );
    }
    throw cause;
  } finally {
    globalThis.clearTimeout(bodyTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The fixed non-raw ICP gateway verifies HTTP certification before exposing a
 * response. Browsers do not consistently expose the proof headers through
 * CORS, so their absence in JavaScript is not evidence of an uncertified
 * response. When a gateway does expose either proof header, require the whole
 * v2 envelope; an incomplete visible envelope still fails closed.
 */
function assertGatewayCertificationV2(response: Response): void {
  const certificate = response.headers.get("ic-certificate");
  const expression = response.headers.get("ic-certificateexpression");
  if (!certificate && !expression) return;
  if (
    !certificate ||
    !/(?:^|[,;]\s*)certificate\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(
      certificate,
    ) ||
    !/(?:^|[,;]\s*)tree\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(certificate) ||
    !/(?:^|[,;]\s*)expr_path\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(
      certificate,
    ) ||
    !/(?:^|[,;]\s*)version\s*=\s*2(?:\s*[,;]|\s*$)/iu.test(certificate) ||
    !expression?.trim() ||
    /\bno_certification\b/iu.test(expression)
  ) {
    throw new UpdateCheckError(
      "uncertified",
      "The update source response is not certified.",
    );
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    throw new UpdateCheckError(
      "unavailable",
      "The update source returned no response body.",
    );
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new UpdateCheckError(
          "unavailable",
          "The update source returned invalid bytes.",
        );
      }
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read already failed closed.
        }
        throw new UpdateCheckError(
          "too_large",
          "The update response exceeds Neutron's size limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (total === 0) {
    throw new UpdateCheckError(
      "unavailable",
      "The update source returned an empty response.",
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertContentType(response: Response, expected: string): void {
  const contentType =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== expected) {
    throw new UpdateCheckError(
      "wrong_content_type",
      "The update source returned the wrong content type.",
    );
  }
}

function assertPackageContentType(response: Response): void {
  const contentType =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    contentType !== "application/vnd.neutron.package" &&
    contentType !== "application/octet-stream" &&
    contentType !== "application/x-neutron"
  ) {
    throw new UpdateCheckError(
      "wrong_content_type",
      "The update source returned the wrong package content type.",
    );
  }
}

function assertPackageResponse(response: Response): void {
  assertPackageContentType(response);
  const contentEncoding =
    response.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (contentEncoding && contentEncoding !== "identity") {
    throw new UpdateCheckError(
      "wrong_content_type",
      "The update package must be served without content transformation.",
    );
  }
}

function sourceOrigin(source: string): string {
  const canisterId = normalizeUpdateSourcePrincipal(
    source,
    "update source canister",
  );
  const deployment = getRuntimeDeployment();
  if (
    deployment.updateSourceOrigin !== null &&
    canisterIdFromUrl(deployment.updateSourceOrigin) === canisterId
  ) {
    return deployment.updateSourceOrigin;
  }
  return canisterOrigin({
    canisterId,
    local: deployment.local,
    ...(deployment.localHost ? { localHost: deployment.localHost } : {}),
  });
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Update check cancelled", "AbortError");
  }
  const error = new Error("Update check cancelled");
  error.name = "AbortError";
  return error;
}
