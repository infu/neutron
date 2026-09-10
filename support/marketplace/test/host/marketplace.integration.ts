import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { account, deferredRelayCall, installFixture, method, ok, relayCall, session, until, wire, type IntegrationCase } from "./helpers.ts";

function succeeded<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected protocol success, received ${wire(result)}`);
  return result.ok;
}

const principal = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

export const cases: IntegrationCase[] = [{
  name: "Marketplace API: audited free/paid acquisition, split withdrawal, Neutron cycles, private reads and upgrade",
  scope: "protocol",
  async run() {
    const env = await session();
    try {
      const publisher = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const buyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const affiliate = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const ledger = await installFixture(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
      const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
      const auditorPrincipal = principal(31);
      const browserPrincipal = principal(32);
      const config = {
        admins: [publisher.canisterId], auditors: [],
        tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
        xrc: oracle.canisterId,
        fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
        referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
        trustedPublishingPrincipal: [], reservations: [[{ appId: "reserved_app", publisher: publisher.canisterId, title: "Existing publisher app" }]],
      };
      const marketplace = await installFixture(env.pic, "marketplace", "mo/main.mo", [config]);
      const endpoints = marketplace.idlFactory({ IDL })._fields.map(([name]: [string, unknown]) => name);
      assert.ok(!endpoints.includes("admin_reconcile_forward"), "The removed ledger-history recovery endpoint stays absent");
      for (const name of ["purchase", "withdraw"]) {
        const fields = method(marketplace, name).argTypes[0]._fields.map(([field]: [string, unknown]) => field);
        assert.ok(!fields.includes("receiptBlock"), `${name} has no manual ledger-block input`);
      }
      const caller = (sender: any) => {
        const actor = env.pic.createActor(marketplace.idlFactory, marketplace.canisterId);
        actor.setPrincipal(sender);
        return actor;
      };
      const browser = caller(browserPrincipal);
      const auditor = caller(auditorPrincipal);
      const charged = async (neutron: any, name: string, arg: unknown) => succeeded(await relayCall(neutron, marketplace, name, [arg], 1_000_000_000n));
      const listing = { appId: "test_free", title: "Test free app", summary: "Local fixture listing", description: "Local integration artifact", priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n };
      assert.ok("err" in await relayCall(buyer, marketplace, "listing_save", [{ ...listing, appId: "reserved_app" }], 1_000_000_000n), "Initial app-ID reservations prevent another Neutron taking an existing publisher's ID");
      assert.ok("err" in await browser.listing_save(listing), "Browser ingress cannot create a charged listing");
      assert.ok("err" in await relayCall(publisher, marketplace, "listing_save", [listing], 0n), "Neutron update without cycles is rejected");
      await charged(publisher, "listing_save", listing);
      await charged(buyer, "read_delegate_set", { browser: browserPrincipal, active: true, feeVersion: 1n });
      assert.equal(succeeded(await browser.library_query({ cursor: [], limit: 20n })).apps.length, 0);
      const outsider = caller(principal(33));
      assert.ok("err" in await outsider.library_query({ cursor: [], limit: 20n }));

      async function artifact(appId: string, kind: "package" | "source", byte: number) {
        // Opaque bytes isolate source storage/audit ownership. This is not a
        // package compiler/install-format qualification test.
        const bytes = Uint8Array.of(byte, 17, 23, 29);
        const requestId = `${appId}-${kind}`;
        await charged(publisher, "upload_begin", { requestId, appId, digest: digest(bytes), size: BigInt(bytes.length), mediaType: "application/octet-stream", purpose: { [kind]: null }, feeVersion: 1n });
        await charged(publisher, "upload_chunk", { requestId, offset: 0n, bytes, feeVersion: 1n });
        const result = await charged(publisher, "upload_finish", { requestId, feeVersion: 1n });
        assert.equal(result.artifactId.length, 1);
        return result.artifactId[0];
      }
      const packageArtifact = await artifact(listing.appId, "package", 1);
      const sourceArtifact = await artifact(listing.appId, "source", 2);
      const candidate = await charged(publisher, "candidate_submit", { requestId: "candidate-1", appId: listing.appId, version: 100n, artifactId: packageArtifact, sourceArtifactId: [sourceArtifact], dependencies: [], feeVersion: 1n });
      const catalogRequest = { search: "", tier: { free: null }, window: { all: null }, cursor: [], limit: 20n };
      assert.equal(succeeded(await marketplace.actor.catalog_query(catalogRequest)).apps.length, 0, "Unaudited app is hidden");
      const stamp = { requestId: "stamp-1", candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest, decision: { approved: null }, analysis: "Fixture bytes inspected for this local test", reason: [] };
      assert.ok("err" in await outsider.audit_stamp(stamp), "Unassigned principals cannot stamp");
      assert.ok("err" in await auditor.audit_stamp(stamp), "A browser is not an auditor until an admin assigns it");
      await charged(publisher, "admin_auditor_set", { principal: auditorPrincipal, active: true, feeVersion: 1n });
      succeeded(await auditor.audit_stamp(stamp)); // Auditor endpoint: no cycles attached.
      assert.ok("err" in await auditor.listing_save({ ...listing, appId: "audit_freepass" }), "Auditor exemption does not apply to publisher writes");
      assert.equal(succeeded(await marketplace.actor.app_detail(listing.appId)).app.visible, true);
      const quote = succeeded(await browser.purchase_quote({ requestId: "free-acquisition", appIds: [listing.appId], ledger: ledger.canisterId, referralCode: [] }));
      assert.equal(quote.amount, 0n);
      assert.ok("err" in await browser.purchase({ quote, feeVersion: 1n }), "Read delegation does not authorize direct updates");
      const acquired = await charged(buyer, "purchase", { quote, feeVersion: 1n });
      assert.ok("complete" in acquired.order.state);
      const retry = await charged(buyer, "purchase", { quote, feeVersion: 1n });
      assert.equal(retry.order.id, acquired.order.id);
      assert.equal((await ledger.actor.stats()).appliedTransactions, 0n, "Free acquisition never touches the ledger");
      const library = succeeded(await browser.library_query({ cursor: [], limit: 20n }));
      assert.deepEqual(library.apps.map((app: any) => app.appId), [listing.appId]);

      // Exercise the public endpoints and their owner/cycle boundary in addition
      // to the isolated payment-engine fault-injection suites.
      const paidDependencyId = "test_paid_dependency";
      await charged(publisher, "listing_save", { ...listing, appId: paidDependencyId, priceUsdMicros: 1_000_000n });
      const dependencyPackage = await artifact(paidDependencyId, "package", 5);
      const dependencySource = await artifact(paidDependencyId, "source", 6);
      const dependencyCandidate = await charged(publisher, "candidate_submit", { requestId: "dependency-candidate", appId: paidDependencyId, version: 100n, artifactId: dependencyPackage, sourceArtifactId: [dependencySource], dependencies: [], feeVersion: 1n });
      succeeded(await auditor.audit_stamp({ ...stamp, requestId: "dependency-stamp", candidateId: dependencyCandidate.id, expectedDigest: dependencyCandidate.digest, expectedSourceDigest: dependencyCandidate.sourceDigest }));
      const paidAppId = "test_paid";
      await charged(publisher, "listing_save", { ...listing, appId: paidAppId, priceUsdMicros: 10_000_000n });
      const paidPackage = await artifact(paidAppId, "package", 3);
      const paidSource = await artifact(paidAppId, "source", 4);
      const paidCandidate = await charged(publisher, "candidate_submit", { requestId: "paid-candidate", appId: paidAppId, version: 100n, artifactId: paidPackage, sourceArtifactId: [paidSource], dependencies: [{ appId: paidDependencyId, minVersion: 100n }], feeVersion: 1n });
      succeeded(await auditor.audit_stamp({ ...stamp, requestId: "paid-stamp", candidateId: paidCandidate.id, expectedDigest: paidCandidate.digest, expectedSourceDigest: paidCandidate.sourceDigest }));
      const packagePath = `/repo/v1/packages/${Buffer.from(paidCandidate.digest).toString("hex")}.neutron`;
      const grant = { request_id: "a1".repeat(16), token: "b2".repeat(32), paths: [packagePath], fee_version: 1n };
      assert.ok("err" in await relayCall(buyer, marketplace, "repo_access_v1", [grant], 1_000_000_000n), "A Neutron cannot download an unowned paid package");
      await charged(publisher, "admin_auditor_set", { principal: auditorPrincipal, active: false, feeVersion: 1n });
      const removedAudit = await auditor.audit_stamp({ ...stamp, requestId: "removed-auditor", candidateId: paidCandidate.id, expectedDigest: paidCandidate.digest, expectedSourceDigest: paidCandidate.sourceDigest, decision: { revoked: null }, reason: ["Must not take effect after role removal"] });
      assert.ok("err" in removedAudit);
      assert.match(removedAudit.err.message, /assigned auditor/i);
      const refreshed = await charged(publisher, "rates_refresh", { feeVersion: 1n });
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0].rateUpdated, true);
      const referral = await charged(affiliate, "referral_get_or_create", { feeVersion: 1n });
      const paidQuote = succeeded(await browser.purchase_quote({ requestId: "paid-acquisition", appIds: [paidAppId], ledger: ledger.canisterId, referralCode: [referral.code] }));
      assert.deepEqual(paidQuote.items.map((item: any) => item.appId).sort(), [paidAppId, paidDependencyId].sort(), "The quote includes an unowned paid dependency before funding");
      assert.equal(paidQuote.amount, 9_900_000n, "$10 root plus $1 required app, less 10% referral discount");
      const rootItem = paidQuote.items.find((item: any) => item.appId === paidAppId);
      assert.equal(rootItem.developerAtoms, 2_700_000n);
      assert.equal(rootItem.affiliateAtoms, 2_700_000n);
      assert.equal(rootItem.burnAtoms, 3_600_000n);
      assert.equal(paidQuote.items.reduce((sum: bigint, item: any) => sum + item.developerAtoms + item.affiliateAtoms + item.burnAtoms, 0n), paidQuote.amount);
      assert.ok("err" in await relayCall(buyer, marketplace, "purchase", [{ quote: { ...paidQuote, amount: 1n }, feeVersion: 1n }], 1_000_000_000n), "A caller cannot alter a quoted payment amount");
      assert.equal((await ledger.actor.stats()).appliedTransactions, 0n);
      await ledger.actor.credit(account(buyer.canisterId), 10_000_000n);
      ok(await relayCall(buyer, ledger, "icrc2_approve", [{
        from_subaccount: [], spender: paidQuote.spender, amount: paidQuote.amount + paidQuote.fee,
        expected_allowance: [0n], expires_at: [], fee: [10n], memo: [Uint8Array.of(3)],
        created_at_time: [BigInt(await env.pic.getTime()) * 1_000_000n],
      }]));
      await ledger.actor.setScript([{ commitThenReject: "public endpoint test: collection reply lost" }]);
      const unresolved = await charged(buyer, "purchase", { quote: paidQuote, feeVersion: 1n });
      assert.ok("outcome_unknown" in unresolved.order.state, "Committed ledger effect retains uncertainty after lost reply");
      assert.equal(await ledger.actor.icrc1_balance_of(account(marketplace.canisterId)), 9_900_000n);
      // Withhold the caller's next update response. A reconnected browser must
      // learn the completed outcome through stored status before consuming it.
      const receivePurchase = await deferredRelayCall(env.pic, buyer, marketplace, "purchase", [{ quote: paidQuote, feeVersion: 1n }], 1_000_000_000n);
      let paidAcquired: any;
      await until(env.pic, async () => {
        const saved = succeeded<any[]>(await browser.purchase_status({ requestId: "paid-acquisition" }));
        paidAcquired = saved[0];
        return Boolean(paidAcquired && "complete" in paidAcquired.order.state);
      }, "stored purchase completion while its browser response is withheld");
      const callsBeforeStatus = (await ledger.actor.stats()).transferFromCalls;
      const reconnected = succeeded<any[]>(await browser.purchase_status({ requestId: "paid-acquisition" }))[0];
      assert.equal(reconnected.order.id, paidAcquired.order.id);
      assert.equal(reconnected.attempt.length, 1);
      assert.ok("succeeded" in reconnected.attempt[0].state);
      assert.equal(reconnected.attempt[0].block.length, 1);
      assert.equal((await ledger.actor.stats()).transferFromCalls, callsBeforeStatus, "Stored status reads cannot dispatch a payment");
      await receivePurchase(); // Drain transport only; recovery used status above.
      assert.ok("complete" in paidAcquired.order.state);
      assert.equal(paidAcquired.order.id, unresolved.order.id);
      assert.equal((await ledger.actor.stats()).appliedTransactions, 2n, "One approval and one collection despite retry");
      const install = await charged(buyer, "install_prepare", { requestId: "install-purchased-root", appIds: [paidAppId], feeVersion: 1n });
      assert.deepEqual([...install.appIds].sort(), [paidAppId, paidDependencyId].sort(), "The completed checkout can immediately prepare its full installation");
      await charged(buyer, "repo_access_v1", grant);
      const subnet = await env.pic.getCanisterSubnetId(marketplace.canisterId);
      assert.ok(subnet);
      const rootKey = new Uint8Array(await env.pic.getPubKey(subnet));
      const privateRequest = { url: packagePath, method: "GET", headers: [["Authorization", `Bearer ${grant.token}`]], body: new Uint8Array(), certificate_version: [2] };
      const verifiedPackage = async () => {
        const response = await marketplace.actor.http_request(privateRequest);
        assert.equal(response.status_code, 200);
        assert.equal(response.headers.find(([name]: [string, string]) => name.toLowerCase() === "content-type")?.[1], "application/vnd.neutron.package", "Browser upload MIME guesses cannot change the certified package format");
        assert.deepEqual(Uint8Array.from(response.body), Uint8Array.of(3, 17, 23, 29));
        const verification = verifyRequestResponsePair(privateRequest, { status_code: response.status_code, headers: response.headers, body: Uint8Array.from(response.body) }, marketplace.canisterId.toUint8Array(), BigInt(await env.pic.getTime()) * 1_000_000n, 300_000_000_000n, rootKey, 2);
        assert.equal(verification.verificationVersion, 2);
      };
      await verifiedPackage();
      assert.equal((await marketplace.actor.http_request({ ...privateRequest, headers: [] })).status_code, 403);
      const earned = succeeded(await relayCall(publisher, marketplace, "earnings_query", []));
      assert.equal(earned.credits.find((credit: any) => !credit.isBurn).available, 2_970_000n);
      const affiliateEarned = succeeded(await relayCall(affiliate, marketplace, "earnings_query", []));
      assert.equal(affiliateEarned.credits.find((credit: any) => !credit.isBurn).available, 2_970_000n);
      const withdrawQuote = succeeded(await relayCall(publisher, marketplace, "withdraw_quote", [{ requestId: "publisher-payout", ledger: ledger.canisterId, to: account(publisher.canisterId), totalDebit: 2_970_000n }]));
      assert.equal(withdrawQuote.netAmount, 2_969_990n);
      const withdrawal = await charged(publisher, "withdraw", { quote: withdrawQuote, feeVersion: 1n });
      assert.ok("complete" in withdrawal.withdrawal.state);
      const withdrawnAgain = await charged(publisher, "withdraw", { quote: withdrawQuote, feeVersion: 1n });
      assert.equal(withdrawnAgain.withdrawal.id, withdrawal.withdrawal.id);
      assert.equal(await ledger.actor.icrc1_balance_of(account(publisher.canisterId)), 2_969_990n);
      assert.equal((await ledger.actor.stats()).appliedTransactions, 3n, "One withdrawal after its exact retry");
      await charged(buyer, "rating_set", { appId: paidAppId, stars: 4n, review: "Local test", feeVersion: 1n });
      assert.equal(succeeded(await browser.app_detail(paidAppId)).app.ratingCount, 1n);

      await env.pic.upgradeCanister({
        canisterId: marketplace.canisterId, wasm: marketplace.wasmPath,
        arg: IDL.encode(marketplace.init({ IDL }), [{ ...config, reservations: [[{ appId: "reserved_app", publisher: buyer.canisterId, title: "Must not overwrite on upgrade" }]] }]),
        upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
      });
      const after = succeeded(await browser.library_query({ cursor: [], limit: 20n }));
      assert.ok("err" in await relayCall(buyer, marketplace, "listing_save", [{ ...listing, appId: "reserved_app" }], 1_000_000_000n), "Upgrade arguments must not replace the retained publisher reservation");
      assert.deepEqual(after.apps.map((app: any) => app.appId).sort(), [listing.appId, paidAppId, paidDependencyId].sort());
      const status = succeeded(await browser.purchase_status({ requestId: "free-acquisition" }));
      assert.equal(status.length, 1);
      assert.ok("complete" in status[0].order.state);
      assert.equal((await ledger.actor.stats()).appliedTransactions, 3n);
      await verifiedPackage();
      const oracleCalls = (await oracle.actor.stats()).calls;
      await env.pic.advanceTime(86_461_000);
      await until(env.pic, async () => (await oracle.actor.stats()).calls > oracleCalls, "the restored main actor timer to run the next daily oracle job");
      assert.equal((await ledger.actor.stats()).appliedTransactions, 3n, "An unset burn destination never initiates a payout");
    } finally { await env.shutdown(); }
  },
}];
