import {
  Cbor,
  Certificate,
  lookup_path,
  LookupPathStatus,
  reconstruct,
  type HashTree,
} from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import {
  copyBytes,
  decodeUnsignedLeb128,
  equalBytes,
  sha256,
  utf8,
} from "./bytes.ts";
import {
  certifiedRequestHashV2,
  certifiedResponseHashV2,
} from "./hash.ts";
import { WAGYU_CERTIFICATION_EXPRESSION_V1 } from "./headers.ts";
import {
  decodeExpressionPath,
  DEFAULT_PROOF_LIMITS_V1,
  expectedExpressionPath,
  validatePortableProofShape,
} from "./proof.ts";
import type {
  CertifiedHttpProofV1,
  CryptographicVerificationV1,
  ExpectedCertifiedResponseV1,
  HttpCertificationAdapterV1,
  ProofShapeLimitsV1,
} from "./types.ts";

export const unavailableCertificationAdapter: HttpCertificationAdapterV1 =
  Object.freeze({
    name: "unavailable",
    available: false,
    async verify(): Promise<CryptographicVerificationV1> {
      return {
        state: "unavailable",
        code: "crypto_adapter_unavailable",
        reason:
          "No IC certificate/HTTP V2 verifier is configured; bytes remain unverified",
      };
    },
  });

export interface DfinityAdapterConfigV1 {
  /** Pinned by the trusted build/runtime configuration, never remote input. */
  readonly rootKey: Uint8Array;
  readonly limits?: ProofShapeLimitsV1;
}

export function createDfinityCertificationAdapter(
  config: DfinityAdapterConfigV1,
): HttpCertificationAdapterV1 {
  if (
    !(config.rootKey instanceof Uint8Array) ||
    config.rootKey.byteLength < 32 ||
    config.rootKey.byteLength > 2_048
  ) {
    throw new Error("Pinned IC root key is missing or invalid");
  }
  const rootKey = copyBytes(config.rootKey);
  const limits = config.limits ?? DEFAULT_PROOF_LIMITS_V1;
  return Object.freeze({
  name: "@icp-sdk/core-certificate+bounded-http-v2",
    available: true,
    async verify(
      proof: CertifiedHttpProofV1,
      expected: ExpectedCertifiedResponseV1,
    ): Promise<CryptographicVerificationV1> {
      try {
        return await verifyDfinityProof(rootKey, limits, proof, expected);
      } catch (error) {
        return {
          state: "invalid",
          code: "invalid_http_certification",
          reason: error instanceof Error
            ? error.message
            : "IC certificate verification failed",
        };
      }
    },
  });
}

async function verifyDfinityProof(
  rootKey: Uint8Array,
  limits: ProofShapeLimitsV1,
  inputProof: CertifiedHttpProofV1,
  expected: ExpectedCertifiedResponseV1,
): Promise<CryptographicVerificationV1> {
  const proof = inputProof.certificateTimeNs === null
    ? validateLiveProofShape(inputProof, limits)
    : validatePortableProofShape(inputProof, limits);
  const principal = Principal.fromText(expected.actor);
  if (
    principal.toText() !== expected.actor ||
    principal.compareTo(Principal.anonymous()) === "eq" ||
    !isCanisterPrincipal(principal)
  ) {
    throw new Error("Expected actor is not a canonical canister principal");
  }

  const expressionPath = decodeExpressionPath(proof.expressionPathCbor, limits);
  const wantedExpressionPath = expectedExpressionPath(expected.path);
  if (!equalStringArrays(expressionPath, wantedExpressionPath)) {
    throw new Error("Certificate expression path does not select the Wagyu path");
  }

  let decodedWitness: unknown;
  try {
    decodedWitness = Cbor.decode(proof.witnessCbor);
  } catch {
    throw new Error("HTTP witness is not valid CBOR");
  }
  const witness = boundedHashTree(decodedWitness, limits);

  const certificate = await Certificate.create({
    certificate: proof.certificateCbor,
    rootKey,
    principal: { canisterId: principal },
    // Immutable proof snapshots intentionally remain historical evidence.
    // Mutable freshness is enforced against the authenticated `time` leaf by
    // the caller after this cryptographic check.
    disableTimeVerification: true,
  });
  const certifiedData = foundLookup(
    certificate.lookup_path([
      "canister",
      principal.toUint8Array(),
      "certified_data",
    ]),
    "certificate certified_data",
  );
  if (certifiedData.byteLength !== 32) {
    throw new Error("Certificate certified_data is not a 32-byte root");
  }
  const timeBytes = foundLookup(
    certificate.lookup_path(["time"]),
    "certificate time",
  );
  const certificateTimeNs = decodeUnsignedLeb128(
    timeBytes,
    "certificate time",
  );
  if (certificateTimeNs <= 0n) {
    throw new Error("Certificate time must be positive");
  }
  if (
    proof.certificateTimeNs !== null &&
    proof.certificateTimeNs !== certificateTimeNs
  ) {
    throw new Error("Portable proof time does not equal the certificate time");
  }

  const witnessRoot = await reconstruct(witness);
  if (!equalBytes(certifiedData, witnessRoot)) {
    throw new Error("HTTP witness root does not equal certified_data");
  }

  const expressionHash = await sha256(utf8(WAGYU_CERTIFICATION_EXPRESSION_V1));
  const requestHash = await certifiedRequestHashV2();
  const responseHash = await certifiedResponseHashV2(
    expected.certifiedHeaders,
    expected.bodyDigest,
  );
  const leafPath: Array<string | Uint8Array> = [
    ...wantedExpressionPath,
    expressionHash,
    requestHash,
    responseHash,
  ];
  const leaf = lookup_path(leafPath, witness);
  if (leaf.status !== LookupPathStatus.Found || leaf.value.byteLength !== 0) {
    throw new Error("HTTP witness does not reveal the exact certified response leaf");
  }
  return {
    state: "verified",
    evidence: {
      certificateTimeNs,
      certifiedDataRoot: copyBytes(certifiedData),
      witnessRoot: copyBytes(witnessRoot),
    },
  };
}

function isCanisterPrincipal(principal: Principal): boolean {
  const bytes = principal.toUint8Array();
  return bytes.byteLength > 0 && bytes.at(-1) === 0x01;
}

function validateLiveProofShape(
  proof: CertifiedHttpProofV1,
  limits: ProofShapeLimitsV1,
): CertifiedHttpProofV1 {
  // Header proofs have no redundant time field. Reuse portable validation with
  // a sentinel only for byte/CBOR bounds, then restore null.
  const bounded = validatePortableProofShape(
    { ...proof, certificateTimeNs: 1n },
    limits,
  );
  return { ...bounded, certificateTimeNs: null };
}

function foundLookup(
  result: ReturnType<Certificate["lookup_path"]>,
  label: string,
): Uint8Array {
  if (result.status !== LookupPathStatus.Found) {
    throw new Error(`${label} is absent or pruned`);
  }
  return result.value;
}

function equalStringArrays(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function boundedHashTree(
  root: unknown,
  limits: ProofShapeLimitsV1,
): HashTree {
  let nodes = 0;
  let blobBytes = 0;
  let boundedRoot: HashTree | null = null;
  const pending: Array<{
    value: unknown;
    assign: (tree: HashTree) => void;
  }> = [{
    value: root,
    assign: (tree) => {
      boundedRoot = tree;
    },
  }];

  while (pending.length > 0) {
    const { value, assign } = pending.pop()!;
    nodes += 1;
    if (nodes > limits.maxTreeNodes) {
      throw new Error("HTTP witness tree exceeds its node bound");
    }
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error("HTTP witness contains a malformed node");
    }
    const rawTag = value[0];
    const tag = typeof rawTag === "bigint" ? Number(rawTag) : rawTag;
    if (!Number.isInteger(tag)) {
      throw new Error("HTTP witness node tag is invalid");
    }
    switch (tag) {
      case 0:
        if (value.length !== 1) throw new Error("Malformed empty witness node");
        assign([0]);
        break;
      case 1: {
        if (value.length !== 3) throw new Error("Malformed fork witness node");
        const node: unknown[] = [1, [0], [0]];
        assign(node as HashTree);
        pending.push(
          {
            value: value[2],
            assign: (child) => {
              node[2] = child;
            },
          },
          {
            value: value[1],
            assign: (child) => {
              node[1] = child;
            },
          },
        );
        break;
      }
      case 2: {
        if (value.length !== 3) throw new Error("Malformed labeled witness node");
        const label = boundedTreeBytes(value[1], "witness label", 512);
        blobBytes += label.byteLength;
        if (blobBytes > limits.maxTreeBlobBytes) {
          throw new Error("HTTP witness blob budget exceeded");
        }
        const node: unknown[] = [2, label, [0]];
        assign(node as HashTree);
        pending.push({
          value: value[2],
          assign: (child) => {
            node[2] = child;
          },
        });
        break;
      }
      case 3: {
        if (value.length !== 2) throw new Error("Malformed leaf witness node");
        const leaf = boundedTreeBytes(
          value[1],
          "witness leaf",
          limits.maxTreeBlobBytes,
        );
        blobBytes += leaf.byteLength;
        if (blobBytes > limits.maxTreeBlobBytes) {
          throw new Error("HTTP witness blob budget exceeded");
        }
        assign([3, leaf as HashTree[1]] as HashTree);
        break;
      }
      case 4: {
        if (value.length !== 2) throw new Error("Malformed pruned witness node");
        const hash = boundedTreeBytes(value[1], "pruned witness hash", 32);
        if (hash.byteLength !== 32) {
          throw new Error("Pruned witness hash must be 32 bytes");
        }
        blobBytes += hash.byteLength;
        if (blobBytes > limits.maxTreeBlobBytes) {
          throw new Error("HTTP witness blob budget exceeded");
        }
        assign([4, hash as HashTree[1]] as HashTree);
        break;
      }
      default:
        throw new Error("HTTP witness contains an unknown node tag");
    }
  }
  if (boundedRoot === null) {
    throw new Error("HTTP witness contains no tree");
  }
  return boundedRoot;
}

function boundedTreeBytes(
  value: unknown,
  label: string,
  maximum: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) {
    throw new Error(`${label} is not bounded bytes`);
  }
  return value;
}
