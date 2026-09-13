import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { session, installFixture, relayCall, type Fixture } from "../../../support/marketplace/test/host/helpers.ts";
import { CONTRACT, checkoutType, channelCheckoutType, encodeOpaque, decodeOpaque, first, type ChannelCheckout, type ChannelPurchaseResult, type Checkout, type Info, type WirePublisherProfile, type WireResult, type WireCandidate, type WireChannelApp, type WireReleaseSelection, type WireRatingSummary, type WireVersionComment, type WirePromotionReceipt } from "../src/protocol.ts";
import { makeTransport, type QueryAgent } from "../src/transport.ts";
import { response, operationView, cycleView } from "../src/client.ts";
import type { Kernel } from "../src/store.ts";
import type { ChannelEthereumInvoiceResult, EthereumFees, EthereumInvoiceResult } from "../src/ethereum_protocol.ts";
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
  const publisherIdentity = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(95));
  const fees = { version: 1n, updateBase: 13n, updateByte: 2n, storageByteYear: 3n, purchase: 17n, withdraw: 19n, grant: 23n, xrc: 20_000_000n };
  const marketplace = await installFixture(env.pic, "marketplace", "mo/main.mo", [{ admins: [publisher.canisterId], auditors: [auditorIdentity.getPrincipal()], trustedPublishingPrincipal: [], tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }], xrc: oracle.canisterId, fees, referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n }, reservations: [] }]);
  let browserQueries = 0;
  function transport(relay: Fixture, readIdentity = identity) {
    const queryAgent = { query: async (canisterId: unknown, { methodName, arg }: { methodName: string; arg: ArrayBuffer }) => {
      browserQueries++;
      return { status: "replied", reply: { arg: await env.pic.queryCall({ canisterId, method: methodName, arg, sender: readIdentity.getPrincipal() }) } };
    } } as unknown as QueryAgent;
    const kernel = { updateSelf: async (method: string, args: Array<{ canister: string; method: string; args: Uint8Array; cycles: string }>) => {
      assert.equal(method, "marketplace_call");
      const request = args[0]!;
      assert.equal(request.canister, marketplace.canisterId.toText());
      return new Uint8Array(await relay.actor.rawCall(marketplace.canisterId, request.method, request.args, BigInt(request.cycles)));
    } } as unknown as Kernel;
    return makeTransport({ canisterId: marketplace.canisterId.toText(), agent: queryAgent, contract: CONTRACT, kernel });
  }
  const buyerClient = transport(buyer), publisherClient = transport(publisher, publisherIdentity);
  async function charged(client: ReturnType<typeof transport>, method: string, request: Record<string, unknown>, storage = 0n) {
    const arg = method === "candidate_submit_v2" || method === "install_prepare_v2"
      ? { ...request, request: { ...(request.request as Record<string, unknown>), feeVersion: fees.version } }
      : { ...request, feeVersion: fees.version };
    const bytes = BigInt(IDL.encode(CONTRACT[method]!.args, [arg]).byteLength);
    const cycles = fees.updateBase + bytes * fees.updateByte + storage * fees.storageByteYear;
    return response<any>(await client.update(method, [arg], cycles));
  }
  async function promote(requestId: string, appIds: string[]) {
    const plan = response<any>(await publisherClient.query("promotion_prepare", [{ appIds }]));
    const request = { requestId, entries: plan.entries };
    const receipt = await charged(publisherClient, "release_promote", request) as WirePromotionReceipt;
    assert.deepEqual(first(response<[] | [WirePromotionReceipt]>(await publisherClient.query("promotion_status", [{ requestId }]))), receipt);
    return { request, receipt };
  }
  function assertReviewedChannel(actual: ChannelCheckout, reviewed: ChannelCheckout) {
    assert.deepEqual({ ...actual, quote: { ...actual.quote, quotedAtNs: reviewed.quote.quotedAtNs } }, reviewed, "Only the diagnostic query timestamp may change when retaining the reviewed quote");
  }
  const info = await buyerClient.query<Info>("marketplace_info");
  assert.equal(info.canister.toText(), marketplace.canisterId.toText());
  assert.equal(info.tokens[0]!.decimals, 6);
  await charged(buyerClient, "read_delegate_set", { browser: identity.getPrincipal(), active: true });
  await charged(publisherClient, "read_delegate_set", { browser: publisherIdentity.getPrincipal(), active: true });
  const listing = { appId: "client_fixture", title: "Client fixture", summary: "SDK integration", description: "Real protocol Candid, local funds only", priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: [] };
  await assert.rejects(charged(publisherClient, "listing_save", listing), { code: "publisher_profile_required" }, "Publishing requires the Neutron's permanent publisher profile");
  assert.deepEqual(response(await buyerClient.query("publisher_profile_for", [publisher.canisterId])), []);
  const publisherProfile = await charged(publisherClient, "publisher_profile_register", { publisherId: "sdk", name: "SDK Publisher", description: "Local Candid integration publisher" });
  assert.equal(publisherProfile.publisherId, "sdk");
  assert.equal(publisherProfile.principal.toText(), publisher.canisterId.toText());
  assert.equal(publisherProfile.totalUsers, 0n);
  const created = await charged(publisherClient, "listing_save", listing);
  assert.equal(created.appId, listing.appId);
  assert.deepEqual(created.publisherProfile, [{ publisherId: "sdk", name: "SDK Publisher" }]);
  const bytes = Uint8Array.of(1, 3, 5, 7), digest = new Uint8Array(createHash("sha256").update(bytes).digest());
  const upload = { requestId: "sdk-upload", appId: listing.appId, digest, size: BigInt(bytes.length), mediaType: "application/octet-stream", purpose: { package: null } };
  await charged(publisherClient, "upload_begin", upload, BigInt(bytes.length));
  await charged(publisherClient, "upload_chunk", { requestId: upload.requestId, offset: 0n, bytes });
  const uploaded = await charged(publisherClient, "upload_finish", { requestId: upload.requestId });
  assert.equal(uploaded.uploadedBytes, 4n);
  const candidate = await charged(publisherClient, "candidate_submit", { requestId: "sdk-candidate", appId: listing.appId, version: 100n, artifactId: uploaded.artifactId[0], sourceArtifactId: [], dependencies: [] });
  const auditor = env.pic.createActor(marketplace.idlFactory, marketplace.canisterId); auditor.setPrincipal(auditorIdentity.getPrincipal());
  response(await auditor.audit_stamp({ requestId: "sdk-audit", candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest, decision: { approved: null }, analysis: "Local SDK fixture", reason: [] }));
  const betaOnly = response<any>(await buyerClient.query("app_detail_v2", [{ appId: listing.appId, mode: { beta: null } }])).release as WireChannelApp;
  assert.equal(betaOnly.selected[0]!.version, 100n);
  assert.deepEqual(betaOnly.selectedChannel, [{ beta: null }]);
  assert.deepEqual(betaOnly.stableHead.candidate, [], "Audit approval initially offers beta only");
  await promote("sdk-promote-100", [listing.appId]);
  const detail = response<any>(await buyerClient.query("app_detail", [listing.appId]));
  assert.equal(detail.app.visible, true); assert.equal(detail.candidate[0].version, 100n);
  assert.deepEqual(detail.app.publisherProfile, [{ publisherId: "sdk", name: "SDK Publisher" }]);
  const quote = response<Checkout>(await buyerClient.query("purchase_quote", [{ requestId: "a1".repeat(16), appIds: [listing.appId], ledger: ledger.canisterId, referralCode: [] }]));
  const restored = decodeOpaque<Checkout>(checkoutType, encodeOpaque(checkoutType, quote));
  assert.deepEqual(restored.commitment, quote.commitment); assert.equal(restored.buyer.toText(), buyer.canisterId.toText());
  assert.equal(cycleView(quote.cycles).total, String(fees.purchase));
  const purchased = response<WireResult>(await buyerClient.update("purchase", [{ quote: restored, feeVersion: fees.version }], quote.cycles.totalCycles));
  assert.equal(operationView(purchased).state, "complete");
  const recoveredPurchase = response<WireResult>(await buyerClient.update("purchase", [{ quote: restored, feeVersion: fees.version }], quote.cycles.totalCycles));
  assert.equal(operationView(recoveredPurchase).state, "complete", "Same-ID recovery returns the original acquisition");
  const acquiredProfile = response<WirePublisherProfile>(await buyerClient.query("publisher_profile", ["sdk"]));
  assert.equal(acquiredProfile.totalUsers, 1n, "The same acquisition and its retry add only one publisher user");
  assert.equal(acquiredProfile.ratingCount, 0n);
  assert.equal(acquiredProfile.statsComplete, true);
  const publisherPage = response<any>(await buyerClient.query("publisher_profile_apps", [{ publisherId: "sdk", cursor: [], limit: 24n }]));
  assert.deepEqual(publisherPage.apps.map((app: any) => app.appId), [listing.appId]);
  assert.deepEqual(publisherPage.apps[0].publisherProfile, [{ publisherId: "sdk", name: "SDK Publisher" }]);
  assert.equal(publisherPage.apps[0].owned, true);
  assert.deepEqual(publisherPage.nextCursor, []);
  await charged(buyerClient, "rating_set", { appId: listing.appId, stars: 5n, review: "SDK review" });
  await charged(buyerClient, "rating_set", { appId: listing.appId, stars: 3n, review: "Edited SDK review" });
  const ratedProfile = response<WirePublisherProfile>(await buyerClient.query("publisher_profile", ["sdk"]));
  assert.equal(ratedProfile.ratingTotal, 3n, "An edited rating replaces the prior contribution");
  assert.equal(ratedProfile.ratingCount, 1n, "Editing a review does not create another review");
  assert.equal(ratedProfile.totalUsers, 1n);
  const ownProfile = first(response<[] | [WirePublisherProfile]>(await buyerClient.query("publisher_profile_for", [publisher.canisterId])));
  assert.deepEqual(ownProfile, ratedProfile, "Public publisher ID and principal lookups expose the same stored aggregates");
  const status = first(response<any>(await buyerClient.query("purchase_status", [{ requestId: quote.request.requestId }])) as [WireResult]);
  assert.ok(status); assert.equal(operationView(status).state, "complete");
  const history = response<any>(await buyerClient.query("operation_history", [{ purchaseCursor: { start: null }, withdrawalCursor: { start: null }, limit: 20n }]));
  assert.equal(history.purchases.length, 1); assert.ok("done" in history.nextWithdrawalCursor);
  assert.ok(browserQueries >= 5, "SDK reads used the direct query adapter");
  assert.equal((await ledger.actor.stats()).appliedTransactions, 0n, "Free SDK purchase never dispatched a ledger mutation");

  // The additive channel contract uses the same real transport and exact byte
  // charges while preserving the completed v1 purchase and its opaque quote.
  const commentIdentity = (release: WireCandidate) => ({ appId: release.appId, candidateId: release.id, version: release.version, digest: release.digest });
  const comments = async (client: ReturnType<typeof transport>, release: WireCandidate) => response<{ comments: WireVersionComment[]; ownComment: [] | [WireVersionComment]; nextCursor: [] | [bigint] }>(await client.query("version_comments_v2", [{ ...commentIdentity(release), cursor: [], limit: 24n }]));
  const histogram = async () => response<WireRatingSummary>(await buyerClient.query("rating_summary_v2", [listing.appId]));
  assert.deepEqual(await histogram(), { one: 0n, two: 0n, three: 1n, four: 0n, five: 0n, count: 1n, total: 3n, complete: true });
  assert.deepEqual((await comments(buyerClient, candidate)).comments, [], "Legacy versionless review text is never assigned to a release");
  const stableComment = await charged(buyerClient, "version_comment_set_v2", { ...commentIdentity(candidate), text: "Version 100 is dependable." });
  assert.deepEqual((await comments(buyerClient, candidate)).ownComment, [stableComment]);
  const betaListing = await charged(publisherClient, "listing_save", { ...listing, title: "Client fixture beta", summary: "Version 101 preview", description: "Frozen beta description", expectedRevision: [created.revision] });
  const betaBytes = Uint8Array.of(2, 4, 6, 8);
  const betaDigest = new Uint8Array(createHash("sha256").update(betaBytes).digest());
  const betaUpload = { ...upload, requestId: "sdk-beta-upload", digest: betaDigest, size: BigInt(betaBytes.length) };
  await charged(publisherClient, "upload_begin", betaUpload, BigInt(betaBytes.length));
  await charged(publisherClient, "upload_chunk", { requestId: betaUpload.requestId, offset: 0n, bytes: betaBytes });
  const betaArtifact = await charged(publisherClient, "upload_finish", { requestId: betaUpload.requestId });
  const betaRequest = { requestId: "sdk-beta-candidate", appId: listing.appId, version: 101n, artifactId: betaArtifact.artifactId[0], sourceArtifactId: [], dependencies: [] };
  const releaseNotes = "Version 101 adds the new SDK preview.";
  const betaCandidate = await charged(publisherClient, "candidate_submit_v2", { request: betaRequest, releaseNotes }) as WireCandidate;
  response(await auditor.audit_stamp({ requestId: "sdk-beta-audit", candidateId: betaCandidate.id, expectedDigest: betaCandidate.digest, expectedSourceDigest: betaCandidate.sourceDigest, decision: { approved: null }, analysis: "Local SDK beta fixture", reason: [] }));
  const channelDetail = async (mode: "stable" | "beta") => response<any>(await buyerClient.query("app_detail_v2", [{ appId: listing.appId, mode: { [mode]: null } }])).release as WireChannelApp;
  const stableDetail = await channelDetail("stable"), betaDetail = await channelDetail("beta");
  assert.equal(stableDetail.selected[0]!.id, candidate.id);
  assert.equal(stableDetail.app.title, listing.title);
  assert.equal(stableDetail.app.description, listing.description);
  assert.deepEqual(stableDetail.selectedChannel, [{ stable: null }]);
  assert.equal(betaDetail.selected[0]!.id, betaCandidate.id);
  assert.equal(betaDetail.app.title, betaListing.title);
  assert.equal(betaDetail.app.description, betaListing.description);
  assert.deepEqual(betaDetail.selectedChannel, [{ beta: null }]);
  assert.equal(betaDetail.betaHead.releaseNotes, releaseNotes);
  await charged(publisherClient, "listing_save", { ...listing, title: "Unsubmitted next draft", description: "Unsubmitted description", expectedRevision: [betaListing.revision] });
  assert.equal((await channelDetail("stable")).app.title, listing.title);
  assert.equal((await channelDetail("beta")).app.title, betaListing.title, "Unsubmitted draft edits cannot change either offered release");
  await assert.rejects(charged(publisherClient, "candidate_submit_v2", { request: betaRequest, releaseNotes: "Changed notes" }), { code: "request_conflict" });

  const installSelection = response<{ selection: WireReleaseSelection[] }>(await buyerClient.query("install_selection_v2", [{ appIds: [listing.appId], mode: { beta: null } }]));
  assert.equal(installSelection.selection[0]!.candidateId, betaCandidate.id);
  assert.deepEqual(installSelection.selection[0]!.channel, { beta: null });
  const installRequest = { request: { requestId: "sdk-beta-install", appIds: [listing.appId] }, mode: { beta: null }, selection: installSelection.selection };
  const install = await charged(buyerClient, "install_prepare_v2", installRequest);
  const manifestResponse = await marketplace.actor.http_request({ url: `/repo/v1/manifests/${install.manifestId}.json`, method: "GET", headers: [], body: new Uint8Array(), certificate_version: [2] });
  assert.equal(manifestResponse.status_code, 200);
  const manifest = JSON.parse(Buffer.from(manifestResponse.body).toString("utf8"));
  assert.equal(manifest.protocol, "neutron-repo-channel-manifest-v1");
  assert.equal(manifest.channel, "beta");
  assert.equal(createHash("sha256").update(manifestResponse.body).digest("hex"), install.digest);

  const betaBuyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
  const betaBuyerIdentity = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(96));
  const betaBuyerClient = transport(betaBuyer, betaBuyerIdentity);
  await charged(betaBuyerClient, "read_delegate_set", { browser: betaBuyerIdentity.getPrincipal(), active: true });
  const channelQuote = response<ChannelCheckout>(await betaBuyerClient.query("purchase_quote_v2", [{ request: { requestId: "a2".repeat(16), appIds: [listing.appId], ledger: ledger.canisterId, referralCode: [] }, mode: { beta: null }, expectedSelection: [installSelection.selection] }]));
  const restoredChannel = decodeOpaque<ChannelCheckout>(channelCheckoutType, encodeOpaque(channelCheckoutType, channelQuote));
  assert.deepEqual(restoredChannel, channelQuote);
  assert.deepEqual(restoredChannel.selection, installSelection.selection);
  assert.deepEqual(restoredChannel.quote.items[0]!.releaseDigest, betaCandidate.digest);
  const channelPurchased = response<ChannelPurchaseResult>(await betaBuyerClient.update("purchase_v2", [{ quote: restoredChannel, feeVersion: fees.version }], restoredChannel.quote.cycles.totalCycles));
  assert.equal(operationView(channelPurchased.purchase).state, "complete");
  assertReviewedChannel(channelPurchased.quote[0]!, restoredChannel);
  assert.deepEqual(first(response<[] | [ChannelPurchaseResult]>(await betaBuyerClient.query("purchase_status_v2", [{ requestId: restoredChannel.quote.request.requestId }]))), channelPurchased);
  const legacyChannelStatus = first(response<[] | [ChannelPurchaseResult]>(await buyerClient.query("purchase_status_v2", [{ requestId: quote.request.requestId }])));
  assert.deepEqual(legacyChannelStatus?.quote, [], "The additive status wrapper leaves a saved v1 quote unmodified");
  assert.equal(operationView(legacyChannelStatus!.purchase).state, "complete");
  await charged(betaBuyerClient, "rating_set_v2", { appId: listing.appId, stars: 5n });
  await charged(buyerClient, "rating_set_v2", { appId: listing.appId, stars: 4n });
  const permanentStars = { one: 0n, two: 0n, three: 0n, four: 1n, five: 1n, count: 2n, total: 9n, complete: true };
  assert.deepEqual(await histogram(), permanentStars, "Stars are one editable contribution per owner across releases");
  const betaComment = await charged(betaBuyerClient, "version_comment_set_v2", { ...commentIdentity(betaCandidate), text: "The version 101 preview works." });
  const editedBetaComment = await charged(betaBuyerClient, "version_comment_set_v2", { ...commentIdentity(betaCandidate), text: "The version 101 preview works well." });
  assert.equal(editedBetaComment.id, betaComment.id);
  assert.deepEqual((await comments(betaBuyerClient, betaCandidate)).comments, [editedBetaComment]);
  assert.deepEqual((await comments(buyerClient, candidate)).comments, [stableComment], "Stable and beta retain separate version comments");
  const promotion = await promote("sdk-promote-101", [listing.appId]);
  assert.equal(promotion.receipt.entries[0]!.candidateId, betaCandidate.id);
  assert.deepEqual(promotion.receipt.entries[0]!.digest, betaCandidate.digest);
  assert.equal(promotion.receipt.entries[0]!.packageSize, BigInt(betaBytes.length));
  assert.deepEqual(await charged(publisherClient, "release_promote", promotion.request), promotion.receipt, "A lost promotion response is recovered with the same request and exact entries");
  assert.equal((await channelDetail("stable")).selected[0]!.id, betaCandidate.id);
  assert.equal((await channelDetail("stable")).stableHead.releaseNotes, releaseNotes);
  assert.deepEqual((await comments(betaBuyerClient, betaCandidate)).comments, [editedBetaComment], "Promotion retains comments for the exact candidate bytes");
  await assert.rejects(comments(buyerClient, candidate), { code: "feedback_release_retired" });
  await assert.rejects(charged(buyerClient, "version_comment_set_v2", { ...commentIdentity(candidate), text: "Retired version" }), { code: "feedback_release_retired" });
  assert.deepEqual(await histogram(), permanentStars, "Promotion and comment retirement preserve permanent app ratings");
  assert.deepEqual(response<ChannelPurchaseResult>(await betaBuyerClient.update("purchase_v2", [{ quote: restoredChannel, feeVersion: fees.version }], restoredChannel.quote.cycles.totalCycles)), channelPurchased, "An existing beta purchase keeps its exact selection after promotion");
  assert.equal(operationView(response<WireResult>(await buyerClient.update("purchase", [{ quote: restored, feeVersion: fees.version }], quote.cycles.totalCycles))).state, "complete", "The released v1 checkout still recovers after channel advancement");
  assert.deepEqual(await charged(buyerClient, "install_prepare_v2", installRequest), install, "An existing prepared installation retains its original beta manifest");
  await assert.rejects(charged(buyerClient, "install_prepare_v2", { ...installRequest, request: { ...installRequest.request, requestId: "sdk-stale-beta-install" } }), { code: "selection_changed" }, "A fresh install cannot reuse a stale reviewed head revision");
  await charged(betaBuyerClient, "version_comment_delete_v2", commentIdentity(betaCandidate));
  assert.deepEqual((await comments(betaBuyerClient, betaCandidate)).comments, []);
  assert.deepEqual(await histogram(), permanentStars, "Deleting version text never deletes the app's star rating");

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
  await promote("sdk-ethereum-promote-100", [paidListing.appId]);
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

  const wrappedLegacyInvoice = first(response<[] | [ChannelEthereumInvoiceResult]>(await buyerClient.query("ethereum_status_v2", [{ requestId: ethereumQuote.request.requestId }])));
  assert.deepEqual(wrappedLegacyInvoice, { invoice, quote: [] }, "The successor Ethereum status preserves a saved legacy invoice without inventing a channel");
  const ethereumChannelQuote = response<ChannelCheckout>(await betaBuyerClient.query("ethereum_quote_v2", [{ request: { ...ethereumQuote.request, requestId: "e4".repeat(16) }, mode: { stable: null }, expectedSelection: [] }]));
  assert.deepEqual(ethereumChannelQuote.mode, { stable: null });
  assert.equal(ethereumChannelQuote.selection[0]!.candidateId, paidCandidate.id);
  assert.deepEqual(ethereumChannelQuote.quote.items[0]!.releaseDigest, paidCandidate.digest);
  const ethereumChannelInvoice = response<ChannelEthereumInvoiceResult>(await betaBuyerClient.update("ethereum_prepare_v2", [{ quote: ethereumChannelQuote, payer, feeVersion: fees.version }], ethereumFees.prepare.totalCycles));
  assertReviewedChannel(ethereumChannelInvoice.quote[0]!, ethereumChannelQuote);
  assert.equal(ethereumChannelInvoice.invoice.invoice.grossAtoms, invoice.invoice.grossAtoms);
  assert.deepEqual(first(response<[] | [ChannelEthereumInvoiceResult]>(await betaBuyerClient.query("ethereum_status_v2", [{ requestId: ethereumChannelQuote.quote.request.requestId }]))), ethereumChannelInvoice);
  assert.deepEqual(response<ChannelEthereumInvoiceResult>(await betaBuyerClient.update("ethereum_prepare_v2", [{ quote: ethereumChannelQuote, payer, feeVersion: fees.version }], ethereumFees.prepare.totalCycles)), ethereumChannelInvoice, "The original channel invoice is recovered under the same request ID");
  assert.deepEqual(response<{ invoices: ChannelEthereumInvoiceResult[] }>(await buyerClient.query("ethereum_history_v2", [{ cursor: [], limit: 24n }])).invoices, [wrappedLegacyInvoice]);
  assert.deepEqual(response<{ invoices: ChannelEthereumInvoiceResult[] }>(await betaBuyerClient.query("ethereum_history_v2", [{ cursor: [], limit: 24n }])).invoices, [ethereumChannelInvoice]);
  assert.equal((await ledger.actor.stats()).appliedTransactions, 0n, "Both invoice protocols prepare and recover without transferring tokens");

  console.log("Marketplace client: real v1/v2 Candid, beta/stable release snapshots, exact promotion and recovery, persistent stars, version comments, selection-bound install/purchase, and legacy/channel Ethereum invoices passed via Ash/PocketIC.");
} finally { await env.shutdown(); }
