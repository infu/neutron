// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { compileFixture } from "../../scripts/test-ash-runtime.ts";
import { installFixture, relayCall, session, wire, type IntegrationCase } from "./helpers.ts";

const previousPath = process.env.MARKETPLACE_STOREFRONT_PREVIOUS_WASM;
const identity = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
function ok<T = any>(value: any): T { assert.ok(value && "ok" in value, wire(value)); return value.ok; }
function denied(value: any, code: string) { assert.equal(value?.err?.code, code, wire(value)); }

export const cases: IntegrationCase[] = [{
  name: `Storefront: admin edits, filtered charts and ${previousPath ? "predecessor" : "same-module"} keep upgrade preserve installed data`,
  scope: "upgrade",
  async run() {
    const env = await session();
    try {
      const compiled = await compileFixture("storefront_marketplace", "mo/main.mo");
      const ledger = await installFixture(env.pic, "storefront_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
      const oracle = await installFixture(env.pic, "storefront_oracle", "test/fixtures/Oracle.mo");
      const buyer = await installFixture(env.pic, "storefront_buyer", "test/fixtures/Relay.mo");
      const adminPrincipal = identity(191), outsiderPrincipal = identity(192);
      const config = {
        admins: [adminPrincipal], auditors: [], trustedPublishingPrincipal: [adminPrincipal], reservations: [],
        tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }], xrc: oracle.canisterId,
        fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
        referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
      };
      const arg = IDL.encode(compiled.init({ IDL }), [config]);
      const freshId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
      await env.pic.installCode({ canisterId: freshId, wasm: compiled.wasmPath, arg });
      const fresh = env.pic.createActor(compiled.idlFactory, freshId);
      const selection = { mode: { stable: null }, search: "", tag: [] };
      assert.deepEqual(ok(await fresh.storefront_query(selection)), { config: { tags: [], featured: [], revision: 0n }, featured: [] }, "Clean root initializes empty without changing any app defaults");
      const previous = await readFile(previousPath ?? compiled.rawWasmPath);
      if (previousPath) {
        const compiler = await loadMotoko();
        try {
          const comparison = await compiler.stableCompatible(await readFile(`${previousPath}.most`, "utf8"), await readFile(compiled.rawWasmPath + ".most", "utf8"));
          assert.equal(comparison.compatible, true, wire(comparison.diagnostics));
        } finally { await disposeMotokoCompiler(); }
      }
      const canisterId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
      await env.pic.installCode({ canisterId, wasm: gzipSync(previous), arg });
      const market = { ...compiled, canisterId, actor: env.pic.createActor(compiled.idlFactory, canisterId) };
      const admin = env.pic.createActor(compiled.idlFactory, canisterId); admin.setPrincipal(adminPrincipal);
      const outsider = env.pic.createActor(compiled.idlFactory, canisterId); outsider.setPrincipal(outsiderPrincipal);
      const owner = env.pic.createActor(compiled.idlFactory, canisterId); owner.setPrincipal(buyer.canisterId);
      ok(await admin.publisher_profile_register({ publisherId: "storefront", name: "Fixture creator", description: "Retained profile", feeVersion: 1n }));
      const ids = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "beta_only"];
      const candidates = [];
      let sequence = 0;
      async function upload(appId: string, purpose: "package" | "image") {
        const bytes = new TextEncoder().encode(purpose === "image" ? `<svg xmlns="http://www.w3.org/2000/svg"><title>${appId}-${sequence++}</title></svg>` : `package-${appId}`);
        const requestId = `${appId}-${purpose}-${sequence++}`;
        ok(await admin.upload_begin({ requestId, appId, purpose: { [purpose]: null }, mediaType: purpose === "image" ? "image/svg+xml" : "application/octet-stream", digest: digest(bytes), size: BigInt(bytes.length), feeVersion: 1n }));
        ok(await admin.upload_chunk({ requestId, offset: 0n, bytes, feeVersion: 1n }));
        return ok(await admin.upload_finish({ requestId, feeVersion: 1n })).artifactId[0];
      }
      const images = new Map<string, bigint>();
      for (const appId of ids) {
        const listing = { appId, title: appId, summary: "Existing excerpt", description: "Existing expanded description", priceUsdMicros: ["delta", "echo", "foxtrot"].includes(appId) ? 1_000_000n : 0n, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n };
        const first = ok(await admin.listing_save(listing));
        const image = await upload(appId, "image"); images.set(appId, image);
        ok(await admin.listing_save({ ...listing, screenshots: [image], expectedRevision: [first.revision] }));
        const pkg = await upload(appId, "package");
        candidates.push(ok(await admin.candidate_submit({ requestId: `${appId}-candidate`, appId, version: 100n, artifactId: pkg, sourceArtifactId: [], dependencies: [], feeVersion: 1n })));
      }
      ok(await admin.trusted_publish_beta_batch({ requestId: "storefront-beta", candidates: candidates.map(candidate => ({ candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest })), analysis: "Local fixture bytes", operation: "publish", channel: "beta" }));
      const promotion = ok(await admin.promotion_prepare({ appIds: ids.filter(id => id !== "beta_only") }));
      ok(await admin.release_promote({ requestId: "storefront-stable", entries: promotion.entries, feeVersion: 1n }));
      const quote = ok(await owner.purchase_quote({ requestId: "storefront-acquisition", appIds: ["alpha"], ledger: ledger.canisterId, referralCode: [] }));
      ok(await relayCall(buyer, market, "purchase", [{ quote, feeVersion: 1n }], 1_000_000_000n));
      const snapshot = async () => ({
        apps: await admin.publisher_apps({ cursor: [], limit: 100n }),
        library: await owner.library_query({ cursor: [], limit: 100n }),
        purchase: await owner.purchase_status({ requestId: "storefront-acquisition" }),
        profile: await admin.publisher_profile("storefront"),
        channels: await admin.app_detail_v2({ appId: "alpha", mode: { stable: null } }),
      });
      const before = await snapshot();
      await env.pic.upgradeCanister({ canisterId, wasm: compiled.wasmPath, arg, upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(await snapshot(), before, "Listings, ownership, acquisition, receipt, publisher and release heads survive predecessor upgrade");
      assert.equal(ok(await admin.storefront_query(selection)).config.revision, 0n);
      const settings = { tags: [{ id: "games", name: "Games" }, { id: "crypto", name: "Crypto" }], featured: ["alpha", "beta_only", "charlie"], expectedRevision: 0n };
      denied(await outsider.admin_storefront_set(settings), "admin_required");
      denied(await market.actor.admin_storefront_set(settings), "admin_required");
      const savedSettings = ok(await admin.admin_storefront_set(settings));
      assert.deepEqual(ok(await admin.admin_storefront_set(settings)), savedSettings, "Lost reply retry is an exact no-op");
      denied(await admin.admin_storefront_set({ ...settings, featured: ["bravo"] }), "storefront_conflict");
      for (const appId of ids) {
        const input = { appId, title: `Discover ${appId}`, subtitle: "An original short subtitle", tags: [appId === "bravo" ? "crypto" : "games"], coverArtifact: [images.get(appId)], expectedRevision: 0n };
        denied(await outsider.admin_storefront_app_set(input), "admin_required");
        const saved = ok(await admin.admin_storefront_app_set(input));
        assert.deepEqual(ok(await admin.admin_storefront_app_set(input)), saved);
        denied(await admin.admin_storefront_app_set({ ...input, title: "Stale edit" }), "storefront_conflict");
        denied(await admin.admin_storefront_app_set({ ...input, tags: ["unknown"], expectedRevision: saved.revision }), "storefront_input");
      }
      assert.deepEqual(await snapshot(), before, "Editorial edits do not alter released listing or purchase state");
      const home = ok(await market.actor.storefront_query(selection));
      assert.deepEqual(home.featured.map((app: any) => app.release.app.appId), ["alpha", "charlie"]);
      assert.deepEqual(ok(await market.actor.storefront_query({ ...selection, mode: { beta: null } })).featured.map((app: any) => app.release.app.appId), settings.featured);
      assert.deepEqual(ok(await market.actor.storefront_query({ ...selection, tag: ["crypto"] })).featured, []);
      const input = { ...selection, exclude: ["alpha"], tag: ["games"], request: { search: "", tier: { free: null }, window: { all: null }, cursor: [], limit: 1n } };
      await env.pic.advanceTime(61_000); await env.pic.tick(30);
      const free = ok(await market.actor.storefront_browse(input));
      assert.deepEqual(free.apps.map((app: any) => app.release.app.appId), ["charlie"], "Filtering fills pages past excluded, differently tagged and beta-only apps");
      const paid = ok(await market.actor.storefront_browse({ ...input, exclude: [], request: { ...input.request, tier: { paid: null } } }));
      assert.equal(paid.apps.length, 1); assert.equal(paid.nextCursor.length, 1);
      const next = ok(await market.actor.storefront_browse({ ...input, exclude: [], request: { ...input.request, tier: { paid: null }, cursor: paid.nextCursor } }));
      assert.equal(next.apps.length, 1); assert.notEqual(next.apps[0].release.app.appId, paid.apps[0].release.app.appId);
      assert.equal(next.generation, paid.generation);
      assert.equal(ok(await market.actor.storefront_browse({ ...input, exclude: [], request: { ...input.request, search: "original short" } })).apps.length, 1, "Search includes editorial subtitle");
      const oldDetail = ok(await admin.app_detail("alpha"));
      const cover = await upload("alpha", "image");
      ok(await admin.listing_save({ ...oldDetail.app, screenshots: [...oldDetail.app.screenshotArtifacts, cover], expectedRevision: [oldDetail.app.revision], feeVersion: 1n }));
      ok(await admin.admin_storefront_app_set({ appId: "alpha", title: "New art", subtitle: "Same approved package", tags: ["games"], coverArtifact: [cover], expectedRevision: 1n }));
      const changedHome = ok(await market.actor.storefront_query(selection));
      assert.notEqual(changedHome.featured[0].presentation.coverUrl[0], home.featured[0].presentation.coverUrl[0], "Admin cover follows a media-only edit without republishing a package");
      assert.deepEqual(changedHome.featured[0].release.selected, home.featured[0].release.selected);
      const http = await market.actor.http_request({ url: new URL(changedHome.featured[0].presentation.coverUrl[0]).pathname, method: "GET", headers: [], body: new Uint8Array(), certificate_version: [2] });
      assert.equal(http.status_code, 200);
      assert.ok(http.headers.some(([name]: [string, string]) => name.toLowerCase() === "ic-certificate"));
      const savedApp = ok(await admin.admin_storefront_app_get("alpha"));
      await env.pic.upgradeCanister({ canisterId, wasm: compiled.wasmPath, arg, upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(ok(await market.actor.storefront_query(selection)), changedHome);
      assert.deepEqual(ok(await admin.admin_storefront_app_get("alpha")), savedApp, "New root restores edits without reinitializing them");
      ok(await admin.admin_storefront_set({ ...settings, tags: [{ id: "games", name: "Play" }], expectedRevision: 1n }));
      assert.equal(ok(await market.actor.storefront_query(selection)).featured[0].presentation.tags[0].name, "Play");
      assert.deepEqual(ok(await admin.admin_storefront_app_get("bravo"))[0].tags, [], "Removing a tag atomically clears its assignments");
      console.log(`Storefront qualified successor ${compiled.wasmHash}; predecessor ${createHash("sha256").update(previous).digest("hex")}`);
    } finally { await env.shutdown(); }
  },
}];
