// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { compileFixture } from "../../scripts/test-ash-runtime.ts";
import { installFixture, relayCall, session, wire, type IntegrationCase } from "./helpers.ts";

// Release qualification supplies the retained deployment artifact. Portable CI
// also exercises the complete public API and a same-module keep upgrade.
const previousPath = process.env.MARKETPLACE_CHANNELS_PREVIOUS_WASM;
const deployedHash = "62538acd0b35afad2d4222a82c4d5476ea200266dbab49516046711efd0eb438";
const principal = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = (bytes: Uint8Array) => Buffer.from(digest(bytes)).toString("hex");
function success<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected release-channel success: ${wire(result)}`);
  return result.ok;
}
function failure(result: any, code: string) {
  assert.equal(result.err?.code, code, `Expected ${code}: ${wire(result)}`);
}
const stablePath = (appId: string) => `/repo/v1/releases/${appId}.json`;
const betaPath = (appId: string) => `/repo/v1/channels/beta/releases/${appId}.json`;
const headsPath = (appId: string) => `/repo/v1/channels/apps/${appId}.json`;

async function setup(previous?: string) {
  const env = await session();
  try {
    const buyer = await installFixture(env.pic, "release_channels_relay", "test/fixtures/Relay.mo");
    const ledger = await installFixture(env.pic, "release_channels_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
    const oracle = await installFixture(env.pic, "release_channels_oracle", "test/fixtures/Oracle.mo");
    const compiled = await compileFixture("marketplace_release_channels", "mo/main.mo");
    const publisherId = principal(161), auditorId = principal(162), browserId = principal(163);
    const config = {
      admins: [buyer.canisterId], auditors: [auditorId], trustedPublishingPrincipal: [publisherId],
      reservations: [[{ appId: "reserved_channel", publisher: publisherId, title: "Retained reservation" }]],
      tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
      xrc: oracle.canisterId,
      fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
      referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
    };
    const arg = IDL.encode(compiled.init({ IDL }), [config]);
    const canisterId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
    let wasm: any = compiled.wasmPath;
    if (previous) {
      const bytes = await readFile(previous);
      assert.equal(hex(bytes), deployedHash, "Qualification installs the exact production predecessor from the retained local release record");
      assert.notEqual(compiled.wasmHash, deployedHash);
      wasm = gzipSync(bytes, { level: 9 });
    }
    await env.pic.installCode({ canisterId, wasm, arg });
    const market = { ...compiled, canisterId, actor: env.pic.createActor(compiled.idlFactory, canisterId) };
    const as = (owner: any) => { const actor = env.pic.createActor(compiled.idlFactory, canisterId); actor.setPrincipal(owner); return actor; };
    const publisher = as(publisherId), auditor = as(auditorId), browser = as(browserId);
    const charged = async (method: string, input: unknown) => success(await relayCall(buyer, market, method, [input], 1_000_000_000n));
    success(await publisher.publisher_profile_register({ publisherId: "channelpublisher", name: "Channel publisher", description: "Release channel qualification", feeVersion: 1n }));
    const revisions = new Map<string, bigint>();
    const listingInput = (appId: string, version: bigint) => ({
      appId, title: `${appId} release ${version}`, summary: `Excerpt ${version}`, description: `Description retained for ${version}`,
      priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: revisions.has(appId) ? [revisions.get(appId)] : [], feeVersion: 1n,
    });
    async function listing(appId: string, version: bigint) {
      const result = success(await publisher.listing_save(listingInput(appId, version)));
      revisions.set(appId, result.revision);
      return result;
    }
    async function upload(appId: string, version: bigint, kind: "package" | "source") {
      const bytes = new TextEncoder().encode(`${appId}:${version}:${kind}:immutable release fixture`);
      const requestId = `${appId}-${version}-${kind}`;
      success(await publisher.upload_begin({ requestId, appId, digest: digest(bytes), size: BigInt(bytes.length), mediaType: "application/octet-stream", purpose: { [kind]: null }, feeVersion: 1n }));
      success(await publisher.upload_chunk({ requestId, offset: 0n, bytes, feeVersion: 1n }));
      const finished = success(await publisher.upload_finish({ requestId, feeVersion: 1n }));
      return { id: finished.artifactId[0], bytes, path: kind === "package" ? `/repo/v1/packages/${hex(bytes)}.neutron` : `/repo/v1/sources/${hex(bytes)}.source.v1.msgpack.gz` };
    }
    async function candidate(appId: string, version: bigint, dependencies: any[] = [], legacy = false) {
      await listing(appId, version);
      const pkg = await upload(appId, version, "package"), source = await upload(appId, version, "source");
      const request = { requestId: `${appId}-${version}-candidate`, appId, version, artifactId: pkg.id, sourceArtifactId: [source.id], dependencies, feeVersion: 1n };
      const releaseNotes = `Release notes ${appId} ${version}`;
      const row = success(await (legacy ? publisher.candidate_submit(request) : publisher.candidate_submit_v2({ request, releaseNotes })));
      return { appId, version, pkg, source, row, request, releaseNotes };
    }
    const entry = (value: any) => ({ candidateId: value.row.id, expectedDigest: value.row.digest, expectedSourceDigest: value.row.sourceDigest });
    const batch = (requestId: string, values: any[]) => ({ requestId, candidates: values.map(entry), analysis: "Verified these exact fixture package and offered-source digests.", operation: "publish", channel: "beta" });
    const publish = async (requestId: string, values: any[]) => success(await publisher.trusted_publish_beta_batch(batch(requestId, values)));
    const prepare = async (requestId: string, appIds: string[]) => ({ requestId, ...success(await publisher.promotion_prepare({ appIds })), feeVersion: 1n });
    const promote = async (requestId: string, appIds: string[]) => success(await publisher.release_promote(await prepare(requestId, appIds)));
    const subnet = await env.pic.getCanisterSubnetId(canisterId);
    assert.ok(subnet);
    const rootKey = new Uint8Array(await env.pic.getPubKey(subnet));
    async function http(url: string, token?: string) {
      const request = { url, method: "GET", headers: token ? [["Authorization", `Bearer ${token}`]] : [], body: new Uint8Array(), certificate_version: [2] };
      const response = await market.actor.http_request(request);
      if (response.status_code === 200) {
        const verification = verifyRequestResponsePair(request, response, canisterId.toUint8Array(), BigInt(await env.pic.getTime()) * 1_000_000n, 300_000_000_000n, rootKey, 2);
        assert.equal(verification.verificationVersion, 2, `Certified response for ${url}`);
      }
      return response;
    }
    const body = async (url: string, token?: string) => { const response = await http(url, token); assert.equal(response.status_code, 200, url); return Buffer.from(response.body); };
    const json = async (url: string) => JSON.parse((await body(url)).toString("utf8"));
    const heads = async (appIds: string[]) => Promise.all(appIds.map(appId => json(headsPath(appId))));
    const detail = async (appId: string, mode: "stable" | "beta") => success(await market.actor.app_detail_v2({ appId, mode: { [mode]: null } })).release;
    const upgrade = () => env.pic.upgradeCanister({ canisterId, wasm: compiled.wasmPath, arg, upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
    const revoke = (value: any) => auditor.audit_stamp({ requestId: `revoke-${value.row.id}`, ...entry(value), decision: { revoked: null }, analysis: "Revoked exact test candidate", reason: ["Qualification revocation"] });
    return { ...env, market, publisher, auditor, browser, publisherId, browserId, ledger, buyer, as, charged, candidate, listing, entry, batch, publish, prepare, promote, http, body, json, heads, detail, upgrade, revoke };
  } catch (error) { await env.shutdown(); throw error; }
}

export const cases: IntegrationCase[] = [{
  name: "Release channels: certified beta isolation, exact atomic Kernel promotion, conflicts and historical receipt recovery",
  scope: "protocol",
  async run() {
    const ctx = await setup();
    try {
      const { publisher, candidate, publish, prepare, promote, heads, http, body, json, detail } = ctx;
      const appIds = ["kernel", "channel_app"];
      const kernel100 = await candidate("kernel", 100n);
      const app100 = await candidate("channel_app", 100n, [{ appId: "kernel", minVersion: 100n }]);
      const beta100 = await publish("beta-100", [kernel100, app100]);
      assert.equal(beta100.operation, "publish");
      assert.equal(beta100.channel, "beta");
      assert.equal((await http(stablePath(app100.appId))).status_code, 404);
      assert.equal((await detail(app100.appId, "beta")).selected[0].id, app100.row.id);
      assert.equal((await json(betaPath(app100.appId))).version, 100);
      for (const artifact of [app100.pkg, app100.source]) assert.deepEqual(await body(artifact.path), Buffer.from(artifact.bytes), "A free beta-only app exposes its exact package and source");
      const firstPromotion = await promote("stable-100", appIds);
      assert.equal(firstPromotion.id, 1n);
      await ctx.charged("read_delegate_set", { browser: ctx.browserId, active: true, feeVersion: 1n });
      const acquiredQuote = success(await ctx.browser.purchase_quote({ requestId: "feedback-acquisition", appIds: [app100.appId], ledger: ctx.ledger.canisterId, referralCode: [] }));
      await ctx.charged("purchase", { quote: acquiredQuote, feeVersion: 1n });
      await ctx.charged("rating_set_v2", { appId: app100.appId, stars: 4n, feeVersion: 1n });
      const stable100 = await body(stablePath(app100.appId));

      const kernel101 = await candidate("kernel", 101n);
      const app101 = await candidate("channel_app", 101n, [{ appId: "kernel", minVersion: 101n }]);
      const publish101 = ctx.batch("beta-101", [kernel101, app101]);
      const beta101 = success(await publisher.trusted_publish_beta_batch(publish101));
      assert.deepEqual(await body(stablePath(app100.appId)), stable100, "Beta publication preserves exact stable release bytes");
      assert.equal((await detail(app100.appId, "stable")).app.title, "channel_app release 100");
      assert.equal((await detail(app100.appId, "beta")).app.title, "channel_app release 101");
      await ctx.listing(app100.appId, 999n);
      assert.equal((await detail(app100.appId, "beta")).app.title, "channel_app release 101", "Unsubmitted listing edits cannot change an offered beta");
      assert.equal((await detail(app100.appId, "beta")).betaHead.releaseNotes, app101.releaseNotes);
      failure(await publisher.candidate_submit_v2({ request: app101.request, releaseNotes: "Replace published notes" }), "request_conflict");
      for (const artifact of [app100.pkg, app100.source, app101.pkg, app101.source]) assert.deepEqual(await body(artifact.path), Buffer.from(artifact.bytes));

      const exact = await prepare("stable-101", appIds);
      const before = await heads(appIds);
      const invalid = { ...exact, entries: [exact.entries[0], { ...exact.entries[1], sourceSize: [999n] }] };
      failure(await publisher.release_promote(invalid), "release_unavailable");
      assert.deepEqual(await heads(appIds), before, "Invalid last source evidence cannot promote an earlier Kernel entry");
      assert.deepEqual(success(await publisher.promotion_status({ requestId: exact.requestId })), []);
      failure(await publisher.release_promote(await prepare("app-without-kernel", [app100.appId])), "dependency_version");
      assert.deepEqual(await heads(appIds), before, "An unpromoted Kernel beta cannot satisfy stable dependency requirements");
      failure(await publisher.release_promote({ ...exact, requestId: "duplicate-app", entries: [exact.entries[0], exact.entries[0]] }), "duplicate_app");
      assert.deepEqual(await heads(appIds), before);
      const receipt101 = success(await publisher.release_promote(exact));
      assert.equal(receipt101.id, 2n);
      assert.equal(receipt101.operation, "promote");
      assert.equal(receipt101.channel, "stable");
      assert.deepEqual(receipt101.entries, exact.entries);
      for (const value of [kernel101, app101]) {
        assert.equal((await json(stablePath(value.appId))).version, 101);
        assert.equal((await detail(value.appId, "stable")).selected[0].id, value.row.id);
      }
      assert.deepEqual(await body(app101.source.path), Buffer.from(app101.source.bytes), "Promotion reuses the exact beta source");
      const after = await heads(appIds);
      const noopRequest = await prepare("already-stable", appIds);
      const noop = success(await publisher.release_promote(noopRequest));
      assert.equal(noop.id, 0n);
      assert.deepEqual(await heads(appIds), after, "No-op promotion does not advance channel revisions");
      assert.deepEqual(success(await publisher.promotion_status({ requestId: "already-stable" })), [noop], "No-op retains recovery evidence without allocating a promotion ID");

      const app102 = await candidate(app100.appId, 102n, [{ appId: "kernel", minVersion: 101n }]);
      await publish("beta-102", [app102]);
      const stale = await prepare("stale-beta", [app100.appId]);
      const app103 = await candidate(app100.appId, 103n, [{ appId: "kernel", minVersion: 101n }]);
      await publish("beta-103", [app103]);
      const beforeStale = await heads(appIds);
      failure(await publisher.release_promote(stale), "channel_conflict");
      assert.deepEqual(await heads(appIds), beforeStale, "A reviewed beta that has been replaced cannot be promoted");
      const stable103 = await prepare("stable-103", [app100.appId]);
      const receipt103 = success(await publisher.release_promote(stable103));
      assert.equal(receipt103.id, 3n, "Failed and no-op promotions do not consume transaction IDs");
      failure(await publisher.release_promote({ ...stable103, requestId: "stale-stable" }), "channel_conflict");
      const current = await heads(appIds);
      assert.deepEqual(success(await publisher.release_promote(noopRequest)), noop, "An earlier no-op retry remains its original receipt after newer channel publication");
      failure(await publisher.release_promote({ ...noopRequest, entries: stable103.entries }), "request_conflict");
      assert.deepEqual(success(await publisher.release_promote(exact)), receipt101, "A lost earlier response returns its original receipt after newer beta and stable publication");
      assert.deepEqual(success(await publisher.promotion_status({ requestId: exact.requestId }))[0], receipt101);
      assert.deepEqual(success(await publisher.trusted_publish_beta_batch(publish101)), beta101, "Publication replay retains historical evidence after its bytes are superseded");
      failure(await publisher.release_promote({ ...exact, entries: stable103.entries }), "request_conflict");
      failure(await publisher.trusted_publish_beta_batch({ ...publish101, channel: "stable" }), "request_conflict");
      assert.deepEqual(await heads(appIds), current, "Recovery cannot reinstall an old channel head");

      const app104 = await candidate(app100.appId, 104n, [{ appId: "kernel", minVersion: 101n }]);
      await publish("beta-104", [app104]);
      const commentRelease = { appId: app104.appId, candidateId: app104.row.id, version: app104.version, digest: app104.row.digest };
      const commentRequest = { ...commentRelease, text: "Feedback on this exact beta", feeVersion: 1n };
      const comment = await ctx.charged("version_comment_set_v2", commentRequest);
      const commentPage = { ...commentRelease, cursor: [], limit: 10n };
      assert.deepEqual(success(await ctx.browser.version_comments_v2(commentPage)).comments, [comment]);
      const starsBeforeRevocation = success(await ctx.market.actor.rating_summary_v2(app104.appId));
      assert.equal(starsBeforeRevocation.count, 1n);
      assert.equal(starsBeforeRevocation.four, 1n);
      const revocationPlan = await prepare("revoked-beta", [app100.appId]);
      const stable103Bytes = await body(stablePath(app100.appId));
      success(await ctx.revoke(app104));
      failure(await ctx.browser.version_comments_v2(commentPage), "feedback_release_retired");
      failure(await relayCall(ctx.buyer, ctx.market, "version_comment_set_v2", [commentRequest], 1_000_000_000n), "feedback_release_retired");
      assert.deepEqual(success(await ctx.market.actor.rating_summary_v2(app104.appId)), starsBeforeRevocation, "Revoking version comments preserves permanent app ratings");
      assert.equal(success(await ctx.browser.app_detail_v2({ appId: app104.appId, mode: { stable: null } })).rating[0].stars, 4n);
      failure(await publisher.release_promote(revocationPlan), "channel_conflict");
      const fallback = await detail(app100.appId, "beta");
      assert.equal(fallback.selected[0].id, app103.row.id);
      assert.ok("stable" in fallback.selectedChannel[0]);
      assert.ok("revoked" in fallback.betaHead.candidate[0].state);
      assert.deepEqual(await body(stablePath(app100.appId)), stable103Bytes);
      assert.equal((await http(betaPath(app100.appId))).status_code, 404, "The revoked beta path does not relabel stable as beta");
      const saved = await heads(appIds);
      await ctx.upgrade();
      assert.deepEqual(await heads(appIds), saved);
      assert.deepEqual(success(await publisher.release_promote(exact)), receipt101);
      assert.deepEqual(success(await publisher.trusted_publish_beta_batch(publish101)), beta101);
      assert.deepEqual(await body(app103.source.path), Buffer.from(app103.source.bytes));
    } finally { await ctx.shutdown(); }
  },
}, {
  name: `Release channels: ${previousPath ? "exact deployed predecessor" : "same-module"} keep upgrade preserves stable bytes, grants, uploads, ownership and receipts`,
  scope: "upgrade",
  async run() {
    const ctx = await setup(previousPath);
    try {
      const { publisher, market, candidate, body, heads, http, detail } = ctx;
      const stable = await candidate("retained_channel", 100n, [], Boolean(previousPath));
      const revoked = await candidate("revoked_channel", 100n, [], Boolean(previousPath));
      const pending = await candidate("pending_channel", 100n, [], Boolean(previousPath));
      const legacyRequest = ctx.batch("retained-publication", [stable, revoked]);
      const legacyReceipt = success(await publisher.trusted_publish_batch(legacyRequest));
      if (!previousPath) await ctx.promote("initial-stable", [stable.appId, revoked.appId]);
      success(await ctx.revoke(revoked));
      await ctx.charged("read_delegate_set", { browser: ctx.browserId, active: true, feeVersion: 1n });
      const quote = success(await ctx.browser.purchase_quote({ requestId: "retained-acquisition", appIds: [stable.appId], ledger: ctx.ledger.canisterId, referralCode: [] }));
      const purchase = await ctx.charged("purchase", { quote, feeVersion: 1n });
      const grant = { request_id: "91".repeat(16), token: "92".repeat(32), paths: [stable.pkg.path, stable.source.path], fee_version: 1n };
      const access = success(await publisher.repo_access_v1(grant));
      const pendingBytes = new TextEncoder().encode("Upload continues after the channel root bootstrap");
      const uploadRequest = { requestId: "retained-incomplete-upload", appId: stable.appId, digest: digest(pendingBytes), size: BigInt(pendingBytes.length), mediaType: "application/octet-stream", purpose: { source: null }, feeVersion: 1n };
      success(await publisher.upload_begin(uploadRequest));
      success(await publisher.upload_chunk({ requestId: uploadRequest.requestId, offset: 0n, bytes: pendingBytes.slice(0, 7), feeVersion: 1n }));
      const uploadBefore = success(await publisher.upload_status({ requestId: uploadRequest.requestId }));
      const stableBytes = await body(stablePath(stable.appId));
      const bytesBefore = await Promise.all(grant.paths.map(path => body(path, grant.token)));
      const profileBefore = success(await publisher.publisher_profile("channelpublisher"));
      const pendingBefore = success(await ctx.auditor.audit_candidate(pending.row.id));
      const revokedBefore = success(await ctx.auditor.audit_candidate(revoked.row.id));
      const infoBefore = await market.actor.marketplace_info();
      const ledgerBefore = await ctx.ledger.actor.stats();
      await ctx.upgrade();
      assert.deepEqual(await market.actor.marketplace_info(), infoBefore);
      assert.deepEqual(await body(stablePath(stable.appId)), stableBytes, "Bootstrap preserves the exact certified v1 stable release JSON body");
      assert.deepEqual(await Promise.all(grant.paths.map(path => body(path, grant.token))), bytesBefore, "Existing grants and exact package/source bytes survive");
      assert.deepEqual(success(await publisher.repo_access_v1(grant)), access);
      assert.deepEqual(success(await publisher.trusted_publish_status({ requestId: legacyRequest.requestId }))[0], legacyReceipt);
      assert.deepEqual(success(await publisher.trusted_publish_batch(legacyRequest)), legacyReceipt, "A legacy publication retry must remain its historical transaction");
      assert.deepEqual(success(await publisher.publisher_profile("channelpublisher")), profileBefore);
      assert.deepEqual(success(await publisher.upload_status({ requestId: uploadRequest.requestId })), uploadBefore);
      assert.deepEqual(success(await ctx.auditor.audit_candidate(pending.row.id)), pendingBefore);
      assert.deepEqual(success(await ctx.auditor.audit_candidate(revoked.row.id)), revokedBefore);
      assert.deepEqual(success(await ctx.browser.purchase_status({ requestId: "retained-acquisition" }))[0], purchase);
      assert.deepEqual(await ctx.ledger.actor.stats(), ledgerBefore);
      assert.equal(success(await publisher.app_detail("reserved_channel")).app.publisher.toText(), ctx.publisherId.toText());
      const restored = await detail(stable.appId, "stable");
      assert.equal(restored.stableHead.candidate[0].id, stable.row.id);
      assert.equal(restored.app.publisher.toText(), ctx.publisherId.toText());
      if (previousPath) assert.deepEqual(restored.betaHead.candidate, [], "Only stable is seeded from the legacy approved head");
      const revokedHeads = (await heads([revoked.appId]))[0];
      assert.equal(revokedHeads.stable.candidate_id, String(revoked.row.id), "Revoked legacy pointers remain retained without reviving old releases");
      assert.equal(revokedHeads.stable.release, null);
      assert.equal((await http(stablePath(revoked.appId))).status_code, 404);
      success(await publisher.upload_chunk({ requestId: uploadRequest.requestId, offset: 7n, bytes: pendingBytes.slice(7), feeVersion: 1n }));
      assert.equal(success(await publisher.upload_finish({ requestId: uploadRequest.requestId, feeVersion: 1n })).uploadedBytes, BigInt(pendingBytes.length));
      const beta = await candidate(stable.appId, 101n);
      const betaReceipt = await ctx.publish("post-upgrade-beta", [beta]);
      assert.deepEqual(await body(stablePath(stable.appId)), stableBytes);
      for (const artifact of [stable.pkg, stable.source, beta.pkg, beta.source]) assert.deepEqual(await body(artifact.path), Buffer.from(artifact.bytes));
      assert.equal((await detail(stable.appId, "stable")).app.title, "retained_channel release 100");
      const beforeRepeat = await heads([stable.appId, revoked.appId, pending.appId]);
      await ctx.upgrade();
      assert.deepEqual(await heads([stable.appId, revoked.appId, pending.appId]), beforeRepeat, "A repeated bootstrap cannot overwrite beta or revive revoked stable heads");
      assert.deepEqual(success(await publisher.trusted_publish_beta_status({ requestId: "post-upgrade-beta" }))[0], betaReceipt);
      assert.deepEqual(await body(stablePath(stable.appId)), stableBytes);
      await ctx.promote("post-upgrade-stable", [stable.appId]);
      assert.equal((await detail(stable.appId, "stable")).selected[0].id, beta.row.id);
      assert.deepEqual(await body(beta.source.path), Buffer.from(beta.source.bytes));
    } finally { await ctx.shutdown(); }
  },
}];
