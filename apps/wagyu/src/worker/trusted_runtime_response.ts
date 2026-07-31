import { readBoundedResponseBody } from "../transport/bounded_response.ts";

export const MAX_TRUSTED_RUNTIME_CONFIG_BYTES = 4_096;

/**
 * Bounds the kernel-authored runtime file before UTF-8 or JSON decoding.
 * Content-Length is only an early rejection hint; the stream remains bounded
 * when the header is absent or dishonest.
 */
export async function readTrustedRuntimeConfigBytes(
  response: Response,
): Promise<Uint8Array> {
  const declaredLength = optionalContentLength(response.headers);
  if (
    declaredLength !== null &&
    (declaredLength === 0 ||
      declaredLength > MAX_TRUSTED_RUNTIME_CONFIG_BYTES)
  ) {
    throw invalidRuntimeConfigSize();
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponseBody(
      response,
      MAX_TRUSTED_RUNTIME_CONFIG_BYTES,
      "Trusted runtime configuration",
    );
  } catch {
    throw invalidRuntimeConfigSize();
  }
  if (bytes.byteLength === 0) {
    throw invalidRuntimeConfigSize();
  }
  return bytes;
}

function optionalContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw invalidRuntimeConfigSize();
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw invalidRuntimeConfigSize();
  return value;
}

function invalidRuntimeConfigSize(): Error {
  return new Error("Trusted runtime configuration has an invalid size");
}
