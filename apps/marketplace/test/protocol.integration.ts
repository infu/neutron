import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { session, installFixture, relayCall, type Fixture } from "../../../support/marketplace/test/host/helpers.ts";
import { CONTRACT, checkoutType, encodeOpaque, decodeOpaque, first, type Checkout, type Info, type WireResult } from "../src/protocol.ts";
import { makeTransport, type QueryAgent } from "../src/transport.ts";
import { response, operationView, cycleView } from "../src/client.ts";
import type { Kernel } from "../src/store.ts";
import type { EthereumFees, EthereumInvoiceResult } from "../src/ethereum_protocol.ts";
import { buildEthereumFundingPlan, principalToEthereumWord } from "../src/ethereum.ts";
import { installAt } from "../../../support/marketplace/test/host/evm-fixture-helpers.ts";

const env = await session();
try {
  const publisher = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
  const buyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
  const ledger = await installAt(env.pic, "evm_sdk_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "ckUSDC", decimals: 6, fee: 10n }], "xevnm-gaaaa-aaaar-qafnq-cai");
  await installAt(env.pic, "evm_sdk_minter", "test/fixtures/FakeEvmMinter.mo", [], "sv3dd-oaaaa-aaaar-qacoa-cai");
  const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
  const identity = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(93));
  const auditorIdentity = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(94));
  const fees = { version: 1n, updateBase: 13n, updateByte: 2n, storageByteYear: 3n, purchase: 17n, withdraw: 19n, grant: 23n, xrc: 20_000_000n };
  const marketplace = await installFixture(env.pic, "marketplace", "mo/main.mo", [{ admins: [publisher.canisterId], auditors: [auditorIdentity.getPrincipal()], trustedPublishingPrincipal: [], tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }], xrc: oracle.canisterId, fees, referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n }, reservations: [] }]);
  let browserQueries = 0;
  const queryAgent = { query: async (canisterId: unknown, { methodName, arg }: { methodName: string; arg: ArrayBuffer }) => {
    browserQueries++;
    return { status: "replied", reply: { arg: await env.pic.queryCall({ canisterId, method: methodName, arg, sender: identity.getPrincipal() }) } };
  } } as unknown as QueryAgent;
  function transport(relay: Fixture) {
    const kernel = { updateSelf: async (method: string, args: Array<{ canister: string; method: string; args: Uint8Array; cycles: string }>) => {
      assert.equal(method, "marketplace_call");
      const request = args[0]!;
      assert.equal(request.canister, marketplace.canisterId.toText());
      return new Uint8Array(await relay.actor.rawCall(marketplace.canisterId, request.method, request.args, BigInt(request.cycles)));
    } } as unknown as Kernel;
    return makeTransport({ canisterId: marketplace.canisterId.toText(), agent: queryAgent, contract: CONTRACT, kernel });
  }
  const buyerClient = transport(buyer), publisherClient = transport(publisher);
  async function charged(client: ReturnType<typeof transport>, method: string, request: Record<string, unknown>, storage = 0n) {
    const arg = { ...request, feeVersion: fees.version };
    const bytes = BigInt(IDL.encode(CONTRACT[method]!.args, [arg]).byteLength);
    const cycles = fees.updateBase + bytes * fees.updateByte + storage * fees.storageByteYear;
    return response<any>(await client.update(method, [arg], cycles));
  }
  const info = await buyerClient.query<Info>("marketplace_info");
  assert.equal(info.canister.toText(), marketplace.canisterId.toText());
  assert.equal(info.tokens[0]!.decimals, 6);
  await charged(buyerClient, "read_delegate_set", { browser: identity.getPrincipal(), active: true });
  const listing = { appId: "client_fixture", title: "Client fixture", summary: "SDK integration", description: "Real protocol Candid, local funds only", priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: [] };
  const created = await charged(publisherClient, "listing_save", listing);
  assert.equal(created.appId, listing.appId);
  const bytes = Uint8Array.of(1, 3, 5, 7), digest = new Uint8Array(createHash("sha256").update(bytes).digest());
  const upload = { requestId: "sdk-upload", appId: listing.appId, digest, size: BigInt(bytes.length), mediaType: "application/octet-stream", purpose: { package: null } };
  await charged(publisherClient, "upload_begin", upload, BigInt(bytes.length));
  await charged(publisherClient, "upload_chunk", { requestId: upload.requestId, offset: 0n, bytes });
  const uploaded = await charged(publisherClient, "upload_finish", { requestId: upload.requestId });
  assert.equal(uploaded.uploadedBytes, 4n);
  const candidate = await charged(publisherClient, "candidate_submit", { requestId: "sdk-candidate", appId: listing.appId, version: 100n, artifactId: uploaded.artifactId[0], sourceArtifactId: [], dependencies: [] });
  const auditor = env.pic.createActor(marketplace.idlFactory, marketplace.canisterId); auditor.setPrincipal(auditorIdentity.getPrincipal());
  response(await auditor.audit_stamp({ requestId: "sdk-audit", candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest, decision: { approved: null }, analysis: "Local SDK fixture", reason: [] }));
  const detail = response<any>(await buyerClient.query("app_detail", [listing.appId]));
  assert.equal(detail.app.visible, true); assert.equal(detail.candidate[0].version, 100n);
  const quote = response<Checkout>(await buyerClient.query("purchase_quote", [{ requestId: "a1".repeat(16), appIds: [listing.appId], ledger: ledger.canisterId, referralCode: [] }]));
  const restored = decodeOpaque<Checkout>(checkoutType, encodeOpaque(checkoutType, quote));
  assert.deepEqual(restored.commitment, quote.commitment); assert.equal(restored.buyer.toText(), buyer.canisterId.toText());
  assert.equal(cycleView(quote.cycles).total, String(fees.purchase));
  const purchased = response<WireResult>(await buyerClient.update("purchase", [{ quote: restored, feeVersion: fees.version }], quote.cycles.totalCycles));
  assert.equal(operationView(purchased).state, "complete");
  const status = first(response<any>(await buyerClient.query("purchase_status", [{ requestId: quote.request.requestId }])) as [WireResult]);
  assert.ok(status); assert.equal(operationView(status).state, "complete");
  const history = response<any>(await buyerClient.query("operation_history", [{ purchaseCursor: { start: null }, withdrawalCursor: { start: null }, limit: 20n }]));
  assert.equal(history.purchases.length, 1); assert.ok("done" in history.nextWithdrawalCursor);
  assert.ok(browserQueries >= 5, "SDK reads used the direct query adapter");
  assert.equal((await ledger.actor.stats()).appliedTransactions, 0n, "Free SDK purchase never dispatched a ledger mutation");
  // Exercise the Ethereum quote through the same Candid transport as the app.
  // Only local fixture actors occupy canonical IDs. Queries and invoice
  // preparation do not send an Ethereum payment or an RPC request.
  const paidListing = { ...listing, appId: "ethereum_client_fixture", priceUsdMicros: 1_000_000n };
  await charged(publisherClient, "listing_save", paidListing);
  const paidUpload = { ...upload, appId: paidListing.appId, requestId: "sdk-ethereum-upload" };
  await charged(publisherClient, "upload_begin", paidUpload, BigInt(bytes.length));
  await charged(publisherClient, "upload_chunk", { requestId: paidUpload.requestId, offset: 0n, bytes });
  const paidArtifact = await charged(publisherClient, "upload_finish", { requestId: paidUpload.requestId });
  const paidCandidate = await charged(publisherClient, "candidate_submit", { requestId: "sdk-ethereum-candidate", appId: paidListing.appId, version: 100n, artifactId: paidArtifact.artifactId[0], sourceArtifactId: [], dependencies: [] });
  response(await auditor.audit_stamp({ requestId: "sdk-ethereum-audit", candidateId: paidCandidate.id, expectedDigest: paidCandidate.digest, expectedSourceDigest: paidCandidate.sourceDigest, decision: { approved: null }, analysis: "Local Ethereum SDK quote fixture", reason: [] }));
  response(await relayCall(publisher, marketplace, "rates_refresh", [{ feeVersion: fees.version }], 1_000_000_000n));
  const ethereumFees = await buyerClient.query<EthereumFees>("ethereum_fees");
  assert.equal(ethereumFees.prepare.totalCycles, fees.purchase);
  assert.equal(ethereumFees.verify.totalCycles - ethereumFees.prepare.totalCycles, 50_000_000_000n);
  const ethereumQuote = response<Checkout>(await buyerClient.query("ethereum_quote", [{ requestId: "e1".repeat(16), appIds: [paidListing.appId], ledger: ledger.canisterId, referralCode: [] }]));
  assert.equal(ethereumQuote.amount, 1_000_000n);
  assert.equal(ethereumQuote.fee, 10n);
  assert.equal(ethereumQuote.buyer.toText(), buyer.canisterId.toText());
  assert.deepEqual(decodeOpaque<Checkout>(checkoutType, encodeOpaque(checkoutType, ethereumQuote)), ethereumQuote);
  assert.deepEqual(response(await buyerClient.query("ethereum_status", [{ requestId: ethereumQuote.request.requestId }])), []);
  assert.deepEqual(response(await buyerClient.query("ethereum_history", [{ cursor: [], limit: 24n }])), { invoices: [], nextCursor: [] });
  assert.equal((await ledger.actor.stats()).appliedTransactions, 0n, "Ethereum read quotes never fund or prepare an invoice");
  const payer = "0x3333333333333333333333333333333333333333";
  const invoice = response<EthereumInvoiceResult>(await buyerClient.update("ethereum_prepare", [{ quote: ethereumQuote, payer, feeVersion: fees.version }], ethereumFees.prepare.totalCycles));
  assert.equal(invoice.invoice.grossAtoms, 1_000_010n);
  assert.equal(invoice.entitled, false);
  assert.equal(invoice.invoice.owner.toText(), buyer.canisterId.toText());
  const route = { chainId: String(invoice.invoice.route.chainId), tokenAddress: invoice.invoice.route.token, helperAddress: invoice.invoice.route.helper, minterAddress: invoice.invoice.route.minterAddress, recipientPrincipal: marketplace.canisterId.toText() };
  const funding = buildEthereumFundingPlan({ operationId: ethereumQuote.request.requestId, payerAddress: payer, amountAtoms: String(invoice.invoice.grossAtoms), principalWord: principalToEthereumWord(marketplace.canisterId.toText()), subaccountWord: `0x${Buffer.from(invoice.invoice.subaccount).toString("hex")}`, route }, route, { approval: "e2".repeat(16), deposit: "e3".repeat(16) });
  assert.equal(invoice.payment.approve.data, funding.steps.approval.transaction.data, "Protocol and app encode the same exact bounded approval");
  assert.equal(invoice.payment.deposit.data, funding.steps.deposit.transaction.data, "Protocol and app encode the same invoice-bound deposit");
  assert.deepEqual(first(response<[] | [EthereumInvoiceResult]>(await buyerClient.query("ethereum_status", [{ requestId: ethereumQuote.request.requestId }]))), invoice);
  assert.equal((await ledger.actor.stats()).appliedTransactions, 0n, "Invoice preparation never dispatches a token transfer");

  console.log("Marketplace client: real Candid, direct queries, exact attached cycle quotes, uploads and same-ID acquisition passed via Ash/PocketIC.");
} finally { await env.shutdown(); }
