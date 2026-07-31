import { chromium } from "@playwright/test";
import { Principal } from "@dfinity/principal";
import { serve } from "bun";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

export const CERTIFIED_ASSETS_BROWSER_CORS_SCHEMA =
  "neutron.kernel.certified-assets-browser-cors.v1" as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const POCKET_IC_GATEWAY_EXPOSED_HEADERS =
  "accept-ranges,content-length,content-range,x-request-id,x-ic-canister-id";
const MAX_HEADER_VALUE_BYTES = 64 * 1024;
const ISOLATED_GATEWAY_IP = "127.0.0.2";
const ISOLATED_GATEWAY_PORT = 8000;
const CANISTER_HOST_SUFFIX = ".localhost";

export type PortableCorsExpectation = Readonly<{
  /** A portable Certified Assets GET on an isolated PocketIC HTTP gateway. */
  url: string;
  status: 200;
  body_bytes: number;
  body_sha256: string;
  content_digest: string;
  etag: string;
  certificate_expression: string;
}>;

type ExactBytes = Readonly<{
  bytes: number;
  sha256: string;
}>;

export type CertifiedAssetsBrowserCorsEvidence = Readonly<{
  schema: typeof CERTIFIED_ASSETS_BROWSER_CORS_SCHEMA;
  engine: Readonly<{
    name: "chromium";
    version: string;
  }>;
  request: Readonly<{
    harness_origin: string;
    target_origin: string;
    url: string;
    mode: "cors";
    credentials: "omit";
    origin_header_exact: true;
    remote_address: Readonly<{
      ip: typeof ISOLATED_GATEWAY_IP;
      port: typeof ISOLATED_GATEWAY_PORT;
    }>;
  }>;
  response: Readonly<{
    status: 200;
    body: ExactBytes;
    headers: readonly Readonly<{
      name: string;
      raw: ExactBytes;
      browser: ExactBytes | null;
      disposition: "visible_exactly" | "hidden";
    }>[];
    cors_control_headers_hidden: true;
  }>;
}>;

type BrowserFetchResult =
  | Readonly<{
      ok: true;
      status: number;
      body_bytes: number;
      body_sha256: string;
      headers: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      ok: false;
      error: string;
    }>;

/**
 * Execute the portable Certified Assets CORS boundary in a real Chromium
 * renderer. The page and PocketIC gateway are different loopback origins.
 *
 * The network transcript proves that the target emitted the fixed headers.
 * PocketIC's gateway deliberately replaces Access-Control-Expose-Headers, so
 * the renderer transcript proves exact body delivery plus the resulting
 * browser visibility boundary; cryptographic proof verification is owned by
 * the separate raw-query gate. Chromium resolves canister hosts to the
 * isolated 127.0.0.2 gateway and the observed response socket is checked, so
 * the live developer gateway on 127.0.0.1 cannot satisfy it.
 */
export async function verifyPortableCorsInChromium(
  input: PortableCorsExpectation,
): Promise<CertifiedAssetsBrowserCorsEvidence> {
  const target = parseIsolatedPocketIcUrl(input.url);
  assertExpectation(input);

  const harness = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/") {
        return new Response("not found", { status: 404 });
      }
      return new Response("<!doctype html><meta charset=utf-8>", {
        headers: {
          "cache-control": "no-store",
          "content-security-policy":
            `default-src 'none'; connect-src ${target.origin}`,
          "content-type": "text/html; charset=utf-8",
        },
      });
    },
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const harnessOrigin = `http://127.0.0.1:${harness.port}`;
    if (harnessOrigin === target.origin) {
      throw new Error("Browser CORS probe did not create two origins");
    }
    browser = await chromium.launch({
      headless: true,
      ...await chromiumLaunchOptions(target.hostname),
    });
    const page = await browser.newPage();
    await page.goto(`${harnessOrigin}/`, { waitUntil: "load" });

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url() === target.href &&
        response.request().method() === "GET",
      { timeout: 30_000 },
    );
    const browserFetchPromise = page.evaluate(
      async (url): Promise<BrowserFetchResult> => {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 25_000);
        try {
          const response = await fetch(url, {
            method: "GET",
            mode: "cors",
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: abort.signal,
          });
          const body = new Uint8Array(await response.arrayBuffer());
          const sha256 = new Uint8Array(
            await crypto.subtle.digest("SHA-256", body),
          );
          const headers: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            headers[name.toLowerCase()] = value;
          });
          return {
            ok: true,
            status: response.status,
            body_bytes: body.byteLength,
            body_sha256: Array.from(
              sha256,
              (byte) => byte.toString(16).padStart(2, "0"),
            ).join(""),
            headers,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error
              ? error.stack ?? error.message
              : String(error),
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      target.href,
    );
    const [networkResponse, browserFetch] = await Promise.all([
      responsePromise,
      browserFetchPromise,
    ]);
    if (!browserFetch.ok) {
      throw new Error(`Chromium CORS fetch failed: ${browserFetch.error}`);
    }

    const requestHeaders = await networkResponse.request().allHeaders();
    if (requestHeaders.origin !== harnessOrigin) {
      throw new Error(
        "Chromium did not send the exact cross-origin Origin header",
      );
    }
    const remoteAddress = await networkResponse.serverAddr();
    if (
      remoteAddress?.ipAddress !== ISOLATED_GATEWAY_IP ||
      remoteAddress.port !== ISOLATED_GATEWAY_PORT
    ) {
      throw new Error(
        "Chromium did not reach the isolated 127.0.0.2:8000 gateway",
      );
    }
    const rawHeaders = await networkResponse.allHeaders();
    if (
      browserFetch.headers["access-control-allow-origin"] !== undefined ||
      browserFetch.headers["access-control-expose-headers"] !== undefined
    ) {
      throw new Error("Chromium exposed a CORS control header to JavaScript");
    }
    if (browserFetch.status !== input.status) {
      throw new Error(
        `Chromium observed status ${browserFetch.status}, expected ${input.status}`,
      );
    }
    if (
      browserFetch.body_bytes !== input.body_bytes ||
      browserFetch.body_sha256 !== input.body_sha256
    ) {
      throw new Error("Chromium observed a different certified body");
    }

    const expectedHeaders = [
      ["ic-certificate", undefined, false],
      ["ic-certificateexpression", input.certificate_expression, false],
      ["content-length", String(input.body_bytes), true],
      ["content-digest", input.content_digest, false],
      ["etag", input.etag, false],
    ] as const;
    const evidenceHeaders = expectedHeaders.map(
      ([name, expected, shouldBeVisible]) => {
        const raw = requiredHeader(rawHeaders, name, "network response");
        if (expected !== undefined && raw !== expected) {
          throw new Error(
            `Network response has an unexpected ${name} header`,
          );
        }
        const visible = browserFetch.headers[name];
        if (shouldBeVisible) {
          if (visible !== raw) {
            throw new Error(
              `Chromium changed or hid the visible ${name} response header`,
            );
          }
        } else if (visible !== undefined) {
          throw new Error(
            `Chromium unexpectedly exposed the gateway-hidden ${name} response header`,
          );
        }
        return Object.freeze({
          name,
          raw: exactText(raw),
          browser: visible === undefined ? null : exactText(visible),
          disposition: shouldBeVisible
            ? "visible_exactly" as const
            : "hidden" as const,
        });
      });
    assertHeader(
      rawHeaders,
      "access-control-allow-origin",
      "*",
      "network response",
    );
    assertHeader(
      rawHeaders,
      "access-control-expose-headers",
      POCKET_IC_GATEWAY_EXPOSED_HEADERS,
      "network response",
    );

    return Object.freeze({
      schema: CERTIFIED_ASSETS_BROWSER_CORS_SCHEMA,
      engine: Object.freeze({
        name: "chromium",
        version: browser.version(),
      }),
      request: Object.freeze({
        harness_origin: harnessOrigin,
        target_origin: target.origin,
        url: target.href,
        mode: "cors",
        credentials: "omit",
        origin_header_exact: true,
        remote_address: Object.freeze({
          ip: ISOLATED_GATEWAY_IP,
          port: ISOLATED_GATEWAY_PORT,
        }),
      }),
      response: Object.freeze({
        status: 200,
        body: Object.freeze({
          bytes: browserFetch.body_bytes,
          sha256: browserFetch.body_sha256,
        }),
        headers: Object.freeze(evidenceHeaders),
        cors_control_headers_hidden: true,
      }),
    });
  } finally {
    await browser?.close();
    await harness.stop(true);
  }
}

export function parseIsolatedPocketIcUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Browser CORS target URL is invalid");
  }
  if (
    url.protocol !== "http:" ||
    !url.hostname.endsWith(CANISTER_HOST_SUFFIX) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== String(ISOLATED_GATEWAY_PORT)
  ) {
    throw new Error(
      "Browser CORS target must be a canonical canister.localhost:8000 HTTP URL",
    );
  }
  const canisterId = url.hostname.slice(0, -CANISTER_HOST_SUFFIX.length);
  try {
    if (Principal.fromText(canisterId).toText() !== canisterId) {
      throw new Error();
    }
  } catch {
    throw new Error("Browser CORS target host has an invalid canister id");
  }
  if (url.hash !== "") {
    throw new Error("Browser CORS target must not contain a fragment");
  }
  return url;
}

function assertExpectation(input: PortableCorsExpectation): void {
  if (
    !Number.isSafeInteger(input.body_bytes) ||
    input.body_bytes < 0 ||
    !SHA256.test(input.body_sha256)
  ) {
    throw new Error("Browser CORS expected body measurement is invalid");
  }
  for (
    const [label, value] of [
      ["content_digest", input.content_digest],
      ["etag", input.etag],
      ["certificate_expression", input.certificate_expression],
    ] as const
  ) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value) > MAX_HEADER_VALUE_BYTES
    ) {
      throw new Error(`Browser CORS ${label} is invalid`);
    }
  }
}

function assertHeader(
  headers: Record<string, string>,
  name: string,
  expected: string,
  label: string,
): void {
  if (requiredHeader(headers, name, label) !== expected) {
    throw new Error(`${label} has an unexpected ${name} header`);
  }
}

function requiredHeader(
  headers: Record<string, string>,
  name: string,
  label: string,
): string {
  const value = headers[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_HEADER_VALUE_BYTES
  ) {
    throw new Error(`${label} lacks a bounded ${name} header`);
  }
  return value;
}

function exactText(value: string): ExactBytes {
  return Object.freeze({
    bytes: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  });
}

async function chromiumLaunchOptions(targetHostname: string): Promise<{
  executablePath?: string;
  args: string[];
}> {
  // Release qualification never accepts a caller-selected browser binary.
  // Prefer the environment's immutable Nix Chromium; otherwise Playwright
  // resolves its package-lock-pinned bundled browser.
  const executablePath = await discoverNixChromium();
  return {
    ...(executablePath ? { executablePath } : {}),
    // Qualification owns the complete argument list. In particular, caller
    // flags cannot disable Chromium's CORS enforcement or redirect DNS.
    args: [
      `--host-resolver-rules=MAP ${targetHostname} ${ISOLATED_GATEWAY_IP},EXCLUDE localhost`,
    ],
  };
}

async function discoverNixChromium(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  let entries: string[];
  try {
    entries = await readdir("/nix/store");
  } catch {
    return undefined;
  }
  for (
    const entry of entries
      .filter((name) => name.includes("-chromium-"))
      .sort()
  ) {
    const candidate = join("/nix/store", entry, "bin", "chromium");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next Nix Chromium derivation.
    }
  }
  return undefined;
}
