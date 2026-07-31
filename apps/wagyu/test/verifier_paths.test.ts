import { describe, expect, test } from "bun:test";
import {
  assertExpectedGatewayUrl,
  createTrustedGateway,
  deriveGatewayUrl,
  wagyuPath,
} from "../src/verifier/index.ts";

const NODE = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const DIGEST = new Uint8Array(32).fill(0xab);

describe("trusted Wagyu gateway derivation", () => {
  test("derives one canister subdomain and fixed protocol path", () => {
    const gateway = createTrustedGateway({ origin: "https://icp0.io" });
    const target = {
      kind: "action",
      actionKind: "post",
      digest: DIGEST,
    } as const;
    expect(deriveGatewayUrl(gateway, NODE, target).href).toBe(
      `https://${NODE}.icp0.io/app/wagyu/_route/protocol/v1/objects/post/sha256/${"ab".repeat(32)}`,
    );
    expect(wagyuPath({ kind: "profile" })).toBe(
      "/app/wagyu/_route/protocol/v1/profile",
    );
  });

  test("permits HTTP only for explicitly trusted loopback", () => {
    expect(
      createTrustedGateway({
        origin: "http://localhost:4943",
        allowInsecureLocalhost: true,
      }).origin,
    ).toBe("http://localhost:4943");
    expect(() =>
      createTrustedGateway({ origin: "http://localhost:4943" })
    ).toThrow("explicitly trusted loopback");
    expect(() =>
      createTrustedGateway({
        origin: "http://gateway.example",
        allowInsecureLocalhost: true,
      })
    ).toThrow();
  });

  test("rejects raw gateways, credentials, paths, queries, and fragments", () => {
    for (const origin of [
      "https://raw.icp0.io",
      "https://user@icp0.io",
      "https://icp0.io/path",
      "https://icp0.io/?x=1",
      "https://icp0.io/#x",
      "ftp://icp0.io",
    ]) {
      expect(() => createTrustedGateway({ origin })).toThrow();
    }
  });

  test("never accepts a caller-modified response URL", () => {
    const gateway = createTrustedGateway({ origin: "https://icp0.io" });
    const target = { kind: "like-head", postId: DIGEST } as const;
    const expected = deriveGatewayUrl(gateway, NODE, target);
    assertExpectedGatewayUrl(expected, gateway, NODE, target);
    for (const hostile of [
      `${expected.href}?x=1`,
      `${expected.href}#fragment`,
      expected.href.replace("icp0.io", "icp0.io:8443"),
      expected.href.replace(`${NODE}.`, `raw.${NODE}.`),
      expected.href.replace("https://", "https://user:pass@"),
    ]) {
      expect(() =>
        assertExpectedGatewayUrl(new URL(hostile), gateway, NODE, target)
      ).toThrow();
    }
  });

  test("requires canonical canister principals and 32-byte keys", () => {
    const gateway = createTrustedGateway({ origin: "https://icp0.io" });
    expect(() =>
      deriveGatewayUrl(gateway, "2vxsx-fae", { kind: "profile" })
    ).toThrow("canonical non-anonymous");
    expect(() =>
      wagyuPath({ kind: "like-batch", digest: new Uint8Array(31) })
    ).toThrow("32 bytes");
  });
});
