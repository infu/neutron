/** Browser integration qualification for the actual resident, SDK transport,
 * trading engine, signing adapters, WebCrypto and installation-origin IndexedDB.
 * The outer Kernel/Wallet and venue are synthetic fixtures. Every request is
 * intercepted; this test never sends an external transaction or order. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, recoverTypedDataAddress, toFunctionSelector } from "viem";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";

const app = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = process.env.HL_BROWSER_ARTIFACTS || "/tmp/neutron-hyperliquid-browser";
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(resolve(tmpdir(), "neutron-hl-resident-"));
const kernelOrigin = "https://4caro-hl777-77775-aaaba-cai.icp0.io";
const residentOrigin = "https://p0123456789abcdef01234567--4caro-hl777-77775-aaaba-cai.icp0.io";
const residentUrl = `${residentOrigin}/app/hyperliquid/service.html`;
const agentCaller = { appId: "agent", installationUid: "901", role: "background", endpoint: "app:agent:background" };
const residentCaller = { appId: "hyperliquid", installationUid: "701", role: "background", endpoint: "app:hyperliquid:background" };
const ownerCaller = { appId: "hyperliquid", installationUid: "701", role: "tile", endpoint: "app:hyperliquid:tile:hyperliquid:instance:fixture-owner" };
// Public, unfunded test vector. This key belongs only to the synthetic Wallet.
const master = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const account = { accountId: "main", address: master.address.toLowerCase(), publicKey: master.publicKey, keyFingerprint: keccak256(master.publicKey), namespaceVersion: "2" };
const zero = "0x" + "0".repeat(64), word = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");
const fullSignature = ({ r, s, v }) => `${r}${s.slice(2)}${Number(v).toString(16).padStart(2, "0")}`;
const id = (value) => Number(value).toString(16).padStart(32, "0");
const seen = { kernel: [], reviews: [], walletSignatures: [], exchange: [], info: [], circle: [], rpc: [], networkEscapes: [], browserErrors: [] };
const walletOperations = new Map(), venueOrders = new Map(), fills = [];
let registered = [], positionSize = 0, nextOid = 1000, nextExchangeFailure = false;
const universe = [{ name: "ETH", szDecimals: 4, maxLeverage: 25, marginTableId: 1 }, { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 1 }];
const meta = { universe, marginTables: [[1, { marginTiers: [{ lowerBound: "0", maxLeverage: 25 }] }]], collateralToken: 0 };
const marketContext = (price) => ({ markPx: String(price), midPx: String(price), oraclePx: String(price), funding: "0.00001", openInterest: "12345.6", dayNtlVlm: "200000000", prevDayPx: String(price - 20) });
function clearinghouse() {
  const marginSummary = { accountValue: "10000", totalMarginUsed: "100", totalNtlPos: String(Math.abs(positionSize) * 2000), totalRawUsd: "10000" };
  return { assetPositions: positionSize === 0 ? [] : [{ type: "oneWay", position: { coin: "ETH", szi: String(positionSize), entryPx: "2000.5", leverage: { type: "cross", value: 3 }, liquidationPx: "1200", marginUsed: "100", maxLeverage: 25, positionValue: String(Math.abs(positionSize) * 2000), returnOnEquity: "0", unrealizedPnl: "0", cumFunding: { allTime: "0", sinceChange: "0", sinceOpen: "0" } } }], marginSummary, crossMarginSummary: marginSummary, crossMaintenanceMarginUsed: "10", withdrawable: "9000", time: Date.now() };
}
function openOrders() { return [...venueOrders.values()].filter((row) => row.status === "open").map(({ order }) => order); }
function info(body) {
  seen.info.push(structuredClone(body));
  const price = body.coin === "BTC" ? 100000 : 2000;
  switch (body.type) {
    case "extraAgents": return registered;
    case "meta": return meta;
    case "metaAndAssetCtxs": return [meta, [marketContext(2000), marketContext(100000)]];
    case "l2Book": return { coin: body.coin, time: Date.now(), levels: [[{ px: String(price - 0.5), sz: "20", n: 3 }, { px: String(price - 1), sz: "30", n: 5 }], [{ px: String(price + 0.5), sz: "20", n: 4 }, { px: String(price + 1), sz: "30", n: 7 }]] };
    case "clearinghouseState": return clearinghouse();
    case "frontendOpenOrders": case "openOrders": return openOrders();
    case "userFees": return { userCrossRate: "0.00045", userAddRate: "0.00015" };
    case "userAbstraction": return "disabled";
    case "userFills": case "userFillsByTime": return fills;
    case "fundingHistory": return [{ coin: body.coin, time: body.startTime, fundingRate: "0.00001", premium: "0.00002" }];
    case "orderStatus": {
      const row = [...venueOrders.values()].find(({ order }) => order.oid === body.oid || order.cloid === body.oid);
      return row ? { status: "order", order: { order: row.order, status: row.status, statusTimestamp: Date.now() } } : { status: "unknownOid" };
    }
    case "candleSnapshot": {
      const end = Math.min(body.req.endTime, Date.now() - 3_600_000);
      return Array.from({ length: 60 }, (_, index) => ({ t: end - (60 - index) * 3_600_000, T: end - (59 - index) * 3_600_000 - 1, s: body.req.coin, i: body.req.interval, o: String(1940 + index), h: String(1942 + index), l: String(1939 + index), c: String(1941 + index), v: String(100 + index), n: 10 + index }));
    }
    default: throw new Error(`Unexpected Hyperliquid info type ${body.type}`);
  }
}
async function exchange(envelope) {
  const { action, nonce, signature } = envelope;
  if (action.type === "approveAgent") {
    const request = seen.walletSignatures.at(-1);
    assert(request, "Setup must go through EVM Wallet signing");
    assert.equal(action.signatureChainId, "0xa4b1"); assert.equal(action.hyperliquidChain, "Mainnet");
    assert.equal(nonce, action.nonce); assert.equal(nonce, request.typedData.message.nonce);
    assert.equal((await recoverTypedDataAddress({ ...request.typedData, signature: fullSignature(signature) })).toLowerCase(), account.address);
    assert.equal(action.agentAddress, request.typedData.message.agentAddress);
    registered = action.agentAddress === "0x" + "0".repeat(40) ? [] : [{ address: action.agentAddress, name: action.agentName, validUntil: Date.now() + 90 * 86_400_000 }];
  } else {
    assert.equal(registered.length, 1, "A venue-approved delegated key is required");
    const recovered = await recoverTypedDataAddress({ domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x" + "0".repeat(40) }, types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] }, primaryType: "Agent", message: { source: "a", connectionId: createL1ActionHash({ action, nonce }) }, signature: fullSignature(signature) });
    assert.equal(recovered.toLowerCase(), registered[0].address.toLowerCase(), "L1 action must recover the approved browser key");
    assert(seen.reviews.some(({ review, approved }) => approved && JSON.stringify(review.action) === JSON.stringify(action)), "The exact submitted action must have an approved provider review");
  }
  seen.exchange.push(structuredClone(envelope));
  if (nextExchangeFailure) { nextExchangeFailure = false; return null; }
  if (action.type === "approveAgent") return { status: "ok", response: { type: "default" } };
  if (action.type === "order") {
    const statuses = action.orders.map((order) => {
      const oid = nextOid++, coin = universe[order.a].name, immediate = order.t.limit?.tif === "Ioc";
      // An explicit partial close fills half its requested quantity. The report
      // must retain that partial outcome and the remaining actual position.
      const executed = immediate ? Number(order.s) * (order.r ? 0.5 : 1) : 0;
      const status = immediate ? executed < Number(order.s) ? "canceled" : "filled" : "open";
      const wire = { coin, oid, cloid: order.c, side: order.b ? "B" : "A", limitPx: order.p, sz: immediate ? "0" : order.s, origSz: order.s, timestamp: Date.now(), reduceOnly: order.r, isTrigger: false, isPositionTpsl: false, orderType: "Limit", triggerCondition: "N/A", triggerPx: "0", children: [] };
      venueOrders.set(oid, { order: wire, status });
      if (executed) {
        const initial = positionSize;
        positionSize = Number((positionSize + (order.b ? executed : -executed)).toFixed(8));
        fills.push({ coin, oid, tid: oid, time: Date.now(), px: "2000.5", sz: String(executed), side: order.b ? "B" : "A", startPosition: String(initial), closedPnl: "0", fee: "0.09", dir: order.r ? "Close Long" : "Open Long", hash: "0x" + oid.toString(16).padStart(64, "0"), feeToken: "USDC", crossed: true });
      }
      return immediate ? { filled: { oid, totalSz: String(executed), avgPx: "2000.5" } } : { resting: { oid } };
    });
    return { status: "ok", response: { type: "order", data: { statuses } } };
  }
  if (action.type === "cancel") {
    for (const cancel of action.cancels) {
      const row = venueOrders.get(cancel.o); assert(row, "Cancel must refer to the known resting order");
      row.status = "canceled"; row.order.sz = "0";
    }
    return { status: "ok", response: { type: "cancel", data: { statuses: action.cancels.map(() => "success") } } };
  }
  throw new Error(`Unexpected exchange action ${action.type}`);
}

async function kernelFixture(request) {
  seen.kernel.push(structuredClone(request));
  const { action, payload, context } = request;
  if (action === "app.state.publish") return null;
  if (action === "provider_approval.request") {
    assert(context?.invocation, "Agent provider review must retain invocation metadata");
    seen.reviews.push({ review: payload.review, approved: request.fixtureOutcome === "approve", source: "agent", invocation: context.invocation });
    if (request.fixtureOutcome === "deny") throw new Error("Synthetic Agent rejected this exact action");
    return { approved: true };
  }
  if (action === "provider_ui.present") {
    assert.equal(payload.tileId, "hyperliquid"); assert.equal(payload.tool, "hl_review_v1");
    seen.reviews.push({ review: JSON.parse(payload.arguments.reviewJson), approved: true, source: "foreground" });
    return { approved: true };
  }
  assert.equal(action, "tools.call", `Unexpected Kernel action ${action}`);
  if (payload.target === ownerCaller.endpoint) {
    assert.equal(payload.name, "hl_owner_review_v1");
    assert.equal(context, undefined, "An owner invocation must not carry Agent authority");
    seen.reviews.push({ review: JSON.parse(payload.arguments.reviewJson), approved: true, source: "owner", endpoint: payload.target });
    return { approved: true };
  }
  assert.equal(payload.target, "app:evm_wallet:background", `Unexpected tool target ${payload.target}`);
  if (payload.name === "evm_accounts_v1") return { accounts: [account] };
  const args = payload.arguments;
  if (payload.name === "evm_operation_status_v1") return walletOperations.get(args.requestId) ?? { ...args, status: "not_found" };
  if (payload.name === "evm_sign_typed_data_v1") {
    assert(context?.invocation, "Setup initiated by an Agent must retain its invocation in Wallet");
    const typedData = JSON.parse(args.typedDataJson);
    assert.equal(args.chainId, "42161"); assert.equal(typedData.domain.chainId, 42161);
    assert.equal(typedData.primaryType, "HyperliquidTransaction:ApproveAgent");
    assert.equal(typedData.domain.name, "HyperliquidSignTransaction");
    assert.deepEqual(Object.keys(typedData.message).sort(), ["agentAddress", "agentName", "hyperliquidChain", "nonce"]);
    assert.equal(typedData.message.hyperliquidChain, "Mainnet");
    seen.walletSignatures.push({ requestId: args.requestId, typedData, invocation: context.invocation });
    const signature = await master.signTypedData(typedData);
    const result = { accountId: args.accountId, chainId: args.chainId, requestId: args.requestId, operationId: String(walletOperations.size + 1), kind: "typed_data", status: "signed", address: account.address, transactionHash: null, signature, message: null, reviewRevision: "1", receipt: null };
    walletOperations.set(args.requestId, result); return result;
  }
  if (payload.name === "evm_call_contract_v1") {
    assert.equal(args.chainId, "1"); assert.equal(args.to.toLowerCase(), "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    return { ...args, address: account.address, result: zero, blockNumber: "100", observedAtNs: String(BigInt(Date.now()) * 1_000_000n) };
  }
  throw new Error(`Unexpected Wallet tool ${payload.name}`);
}

const built = await build({ absWorkingDir: app, stdin: { contents: `import "./src/service.ts"; window.fixtureServiceLoaded = true; parent.postMessage({type:"fixture-resident-ready"}, ${JSON.stringify(kernelOrigin)});`, resolveDir: app, sourcefile: "resident-fixture-entry.ts", loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", target: "chrome120" });
const serviceJs = built.outputFiles[0].text;
const parentHtml = `<!doctype html><html><body><iframe id="resident" sandbox="allow-scripts allow-same-origin" src="${residentUrl}"></iframe><script>
const residentOrigin=${JSON.stringify(residentOrigin)}, residentCaller=${JSON.stringify(residentCaller)}, agentCaller=${JSON.stringify(agentCaller)}, ownerCaller=${JSON.stringify(ownerCaller)};
let port, serial=100000, tools=[], readyResolve;
const pending=new Map(), approvals=new Map();
window.residentReady=new Promise(resolve=>{readyResolve=resolve});
function metadata(rootId){const id=(++serial).toString(16).padStart(16,"0");return {id,rootId:rootId||id,capability:id.padStart(64,"0")};}
function request(action,payload,context,policy={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error("Fixture tool timed out: "+(payload?.name||action)))},15000);pending.set(id,{resolve,reject,timer});if(policy.capability)approvals.set(policy.capability,{...policy,id});port.postMessage({type:"exec",id,payload:{action,payload,...(context?{context}: {})}});});}
async function incoming(event){const message=event.data;if(message.type==="response"){const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error(message.error.message||JSON.stringify(message.error))):entry.resolve(message.ok);return;}
if(message.type==="progress"||message.type==="neutron:msgbus:cancel")return;
if(message.type!=="exec")throw Error("Unexpected resident message "+message.type);
try{const requestPayload=message.payload;let result;
if(requestPayload.action==="tools.call"&&requestPayload.payload.target==="app:hyperliquid:background"){
if(requestPayload.payload.name!=="hl_identity_v1")throw Error("Unexpected self tool");
window.fixtureIdentityCalls=(window.fixtureIdentityCalls||0)+1;
result=await request("__neutron_msgbus_tools_call",{name:"hl_identity_v1",arguments:{},caller:residentCaller},requestPayload.context?.invocation?{invocation:metadata(requestPayload.context.invocation.rootId)}:undefined);
}else{const approval=approvals.get(requestPayload.payload?.capability);const fixtureOutcome=approval?.outcome||"approve";
if(requestPayload.action==="provider_approval.request"||requestPayload.action==="provider_ui.present"){
if(!approval)throw Error("Unknown provider capability");
if(approval.invocation&&requestPayload.context?.invocation.rootId!==approval.invocation.rootId)throw Error("Provider invocation lost its root");
if(fixtureOutcome==="cancel")port.postMessage({type:"neutron:msgbus:cancel",version:1,id:approval.id});
}
result=await window.fixtureKernel({...requestPayload,fixtureOutcome});}
port.postMessage({type:"response",id:message.id,ok:result});
}catch(error){port.postMessage({type:"response",id:message.id,error:{message:error.message||String(error)}});}}
window.addEventListener("message",async(event)=>{if(event.origin!==residentOrigin||event.source!==document.getElementById("resident").contentWindow||event.data.type!=="fixture-resident-ready")return;
const channel=new MessageChannel();port=channel.port1;port.onmessage=incoming;port.start();event.source.postMessage({type:"neutron:msgbus:connect",version:1,sessionId:"fixture-session-00000001"},residentOrigin,[channel.port2]);
tools=await request("__neutron_msgbus_tools_list",null);window.fixtureDescriptors=tools;readyResolve();});
window.fixtureInvoke=async(name,args={},options={})=>{await window.residentReady;const descriptor=tools.find(tool=>tool.name===name);if(!descriptor)throw Error("Unregistered tool "+name);
const invocation=options.human?undefined:metadata(),caller=options.caller||(options.human?ownerCaller:agentCaller);
const capability=(++serial).toString(16).padStart(64,"0"),provider=descriptor.annotations?.["neutron:consent"]==="provider_once";
const response=await request("__neutron_msgbus_tools_call",{name,arguments:args,caller,...(provider?{providerApproval:{capability},...(!invocation?{providerUi:true}:{})}:{})},invocation?{invocation}:undefined,{capability,outcome:options.outcome||"approve",invocation});
if(response?.dataJson!==undefined)return JSON.parse(response.dataJson);if(response?.resultJson!==undefined)return JSON.parse(response.resultJson);return response;};
</script></body></html>`;

async function launch() {
  const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", serviceWorkers: "block" });
  await context.exposeFunction("fixtureKernel", kernelFixture);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const json = (value) => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" }, body: JSON.stringify(value) });
    try {
      if (url.origin === kernelOrigin) return route.fulfill({ status: 200, contentType: "text/html", body: parentHtml });
      if (url.origin === residentOrigin) {
        if (url.pathname.endsWith("service.js")) return route.fulfill({ status: 200, contentType: "text/javascript", body: serviceJs });
        assert.equal(url.href, residentUrl);
        return route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><body><script type="module" src="./service.js"></script></body></html>' });
      }
      if (request.method() === "OPTIONS") return json({});
      if (url.origin === "https://api.hyperliquid.xyz") {
        const body = request.postDataJSON();
        if (url.pathname === "/info") return json(info(body));
        if (url.pathname === "/exchange") { const result = await exchange(body); return result === null ? route.abort("failed") : json(result); }
      }
      if (url.origin === "https://iris-api.circle.com") {
        assert.equal(request.method(), "GET"); assert.equal(url.pathname, "/v2/burn/USDC/fees/0/19");
        assert.equal(url.searchParams.get("hyperCoreDeposit"), "true"); seen.circle.push(url.href);
        return json([{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: "200000", med: "250000", high: "300000" } }]);
      }
      if (url.href === "https://rpc.hyperliquid.xyz/evm") {
        const body = request.postDataJSON(); seen.rpc.push(body); assert.equal(body.method, "eth_call");
        const call = body.params[0], selector = call.data.slice(0, 10);
        const results = { [toFunctionSelector("enabledDestinationDexes(uint32)")]: word(1), [toFunctionSelector("isDexForwardingDisabled()")]: word(0), [toFunctionSelector("cctpMaxFee()")]: word(10000), [toFunctionSelector("newCoreAccountFee()")]: word(100000000), [toFunctionSelector("calculateCrossChainWithdrawalFee(bool,uint32)")]: word(250000) };
        const result = call.to.toLowerCase() === "0x0000000000000000000000000000000000000810" ? word(1) : results[selector];
        assert(result, "Unexpected HyperEVM read"); return json({ jsonrpc: "2.0", id: body.id, result });
      }
      seen.networkEscapes.push(url.href); await route.abort("blockedbyclient");
    } catch (error) { seen.browserErrors.push(String(error.stack || error)); await route.abort("failed"); }
  });
  const page = await context.newPage();
  page.on("pageerror", error => seen.browserErrors.push(String(error.stack || error)));
  await page.goto(kernelOrigin);
  await page.evaluate(() => window.residentReady);
  return { context, page };
}
const invoke = (page, name, args = {}, options = {}) => page.evaluate(({ name, args, options }) => window.fixtureInvoke(name, args, options), { name, args, options });
const assertPublic = (value) => { const json = JSON.stringify(value); for (const field of ["privateKey", "ciphertext", "encryptionKey", "envelopeJson", '"signature"']) assert(!json.includes(field), `Public tool result exposed ${field}`); return value; };
const checkpoints = [];
let runtime;
try {
  runtime = await launch(); let { page } = runtime;
  const descriptors = await page.evaluate(() => window.fixtureDescriptors);
  assert(descriptors.length >= 24); assert(descriptors.every(tool => tool.inputSchema.additionalProperties === false));
  const missing = assertPublic(await invoke(page, "hl_setup_status_v1")); assert.equal(missing.state, "missing");
  const session = assertPublic(await invoke(page, "hl_setup_v1", { operationId: id(1), action: "approve" }));
  assert.equal(session.state, "active"); assert.equal(seen.walletSignatures.length, 1); assert.equal(seen.exchange.length, 1);
  assert.equal(session.agentAddress, registered[0].address); assert.notEqual(session.agentAddress, account.address);
  assert.equal(await page.evaluate(() => window.fixtureIdentityCalls), 1, "Resident must bind its own installation through the authenticated helper");
  const residentFrame = page.frames().find(frame => frame.url() === residentUrl);
  const keyStorage = await residentFrame.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("neutron-hyperliquid-trading-keys-v1", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const records = await new Promise((resolve, reject) => { const request = database.transaction("records").objectStore("records").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const session = records.find(record => record.encryptionKey); let exportRejected = false;
    try { await crypto.subtle.exportKey("raw", session.encryptionKey); } catch { exportRejected = true; }
    return { secure: isSecureContext, origin: location.origin, binding: session.binding, algorithm: session.encryptionKey.algorithm.name, extractable: session.encryptionKey.extractable, exportRejected, ivBytes: session.iv.byteLength, ciphertextBytes: session.ciphertext.byteLength, rawKeyProperty: records.some(record => Object.keys(record).some(key => /private.?key|secret/i.test(key))) };
  });
  assert.equal(keyStorage.origin, residentOrigin); assert.equal(keyStorage.secure, true); assert.equal(keyStorage.algorithm, "AES-GCM");
  assert.equal(keyStorage.extractable, false); assert.equal(keyStorage.exportRejected, true); assert.equal(keyStorage.rawKeyProperty, false);
  assert(keyStorage.binding.includes(`701:${account.keyFingerprint}:2`)); assert.equal(keyStorage.ivBytes, 12); assert(keyStorage.ciphertextBytes > 32);
  checkpoints.push("Agent setup uses Wallet EIP-712 chain 42161; encrypted installation key is active and nonextractable");

  const markets = assertPublic(await invoke(page, "hl_markets_v1", { query: "ETH" })); assert.equal(markets.markets[0].name, "ETH"); assert.equal(markets.markets[0].asset, 0);
  const chart = assertPublic(await invoke(page, "hl_chart_v1", { coin: "ETH" })); assert.equal(chart.candles.length, 60); assert(chart.analysis);
  const book = assertPublic(await invoke(page, "hl_orderbook_v1", { coin: "ETH", side: "buy", size: "0.1" })); assert(book.analysis); assert.equal(book.levels.length, 2);
  const screen = assertPublic(await invoke(page, "hl_market_v1", { coin: "ETH" })); assert.equal(screen.market.name, "ETH"); assert(screen.analysis.chart && screen.analysis.book);
  const fundingRate = await invoke(page, "hl_funding_rates_v1", { coin: "ETH", startTime: Date.now() - 3_600_000 }); assert.equal(fundingRate.funding.length, 1);
  const deposit = assertPublic(await invoke(page, "hl_funding_quote_v1", { direction: "deposit", chainId: "1", amount: "100" }));
  assert.equal(deposit.amountAtoms, "100000000"); assert.equal(deposit.protocolFeeAtoms, "10000"); assert.equal(deposit.maxFeeAtoms, "310000"); assert.equal(deposit.minimumReceiveAtoms, "99690000");
  const withdrawal = await invoke(page, "hl_funding_quote_v1", { direction: "withdraw", chainId: "1", amount: "100" }); assert.equal(withdrawal.sourceDex, ""); assert.equal(withdrawal.maxFeeAtoms, "250000"); assert.equal(withdrawal.protocolFeeAtoms, "10000"); assert.equal(withdrawal.forwardingFeeAtoms, "240000");
  checkpoints.push("Market, chart, book, account-fee and Ethereum/CCTP quote adapters consume real transport responses");

  const order = { operationId: id(2), coin: "ETH", side: "buy", orderType: "market", size: "0.1", slippageBps: 50 };
  const { operationId: _previewOperationId, ...previewArgs } = order;
  const preview = assertPublic(await invoke(page, "hl_preview_order_v1", previewArgs)); assert.equal(preview.review.fees.takerRate, "0.00045");
  const bought = assertPublic(await invoke(page, "hl_place_order_v1", order)); assert.equal(bought.state, "filled"); assert.equal(positionSize, 0.1);
  const limit = assertPublic(await invoke(page, "hl_place_order_v1", { operationId: id(3), coin: "ETH", side: "buy", orderType: "limit", size: "0.2", price: "1900", postOnly: true }));
  assert.equal(limit.state, "resting"); assert.equal(seen.exchange.at(-1).action.orders[0].t.limit.tif, "Alo");
  const closed = assertPublic(await invoke(page, "hl_close_position_v1", { operationId: id(4), coin: "ETH", size: "0.04", slippageBps: 50 }));
  assert.equal(closed.state, "partial"); assert.equal(closed.orders[0].filledSize, "0.02"); assert.equal(positionSize, 0.08);
  assert.equal(seen.exchange.at(-1).action.orders[0].r, true); assert.equal(seen.exchange.at(-1).action.orders[0].b, false);
  const canceled = assertPublic(await invoke(page, "hl_cancel_order_v1", { operationId: id(5), coin: "ETH", oid: limit.orders[0].oid })); assert.equal(canceled.state, "canceled");
  const reconciled = assertPublic(await invoke(page, "hl_reconcile_v1", { operationId: id(4), kind: "trade" })); assert.equal(reconciled.state, "partial");
  const actualAccount = assertPublic(await invoke(page, "hl_account_v1")); assert.equal(actualAccount.complete, true); assert.equal(actualAccount.positions[0].szi, "0.08"); assert.equal(actualAccount.openOrders.length, 0);
  const actualFills = assertPublic(await invoke(page, "hl_fills_v1")); assert.equal(actualFills.fills.length, 2);
  assert.equal(seen.walletSignatures.length, 1, "Per-order signing must stay in the browser");
  assert(!seen.kernel.some(request => /self.call|canister.call|querySelf|updateSelf/i.test(JSON.stringify(request))), "Direct trading must not call Neutron journal methods");
  checkpoints.push("Agent market, post-only limit, partial reduce-only close, cancellation and reconciliation execute directly with one setup Wallet signature");

  const beforeRejected = seen.exchange.length;
  for (const outcome of ["deny", "cancel"]) {
    await assert.rejects(invoke(page, "hl_place_order_v1", { ...order, operationId: id(outcome === "deny" ? 6 : 7) }, { outcome }), outcome === "deny" ? /rejected/ : /cancel|abort/i);
  }
  assert.equal(seen.exchange.length, beforeRejected, "Rejected or canceled exact reviews must stop exchange dispatch");
  await assert.rejects(invoke(page, "hl_place_order_v1", { ...order, caller: ownerCaller }), /schema|additional|caller/i);
  await assert.rejects(invoke(page, "hl_identity_v1", {}, { caller: agentCaller }), /unavailable/);
  await assert.rejects(invoke(page, "hl_reconcile_v1", { operationId: id(2), kind: "trade" }, { caller: { ...agentCaller, installationUid: "902" } }), /Unknown operation/);
  const ownerOrder = assertPublic(await invoke(page, "hl_place_order_v1", { operationId: id(8), coin: "ETH", side: "buy", orderType: "limit", size: "0.01", price: "1800" }, { human: true }));
  assert.equal(ownerOrder.state, "resting"); assert.equal(seen.reviews.at(-1).source, "owner"); assert.equal(seen.reviews.at(-1).endpoint, ownerCaller.endpoint);
  const foregroundOrder = await invoke(page, "hl_place_order_v1", { operationId: id(9), coin: "ETH", side: "buy", orderType: "limit", size: "0.01", price: "1800" }, { human: true, caller: { appId: "kitchensink", installationUid: "41", role: "tile", endpoint: "app:kitchensink:tile:main:instance:fixture" } });
  assert.equal(foregroundOrder.state, "resting"); assert.equal(seen.reviews.at(-1).source, "foreground");
  checkpoints.push("Real MessagePort context rejects spoofed identity, Agent denial/cancellation and cross-installation recovery; owner reviews target the originating tile");

  nextExchangeFailure = true;
  const uncertainArgs = { operationId: id(10), coin: "ETH", side: "buy", orderType: "limit", size: "0.01", price: "1700" };
  const uncertain = await invoke(page, "hl_place_order_v1", uncertainArgs); assert.equal(uncertain.state, "uncertain");
  const originalEnvelope = JSON.stringify(seen.exchange.at(-1)), countBeforeReload = seen.exchange.length;
  await runtime.context.close(); runtime = await launch(); page = runtime.page;
  const restored = assertPublic(await invoke(page, "hl_setup_status_v1")); assert.equal(restored.state, "active"); assert.equal(restored.agentAddress, session.agentAddress);
  const continued = await invoke(page, "hl_place_order_v1", uncertainArgs); assert.equal(continued.state, "uncertain");
  assert.equal(seen.exchange.length, countBeforeReload); assert.equal(seen.walletSignatures.length, 1);
  const retry = assertPublic(await invoke(page, "hl_retry_trade_v1", { operationId: id(10) })); assert.equal(retry.state, "resting");
  assert.equal(JSON.stringify(seen.exchange.at(-1)), originalEnvelope, "Explicit retry after browser restart must resend identical signed bytes");
  checkpoints.push("A real Chromium restart preserves the encrypted signer and uncertain intent; ordinary continuation only reconciles and explicit retry sends identical bytes");

  assert.deepEqual(seen.networkEscapes, []); assert.deepEqual(seen.browserErrors, []);
  const report = { passed: true, checkpoints, observedAt: new Date().toISOString(), runtime: await runtime.context.browser()?.version() ?? "Chromium persistent context", transport: "Unmodified neutron-tools/app over a real parent/iframe MessageChannel", storage: keyStorage, registeredTools: descriptors.map(tool => tool.name), walletSignatures: seen.walletSignatures.length, directExchangeRequests: seen.exchange.length, providerReviews: seen.reviews.length, directInfoRequests: seen.info.length, circleQuotes: seen.circle.length, forbiddenNetworkRequests: seen.networkEscapes, limitations: ["Kernel routing/authorization decisions and EVM Wallet signing are synthetic fixtures; actual app and SDK validate inputs and construct scoped contexts.", "All venue, Circle and RPC responses are intercepted fixtures. No funded execution or live venue acceptance is claimed.", "Owner and external foreground review responses are fixtures; the separate UI browser test qualifies the rendered dialogs."] };
  await writeFile(resolve(artifacts, "resident-report.json"), JSON.stringify(report, null, 2) + "\n");
  await rm(resolve(artifacts, "resident-failure.json"), { force: true });
  console.log(JSON.stringify({ passed: true, checkpoints: checkpoints.length, tools: descriptors.length, walletSignatures: report.walletSignatures, directExchangeRequests: report.directExchangeRequests, report: resolve(artifacts, "resident-report.json") }));
} catch (error) {
  await writeFile(resolve(artifacts, "resident-failure.json"), JSON.stringify({ error: String(error.stack || error), checkpoints, ...seen }, null, 2) + "\n");
  throw error;
} finally {
  await runtime?.context.close();
  await rm(profile, { recursive: true, force: true });
}
