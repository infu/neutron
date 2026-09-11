// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { buildMarketplace } from "../../scripts/build.ts";
import { prepareAsh, projectRoot } from "../../scripts/test-ash-runtime.ts";
import { installFixture, method, relayCall, session, wire, type IntegrationCase } from "./helpers.ts";

const previousPath = process.env.MARKETPLACE_LISTING_PREVIOUS_WASM;
const deployedHash = "7ec8262e5067d5e8c20c990767eeb5c214c7741bb1fb3cb1da4477efe29af0a5";
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const principal = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
function success<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected protocol success, got ${wire(result)}`);
  return result.ok;
}
function rejected(result: any, message: string) {
  assert.ok(result && "err" in result, `Expected listing rejection, got ${wire(result)}`);
  assert.equal(result.err.code, "listing");
  assert.equal(result.err.message, message);
}
const excerptError = "The app excerpt must be 255 characters or fewer.";
const descriptionError = "The app description must be 5000 characters or fewer.";

async function targetProtocol() {
  const directory = process.env.MARKETPLACE_LISTING_ARTIFACTS_DIR ?? await mkdtemp(path.join(os.tmpdir(), "marketplace-listing-text-"));
  await mkdir(directory, { recursive: true });
  const built = await buildMarketplace({ outputPath: path.join(directory, "marketplace.wasm") });
  const bytes = await readFile(built.wasmPath);
  const wasmPath = `${built.wasmPath}.gz`;
  await writeFile(wasmPath, gzipSync(bytes, { level: 9 }));
  const bindings = await (await prepareAsh()).bind(built.candidPath, path.join(directory, "marketplace"), projectRoot);
  const { idlFactory, init } = await import(pathToFileURL(bindings.jsPath).href);
  console.log(`Listing-text release module: ${built.wasmPath}; SHA-256: ${hash(bytes)}`);
  return { ...built, rawWasmPath: built.wasmPath, wasmPath, wasmHash: hash(bytes), idlFactory, init };
}

export const cases: IntegrationCase[] = [{
  name: `Listing text: Unicode bounds and saved data survive ${previousPath ? "exact deployed predecessor" : "same-module"} keep upgrade`,
  scope: "upgrade",
  async run() {
    const env = await session();
    try {
      const buyer = await installFixture(env.pic, "listing_text_relay", "test/fixtures/Relay.mo");
      const ledger = await installFixture(env.pic, "listing_text_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
      const oracle = await installFixture(env.pic, "listing_text_oracle", "test/fixtures/Oracle.mo");
      const compiled = await targetProtocol();
      const publisherPrincipal = principal(141), browserPrincipal = principal(142), auditorPrincipal = principal(143);
      const config = {
        admins: [publisherPrincipal], auditors: [auditorPrincipal], trustedPublishingPrincipal: [publisherPrincipal],
        reservations: [[{ appId: "reserved_listing", title: "Reserved app", publisher: publisherPrincipal }]],
        tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
        xrc: oracle.canisterId,
        fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
        referralTerms: { version: 7n, discountBps: 1250n, affiliateBps: 3000n, developerBps: 3000n },
      };
      const arg = IDL.encode(compiled.init({ IDL }), [config]);
      function actors(canisterId: Principal) {
        const as = (sender: Principal) => {
          const actor = env.pic.createActor(compiled.idlFactory, canisterId);
          actor.setPrincipal(sender);
          return actor;
        };
        const market = { ...compiled, canisterId, actor: env.pic.createActor(compiled.idlFactory, canisterId) };
        return {
          market, publisher: as(publisherPrincipal), browser: as(browserPrincipal), owner: as(buyer.canisterId),
          call: (name: string, value: unknown) => relayCall(buyer, market, name, [value], 1_000_000_000n),
        };
      }
      const listing = (appId: string) => ({
        appId, title: "Listing text fixture", summary: "Short excerpt", description: "Expanded description.",
        priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n,
      });
      async function registerPublishers(ctx: ReturnType<typeof actors>) {
        success(await ctx.publisher.publisher_profile_register({
          publisherId: "trustedpublisher", name: "Trusted publisher", description: "Listing text fixture.", feeVersion: 1n,
        }));
        success(await ctx.call("publisher_profile_register", {
          publisherId: "ordinarypublisher", name: "Ordinary publisher", description: "Charged listing text fixture.", feeVersion: 1n,
        }));
      }
      async function exerciseBounds(ctx: ReturnType<typeof actors>, prefix: string) {
        // Exercise both ingress paths; native cycle charging remains unchanged.
        for (const [kind, writer, reader] of [
          ["trusted", (input: unknown) => ctx.publisher.listing_save(input), ctx.publisher],
          ["ordinary", (input: unknown) => ctx.call("listing_save", input), ctx.owner],
        ] as const) {
          for (const [label, character] of [["ascii", "a"], ["unicode", "🚀"]] as const) {
            const input = { ...listing(`${prefix}_${kind}_${label}`), summary: character.repeat(255), description: character.repeat(5000) };
            const snapshot = () => reader.publisher_apps({ cursor: [], limit: 100n });
            const before = await snapshot();
            rejected(await writer({ ...input, summary: character.repeat(256) }), excerptError);
            rejected(await writer({ ...input, description: character.repeat(5001) }), descriptionError);
            assert.deepEqual(await snapshot(), before, "Rejected new listings do not change publisher records");
            const saved = success(await writer(input));
            assert.equal(saved.summary, input.summary);
            assert.equal(saved.description, input.description);
            const detail = await reader.app_detail(input.appId);
            const revised = { ...input, expectedRevision: [saved.revision] };
            rejected(await writer({ ...revised, summary: character.repeat(256) }), excerptError);
            rejected(await writer({ ...revised, description: character.repeat(5001) }), descriptionError);
            assert.deepEqual(await reader.app_detail(input.appId), detail, "Rejected edits retain the exact listing and revision");
            assert.deepEqual(success(await writer(input)), saved, "A stale exact retry remains a no-op");
          }
        }
        assert.equal(success(await ctx.publisher.listing_save({ ...listing(`${prefix}_empty`), description: "" })).description, "");
      }

      const freshId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
      await env.pic.installCode({ canisterId: freshId, wasm: compiled.wasmPath, arg });
      const fresh = actors(freshId);
      assert.equal(success(await fresh.publisher.app_detail("reserved_listing")).app.description, "");
      await registerPublishers(fresh);
      await exerciseBounds(fresh, "fresh");

      const previous = await readFile(previousPath ?? compiled.rawWasmPath);
      if (previousPath) {
        assert.equal(hash(previous), deployedHash, "Qualification uses the exact deployed predecessor");
        assert.notEqual(compiled.wasmHash, deployedHash);
        const compiler = await loadMotoko();
        try {
          const compatibility = await compiler.stableCompatible(
            await readFile(`${previousPath}.most`, "utf8"), await readFile(compiled.stableTypesPath!, "utf8"),
          );
          assert.equal(compatibility.compatible, true, `Existing memory remains compatible with the added publisher root: ${wire(compatibility.diagnostics)}`);
        } finally { await disposeMotokoCompiler(); }
        assert.deepEqual(method(compiled, "publisher_profile_register").annotations, [], "Publisher registration is an added update endpoint");
        assert.deepEqual(method(compiled, "publisher_profile").annotations, ["query"], "Public publisher reads remain queries");
      }
      const canisterId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
      await env.pic.installCode({ canisterId, wasm: gzipSync(previous, { level: 9 }), arg });
      const ctx = actors(canisterId);
      // An archived predecessor predates profiles and must be seeded using only
      // its original interface. The same-module fixture already requires them.
      if (!previousPath) await registerPublishers(ctx);
      success(await ctx.call("read_delegate_set", { browser: browserPrincipal, active: true, feeVersion: 1n }));
      success(await ctx.call("referral_get_or_create", { feeVersion: 1n }));
      const retainedInput = {
        ...listing("retained_listing"),
        summary: previousPath ? "🚀".repeat(256) : "Retained excerpt",
        description: previousPath ? "🚀".repeat(5001) : "Retained description",
      };
      const retained = success(await ctx.publisher.listing_save(retainedInput));
      async function upload(requestId: string, purpose: "package" | "source", bytes: Uint8Array) {
        success(await ctx.publisher.upload_begin({ requestId, appId: retained.appId, digest: digest(bytes), size: BigInt(bytes.length), mediaType: "application/octet-stream", purpose: { [purpose]: null }, feeVersion: 1n }));
        success(await ctx.publisher.upload_chunk({ requestId, offset: 0n, bytes, feeVersion: 1n }));
        const finished = success(await ctx.publisher.upload_finish({ requestId, feeVersion: 1n }));
        return { ...finished, path: purpose === "package" ? `/repo/v1/packages/${hash(bytes)}.neutron` : `/repo/v1/sources/${hash(bytes)}.source.v1.msgpack.gz` };
      }
      const pkg = await upload("retained-package", "package", Uint8Array.of(76, 73, 83, 84));
      const source = await upload("retained-source", "source", Uint8Array.of(83, 79, 85, 82, 67, 69));
      const candidate = success(await ctx.publisher.candidate_submit({ requestId: "retained-candidate", appId: retained.appId, version: 100n, artifactId: pkg.artifactId[0], sourceArtifactId: source.artifactId, dependencies: [], feeVersion: 1n }));
      const batchInput = { requestId: "retained-batch", candidates: [{ candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest }], analysis: "Inspected fixture package and source digests." };
      const receipt = success(await ctx.publisher.trusted_publish_batch(batchInput));
      const quote = success(await ctx.browser.purchase_quote({ requestId: "retained-acquisition", appIds: [retained.appId], ledger: ledger.canisterId, referralCode: [] }));
      success(await ctx.call("purchase", { quote, feeVersion: 1n }));
      const grant = { request_id: "a1".repeat(16), token: "b2".repeat(32), paths: [pkg.path, source.path], fee_version: 1n };
      success(await ctx.publisher.repo_access_v1(grant));
      const savedBytes = async () => Promise.all(grant.paths.map(async (url: string) => {
        const response = await ctx.market.actor.http_request({ url, method: "GET", headers: [["Authorization", `Bearer ${grant.token}`]], body: new Uint8Array(), certificate_version: [2] });
        assert.equal(response.status_code, 200);
        assert.ok(response.headers.some(([key]: [string, string]) => key.toLowerCase() === "ic-certificate"));
        return response.body;
      }));
      const snapshot = async () => ({
        info: await ctx.market.actor.marketplace_info(),
        detail: success(await ctx.browser.app_detail(retained.appId)),
        reservation: success(await ctx.publisher.app_detail("reserved_listing")),
        library: success(await ctx.browser.library_query({ cursor: [], limit: 20n })),
        earnings: success(await ctx.browser.earnings_query()),
        history: success(await ctx.browser.operation_history({ purchaseCursor: { start: null }, withdrawalCursor: { start: null }, limit: 20n })),
        purchase: success(await ctx.browser.purchase_status({ requestId: quote.request.requestId })),
        receipt: success(await ctx.publisher.trusted_publish_status({ requestId: batchInput.requestId })),
        bytes: await savedBytes(), ledger: await ledger.actor.stats(),
      });
      const before = await snapshot();
      assert.equal(before.library.apps.length, 1);
      await env.pic.upgradeCanister({ canisterId, wasm: compiled.wasmPath, arg, upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(await snapshot(), before, "Keep upgrade preserves listings, approvals, purchases, referrals, delegation, settings, receipts, blobs and access grants");
      if (previousPath) await registerPublishers(ctx);
      const registered = await snapshot();
      assert.deepEqual(success(await ctx.publisher.trusted_publish_batch(batchInput)), receipt, "Historical publication replay keeps its exact receipt");
      assert.equal(success(await ctx.publisher.listing_save(retainedInput)).revision, retained.revision, "Historical listing replay remains a no-op");
      if (previousPath) {
        rejected(await ctx.publisher.listing_save({ ...retainedInput, title: "Edited title", expectedRevision: [retained.revision] }), excerptError);
        rejected(await ctx.publisher.listing_save({ ...retainedInput, summary: "Valid excerpt", expectedRevision: [retained.revision] }), descriptionError);
      }
      assert.deepEqual(await snapshot(), registered, "Replays and rejected new revisions do not alter retained state");
      await exerciseBounds(ctx, "upgraded");
      const corrected = success(await ctx.publisher.listing_save({ ...retainedInput, summary: "Corrected excerpt", description: "Corrected expanded description", expectedRevision: [retained.revision] }));
      assert.equal(corrected.revision, retained.revision + 1n);
      const detail = success(await ctx.browser.app_detail(retained.appId));
      assert.equal(detail.candidate[0].id, candidate.id);
      assert.deepEqual(success(await ctx.publisher.trusted_publish_batch(batchInput)), receipt, "Listing edits do not change the old package publication receipt");
    } finally { await env.shutdown(); }
  },
}];
