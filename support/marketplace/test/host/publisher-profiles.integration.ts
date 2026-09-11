// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { compileFixture } from "../../scripts/test-ash-runtime.ts";
import { account, deferredRelayCall, installFixture, ok, relayCall, session, wire, type Fixture, type IntegrationCase } from "./helpers.ts";

const previousPath = process.env.MARKETPLACE_PUBLISHERS_PREVIOUS_WASM;
const deployedHash = "f3665ba9677b98df17c6c85fde1207e205bfe3e8bded609a864e5648e3bd2d5e";
const principal = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
function success<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected success, received ${wire(result)}`);
  return result.ok;
}
function rejected(result: any, reason: string) {
  assert.ok(result && "err" in result, `${reason}: ${wire(result)}`);
  return result.err;
}
const listing = (appId: string) => ({
  appId, title: appId, summary: "Publisher profile fixture", description: "Retained publication and acquisition evidence.",
  priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n,
});
const registration = (publisherId: string, name = "Fixture publisher", description = "Publisher description") => ({ publisherId, name, description, feeVersion: 1n });

async function setup(legacy = false) {
  const env = await session();
  try {
    const ordinary = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const competitor = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const firstBuyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const secondBuyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const thirdBuyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const ledger = await installFixture(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
    const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
    const compiled = await compileFixture("publisher_profiles_marketplace", "mo/main.mo");
    const trustedPrincipal = principal(151), auditorPrincipal = principal(152);
    const config = {
      admins: [trustedPrincipal], auditors: [auditorPrincipal], trustedPublishingPrincipal: [trustedPrincipal], reservations: [],
      tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
      xrc: oracle.canisterId,
      fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
      referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
    };
    const arg = IDL.encode(compiled.init({ IDL }), [config]);
    const canisterId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
    if (legacy && previousPath) {
      const oldBytes = await readFile(previousPath);
      assert.equal(hash(oldBytes), deployedHash, "Upgrade qualification uses the exact previously deployed protocol");
      assert.notEqual(hash(await readFile(compiled.rawWasmPath)), deployedHash);
      await env.pic.installCode({ canisterId, wasm: gzipSync(oldBytes, { level: 9 }), arg });
    } else await env.pic.installCode({ canisterId, wasm: compiled.wasmPath, arg });
    const as = (sender: Principal) => {
      const actor = env.pic.createActor(compiled.idlFactory, canisterId);
      actor.setPrincipal(sender);
      return actor;
    };
    const market = { ...compiled, canisterId, actor: as(Principal.anonymous()) };
    const trusted = as(trustedPrincipal), auditor = as(auditorPrincipal);
    const call = async (sender: Fixture, method: string, input: unknown, cycles = 1_000_000_000n) => success(await relayCall(sender, market, method, [input], cycles));
    const direct = async (method: string, input: unknown) => success(await trusted[method](input));
    const profile = async (id = "aae") => success(await market.actor.publisher_profile(id));
    async function settleStats(id = "aae") {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const value = await profile(id);
        if (value.statsComplete) return value;
        await env.pic.advanceTime(61_000);
        for (let index = 0; index < 4; index += 1) await env.pic.tick();
      }
      throw new Error("Publisher statistics did not complete their bounded maintenance backfill");
    }
    async function publish(appId: string, visible = true, send = direct) {
      const saved = await send("listing_save", listing(appId));
      const bytes = new TextEncoder().encode(`publisher-profile-package:${appId}`);
      const requestId = `${appId}-upload`;
      await send("upload_begin", { requestId, appId, digest: digest(bytes), size: BigInt(bytes.length), mediaType: "application/octet-stream", purpose: { package: null }, feeVersion: 1n });
      await send("upload_chunk", { requestId, offset: 0n, bytes, feeVersion: 1n });
      const upload = await send("upload_finish", { requestId, feeVersion: 1n });
      const candidate = await send("candidate_submit", { requestId: `${appId}-candidate`, appId, version: 100n, artifactId: upload.artifactId[0], sourceArtifactId: [], dependencies: [], feeVersion: 1n });
      if (visible) success(await auditor.audit_stamp({ requestId: `${appId}-audit`, candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest, decision: { approved: null }, analysis: "Opaque local fixture inspected", reason: [] }));
      return { appId, saved, candidate, bytes, path: `/repo/v1/packages/${hash(bytes)}.neutron` };
    }
    async function acquire(sender: Fixture, requestId: string, appIds: string[]) {
      const quote = await call(sender, "purchase_quote", { requestId, appIds, ledger: ledger.canisterId, referralCode: [] }, 0n);
      if (quote.amount > 0n) {
        await ledger.actor.credit(account(sender.canisterId), quote.amount + quote.fee + 10n);
        ok(await relayCall(sender, ledger, "icrc2_approve", [{
          from_subaccount: [], spender: quote.spender, amount: quote.amount + quote.fee,
          expected_allowance: [0n], expires_at: [], fee: [10n], memo: [],
          created_at_time: [BigInt(Math.floor(await env.pic.getTime())) * 1_000_000n],
        }]));
      }
      const result = await call(sender, "purchase", { quote, feeVersion: 1n });
      assert.ok("complete" in result.order.state);
      return { quote, result };
    }
    const rating = (sender: Fixture, appId: string, stars: bigint, review = "Local review") => call(sender, "rating_set", { appId, stars, review, feeVersion: 1n });
    const upgrade = () => env.pic.upgradeCanister({ canisterId, wasm: compiled.wasmPath, arg, upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
    return { ...env, ordinary, competitor, firstBuyer, secondBuyer, thirdBuyer, ledger, market, trusted, trustedPrincipal, auditor, as, call, direct, profile, settleStats, publish, acquire, rating, upgrade };
  } catch (error) { await env.shutdown(); throw error; }
}

export const cases: IntegrationCase[] = [{
  name: "Publisher profiles: permanent identity, owner boundaries and concurrent ID claims",
  scope: "protocol",
  async run() {
    const ctx = await setup();
    try {
      const { market, trusted, trustedPrincipal, ordinary, competitor, firstBuyer, as, call, direct } = ctx;
      assert.deepEqual(success(await market.actor.publisher_profile_for(trustedPrincipal)), []);
      rejected(await trusted.listing_save(listing("missing_profile")), "Trusted listings also require a publisher profile");
      rejected(await relayCall(ordinary, market, "listing_save", [listing("missing_ordinary")], 1_000_000_000n), "Ordinary listings require a publisher profile");
      rejected(await trusted.upload_begin({ requestId: "missing-profile-upload", appId: "missing_profile", digest: digest(Uint8Array.of(1)), size: 1n, mediaType: "application/octet-stream", purpose: { package: null }, feeVersion: 1n }), "New uploads require a profile");
      rejected(await market.actor.publisher_profile_register(registration("anon")), "Anonymous ingress must not reserve an ID");
      rejected(await relayCall(ordinary, market, "publisher_profile_register", [registration("ordinary")]), "Ordinary registration must attach cycles");
      rejected(await as(principal(153)).publisher_profile_register(registration("browser")), "Browser ingress has no cycle subsidy");
      for (const id of ["aa", "a".repeat(21), "AAA", "abc1", "abc-def", " abc", "abc ", "åbc"]) {
        rejected(await trusted.publisher_profile_register(registration(id)), `Reject invalid publisher ID ${id}`);
      }
      for (const name of [" \n\t", "\u0085", "\u00a0", "\u2003", "\ufeff", "\u00a0\u2003\ufeff"]) {
        rejected(await trusted.publisher_profile_register(registration("aae", name)), "A publisher name must contain visible text rather than only Unicode whitespace");
      }
      const saved = await direct("publisher_profile_register", registration("aae", "AAE"));
      assert.equal(saved.publisherId, "aae");
      assert.equal(saved.name, "AAE");
      assert.equal(saved.principal.toText(), trustedPrincipal.toText());
      assert.equal(saved.totalUsers, 0n);
      assert.equal(saved.ratingCount, 0n);
      assert.equal(saved.ratingTotal, 0n);
      assert.deepEqual(await direct("publisher_profile_register", registration("aae", "AAE")), saved, "Exact retry does not create another profile or revision");
      rejected(await trusted.publisher_profile_register(registration("changed", "AAE")), "Publisher ID is permanent");
      rejected(await trusted.publisher_profile_register(registration("aae", "Another name")), "Publisher name is permanent");
      rejected(await relayCall(ordinary, market, "publisher_profile_register", [registration("aae", "Imposter")], 1_000_000_000n), "Another principal cannot claim an occupied ID");
      const edited = await direct("publisher_profile_update", { description: "Updated public description", feeVersion: 1n });
      assert.equal(edited.description, "Updated public description");
      assert.equal(edited.name, "AAE");
      assert.equal(edited.createdAtNs, saved.createdAtNs);
      assert.deepEqual(await direct("publisher_profile_register", registration("aae", "AAE")), edited, "Old registration replay cannot overwrite the later description");
      assert.deepEqual(success(await market.actor.publisher_profile_for(trustedPrincipal)), [edited]);
      assert.deepEqual(success(await market.actor.publisher_profile("aae")), edited, "Public profile reads work without connecting a browser identity");
      rejected(await relayCall(ordinary, market, "publisher_profile_update", [{ description: "Cannot edit someone else's profile", feeVersion: 1n }], 1_000_000_000n), "Description update targets the authenticated principal, not an arbitrary profile");

      const waits = await Promise.all([ordinary, competitor].map(sender => deferredRelayCall(ctx.pic, sender, market, "publisher_profile_register", [registration("shared", sender.canisterId.toText())], 1_000_000_000n)));
      const raced = await Promise.all(waits.map(receive => receive()));
      assert.equal(raced.filter(result => "ok" in result).length, 1, "Only one concurrent claimant receives an ID");
      assert.equal(raced.filter(result => "err" in result).length, 1);
      const winner = success(raced.find(result => "ok" in result));
      assert.equal(success(await market.actor.publisher_profile("shared")).principal.toText(), winner.principal.toText());
      const boundary = await call(firstBuyer, "publisher_profile_register", registration("abcdefghijklmnopqrst", "Boundary publisher"));
      assert.equal(boundary.publisherId.length, 20);
      const freshListing = await direct("listing_save", listing("owned_by_aae"));
      assert.deepEqual(freshListing.publisherProfile, [{ publisherId: "aae", name: "AAE" }]);
      assert.deepEqual(success(await trusted.publisher_apps({ cursor: [], limit: 10n })).apps[0].publisherProfile, freshListing.publisherProfile);
      await ctx.upgrade();
      assert.deepEqual(success(await market.actor.publisher_profile("aae")), edited, "Profile identity and edits survive an ordinary keep upgrade");
      assert.equal(success(await market.actor.publisher_profile("shared")).principal.toText(), winner.principal.toText());
    } finally { await ctx.shutdown(); }
  },
}, {
  name: "Publisher profiles: distinct buyers, weighted app ratings and audited public pagination",
  scope: "protocol",
  async run() {
    const ctx = await setup();
    try {
      await ctx.direct("publisher_profile_register", registration("aae", "AAE"));
      const first = await ctx.publish("profile_first");
      const second = await ctx.publish("profile_second");
      const hidden = await ctx.publish("profile_unaudited", false);
      const page = success(await ctx.market.actor.publisher_profile_apps({ publisherId: "aae", cursor: [], limit: 1n }));
      assert.equal(page.apps.length, 1);
      assert.equal(page.nextCursor.length, 1);
      const next = success(await ctx.market.actor.publisher_profile_apps({ publisherId: "aae", cursor: page.nextCursor, limit: 10n }));
      const visibleIds = [...page.apps, ...next.apps].map(app => app.appId).sort();
      assert.deepEqual(visibleIds, [first.appId, second.appId].sort(), "Publisher pages must not expose unaudited apps");
      assert.ok(!visibleIds.includes(hidden.appId));
      assert.deepEqual(next.nextCursor, []);
      const purchase = await ctx.acquire(ctx.firstBuyer, "two-apps-one-owner", [first.appId, second.appId]);
      assert.equal((await ctx.settleStats()).totalUsers, 1n, "Two app entitlements from one Neutron represent one publisher user");
      const current = success(await ctx.trusted.app_detail(first.appId)).app;
      await ctx.direct("listing_save", { ...listing(first.appId), priceUsdMicros: 1_000_000n, expectedRevision: [current.revision] });
      await ctx.direct("rates_refresh", { feeVersion: 1n });
      const paid = await ctx.acquire(ctx.secondBuyer, "first-app-second-owner", [first.appId]);
      assert.equal(paid.quote.amount, 1_000_000n);
      assert.equal((await ctx.profile()).totalUsers, 2n, "Free and paid acquisitions contribute to the same distinct-owner index");
      const beforeLedger = await ctx.ledger.actor.stats();
      assert.equal(beforeLedger.appliedTransactions, 2n, "The paid acquisition has one approval and one transfer");
      await ctx.call(ctx.firstBuyer, "purchase", { quote: purchase.quote, feeVersion: 1n });
      await ctx.call(ctx.firstBuyer, "install_prepare", { requestId: "profile-reinstall", appIds: [first.appId, second.appId], feeVersion: 1n });
      assert.equal((await ctx.profile()).totalUsers, 2n, "Purchase retries and installation preparations do not add users");
      rejected(await relayCall(ctx.thirdBuyer, ctx.market, "rating_set", [{ appId: first.appId, stars: 5n, review: "Not owned", feeVersion: 1n }], 1_000_000_000n), "An unowned app cannot alter publisher ratings");
      await ctx.rating(ctx.firstBuyer, first.appId, 5n);
      await ctx.rating(ctx.secondBuyer, first.appId, 5n);
      const secondRating = await ctx.rating(ctx.firstBuyer, second.appId, 1n);
      let profile = await ctx.profile();
      assert.equal(profile.ratingCount, 3n);
      assert.equal(profile.ratingTotal, 11n, "Publisher rating weights individual app ratings rather than averaging app averages");
      assert.deepEqual(await ctx.rating(ctx.firstBuyer, second.appId, 1n), secondRating, "Identical rating retry retains its original record");
      await ctx.rating(ctx.firstBuyer, second.appId, 4n, "Edited rating");
      profile = await ctx.profile();
      assert.equal(profile.ratingCount, 3n);
      assert.equal(profile.ratingTotal, 14n, "A rating edit replaces its previous contribution");
      assert.equal(profile.totalUsers, 2n);
      assert.deepEqual(await ctx.ledger.actor.stats(), beforeLedger, "Retries, ratings and profile reads create no further ledger transactions");
      await ctx.upgrade();
      assert.deepEqual(await ctx.settleStats(), profile, "Restoring counters must not replay acquisition or rating contributions");
    } finally { await ctx.shutdown(); }
  },
}, {
  name: `Publisher profiles: ${previousPath ? "exact deployed predecessor" : "same-module"} keep upgrade preserves purchases and backfills aggregates once`,
  scope: "upgrade",
  async run() {
    const ctx = await setup(true);
    try {
      if (!previousPath) await ctx.direct("publisher_profile_register", registration("aae", "AAE"));
      const first = await ctx.publish("retained_profile_first"), second = await ctx.publish("retained_profile_second");
      const firstPurchase = await ctx.acquire(ctx.firstBuyer, "retained-profile-owner-one", [first.appId, second.appId]);
      const secondPurchase = await ctx.acquire(ctx.secondBuyer, "retained-profile-owner-two", [first.appId]);
      await ctx.rating(ctx.firstBuyer, first.appId, 5n);
      await ctx.rating(ctx.firstBuyer, second.appId, 2n);
      await ctx.rating(ctx.secondBuyer, first.appId, 3n);
      const interruptedBytes = Uint8Array.of(81, 82, 83);
      const interruptedUpload = { requestId: "retained-profile-interrupted-upload", appId: first.appId, digest: digest(interruptedBytes), size: 3n, mediaType: "application/octet-stream", purpose: { source: null }, feeVersion: 1n };
      await ctx.direct("upload_begin", interruptedUpload);
      await ctx.direct("upload_chunk", { requestId: interruptedUpload.requestId, offset: 0n, bytes: interruptedBytes.slice(0, 1), feeVersion: 1n });
      const grant = { request_id: "c7".repeat(16), token: "d8".repeat(32), paths: [first.path, second.path], fee_version: 1n };
      success(await ctx.trusted.repo_access_v1(grant));
      const stripProfile = (detail: any) => {
        const { publisherProfile: _profile, ...app } = detail.app;
        return { ...detail, app };
      };
      const body = async (url: string) => {
        const response = await ctx.market.actor.http_request({ url, method: "GET", headers: [["Authorization", `Bearer ${grant.token}`]], body: new Uint8Array(), certificate_version: [2] });
        assert.equal(response.status_code, 200);
        assert.ok(response.headers.some(([key]: [string, string]) => key.toLowerCase() === "ic-certificate"));
        return response.body;
      };
      const before = {
        first: stripProfile(success(await ctx.trusted.app_detail(first.appId))),
        second: stripProfile(success(await ctx.trusted.app_detail(second.appId))),
        purchaseOne: await ctx.call(ctx.firstBuyer, "purchase_status", { requestId: firstPurchase.quote.request.requestId }, 0n),
        purchaseTwo: await ctx.call(ctx.secondBuyer, "purchase_status", { requestId: secondPurchase.quote.request.requestId }, 0n),
        ledger: await ctx.ledger.actor.stats(), packageOne: await body(first.path), packageTwo: await body(second.path),
      };
      await ctx.upgrade();
      assert.deepEqual(stripProfile(success(await ctx.trusted.app_detail(first.appId))), before.first);
      assert.deepEqual(stripProfile(success(await ctx.trusted.app_detail(second.appId))), before.second);
      assert.deepEqual(await ctx.call(ctx.firstBuyer, "purchase_status", { requestId: firstPurchase.quote.request.requestId }, 0n), before.purchaseOne);
      assert.deepEqual(await ctx.call(ctx.secondBuyer, "purchase_status", { requestId: secondPurchase.quote.request.requestId }, 0n), before.purchaseTwo);
      assert.deepEqual(await body(first.path), before.packageOne, "Published package and access grant survive the keep upgrade");
      assert.deepEqual(await body(second.path), before.packageTwo);
      if (previousPath) {
        assert.deepEqual(success(await ctx.market.actor.publisher_profile_for(ctx.trustedPrincipal)), [], "Upgrade does not silently claim a permanent publisher identity");
        rejected(await ctx.trusted.upload_begin({ ...interruptedUpload, requestId: "new-upload-needs-profile" }), "A new upload must wait for explicit permanent profile setup");
      }
      const resumed = await ctx.direct("upload_begin", interruptedUpload);
      assert.equal(resumed.uploadedBytes, 1n, "A saved upload resumes without first registering a new permanent identity");
      await ctx.direct("upload_chunk", { requestId: interruptedUpload.requestId, offset: 1n, bytes: interruptedBytes.slice(1), feeVersion: 1n });
      const finished = await ctx.direct("upload_finish", { requestId: interruptedUpload.requestId, feeVersion: 1n });
      assert.equal(finished.uploadedBytes, 3n);
      const savedCandidate = await ctx.direct("candidate_submit", { requestId: `${first.appId}-candidate`, appId: first.appId, version: 100n, artifactId: first.candidate.artifactId, sourceArtifactId: [], dependencies: [], feeVersion: 1n });
      assert.deepEqual(savedCandidate, before.first.candidate[0], "An exact retained candidate retry remains recoverable before profile setup");
      // Tiny historical fixtures finish the bounded initial batch at upgrade;
      // live writes afterward still must not duplicate its saved baselines.
      await ctx.rating(ctx.firstBuyer, second.appId, 4n, "Post-upgrade edit");
      await ctx.acquire(ctx.thirdBuyer, "post-upgrade-third-owner", [first.appId, second.appId]);
      await ctx.direct("publisher_profile_register", registration("aae", "AAE"));
      const profile = await ctx.settleStats();
      assert.equal(profile.totalUsers, 3n);
      assert.equal(profile.ratingCount, 3n);
      assert.equal(profile.ratingTotal, 12n);
      assert.deepEqual(await ctx.ledger.actor.stats(), before.ledger, "Registration and backfill never replay financial effects");
      for (const buyer of [ctx.firstBuyer, ctx.secondBuyer, ctx.thirdBuyer]) {
        const library = await ctx.call(buyer, "library_query", { cursor: [], limit: 20n }, 0n);
        assert.ok(library.apps.length > 0);
        assert.ok(library.apps.every((app: any) => app.owned && app.publisherProfile[0]?.publisherId === "aae"));
      }
      await ctx.upgrade();
      assert.deepEqual(await ctx.settleStats(), profile, "A second keep upgrade neither clears nor duplicates completed aggregate backfill");
      await ctx.call(ctx.firstBuyer, "purchase", { quote: firstPurchase.quote, feeVersion: 1n });
      assert.equal((await ctx.profile()).totalUsers, 3n, "Replaying a pre-upgrade acquisition does not add a publisher user");
      assert.deepEqual(await ctx.ledger.actor.stats(), before.ledger);
    } finally { await ctx.shutdown(); }
  },
}];
