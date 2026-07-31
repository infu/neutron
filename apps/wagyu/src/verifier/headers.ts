import { toBase64, toLowerHex } from "./bytes.ts";
import type {
  CertifiedBlobKindV1,
} from "./types.ts";

export const WAGYU_CERTIFICATION_EXPRESSION_V1 =
  "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";

export const IC_CERTIFICATE_HEADER = "ic-certificate";
export const IC_CERTIFICATE_EXPRESSION_HEADER = "ic-certificateexpression";

const CACHE_CONTROL: Readonly<Record<CertifiedBlobKindV1, string>> = {
  immutable_blob: "public, max-age=31536000, immutable",
  mutable_blob: "no-cache, must-revalidate",
};

const COMMON_HEADERS = [
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
] as const;

const FORBIDDEN_VISIBLE_HEADERS = [
  "location",
  "set-cookie",
  "content-range",
  "accept-ranges",
  "content-disposition",
] as const;

// Cross-origin Fetch exposes the safelisted response headers plus the exact
// names in Access-Control-Expose-Headers. The remaining fixed security/CORS
// headers are still bound by the HTTP V2 leaf: callers reconstruct them below
// instead of trusting or requiring browser visibility.
const DIRECTLY_CHECKED_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-digest",
  "etag",
  "cache-control",
  "ic-certificateexpression",
]);

export function expectedCertifiedHeaders(
  kind: CertifiedBlobKindV1,
  bodyLength: number,
  bodyDigest: Uint8Array,
): readonly (readonly [string, string])[] {
  if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) {
    throw new Error("Body length is invalid");
  }
  if (bodyDigest.byteLength !== 32) {
    throw new Error("Body digest must be 32 bytes");
  }
  return [
    ["Content-Type", "application/octet-stream"],
    ["Content-Length", bodyLength.toString(10)],
    ["Content-Digest", `sha-256=:${toBase64(bodyDigest)}:`],
    ["ETag", `"${toLowerHex(bodyDigest)}"`],
    ["Cache-Control", CACHE_CONTROL[kind]],
    ...COMMON_HEADERS,
    ["IC-CertificateExpression", WAGYU_CERTIFICATION_EXPRESSION_V1],
  ];
}

export function verifyVisibleResponseHeaders(
  headers: Headers,
  expected: readonly (readonly [string, string])[],
): void {
  for (const [name, value] of expected) {
    if (!DIRECTLY_CHECKED_HEADERS.has(name.toLowerCase())) continue;
    const actual = headers.get(name);
    if (actual === null) {
      throw new Error(
        `Response header ${name} was not visible; the trusted gateway did not expose the fixed certified header set`,
      );
    }
    if (actual !== value) {
      throw new Error(`Response header ${name} did not match the fixed policy`);
    }
  }
  const encoding = headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    throw new Error("Encoded Wagyu responses are forbidden");
  }
  for (const name of FORBIDDEN_VISIBLE_HEADERS) {
    if (headers.has(name)) {
      throw new Error(`Forbidden response header ${name}`);
    }
  }
  const certificateValues = headers.get(IC_CERTIFICATE_HEADER);
  if (certificateValues === null || certificateValues.length === 0) {
    throw new Error("Certified response omitted IC-Certificate");
  }
}

export function strictContentLength(headers: Headers): number {
  const value = headers.get("content-length");
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Content-Length must be one canonical decimal integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Content-Length exceeds the safe integer range");
  }
  return parsed;
}
