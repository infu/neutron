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
import { buildMarketplace } from "../../scripts/build.ts";
import { prepareAsh, projectRoot } from "../../scripts/test-ash-runtime.ts";
import { account, installFixture, ok, relayCall, session, wire, type IntegrationCase } from "./helpers.ts";

const previousPath = process.env.MARKETPLACE_PREVIOUS_PROTOCOL_WASM;
const deployedHash = "2bde4755ae504b96706c48b752daa681a19a5b0aa302da764c41529c00789143";
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const principal = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
function success<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected protocol success, got ${wire(result)}`);
  return result.ok;
}

async function targetProtocol() {
  const directory = process.env.MARKETPLACE_COUNTS_ARTIFACTS_DIR ?? await mkdtemp(path.join(os.tmpdir(), "marketplace-acquisition-counts-"));
  await mkdir(directory, { recursive: true });
  const built = await buildMarketplace({ outputPath: path.join(directory, "marketplace.wasm") });
  const bytes = await readFile(built.wasmPath);
  const wasmPath = `${built.wasmPath}.gz`;
  await writeFile(wasmPath, gzipSync(bytes, { level: 9 }));
  const bindings = await (await prepareAsh()).bind(built.candidPath, path.join(directory, "marketplace"), projectRoot);
  const { idlFactory, init } = await import(pathToFileURL(bindings.jsPath).href);
  const wasmHash = createHash("sha256").update(bytes).digest("hex");
  console.log(`Acquisition-count release module: ${built.wasmPath}; SHA-256: ${wasmHash}`);
  return { ...built, rawWasmPath: built.wasmPath, wasmPath, wasmHash, idlFactory, init };
}

export const cases: IntegrationCase[] = [{
  name: `acquisition counts preserve free and paid history across ${previousPath ? "deployed protocol" : "same-module"} keep upgrade`,
  scope: "upgrade",
  async run() {
    const env = await session();
    try {
      const firstBuyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const secondBuyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const ledger = await installFixture(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
      const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
      const compiled = await targetProtocol();
      const publisherPrincipal = principal(121), auditorPrincipal = principal(122);
      const config = {
        admins: [publisherPrincipal], auditors: [auditorPrincipal], trustedPublishingPrincipal: [publisherPrincipal], reservations: [],
        tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
        xrc: oracle.canisterId,
        fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
        referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
      };
      const arg = IDL.encode(compiled.init({ IDL }), [config]);
      const listing = (appId: string, priceUsdMicros: bigint) => ({
        appId, title: appId, summary: "Acquisition count fixture", description: "Public API counts and retained acquisition history.",
        priceUsdMicros, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n,
      });
      const actorAs = (canisterId: any, sender: ReturnType<typeof principal>) => {
        const actor = env.pic.createActor(compiled.idlFactory, canisterId);
        actor.setPrincipal(sender);
        return actor;
      };
      const registerPublisher = async (publisher: ReturnType<typeof actorAs>) => success(await publisher.publisher_profile_register({
        publisherId: "countspublisher", name: "Counts publisher", description: "Acquisition count fixture.", feeVersion: 1n,
      }));

      // Clean initialization must return actual zeros rather than absent data.
      const freshId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
      await env.pic.installCode({ canisterId: freshId, wasm: compiled.wasmPath, arg });
      const freshPublisher = actorAs(freshId, publisherPrincipal);
      await registerPublisher(freshPublisher);
      const fresh = success(await freshPublisher.listing_save(listing("clean_count", 0n)));
      assert.deepEqual(fresh.acquisitionCounts, [{ free: 0n, paid: 0n }]);
      assert.deepEqual(success(await freshPublisher.app_detail("clean_count")).app.acquisitionCounts, [{ free: 0n, paid: 0n }]);

      // CI can check restoration without private artifacts; production release
      // qualification supplies and pins the exact previously deployed module.
      const previous = await readFile(previousPath ?? compiled.rawWasmPath);
      if (previousPath) {
        assert.equal(createHash("sha256").update(previous).digest("hex"), deployedHash);
        assert.notEqual(compiled.wasmHash, deployedHash);
      }
      const canisterId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
      await env.pic.installCode({ canisterId, wasm: gzipSync(previous, { level: 9 }), arg });
      const actor = env.pic.createActor(compiled.idlFactory, canisterId);
      const market = { ...compiled, actor, canisterId };
      const publisher = actorAs(canisterId, publisherPrincipal);
      const auditor = actorAs(canisterId, auditorPrincipal);
      const call = async (buyer: typeof firstBuyer, name: string, value: unknown, cycles = 1_000_000_000n) => success(await relayCall(buyer, market, name, [value], cycles));
      // The archived module has no profile endpoint; do not mutate its fixture
      // using APIs introduced by the target release.
      if (!previousPath) await registerPublisher(publisher);
      const appId = "historical_counts";
      const saved = success(await publisher.listing_save(listing(appId, 0n)));
      const bytes = Uint8Array.of(67, 79, 85, 78, 84);
      success(await publisher.upload_begin({ requestId: "counts-package", appId, digest: digest(bytes), size: BigInt(bytes.length), mediaType: "application/octet-stream", purpose: { package: null }, feeVersion: 1n }));
      success(await publisher.upload_chunk({ requestId: "counts-package", offset: 0n, bytes, feeVersion: 1n }));
      const uploaded = success(await publisher.upload_finish({ requestId: "counts-package", feeVersion: 1n }));
      const candidate = success(await publisher.candidate_submit({ requestId: "counts-candidate", appId, version: 100n, artifactId: uploaded.artifactId[0], sourceArtifactId: [], dependencies: [], feeVersion: 1n }));
      success(await auditor.audit_stamp({ requestId: "counts-audit", candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest, decision: { approved: null }, analysis: "Opaque test fixture inspected", reason: [] }));
      const freeQuote = await call(firstBuyer, "purchase_quote", { requestId: "count-free-acquisition", appIds: [appId], ledger: ledger.canisterId, referralCode: [] }, 0n);
      assert.equal(freeQuote.amount, 0n);
      const freePurchase = await call(firstBuyer, "purchase", { quote: freeQuote, feeVersion: 1n });
      assert.ok("complete" in freePurchase.order.state);

      // A price change must not relabel the prior free acquisition as a sale.
      success(await publisher.listing_save({ ...listing(appId, 1_000_000n), expectedRevision: [saved.revision] }));
      success(await publisher.rates_refresh({ feeVersion: 1n }));
      const paidQuote = await call(secondBuyer, "purchase_quote", { requestId: "count-paid-acquisition", appIds: [appId], ledger: ledger.canisterId, referralCode: [] }, 0n);
      assert.equal(paidQuote.amount, 1_000_000n);
      await ledger.actor.credit(account(secondBuyer.canisterId), 2_000_000n);
      ok(await relayCall(secondBuyer, ledger, "icrc2_approve", [{
        from_subaccount: [], spender: paidQuote.spender, amount: paidQuote.amount + paidQuote.fee,
        expected_allowance: [0n], expires_at: [], fee: [10n], memo: [],
        created_at_time: [BigInt(Math.floor(await env.pic.getTime())) * 1_000_000n],
      }]));
      const paidPurchase = await call(secondBuyer, "purchase", { quote: paidQuote, feeVersion: 1n });
      assert.ok("complete" in paidPurchase.order.state);
      const statsBefore = await ledger.actor.stats();
      assert.equal(statsBefore.appliedTransactions, 2n, "Only approval and paid acquisition reach the ledger");
      const before = success(await actor.app_detail(appId));
      if (previousPath) assert.deepEqual(before.app.acquisitionCounts, [], "The live predecessor omitted optional count metadata");
      const statusBefore = await call(secondBuyer, "purchase_status", { requestId: paidQuote.request.requestId }, 0n);

      await env.pic.upgradeCanister({ canisterId, wasm: compiled.wasmPath, arg, upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      const after = success(await actor.app_detail(appId));
      assert.deepEqual(after.app.acquisitionCounts, [{ free: 1n, paid: 1n }]);
      assert.deepEqual({ ...after.app, acquisitionCounts: before.app.acquisitionCounts }, before.app, "Upgrade changes only the derived response metadata");
      assert.deepEqual(after.candidate, before.candidate);
      assert.deepEqual(after.audit, before.audit);
      assert.deepEqual(await call(secondBuyer, "purchase_status", { requestId: paidQuote.request.requestId }, 0n), statusBefore);
      for (const buyer of [firstBuyer, secondBuyer]) {
        const library = await call(buyer, "library_query", { cursor: [], limit: 10n }, 0n);
        assert.equal(library.apps.length, 1);
        assert.equal(library.apps[0].owned, true);
        assert.deepEqual(library.apps[0].acquisitionCounts, [{ free: 1n, paid: 1n }]);
      }
      assert.deepEqual(await ledger.actor.stats(), statsBefore, "Upgrade and count reads must not call the ledger");

      // Reopening installation and replaying the exact saved purchase are not
      // additional acquisitions. Neither creates another ledger effect.
      const retried = await call(secondBuyer, "purchase", { quote: paidQuote, feeVersion: 1n });
      assert.equal(retried.order.id, paidPurchase.order.id);
      await call(secondBuyer, "install_prepare", { requestId: "counts-install-first", appIds: [appId], feeVersion: 1n });
      await call(secondBuyer, "install_prepare", { requestId: "counts-install-again", appIds: [appId], feeVersion: 1n });
      assert.deepEqual(success(await actor.app_detail(appId)).app.acquisitionCounts, [{ free: 1n, paid: 1n }]);
      assert.deepEqual(await ledger.actor.stats(), statsBefore);
      if (previousPath) {
        await registerPublisher(publisher);
        assert.deepEqual(success(await actor.app_detail(appId)).app.acquisitionCounts, [{ free: 1n, paid: 1n }], "Profile adoption preserves retained acquisition counts");
      }
    } finally { await env.shutdown(); }
  },
}];
