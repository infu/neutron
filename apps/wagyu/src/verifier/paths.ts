import { Principal } from "@dfinity/principal";
import { requireBytes, toLowerHex } from "./bytes.ts";
import type {
  CertifiedBlobKindV1,
  TrustedGatewayConfigV1,
  TrustedGatewayV1,
  WagyuTargetV1,
} from "./types.ts";

export const WAGYU_PROTOCOL_PREFIX = "/app/wagyu/_route/protocol/v1";
export const WAGYU_PROFILE_PATH = `${WAGYU_PROTOCOL_PREFIX}/profile`;

const RAW_GATEWAY_LABEL = /(?:^|[.-])raw(?:[.-]|$)/iu;
const LOOPBACK_HOST = /^(?:localhost|[a-z0-9-]+\.localhost)$/iu;

export function canonicalNodeId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 63) {
    throw new Error("Node ID must be a bounded principal");
  }
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch {
    throw new Error("Node ID is not a principal");
  }
  const canonical = principal.toText();
  if (
    canonical !== value ||
    principal.compareTo(Principal.anonymous()) === "eq"
  ) {
    throw new Error("Node ID must be a canonical non-anonymous principal");
  }
  if (!isCanisterPrincipal(principal)) {
    throw new Error("Node ID must be a canister principal");
  }
  return canonical;
}

function isCanisterPrincipal(principal: Principal): boolean {
  const bytes = principal.toUint8Array();
  return bytes.byteLength > 0 && bytes.at(-1) === 0x01;
}

export function createTrustedGateway(
  config: TrustedGatewayConfigV1,
): TrustedGatewayV1 {
  if (typeof config.origin !== "string" || config.origin.length > 2_048) {
    throw new Error("Trusted gateway origin is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(config.origin);
  } catch {
    throw new Error("Trusted gateway origin is not an absolute URL");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "Trusted gateway must be an origin without credentials, path, query, or fragment",
    );
  }
  if (RAW_GATEWAY_LABEL.test(parsed.hostname)) {
    throw new Error("Raw gateways cannot be trusted for Wagyu");
  }
  if (parsed.protocol === "http:") {
    if (
      config.allowInsecureLocalhost !== true ||
      !LOOPBACK_HOST.test(parsed.hostname)
    ) {
      throw new Error("HTTP gateways are limited to explicitly trusted loopback");
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error("Trusted gateway must use HTTPS");
  }
  if (parsed.hostname.includes(":")) {
    throw new Error("Gateway hostname is not subdomain-compatible");
  }
  return Object.freeze({
    scheme: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    origin: parsed.origin,
  });
}

export function wagyuPath(target: WagyuTargetV1): string {
  switch (target.kind) {
    case "profile":
      return WAGYU_PROFILE_PATH;
    case "action": {
      const digest = requireBytes(target.digest, "Action digest", 32);
      return `${WAGYU_PROTOCOL_PREFIX}/objects/${target.actionKind}/sha256/${toLowerHex(digest)}`;
    }
    case "like-batch": {
      const digest = requireBytes(target.digest, "Like batch digest", 32);
      return `${WAGYU_PROTOCOL_PREFIX}/objects/like-batch/sha256/${toLowerHex(digest)}`;
    }
    case "like-head": {
      const postId = requireBytes(target.postId, "Post ID", 32);
      return `${WAGYU_PROTOCOL_PREFIX}/heads/likes/${toLowerHex(postId)}`;
    }
    case "reply-index": {
      const postId = requireBytes(target.postId, "Post ID", 32);
      return `${WAGYU_PROTOCOL_PREFIX}/heads/replies/${toLowerHex(postId)}`;
    }
  }
}

export function responseKind(
  target: WagyuTargetV1,
): CertifiedBlobKindV1 {
  switch (target.kind) {
    case "profile":
    case "like-head":
    case "reply-index":
      return "mutable_blob";
    case "action":
    case "like-batch":
      return "immutable_blob";
  }
}

export function maximumBodyBytes(target: WagyuTargetV1): number {
  switch (target.kind) {
    case "profile":
      return 266_240;
    case "like-head":
      return 4_096;
    case "reply-index":
      return 1_044_480;
    case "like-batch":
      return 983_040;
    case "action":
      return target.actionKind === "post" ? 1_044_480 : 1_048_576;
  }
}

export function deriveGatewayUrl(
  gateway: TrustedGatewayV1,
  actor: string,
  target: WagyuTargetV1,
): URL {
  const node = canonicalNodeId(actor);
  const port = gateway.port === "" ? "" : `:${gateway.port}`;
  const url = new URL(
    `${gateway.scheme}//${node}.${gateway.hostname}${port}${wagyuPath(target)}`,
  );
  assertExpectedGatewayUrl(url, gateway, node, target);
  return url;
}

export function assertExpectedGatewayUrl(
  actual: URL,
  gateway: TrustedGatewayV1,
  actor: string,
  target: WagyuTargetV1,
): void {
  const expected = `${gateway.scheme}//${canonicalNodeId(actor)}.${gateway.hostname}` +
    `${gateway.port === "" ? "" : `:${gateway.port}`}${wagyuPath(target)}`;
  if (
    actual.href !== expected ||
    actual.username !== "" ||
    actual.password !== "" ||
    actual.search !== "" ||
    actual.hash !== "" ||
    RAW_GATEWAY_LABEL.test(actual.hostname)
  ) {
    throw new Error("Response URL is not the derived trusted Wagyu URL");
  }
}
