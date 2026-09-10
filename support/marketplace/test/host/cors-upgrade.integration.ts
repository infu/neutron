// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { compileFixture, projectRoot } from "../../scripts/test-ash-runtime.ts";
import { installFixture, relayCall, session, wire, type IntegrationCase } from "./helpers.ts";

const deployedHash = "1bd60e9e252c7372d2e6939d3a3896fd0566c18abf4022bd4a49c8542f633d8b";
const previousProtocolPath = process.env.MARKETPLACE_PREVIOUS_PROTOCOL_WASM ?? process.env.OLD_PROTOCOL_WASM;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
function success<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected protocol success, got ${wire(result)}`);
  return result.ok;
}
type Header = [string, string];
function header(response: any, name: string): string {
  const value = response.headers.find(([key]: Header) => key.toLowerCase() === name.toLowerCase())?.[1];
  assert.equal(typeof value, "string", `Missing response header ${name}`);
  return value;
}
function exposesVary(response: any): boolean {
  return header(response, "Access-Control-Expose-Headers").split(",").some(value => value.trim().toLowerCase() === "vary");
}
function request(url: string, method = "GET", token?: string) {
  return { url, method, headers: (token ? [["Authorization", `Bearer ${token}`]] : []) as Header[], body: new Uint8Array(), certificate_version: [2] };
}

export const cases: IntegrationCase[] = [{
  name: `CORS upgrade from ${previousProtocolPath ? "exact deployed protocol" : "synthetic old-header protocol"} preserves state and rebuilds every certified route with browser-visible Vary`,
  scope: "upgrade",
  async run() {
    // Normal CI creates a disposable old-header baseline without requiring
    // private production artifacts. Release qualification instead sets
    // MARKETPLACE_PREVIOUS_PROTOCOL_WASM to the retained deployed module and
    // verifies its exact hash; no path downloads live canister bytes.
    let previous: Buffer;
    let temporary: string | undefined;
    if (previousProtocolPath) {
      try { previous = await readFile(previousProtocolPath); }
      catch (cause) { throw new Error(`Read the explicit prior protocol WASM at ${previousProtocolPath}`, { cause }); }
      assert.equal(sha256(previous), deployedHash, "The qualification baseline must be the exact retained deployed WASM");
    } else {
      temporary = await mkdtemp(path.join(os.tmpdir(), "marketplace-cors-baseline-"));
      try {
        await cp(path.join(projectRoot, "mo"), path.join(temporary, "mo"), { recursive: true });
        await symlink(path.join(projectRoot, ".ashroot"), path.join(temporary, ".ashroot"), "dir");
        const httpPath = path.join(temporary, "mo/Http.mo");
        const current = await readFile(httpPath, "utf8");
        const old = current.replace(/("Access-Control-Expose-Headers", "[^"\n]*), Vary"/g, '$1"');
        assert.equal(current.split(", Vary\"").length - old.split(", Vary\"").length, 2, "Only the two CORS expose values change in the synthetic baseline");
        await writeFile(httpPath, old);
        const baseline = await compileFixture("marketplace_cors_old_headers", path.join(temporary, "mo/main.mo"));
        previous = await readFile(baseline.rawWasmPath);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    const env = await session();
    try {
      const buyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const ledger = await installFixture(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
      const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
      const compiled = await compileFixture("marketplace_cors_upgrade", "mo/main.mo");
      assert.notEqual(compiled.wasmHash, deployedHash, "The target must include the CORS fix");
      const publisherPrincipal = identity(111), auditorPrincipal = identity(112), browserPrincipal = identity(113);
      const config = {
        admins: [buyer.canisterId], auditors: [auditorPrincipal], trustedPublishingPrincipal: [publisherPrincipal], reservations: [],
        tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
        xrc: oracle.canisterId,
        fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
        referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
      };
      const arg = IDL.encode(compiled.init({ IDL }), [config]);
      const canisterId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
      await env.pic.installCode({ canisterId, wasm: gzipSync(previous, { level: 9 }), arg });
      const actor = env.pic.createActor(compiled.idlFactory, canisterId);
      const market = { ...compiled, actor, canisterId };
      const as = (principal: ReturnType<typeof identity>) => {
        const result = env.pic.createActor(compiled.idlFactory, canisterId);
        result.setPrincipal(principal);
        return result;
      };
      const publisher = as(publisherPrincipal), auditor = as(auditorPrincipal), browser = as(browserPrincipal);
      const charged = async (name: string, value: unknown) => success(await relayCall(buyer, market, name, [value], 1_000_000_000n));
      const direct = async (name: string, value: unknown) => success(await publisher[name](value));
      const listing = (appId: string, priceUsdMicros: bigint) => ({
        appId, title: appId, summary: "CORS upgrade fixture", description: "Opaque bytes test storage and HTTP transport, not package-format validity.",
        priceUsdMicros, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n,
      });
      type Kind = "package" | "source" | "image";
      async function upload(appId: string, kind: Kind, bytes: Uint8Array, suffix = "") {
        const requestId = `${appId}-${kind}${suffix}`;
        await direct("upload_begin", { requestId, appId, digest: digest(bytes), size: BigInt(bytes.length), mediaType: kind === "image" ? "image/png" : "application/octet-stream", purpose: { [kind]: null }, feeVersion: 1n });
        for (let offset = 0; offset < bytes.length; offset += 262_144) {
          await direct("upload_chunk", { requestId, offset: BigInt(offset), bytes: bytes.slice(offset, offset + 262_144), feeVersion: 1n });
        }
        const result = await direct("upload_finish", { requestId, feeVersion: 1n });
        assert.equal(result.artifactId.length, 1);
        const hex = sha256(bytes);
        const url = kind === "package" ? `/repo/v1/packages/${hex}.neutron` : kind === "source" ? `/repo/v1/sources/${hex}.source.v1.msgpack.gz` : `/repo/v1/media/${hex}`;
        return { id: result.artifactId[0], url, bytes, requestId };
      }
      async function release(appId: string, price: bigint, byte: number, withImage: boolean) {
        const saved = await direct("listing_save", listing(appId, price));
        const pkg = await upload(appId, "package", new Uint8Array(price ? 1_048_593 : 29).fill(byte));
        const source = await upload(appId, "source", new Uint8Array(31).fill(byte + 1));
        const image = withImage ? await upload(appId, "image", new Uint8Array(23).fill(byte + 2)) : undefined;
        if (image) await direct("listing_save", { ...listing(appId, price), iconArtifact: [image.id], screenshots: [image.id], expectedRevision: [saved.revision] });
        const candidate = await direct("candidate_submit", { requestId: `${appId}-candidate`, appId, version: 100n, artifactId: pkg.id, sourceArtifactId: [source.id], dependencies: [], feeVersion: 1n });
        success(await auditor.audit_stamp({ requestId: `${appId}-audit`, candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest, decision: { approved: null }, analysis: "Inspected fixture byte identities", reason: [] }));
        return { appId, candidate, pkg, source, image };
      }

      const paid = await release("cors_paid", 1_000_000n, 61, true);
      const free = await release("cors_free", 0n, 71, false);
      const orphan = await upload(paid.appId, "source", new Uint8Array(19).fill(81), "-unsubmitted");
      const grant = { request_id: "ab".repeat(16), token: "cd".repeat(32), paths: [paid.pkg.url, paid.source.url], fee_version: 1n };
      success(await publisher.repo_access_v1(grant));
      await charged("read_delegate_set", { browser: browserPrincipal, active: true, feeVersion: 1n });
      const quote = success(await browser.purchase_quote({ requestId: "cors-free-acquisition", appIds: [free.appId], ledger: ledger.canisterId, referralCode: [] }));
      assert.equal(quote.amount, 0n);
      const acquisition = await charged("purchase", { quote, feeVersion: 1n });
      assert.ok("complete" in acquisition.order.state);
      const prepared = await charged("install_prepare", { requestId: "cors-free-install", appIds: [free.appId], feeVersion: 1n });
      const libraryBefore = success(await browser.library_query({ cursor: [], limit: 20n }));
      const uploadBefore = success(await publisher.upload_status({ requestId: orphan.requestId }));
      const infoBefore = await actor.marketplace_info();
      const candidateBefore = success(await auditor.audit_candidate(paid.candidate.id));
      assert.deepEqual(libraryBefore.apps.map((app: any) => app.appId), [free.appId]);

      const subnet = await env.pic.getCanisterSubnetId(canisterId);
      assert.ok(subnet);
      const rootKey = new Uint8Array(await env.pic.getPubKey(subnet));
      async function read(req: ReturnType<typeof request>, status: number, fixed: boolean, bytes?: Uint8Array) {
        const response = await actor.http_request(req);
        assert.equal(response.status_code, status, `${req.method} ${req.url}`);
        assert.equal(header(response, "Vary"), "Authorization");
        assert.equal(exposesVary(response), fixed, `${req.url} must expose Vary only after the deployed upgrade`);
        const continuation = response.streaming_strategy[0]?.Callback.token;
        let token = continuation;
        const chunks = [Buffer.from(response.body)];
        while (token) {
          const next = await actor.http_streaming_callback(token);
          chunks.push(Buffer.from(next.body));
          token = next.token[0];
        }
        const body = Buffer.concat(chunks);
        if (bytes) assert.deepEqual(body, Buffer.from(bytes));
        // PocketIC can advance sub-millisecond time between calls. Round the
        // verifier clock up by at most 1 ms rather than passing a fractional
        // JavaScript number to BigInt.
        const nowNs = BigInt(Math.ceil(await env.pic.getTime())) * 1_000_000n;
        const result = verifyRequestResponsePair(req, { status_code: response.status_code, headers: response.headers, body }, canisterId.toUint8Array(), nowNs, 300_000_000_000n, rootKey, 2);
        assert.equal(result.verificationVersion, 2);
        assert.ok(result.response);
        return continuation;
      }
      const missing = `/repo/v1/packages/${"00".repeat(32)}.neutron`;
      const checks: Array<{ req: ReturnType<typeof request>; status: number; bytes?: Uint8Array }> = [
        { req: request(paid.pkg.url, "GET", grant.token), status: 200, bytes: paid.pkg.bytes },
        { req: request(paid.source.url, "GET", grant.token), status: 200, bytes: paid.source.bytes },
        { req: request(paid.pkg.url), status: 403 },
        { req: request(free.pkg.url), status: 200, bytes: free.pkg.bytes },
        { req: request(free.source.url), status: 200, bytes: free.source.bytes },
        { req: request(paid.image!.url), status: 200, bytes: paid.image!.bytes },
        { req: request(orphan.url), status: 403 },
        { req: request(orphan.url, "OPTIONS"), status: 204 },
        { req: request(missing), status: 404 },
        { req: request(missing, "OPTIONS"), status: 204 },
        { req: request(free.pkg.url, "HEAD"), status: 200, bytes: new Uint8Array() },
        { req: request("/repo/v1/info.json"), status: 200 },
        { req: request(`/repo/v1/manifests/${prepared.manifestId}.json`), status: 200 },
      ];
      let retainedStream: any;
      for (const [index, check] of checks.entries()) {
        const stream = await read(check.req, check.status, false, check.bytes);
        if (index === 0) retainedStream = stream;
      }
      assert.ok(retainedStream, "The paid package exercises an existing streaming continuation");
      await env.pic.tick(100);
      await env.pic.upgradeCanister({
        canisterId, wasm: compiled.wasmPath, arg,
        upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
      });
      // No grant, listing, artifact, or acquisition update is issued after
      // upgrade. The protocol's upgrade hook alone must rebuild all proofs.
      for (const check of checks) await read(check.req, check.status, true, check.bytes);
      const resumed = await actor.http_streaming_callback(retainedStream);
      assert.deepEqual(Uint8Array.from(resumed.body), paid.pkg.bytes.slice(1_048_576));
      assert.deepEqual(success(await browser.library_query({ cursor: [], limit: 20n })), libraryBefore);
      assert.deepEqual(success(await publisher.upload_status({ requestId: orphan.requestId })), uploadBefore);
      assert.deepEqual(await actor.marketplace_info(), infoBefore);
      assert.deepEqual(success(await auditor.audit_candidate(paid.candidate.id)), candidateBefore);
      const purchase = success<any[]>(await browser.purchase_status({ requestId: quote.request.requestId }))[0];
      assert.equal(purchase.order.id, acquisition.order.id);
      assert.ok("complete" in purchase.order.state);
      assert.equal((await ledger.actor.stats()).appliedTransactions, 0n, "Free acquisition does not generate a ledger transfer");
    } finally { await env.shutdown(); }
  },
}];
