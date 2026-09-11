import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { account, installFixture, relayCall, session, wire, type IntegrationCase } from "./helpers.ts";

function succeeded<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected success, received ${wire(result)}`);
  return result.ok;
}

function denied(result: any, code: string, description: string) {
  assert.ok(result && "err" in result, `${description}: ${wire(result)}`);
  assert.equal(result.err.code, code, description);
}

const identity = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

export const cases: IntegrationCase[] = [{
  name: "Marketplace admin access: direct identities and zero-cycle admin calls preserve ordinary mutation boundaries",
  scope: "protocol",
  async run() {
    const env = await session();
    try {
      const canisterAdmin = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const ledger = await installFixture(env.pic, "admin_access_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
      const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
      const adminPrincipal = identity(71);
      const auditorPrincipal = identity(72);
      const outsiderPrincipal = identity(73);
      const config = {
        admins: [adminPrincipal, canisterAdmin.canisterId], auditors: [],
        tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
        xrc: oracle.canisterId,
        fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
        referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
        trustedPublishingPrincipal: [], reservations: [],
      };
      // Install the exact public actor, including validation of its initial
      // self-authenticating administrator. No test-only authorization facade.
      const market = await installFixture(env.pic, "marketplace", "mo/main.mo", [config]);
      for (const [admins, expected] of [
        [[], /Configure at least one marketplace administrator/],
        [[Principal.anonymous()], /An administrator must have an authenticated principal/],
        [[Principal.fromText("aaaaa-aa")], /An administrator must have an authenticated principal/],
      ] as Array<[Principal[], RegExp]>) {
        await assert.rejects(
          installFixture(env.pic, "marketplace", "mo/main.mo", [{ ...config, admins }]),
          expected,
          "The public constructor must reject invalid administrator configurations",
        );
      }
      const as = (principal: Principal) => {
        const actor = env.pic.createActor(market.idlFactory, market.canisterId);
        actor.setPrincipal(principal);
        return actor;
      };
      const admin = as(adminPrincipal);
      const auditor = as(auditorPrincipal);
      const outsider = as(outsiderPrincipal);
      const anonymous = as(Principal.anonymous());
      const page = { cursor: [], limit: 20n };
      const burnAccount = { owner: outsiderPrincipal, subaccount: [new Uint8Array(32).fill(19)] };
      // The fields remain wire-compatible but these scoped exemptions do not
      // consult the cycle tariff/version or require an ingress cycle transfer.
      const auditorRequest = { principal: auditorPrincipal, active: true, feeVersion: 0n };
      const reservation = { appId: "admin_reserved", publisher: canisterAdmin.canisterId, title: "Reserved publisher", feeVersion: 0n };
      const burnRequest = { ledger: ledger.canisterId, account: [burnAccount], feeVersion: 0n };
      const refreshRequest = { feeVersion: 0n };

      denied(await auditor.audit_queue(page), "auditor_required", "The test auditor starts unassigned");
      succeeded(await admin.admin_auditor_set(auditorRequest));
      succeeded(await auditor.audit_queue(page));
      const reserved = succeeded(await admin.admin_reserve_app(reservation));
      assert.equal(reserved.publisher.toText(), canisterAdmin.canisterId.toText());
      succeeded(await admin.admin_set_burn_account(burnRequest));
      const info = await market.actor.marketplace_info();
      assert.deepEqual(info.tokens[0].burnAccount, [burnAccount]);
      const beforeRefresh = await oracle.actor.stats();
      const refreshed = succeeded<any[]>(await admin.rates_refresh(refreshRequest));
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0].rateUpdated, true);
      assert.equal(refreshed[0].ledger.toText(), ledger.canisterId.toText());
      const afterRefresh = await oracle.actor.stats();
      assert.ok(afterRefresh.calls > beforeRefresh.calls, "The exempt update actually calls the configured oracle");
      assert.ok(afterRefresh.cyclesReceived >= beforeRefresh.cyclesReceived + config.fees.xrc, "The marketplace still funds the oracle call");

      const adminCalls: Array<[string, any]> = [
        ["admin_auditor_set", auditorRequest],
        ["admin_reserve_app", reservation],
        ["admin_set_burn_account", burnRequest],
        ["rates_refresh", refreshRequest],
      ];
      for (const [label, actor] of [["unassigned identity", outsider], ["anonymous caller", anonymous], ["auditor without admin role", auditor]] as const) {
        for (const [name, request] of adminCalls) {
          denied(await actor[name](request), "admin_required", `${label} cannot call ${name}`);
        }
      }
      for (const [name, request] of adminCalls) {
        succeeded(await relayCall(canisterAdmin, market, name, [request], 0n));
      }
      denied(await admin.admin_reserve_app({ ...reservation, appId: "invalid_identity_publisher", publisher: adminPrincipal }), "neutron_required", "An admin exemption does not make a signing identity an app publisher");

      const charged = async (name: string, request: unknown) => succeeded(await relayCall(canisterAdmin, market, name, [request], 1_000_000_000n));
      await charged("publisher_profile_register", { publisherId: "adminpublisher", name: "Admin publisher", description: "Ordinary publishing cycle boundary fixture", feeVersion: 1n });
      const listing = {
        appId: "ordinary_admin_app", title: "Ordinary publisher app", summary: "Local authorization regression",
        description: "A real free package for checkout authorization tests", priceUsdMicros: 0n,
        iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n,
      };
      denied(await admin.listing_save(listing), "neutron_required", "Self-authenticating admins cannot bypass ordinary publisher identity requirements");
      denied(await relayCall(canisterAdmin, market, "listing_save", [listing], 0n), "cycles_required", "Canister admins cannot bypass ordinary publisher charges");
      await charged("listing_save", listing);
      async function artifact(purpose: "package" | "source", byte: number) {
        const bytes = Uint8Array.of(byte, 23, 31, 41);
        const requestId = `admin-access-${purpose}`;
        await charged("upload_begin", {
          requestId, appId: listing.appId, digest: digest(bytes), size: BigInt(bytes.length),
          mediaType: "application/octet-stream", purpose: { [purpose]: null }, feeVersion: 1n,
        });
        await charged("upload_chunk", { requestId, offset: 0n, bytes, feeVersion: 1n });
        return (await charged("upload_finish", { requestId, feeVersion: 1n })).artifactId[0];
      }
      const artifactId = await artifact("package", 3);
      const sourceArtifactId = await artifact("source", 7);
      const candidate = await charged("candidate_submit", {
        requestId: "admin-access-candidate", appId: listing.appId, version: 100n,
        artifactId, sourceArtifactId: [sourceArtifactId], dependencies: [], feeVersion: 1n,
      });
      succeeded(await auditor.audit_stamp({
        requestId: "admin-access-audit", candidateId: candidate.id, expectedDigest: candidate.digest,
        expectedSourceDigest: candidate.sourceDigest, decision: { approved: null },
        analysis: "Local authorization fixture", reason: [],
      }));
      const purchaseRequest = { requestId: "ordinary-admin-purchase", appIds: [listing.appId], ledger: ledger.canisterId, referralCode: [] };
      const directQuote = succeeded(await admin.purchase_quote(purchaseRequest));
      assert.equal(directQuote.amount, 0n);
      denied(await admin.purchase({ quote: directQuote, feeVersion: 1n }), "neutron_required", "An admin cannot acquire an app directly through its signing identity");
      const canisterQuote = succeeded(await relayCall(canisterAdmin, market, "purchase_quote", [purchaseRequest]));
      denied(await relayCall(canisterAdmin, market, "purchase", [{ quote: canisterQuote, feeVersion: 1n }], 0n), "cycles_required", "Canister admins must fund ordinary checkout processing even for free apps");
      assert.deepEqual(succeeded(await admin.purchase_status({ requestId: purchaseRequest.requestId })), []);
      assert.deepEqual(succeeded(await relayCall(canisterAdmin, market, "purchase_status", [{ requestId: purchaseRequest.requestId }])), []);
      assert.equal((await ledger.actor.stats()).appliedTransactions, 0n, "Admin access tests do not move tokens");
      assert.equal(await ledger.actor.icrc1_balance_of(account(market.canisterId)), 0n);
      // Role changes still take effect; the exempt endpoint is not an admission
      // bypass for an auditor after it has been removed.
      succeeded(await admin.admin_auditor_set({ ...auditorRequest, active: false }));
      denied(await auditor.audit_queue(page), "auditor_required", "Removing the auditor role takes effect immediately");
    } finally { await env.shutdown(); }
  },
}];
