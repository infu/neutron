import { describe, expect, test } from "bun:test";
import { Cbor } from "@dfinity/agent";
import {
  createWagyuVerifier,
  expectedCertifiedHeaders,
  sha256,
  toBase64,
  toLowerHex,
  trustedWagyuNetworkConfig,
  type HttpCertificationAdapterV1,
} from "../src/verifier/index.ts";
import { createBrowserImmutableResponseCache } from "../src/worker/response_cache.ts";

const NODE = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const ROOT_KEY = new Uint8Array(32).fill(5);
const NETWORK = trustedWagyuNetworkConfig(
  ROOT_KEY,
  { origin: "https://icp0.io" },
).networkId;
const CERTIFICATE_TIME = 1_000_000_000_000n;

function proofHeader(): string {
  const path = Cbor.encode([
    "http_expr",
    "app",
    "wagyu",
    "_route",
    "protocol",
    "v1",
    "objects",
    "post",
    "sha256",
    "00".repeat(32),
    "<$>",
  ]);
  return `certificate=:AQ==:, tree=:Ag==:, expr_path=:${toBase64(path)}:, version=2`;
}

function verifiedAdapter(onVerify?: () => void): HttpCertificationAdapterV1 {
  return {
    name: "test-verified",
    available: true,
    async verify() {
      onVerify?.();
      return {
        state: "verified",
        evidence: {
          certificateTimeNs: CERTIFICATE_TIME,
          certifiedDataRoot: new Uint8Array(32),
          witnessRoot: new Uint8Array(32),
        },
      };
    },
  };
}

async function certifiedResponse(
  url: string,
  body: Uint8Array,
  kind: "immutable_blob" | "mutable_blob" = "immutable_blob",
): Promise<Response> {
  const digest = await sha256(body);
  const headers = new Headers();
  for (const [name, value] of expectedCertifiedHeaders(
    kind,
    body.byteLength,
    digest,
  )) {
    if ([
      "content-type",
      "content-length",
      "content-digest",
      "etag",
      "cache-control",
      "ic-certificateexpression",
    ].includes(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("IC-Certificate", proofHeader());
  const bodyCopy = new Uint8Array(body.byteLength);
  bodyCopy.set(body);
  const response = new Response(bodyCopy.buffer, { status: 200, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("high-level certified fetch", () => {
  test("uses anonymous no-redirect GET and releases bytes only after all checks", async () => {
    const body = new TextEncoder().encode("exact-post-candid");
    const digest = await sha256(body);
    let adapterCalls = 0;
    let capturedInit: RequestInit | undefined;
    const target = {
      kind: "action",
      actionKind: "post",
      digest,
    } as const;
    const expectedUrl =
      `https://${NODE}.icp0.io/app/wagyu/_route/protocol/v1/objects/post/sha256/` +
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const verifier = createWagyuVerifier({
      network: {
        rootKey: ROOT_KEY,
        networkId: NETWORK,
        gateway: { origin: "https://icp0.io" },
      },
      adapter: verifiedAdapter(() => {
        adapterCalls += 1;
      }),
      fetch: (async (
        url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        expect(url).toBe(expectedUrl);
        capturedInit = init;
        return certifiedResponse(expectedUrl, body);
      }) as unknown as typeof fetch,
    });
    const result = await verifier.fetchAndVerify({
      actor: NODE,
      target,
      decoder: {
        decodeAndValidate(exact, context) {
          expect(context.networkId).toEqual(NETWORK);
          return new TextDecoder().decode(exact);
        },
      },
    });
    expect(result.state).toBe("verified");
    if (result.state === "verified") {
      expect(result.value).toBe("exact-post-candid");
      expect(result.body).toEqual(body);
      expect(result.highWater).toBeNull();
    }
    expect(adapterCalls).toBe(1);
    expect(capturedInit).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      mode: "cors",
    });
  });

  test("untrusted digest/path mismatch stays unavailable before crypto or semantics", async () => {
    const body = new TextEncoder().encode("hostile");
    let adapterCalls = 0;
    let decoderCalls = 0;
    const target = {
      kind: "action",
      actionKind: "post",
      digest: new Uint8Array(32),
    } as const;
    const path =
      `https://${NODE}.icp0.io/app/wagyu/_route/protocol/v1/objects/post/sha256/${"00".repeat(32)}`;
    const verifier = createWagyuVerifier({
      network: {
        rootKey: ROOT_KEY,
        networkId: NETWORK,
        gateway: { origin: "https://icp0.io" },
      },
      adapter: verifiedAdapter(() => {
        adapterCalls += 1;
      }),
      fetch: (async () =>
        certifiedResponse(path, body)) as unknown as typeof fetch,
    });
    const result = await verifier.fetchAndVerify({
      actor: NODE,
      target,
      decoder: {
        decodeAndValidate() {
          decoderCalls += 1;
          return "never";
        },
      },
    });
    expect(result).toMatchObject({
      state: "unavailable",
      code: "untrusted_live_response",
    });
    expect(adapterCalls).toBe(0);
    expect(decoderCalls).toBe(0);
  });

  test("distinguishes a hidden digest header from a conflicting value", async () => {
    const body = new TextEncoder().encode("exact-certified-body");
    const digest = await sha256(body);
    const target = {
      kind: "action",
      actionKind: "post",
      digest,
    } as const;
    const path =
      `https://${NODE}.icp0.io/app/wagyu/_route/protocol/v1/objects/post/sha256/${toLowerHex(digest)}`;

    for (const fixture of [
      {
        expectedReason: "Content-Digest was not visible",
        mutate(headers: Headers) {
          headers.delete("Content-Digest");
        },
      },
      {
        expectedReason: "Content-Digest did not match the fixed policy",
        mutate(headers: Headers) {
          headers.set("Content-Digest", "sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:");
        },
      },
    ]) {
      let adapterCalls = 0;
      let decoderCalls = 0;
      const response = await certifiedResponse(path, body);
      fixture.mutate(response.headers);
      const verifier = createWagyuVerifier({
        network: {
          rootKey: ROOT_KEY,
          networkId: NETWORK,
          gateway: { origin: "https://icp0.io" },
        },
        adapter: verifiedAdapter(() => {
          adapterCalls += 1;
        }),
        fetch: (async () => response) as unknown as typeof fetch,
      });
      const result = await verifier.fetchAndVerify({
        actor: NODE,
        target,
        decoder: {
          decodeAndValidate() {
            decoderCalls += 1;
            return "never";
          },
        },
      });
      expect(result).toMatchObject({
        state: "unavailable",
        code: "untrusted_live_response",
      });
      if (result.state !== "verified") {
        expect(result.reason).toContain(fixture.expectedReason);
      }
      expect(adapterCalls).toBe(0);
      expect(decoderCalls).toBe(0);
    }
  });

  test("classifies live trust failures as unavailable and semantic invalidity as terminal", async () => {
    const body = new TextEncoder().encode("live-post");
    const digest = await sha256(body);
    const target = {
      kind: "action",
      actionKind: "post",
      digest,
    } as const;
    const path =
      `https://${NODE}.icp0.io/app/wagyu/_route/protocol/v1/objects/post/sha256/${toLowerHex(digest)}`;
    let decoderCalls = 0;
    const run = (
      adapter: HttpCertificationAdapterV1,
      fetcher: typeof fetch,
      semanticInvalid = false,
    ) =>
      createWagyuVerifier({
        network: {
          rootKey: ROOT_KEY,
          networkId: NETWORK,
          gateway: { origin: "https://icp0.io" },
        },
        adapter,
        fetch: fetcher,
      }).fetchAndVerify({
        actor: NODE,
        target,
        decoder: {
          decodeAndValidate() {
            decoderCalls += 1;
            if (semanticInvalid) throw new Error("Invalid certified semantics");
            return "decoded";
          },
        },
      });

    const missing = new Response(null, { status: 404 });
    Object.defineProperty(missing, "url", { value: path });
    const raw = await run(
      verifiedAdapter(),
      (async () => missing) as unknown as typeof fetch,
    );
    expect(raw).toMatchObject({ state: "unavailable", code: "http_404" });

    const cryptoInvalid = await run(
      {
        name: "test-invalid",
        available: true,
        async verify() {
          return {
            state: "invalid",
            code: "invalid_http_certification",
            reason: "The proof names another canister",
          };
        },
      },
      (async () =>
        certifiedResponse(path, body)) as unknown as typeof fetch,
    );
    expect(cryptoInvalid).toMatchObject({
      state: "unavailable",
      code: "untrusted_live_response",
    });
    expect(decoderCalls).toBe(0);

    const semanticInvalid = await run(
      verifiedAdapter(),
      (async () =>
        certifiedResponse(path, body)) as unknown as typeof fetch,
      true,
    );
    expect(semanticInvalid).toMatchObject({
      state: "invalid",
      code: "invalid_wagyu_semantics",
    });
    expect(decoderCalls).toBe(1);
  });

  test("hashes only the exact Uint8Array view, not its backing buffer", async () => {
    const backing = new Uint8Array(96).fill(0xee);
    const body = backing.subarray(17, 47);
    body.set(new TextEncoder().encode("bounded byte view"));
    const exact = body.slice();
    const digest = await sha256(exact);
    const target = {
      kind: "action",
      actionKind: "post",
      digest,
    } as const;
    const path =
      `https://${NODE}.icp0.io/app/wagyu/_route/protocol/v1/objects/post/sha256/${toLowerHex(digest)}`;
    const verifier = createWagyuVerifier({
      network: {
        rootKey: ROOT_KEY,
        networkId: NETWORK,
        gateway: { origin: "https://icp0.io" },
      },
      adapter: verifiedAdapter(),
      fetch: (async () =>
        certifiedResponse(path, body)) as unknown as typeof fetch,
    });
    const result = await verifier.fetchAndVerify({
      actor: NODE,
      target,
      decoder: {
        decodeAndValidate(bytes) {
          return bytes;
        },
      },
    });
    expect(result.state).toBe("verified");
    if (result.state === "verified") {
      expect(result.body).toEqual(exact);
      expect(result.body.byteLength).toBe(30);
    }
  });

  test("re-verifies a bounded CacheStorage hit with its exact reconstructed URL", async () => {
    const body = new TextEncoder().encode("cacheable-post");
    const digest = await sha256(body);
    const target = {
      kind: "action",
      actionKind: "post",
      digest,
    } as const;
    const expectedUrl =
      `https://${NODE}.icp0.io/app/wagyu/_route/protocol/v1/objects/post/sha256/${toLowerHex(digest)}`;
    let networkReads = 0;
    const cache = createBrowserImmutableResponseCache(
      toLowerHex(NETWORK),
      (async () => {
        networkReads += 1;
        return certifiedResponse(expectedUrl, body);
      }) as unknown as typeof globalThis.fetch,
      fakeCacheStorage() as unknown as CacheStorage,
    );
    const verifier = createWagyuVerifier({
      network: {
        rootKey: ROOT_KEY,
        networkId: NETWORK,
        gateway: { origin: "https://icp0.io" },
      },
      adapter: verifiedAdapter(),
      fetch: cache.fetch,
    });
    const request = {
      actor: NODE,
      target,
      decoder: {
        decodeAndValidate(exact: Uint8Array) {
          return new TextDecoder().decode(exact);
        },
      },
    } as const;

    const first = await verifier.fetchAndVerify(request);
    expect(first.state).toBe("verified");
    await cache.commit(expectedUrl);
    const hit = await verifier.fetchAndVerify(request);
    expect(hit.state).toBe("verified");
    await cache.commit(expectedUrl);
    expect(networkReads).toBe(1);
  });

  test("mutable targets require freshness and high-water before success", async () => {
    const body = new TextEncoder().encode("profile");
    const path = `https://${NODE}.icp0.io/app/wagyu/_route/protocol/v1/profile`;
    const verifier = createWagyuVerifier({
      network: {
        rootKey: ROOT_KEY,
        networkId: NETWORK,
        gateway: { origin: "https://icp0.io" },
      },
      adapter: verifiedAdapter(),
      fetch: (async () =>
        certifiedResponse(
          path,
          body,
          "mutable_blob",
        )) as unknown as typeof fetch,
    });
    expect((await verifier.fetchAndVerify({
      actor: NODE,
      target: { kind: "profile" },
      decoder: { decodeAndValidate: () => "profile" },
    })).state).toBe("invalid");

    const result = await verifier.fetchAndVerify({
      actor: NODE,
      target: { kind: "profile" },
      decoder: { decodeAndValidate: () => "profile" },
      mutable: {
        freshness: { nowNs: CERTIFICATE_TIME + 1n },
        checkHighWater: () => ({ state: "advance" }),
      },
    });
    expect(result.state).toBe("verified");
    if (result.state === "verified") expect(result.highWater).toBe("advance");
  });

  test("zero network IDs and unconfigured roots fail at construction", () => {
    expect(() =>
      createWagyuVerifier({
        network: {
          rootKey: ROOT_KEY,
          networkId: new Uint8Array(32),
          gateway: { origin: "https://icp0.io" },
        },
        adapter: verifiedAdapter(),
      })
    ).toThrow("unconfigured");
    expect(() =>
      createWagyuVerifier({
        network: {
          rootKey: new Uint8Array(),
          networkId: NETWORK,
          gateway: { origin: "https://icp0.io" },
        },
        adapter: verifiedAdapter(),
      })
    ).toThrow("root key");
  });
});

function fakeCacheStorage() {
  const entries = new Map<string, Response>();
  const cache = {
    async match(request: RequestInfo | URL) {
      return entries.get(requestUrl(request))?.clone();
    },
    async put(request: RequestInfo | URL, response: Response) {
      entries.set(requestUrl(request), response.clone());
    },
    async keys() {
      return [...entries.keys()].map((url) => new Request(url));
    },
    async delete(request: RequestInfo | URL) {
      return entries.delete(requestUrl(request));
    },
  };
  return {
    async open() {
      return cache;
    },
  };
}

function requestUrl(value: RequestInfo | URL): string {
  if (value instanceof Request) return value.url;
  return value instanceof URL ? value.href : value;
}
