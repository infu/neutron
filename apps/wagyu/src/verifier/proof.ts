import { Cbor } from "@dfinity/agent";
import {
  copyBytes,
  fromCanonicalBase64,
} from "./bytes.ts";
import type {
  CertifiedHttpProofV1,
  ProofShapeLimitsV1,
} from "./types.ts";

export const DEFAULT_PROOF_LIMITS_V1: ProofShapeLimitsV1 = Object.freeze({
  maxSnapshotBytes: 5_500,
  maxCertificateBytes: 4_096,
  maxWitnessBytes: 4_096,
  maxExpressionPathBytes: 512,
  maxExpressionPathSegments: 14,
  maxTreeNodes: 512,
  maxTreeBlobBytes: 5_500,
});

const FIELD = /(?:^|,\s*)(certificate|tree|expr_path|version)=((?::[A-Za-z0-9+/]*={0,2}:)|(?:[0-9]+))(?=,\s*|$)/guy;

export function parseCertificateHeaderV2(
  value: string,
  limits: ProofShapeLimitsV1 = DEFAULT_PROOF_LIMITS_V1,
): CertifiedHttpProofV1 {
  if (typeof value !== "string" || value.length > 12_000) {
    throw new Error("IC-Certificate header is too large");
  }
  const fields = new Map<string, string>();
  let position = 0;
  while (position < value.length) {
    FIELD.lastIndex = position;
    const match = FIELD.exec(value);
    if (match === null || match.index !== position) {
      throw new Error("IC-Certificate header has invalid syntax");
    }
    const name = match[1]!;
    if (fields.has(name)) {
      throw new Error(`IC-Certificate header repeats ${name}`);
    }
    fields.set(name, match[2]!);
    position = FIELD.lastIndex;
  }
  if (
    fields.size !== 4 ||
    fields.get("version") !== "2" ||
    !fields.has("certificate") ||
    !fields.has("tree") ||
    !fields.has("expr_path")
  ) {
    throw new Error("IC-Certificate header is not the closed V2 shape");
  }
  const certificateCbor = decodeByteSequence(
    fields.get("certificate")!,
    "certificate",
    limits.maxCertificateBytes,
  );
  const witnessCbor = decodeByteSequence(
    fields.get("tree")!,
    "tree",
    limits.maxWitnessBytes,
  );
  const expressionPathCbor = decodeByteSequence(
    fields.get("expr_path")!,
    "expr_path",
    limits.maxExpressionPathBytes,
  );
  enforceSnapshotBounds(
    {
      certificateVersion: 2,
      certificateCbor,
      witnessCbor,
      expressionPathCbor,
      certificateTimeNs: null,
    },
    limits,
  );
  return {
    certificateVersion: 2,
    certificateCbor,
    witnessCbor,
    expressionPathCbor,
    certificateTimeNs: null,
  };
}

function decodeByteSequence(
  value: string,
  label: string,
  maximum: number,
): Uint8Array {
  if (value.length < 3 || value[0] !== ":" || value.at(-1) !== ":") {
    throw new Error(`${label} must use an RFC 8941 byte sequence`);
  }
  return fromCanonicalBase64(value.slice(1, -1), label, maximum);
}

export function validatePortableProofShape(
  proof: CertifiedHttpProofV1,
  limits: ProofShapeLimitsV1 = DEFAULT_PROOF_LIMITS_V1,
): CertifiedHttpProofV1 {
  if (proof.certificateVersion !== 2) {
    throw new Error("Only certificate version 2 is supported");
  }
  if (proof.certificateTimeNs === null || proof.certificateTimeNs <= 0n) {
    throw new Error("Portable proof must carry a positive certificate time");
  }
  enforceComponent(
    proof.certificateCbor,
    "Certificate",
    limits.maxCertificateBytes,
  );
  enforceComponent(proof.witnessCbor, "Witness", limits.maxWitnessBytes);
  enforceComponent(
    proof.expressionPathCbor,
    "Expression path",
    limits.maxExpressionPathBytes,
  );
  enforceSnapshotBounds(proof, limits);
  return {
    certificateVersion: 2,
    certificateCbor: copyBytes(proof.certificateCbor),
    witnessCbor: copyBytes(proof.witnessCbor),
    expressionPathCbor: copyBytes(proof.expressionPathCbor),
    certificateTimeNs: proof.certificateTimeNs,
  };
}

function enforceComponent(
  value: Uint8Array,
  label: string,
  maximum: number,
): void {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${label} must be nonempty bytes`);
  }
  if (value.byteLength > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes`);
  }
}

function enforceSnapshotBounds(
  proof: CertifiedHttpProofV1,
  limits: ProofShapeLimitsV1,
): void {
  // Conservative exact-Candid upper bound: three Blob lengths/tags, record
  // fields, version, and Nat64. It intentionally rejects at the edge rather
  // than admitting a proof that can exceed the 5,500-byte wire ceiling.
  const estimatedCandidBytes =
    proof.certificateCbor.byteLength +
    proof.witnessCbor.byteLength +
    proof.expressionPathCbor.byteLength +
    96;
  if (estimatedCandidBytes > limits.maxSnapshotBytes) {
    throw new Error(
      `Proof snapshot exceeds ${limits.maxSnapshotBytes} encoded bytes`,
    );
  }
}

export function decodeExpressionPath(
  encoded: Uint8Array,
  limits: ProofShapeLimitsV1 = DEFAULT_PROOF_LIMITS_V1,
): readonly string[] {
  if (encoded.byteLength === 0 || encoded.byteLength > limits.maxExpressionPathBytes) {
    throw new Error("Expression path exceeds its byte bound");
  }
  let decoded: unknown;
  try {
    decoded = Cbor.decode(encoded);
  } catch {
    throw new Error("Expression path is not valid CBOR");
  }
  if (!Array.isArray(decoded) || decoded.length > limits.maxExpressionPathSegments) {
    throw new Error("Expression path is not a bounded array");
  }
  const path: string[] = [];
  let totalUtf8Bytes = 0;
  for (const segment of decoded) {
    if (typeof segment !== "string") {
      throw new Error("Expression path contains a non-text segment");
    }
    const bytes = new TextEncoder().encode(segment);
    totalUtf8Bytes += bytes.byteLength;
    if (
      bytes.byteLength > 255 ||
      totalUtf8Bytes > limits.maxExpressionPathBytes
    ) {
      throw new Error("Expression path text exceeds its bound");
    }
    path.push(segment);
  }
  return path;
}

export function expectedExpressionPath(path: string): readonly string[] {
  if (
    path === "" ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("%") ||
    path.includes("\\") ||
    path.includes("//")
  ) {
    throw new Error("Certified path is not canonical");
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Certified path contains traversal");
  }
  return ["http_expr", ...segments, "<$>"];
}
