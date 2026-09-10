// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

const token = "0000000000000000000000000000000000000000000000000000000000000001";
const privatePath = "/repo/v1/packages/private.neutron";
const publicPath = "/repo/v1/access.json";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Header = [string, string];

function request(url: string, headers: Header[] = [], method = "GET") {
  return { url, method, headers, body: new Uint8Array(), certificate_version: [2] };
}

export const cases: IntegrationCase[] = [{
  name: "HTTP v2 verifies grants, full streamed bytes, denials and revocation",
  scope: "http",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const { actor, canisterId, wasmPath } = await installFixture(pic, "http_fixture", "test/http_fixture.mo");
      const subnet = await pic.getCanisterSubnetId(canisterId);
      assert.ok(subnet);
      const rootKey = new Uint8Array(await pic.getPubKey(subnet));
      const verify = async (req: ReturnType<typeof request>, response: any) => {
        const result = verifyRequestResponsePair(
          req,
          { status_code: response.status_code, headers: response.headers, body: Uint8Array.from(response.body) },
          canisterId.toUint8Array(),
          BigInt(await pic.getTime()) * 1_000_000n,
          300_000_000_000n,
          rootKey,
          2,
        );
        assert.equal(result.verificationVersion, 2);
        assert.ok(result.response);
        return result;
      };
      const header = (response: any, name: string) => response.headers.find(([key]: Header) => key.toLowerCase() === name.toLowerCase())?.[1];
      const rejectsProof = (req: ReturnType<typeof request>, response: any) => assert.rejects(
        () => verify(req, response),
        (error: any) => {
          // A verifier runtime failure must not count as successful proof that
          // a modified request or response fails cryptographic verification.
          assert.ok([11, 17].includes(error?.code), `Expected certified path/hash rejection, received ${String(error)}`);
          return true;
        },
      );

      const publicRequest = request(publicPath);
      const publicResponse = await actor.http_request(publicRequest);
      assert.equal(publicResponse.status_code, 200);
      await verify(publicRequest, publicResponse);
      assert.equal(Number(header(publicResponse, "Content-Length")), publicResponse.body.length);
      for (const path of ["/", "/repo/v1/%61ccess.json", "/repo//v1/access.json"]) {
        const alias = request(path);
        const response = await actor.http_request(alias);
        assert.equal(response.status_code, 200);
        await verify(alias, response);
      }

      const privateRequest = request(privatePath, [["Authorization", `Bearer ${token}`]]);
      const initial = await actor.http_request(privateRequest);
      assert.equal(initial.status_code, 200);
      assert.equal(header(initial, "Cache-Control"), "private, no-store");
      assert.match(header(initial, "IC-CertificateExpression"), /certified_request_headers:\["authorization"\]/);
      assert.equal(initial.streaming_strategy.length, 1);
      const continuation = initial.streaming_strategy[0].Callback.token;
      let next: any = continuation;
      const chunks = [Buffer.from(initial.body)];
      while (next) {
        const response = await actor.http_streaming_callback(next);
        chunks.push(Buffer.from(response.body));
        next = response.token[0];
      }
      const assembled = { ...initial, body: Buffer.concat(chunks) };
      assert.equal(decoder.decode(assembled.body), "secret-part-1secret-part-2secret-part-3");
      await verify(privateRequest, assembled);

      // These assertions use the official response verifier against real IC
      // query certificates, not a second implementation of the tree formula.
      await rejectsProof(request(privatePath), assembled);
      await rejectsProof(request(privatePath, [["Authorization", `Bearer ${"2".repeat(64)}`]]), assembled);
      await rejectsProof(request("/repo/v1/packages/other.neutron", privateRequest.headers), assembled);
      await rejectsProof(privateRequest, { ...assembled, body: encoder.encode("altered") });
      await rejectsProof(privateRequest, { ...assembled, status_code: 201 });
      await rejectsProof(privateRequest, { ...assembled, headers: assembled.headers.map(([key, value]: Header) => [key, key.toLowerCase() === "cache-control" ? "public" : value]) });

      const head = request(privatePath, privateRequest.headers, "HEAD");
      const headResponse = await actor.http_request(head);
      assert.equal(headResponse.body.length, 0);
      assert.equal(headResponse.streaming_strategy.length, 0);
      await verify(head, headResponse);

      for (const invalid of [request(privatePath), request(privatePath, [["Authorization", "Bearer invalid"]]), request(privatePath, [...privateRequest.headers, ...privateRequest.headers])]) {
        const denied = await actor.http_request(invalid);
        assert.equal(denied.status_code, 403);
        assert.equal(denied.body.length, 0);
        assert.equal(denied.streaming_strategy.length, 0);
        await verify(invalid, denied);
      }
      const options = request(privatePath, [["Origin", "https://example.com"], ["Access-Control-Request-Headers", "authorization"]], "OPTIONS");
      const preflight = await actor.http_request(options);
      assert.equal(preflight.status_code, 204);
      assert.equal(header(preflight, "Access-Control-Allow-Headers"), "Authorization");
      await verify(options, preflight);

      for (const path of ["/missing", "/missing/", "/repo/v1/packages/missing.neutron", "/repo/v1/access.json/child", "/repo/v1/packages//missing"]) {
        const req = request(path);
        const missing = await actor.http_request(req);
        assert.equal(missing.status_code, 404);
        assert.equal(missing.body.length, 0);
        await verify(req, missing);
      }
      const encodedPrivate = request("/repo/v1/packages/%2fprivate.neutron");
      const encodedDenied = await actor.http_request(encodedPrivate);
      assert.equal(encodedDenied.status_code, 403);
      await verify(encodedPrivate, encodedDenied);

      await assert.rejects(() => actor.http_streaming_callback({ ...continuation, path: "/repo/v1/packages/other.neutron" }));
      await assert.rejects(() => actor.http_streaming_callback({ ...continuation, grant: [] }));
      await assert.rejects(() => actor.http_streaming_callback({ ...continuation, sha256: new Uint8Array(32) }));
      await assert.rejects(() => actor.http_streaming_callback({ ...continuation, index: 3n }));
      await actor.setEligibility(false);
      await assert.rejects(() => actor.http_streaming_callback(continuation));
      const ineligible = await actor.http_request(privateRequest);
      assert.equal(ineligible.status_code, 403);
      await verify(privateRequest, ineligible);
      await actor.setEligibility(true);
      await actor.revoke();
      const revoked = await actor.http_request(privateRequest);
      assert.equal(revoked.status_code, 403);
      await verify(privateRequest, revoked);
      await assert.rejects(() => actor.http_streaming_callback(continuation));
      // Revoking the private grant must preserve unrelated public metadata.
      await verify(publicRequest, await actor.http_request(publicRequest));
      // An actual same-principal upgrade must retain the revoked grant rather
      // than recreating its authorization during certificate-tree restoration.
      await pic.upgradeCanister({ canisterId, wasm: wasmPath, arg: new Uint8Array(), upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      const upgraded = await actor.http_request(privateRequest);
      assert.equal(upgraded.status_code, 403);
      await verify(privateRequest, upgraded);
      await assert.rejects(() => actor.http_streaming_callback(continuation));
      await verify(publicRequest, await actor.http_request(publicRequest));
    } finally {
      await shutdown();
    }
  },
}];
