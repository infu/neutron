import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  parseIsolatedPocketIcUrl,
  verifyPortableCorsInChromium,
} from "./browser_cors.ts";

const BODY = new TextEncoder().encode("portable certified body");
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");
const CONTENT_DIGEST =
  `sha-256=:${createHash("sha256").update(BODY).digest("base64")}:`;
const ETAG = `"${BODY_SHA256}"`;
const EXPRESSION = "default_certification(test)";
const CERTIFICATE = "certificate=:AQID:, tree=:BAUG:, expr_path=:BwgJ:, version=2";
const EXPOSE =
  "accept-ranges,content-length,content-range,x-request-id,x-ic-canister-id";

let target: Server;

beforeAll(async () => {
  target = createServer((request, response) => {
    const path = new URL(
      request.url ?? "/",
      "http://127.0.0.2:8000",
    ).pathname;
    const expose = path === "/wrong-expose"
      ? "content-length"
      : EXPOSE;
    const certificate = path === "/missing-proof" ? undefined : CERTIFICATE;
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": expose,
      "content-digest": CONTENT_DIGEST,
      "content-length": String(BODY.byteLength),
      "content-type": "application/octet-stream",
      etag: ETAG,
      ...(certificate === undefined ? {} : { "ic-certificate": certificate }),
      "ic-certificateexpression": EXPRESSION,
    });
    response.end(BODY);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    target.once("error", onError);
    target.listen(8000, "127.0.0.2", () => {
      target.off("error", onError);
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    target.close((error) => {
      if (
        error !== undefined &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
});

test(
  "a real cross-origin Chromium fetch sees the certified portable response",
  async () => {
    const evidence = await verifyPortableCorsInChromium({
      url: "http://aaaaa-aa.localhost:8000/portable",
      status: 200,
      body_bytes: BODY.byteLength,
      body_sha256: BODY_SHA256,
      content_digest: CONTENT_DIGEST,
      etag: ETAG,
      certificate_expression: EXPRESSION,
    });

    expect(evidence.request.harness_origin).not.toBe(
      evidence.request.target_origin,
    );
    expect(evidence.request.origin_header_exact).toBe(true);
    expect(evidence.request.remote_address).toEqual({
      ip: "127.0.0.2",
      port: 8000,
    });
    expect(evidence.response.body).toEqual({
      bytes: BODY.byteLength,
      sha256: BODY_SHA256,
    });
    expect(evidence.response.headers.map(({ name }) => name)).toEqual([
      "ic-certificate",
      "ic-certificateexpression",
      "content-length",
      "content-digest",
      "etag",
    ]);
    expect(evidence.response.headers.map(({ disposition }) => disposition))
      .toEqual([
        "hidden",
        "hidden",
        "visible_exactly",
        "hidden",
        "hidden",
      ]);
    expect(
      evidence.response.headers.find(({ name }) => name === "content-length")
        ?.browser,
    ).toEqual(
      evidence.response.headers.find(({ name }) => name === "content-length")
        ?.raw,
    );
  },
  30_000,
);

test(
  "missing proof material is rejected at the network boundary",
  async () => {
    await expect(
      verifyPortableCorsInChromium({
        url: "http://aaaaa-aa.localhost:8000/missing-proof",
        status: 200,
        body_bytes: BODY.byteLength,
        body_sha256: BODY_SHA256,
        content_digest: CONTENT_DIGEST,
        etag: ETAG,
        certificate_expression: EXPRESSION,
      }),
    ).rejects.toThrow(
      /lacks a bounded ic-certificate/u,
    );
  },
  30_000,
);

test(
  "an unpinned gateway expose-header rewrite is rejected",
  async () => {
    await expect(
      verifyPortableCorsInChromium({
        url: "http://aaaaa-aa.localhost:8000/wrong-expose",
        status: 200,
        body_bytes: BODY.byteLength,
        body_sha256: BODY_SHA256,
        content_digest: CONTENT_DIGEST,
        etag: ETAG,
        certificate_expression: EXPRESSION,
      }),
    ).rejects.toThrow(
      /unexpected access-control-expose-headers/u,
    );
  },
  30_000,
);

test("the qualification target accepts only canonical canister origins", () => {
  expect(
    parseIsolatedPocketIcUrl("http://aaaaa-aa.localhost:8000/portable").origin,
  ).toBe("http://aaaaa-aa.localhost:8000");
  expect(() =>
    parseIsolatedPocketIcUrl("http://127.0.0.1:8000/portable")
  ).toThrow("canonical canister.localhost:8000");
  expect(() =>
    parseIsolatedPocketIcUrl("http://aaaaa-aa.localhost:8001/portable")
  ).toThrow("canonical canister.localhost:8000");
  expect(() =>
    parseIsolatedPocketIcUrl("https://example.com/portable")
  ).toThrow("canonical canister.localhost:8000");
});
