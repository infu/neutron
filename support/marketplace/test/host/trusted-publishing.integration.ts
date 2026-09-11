// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { account, installFixture, ok, relayCall, session, wire, type IntegrationCase } from "./helpers.ts";

const identity = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
const hash = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
function success<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected protocol success, got ${wire(result)}`);
  return result.ok;
}
function rejected(result: any, message: string) {
  assert.ok(result && "err" in result, `${message}: ${wire(result)}`);
  return result.err;
}

async function setup() {
  const env = await session();
  try {
    const admin = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const ordinary = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const buyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const ledger = await installFixture(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
    const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
    const trustedPrincipal = identity(91), auditorPrincipal = identity(92), adminPrincipal = identity(93);
    const config = {
      admins: [admin.canisterId, adminPrincipal], auditors: [auditorPrincipal],
      trustedPublishingPrincipal: [trustedPrincipal], reservations: [[{ appId: "trusted_reserved", publisher: trustedPrincipal, title: "Reserved first-party app" }]],
      tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
      xrc: oracle.canisterId,
      fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
      referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
    };
    const market = await installFixture(env.pic, "marketplace", "mo/main.mo", [config]);
    const as = (principal: Principal) => {
      const actor = env.pic.createActor(market.idlFactory, market.canisterId);
      actor.setPrincipal(principal);
      return actor;
    };
    const trusted = as(trustedPrincipal), auditor = as(auditorPrincipal);
    const charged = async (sender: any, name: string, input: unknown) => success(await relayCall(sender, market, name, [input], 1_000_000_000n));
    const direct = async (name: string, input: unknown) => success(await trusted[name](input));
    await direct("publisher_profile_register", { publisherId: "trustedpublisher", name: "Trusted fixture publisher", description: "First-party publishing fixture", feeVersion: 1n });
    for (const [sender, publisherId] of [[admin, "adminpublisher"], [ordinary, "ordinarypublisher"], [buyer, "buyerpublisher"]] as const) {
      await charged(sender, "publisher_profile_register", { publisherId, name: publisherId, description: "Ordinary publisher authorization fixture", feeVersion: 1n });
    }
    const listing = (appId: string, priceUsdMicros = 1_000_000n) => ({
      appId, title: appId, summary: "Local first-party publication test", description: "Opaque transport fixtures; package and image formats are not qualified by this test.",
      priceUsdMicros, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n,
    });
    type Kind = "package" | "source" | "image";
    async function upload(appId: string, kind: Kind, bytes: Uint8Array, send = direct, suffix = "") {
      const requestId = `${appId}-${kind}${suffix}`;
      const begun = await send("upload_begin", { requestId, appId, digest: hash(bytes), size: BigInt(bytes.length), mediaType: kind === "image" ? "image/png" : "application/octet-stream", purpose: { [kind]: null }, feeVersion: 1n });
      if (send === direct) assert.equal(begun.charge.cycles, 0n, "First-party storage is subsidized without collecting cycles");
      // Use real incremental upload messages and a duplicate chunk, including
      // for source and image files. No test-only storage writer is exposed.
      const width = Math.min(262_144, Math.max(1, Math.floor(bytes.length / 2)));
      for (let offset = 0; offset < bytes.length; offset += width) {
        const chunk = { requestId, offset: BigInt(offset), bytes: bytes.slice(offset, offset + width), feeVersion: 1n };
        await send("upload_chunk", chunk);
        if (offset === 0) await send("upload_chunk", chunk);
      }
      const finished = await send("upload_finish", { requestId, feeVersion: 1n });
      assert.equal(finished.uploadedBytes, BigInt(bytes.length));
      assert.equal(finished.artifactId.length, 1);
      const hex = Buffer.from(hash(bytes)).toString("hex");
      const path = kind === "package" ? `/repo/v1/packages/${hex}.neutron` : kind === "source" ? `/repo/v1/sources/${hex}.source.v1.msgpack.gz` : `/repo/v1/media/${hex}`;
      return { id: finished.artifactId[0], bytes, path, requestId };
    }
    async function candidate(appId: string, byte: number, large = false, send = direct) {
      const savedListing = await send("listing_save", listing(appId));
      const body = (suffix: number) => {
        const bytes = new Uint8Array(large ? 1_048_593 : 9).fill(byte + suffix);
        bytes[bytes.length - 1] = suffix;
        return bytes;
      };
      const pkg = await upload(appId, "package", body(0), send);
      const source = await upload(appId, "source", body(1), send);
      const image = await upload(appId, "image", body(2), send);
      await send("listing_save", { ...listing(appId), iconArtifact: [image.id], screenshots: [image.id], expectedRevision: [savedListing.revision] });
      const input = { requestId: `${appId}-candidate`, appId, version: 100n, artifactId: pkg.id, sourceArtifactId: [source.id], dependencies: [], feeVersion: 1n };
      const row = await send("candidate_submit", input);
      assert.ok("pending" in row.state);
      assert.equal(row.published, false);
      return { appId, row, input, pkg, source, image };
    }
    const entry = (row: any) => ({ candidateId: row.id, expectedDigest: row.digest, expectedSourceDigest: row.sourceDigest });
    const batch = (requestId: string, rows: any[]) => ({ requestId, candidates: rows.map(entry), analysis: "First-party release: exact uploaded package and source hashes verified. This test does not assert a malware inspection." });
    const upgrade = async (trusted = [trustedPrincipal]) => {
      await env.pic.upgradeCanister({
        canisterId: market.canisterId, wasm: market.wasmPath,
        arg: IDL.encode(market.init({ IDL }), [{ ...config, trustedPublishingPrincipal: trusted }]),
        upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
      });
    };
    return { ...env, admin, ordinary, buyer, ledger, market, config, trustedPrincipal, auditorPrincipal, adminPrincipal, trusted, auditor, as, charged, direct, listing, upload, candidate, entry, batch, upgrade };
  } catch (error) { await env.shutdown(); throw error; }
}

export const cases: IntegrationCase[] = [{
  name: "Trusted publishing API: exact principal subsidy, ordinary role boundaries and ownership",
  scope: "protocol",
  async run() {
    const ctx = await setup();
    try {
      const { market, trusted, auditor, as, config, trustedPrincipal, adminPrincipal, admin, ordinary, buyer, listing, charged, direct, candidate, batch } = ctx;
      assert.equal((await market.actor.marketplace_info()).trustedPublishingPrincipal[0].toText(), trustedPrincipal.toText());
      assert.ok(!config.admins.some(value => value.toText() === trustedPrincipal.toText()));
      assert.ok(!config.auditors.some(value => value.toText() === trustedPrincipal.toText()), "Trusted publishing is independent of the auditor role");
      const outsider = as(identity(94));
      for (const [name, actor] of [["anonymous", as(Principal.anonymous())], ["other identity", outsider], ["admin ingress", as(adminPrincipal)], ["auditor ingress", auditor]] as const) {
        rejected(await actor.listing_save(listing(`denied_${name.replaceAll(" ", "_")}`)), `${name} has no direct publisher update subsidy`);
        rejected(await actor.trusted_publish_batch(batch("denied", [])), `${name} is not the exact configured first-party publisher`);
        rejected(await actor.trusted_publish_status({ requestId: "denied" }), `${name} cannot query another publisher's batch`);
      }
      for (const sender of [admin, ordinary, buyer]) {
        rejected(await relayCall(sender, market, "listing_save", [listing("no_cycles")]), "Being an admin or a canister does not waive native cycles");
      }
      const own = await candidate("trusted_owned", 11);
      assert.equal(own.row.publisher.toText(), trustedPrincipal.toText());
      assert.equal(success(await trusted.app_detail(own.appId)).app.publisher.toText(), trustedPrincipal.toText());
      assert.deepEqual(success(await trusted.publisher_apps({ cursor: [], limit: 20n })).apps.map((app: any) => app.appId).sort(), [own.appId, "trusted_reserved"].sort());
      assert.equal(success(await trusted.app_detail("trusted_reserved")).app.publisher.toText(), trustedPrincipal.toText(), "Fresh initialization supports a reservation owned by the exact trusted ingress identity");
      rejected(await relayCall(ordinary, market, "listing_save", [listing("trusted_reserved")], 1_000_000_000n), "Another Neutron cannot claim a first-party reservation");
      assert.equal(success(await auditor.audit_queue({ cursor: [], limit: 20n })).candidates[0].id, own.row.id);
      rejected(await trusted.audit_queue({ cursor: [], limit: 20n }), "The trusted publisher does not become an auditor");
      rejected(await trusted.audit_stamp({ requestId: "not-an-auditor", ...ctx.entry(own.row), decision: { approved: null }, analysis: "Cannot self-assign auditor role", reason: [] }), "Ordinary audit authority is separate from first-party batch publication");
      const unpaidCatalog = success(await market.actor.catalog_query({ search: "", tier: { paid: null }, window: { all: null }, cursor: [], limit: 20n }));
      assert.equal(unpaidCatalog.apps.length, 0, "Submitting first-party files alone must not publish the candidate");

      await charged(ordinary, "listing_save", listing("ordinary_owned"));
      rejected(await trusted.listing_save(listing("ordinary_owned")), "The trusted publisher cannot take another publisher's listing");
      rejected(await relayCall(ordinary, market, "listing_save", [listing(own.appId)], 1_000_000_000n), "An ordinary publisher cannot take a trusted listing");
      const other = await candidate("ordinary_package", 31, false, (name, input) => charged(ordinary, name, input));
      rejected(await trusted.candidate_submit({ ...own.input, requestId: "foreign-package", artifactId: other.pkg.id }), "The first-party exception does not bypass artifact ownership");
      rejected(await trusted.trusted_publish_batch(batch("mixed-owners", [own.row, other.row])), "A batch must contain only this publisher's candidates");
      assert.ok("pending" in success(await auditor.audit_candidate(own.row.id)).state, "Rejecting another publisher's candidate cannot partially approve the valid first entry");
      assert.ok("pending" in success(await auditor.audit_candidate(other.row.id)).state);
      assert.deepEqual(success(await trusted.trusted_publish_status({ requestId: "mixed-owners" })), []);
      rejected(await trusted.repo_access_v1({ request_id: "a3".repeat(16), token: "b4".repeat(32), paths: [other.pkg.path], fee_version: 1n }), "The source-download subsidy remains limited to owned publishing files");
      // This exemption is for publishing/royalty withdrawals, not arbitrary
      // user updates. Read delegation and buying still use a Neutron.
      rejected(await trusted.read_delegate_set({ browser: identity(95), active: true, feeVersion: 1n }), "Trusted signing identity does not impersonate a Neutron");
      const quote = { requestId: "no-purchase-bypass", appIds: [own.appId], ledger: ctx.ledger.canisterId, referralCode: [] };
      await direct("trusted_publish_batch", batch("own-published", [own.row]));
      await charged(admin, "rates_refresh", { feeVersion: 1n });
      const quoted = success(await trusted.purchase_quote(quote));
      rejected(await trusted.purchase({ quote: quoted, feeVersion: 1n }), "The publishing exception does not grant free/direct paid acquisitions");
      assert.equal((await ctx.ledger.actor.stats()).transferFromCalls, 0n);
    } finally { await ctx.shutdown(); }
  },
}, {
  name: "Trusted publishing API: atomic two-app batch, streamed certified files and retained upgrade",
  scope: "upgrade",
  async run() {
    const ctx = await setup();
    try {
      const { pic, market, trusted, auditor, trustedPrincipal, direct, candidate, batch, upgrade } = ctx;
      const first = await candidate("trusted_stream", 41, true);
      const second = await candidate("trusted_second", 51);
      const request = batch("publish-two", [first.row, second.row]);
      const wrong = { ...request, candidates: [request.candidates[0], { ...request.candidates[1], expectedSourceDigest: [new Uint8Array(32)] }] };
      rejected(await trusted.trusted_publish_batch(wrong), "A wrong last source hash must reject the whole batch");
      rejected(await trusted.trusted_publish_batch({ ...request, candidates: [request.candidates[0], { ...request.candidates[1], expectedDigest: new Uint8Array(32) }] }), "A wrong last package hash must also reject the whole batch");
      for (const item of [first, second]) assert.ok("pending" in success(await auditor.audit_candidate(item.row.id)).state);
      assert.deepEqual(success(await trusted.trusted_publish_status({ requestId: request.requestId })), [], "Invalid preflight retains no successful batch record");
      assert.equal(success(await market.actor.catalog_query({ search: "", tier: { paid: null }, window: { all: null }, cursor: [], limit: 20n })).apps.length, 0);
      const published = await direct("trusted_publish_batch", request);
      assert.equal(published.publisher.toText(), trustedPrincipal.toText());
      assert.deepEqual(published.entries.map((item: any) => item.candidateId), [first.row.id, second.row.id]);
      assert.equal(new Set(published.entries.map((item: any) => item.auditId)).size, 2);
      const auditIds = [];
      for (const item of [first, second]) {
        const detail = success(await market.actor.app_detail(item.appId));
        assert.ok("approved" in detail.candidate[0].state);
        assert.equal(detail.candidate[0].published, true);
        assert.equal(detail.app.publisher.toText(), trustedPrincipal.toText());
        assert.equal(detail.audit[0].auditor.toText(), trustedPrincipal.toText());
        assert.ok("approved" in detail.audit[0].decision);
        assert.match(detail.audit[0].analysis, /first.party|publisher/i, "Automatically retained audit explains its actual first-party authority");
        assert.match(detail.audit[0].analysis, /hash|digest|artifact/i, "Automatic verification describes verified artifacts");
        auditIds.push(detail.audit[0].id);
      }
      assert.deepEqual(success(await trusted.trusted_publish_batch(request)), published, "Exact batch retry is the same durable receipt");
      rejected(await trusted.trusted_publish_batch({ ...request, analysis: "Different intent using the same ID" }), "Batch IDs bind the complete request");
      assert.equal(success(await auditor.audit_queue({ cursor: [], limit: 20n })).candidates.length, 0);

      const grant = { request_id: "c5".repeat(16), token: "d6".repeat(32), paths: [first.pkg.path, first.source.path, first.image.path], fee_version: 1n };
      assert.equal(success(await trusted.repo_access_v1(grant)).accepted_cycles, 0n);
      const subnet = await pic.getCanisterSubnetId(market.canisterId);
      assert.ok(subnet);
      const rootKey = new Uint8Array(await pic.getPubKey(subnet));
      async function readFiles() {
        for (const artifact of [first.pkg, first.source, first.image]) {
          const req = { url: artifact.path, method: "GET", headers: [["Authorization", `Bearer ${grant.token}`]], body: new Uint8Array(), certificate_version: [2] };
          const response = await market.actor.http_request(req);
          assert.equal(response.status_code, 200);
          let next = response.streaming_strategy[0]?.Callback.token;
          assert.ok(next, "Every large package, source and image uses real HTTP streaming");
          const chunks = [Buffer.from(response.body)];
          while (next) {
            const part = await market.actor.http_streaming_callback(next);
            chunks.push(Buffer.from(part.body));
            next = part.token[0];
          }
          const bytes = Buffer.concat(chunks);
          assert.deepEqual(bytes, Buffer.from(artifact.bytes));
          const verification = verifyRequestResponsePair(req, { status_code: response.status_code, headers: response.headers, body: bytes }, market.canisterId.toUint8Array(), BigInt(await pic.getTime()) * 1_000_000n, 300_000_000_000n, rootKey, 2);
          assert.equal(verification.verificationVersion, 2);
        }
      }
      await readFiles();
      await upgrade([identity(96)]);
      assert.equal((await market.actor.marketplace_info()).trustedPublishingPrincipal[0].toText(), trustedPrincipal.toText(), "Upgrade arguments cannot replace retained publishing authority");
      assert.equal(success(await trusted.app_detail("trusted_reserved")).app.publisher.toText(), trustedPrincipal.toText(), "Upgrade preserves first-party reservation ownership");
      assert.deepEqual(success(await trusted.trusted_publish_status({ requestId: request.requestId }))[0], published);
      assert.deepEqual(success(await trusted.trusted_publish_batch(request)), published);
      for (const [index, item] of [first, second].entries()) {
        const detail = success(await market.actor.app_detail(item.appId));
        assert.equal(detail.audit[0].id, auditIds[index], "Replay after upgrade cannot create another approval record");
        assert.equal(detail.app.version[0], 100n);
      }
      await readFiles();
      rejected(await ctx.as(identity(96)).listing_save(ctx.listing("upgrade_hijack")), "An unrelated upgrade argument cannot take over subsidized publishing");
      await direct("listing_save", ctx.listing("trusted_after_upgrade"));
    } finally { await ctx.shutdown(); }
  },
}, {
  name: "Trusted publishing API: Neutron paid acquisition and direct royalty withdrawal survive upgrade without duplicate ledger effects",
  scope: "upgrade",
  async run() {
    const ctx = await setup();
    try {
      const { pic, market, trusted, trustedPrincipal, buyer, admin, ledger, charged, direct, candidate, batch, upgrade } = ctx;
      const app = await candidate("trusted_paid", 61);
      await direct("trusted_publish_batch", batch("paid-publication", [app.row]));
      await charged(admin, "rates_refresh", { feeVersion: 1n });
      const quote = success(await relayCall(buyer, market, "purchase_quote", [{ requestId: "trusted-app-purchase", appIds: [app.appId], ledger: ledger.canisterId, referralCode: [] }]));
      assert.equal(quote.amount, 1_000_000n);
      assert.equal(quote.items[0].publisher.toText(), trustedPrincipal.toText());
      assert.equal(quote.items[0].developerAtoms, 300_000n);
      assert.equal(quote.items[0].burnAtoms, 700_000n);
      assert.deepEqual(success(await trusted.earnings_query()).credits, []);
      await ledger.actor.credit(account(buyer.canisterId), 1_000_020n);
      ok(await relayCall(buyer, ledger, "icrc2_approve", [{ from_subaccount: [], spender: quote.spender, amount: quote.amount + quote.fee, expected_allowance: [0n], expires_at: [], fee: [10n], memo: [], created_at_time: [BigInt(await pic.getTime()) * 1_000_000n] }]));
      rejected(await relayCall(buyer, market, "purchase", [{ quote, feeVersion: 1n }]), "Trusted app buyers still attach cycles through their own Neutron");
      assert.equal((await ledger.actor.stats()).transferFromCalls, 0n);
      const purchase = await charged(buyer, "purchase", { quote, feeVersion: 1n });
      assert.ok("complete" in purchase.order.state);
      assert.equal((await ledger.actor.stats()).transferFromCalls, 1n);
      assert.deepEqual(success(await relayCall(buyer, market, "library_query", [{ cursor: [], limit: 20n }])).apps.map((item: any) => item.appId), [app.appId]);
      const earned = success(await trusted.earnings_query()).credits;
      assert.equal(earned.length, 1);
      assert.equal(earned[0].owner.toText(), trustedPrincipal.toText());
      assert.equal(earned[0].available, 300_000n);
      const withdrawalQuote = success(await trusted.withdraw_quote({ requestId: "trusted-royalties", ledger: ledger.canisterId, to: account(trustedPrincipal), totalDebit: 300_000n }));
      assert.equal(withdrawalQuote.netAmount, 299_990n);
      const withdrawn = success(await trusted.withdraw({ quote: withdrawalQuote, feeVersion: 1n }));
      assert.ok("complete" in withdrawn.withdrawal.state);
      assert.equal(withdrawn.withdrawal.owner.toText(), trustedPrincipal.toText());
      assert.equal((await ledger.actor.stats()).transferCalls, 1n, "Direct trusted withdrawal uses the real ICRC ledger once");
      assert.equal(await ledger.actor.icrc1_balance_of(account(trustedPrincipal)), 299_990n);
      assert.equal(await ledger.actor.icrc1_balance_of(account(market.canisterId)), 700_000n, "Only the developer share and its own fee leave the marketplace");
      assert.equal(success(await trusted.withdraw({ quote: withdrawalQuote, feeVersion: 1n })).withdrawal.id, withdrawn.withdrawal.id);
      await upgrade([]);
      const saved = success(await trusted.withdraw_status({ requestId: "trusted-royalties" }))[0];
      assert.ok("complete" in saved.withdrawal.state);
      assert.equal(saved.withdrawal.id, withdrawn.withdrawal.id);
      assert.equal(saved.attempt[0].block[0], withdrawn.attempt[0].block[0]);
      assert.equal(success(await trusted.withdraw({ quote: withdrawalQuote, feeVersion: 1n })).withdrawal.id, withdrawn.withdrawal.id);
      assert.equal((await charged(buyer, "purchase", { quote, feeVersion: 1n })).order.id, purchase.order.id);
      assert.equal((await ledger.actor.stats()).transferCalls, 1n);
      assert.equal((await ledger.actor.stats()).transferFromCalls, 1n);
      assert.equal(success(await trusted.earnings_query()).credits[0].available, 0n);
      assert.equal(await ledger.actor.icrc1_balance_of(account(trustedPrincipal)), 299_990n);
      assert.equal(success(await trusted.trusted_publish_status({ requestId: "paid-publication" }))[0].entries[0].candidateId, app.row.id);
    } finally { await ctx.shutdown(); }
  },
}, {
  name: "Trusted publishing API: failure after an earlier approval rolls back batch state and blob retirement",
  scope: "protocol",
  async run() {
    const ctx = await setup();
    try {
      const { market, trusted, auditor, candidate, direct, upload, batch } = ctx;
      const first = await candidate("atomic_first", 71);
      await direct("trusted_publish_batch", batch("atomic-baseline", [first.row]));
      async function successor(item: Awaited<ReturnType<typeof candidate>>, byte: number) {
        const pkg = await upload(item.appId, "package", Uint8Array.of(byte, 7, 11, 13), direct, "-101");
        const source = await upload(item.appId, "source", Uint8Array.of(byte, 17, 19, 23), direct, "-101");
        return direct("candidate_submit", { ...item.input, requestId: `${item.appId}-candidate-101`, version: 101n, artifactId: pkg.id, sourceArtifactId: [source.id] });
      }
      const nextFirst = await successor(first, 72);
      const stale = await candidate("atomic_stale", 81);
      const nextStale = await successor(stale, 82);
      await direct("trusted_publish_batch", batch("publish-higher-second", [nextStale]));
      const prior = success(await trusted.app_detail(first.appId));
      assert.equal(prior.app.version[0], 100n);
      assert.ok("pending" in success(await auditor.audit_candidate(nextFirst.id)).state);
      assert.ok("pending" in success(await auditor.audit_candidate(stale.row.id)).state);
      const grant = { request_id: "e7".repeat(16), token: "f8".repeat(32), paths: [first.pkg.path, first.source.path], fee_version: 1n };
      success(await trusted.repo_access_v1(grant));
      const request = batch("must-roll-back", [nextFirst, stale.row]);
      // The second entry has correct hashes, owner and pending state, so batch
      // preflight accepts it. Audits rejects its stale version only after the
      // first entry has approved v101 and retired that app's old blob bytes.
      await assert.rejects(() => trusted.trusted_publish_batch(request), /publication batch was not committed.*higher version/is);
      assert.deepEqual(success(await trusted.trusted_publish_status({ requestId: request.requestId })), []);
      assert.deepEqual(success(await trusted.app_detail(first.appId)), prior, "First approval, audit, version pointer and metadata all roll back");
      assert.ok("pending" in success(await auditor.audit_candidate(nextFirst.id)).state);
      assert.ok("pending" in success(await auditor.audit_candidate(stale.row.id)).state);
      assert.equal(success(await market.actor.app_detail(stale.appId)).app.version[0], 101n, "The already-published second app is unchanged");
      const subnet = await ctx.pic.getCanisterSubnetId(market.canisterId);
      assert.ok(subnet);
      const rootKey = new Uint8Array(await ctx.pic.getPubKey(subnet));
      for (const artifact of [first.pkg, first.source]) {
        const req = { url: artifact.path, method: "GET", headers: [["Authorization", `Bearer ${grant.token}`]], body: new Uint8Array(), certificate_version: [2] };
        const response = await market.actor.http_request(req);
        assert.equal(response.status_code, 200, "Old authorized blob retirement rolls back with the failed batch");
        assert.deepEqual(Uint8Array.from(response.body), artifact.bytes);
        const verified = verifyRequestResponsePair(req, { status_code: response.status_code, headers: response.headers, body: Uint8Array.from(response.body) }, market.canisterId.toUint8Array(), BigInt(await ctx.pic.getTime()) * 1_000_000n, 300_000_000_000n, rootKey, 2);
        assert.equal(verified.verificationVersion, 2, "The retained old bytes still match their certified HTTP success paths");
        assert.equal(success(await trusted.upload_status({ requestId: artifact.requestId })).artifactId[0], artifact.id);
      }
      const completed = await direct("trusted_publish_batch", batch("commit-after-rollback", [nextFirst]));
      assert.equal(completed.entries[0].candidateId, nextFirst.id, "A rolled-back approval remains executable under a new valid batch");
      assert.equal(success(await market.actor.app_detail(first.appId)).app.version[0], 101n);
    } finally { await ctx.shutdown(); }
  },
}];
