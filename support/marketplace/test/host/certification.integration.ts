// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { ResponseVerificationErrorCode, verifyRequestResponsePair } from "@dfinity/response-verification";
import { IDL } from "@dfinity/candid";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

type Header = [string, string];
const tokens = { buyer: "1".padStart(64, "0"), publisher: "2".padStart(64, "0"), auditor: "3".padStart(64, "0") };
function request(url: string, token?: string) {
  return { url, method: "GET", headers: (token ? [["Authorization", `Bearer ${token}`]] : []) as Header[], body: new Uint8Array(), certificate_version: [2] };
}
function header(response: any, name: string) {
  const value = response.headers.find(([key]: Header) => key.toLowerCase() === name.toLowerCase())?.[1];
  assert.equal(typeof value, "string", `Missing ${name}`);
  return value as string;
}

export const cases: IntegrationCase[] = [{
  name: "Production certification removes stale success witnesses after access changes",
  scope: "http",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const fixture = await installFixture(pic, "certification_fixture", "test/certification_fixture.mo");
      const { actor, canisterId, wasmPath } = fixture;
      const [packagePath, sourcePath, imagePath] = await actor.initialize();
      const subnet = await pic.getCanisterSubnetId(canisterId);
      assert.ok(subnet);
      const rootKey = new Uint8Array(await pic.getPubKey(subnet));
      const verify = async (req: ReturnType<typeof request>, response: any) => {
        try {
          const result = verifyRequestResponsePair(
            req,
            { status_code: response.status_code, headers: response.headers, body: Uint8Array.from(response.body) },
            canisterId.toUint8Array(), BigInt(await pic.getTime()) * 1_000_000n, 300_000_000_000n, rootKey, 2,
          );
          assert.equal(result.verificationVersion, 2);
          assert.ok(result.response);
        } catch (cause) {
          throw new Error(`Certificate verification failed for ${req.url}, status ${response.status_code}, body ${response.body.length} bytes`, { cause });
        }
      };
      const read = async (req: ReturnType<typeof request>, status: number) => {
        const initial = await actor.http_request(req);
        assert.equal(initial.status_code, status);
        let next = initial.streaming_strategy[0]?.Callback.token;
        const continuation = next;
        const chunks = [Buffer.from(initial.body)];
        while (next) {
          const response = await actor.http_streaming_callback(next);
          chunks.push(Buffer.from(response.body));
          next = response.token[0];
        }
        const assembled = { ...initial, body: Buffer.concat(chunks) };
        await verify(req, assembled);
        if (status === 200) assert.equal(Number(header(initial, "Content-Length")), assembled.body.length);
        else assert.equal(assembled.body.length, 0);
        return { assembled, continuation };
      };
      const rejectsStaleWitness = async (req: ReturnType<typeof request>, oldSuccess: any, freshDenial: any) => {
        // An old certificate can still be inside the verifier's freshness window.
        // Use the newly signed certificate with the earlier success witness: it
        // must fail because the production refresh removed that success leaf.
        const currentCertificate = header(freshDenial, "IC-Certificate").match(/certificate=:[^:]+:/)?.[0];
        assert.ok(currentCertificate);
        const original = header(oldSuccess, "IC-Certificate");
        assert.notEqual(original.match(/certificate=:[^:]+:/)?.[0], currentCertificate);
        const forged = {
          ...oldSuccess,
          headers: oldSuccess.headers.map(([key, value]: Header) => [key, key.toLowerCase() === "ic-certificate" ? value.replace(/certificate=:[^:]+:/, currentCertificate) : value]),
        };
        await assert.rejects(() => verify(req, forged), (error: any) => error?.cause?.code === ResponseVerificationErrorCode.InvalidTreeRootHash);
      };

      // This coupled fixture intentionally exposes no alternate paid-artifact
      // Candid reader. It uses the production artifact and streaming callbacks.
      const names = fixture.idlFactory({ IDL })._fields.map(([name]: [string, unknown]) => name).sort();
      assert.deepEqual(names, ["buyerOwnershipRetained", "http_request", "http_streaming_callback", "initialize", "removeAuditor", "revokeCandidate", "revokeGrant", "setFree"].sort());
      await read(request(packagePath), 403);
      await read(request(sourcePath), 403);
      const image = await read(request(imagePath), 200);
      assert.equal(image.assembled.body.toString(), "public-listing-image");
      const successes = new Map<string, Awaited<ReturnType<typeof read>>>();
      for (const [role, token] of Object.entries(tokens)) {
        const success = await read(request(packagePath, token), 200);
        assert.ok(success.continuation, `${role} package uses production-sized streaming`);
        assert.equal(success.assembled.body.length, 1_048_576 + 17);
        assert.equal(header(success.assembled, "Content-Type"), "application/vnd.neutron.package");
        assert.deepEqual(success.assembled.body, Buffer.concat([Buffer.alloc(1_048_576, 65), Buffer.alloc(17, 66)]));
        successes.set(role, success);
        const source = await read(request(sourcePath, token), 200);
        assert.equal(header(source.assembled, "Content-Type"), "application/gzip");
        assert.equal(source.assembled.body.toString(), "private-offered-source");
      }

      await actor.setFree(true);
      const freeSuccess = await read(request(packagePath), 200);
      await read(request(sourcePath), 200);
      await actor.setFree(false);
      const paidAgain = await read(request(packagePath), 403);
      await rejectsStaleWitness(request(packagePath), freeSuccess.assembled, paidAgain.assembled);
      await read(request(sourcePath), 403);
      await read(request(packagePath, tokens.buyer), 200);

      await actor.revokeCandidate();
      assert.equal(await actor.buyerOwnershipRetained(), true);
      const buyerRequest = request(packagePath, tokens.buyer);
      const revokedBuyer = await read(buyerRequest, 403);
      await rejectsStaleWitness(buyerRequest, successes.get("buyer")!.assembled, revokedBuyer.assembled);
      await assert.rejects(() => actor.http_streaming_callback(successes.get("buyer")!.continuation));
      await read(request(sourcePath, tokens.buyer), 403);
      const hiddenImage = await read(request(imagePath), 403);
      await rejectsStaleWitness(request(imagePath), image.assembled, hiddenImage.assembled);
      for (const token of [tokens.publisher, tokens.auditor]) {
        await read(request(packagePath, token), 200);
        await read(request(sourcePath, token), 200);
      }

      await actor.removeAuditor();
      const auditRequest = request(packagePath, tokens.auditor);
      const removedAuditor = await read(auditRequest, 403);
      await rejectsStaleWitness(auditRequest, successes.get("auditor")!.assembled, removedAuditor.assembled);
      await assert.rejects(() => actor.http_streaming_callback(successes.get("auditor")!.continuation));
      await read(request(sourcePath, tokens.auditor), 403);
      await read(request(packagePath, tokens.publisher), 200);
      await read(request(sourcePath, tokens.publisher), 200);

      await actor.revokeGrant();
      const publisherRequest = request(packagePath, tokens.publisher);
      const revokedPublisher = await read(publisherRequest, 403);
      await rejectsStaleWitness(publisherRequest, successes.get("publisher")!.assembled, revokedPublisher.assembled);
      await assert.rejects(() => actor.http_streaming_callback(successes.get("publisher")!.continuation));
      await read(request(sourcePath, tokens.publisher), 403);

      await pic.upgradeCanister({ canisterId, wasm: wasmPath, arg: new Uint8Array(), upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.equal(await actor.buyerOwnershipRetained(), true);
      for (const token of Object.values(tokens)) {
        await read(request(packagePath, token), 403);
        await read(request(sourcePath, token), 403);
      }
      await read(request(imagePath), 403);
    } finally {
      await shutdown();
    }
  },
}];
