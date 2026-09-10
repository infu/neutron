import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { account, installFixture, relayCall, session, wire, type IntegrationCase } from "./helpers.ts";
import { installAt, receiptFor } from "./evm-fixture-helpers.ts";

const digest = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = (seed: number) => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
function success<T = any>(value: any): T {
  assert.ok(value && "ok" in value, `Expected protocol success, received ${wire(value)}`);
  return value.ok;
}
function creditTotal(earnings: any) {
  return earnings.credits.filter((row: any) => !row.isBurn).reduce((sum: bigint, row: any) => sum + row.available, 0n);
}
function assertPaymentTransactions(result: any, market: any, payer: string) {
  const { invoice, payment } = result;
  const words = (data: string, selector: string, count: number) => {
    assert.match(data, /^0x[0-9a-f]+$/i);
    assert.equal(data.slice(0, 10).toLowerCase(), selector);
    assert.equal(data.length, 10 + count * 64);
    return Array.from({ length: count }, (_, index) => data.slice(10 + index * 64, 10 + (index + 1) * 64).toLowerCase());
  };
  const addressWord = (address: string) => address.slice(2).toLowerCase().padStart(64, "0");
  for (const tx of [payment.approve, payment.deposit]) {
    assert.equal(tx.chainId, 1n);
    assert.equal(tx.from.toLowerCase(), payer);
    assert.equal(tx.value, 0n);
  }
  assert.equal(payment.approve.to.toLowerCase(), invoice.route.token);
  // Independently decoded standard approve(address,uint256) calldata.
  const approval = words(payment.approve.data, "0x095ea7b3", 2);
  assert.equal(approval[0], addressWord(invoice.route.helper));
  assert.equal(BigInt(`0x${approval[1]}`), invoice.grossAtoms);
  assert.equal(payment.deposit.to.toLowerCase(), invoice.route.helper);
  // Official helper depositErc20(address,uint256,bytes32,bytes32), including
  // the raw length-prefixed principal rather than an account identifier.
  const deposit = words(payment.deposit.data, "0xdb9751af", 4);
  assert.equal(deposit[0], addressWord(invoice.route.token));
  assert.equal(BigInt(`0x${deposit[1]}`), invoice.grossAtoms);
  const principal = market.toUint8Array(), principalWord = new Uint8Array(32);
  principalWord[0] = principal.length;
  principalWord.set(principal, 1);
  assert.equal(deposit[2], Buffer.from(principalWord).toString("hex"));
  assert.equal(deposit[3], Buffer.from(invoice.subaccount).toString("hex"));
}

export const cases: IntegrationCase[] = [{
  name: "Ethereum marketplace API: mined delivery, delayed settlement, cycle routing, upgrade and canceled late funding",
  scope: "protocol",
  async run() {
    const env = await session();
    try {
      // Only local actors occupy these canonical IDs. No HTTP outcall, Ethereum
      // approval/deposit or production ckUSDC mint occurs in this test.
      const ledger = await installAt(env.pic, "evm_public_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "ckUSDC", decimals: 6, fee: 10_000n }], "xevnm-gaaaa-aaaar-qafnq-cai");
      await installAt(env.pic, "evm_public_minter", "test/fixtures/FakeEvmMinter.mo", [], "sv3dd-oaaaa-aaaar-qacoa-cai");
      const rpc = await installAt(env.pic, "evm_public_rpc", "test/fixtures/FakeEvmRpc.mo", [], "7hfb6-caaaa-aaaar-qadga-cai");
      const publisher = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const buyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
      const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
      const auditorPrincipal = identity(71), browserPrincipal = identity(72);
      const config = {
        admins: [publisher.canisterId], auditors: [auditorPrincipal],
        tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10_000n, rateSymbol: "USDC", burnAccount: [] }],
        xrc: oracle.canisterId,
        fees: { version: 1n, updateBase: 1n, updateByte: 1n, storageByteYear: 1n, purchase: 1n, withdraw: 1n, grant: 1n, xrc: 20_000_000n },
        referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
        trustedPublishingPrincipal: [], reservations: [],
      };
      const market = await installFixture(env.pic, "marketplace", "mo/main.mo", [config]);
      const as = (principal: any) => {
        const actor = env.pic.createActor(market.idlFactory, market.canisterId);
        actor.setPrincipal(principal);
        return actor;
      };
      const browser = as(browserPrincipal), auditor = as(auditorPrincipal);
      const charged = async (neutron: any, name: string, arg: unknown, cycles = 1_000_000_000n) => success(await relayCall(neutron, market, name, [arg], cycles));
      const earnings = async (owner: any) => success(await relayCall(owner, market, "earnings_query", []));
      await charged(buyer, "read_delegate_set", { browser: browserPrincipal, active: true, feeVersion: 1n });

      async function publish(appId: string, byte: number) {
        await charged(publisher, "listing_save", { appId, title: appId, summary: "Local Ethereum checkout test", description: "Opaque fixture bytes, not a packed application qualification", priceUsdMicros: 1_000_000n, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n });
        const bytes = Uint8Array.of(byte, 23, 47, 59);
        const artifacts: bigint[] = [];
        for (const kind of ["package", "source"]) {
          const body = kind === "package" ? bytes : Uint8Array.of(byte, 23, 47, 60);
          const requestId = `${appId}-${kind}`;
          await charged(publisher, "upload_begin", { requestId, appId, digest: digest(body), size: BigInt(body.length), mediaType: "application/octet-stream", purpose: { [kind]: null }, feeVersion: 1n });
          await charged(publisher, "upload_chunk", { requestId, offset: 0n, bytes: body, feeVersion: 1n });
          artifacts.push((await charged(publisher, "upload_finish", { requestId, feeVersion: 1n })).artifactId[0]);
        }
        const candidate = await charged(publisher, "candidate_submit", { requestId: `${appId}-candidate`, appId, version: 100n, artifactId: artifacts[0], sourceArtifactId: [artifacts[1]], dependencies: [], feeVersion: 1n });
        success(await auditor.audit_stamp({ requestId: `${appId}-audit`, candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest, decision: { approved: null }, analysis: "Locally inspected fixture artifact", reason: [] }));
        return { appId, candidate, bytes };
      }
      const first = await publish("ethereum_paid", 61);
      const canceledApp = await publish("ethereum_canceled", 62);
      await charged(publisher, "rates_refresh", { feeVersion: 1n });
      const fees = await browser.ethereum_fees();
      assert.equal(fees.verify.totalCycles - fees.prepare.totalCycles, 50_000_000_000n);
      const payer = "0x3333333333333333333333333333333333333333";
      const quoteFor = (requestId: string, appId: string) => browser.ethereum_quote({ requestId, appIds: [appId], ledger: ledger.canisterId, referralCode: [] }).then(success);
      const quote = await quoteFor("evm-paid", first.appId);
      assert.equal(quote.amount, 1_000_000n);
      const prepare = { quote, payer, feeVersion: 1n };
      assert.ok("err" in await browser.ethereum_prepare(prepare), "A read delegate cannot make a charged update directly");
      assert.ok("err" in await relayCall(buyer, market, "ethereum_prepare", [prepare], 0n));
      const prepared = await charged(buyer, "ethereum_prepare", prepare, fees.prepare.totalCycles);
      const again = await charged(buyer, "ethereum_prepare", prepare, fees.prepare.totalCycles);
      assert.equal(again.invoice.id, prepared.invoice.id);
      assert.deepEqual(again.payment, prepared.payment);
      assert.equal(prepared.invoice.saleAtoms, 1_000_000n);
      assert.equal(prepared.invoice.grossAtoms, 1_010_000n);
      assert.equal(prepared.invoice.subaccount.length, 32);
      assertPaymentTransactions(prepared, market.canisterId, payer);
      assert.equal(prepared.entitled, false);
      assert.equal(prepared.earningsAvailable, false);
      assert.equal((await rpc.actor.stats()).receiptCalls, 0n);
      assert.equal((await ledger.actor.stats()).appliedTransactions, 0n);
      const wrongRailStatus = await browser.purchase_status({ requestId: "evm-paid" });
      assert.ok("err" in wrongRailStatus);
      assert.equal(wrongRailStatus.err.code, "payment_rail", "An Ethereum invoice must not appear as an IC allowance purchase");
      const noPage = await browser.ethereum_history({ cursor: [], limit: 0n });
      assert.ok("err" in noPage);
      assert.equal(noPage.err.code, "invalid_page");
      const ordinaryHistory = success(await browser.operation_history({ purchaseCursor: { start: null }, withdrawalCursor: { start: null }, limit: 20n }));
      assert.deepEqual(ordinaryHistory.purchases, [], "Ethereum invoice progress is returned by its own history endpoint");
      const outsider = as(identity(73));
      assert.ok("err" in await outsider.ethereum_status({ requestId: "evm-paid" }));

      const hash = `0x${"ab".repeat(32)}`;
      const { receipt, block } = receiptFor({ helper: prepared.invoice.route.helper, payer, recipient: market.canisterId, subaccount: Uint8Array.from(prepared.invoice.subaccount), amount: prepared.invoice.grossAtoms, hash, blockHash: `0x${"cd".repeat(32)}` });
      await rpc.actor.setReceipt({ Consistent: { Ok: [receipt] } });
      await rpc.actor.setBlock({ Consistent: { Ok: block } });
      const verify = { requestId: "evm-paid", transactionHash: hash, feeVersion: 1n };
      assert.ok("err" in await relayCall(buyer, market, "ethereum_verify", [verify], fees.verify.totalCycles - 1n));
      assert.equal((await rpc.actor.stats()).receiptCalls, 0n, "Underfunded verification cannot start paid RPC calls");
      const mined = await charged(buyer, "ethereum_verify", verify, fees.verify.totalCycles);
      assert.equal(mined.entitled, true, "Exact mined evidence permits early app delivery");
      assert.equal(mined.earningsAvailable, false, "Mined Ethereum evidence cannot make unsettled royalties withdrawable");
      assert.equal(mined.receipt[0].transactionHash, hash);
      assert.equal(mined.invoice.revenueFinalizedAtNs.length, 0);
      assert.equal((await ledger.actor.stats()).transferCalls, 0n);
      assert.equal(creditTotal(await earnings(publisher)), 0n);
      assert.deepEqual(success(await browser.library_query({ cursor: [], limit: 20n })).apps.map((app: any) => app.appId), [first.appId]);
      const rpcStats = await rpc.actor.stats();
      assert.deepEqual(rpcStats.observations.map((row: any) => row.attachedCycles), [5_000_000_000n, 45_000_000_000n]);
      assert.ok(rpcStats.observations.every((row: any) => row.caller.toText() === market.canisterId.toText()));
      for (const observation of rpcStats.observations) {
        assert.deepEqual(observation.services, { EthMainnet: [[{ Ankr: null }, { PublicNode: null }, { Llama: null }]] });
        assert.deepEqual(observation.config[0].responseConsensus, [{ Equality: null }]);
      }
      const install = await charged(buyer, "install_prepare", { requestId: "install-mined-payment", appIds: [first.appId], feeVersion: 1n });
      assert.deepEqual(install.appIds, [first.appId], "The buyer can prepare installation before wrapping settles");

      const packagePath = `/repo/v1/packages/${Buffer.from(first.candidate.digest).toString("hex")}.neutron`;
      const grant = { request_id: "c1".repeat(16), token: "d2".repeat(32), paths: [packagePath], fee_version: 1n };
      await charged(buyer, "repo_access_v1", grant);
      const httpRequest = { url: packagePath, method: "GET", headers: [["Authorization", `Bearer ${grant.token}`]], body: new Uint8Array(), certificate_version: [2] };
      const verifyDownload = async () => {
        const response = await market.actor.http_request(httpRequest);
        assert.equal(response.status_code, 200);
        assert.deepEqual(Uint8Array.from(response.body), first.bytes);
        const subnet = await env.pic.getCanisterSubnetId(market.canisterId);
        const rootKey = new Uint8Array(await env.pic.getPubKey(subnet));
        assert.equal(verifyRequestResponsePair(httpRequest, { status_code: response.status_code, headers: response.headers, body: Uint8Array.from(response.body) }, market.canisterId.toUint8Array(), BigInt(await env.pic.getTime()) * 1_000_000n, 300_000_000_000n, rootKey, 2).verificationVersion, 2);
      };
      await verifyDownload();
      const waiting = await charged(buyer, "ethereum_settle", { requestId: "evm-paid", feeVersion: 1n }, fees.settle.totalCycles);
      assert.equal(waiting.entitled, true);
      assert.equal(waiting.earningsAvailable, false);
      assert.equal((await ledger.actor.stats()).transferCalls, 0n);

      await env.pic.upgradeCanister({ canisterId: market.canisterId, wasm: market.wasmPath, arg: IDL.encode(market.init({ IDL }), [config]), upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      const retained = success<any[]>(await browser.ethereum_status({ requestId: "evm-paid" }))[0];
      assert.equal(retained.invoice.id, prepared.invoice.id);
      assert.deepEqual(retained.receipt, mined.receipt);
      assert.equal(retained.entitled, true);
      assert.equal(retained.earningsAvailable, false);
      await verifyDownload();

      await ledger.actor.credit({ owner: market.canisterId, subaccount: [prepared.invoice.subaccount] }, prepared.invoice.grossAtoms);
      const settled = await charged(buyer, "ethereum_settle", { requestId: "evm-paid", feeVersion: 1n }, fees.settle.totalCycles);
      assert.equal(settled.earningsAvailable, true);
      assert.equal(creditTotal(await earnings(publisher)), 300_000n);
      assert.equal(await ledger.actor.icrc1_balance_of(account(market.canisterId)), 1_000_000n);
      await charged(buyer, "ethereum_settle", { requestId: "evm-paid", feeVersion: 1n }, fees.settle.totalCycles);
      await charged(buyer, "ethereum_verify", verify, fees.verify.totalCycles);
      assert.equal((await ledger.actor.stats()).transferCalls, 1n);
      assert.equal(creditTotal(await earnings(publisher)), 300_000n);

      const canceledQuote = await quoteFor("evm-cancel", canceledApp.appId);
      const pending = await charged(buyer, "ethereum_prepare", { quote: canceledQuote, payer, feeVersion: 1n }, fees.prepare.totalCycles);
      await charged(buyer, "ethereum_cancel", { requestId: "evm-cancel", feeVersion: 1n }, fees.cancel.totalCycles);
      await ledger.actor.credit({ owner: market.canisterId, subaccount: [pending.invoice.subaccount] }, pending.invoice.grossAtoms);
      const canceled = await charged(buyer, "ethereum_settle", { requestId: "evm-cancel", feeVersion: 1n }, fees.settle.totalCycles);
      assert.equal(canceled.entitled, false);
      assert.equal(canceled.invoice.creditedBuyerAtoms, 1_000_000n);
      assert.equal(creditTotal(await earnings(publisher)), 300_000n, "Canceled invoice funds cannot become publisher revenue");
      assert.equal(creditTotal(await earnings(buyer)), 1_000_000n);
      assert.deepEqual(success(await browser.library_query({ cursor: [], limit: 20n })).apps.map((app: any) => app.appId), [first.appId]);
      const refundQuote = success(await browser.withdraw_quote({ requestId: "evm-cancel-credit", ledger: ledger.canisterId, to: account(buyer.canisterId), totalDebit: 1_000_000n }));
      await charged(buyer, "withdraw", { quote: refundQuote, feeVersion: 1n });
      assert.equal(await ledger.actor.icrc1_balance_of(account(buyer.canisterId)), 990_000n);
      const history = success(await browser.ethereum_history({ cursor: [], limit: 20n }));
      assert.deepEqual(history.invoices.map((entry: any) => entry.invoice.requestId).sort(), ["evm-cancel", "evm-paid"]);
      const completedHistory = success(await browser.operation_history({ purchaseCursor: { start: null }, withdrawalCursor: { start: null }, limit: 20n }));
      assert.deepEqual(completedHistory.purchases, []);
      assert.equal(completedHistory.withdrawals.length, 1, "The ordinary withdrawal of buyer credit remains visible");
      assert.equal((await ledger.actor.stats()).transferCalls, 3n, "One sale sweep, one canceled-funds sweep and one buyer withdrawal");
    } finally { await env.shutdown(); }
  },
}];
