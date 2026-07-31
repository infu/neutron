export const WAGYU_VERIFIER_VERSION = "wagyu-verifier-v1";

export type ActionKindV1 = "post" | "share" | "tombstone" | "like";

export type WagyuTargetV1 =
  | { readonly kind: "action"; readonly actionKind: ActionKindV1; readonly digest: Uint8Array }
  | { readonly kind: "like-batch"; readonly digest: Uint8Array }
  | { readonly kind: "like-head"; readonly postId: Uint8Array }
  | { readonly kind: "reply-index"; readonly postId: Uint8Array }
  | { readonly kind: "profile" };

export type CertifiedBlobKindV1 = "immutable_blob" | "mutable_blob";

export interface TrustedGatewayConfigV1 {
  /**
   * A trusted non-raw gateway origin, for example `https://icp0.io` or
   * `http://localhost:4943`. Paths, credentials, queries, and fragments are
   * never accepted.
   */
  readonly origin: string;
  readonly allowInsecureLocalhost?: boolean;
}

export interface TrustedGatewayV1 {
  readonly scheme: "http:" | "https:";
  readonly hostname: string;
  readonly port: string;
  readonly origin: string;
}

export interface CertifiedHttpProofV1 {
  readonly certificateVersion: 2;
  readonly certificateCbor: Uint8Array;
  readonly witnessCbor: Uint8Array;
  readonly expressionPathCbor: Uint8Array;
  readonly certificateTimeNs: bigint | null;
}

export interface ProofShapeLimitsV1 {
  readonly maxSnapshotBytes: number;
  readonly maxCertificateBytes: number;
  readonly maxWitnessBytes: number;
  readonly maxExpressionPathBytes: number;
  readonly maxExpressionPathSegments: number;
  readonly maxTreeNodes: number;
  readonly maxTreeBlobBytes: number;
}

export interface ExpectedCertifiedResponseV1 {
  readonly actor: string;
  readonly path: string;
  readonly status: 200;
  readonly method: "GET";
  readonly kind: CertifiedBlobKindV1;
  readonly bodyDigest: Uint8Array;
  readonly bodyLength: number;
  readonly certifiedHeaders: readonly (readonly [string, string])[];
}

export interface CryptographicEvidenceV1 {
  readonly certificateTimeNs: bigint;
  readonly certifiedDataRoot: Uint8Array;
  readonly witnessRoot: Uint8Array;
}

export type CryptographicVerificationV1 =
  | {
      readonly state: "verified";
      readonly evidence: CryptographicEvidenceV1;
    }
  | {
      readonly state: "invalid";
      readonly code: string;
      readonly reason: string;
    }
  | {
      readonly state: "unavailable";
      readonly code: "crypto_adapter_unavailable";
      readonly reason: string;
    };

export interface HttpCertificationAdapterV1 {
  readonly name: string;
  readonly available: boolean;
  verify(
    proof: CertifiedHttpProofV1,
    expected: ExpectedCertifiedResponseV1,
  ): Promise<CryptographicVerificationV1>;
}

export interface MutableFreshnessPolicyV1 {
  readonly nowNs: bigint;
  readonly maxAgeNs?: bigint;
  readonly maxFutureSkewNs?: bigint;
}

export type VerificationFailureV1 = {
  readonly state: "invalid";
  readonly code: string;
  readonly reason: string;
} | {
  readonly state: "unavailable";
  readonly code: string;
  readonly reason: string;
};

export type VerificationResultV1<T> =
  | {
      readonly state: "verified";
      readonly value: T;
      readonly body: Uint8Array;
      readonly bodyDigest: Uint8Array;
      readonly path: string;
      readonly certificateTimeNs: bigint;
      readonly highWater: "advance" | "replay" | null;
      readonly verifierVersion: typeof WAGYU_VERIFIER_VERSION;
    }
  | VerificationFailureV1;

export interface SemanticDecoderV1<T> {
  /**
   * Decode under protocol-owned Candid limits and validate all semantic
   * bindings. This callback runs only after transport bytes and certification
   * have verified.
   */
  decodeAndValidate(
    exactBody: Uint8Array,
    context: {
      readonly actor: string;
      readonly target: WagyuTargetV1;
      readonly bodyDigest: Uint8Array;
      readonly networkId: Uint8Array;
    },
  ): T | Promise<T>;
}

export interface MutableVerificationGuardV1<T> {
  readonly freshness: MutableFreshnessPolicyV1;
  readonly checkHighWater: (
    value: T,
    bodyDigest: Uint8Array,
  ) => HighWaterDecisionV1;
}

export interface TrustedWagyuNetworkConfigV1 {
  /** Pinned locally by the build/runtime provisioning path. */
  readonly rootKey: Uint8Array;
  /** Derived locally from the pinned root; never learned from a peer. */
  readonly networkId: Uint8Array;
  readonly gateway: TrustedGatewayConfigV1;
}

export interface ProfileHighWaterV1 {
  readonly profileGeneration: bigint;
  readonly revision: bigint;
  readonly bodyDigest: Uint8Array;
}

export interface LikeHeadHighWaterV1 {
  readonly storeGeneration: bigint;
  readonly revision: bigint;
  readonly bodyDigest: Uint8Array;
}

export interface ReplyIndexHighWaterV1 {
  readonly storeGeneration: bigint;
  readonly revision: bigint;
  readonly bodyDigest: Uint8Array;
}

export type HighWaterDecisionV1 =
  | { readonly state: "advance" }
  | { readonly state: "replay" }
  | { readonly state: "reject"; readonly code: string; readonly reason: string };
