import { REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS } from "neutron-compiler/src/install.js";
import { getRuntimeDeployment } from "../runtime_deployment.ts";

export const URL_PACKAGE_MAX_BYTES =
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS.maxRawBytes;
export const URL_PACKAGE_MAX_CHARACTERS = 4_096;

export type FetchPackageUrlOptions = {
  fetch?: typeof fetch;
  maxBytes?: number;
  signal?: AbortSignal;
};

export async function fetchPackageFromUrl(
  rawUrl: string,
  options: FetchPackageUrlOptions = {},
): Promise<Uint8Array> {
  const allowLoopbackHttp = getRuntimeDeployment().allowLoopbackHttp;
  const packageUrl = parsePackageUrl(rawUrl, { allowLoopbackHttp });
  const fetchPackage = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? URL_PACKAGE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("URL package byte limit is invalid");
  }

  let response: Response;
  try {
    response = await fetchPackage(packageUrl.href, {
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/octet-stream, application/x-neutron, */*;q=0.1",
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
      "Could not download this URL. Check the address, CORS settings, and that it does not redirect, or use File.",
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new Error(`Package download failed (HTTP ${response.status})`);
  }
  if (response.url) {
    const responseUrl = parsePackageUrl(response.url, { allowLoopbackHttp });
    if (responseUrl.href !== packageUrl.href) {
      throw new Error("The package URL redirected. Use the final package URL.");
    }
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength.trim())) {
    const bytes = Number(declaredLength);
    if (Number.isSafeInteger(bytes) && bytes > maxBytes) {
      throw packageTooLarge(maxBytes);
    }
  }

  const body = response.body;
  if (!body) throw new Error("Package download returned no body");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Package download returned invalid bytes");
      }
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read has already failed closed.
        }
        throw packageTooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (isAbortError(error) || isPackageUrlError(error)) throw error;
    throw new Error("Package download was interrupted", { cause: error });
  } finally {
    reader.releaseLock();
  }

  if (total === 0) throw new Error("The downloaded package is empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function parsePackageUrl(
  rawUrl: string,
  {
    allowLoopbackHttp = false,
  }: {
    allowLoopbackHttp?: boolean;
  } = {},
): URL {
  const value = rawUrl.trim();
  if (!value || value.length > URL_PACKAGE_MAX_CHARACTERS) {
    throw new Error("Enter a valid HTTPS package URL");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error("Enter a valid HTTPS package URL", { cause });
  }
  if (url.username || url.password) {
    throw new Error("Package URLs cannot contain a username or password");
  }
  if (url.hash) {
    throw new Error("Package URLs cannot contain a fragment");
  }
  if (url.protocol === "https:") return url;
  if (
    url.protocol === "http:" &&
    allowLoopbackHttp &&
    isLoopbackHostname(url.hostname)
  ) {
    return url;
  }
  throw new Error("Use an HTTPS package URL");
}

/**
 * App- and agent-originated offers are intentionally narrower than the
 * owner's manual URL field: the path must identify a `.neutron` package.
 * Query parameters may select a build, but cannot stand in for the suffix.
 */
export function parseOfferedPackageUrl(
  rawUrl: string,
  {
    allowLoopbackHttp = getRuntimeDeployment().allowLoopbackHttp,
  }: {
    allowLoopbackHttp?: boolean;
  } = {},
): URL {
  const url = parsePackageUrl(rawUrl, { allowLoopbackHttp });
  if (!url.pathname.endsWith(".neutron")) {
    throw new Error("Install offers must use a URL ending in .neutron");
  }
  return url;
}

export function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException)
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized) ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

function packageTooLarge(maxBytes: number): Error {
  const mebibytes = maxBytes / (1024 * 1024);
  const label = Number.isInteger(mebibytes)
    ? `${mebibytes} MiB`
    : `${maxBytes} bytes`;
  return new Error(`Package is larger than the ${label} URL-install limit`);
}

function isPackageUrlError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("Package is larger than") ||
      error.message === "Package download returned invalid bytes")
  );
}
