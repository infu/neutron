import { equalBytes, sha256 } from "./bytes.ts";
import { deriveNetworkId } from "../protocol/index.ts";
import { readBoundedResponseBody } from "../transport/bounded_response.ts";
import { createDfinityCertificationAdapter } from "./crypto.ts";
import { assertFreshCertificate } from "./freshness.ts";
import {
  expectedCertifiedHeaders,
  IC_CERTIFICATE_HEADER,
  strictContentLength,
  verifyVisibleResponseHeaders,
} from "./headers.ts";
import {
  assertExpectedGatewayUrl,
  createTrustedGateway,
  deriveGatewayUrl,
  maximumBodyBytes,
  responseKind,
  wagyuPath,
} from "./paths.ts";
import {
  parseCertificateHeaderV2,
  validatePortableProofShape,
} from "./proof.ts";
import { assertConfiguredNetworkId } from "./semantics.ts";
import {
  WAGYU_VERIFIER_VERSION,
  type CertifiedHttpProofV1,
  type ExpectedCertifiedResponseV1,
  type HttpCertificationAdapterV1,
  type MutableVerificationGuardV1,
  type SemanticDecoderV1,
  type TrustedGatewayV1,
  type TrustedWagyuNetworkConfigV1,
  type VerificationResultV1,
  type WagyuTargetV1,
} from "./types.ts";

export interface WagyuVerifierConfigV1 {
  readonly network: TrustedWagyuNetworkConfigV1;
  readonly fetch?: typeof globalThis.fetch;
  /** Tests or a future audited implementation may inject an equivalent adapter. */
  readonly adapter?: HttpCertificationAdapterV1;
}

export function trustedWagyuNetworkConfig(
  rootKey: Uint8Array,
  gateway: TrustedWagyuNetworkConfigV1["gateway"],
): TrustedWagyuNetworkConfigV1 {
  if (!(rootKey instanceof Uint8Array) || rootKey.byteLength === 0) {
    throw new Error("Pinned IC root key is not configured");
  }
  const pinned = rootKey.slice();
  return Object.freeze({
    rootKey: pinned,
    networkId: deriveNetworkId(pinned).slice(),
    gateway,
  });
}

export interface FetchAndVerifyRequestV1<T> {
  readonly actor: string;
  readonly target: WagyuTargetV1;
  readonly decoder: SemanticDecoderV1<T>;
  /**
   * Required for profile and like-head targets, forbidden for immutable
   * targets. The check runs only after cryptographic proof, freshness, and
   * semantic validation.
   */
  readonly mutable?: MutableVerificationGuardV1<T>;
  readonly signal?: AbortSignal;
}

export interface VerifyPortableRequestV1<T> {
  readonly actor: string;
  readonly target:
    | Extract<WagyuTargetV1, { readonly kind: "action" }>
    | Extract<WagyuTargetV1, { readonly kind: "like-batch" }>;
  readonly body: Uint8Array;
  readonly proof: CertifiedHttpProofV1;
  readonly decoder: SemanticDecoderV1<T>;
}

export interface WagyuVerifierV1 {
  readonly networkId: Uint8Array;
  readonly gateway: TrustedGatewayV1;
  readonly adapterName: string;
  fetchAndVerify<T>(
    request: FetchAndVerifyRequestV1<T>,
  ): Promise<VerificationResultV1<T>>;
  verifyPortable<T>(
    request: VerifyPortableRequestV1<T>,
  ): Promise<VerificationResultV1<T>>;
}

export function createWagyuVerifier(
  config: WagyuVerifierConfigV1,
): WagyuVerifierV1 {
  const networkId = assertConfiguredNetworkId(config.network.networkId).slice();
  if (
    !(config.network.rootKey instanceof Uint8Array) ||
    config.network.rootKey.byteLength === 0
  ) {
    throw new Error("Pinned IC root key is not configured");
  }
  const derivedNetworkId = deriveNetworkId(config.network.rootKey);
  if (!equalBytes(networkId, derivedNetworkId)) {
    throw new Error("Trusted network ID is not derived from the pinned IC root key");
  }
  const gateway = createTrustedGateway(config.network.gateway);
  const adapter = config.adapter ??
    createDfinityCertificationAdapter({ rootKey: config.network.rootKey });
  const fetcher = config.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new Error("Certified fetch is unavailable in this runtime");
  }

  return Object.freeze({
    networkId: networkId.slice(),
    gateway,
    adapterName: adapter.name,
    fetchAndVerify: <T>(
      request: FetchAndVerifyRequestV1<T>,
    ): Promise<VerificationResultV1<T>> =>
      fetchAndVerify(networkId, gateway, adapter, fetcher, request),
    verifyPortable: <T>(
      request: VerifyPortableRequestV1<T>,
    ): Promise<VerificationResultV1<T>> =>
      verifyPortable(networkId, adapter, request),
  });
}

async function fetchAndVerify<T>(
  networkId: Uint8Array,
  gateway: TrustedGatewayV1,
  adapter: HttpCertificationAdapterV1,
  fetcher: typeof globalThis.fetch,
  request: FetchAndVerifyRequestV1<T>,
): Promise<VerificationResultV1<T>> {
  const isMutable =
    request.target.kind === "profile" ||
    request.target.kind === "like-head" ||
    request.target.kind === "reply-index";
  if (isMutable !== (request.mutable !== undefined)) {
    return invalid(
      "mutable_guard_mismatch",
      isMutable
        ? "Mutable Wagyu responses require freshness and high-water checks"
        : "Immutable Wagyu responses cannot use mutable high-water policy",
    );
  }

  let expectedUrl: URL;
  try {
    expectedUrl = deriveGatewayUrl(gateway, request.actor, request.target);
  } catch (error) {
    return invalidError("invalid_fetch_target", error);
  }

  let response: Response;
  try {
    response = await fetcher(expectedUrl.href, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      mode: "cors",
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    return unavailableError("certified_fetch_failed", error);
  }
  try {
    if (response.redirected || response.type === "opaqueredirect") {
      throw new Error("Gateway redirect was rejected");
    }
    assertExpectedGatewayUrl(
      new URL(response.url),
      gateway,
      request.actor,
      request.target,
    );
    if (response.status !== 200) {
      return {
        state: "unavailable",
        code: `http_${response.status}`,
        reason:
          "The exact Wagyu object was not available as a certified 200 response",
      };
    }
    const declaredLength = strictContentLength(response.headers);
    const maximum = maximumBodyBytes(request.target);
    if (declaredLength > maximum) {
      throw new Error(`Response exceeds the ${maximum}-byte object limit`);
    }
    const body = await readBoundedResponseBody(
      response,
      declaredLength,
      "Certified response",
    );
    if (body.byteLength !== declaredLength) {
      throw new Error("Response body length does not match Content-Length");
    }
    const digest = await sha256(body);
    assertTargetDigest(request.target, digest);
    const kind = responseKind(request.target);
    const certifiedHeaders = expectedCertifiedHeaders(
      kind,
      body.byteLength,
      digest,
    );
    verifyVisibleResponseHeaders(response.headers, certifiedHeaders);
    const proof = parseCertificateHeaderV2(
      response.headers.get(IC_CERTIFICATE_HEADER)!,
    );
    const expected = expectedResponse(
      request.actor,
      request.target,
      digest,
      body.byteLength,
      certifiedHeaders,
    );
    const crypto = await adapter.verify(proof, expected);
    if (crypto.state === "unavailable") return crypto;
    if (crypto.state === "invalid") {
      // A live gateway response that fails cryptographic verification is not
      // evidence about the discovered author object. A broken or hostile
      // gateway must not be able to make Wagyu delete durable discovery state.
      return {
        state: "unavailable",
        code: "untrusted_live_response",
        reason: crypto.reason,
      };
    }

    if (request.mutable !== undefined) {
      try {
        assertFreshCertificate(
          crypto.evidence.certificateTimeNs,
          request.mutable.freshness,
        );
      } catch (error) {
        return unavailableError("stale_mutable_response", error);
      }
    }
    let value: T;
    try {
      value = await request.decoder.decodeAndValidate(body.slice(), {
        actor: request.actor,
        target: request.target,
        bodyDigest: digest.slice(),
        networkId: networkId.slice(),
      });
    } catch (error) {
      return invalidError("invalid_wagyu_semantics", error);
    }
    let highWater: "advance" | "replay" | null = null;
    if (request.mutable !== undefined) {
      let decision;
      try {
        decision = request.mutable.checkHighWater(value, digest.slice());
      } catch (error) {
        return invalidError("invalid_high_water_state", error);
      }
      if (decision.state === "reject") {
        return invalid(decision.code, decision.reason);
      }
      highWater = decision.state;
    }
    return verified(
      value,
      body,
      digest,
      expected.path,
      crypto.evidence.certificateTimeNs,
      highWater,
    );
  } catch (error) {
    // Header, length, digest, proof-shape, and URL failures all occur before
    // the response has established author authority. They remain retryable.
    return unavailableError("untrusted_live_response", error);
  }
}

async function verifyPortable<T>(
  networkId: Uint8Array,
  adapter: HttpCertificationAdapterV1,
  request: VerifyPortableRequestV1<T>,
): Promise<VerificationResultV1<T>> {
  try {
    const maximum = maximumBodyBytes(request.target);
    if (
      !(request.body instanceof Uint8Array) ||
      request.body.byteLength > maximum
    ) {
      throw new Error(`Portable body exceeds the ${maximum}-byte object limit`);
    }
    const body = request.body.slice();
    const digest = await sha256(body);
    assertTargetDigest(request.target, digest);
    const kind = responseKind(request.target);
    const certifiedHeaders = expectedCertifiedHeaders(
      kind,
      body.byteLength,
      digest,
    );
    const proof = validatePortableProofShape(request.proof);
    const expected = expectedResponse(
      request.actor,
      request.target,
      digest,
      body.byteLength,
      certifiedHeaders,
    );
    const crypto = await adapter.verify(proof, expected);
    if (crypto.state !== "verified") return crypto;
    let value: T;
    try {
      value = await request.decoder.decodeAndValidate(body.slice(), {
        actor: request.actor,
        target: request.target,
        bodyDigest: digest.slice(),
        networkId: networkId.slice(),
      });
    } catch (error) {
      return invalidError("invalid_wagyu_semantics", error);
    }
    return verified(
      value,
      body,
      digest,
      expected.path,
      crypto.evidence.certificateTimeNs,
      null,
    );
  } catch (error) {
    return invalidError("invalid_portable_proof", error);
  }
}

function expectedResponse(
  actor: string,
  target: WagyuTargetV1,
  digest: Uint8Array,
  length: number,
  certifiedHeaders: readonly (readonly [string, string])[],
): ExpectedCertifiedResponseV1 {
  return {
    actor,
    path: wagyuPath(target),
    method: "GET",
    status: 200,
    kind: responseKind(target),
    bodyDigest: digest.slice(),
    bodyLength: length,
    certifiedHeaders,
  };
}

function assertTargetDigest(
  target: WagyuTargetV1,
  digest: Uint8Array,
): void {
  const expected =
    target.kind === "action" || target.kind === "like-batch"
      ? target.digest
      : null;
  if (expected !== null && !equalBytes(expected, digest)) {
    throw new Error("Body digest does not match its content-addressed path");
  }
}

function verified<T>(
  value: T,
  body: Uint8Array,
  digest: Uint8Array,
  path: string,
  certificateTimeNs: bigint,
  highWater: "advance" | "replay" | null,
): VerificationResultV1<T> {
  return {
    state: "verified",
    value,
    body: body.slice(),
    bodyDigest: digest.slice(),
    path,
    certificateTimeNs,
    highWater,
    verifierVersion: WAGYU_VERIFIER_VERSION,
  };
}

function invalid(code: string, reason: string): VerificationResultV1<never> {
  return { state: "invalid", code, reason };
}

function invalidError(
  code: string,
  error: unknown,
): VerificationResultV1<never> {
  return invalid(code, errorMessage(error));
}

function unavailableError(
  code: string,
  error: unknown,
): VerificationResultV1<never> {
  return { state: "unavailable", code, reason: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Verification failed";
}
