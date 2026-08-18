import {
  Cbor,
  LookupPathStatus,
  lookup_path,
  reconstruct,
  type HashTree,
  type HttpAgent,
} from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  Certificate as TreeAwareCertificate,
  LookupPathStatus as TreeAwareLookupPathStatus,
  type Agent as CoreAgent,
  type HttpAgent as CoreHttpAgent,
} from "@icp-sdk/core/agent";
import { Principal as CorePrincipal } from "@icp-sdk/core/principal";
import { createHash } from "node:crypto";
import type { CertifiedHttpObservation, ExactBytes } from "./receipt.ts";
import {
  CERTIFIED_ASSETS_HTTP_OBSERVATION_SCHEMA,
} from "./receipt.ts";

export const HOST_BOUND_CERTIFICATION_EXPRESSION =
  'default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:["host"],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})';
export const PORTABLE_CERTIFICATION_EXPRESSION =
  "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";

const HEADER_FIELD =
  /(?:^|,\s*)(certificate|tree|expr_path|version)=((?::[A-Za-z0-9+/]*={0,2}:)|(?:[0-9]+))(?=,\s*|$)/guy;
const EMPTY_SHA256 = hash(new Uint8Array());
const MAX_CERTIFICATE_BYTES = 16 * 1024;
const MAX_WITNESS_BYTES = 64 * 1024;
const MAX_EXPRESSION_PATH_BYTES = 2 * 1024;
const MAX_PROOF_BYTES = 64 * 1024;
const MAX_TREE_NODES = 4_096;
const MAX_TREE_BLOB_BYTES = 64 * 1024;
const MAX_CBOR_DEPTH = 128;
const MAX_CBOR_ITEMS = 32_768;
const MAX_HEADER_FIELDS = 64;
const MAX_REQUEST_HEADER_BYTES = 32 * 1024;
const MAX_RESPONSE_HEADER_BYTES = 160 * 1024;
const MAX_TRANSCRIPT_HEADER_BYTES = 128 * 1024;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 120_000;
const MAX_TRANSCRIPT_HEADER_VALUE_BYTES = 96 * 1024;
const MAX_PINNED_RANGE_START = 4_294_967_295n;
const MAX_HTTP_BODY_BYTES = 67_108_864;
const MAX_PUBLICATION_BLOCK_BYTES = 1_889_984;
const MAX_PORTABLE_BODY_BYTES = 1_048_576;
const MAX_GATEWAY_ERROR_CAUSE_BYTES = 512;
const MAX_GATEWAY_ERROR_BODY_BYTES = 2 * 1024;
const POCKET_IC_GATEWAY_EXPOSE_HEADERS =
  "accept-ranges,content-length,content-range,x-request-id,x-ic-canister-id";
const POCKET_IC_503_RETRY_DELAYS_MS = [
  0,
  100,
  250,
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  28_000,
] as const;

type HeaderField = readonly [string, string];
type CoreCertificateClockAgent = Pick<
  CoreHttpAgent,
  | "getTimeDiffMsecs"
  | "hasSyncedTime"
  | "syncTime"
  | "syncTimeWithSubnet"
>;

export type CertifiedHttpQueryRequest = Readonly<{
  method: string;
  url: string;
  headers: readonly HeaderField[];
  body: Uint8Array;
  certificate_version: readonly number[];
}>;

export type CertifiedHttpQueryResponse = Readonly<{
  body: Uint8Array;
  headers: readonly HeaderField[];
  streaming_strategy: readonly unknown[];
  status_code: number;
  upgrade: readonly boolean[];
}>;

export type ExpectedCertifiedHttpResponse = Readonly<{
  canisterId: string;
  url: string;
  method: "GET" | "HEAD";
  status: 200 | 206 | 404;
  authority: "host_bound" | "portable";
  expressionPath: readonly string[];
  headers: readonly HeaderField[];
  body: Uint8Array;
  requestHeaders?: readonly HeaderField[];
}>;

/**
 * Core Certificate needs only these four clock methods, but types its option
 * as a complete Agent. Keep the production legacy agent isolated behind this
 * qualification-only adapter and fail closed for subnet synchronization,
 * which the canister-principal verification path never requests.
 */
function adaptLegacyCertificateAgent(agent: HttpAgent): CoreAgent {
  const clockAgent: CoreCertificateClockAgent = {
    getTimeDiffMsecs: () => agent.getTimeDiffMsecs(),
    hasSyncedTime: () => agent.hasSyncedTime(),
    syncTime: async (canisterId) => {
      if (canisterId === undefined) {
        throw new Error(
          "Certified HTTP certificate clock sync requires an effective canister ID",
        );
      }
      await agent.syncTime(
        Principal.fromUint8Array(canisterId.toUint8Array()),
      );
    },
    syncTimeWithSubnet: async (subnetId) => {
      throw new Error(
        `Certified HTTP legacy clock adapter cannot synchronize subnet ${subnetId.toText()}`,
      );
    },
  };
  return clockAgent as unknown as CoreAgent;
}

/**
 * Verify a response observed through the HTTP gateway. This validates the
 * complete certified response, but the gateway has already interpreted the
 * canister's `streaming_strategy`. Release qualification must additionally
 * call {@link verifyCertifiedHttpQueryResponse} on the raw `http_request`
 * reply so a callback or upgrade flag cannot be hidden by the gateway.
 * Node qualification may dial `127.0.0.2:8000` through `transportOrigin`
 * while retaining the certified `<canister>.localhost:8000` Host. Chromium
 * instead uses its isolated host-resolver rule and omits this override.
 */
export async function fetchAndVerifyCertifiedHttp(
  expected: ExpectedCertifiedHttpResponse,
  rootKey: Uint8Array,
  fetchImpl: typeof fetch = fetch,
  certificateAgent?: HttpAgent,
  transportOrigin?: string,
): Promise<CertifiedHttpObservation> {
  const prepared = prepareExpectedResponse(expected);
  const trustedRootKey = snapshotRootKey(rootKey);
  const transportUrl = transportOrigin === undefined
    ? prepared.url
    : isolatedTransportUrl(transportOrigin, prepared.url);
  const requestHeaders = new Headers(
    (
      transportOrigin === undefined
        ? prepared.transportRequestHeaders
        : prepared.effectiveRequestHeaders
    ).map(
      ([name, value]): [string, string] => [name, value],
    ),
  );
  const response = await fetchPocketIcGatewayWithBounded503Retry(
    fetchImpl,
    transportUrl,
    {
      method: expected.method,
      headers: requestHeaders,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    },
  );
  if (response.redirected) {
    throw new Error("Certified HTTP gateway followed a redirect");
  }
  if (response.status !== prepared.expected.status) {
    const detail = await boundedGatewayErrorDetail(response);
    throw new Error(
      `Certified HTTP ${prepared.expected.method} ${prepared.url.href} returned ${response.status}, expected ${prepared.expected.status}${detail}`,
    );
  }
  const body = await readExactGatewayBody(
    response,
    prepared.expected.body.byteLength,
  );
  return verifyPreparedCertifiedHttpResponse(
    prepared,
    trustedRootKey,
    {
      body,
      headers: [...response.headers.entries()],
      status: response.status,
    },
    prepared.effectiveRequestHeaders,
    false,
    "gateway",
    certificateAgent,
  );
}

async function fetchPocketIcGatewayWithBounded503Retry(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  let response = await fetchImpl.call(globalThis, url.href, init);
  for (const delayMs of POCKET_IC_503_RETRY_DELAYS_MS) {
    if (response.status !== 503) return response;
    try {
      await response.body?.cancel();
    } catch {
      // A failed best-effort discard must not widen the retryable status set.
    }
    if (delayMs > 0) await delay(delayMs);
    response = await fetchImpl.call(globalThis, url.href, init);
  }
  return response;
}

function isolatedTransportUrl(origin: string, certifiedUrl: URL): URL {
  let transport: URL;
  try {
    transport = new URL(origin);
  } catch {
    throw new Error("Certified HTTP transport origin is invalid");
  }
  if (
    transport.protocol !== "http:" ||
    transport.hostname !== "127.0.0.2" ||
    transport.port !== "8000" ||
    transport.username !== "" ||
    transport.password !== "" ||
    transport.pathname !== "/" ||
    transport.search !== "" ||
    transport.hash !== ""
  ) {
    throw new Error("Certified HTTP transport is not the isolated loopback gateway");
  }
  transport.pathname = certifiedUrl.pathname;
  transport.search = certifiedUrl.search;
  return transport;
}

async function readExactGatewayBody(
  response: Response,
  expectedBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) {
    if (expectedBytes !== 0) {
      throw new Error("Certified HTTP gateway body ended before expected");
    }
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const result = new Uint8Array(expectedBytes);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Certified HTTP gateway returned a non-byte body");
      }
      total += value.byteLength;
      if (total > expectedBytes) {
        await reader.cancel("Certified HTTP body exceeded expected length");
        throw new Error("Certified HTTP gateway body exceeds expected length");
      }
      result.set(value, total - value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedBytes) {
    throw new Error("Certified HTTP gateway body ended before expected");
  }
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function boundedGatewayErrorDetail(
  response: Response,
): Promise<string> {
  const cause = boundedDiagnosticText(
    response.headers.get("x-ic-error-cause") ?? "",
    MAX_GATEWAY_ERROR_CAUSE_BYTES,
  );
  let body = "";
  try {
    body = boundedDiagnosticText(
      await readBoundedGatewayErrorBody(response),
      MAX_GATEWAY_ERROR_BODY_BYTES,
    );
  } catch (error) {
    body = `unreadable: ${boundedDiagnosticText(
      error instanceof Error ? error.message : String(error),
      MAX_GATEWAY_ERROR_BODY_BYTES,
    )}`;
  }
  const fields = [
    cause.length === 0 ? "" : `cause=${JSON.stringify(cause)}`,
    body.length === 0 ? "" : `body=${JSON.stringify(body)}`,
  ].filter((value) => value.length > 0);
  return fields.length === 0 ? "" : ` (${fields.join(", ")})`;
}

async function readBoundedGatewayErrorBody(
  response: Response,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const bytes: number[] = [];
  let truncated = false;
  try {
    while (bytes.length <= MAX_GATEWAY_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_GATEWAY_ERROR_BODY_BYTES + 1 - bytes.length;
      bytes.push(...value.subarray(0, remaining));
      if (value.byteLength > remaining) {
        truncated = true;
        break;
      }
    }
    if (bytes.length > MAX_GATEWAY_ERROR_BODY_BYTES) truncated = true;
    if (truncated) await reader.cancel("Gateway error body exceeded bound");
  } finally {
    reader.releaseLock();
  }
  const bounded = Uint8Array.from(
    bytes.slice(0, MAX_GATEWAY_ERROR_BODY_BYTES),
  );
  return `${new TextDecoder().decode(bounded)}${truncated ? "…" : ""}`;
}

function boundedDiagnosticText(value: string, maximumBytes: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const encoded = new TextEncoder().encode(normalized);
  if (encoded.byteLength <= maximumBytes) return normalized;
  return `${new TextDecoder().decode(encoded.subarray(0, maximumBytes))}…`;
}

/**
 * Verify the exact standard canister-HTTP query reply. Unlike a browser
 * `Response`, this boundary still exposes the callback and upgrade fields, so
 * it can prove that a certified route is a single closed response.
 */
export async function verifyCertifiedHttpQueryResponse(
  expected: ExpectedCertifiedHttpResponse,
  rootKey: Uint8Array,
  request: CertifiedHttpQueryRequest,
  response: CertifiedHttpQueryResponse,
  certificateAgent?: HttpAgent,
): Promise<CertifiedHttpObservation> {
  const prepared = prepareExpectedResponse(expected);
  const trustedRootKey = snapshotRootKey(rootKey);
  const rawRequestHeaders = closedRawRequest(
    prepared.url,
    expected.method,
    request,
  );
  if (
    !equalHeaderSets(
      rawRequestHeaders,
      prepared.effectiveRequestHeaders,
    )
  ) {
    throw new Error("Certified HTTP raw request does not match its expectation");
  }
  const raw = closedRawResponse(response);
  return verifyPreparedCertifiedHttpResponse(
    prepared,
    trustedRootKey,
    raw,
    rawRequestHeaders,
    true,
    "raw_query",
    certificateAgent,
  );
}

/**
 * Check the fail-closed raw response for a request whose Range syntax is
 * unsupported by the Kernel's closed single-range grammar. A hostile request
 * must receive the small uncertified 400 response and must never stream or
 * upgrade.
 */
export function assertHostileRangeRejected(input: Readonly<{
  url: string;
  request: CertifiedHttpQueryRequest;
  response: CertifiedHttpQueryResponse;
}>): void {
  const url = exactRequestUrl(input.url);
  const canisterText = url.hostname.endsWith(".localhost")
    ? url.hostname.slice(0, -".localhost".length)
    : "";
  let canister: Principal;
  try {
    canister = Principal.fromText(canisterText);
  } catch {
    throw new Error("Hostile Range target is not a qualification canister");
  }
  const canisterBytes = canister.toUint8Array();
  if (
    url.protocol !== "http:" ||
    url.port !== "8000" ||
    canister.toText() !== canisterText ||
    canisterBytes.byteLength === 0 ||
    canisterBytes.at(-1) !== 0x01
  ) {
    throw new Error("Hostile Range target is not a qualification canister");
  }
  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    throw new Error("Hostile Range request method is unsupported");
  }
  const requestHeaders = closedRawRequest(
    url,
    input.request.method,
    input.request,
  );
  const range = requestRange(requestHeaders);
  if (range.kind !== "unsupported") {
    throw new Error("The qualification request is not a hostile Range request");
  }
  const response = closedRawResponse(input.response);
  if (
    response.status !== 400 ||
    response.body.byteLength !== 0 ||
    !equalHeaderSets(response.headers, [["Cache-Control", "no-store"]])
  ) {
    throw new Error("Hostile Range did not receive the closed 400 response");
  }
  if (
    headerValues(response.headers, "IC-Certificate").length !== 0 ||
    headerValues(response.headers, "IC-CertificateExpression").length !== 0
  ) {
    throw new Error("Hostile Range rejection unexpectedly carried a proof");
  }
}

type PreparedExpectedResponse = Readonly<{
  expected: ExpectedCertifiedHttpResponse;
  url: URL;
  effectiveRequestHeaders: readonly HeaderField[];
  transportRequestHeaders: readonly HeaderField[];
}>;

type ResponseMaterial = Readonly<{
  body: Uint8Array;
  headers: readonly HeaderField[];
  status: number;
}>;

function snapshotRootKey(rootKey: Uint8Array): Uint8Array {
  if (
    !(rootKey instanceof Uint8Array) ||
    rootKey.byteLength === 0 ||
    rootKey.byteLength > 4 * 1024
  ) {
    throw new Error("Certified HTTP root key is invalid or excessive");
  }
  return new Uint8Array(rootKey);
}

async function verifyPreparedCertifiedHttpResponse(
  prepared: PreparedExpectedResponse,
  rootKey: Uint8Array,
  response: ResponseMaterial,
  observedRequestHeaders: readonly HeaderField[],
  exactRawHeaders: boolean,
  boundary: CertifiedHttpObservation["boundary"],
  certificateAgent?: HttpAgent,
): Promise<CertifiedHttpObservation> {
  const trustedRootKey = snapshotRootKey(rootKey);
  const { expected, url } = prepared;
  validateHeaderFields(response.headers, "Certified HTTP response headers");
  if (response.status !== expected.status) {
    throw new Error(
      `Certified HTTP ${expected.method} ${url.href} returned ${response.status}, expected ${expected.status}`,
    );
  }
  if (!equalBytes(response.body, expected.body)) {
    throw new Error("Certified HTTP body does not equal the expected bytes");
  }
  assertPolicyHeaders(response.headers, expected.headers, exactRawHeaders);
  const certificateHeaders = headerValues(
    response.headers,
    "IC-Certificate",
  );
  if (certificateHeaders.length !== 1) {
    throw new Error("Certified HTTP response must contain one IC-Certificate");
  }
  const proof = parseCertificateHeader(certificateHeaders[0]!);
  if (
    proof.certificate.byteLength +
      proof.witness.byteLength +
      proof.expressionPath.byteLength >
    MAX_PROOF_BYTES
  ) {
    throw new Error("Certified HTTP proof exceeds its aggregate byte bound");
  }
  decodeCanonicalCbor(proof.certificate, "Certified HTTP certificate");
  const decodedPath = decodeExpressionPath(proof.expressionPath);
  if (!equalText(decodedPath, expected.expressionPath)) {
    throw new Error("Certified HTTP expression path does not match the expected leaf");
  }
  const witness = boundedHashTree(
    decodeCanonicalCbor(proof.witness, "Certified HTTP witness"),
  );
  const principal = Principal.fromText(expected.canisterId);
  const certificate = await TreeAwareCertificate.create({
    certificate: proof.certificate,
    rootKey: trustedRootKey,
    principal: {
      canisterId: CorePrincipal.fromUint8Array(principal.toUint8Array()),
    },
    ...(certificateAgent === undefined
      ? {}
      : { agent: adaptLegacyCertificateAgent(certificateAgent) }),
  });
  const certifiedData = found(
    certificate.lookup_path([
      "canister",
      principal.toUint8Array(),
      "certified_data",
    ]),
    "certificate certified_data",
  );
  if (certifiedData.byteLength !== 32) {
    throw new Error("Certified data root is not 32 bytes");
  }
  const witnessRoot = await reconstruct(witness);
  if (!equalBytes(certifiedData, witnessRoot)) {
    throw new Error("Certified HTTP witness does not match certified_data");
  }
  const certificateTime = decodeUnsignedLeb128(
    found(certificate.lookup_path(["time"]), "certificate time"),
  );
  if (certificateTime <= 0n) {
    throw new Error("Certified HTTP certificate time is not positive");
  }
  const requestHash = representationIndependentRequestHash(
    expected.method,
    expected.authority === "host_bound"
      ? [["host", url.host]]
      : [],
  );
  const responseHash = representationIndependentResponseHash(
    expected.status,
    expected.headers,
    hash(response.body),
  );
  const expression = expected.authority === "host_bound"
    ? HOST_BOUND_CERTIFICATION_EXPRESSION
    : PORTABLE_CERTIFICATION_EXPRESSION;
  const leaf = lookup_path(
    [
      ...expected.expressionPath,
      hash(new TextEncoder().encode(expression)),
      requestHash,
      responseHash,
    ],
    witness,
  );
  if (leaf.status !== LookupPathStatus.Found || leaf.value.byteLength !== 0) {
    throw new Error("Certified HTTP witness does not prove the exact response leaf");
  }
  if (expected.expressionPath.at(-1) === "<*>") {
    verifyWildcardSelection(
      witness,
      url.pathname,
      expected.expressionPath.slice(1, -1),
    );
  }

  return {
    schema: CERTIFIED_ASSETS_HTTP_OBSERVATION_SCHEMA,
    boundary,
    method: expected.method,
    url: url.href,
    status: expected.status,
    request_headers: canonicalTranscriptHeaders(
      observedRequestHeaders,
    ),
    // The full IC-Certificate field is deliberately omitted: its three
    // bounded components are measured below, without duplicating base64 into
    // the release receipt. Gateway-added fields are not certified and are not
    // release evidence.
    response_headers: canonicalTranscriptHeaders(
      exactRawHeaders
        ? response.headers.filter(
            ([name]) => name.toLowerCase() !== "ic-certificate",
          )
        : expected.headers,
    ),
    body: exactBytes(response.body),
    certificate: exactBytes(proof.certificate),
    witness: exactBytes(proof.witness),
    expression_path: exactBytes(proof.expressionPath),
    certificate_time_ns: certificateTime.toString(),
  };
}

function prepareExpectedResponse(
  expected: ExpectedCertifiedHttpResponse,
): PreparedExpectedResponse {
  const url = exactRequestUrl(expected.url);
  const principal = Principal.fromText(expected.canisterId);
  const principalBytes = principal.toUint8Array();
  if (
    principal.toText() !== expected.canisterId ||
    principalBytes.byteLength === 0 ||
    principalBytes.at(-1) !== 0x01
  ) {
    throw new Error("Certified HTTP canister ID is not a canonical canister principal");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== `${expected.canisterId}.localhost` ||
    url.port !== "8000"
  ) {
    throw new Error("Certified HTTP URL is not the isolated PocketIC canister origin");
  }
  if (url.search !== "" && expected.authority !== "host_bound") {
    throw new Error("Portable Certified HTTP routes reject query aliases");
  }
  if (
    !(expected.body instanceof Uint8Array) ||
    expected.body.byteLength > MAX_HTTP_BODY_BYTES
  ) {
    throw new Error("Certified HTTP expected body is invalid or excessive");
  }
  validateHeaderFields(
    expected.headers,
    "Certified HTTP expected response headers",
    MAX_TRANSCRIPT_HEADER_BYTES,
    MAX_TRANSCRIPT_HEADER_VALUE_BYTES,
  );
  assertUniqueHeaderNames(
    expected.headers,
    "Certified HTTP expected response headers",
  );
  if (headerValues(expected.headers, "IC-Certificate").length !== 0) {
    throw new Error("IC-Certificate is proof material, not a policy header");
  }
  const expression = expected.authority === "host_bound"
    ? HOST_BOUND_CERTIFICATION_EXPRESSION
    : PORTABLE_CERTIFICATION_EXPRESSION;
  const expressionHeaders = headerValues(
    expected.headers,
    "IC-CertificateExpression",
  );
  if (expressionHeaders.length !== 1 || expressionHeaders[0] !== expression) {
    throw new Error("Certified HTTP expression does not match authority policy");
  }

  assertClosedExpectedPolicy(expected);
  assertExpressionPathOwnsRequest(expected, url);
  const effectiveRequestHeaders = normalizedRequestHeaders(
    url,
    expected.requestHeaders ?? [],
  );
  assertRangeSemantics(expected, effectiveRequestHeaders);
  if (expected.method === "HEAD" && expected.body.byteLength !== 0) {
    throw new Error("Certified HTTP HEAD response must have an empty body");
  }
  if (expected.status === 404 && expected.body.byteLength !== 0) {
    throw new Error("Certified HTTP absence response must have an empty body");
  }

  const boundExpected: ExpectedCertifiedHttpResponse = {
    ...expected,
    expressionPath: [...expected.expressionPath],
    headers: expected.headers.map(
      ([name, value]) => [name, value] as const,
    ),
    body: new Uint8Array(expected.body),
    ...(expected.requestHeaders === undefined
      ? {}
      : {
          requestHeaders: expected.requestHeaders.map(
            ([name, value]) => [name, value] as const,
          ),
        }),
  };
  return {
    expected: boundExpected,
    url,
    effectiveRequestHeaders,
    // The HTTP stack owns Host. Supplying it through browser Headers is
    // forbidden in browsers and would make the gateway check non-portable.
    transportRequestHeaders: effectiveRequestHeaders.filter(
      ([name]) => name.toLowerCase() !== "host",
    ),
  };
}

function exactRequestUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Certified HTTP URL is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.href !== value
  ) {
    throw new Error("Certified HTTP URL is not a canonical absolute URL");
  }
  canonicalPathSegments(url.pathname);
  return url;
}

function normalizedRequestHeaders(
  url: URL,
  input: readonly HeaderField[],
): readonly HeaderField[] {
  validateHeaderFields(
    input,
    "Certified HTTP request headers",
    MAX_REQUEST_HEADER_BYTES,
  );
  const hosts = headerValues(input, "Host");
  if (hosts.length > 1) {
    throw new Error("Certified HTTP request repeats Host");
  }
  if (hosts.length === 1 && hosts[0] !== url.host) {
    throw new Error("Certified HTTP Host does not match the request URL");
  }
  const withoutHost = input.filter(
    ([name]) => name.toLowerCase() !== "host",
  );
  return [["Host", url.host], ...withoutHost];
}

function assertExpressionPathOwnsRequest(
  expected: ExpectedCertifiedHttpResponse,
  url: URL,
): void {
  const requestSegments = canonicalPathSegments(url.pathname);
  const exact = ["http_expr", ...requestSegments, "<$>"];
  if (equalText(expected.expressionPath, exact)) return;
  if (
    expected.status !== 404 ||
    expected.expressionPath.length < 3 ||
    expected.expressionPath[0] !== "http_expr" ||
    expected.expressionPath.at(-1) !== "<*>"
  ) {
    throw new Error("Certified HTTP expression path does not own the request");
  }
  const base = expected.expressionPath.slice(1, -1);
  if (
    base.length > requestSegments.length ||
    base.some((segment, index) => segment !== requestSegments[index])
  ) {
    throw new Error("Certified HTTP wildcard does not own the request");
  }
}

function assertClosedExpectedPolicy(
  expected: ExpectedCertifiedHttpResponse,
): void {
  if (expected.authority === "portable" && expected.method !== "GET") {
    throw new Error("Portable Certified HTTP routes support GET only");
  }
  const contentLengths = headerValues(expected.headers, "Content-Length");
  if (contentLengths.length !== 1) {
    throw new Error("Certified HTTP policy requires one Content-Length");
  }
  const contentLength = canonicalDecimal(
    contentLengths[0]!,
    MAX_HTTP_BODY_BYTES,
  );
  if (contentLength === null) {
    throw new Error("Certified HTTP Content-Length is invalid");
  }
  if (expected.status === 404) {
    const absenceHeaders = expected.authority === "host_bound"
      ? hostBoundAbsenceHeaders()
      : portableAbsenceHeaders();
    if (
      contentLength !== 0 ||
      expected.body.byteLength !== 0 ||
      !equalHeaderSets(expected.headers, absenceHeaders)
    ) {
      throw new Error("Certified HTTP absence policy is not closed");
    }
    return;
  }
  if (
    expected.method === "GET" &&
    contentLength !== expected.body.byteLength
  ) {
    throw new Error("Certified HTTP Content-Length does not match its body");
  }
  if (expected.authority === "portable") {
    if (
      expected.status !== 200 ||
      expected.method !== "GET" ||
      contentLength > MAX_PORTABLE_BODY_BYTES
    ) {
      throw new Error("Portable Certified HTTP response is outside its closed policy");
    }
    const digest = portableDigest(expected.headers);
    if (
      expected.method === "GET" &&
      !equalBytes(digest, hash(expected.body))
    ) {
      throw new Error("Portable Content-Digest does not match its body");
    }
    const cache = singleHeader(expected.headers, "Cache-Control");
    const kind = cache === "public, max-age=31536000, immutable"
      ? "immutable_blob"
      : cache === "no-cache, must-revalidate"
      ? "mutable_blob"
      : null;
    if (
      kind === null ||
      !equalHeaderSets(
        expected.headers,
        portableHeadersFromDigest({
          kind,
          digest,
          contentLength,
        }),
      )
    ) {
      throw new Error("Portable Certified HTTP response policy is not closed");
    }
    return;
  }

  if (
    expected.method === "GET" &&
    contentLength > MAX_PUBLICATION_BLOCK_BYTES
  ) {
    throw new Error("Publication response exceeds one physical block");
  }
  const etag = singleHeader(expected.headers, "ETag");
  const etagMatch = /^"([0-9a-f]{64})"$/u.exec(etag);
  if (etagMatch === null) {
    throw new Error("Publication ETag is not a quoted SHA-256 tag");
  }
  const contentType = singleHeader(expected.headers, "Content-Type");
  let filename: string | undefined;
  if (contentType === "text/plain; charset=utf-8") {
    if (headerValues(expected.headers, "Content-Disposition").length !== 0) {
      throw new Error("Inline publication unexpectedly has a filename");
    }
  } else if (contentType === "application/octet-stream") {
    const disposition = singleHeader(
      expected.headers,
      "Content-Disposition",
    );
    const dispositionMatch =
      /^attachment; filename="([A-Za-z0-9._-]{1,100})"$/u.exec(disposition);
    if (
      dispositionMatch === null ||
      dispositionMatch[1] === "." ||
      dispositionMatch[1] === ".."
    ) {
      throw new Error("Publication attachment filename is invalid");
    }
    filename = dispositionMatch[1]!;
  } else {
    throw new Error("Publication Content-Type is outside closed policy");
  }
  const contentRanges = headerValues(expected.headers, "Content-Range");
  if (contentRanges.length > 1) {
    throw new Error("Publication response repeats Content-Range");
  }
  if (
    !equalHeaderSets(
      expected.headers,
      publicationHeaders({
        contentTag: new Uint8Array(Buffer.from(etagMatch[1]!, "hex")),
        contentLength,
        ...(contentRanges.length === 0
          ? {}
          : { contentRange: contentRanges[0]! }),
        ...(filename === undefined ? {} : { filename }),
      }),
    )
  ) {
    throw new Error("Publication Certified HTTP response policy is not closed");
  }
}

function canonicalDecimal(value: string, maximum: number): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result <= maximum ? result : null;
}

function singleHeader(
  headers: readonly HeaderField[],
  name: string,
): string {
  const values = headerValues(headers, name);
  if (values.length !== 1) {
    throw new Error(`Certified HTTP policy requires one ${name}`);
  }
  return values[0]!;
}

function portableDigest(headers: readonly HeaderField[]): Uint8Array {
  const contentDigest = singleHeader(headers, "Content-Digest");
  const match =
    /^sha-256=:([A-Za-z0-9+/]{43}=):$/u.exec(contentDigest);
  if (match === null) {
    throw new Error("Portable Content-Digest is not canonical SHA-256");
  }
  const digest = new Uint8Array(Buffer.from(match[1]!, "base64"));
  if (
    digest.byteLength !== 32 ||
    singleHeader(headers, "ETag") !==
      `"${Buffer.from(digest).toString("hex")}"`
  ) {
    throw new Error("Portable Content-Digest and ETag disagree");
  }
  return digest;
}

type ParsedRequestRange =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "valid"; start: bigint; end?: bigint }>;

function requestRange(headers: readonly HeaderField[]): ParsedRequestRange {
  const values = headerValues(headers, "Range");
  if (values.length === 0) return { kind: "absent" };
  if (values.length !== 1) return { kind: "unsupported" };
  const value = values[0]!.trim();
  if (!value.startsWith("bytes=")) return { kind: "unsupported" };
  const spec = value.slice("bytes=".length);
  if (spec.includes(",")) return { kind: "unsupported" };
  const parts = spec.split("-");
  if (parts.length !== 2) return { kind: "unsupported" };
  const start = pinnedRangeNat(parts[0]!.trim());
  if (start === null) return { kind: "unsupported" };
  const rawEnd = parts[1]!.trim();
  if (rawEnd === "") return { kind: "valid", start };
  const end = pinnedRangeNat(rawEnd);
  if (end === null || end < start) return { kind: "unsupported" };
  return { kind: "valid", start, end };
}

function pinnedRangeNat(value: string): bigint | null {
  const digits = value.startsWith("+") ? value.slice(1) : value;
  if (!/^[0-9]+$/u.test(digits)) return null;
  const result = BigInt(digits);
  return result <= MAX_PINNED_RANGE_START ? result : null;
}

function assertRangeSemantics(
  expected: ExpectedCertifiedHttpResponse,
  requestHeaders: readonly HeaderField[],
): void {
  const range = requestRange(requestHeaders);
  const contentRanges = headerValues(expected.headers, "Content-Range");
  if (expected.status === 404) {
    if (contentRanges.length !== 0) {
      throw new Error("Certified HTTP absence carries Content-Range");
    }
    return;
  }
  if (range.kind === "unsupported") {
    throw new Error("Certified HTTP request has an unsupported Range");
  }
  if (expected.status === 206) {
    if (
      expected.method !== "GET" ||
      expected.authority !== "host_bound" ||
      contentRanges.length !== 1
    ) {
      throw new Error("Certified HTTP 206 is outside publication GET policy");
    }
    const contentRange = parseContentRange(contentRanges[0]!);
    if (
      contentRange === null ||
      contentRange.end - contentRange.start + 1n !==
        BigInt(expected.body.byteLength) ||
      (
        range.kind === "absent"
          ? contentRange.start !== 0n
          : range.start < contentRange.start ||
            range.start > contentRange.end
      )
    ) {
      throw new Error("Certified HTTP Content-Range does not bind the selected block");
    }
    return;
  }
  if (contentRanges.length !== 0) {
    throw new Error("Certified HTTP non-206 response carries Content-Range");
  }
  if (range.kind === "absent") return;
  if (
    expected.authority !== "host_bound" ||
    (expected.method !== "GET" && expected.method !== "HEAD")
  ) {
    throw new Error("Certified HTTP Range is outside publication policy");
  }
  const total = canonicalDecimal(
    singleHeader(expected.headers, "Content-Length"),
    MAX_HTTP_BODY_BYTES,
  );
  if (total === null || range.start >= BigInt(total)) {
    throw new Error("Certified HTTP single-block Range is inconsistent");
  }
}

function parseContentRange(value: string): Readonly<{
  start: bigint;
  end: bigint;
  total: bigint;
}> | null {
  const match = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/u
    .exec(value);
  if (match === null) return null;
  const start = BigInt(match[1]!);
  const end = BigInt(match[2]!);
  const total = BigInt(match[3]!);
  if (
    end < start ||
    total === 0n ||
    end >= total ||
    total > BigInt(MAX_HTTP_BODY_BYTES)
  ) {
    return null;
  }
  return { start, end, total };
}

function closedRawResponse(
  response: CertifiedHttpQueryResponse,
): ResponseMaterial {
  if (
    !Array.isArray(response.streaming_strategy) ||
    response.streaming_strategy.length !== 0
  ) {
    throw new Error("Certified HTTP raw response must not stream");
  }
  if (!Array.isArray(response.upgrade) || response.upgrade.length !== 0) {
    throw new Error("Certified HTTP raw response must not upgrade");
  }
  if (
    !(response.body instanceof Uint8Array) ||
    response.body.byteLength > MAX_HTTP_BODY_BYTES
  ) {
    throw new Error("Certified HTTP raw response body is invalid or excessive");
  }
  if (
    !Number.isSafeInteger(response.status_code) ||
    response.status_code < 100 ||
    response.status_code > 599
  ) {
    throw new Error("Certified HTTP raw response status is invalid");
  }
  validateHeaderFields(
    response.headers,
    "Certified HTTP raw response headers",
    MAX_RESPONSE_HEADER_BYTES,
  );
  return {
    body: new Uint8Array(response.body),
    headers: response.headers.map(([name, value]) => [name, value] as const),
    status: response.status_code,
  };
}

function closedRawRequest(
  url: URL,
  method: "GET" | "HEAD",
  request: CertifiedHttpQueryRequest,
): readonly HeaderField[] {
  if (
    request.method !== method ||
    request.url !== `${url.pathname}${url.search}` ||
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength !== 0 ||
    !Array.isArray(request.certificate_version) ||
    request.certificate_version.length !== 1 ||
    request.certificate_version[0] !== 2
  ) {
    throw new Error("Certified HTTP raw request is not the exact V2 request");
  }
  validateHeaderFields(
    request.headers,
    "Certified HTTP raw request headers",
    MAX_REQUEST_HEADER_BYTES,
  );
  const hosts = headerValues(request.headers, "Host");
  if (hosts.length !== 1 || hosts[0] !== url.host) {
    throw new Error("Certified HTTP raw request must bind the exact Host");
  }
  return request.headers.map(([name, value]) => [name, value] as const);
}

function assertPolicyHeaders(
  actual: readonly HeaderField[],
  expected: readonly HeaderField[],
  exact: boolean,
): void {
  if (exact) {
    const withoutCertificate = actual.filter(
      ([name]) => name.toLowerCase() !== "ic-certificate",
    );
    if (!equalHeadersExact(withoutCertificate, expected)) {
      throw new Error("Certified HTTP raw response headers do not match policy");
    }
    return;
  }
  for (const [name, value] of expected) {
    const values = headerValues(actual, name);
    // PocketIC's pinned HTTP gateway owns and replaces this CORS control
    // field. The raw query above remains the exact certified policy boundary;
    // Chromium separately proves the cross-origin browser behavior.
    if (name.toLowerCase() === "access-control-expose-headers") {
      if (
        values.length !== 1 ||
        values[0] !== POCKET_IC_GATEWAY_EXPOSE_HEADERS
      ) {
        throw new Error(
          `Certified HTTP gateway expose-header rewrite is not the pinned PocketIC policy: received ${JSON.stringify(values).slice(0, 512)}`,
        );
      }
      continue;
    }
    if (values.length !== 1 || values[0] !== value) {
      throw new Error(
        `Certified HTTP header ${name} does not match policy: expected ${JSON.stringify(value)}, received ${JSON.stringify(values).slice(0, 512)}`,
      );
    }
  }
}

function equalHeadersExact(
  left: readonly HeaderField[],
  right: readonly HeaderField[],
): boolean {
  return left.length === right.length &&
    left.every(
      ([name, value], index) =>
        right[index]?.[0] === name && right[index]?.[1] === value,
    );
}

function equalHeaderSets(
  left: readonly HeaderField[],
  right: readonly HeaderField[],
): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = canonicalTranscriptHeaders(left);
  const normalizedRight = canonicalTranscriptHeaders(right);
  return normalizedLeft.every(
    ([name, value], index) =>
      normalizedRight[index]?.[0] === name &&
      normalizedRight[index]?.[1] === value,
  );
}

function headerValues(
  headers: readonly HeaderField[],
  wantedName: string,
): string[] {
  const normalized = wantedName.toLowerCase();
  return headers
    .filter(([name]) => name.toLowerCase() === normalized)
    .map(([, value]) => value);
}

function canonicalTranscriptHeaders(
  headers: readonly HeaderField[],
): readonly HeaderField[] {
  return headers
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      if (leftValue === rightValue) return 0;
      return leftValue < rightValue ? -1 : 1;
    });
}

function assertUniqueHeaderNames(
  headers: readonly HeaderField[],
  label: string,
): void {
  const names = new Set<string>();
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (names.has(normalized)) {
      throw new Error(`${label} repeats ${name}`);
    }
    names.add(normalized);
  }
}

function validateHeaderFields(
  headers: readonly HeaderField[],
  label: string,
  maximumBytes = MAX_RESPONSE_HEADER_BYTES,
  maximumValueBytes = MAX_HEADER_VALUE_BYTES,
): void {
  if (!Array.isArray(headers) || headers.length > MAX_HEADER_FIELDS) {
    throw new Error(`${label} is not a bounded header array`);
  }
  let totalBytes = 0;
  for (const field of headers) {
    if (
      !Array.isArray(field) ||
      field.length !== 2 ||
      typeof field[0] !== "string" ||
      typeof field[1] !== "string" ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(field[0])
    ) {
      throw new Error(`${label} contains a malformed header`);
    }
    const nameBytes = Buffer.byteLength(field[0], "utf8");
    const valueBytes = Buffer.byteLength(field[1], "utf8");
    if (
      nameBytes === 0 ||
      nameBytes > MAX_HEADER_NAME_BYTES ||
      valueBytes > maximumValueBytes ||
      /[\r\n\0]/u.test(field[1])
    ) {
      throw new Error(`${label} contains an excessive or unsafe header`);
    }
    totalBytes += nameBytes + valueBytes;
    if (totalBytes > maximumBytes) {
      throw new Error(`${label} exceeds its byte bound`);
    }
  }
}

function verifyWildcardSelection(
  witness: HashTree,
  requestedPath: string,
  baseSegments: readonly string[],
): void {
  const requested = canonicalPathSegments(requestedPath);
  requireAbsent(
    lookup_path(["http_expr", ...requested, "<$>"], witness),
    "requested exact Certified HTTP path",
  );
  if (
    requested.length < baseSegments.length ||
    baseSegments.some((segment, index) => requested[index] !== segment)
  ) {
    throw new Error("Certified HTTP wildcard does not own the requested path");
  }
  for (
    let length = requested.length;
    length > baseSegments.length;
    length -= 1
  ) {
    const prefix = requested.slice(0, length);
    requireAbsent(
      lookup_path(["http_expr", ...prefix, "<*>"], witness),
      "more-specific Certified HTTP wildcard",
    );
    requireAbsent(
      lookup_path(
        ["http_expr", ...prefix.slice(0, -1), "", "<*>"],
        witness,
      ),
      "more-specific directory Certified HTTP wildcard",
    );
  }
}

function requireAbsent(
  value: ReturnType<typeof lookup_path>,
  label: string,
): void {
  if (value.status !== LookupPathStatus.Absent) {
    throw new Error(`${label} is not proven absent`);
  }
}

export function exactExpressionPath(path: string): readonly string[] {
  return ["http_expr", ...canonicalPathSegments(path), "<$>"];
}

export function wildcardExpressionPath(basePath: string): readonly string[] {
  return ["http_expr", ...canonicalPathSegments(basePath), "<*>"];
}

export function portableHeaders(input: {
  kind: "immutable_blob" | "mutable_blob";
  body: Uint8Array;
}): readonly (readonly [string, string])[] {
  return portableHeadersFromDigest({
    kind: input.kind,
    digest: hash(input.body),
    contentLength: input.body.byteLength,
  });
}

function portableHeadersFromDigest(input: {
  kind: "immutable_blob" | "mutable_blob";
  digest: Uint8Array;
  contentLength: number;
}): readonly HeaderField[] {
  return [
    ["Content-Type", "application/octet-stream"],
    ["Content-Length", String(input.contentLength)],
    [
      "Content-Digest",
      `sha-256=:${Buffer.from(input.digest).toString("base64")}:`,
    ],
    ["ETag", `"${Buffer.from(input.digest).toString("hex")}"`],
    [
      "Cache-Control",
      input.kind === "immutable_blob"
        ? "public, max-age=31536000, immutable"
        : "no-cache, must-revalidate",
    ],
    ["Access-Control-Allow-Origin", "*"],
    [
      "Access-Control-Expose-Headers",
      "IC-Certificate, IC-CertificateExpression, Content-Length, Content-Digest, ETag",
    ],
    ["Cross-Origin-Resource-Policy", "cross-origin"],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["Permissions-Policy", "camera=(), geolocation=(), microphone=()"],
    [
      "Content-Security-Policy",
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    ],
    ["IC-CertificateExpression", PORTABLE_CERTIFICATION_EXPRESSION],
  ];
}

export function portableAbsenceHeaders(): readonly (readonly [string, string])[] {
  return [
    ["Content-Type", "application/octet-stream"],
    ["Content-Length", "0"],
    ["Cache-Control", "no-store"],
    ["Access-Control-Allow-Origin", "*"],
    [
      "Access-Control-Expose-Headers",
      "IC-Certificate, IC-CertificateExpression, Content-Length",
    ],
    ["Cross-Origin-Resource-Policy", "cross-origin"],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["Permissions-Policy", "camera=(), geolocation=(), microphone=()"],
    [
      "Content-Security-Policy",
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    ],
    ["IC-CertificateExpression", PORTABLE_CERTIFICATION_EXPRESSION],
  ];
}

export function publicationHeaders(input: {
  contentTag: Uint8Array;
  contentLength: number;
  contentRange?: string;
  filename?: string;
}): readonly (readonly [string, string])[] {
  const headers: Array<readonly [string, string]> = [
    [
      "Content-Type",
      input.filename === undefined
        ? "text/plain; charset=utf-8"
        : "application/octet-stream",
    ],
  ];
  if (input.filename !== undefined) {
    headers.push([
      "Content-Disposition",
      `attachment; filename="${input.filename}"`,
    ]);
  }
  headers.push(
    ["Cache-Control", "no-store"],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["Permissions-Policy", "camera=(), geolocation=(), microphone=()"],
    [
      "Content-Security-Policy",
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    ],
    ["Accept-Ranges", "bytes"],
    ["ETag", `"${Buffer.from(input.contentTag).toString("hex")}"`],
    ["Content-Length", String(input.contentLength)],
  );
  if (input.contentRange !== undefined) {
    headers.push(["Content-Range", input.contentRange]);
  }
  headers.push([
    "IC-CertificateExpression",
    HOST_BOUND_CERTIFICATION_EXPRESSION,
  ]);
  return headers;
}

export function hostBoundAbsenceHeaders(): readonly (readonly [string, string])[] {
  return [
    ["Content-Type", "text/plain; charset=utf-8"],
    ["Content-Length", "0"],
    ["Cache-Control", "no-store"],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["Permissions-Policy", "camera=(), geolocation=(), microphone=()"],
    [
      "Content-Security-Policy",
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    ],
    ["IC-CertificateExpression", HOST_BOUND_CERTIFICATION_EXPRESSION],
  ];
}

export function exactBytes(value: Uint8Array): ExactBytes {
  return {
    bytes: value.byteLength,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function parseCertificateHeader(value: string): {
  certificate: Uint8Array;
  witness: Uint8Array;
  expressionPath: Uint8Array;
} {
  if (value.length === 0 || value.length > 120_000) {
    throw new Error("IC-Certificate header is empty or excessive");
  }
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < value.length) {
    HEADER_FIELD.lastIndex = offset;
    const match = HEADER_FIELD.exec(value);
    if (match === null || match.index !== offset) {
      throw new Error("IC-Certificate header syntax is invalid");
    }
    if (fields.has(match[1]!)) {
      throw new Error(`IC-Certificate repeats ${match[1]}`);
    }
    fields.set(match[1]!, match[2]!);
    offset = HEADER_FIELD.lastIndex;
  }
  if (
    fields.size !== 4 ||
    fields.get("version") !== "2" ||
    !fields.has("certificate") ||
    !fields.has("tree") ||
    !fields.has("expr_path")
  ) {
    throw new Error("IC-Certificate is not the closed V2 shape");
  }
  return {
    certificate: headerBytes(
      fields.get("certificate")!,
      MAX_CERTIFICATE_BYTES,
      "certificate",
    ),
    witness: headerBytes(
      fields.get("tree")!,
      MAX_WITNESS_BYTES,
      "tree",
    ),
    expressionPath: headerBytes(
      fields.get("expr_path")!,
      MAX_EXPRESSION_PATH_BYTES,
      "expr_path",
    ),
  };
}

function headerBytes(value: string, maximum: number, label: string): Uint8Array {
  if (value[0] !== ":" || value.at(-1) !== ":") {
    throw new Error(`IC-Certificate ${label} is not an RFC 8941 byte sequence`);
  }
  const encoded = value.slice(1, -1);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    throw new Error(`IC-Certificate ${label} is not canonical base64`);
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximum ||
    Buffer.from(bytes).toString("base64") !== encoded
  ) {
    throw new Error(`IC-Certificate ${label} is empty, excessive, or noncanonical`);
  }
  return bytes;
}

function decodeCanonicalCbor(value: Uint8Array, label: string): unknown {
  preflightCbor(value, label);
  let decoded: unknown;
  try {
    decoded = Cbor.decode<unknown>(value);
  } catch {
    throw new Error(`${label} is not valid CBOR`);
  }
  let encoded: Uint8Array;
  try {
    encoded = new Uint8Array(Cbor.encode(decoded));
  } catch {
    throw new Error(`${label} cannot be canonically re-encoded`);
  }
  if (!equalBytes(value, encoded)) {
    throw new Error(`${label} is not exact canonical self-described CBOR`);
  }
  return decoded;
}

function preflightCbor(value: Uint8Array, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${label} is empty`);
  }
  const frames: number[] = [1];
  let offset = 0;
  let items = 0;
  while (frames.length > 0) {
    const frame = frames.length - 1;
    if (frames[frame] === 0) {
      frames.pop();
      continue;
    }
    frames[frame] = frames[frame]! - 1;
    if (offset >= value.byteLength) {
      throw new Error(`${label} is truncated CBOR`);
    }
    items += 1;
    if (items > MAX_CBOR_ITEMS) {
      throw new Error(`${label} exceeds its CBOR item bound`);
    }
    const initial = value[offset++]!;
    const major = initial >>> 5;
    const additional = initial & 0x1f;
    const argument = readCborArgument(
      value,
      additional,
      () => offset,
      (next) => {
        offset = next;
      },
      label,
    );
    if (major === 2 || major === 3) {
      if (argument > BigInt(value.byteLength - offset)) {
        throw new Error(`${label} contains a truncated CBOR string`);
      }
      offset += Number(argument);
      continue;
    }
    if (major === 4 || major === 5 || major === 6) {
      const children = major === 6
        ? 1n
        : major === 5
        ? argument * 2n
        : argument;
      if (children > BigInt(MAX_CBOR_ITEMS)) {
        throw new Error(`${label} exceeds its CBOR container bound`);
      }
      if (children > 0n) {
        frames.push(Number(children));
        if (frames.length > MAX_CBOR_DEPTH) {
          throw new Error(`${label} exceeds its CBOR depth bound`);
        }
      }
      continue;
    }
    if (major === 7 && additional >= 28) {
      throw new Error(`${label} contains unsupported CBOR simple data`);
    }
  }
  if (offset !== value.byteLength) {
    throw new Error(`${label} has trailing CBOR bytes`);
  }
}

function readCborArgument(
  value: Uint8Array,
  additional: number,
  getOffset: () => number,
  setOffset: (value: number) => void,
  label: string,
): bigint {
  if (additional < 24) return BigInt(additional);
  const bytes = additional === 24
    ? 1
    : additional === 25
    ? 2
    : additional === 26
    ? 4
    : additional === 27
    ? 8
    : 0;
  if (bytes === 0) {
    throw new Error(`${label} contains indefinite or reserved CBOR`);
  }
  const offset = getOffset();
  if (offset + bytes > value.byteLength) {
    throw new Error(`${label} contains a truncated CBOR argument`);
  }
  let result = 0n;
  for (let index = 0; index < bytes; index += 1) {
    result = (result << 8n) | BigInt(value[offset + index]!);
  }
  setOffset(offset + bytes);
  return result;
}

function decodeExpressionPath(value: Uint8Array): string[] {
  const decoded = decodeCanonicalCbor(
    value,
    "Certified HTTP expression path",
  );
  if (
    !Array.isArray(decoded) ||
    decoded.length === 0 ||
    decoded.length > 17 ||
    decoded.some(
      (segment) =>
        typeof segment !== "string" ||
        Buffer.byteLength(segment, "utf8") > 255,
    )
  ) {
    throw new Error("Certified HTTP expression path is invalid");
  }
  return decoded as string[];
}

function canonicalPathSegments(value: string): string[] {
  if (
    !value.startsWith("/") ||
    value.includes("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%") ||
    value.includes("\\")
  ) {
    throw new Error("Certified HTTP path is not canonical");
  }
  const segments = value === "/" ? [""] : value.slice(1).split("/");
  if (
    segments.length > 15 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Certified HTTP path has invalid segments");
  }
  return segments;
}

function representationIndependentRequestHash(
  method: string,
  headers: readonly (readonly [string, string])[],
): Uint8Array {
  return hash(concat(
    representationIndependentHash([
      ...headers.map(([name, value]) => [
        name.toLowerCase(),
        { string: value },
      ] as const),
      [":ic-cert-method", { string: method }] as const,
    ]),
    EMPTY_SHA256,
  ));
}

function representationIndependentResponseHash(
  status: number,
  headers: readonly (readonly [string, string])[],
  bodyHash: Uint8Array,
): Uint8Array {
  return hash(concat(
    representationIndependentHash([
      ...headers
        .filter(([name]) => name.toLowerCase() !== "ic-certificate")
        .map(([name, value]) => [
          name.toLowerCase(),
          { string: value },
        ] as const),
      [":ic-cert-status", { nat: BigInt(status) }] as const,
    ]),
    bodyHash,
  ));
}

function representationIndependentHash(
  entries: readonly (
    readonly [string, { readonly string: string } | { readonly nat: bigint }]
  )[],
): Uint8Array {
  const hashed = entries.map(([name, value], index) => ({
    key: hash(new TextEncoder().encode(name)),
    value: "string" in value
      ? hash(new TextEncoder().encode(value.string))
      : hash(unsignedLeb128(value.nat)),
    index,
  }));
  hashed.sort((left, right) =>
    Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)) ||
    left.index - right.index
  );
  return hash(concat(...hashed.flatMap(({ key, value }) => [key, value])));
}

function unsignedLeb128(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("LEB128 value is negative");
  const result: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) byte |= 0x80;
    result.push(byte);
  } while (value !== 0n);
  return Uint8Array.from(result);
}

function decodeUnsignedLeb128(value: Uint8Array): bigint {
  if (value.byteLength === 0 || value.byteLength > 10) {
    throw new Error("Certificate time is not a bounded Nat64");
  }
  let result = 0n;
  let shift = 0n;
  for (let index = 0; index < value.byteLength; index += 1) {
    const byte = value[index]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (index !== value.byteLength - 1 || (index > 0 && byte === 0)) {
        throw new Error("Certificate time is not canonical LEB128");
      }
      return result;
    }
    shift += 7n;
  }
  throw new Error("Certificate time is unterminated LEB128");
}

function boundedHashTree(value: unknown): HashTree {
  let nodes = 0;
  let blobBytes = 0;
  let result: HashTree | null = null;
  const pending: Array<{
    value: unknown;
    set(value: HashTree): void;
  }> = [{
    value,
    set(tree) {
      result = tree;
    },
  }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_TREE_NODES) {
      throw new Error("Certified HTTP witness exceeds its node bound");
    }
    if (!Array.isArray(current.value) || current.value.length === 0) {
      throw new Error("Certified HTTP witness node is malformed");
    }
    const tag = typeof current.value[0] === "bigint"
      ? Number(current.value[0])
      : current.value[0];
    switch (tag) {
      case 0:
        if (current.value.length !== 1) throw new Error("Malformed empty node");
        current.set([0]);
        break;
      case 1: {
        if (current.value.length !== 3) throw new Error("Malformed fork node");
        const node: unknown[] = [1, [0], [0]];
        current.set(node as HashTree);
        pending.push(
          { value: current.value[2], set: (tree) => { node[2] = tree; } },
          { value: current.value[1], set: (tree) => { node[1] = tree; } },
        );
        break;
      }
      case 2: {
        if (current.value.length !== 3) throw new Error("Malformed label node");
        const label = treeBytes(current.value[1], 512, "label");
        blobBytes += label.byteLength;
        const node: unknown[] = [2, label, [0]];
        current.set(node as HashTree);
        pending.push({
          value: current.value[2],
          set: (tree) => { node[2] = tree; },
        });
        break;
      }
      case 3: {
        if (current.value.length !== 2) throw new Error("Malformed leaf node");
        const leaf = treeBytes(current.value[1], MAX_TREE_BLOB_BYTES, "leaf");
        blobBytes += leaf.byteLength;
        current.set([3, leaf as HashTree[1]] as HashTree);
        break;
      }
      case 4: {
        if (current.value.length !== 2) throw new Error("Malformed pruned node");
        const pruned = treeBytes(current.value[1], 32, "pruned hash");
        if (pruned.byteLength !== 32) {
          throw new Error("Pruned witness hash is not 32 bytes");
        }
        blobBytes += pruned.byteLength;
        current.set([4, pruned as HashTree[1]] as HashTree);
        break;
      }
      default:
        throw new Error("Certified HTTP witness has an unknown node tag");
    }
    if (blobBytes > MAX_TREE_BLOB_BYTES) {
      throw new Error("Certified HTTP witness exceeds its blob budget");
    }
  }
  if (result === null) throw new Error("Certified HTTP witness is empty");
  return result;
}

function treeBytes(value: unknown, maximum: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) {
    throw new Error(`Certified HTTP witness ${label} is invalid`);
  }
  return value;
}

function found(
  value: ReturnType<TreeAwareCertificate["lookup_path"]>,
  label: string,
): Uint8Array {
  if (value.status !== TreeAwareLookupPathStatus.Found) {
    throw new Error(`${label} is absent or pruned`);
  }
  return value.value;
}

function hash(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    values.reduce((total, value) => total + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function equalText(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
