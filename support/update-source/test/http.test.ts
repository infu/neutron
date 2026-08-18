import { describe, expect, test } from "bun:test";
import {
  readPackageAsset,
  readReleaseAsset,
  readSourceAsset,
  updateSourceOrigin,
} from "../src/http.ts";
import {
  PACKAGE_CONTENT_TYPE,
  PACKAGE_MAX_AGE_SECONDS,
  RELEASE_CONTENT_TYPE,
  RELEASE_MAX_AGE_SECONDS,
  SOURCE_CONTENT_TYPE,
  SOURCE_MAX_AGE_SECONDS,
  packageHeaders,
  releaseHeaders,
  sha256Hex,
  sourceHeaders,
} from "../src/model.ts";
import { serializeRepositoryReleaseRecord } from "neutron-tools/src/repository.ts";
import { MemoryAssetState, storedAsset } from "./memory_asset.ts";

const canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const origin = updateSourceOrigin({ canisterId });

describe("certified update-source HTTP", () => {
  test("exposes the complete certified HTTP v2 envelope to browsers", () => {
    for (const headers of [releaseHeaders("a".repeat(64)), packageHeaders("b".repeat(64))]) {
      const exposed = new Headers(headers).get("Access-Control-Expose-Headers");
      expect(exposed?.split(",").map((name) => name.trim())).toEqual([
        "Content-Length",
        "Content-Type",
        "ETag",
        "IC-Certificate",
        "IC-CertificateExpression",
      ]);
    }
  });

  test("accepts a certified v2 release with revalidation headers", async () => {
    const state = new MemoryAssetState();
    const bytes = serializeRepositoryReleaseRecord({
      protocol: "neutron-repo-v1",
      id: "alpha",
      version: 100,
      sha256: "a".repeat(64),
      size: 10,
    });
    state.seed(
      "/repo/v1/releases/alpha.json",
      storedAsset({
        bytes,
        contentType: RELEASE_CONTENT_TYPE,
        headers: releaseHeaders(sha256Hex(bytes)),
        maxAge: RELEASE_MAX_AGE_SECONDS,
      }),
    );
    const result = await readReleaseAsset({
      origin,
      path: "/repo/v1/releases/alpha.json",
      fetch: state.fetch(origin),
    });
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.record.id).toBe("alpha");
      expect(result.digest).toBe(sha256Hex(bytes));
    }
  });

  test("fails closed without a complete v2 proof envelope", async () => {
    const fetch = (async (input: string | URL | Request) => {
      const response = new Response("missing", { status: 404 });
      Object.defineProperty(response, "url", {
        value: typeof input === "string" ? input : input.toString(),
      });
      return response;
    }) as typeof globalThis.fetch;
    await expect(
      readReleaseAsset({
        origin,
        path: "/repo/v1/releases/alpha.json",
        fetch,
      }),
    ).rejects.toThrow("missing a certified HTTP v2 proof");
  });

  test("streams a multi-chunk package and checks exact bytes", async () => {
    const state = new MemoryAssetState();
    const bytes = new Uint8Array(2_200_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const digest = sha256Hex(bytes);
    const path = `/repo/v1/packages/${digest}.neutron`;
    state.seed(
      path,
      storedAsset({
        bytes,
        contentType: PACKAGE_CONTENT_TYPE,
        headers: packageHeaders(digest),
        maxAge: PACKAGE_MAX_AGE_SECONDS,
      }),
    );
    const result = await readPackageAsset({
      origin,
      path,
      expectedDigest: digest,
      expectedSize: bytes.byteLength,
      fetch: state.fetch(origin, 200_000),
    });
    expect(result.status).toBe("found");
  });

  test("streams immutable gzip source bytes and verifies exact identity", async () => {
    const state = new MemoryAssetState();
    const bytes = new Uint8Array(2_200_000);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 241;
    }
    const digest = sha256Hex(bytes);
    const path = `/repo/v1/sources/${digest}.source.v1.msgpack.gz`;
    state.seed(
      path,
      storedAsset({
        bytes,
        contentType: SOURCE_CONTENT_TYPE,
        headers: sourceHeaders(digest),
        maxAge: SOURCE_MAX_AGE_SECONDS,
      }),
    );

    const result = await readSourceAsset({
      origin,
      path,
      expectedDigest: digest,
      expectedSize: bytes.byteLength,
      fetch: state.fetch(origin, 200_000),
    });
    expect(result.status).toBe("found");
  });

  test("rejects decoded HTTP encoding or wrong source identity", async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 8, 0]);
    const digest = sha256Hex(bytes);
    const path = `/repo/v1/sources/${digest}.source.v1.msgpack.gz`;
    const headers = new Headers({
      "Content-Type": SOURCE_CONTENT_TYPE,
      "Content-Encoding": "gzip",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable, no-transform",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      ETag: `"${digest}"`,
      "IC-Certificate":
        "certificate=:YQ==:, tree=:Yg==:, expr_path=:Yw==:, version=2",
      "IC-CertificateExpression":
        "default_certification(ValidationArgs{no_request_certification: Empty{}})",
    });
    const encodedFetch = (async (input: string | URL | Request) => {
      const response = new Response(bytes, { status: 200, headers });
      Object.defineProperty(response, "url", {
        value: typeof input === "string" ? input : input.toString(),
      });
      return response;
    }) as typeof globalThis.fetch;

    await expect(
      readSourceAsset({
        origin,
        path,
        expectedDigest: digest,
        expectedSize: bytes.byteLength,
        fetch: encodedFetch,
      }),
    ).rejects.toThrow("not identity encoded");

    const state = new MemoryAssetState();
    state.seed(
      path,
      storedAsset({
        bytes,
        contentType: SOURCE_CONTENT_TYPE,
        headers: sourceHeaders(digest),
        maxAge: SOURCE_MAX_AGE_SECONDS,
      }),
    );
    await expect(
      readSourceAsset({
        origin,
        path,
        expectedDigest: "a".repeat(64),
        expectedSize: bytes.byteLength + 1,
        fetch: state.fetch(origin),
      }),
    ).rejects.toThrow(`expected ${bytes.byteLength + 1}`);
  });

  test("rejects a mutable cache policy and compressed package", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = sha256Hex(bytes);
    const path = `/repo/v1/packages/${digest}.neutron`;
    const baseHeaders = new Headers({
      "Content-Type": PACKAGE_CONTENT_TYPE,
      "Content-Encoding": "gzip",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      ETag: `"${digest}"`,
      "IC-Certificate":
        "certificate=:YQ==:, tree=:Yg==:, expr_path=:Yw==:, version=2",
      "IC-CertificateExpression":
        "default_certification(ValidationArgs{no_request_certification: Empty{}})",
    });
    const fetch = (async (input: string | URL | Request) => {
      const response = new Response(bytes, { status: 200, headers: baseHeaders });
      Object.defineProperty(response, "url", {
        value: typeof input === "string" ? input : input.toString(),
      });
      return response;
    }) as typeof globalThis.fetch;
    await expect(
      readPackageAsset({
        origin,
        path,
        expectedDigest: digest,
        expectedSize: bytes.byteLength,
        fetch,
      }),
    ).rejects.toThrow("wrong Cache-Control policy");
  });

  test("constructs only canonical canister origins", () => {
    expect(updateSourceOrigin({ canisterId })).toBe(
      `https://${canisterId}.icp0.io`,
    );
    expect(() => updateSourceOrigin({ canisterId: "aaaaa-aa" })).toThrow();
  });
});
