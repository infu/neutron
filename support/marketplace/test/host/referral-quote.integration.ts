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
import { buildMarketplace } from "../../scripts/build.ts";
import { prepareAsh, projectRoot } from "../../scripts/test-ash-runtime.ts";
import { installFixture, method, relayCall, session, wire, type IntegrationCase } from "./helpers.ts";

const previousPath = process.env.MARKETPLACE_PREVIOUS_PROTOCOL_WASM;
const deployedHash = "26feaa471ee6fbd2c86afffd6de80448f3e0c60ba8dc6dd11068b07540699c00";
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const principal = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
function success<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected protocol success, got ${wire(result)}`);
  return result.ok;
}
function rejected(result: any, code: string) {
  assert.ok(result && "err" in result, `Expected protocol rejection, got ${wire(result)}`);
  assert.equal(result.err.code, code);
}

async function targetProtocol() {
  const directory = process.env.MARKETPLACE_REFERRAL_ARTIFACTS_DIR ?? await mkdtemp(path.join(os.tmpdir(), "marketplace-referral-quote-"));
  await mkdir(directory, { recursive: true });
  const built = await buildMarketplace({ outputPath: path.join(directory, "marketplace.wasm") });
  const bytes = await readFile(built.wasmPath);
  const wasmPath = `${built.wasmPath}.gz`;
  await writeFile(wasmPath, gzipSync(bytes, { level: 9 }));
  const bindings = await (await prepareAsh()).bind(built.candidPath, path.join(directory, "marketplace"), projectRoot);
  const { idlFactory, init } = await import(pathToFileURL(bindings.jsPath).href);
  const wasmHash = createHash("sha256").update(bytes).digest("hex");
  console.log(`Referral-query release module: ${built.wasmPath}; SHA-256: ${wasmHash}`);
  return { ...built, rawWasmPath: built.wasmPath, wasmPath, wasmHash, idlFactory, init };
}

export const cases: IntegrationCase[] = [{
  name: `referral quote authenticates browser ownership and preserves saved data across ${previousPath ? "deployed protocol" : "same-module"} keep upgrade`,
  scope: "upgrade",
  async run() {
    const env = await session();
    try {
      const firstBuyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const secondBuyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const affiliate = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const ledger = await installFixture(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
      const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
      const compiled = await targetProtocol();
      assert.deepEqual(method(compiled, "referral_quote").annotations, ["query"], "Code activation is a free query, not an update");
      const publisherPrincipal = principal(123), auditorPrincipal = principal(124);
      const firstBrowserPrincipal = principal(125), secondBrowserPrincipal = principal(126);
      const config = {
        admins: [publisherPrincipal], auditors: [auditorPrincipal], trustedPublishingPrincipal: [publisherPrincipal], reservations: [],
        tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
        xrc: oracle.canisterId,
        fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
        referralTerms: { version: 7n, discountBps: 1250n, affiliateBps: 3000n, developerBps: 3000n },
      };
      const arg = IDL.encode(compiled.init({ IDL }), [config]);
      const actorAs = (canisterId: Principal, sender: Principal) => {
        const actor = env.pic.createActor(compiled.idlFactory, canisterId);
        actor.setPrincipal(sender);
        return actor;
      };
      function actors(canisterId: Principal) {
        const actor = env.pic.createActor(compiled.idlFactory, canisterId);
        const market = { ...compiled, actor, canisterId };
        return {
          market,
          publisher: actorAs(canisterId, publisherPrincipal), auditor: actorAs(canisterId, auditorPrincipal),
          firstBrowser: actorAs(canisterId, firstBrowserPrincipal), secondBrowser: actorAs(canisterId, secondBrowserPrincipal),
          outsider: actorAs(canisterId, principal(127)), anonymous: actorAs(canisterId, Principal.anonymous()),
          firstOwner: actorAs(canisterId, firstBuyer.canisterId), affiliateOwner: actorAs(canisterId, affiliate.canisterId),
          call: async (buyer: typeof firstBuyer, name: string, value: unknown, cycles = 1_000_000_000n) => success(await relayCall(buyer, market, name, [value], cycles)),
        };
      }
      async function seedAccess(ctx: ReturnType<typeof actors>) {
        await ctx.call(firstBuyer, "read_delegate_set", { browser: firstBrowserPrincipal, active: true, feeVersion: 1n });
        await ctx.call(secondBuyer, "read_delegate_set", { browser: secondBrowserPrincipal, active: true, feeVersion: 1n });
        const other = await ctx.call(affiliate, "referral_get_or_create", { feeVersion: 1n });
        const own = await ctx.call(firstBuyer, "referral_get_or_create", { feeVersion: 1n });
        return { other, own };
      }
      async function exerciseRead(ctx: ReturnType<typeof actors>, referrals: Awaited<ReturnType<typeof seedAccess>>) {
        const expected = { code: referrals.other.code, affiliate: affiliate.canisterId, discountBps: 1250n, termsVersion: 7n };
        for (const browser of [ctx.firstBrowser, ctx.secondBrowser, ctx.firstOwner]) {
          assert.deepEqual(success(await browser.referral_quote(` \t${referrals.other.code.toLowerCase()}\r\n`)), expected);
        }
        rejected(await ctx.firstBrowser.referral_quote(referrals.own.code), "invalid_referral");
        rejected(await ctx.firstOwner.referral_quote(referrals.own.code), "invalid_referral");
        rejected(await ctx.affiliateOwner.referral_quote(referrals.other.code), "invalid_referral");
        for (const input of ["", " \r\n\t", "NOT-REGISTERED"]) rejected(await ctx.firstBrowser.referral_quote(input), "invalid_referral");
        rejected(await ctx.outsider.referral_quote(referrals.other.code), "delegate_required");
        rejected(await ctx.anonymous.referral_quote(referrals.other.code), "authentication_required");
        assert.deepEqual(success(await ctx.secondBrowser.earnings_query()).referral, [], "Validating another code never creates a buyer's own referral");
      }

      // A fresh installation already has the configured, non-default discount;
      // validation must work before any rates, listings or payment exist.
      const freshId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
      await env.pic.installCode({ canisterId: freshId, wasm: compiled.wasmPath, arg });
      const fresh = actors(freshId);
      const freshReferrals = await seedAccess(fresh);
      const freshLedgerBefore = await ledger.actor.stats();
      await exerciseRead(fresh, freshReferrals);
      assert.deepEqual(await ledger.actor.stats(), freshLedgerBefore, "Clean-init referral queries never reach a ledger");
      assert.deepEqual(success(await fresh.firstBrowser.library_query({ cursor: [], limit: 20n })).apps, []);

      // Release qualification supplies the exact deployed predecessor. CI may
      // instead use the same module to exercise stable-memory restoration.
      const previous = await readFile(previousPath ?? compiled.rawWasmPath);
      if (previousPath) {
        assert.equal(createHash("sha256").update(previous).digest("hex"), deployedHash);
        assert.notEqual(compiled.wasmHash, deployedHash);
      }
      const canisterId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
      await env.pic.installCode({ canisterId, wasm: gzipSync(previous, { level: 9 }), arg });
      const ctx = actors(canisterId);
      const referrals = await seedAccess(ctx);
      const appId = "retained_referral";
      success(await ctx.publisher.listing_save({
        appId, title: "Retained app", summary: "Referral upgrade fixture", description: "Retains listing, approval, ownership and attribution.",
        priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n,
      }));
      const bytes = Uint8Array.of(82, 69, 70, 69, 82);
      success(await ctx.publisher.upload_begin({ requestId: "referral-package", appId, digest: digest(bytes), size: BigInt(bytes.length), mediaType: "application/octet-stream", purpose: { package: null }, feeVersion: 1n }));
      success(await ctx.publisher.upload_chunk({ requestId: "referral-package", offset: 0n, bytes, feeVersion: 1n }));
      const uploaded = success(await ctx.publisher.upload_finish({ requestId: "referral-package", feeVersion: 1n }));
      const candidate = success(await ctx.publisher.candidate_submit({ requestId: "referral-candidate", appId, version: 100n, artifactId: uploaded.artifactId[0], sourceArtifactId: [], dependencies: [], feeVersion: 1n }));
      success(await ctx.auditor.audit_stamp({ requestId: "referral-audit", candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest, decision: { approved: null }, analysis: "Opaque fixture inspected", reason: [] }));
      const purchaseRequest = { requestId: "retained-free-acquisition", appIds: [appId], ledger: ledger.canisterId, referralCode: [referrals.other.code] };
      const quote = success(await ctx.firstBrowser.purchase_quote(purchaseRequest));
      assert.equal(quote.amount, 0n);
      const purchase = await ctx.call(firstBuyer, "purchase", { quote, feeVersion: 1n });
      assert.ok("complete" in purchase.order.state);
      const snapshot = async () => ({
        info: await ctx.market.actor.marketplace_info(),
        detail: success(await ctx.firstBrowser.app_detail(appId)),
        library: success(await ctx.firstBrowser.library_query({ cursor: [], limit: 20n })),
        earnings: success(await ctx.firstBrowser.earnings_query()),
        affiliateEarnings: success(await ctx.affiliateOwner.earnings_query()),
        secondBuyerEarnings: success(await ctx.secondBrowser.earnings_query()),
        history: success(await ctx.firstBrowser.operation_history({ purchaseCursor: { start: null }, withdrawalCursor: { start: null }, limit: 20n })),
        purchase: success(await ctx.firstBrowser.purchase_status({ requestId: purchaseRequest.requestId })),
        ledger: await ledger.actor.stats(),
      });
      const before = await snapshot();
      assert.equal(before.library.apps.length, 1);
      assert.equal(before.library.apps[0].owned, true);
      assert.equal(before.ledger.appliedTransactions, 0n, "The seeded free entitlement required no ledger transaction");
      await env.pic.upgradeCanister({ canisterId, wasm: compiled.wasmPath, arg, upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(await snapshot(), before, "Keep-upgrade preserves listings, audits, library, referrals, settings, history and ledger counters");
      await exerciseRead(ctx, referrals);
      assert.deepEqual(await snapshot(), before, "Successful and rejected referral queries do not alter saved state or call the ledger");
      await ctx.call(firstBuyer, "read_delegate_set", { browser: firstBrowserPrincipal, active: false, feeVersion: 1n });
      rejected(await ctx.firstBrowser.referral_quote(referrals.other.code), "delegate_revoked");
      assert.deepEqual(success(await ctx.secondBrowser.referral_quote(referrals.other.code)), {
        code: referrals.other.code, affiliate: affiliate.canisterId, discountBps: 1250n, termsVersion: 7n,
      }, "Revocation is scoped to the registered browser");
    } finally { await env.shutdown(); }
  },
}];
