/** Browser integration qualification for the actual resident, SDK transport,
 * trading engine, signing adapters, WebCrypto and installation-origin IndexedDB.
 * The outer Kernel/Wallet and venue are synthetic fixtures. Every request is
 * intercepted; this test never sends an external transaction or order. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, recoverTypedDataAddress, stringToHex, toFunctionSelector } from "viem";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";

const app = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = process.env.HL_BROWSER_ARTIFACTS || "/tmp/neutron-hyperliquid-browser";
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(resolve(tmpdir(), "neutron-hl-resident-"));
const kernelOrigin = "https://4caro-hl777-77775-aaaba-cai.icp0.io";
const residentOrigin = "https://p0123456789abcdef01234567--4caro-hl777-77775-aaaba-cai.icp0.io";
const residentUrl = `${residentOrigin}/app/hyperliquid/service.html`;
const tileUrl = `${residentOrigin}/app/hyperliquid/index.html`;
const agentCaller = { appId: "agent", installationUid: "901", role: "background", endpoint: "app:agent:background" };
const residentCaller = { appId: "hyperliquid", installationUid: "701", role: "background", endpoint: "app:hyperliquid:background" };
const ownerCaller = { appId: "hyperliquid", installationUid: "701", role: "tile", endpoint: "app:hyperliquid:tile:hyperliquid:instance:fixture-owner" };
// Public, unfunded test vector. This key belongs only to the synthetic Wallet.
const master = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const account = { accountId: "main", address: master.address.toLowerCase(), publicKey: master.publicKey, keyFingerprint: keccak256(master.publicKey), namespaceVersion: "2" };
const zero = "0x" + "0".repeat(64), word = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");
const fullSignature = ({ r, s, v }) => `${r}${s.slice(2)}${Number(v).toString(16).padStart(2, "0")}`;
const id = (value) => Number(value).toString(16).padStart(32, "0");
const seen = { kernel: [], reviews: [], walletReviews: [], walletTransactions: [], walletSignatures: [], exchange: [], info: [], circle: [], rpc: [], networkEscapes: [], browserErrors: [] };
const walletOperations = new Map(), walletTransactions = new Map(), fundingRecords = new Map(), venueOrders = new Map(), fills = [];
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
    case "activeAssetData": return { user: body.user, coin: body.coin, leverage: { type: "cross", value: 3 }, maxTradeSzs: ["15", "12"], availableToTrade: ["10000", "8000"], markPx: String(price) };
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
  if (action.type === "approveAgent" || action.type === "sendToEvmWithData") {
    const request = seen.walletSignatures.at(-1);
    assert(request, "Setup must go through EVM Wallet signing");
    assert.equal(action.signatureChainId, "0xa4b1"); assert.equal(action.hyperliquidChain, "Mainnet");
    assert.equal(nonce, action.nonce); assert.equal(nonce, request.typedData.message.nonce);
    assert.equal((await recoverTypedDataAddress({ ...request.typedData, signature: fullSignature(signature) })).toLowerCase(), account.address);
    if (action.type === "approveAgent") {
      assert.equal(action.agentAddress, request.typedData.message.agentAddress);
      registered = action.agentAddress === "0x" + "0".repeat(40) ? [] : [{ address: action.agentAddress, name: action.agentName, validUntil: Date.now() + 90 * 86_400_000 }];
    } else {
      assert.equal(action.destinationRecipient, account.address);
      assert.equal(action.amount, request.typedData.message.amount);
      assert.equal(action.destinationChainId, request.typedData.message.destinationChainId);
    }
  } else {
    assert.equal(registered.length, 1, "A venue-approved delegated key is required");
    const recovered = await recoverTypedDataAddress({ domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x" + "0".repeat(40) }, types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] }, primaryType: "Agent", message: { source: "a", connectionId: createL1ActionHash({ action, nonce }) }, signature: fullSignature(signature) });
    assert.equal(recovered.toLowerCase(), registered[0].address.toLowerCase(), "L1 action must recover the approved browser key");
    assert(seen.reviews.some(({ review, approved }) => approved && JSON.stringify(review.action) === JSON.stringify(action)), "The exact submitted action must have an approved provider review");
  }
  seen.exchange.push(structuredClone(envelope));
  if (nextExchangeFailure) { nextExchangeFailure = false; return null; }
  if (action.type === "approveAgent" || action.type === "sendToEvmWithData") return { status: "ok", response: { type: "default" } };
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
  if (action === "canister.query_self" || action === "canister.update_self") {
    if (action === "canister.update_self") assert(context?.invocation, "Root funding must retain its invocation through durable journal calls");
    const [value] = payload.args;
    if (payload.method === "hyperliquid_page_v1") return { rows: [], next_cursor: null };
    if (payload.method === "hyperliquid_get_v1") return structuredClone(fundingRecords.get(value) ?? null);
    if (payload.method === "hyperliquid_begin_v1") {
      assert(!fundingRecords.has(value.id), "Funding intent must only initialize once");
      const row = { ...value, revision: "0", created_at: String(Date.now()), updated_at: String(Date.now()) };
      fundingRecords.set(value.id, row); return structuredClone(row);
    }
    if (payload.method === "hyperliquid_update_v1") {
      const prior = fundingRecords.get(value.id); assert(prior); assert.equal(prior.revision, value.expected_revision);
      const row = { ...prior, state_json: value.state_json, phase: value.phase, revision: String(BigInt(prior.revision) + 1n), updated_at: String(Date.now()) };
      fundingRecords.set(value.id, row); return structuredClone(row);
    }
    throw Error(`Unexpected funding journal method ${payload.method}`);
  }
  if (action === "provider_approval.request") {
    assert(context?.invocation, "Agent provider review must retain invocation metadata");
    seen.reviews.push({ review: payload.review, approved: request.fixtureOutcome === "approve", source: "agent", invocation: context.invocation });
    if (request.fixtureOutcome === "deny") throw new Error("Synthetic Agent rejected this exact action");
    return { approved: true };
  }
  if (action === "provider_ui.present") {
    assert.equal(payload.tileId, "hyperliquid"); assert.equal(payload.tool, "hl_review_v1");
    assert.equal(context, undefined, "Normal Agent review must not acquire Root authority");
    const entry = { review: JSON.parse(payload.arguments.reviewJson), approved: false, source: request.fixtureMode === "normal" ? "normal_agent" : "foreground" };
    seen.reviews.push(entry);
    if (request.fixtureMode === "normal") return { reviewIndex: seen.reviews.length - 1 };
    entry.approved = request.fixtureOutcome === "approve";
    return { approved: entry.approved };
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
  if (payload.name === "evm_balances_v1") {
    assert.equal(args.accountId, "main"); assert.equal(args.chainId, "1"); assert.deepEqual(args.tokens, ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]);
    return { accountId: args.accountId, chainId: args.chainId, address: account.address, nativeBalanceWei: "10000000000000000", tokens: args.tokens.map(address => ({ address, balanceAtoms: "10123456", decimals: "6", symbol: "USDC", error: null })), blockNumber: "123", observedAtNs: String(BigInt(Date.now()) * 1_000_000n), completeness: "requested_only" };
  }
  if (payload.name === "evm_operation_status_v1") return walletOperations.get(args.requestId) ?? { ...args, status: "not_found" };
  if (payload.name === "evm_sign_typed_data_v1") {
    assert(context?.invocation, "Setup initiated by an Agent must retain its invocation in Wallet");
    const typedData = JSON.parse(args.typedDataJson);
    assert.equal(args.chainId, "42161"); assert.equal(typedData.domain.chainId, 42161);
    assert(["HyperliquidTransaction:ApproveAgent", "HyperliquidTransaction:SendToEvmWithData"].includes(typedData.primaryType));
    assert.equal(typedData.domain.name, "HyperliquidSignTransaction");
    if (typedData.primaryType === "HyperliquidTransaction:ApproveAgent") assert.deepEqual(Object.keys(typedData.message).sort(), ["agentAddress", "agentName", "hyperliquidChain", "nonce"]);
    assert.equal(typedData.message.hyperliquidChain, "Mainnet");
    // The real Wallet provider and Kernel's nested Root consent route have
    // separate focused tests. This fixture checks that the resident delivers
    // the exact request and its active invocation to that boundary.
    seen.walletReviews.push({ request: structuredClone(args), source: "root_judge", invocation: context.invocation });
    if (request.fixtureOutcome !== "approve") throw Error("Synthetic Root judge rejected the exact Wallet signature");
    seen.walletSignatures.push({ requestId: args.requestId, typedData, invocation: context.invocation });
    const signature = await master.signTypedData(typedData);
    const result = { accountId: args.accountId, chainId: args.chainId, requestId: args.requestId, operationId: String(walletOperations.size + 1), kind: "typed_data", status: "signed", address: account.address, transactionHash: null, signature, message: null, reviewRevision: "1", receipt: null };
    walletOperations.set(args.requestId, result); return result;
  }
  if (payload.name === "evm_send_transaction_v1") {
    assert(context?.invocation, "Root deposits must retain their invocation in Wallet");
    assert.equal(args.chainId, "1"); assert.equal(args.valueWei, "0");
    const isApproval = args.to.toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    assert.equal(args.data.slice(0, 10), toFunctionSelector(isApproval ? "approve(address,uint256)" : "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)"));
    seen.walletReviews.push({ request: structuredClone(args), source: "root_judge", invocation: context.invocation });
    if (request.fixtureOutcome !== "approve") throw Error("Synthetic Root judge rejected the exact Wallet transaction");
    seen.walletTransactions.push(structuredClone(args));
    const hash = keccak256(stringToHex(args.requestId)), blockHash = "0x" + "99".repeat(32), observedAtNs = String(BigInt(Date.now()) * 1_000_000n);
    const receipt = { blockNumber: "123", blockHash, status: "success", gasUsed: "50000", effectiveGasPriceWei: "10000000", finality: "included", observedAtNs, logs: [] };
    const result = { accountId: args.accountId, chainId: args.chainId, requestId: args.requestId, operationId: String(walletOperations.size + 1), kind: "transaction", status: "confirmed", address: account.address, transactionHash: hash, signature: null, message: null, reviewRevision: "1", receipt };
    walletOperations.set(args.requestId, result);
    walletTransactions.set(hash, { chainId: args.chainId, transactionHash: hash, walletRequestMatches: null, transaction: { from: account.address, to: args.to, data: args.data, valueWei: "0", nonce: "0", blockNumber: "123", blockHash }, receipt, observedAtNs, source: "evm_rpc" });
    return result;
  }
  if (payload.name === "evm_transaction_v1") { assert(walletTransactions.has(args.transactionHash)); return walletTransactions.get(args.transactionHash); }
  if (payload.name === "evm_call_contract_v1") {
    assert.equal(args.chainId, "1"); assert.equal(args.to.toLowerCase(), "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    return { ...args, address: account.address, result: zero, blockNumber: "100", observedAtNs: String(BigInt(Date.now()) * 1_000_000n) };
  }
  throw new Error(`Unexpected Wallet tool ${payload.name}`);
}

const built = await build({ absWorkingDir: app, stdin: { contents: `import "./src/service.ts"; window.fixtureServiceLoaded = true; parent.postMessage({type:"fixture-resident-ready"}, ${JSON.stringify(kernelOrigin)});`, resolveDir: app, sourcefile: "resident-fixture-entry.ts", loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", target: "chrome120" });
const serviceJs = built.outputFiles[0].text;
const uiBuilt = await build({ absWorkingDir: app, stdin: { contents: `import "./src/main.tsx"; parent.postMessage({type:"fixture-tile-ready"}, ${JSON.stringify(kernelOrigin)});`, resolveDir: app, sourcefile: "tile-fixture-entry.ts", loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic", outdir: resolve(artifacts, "resident-ui-build"), target: "chrome120", plugins: [sassPlugin()] });
const uiJs = uiBuilt.outputFiles.find(file => file.path.endsWith(".js")).text;
const uiCss = uiBuilt.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
const parentHtml = `<!doctype html><html><body><iframe id="resident" style="display:none" sandbox="allow-scripts allow-same-origin" src="${residentUrl}"></iframe><script>
const residentOrigin=${JSON.stringify(residentOrigin)}, residentCaller=${JSON.stringify(residentCaller)}, agentCaller=${JSON.stringify(agentCaller)}, ownerCaller=${JSON.stringify(ownerCaller)};
let port, serial=100000, tools=[], readyResolve;
let tilePort, tileReadyResolve, tileReady;
const tilePending=new Map();
const pending=new Map(), approvals=new Map(), invocationPolicies=new Map();
let foregroundPolicy;
window.residentReady=new Promise(resolve=>{readyResolve=resolve});
function metadata(rootId){const id=(++serial).toString(16).padStart(16,"0");return {id,rootId:rootId||id,capability:id.padStart(64,"0")};}
function request(action,payload,context,policy={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error("Fixture tool timed out: "+(payload?.name||action)))},15000);pending.set(id,{resolve,reject,timer});if(policy.capability)approvals.set(policy.capability,{...policy,id});port.postMessage({type:"exec",id,payload:{action,payload,...(context?{context}: {})}});});}
function tileRequest(action,payload){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{tilePending.delete(id);reject(Error("Fixture tile timed out"))},15000);tilePending.set(id,{resolve,reject,timer});tilePort.postMessage({type:"exec",id,payload:{action,payload}});});}
async function tileIncoming(event){const message=event.data;if(message.type==="response"){const entry=tilePending.get(message.id);if(!entry)return;tilePending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error(message.error.message||JSON.stringify(message.error))):entry.resolve(message.ok);return;}
if(message.type==="progress"||message.type==="neutron:msgbus:cancel")return;
try{if(message.type!=="exec")throw Error("Unexpected tile message "+message.type);const call=message.payload;let result;
if(call.action==="tools.call"&&call.payload.target==="app:hyperliquid:background")result=await request("__neutron_msgbus_tools_call",{name:call.payload.name,arguments:call.payload.arguments,caller:ownerCaller});
else result=await window.fixtureKernel(call);
tilePort.postMessage({type:"response",id:message.id,ok:result});}catch(error){tilePort.postMessage({type:"response",id:message.id,error:{message:error.message||String(error)}});}}
async function openTile(){if(!tileReady){tileReady=new Promise(resolve=>{tileReadyResolve=resolve});const tile=document.createElement("iframe");tile.id="tile";tile.style="width:640px;height:850px;border:0";tile.sandbox="allow-scripts allow-same-origin";tile.src=${JSON.stringify(tileUrl)};document.body.append(tile);}await tileReady;}
window.fixtureReviewTool=async(name,caller,audience)=>{await openTile();return tileRequest("__neutron_msgbus_tools_call",{name,arguments:{reviewJson:JSON.stringify({title:"Untrusted review"})},caller,...(audience?{audience}:{})});};
window.fixtureCloseTile=()=>{document.getElementById("tile")?.remove();tilePort?.close();tilePort=undefined;tileReady=undefined;};
async function incoming(event){const message=event.data;if(message.type==="response"){const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error(message.error.message||JSON.stringify(message.error))):entry.resolve(message.ok);return;}
if(message.type==="progress"||message.type==="neutron:msgbus:cancel")return;
if(message.type==="neutron:self-call:exec"){
try{const result=await window.fixtureKernel({action:message.tool,payload:{method:message.method,args:message.args},context:message.context});port.postMessage({type:"neutron:self-call:response",version:1,id:message.id,ok:result,blobs:[]});}
catch(error){port.postMessage({type:"neutron:self-call:response",version:1,id:message.id,error:{message:error.message||String(error)},blobs:[]});}return;}
if(message.type!=="exec")throw Error("Unexpected resident message "+message.type);
try{const requestPayload=message.payload;let result;
if(requestPayload.action==="tools.call"&&requestPayload.payload.target==="app:hyperliquid:background"){
if(requestPayload.payload.name!=="hl_identity_v1")throw Error("Unexpected self tool");
window.fixtureIdentityCalls=(window.fixtureIdentityCalls||0)+1;
result=await request("__neutron_msgbus_tools_call",{name:"hl_identity_v1",arguments:{},caller:residentCaller},requestPayload.context?.invocation?{invocation:metadata(requestPayload.context.invocation.rootId)}:undefined);
}else{const approval=approvals.get(requestPayload.payload?.capability),inherited=invocationPolicies.get(requestPayload.context?.invocation?.rootId)||foregroundPolicy;const fixtureOutcome=approval?.outcome||inherited?.outcome||"approve";
if(requestPayload.action==="provider_approval.request"||requestPayload.action==="provider_ui.present"){
if(!approval)throw Error("Unknown provider capability");
if(approval.invocation&&requestPayload.context?.invocation.rootId!==approval.invocation.rootId)throw Error("Provider invocation lost its root");
if(fixtureOutcome==="cancel")port.postMessage({type:"neutron:msgbus:cancel",version:1,id:approval.id});
}
result=await window.fixtureKernel({...requestPayload,fixtureOutcome,fixtureMode:inherited?.mode});
if(requestPayload.action==="provider_ui.present"&&inherited?.mode==="normal"){
if(fixtureOutcome==="legacy_guard_error")throw Error("Hyperliquid owner review requires the authenticated Hyperliquid app.");
await openTile();const index=result.reviewIndex;
// Match Kernel presentProviderUiForEndpoint exactly: its foreground tool sees
// the ORIGINAL requester, not the provider resident, with Kernel attestation.
result=await tileRequest("__neutron_msgbus_tools_call",{name:requestPayload.payload.tool,arguments:requestPayload.payload.arguments,caller:approval.caller,audience:"foreground_tile"});
await window.fixtureReviewResult(index,result.approved);
}}
port.postMessage({type:"response",id:message.id,ok:result});
}catch(error){port.postMessage({type:"response",id:message.id,error:{message:error.message||String(error)}});}}
window.addEventListener("message",async(event)=>{if(event.origin!==residentOrigin)return;
if(event.source===document.getElementById("tile")?.contentWindow&&event.data.type==="fixture-tile-ready"){
const channel=new MessageChannel();tilePort=channel.port1;tilePort.onmessage=tileIncoming;tilePort.start();event.source.postMessage({type:"neutron:msgbus:connect",version:1,sessionId:"fixture-tile-session-0001"},residentOrigin,[channel.port2]);await tileRequest("__neutron_msgbus_tools_list",null);tileReadyResolve();return;}
if(event.source!==document.getElementById("resident").contentWindow||event.data.type!=="fixture-resident-ready")return;
const channel=new MessageChannel();port=channel.port1;port.onmessage=incoming;port.start();event.source.postMessage({type:"neutron:msgbus:connect",version:1,sessionId:"fixture-session-00000001"},residentOrigin,[channel.port2]);
tools=await request("__neutron_msgbus_tools_list",null);window.fixtureDescriptors=tools;readyResolve();});
window.fixtureInvoke=async(name,args={},options={})=>{await window.residentReady;const descriptor=tools.find(tool=>tool.name===name);if(!descriptor)throw Error("Unregistered tool "+name);
const invocation=options.human||options.mode==="normal"?undefined:metadata(),caller=options.caller||(options.human?ownerCaller:agentCaller),policy={outcome:options.outcome||"approve",mode:options.mode||(options.human?"human":"root")};
if(invocation)invocationPolicies.set(invocation.rootId,policy);else foregroundPolicy=policy;
const capability=(++serial).toString(16).padStart(64,"0"),provider=descriptor.annotations?.["neutron:consent"]==="provider_once";
let response;try{response=await request("__neutron_msgbus_tools_call",{name,arguments:args,caller,...(provider?{providerApproval:{capability},...(!invocation?{providerUi:true}:{})}:{})},invocation?{invocation}:undefined,{capability,outcome:policy.outcome,invocation,caller});}finally{if(invocation)invocationPolicies.delete(invocation.rootId);else foregroundPolicy=undefined;}
if(response?.dataJson!==undefined)return JSON.parse(response.dataJson);if(response?.resultJson!==undefined)return JSON.parse(response.resultJson);return response;};
</script></body></html>`;

async function launch() {
  const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", serviceWorkers: "block" });
  await context.exposeFunction("fixtureKernel", kernelFixture);
  await context.exposeFunction("fixtureReviewResult", (index, approved) => { assert.equal(typeof approved, "boolean"); seen.reviews[index].approved = approved; });
  await context.routeWebSocket("wss://api.hyperliquid.xyz/ws", socket => { socket.onMessage(() => {}); });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const json = (value) => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" }, body: JSON.stringify(value) });
    try {
      if (url.origin === kernelOrigin) return route.fulfill({ status: 200, contentType: "text/html", body: parentHtml });
      if (url.origin === residentOrigin) {
        if (url.pathname.endsWith("service.js")) return route.fulfill({ status: 200, contentType: "text/javascript", body: serviceJs });
        if (url.pathname.endsWith("main.js")) return route.fulfill({ status: 200, contentType: "text/javascript", body: uiJs });
        if (url.pathname.endsWith("main.css")) return route.fulfill({ status: 200, contentType: "text/css", body: uiCss });
        if (url.pathname === "/app/hyperliquid/static/icon.svg") return route.fulfill({ status: 200, contentType: "image/svg+xml", body: await readFile(new URL("../../public/static/icon.svg", import.meta.url), "utf8") });
        if (url.href === tileUrl) return route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head><link rel="stylesheet" href="./main.css"></head><body><div id="root"></div><script type="module" src="./main.js"></script></body></html>' });
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
        assert.equal(request.method(), "GET"); seen.circle.push(url.href);
        if (url.pathname === "/v2/messages/0") return json({ messages: [] });
        assert.equal(url.pathname, "/v2/burn/USDC/fees/0/19");
        assert.equal(url.searchParams.get("hyperCoreDeposit"), "true");
        return json([{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: "200000", med: "250000", high: "300000" } }]);
      }
      if (url.href === "https://rpc.hyperliquid.xyz/evm" || url.origin === "https://ethereum-rpc.publicnode.com") {
        const body = request.postDataJSON(); seen.rpc.push(body);
        if (body.method === "eth_blockNumber") return json({ jsonrpc: "2.0", id: body.id, result: "0x100" });
        if (body.method === "eth_getLogs") return json({ jsonrpc: "2.0", id: body.id, result: [] });
        assert.equal(body.method, "eth_call");
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
  const depositCapacity = assertPublic(await invoke(page, "hl_funding_capacity_v1", { direction: "deposit", chainId: "1" })); assert.equal(depositCapacity.maxAmountUsdc, "10.123456");
  const withdrawalCapacity = assertPublic(await invoke(page, "hl_funding_capacity_v1", { direction: "withdraw", chainId: "1" })); assert.equal(withdrawalCapacity.maxAmountUsdc, "9000");
  const orderCapacity = assertPublic(await invoke(page, "hl_order_capacity_v1", { coin: "ETH", side: "buy", orderType: "market", slippageBps: 50 }));
  assert.equal(orderCapacity.leverage, 3); assert.equal(orderCapacity.availableMarginUsdc, "10000"); assert.equal(orderCapacity.sizeDecimals, 4);
  assert(Number(orderCapacity.maxSize) > 0 && Number(orderCapacity.maxSize) < 15, "Max must use account leverage and reserve fees/price movement within venue capacity");
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
  const closeCapacity = assertPublic(await invoke(page, "hl_order_capacity_v1", { coin: "ETH", side: "sell", orderType: "market", reduceOnly: true })); assert.equal(closeCapacity.maxSize, "0.08");
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

  const beforeNormal = seen.exchange.length;
  const normalArgs = { operationId: id(11), coin: "ETH", side: "buy", orderType: "limit", size: "0.01", price: "1600" };
  // Reproduce the published UI guard error at the presentation boundary after
  // the real resident has durably prepared the order, then recover that same ID.
  await assert.rejects(invoke(page, "hl_place_order_v1", normalArgs, { mode: "normal", outcome: "legacy_guard_error" }), /authenticated Hyperliquid app/);
  const savedPrepared = assertPublic(await invoke(page, "hl_reconcile_v1", { operationId: normalArgs.operationId, kind: "trade" }, { mode: "normal" }));
  assert.equal(savedPrepared.state, "prepared"); assert.equal(seen.exchange.length, beforeNormal);
  let ownerReviewError;
  const awaitingOwner = invoke(page, "hl_place_order_v1", normalArgs, { mode: "normal", outcome: "pending" }).catch(error => { ownerReviewError = error; return null; });
  // A second isolated iframe runs the actual React UI and unmodified SDK. The
  // fixture only routes the original caller + Kernel foreground attestation.
  const reviewFrame = page.frameLocator("#tile");
  const approvalButton = reviewFrame.getByRole("button", { name: "Approve action", exact: true });
  await approvalButton.waitFor({ timeout: 10_000 }).catch(error => { throw ownerReviewError ?? error; });
  assert.equal(await reviewFrame.getByRole("dialog").count(), 1);
  assert.equal(seen.reviews.at(-1).source, "normal_agent"); assert.equal(seen.reviews.at(-1).approved, false);
  assert.equal(seen.exchange.length, beforeNormal, "Normal Agent must wait for the owner's explicit decision before dispatch");
  assert.equal(seen.reviews.at(-1).review.action.orders[0].c, savedPrepared.orders[0].cloid);
  await page.screenshot({ path: resolve(artifacts, "normal-agent-real-review.png"), fullPage: true });
  await approvalButton.click();
  const normalResult = await awaitingOwner;
  assert(normalResult, String(ownerReviewError ?? "The reviewed order did not return a result"));
  assert.equal(normalResult.state, "resting"); assert.equal(normalResult.operationId, normalArgs.operationId);
  assert.equal(normalResult.orders[0].cloid, savedPrepared.orders[0].cloid, "Retrying prepared must keep its original order identity");
  assert.equal(seen.exchange.length, beforeNormal + 1);
  const decline = invoke(page, "hl_place_order_v1", { ...normalArgs, operationId: id(12) }, { mode: "normal", outcome: "deny" });
  const rejected = assert.rejects(decline, /declined/);
  await reviewFrame.getByRole("button", { name: "Decline", exact: true }).click(); await rejected;
  assert.equal(seen.exchange.length, beforeNormal + 1, "Normal Agent's declined review must not submit an order");
  await assert.rejects(page.evaluate(caller => window.fixtureReviewTool("hl_review_v1", caller), agentCaller), /audience attestation/);
  await assert.rejects(page.evaluate(caller => window.fixtureReviewTool("hl_owner_review_v1", caller), agentCaller), /resident service|foreground attestation/);
  assert.equal(await reviewFrame.getByRole("dialog").count(), 0, "Invalid review callers must not create a dialog");
  await page.evaluate(() => window.fixtureCloseTile());
  checkpoints.push("Normal Agent's original caller reaches the actual React review through Kernel foreground attestation; a saved prepared order resumes with the same cloid, Approve dispatches once, Decline dispatches nothing, and unscoped/private-route spoofing is rejected");

  const beforeRootFunding = { reviews: seen.reviews.length, walletReviews: seen.walletReviews.length, walletSignatures: seen.walletSignatures.length, transactions: seen.walletTransactions.length };
  const depositArgs = { operationId: id(13), direction: "deposit", chainId: "1", amount: "10" };
  const funded = assertPublic(await invoke(page, "hl_funding_execute_v1", depositArgs));
  assert.equal(funded.state, "pending"); assert.equal(funded.phase, "waiting_attestation");
  assert.equal(funded.steps.length, 2); assert(funded.steps.every(step => step.status === "confirmed"));
  assert.equal(seen.walletTransactions.length, beforeRootFunding.transactions + 2, "Root funding must approve exact USDC and burn once through Wallet");
  const fundingTxCount = seen.walletTransactions.length;
  await invoke(page, "hl_funding_execute_v1", depositArgs);
  assert.equal(seen.walletTransactions.length, fundingTxCount, "Continuing Root funding must only reconcile the saved deposit");
  const withdrawn = assertPublic(await invoke(page, "hl_funding_execute_v1", { operationId: id(14), direction: "withdraw", chainId: "1", amount: "10" }));
  assert.equal(withdrawn.state, "pending"); assert.equal(withdrawn.phase, "waiting_source");
  assert.equal(seen.exchange.at(-1).action.type, "sendToEvmWithData");
  assert.equal(seen.walletSignatures.at(-1).typedData.primaryType, "HyperliquidTransaction:SendToEvmWithData");
  const revoked = assertPublic(await invoke(page, "hl_setup_v1", { operationId: id(15), action: "revoke" }));
  assert.equal(revoked.state, "revoked"); assert.equal(registered.length, 0);
  assert.equal(seen.exchange.at(-1).action.agentAddress, "0x" + "0".repeat(40));
  const reauthorized = assertPublic(await invoke(page, "hl_setup_v1", { operationId: id(16), action: "approve" }));
  assert.equal(reauthorized.state, "active"); assert.notEqual(reauthorized.agentAddress, session.agentAddress);
  assert.equal(seen.walletSignatures.length, beforeRootFunding.walletSignatures + 3);
  assert.equal(seen.walletReviews.length, beforeRootFunding.walletReviews + 5);
  assert(seen.walletReviews.slice(beforeRootFunding.walletReviews).every(review => review.source === "root_judge" && review.invocation));
  assert.equal(seen.reviews.length, beforeRootFunding.reviews, "Root master-wallet actions must not open a Hyperliquid foreground review");
  assert.equal(page.frames().length, 2, "Root actions must not require any application tile; only the resident iframe exists");
  checkpoints.push("Root executes exact USDC approval and deposit, reconciles without a duplicate burn, signs withdrawal, revokes and reauthorizes browser access through scoped Wallet tools without a foreground tile");

  assert.deepEqual(seen.networkEscapes, []); assert.deepEqual(seen.browserErrors, []);
  const report = { passed: true, checkpoints, observedAt: new Date().toISOString(), runtime: await runtime.context.browser()?.version() ?? "Chromium persistent context", transport: "Unmodified neutron-tools/app over real parent/resident/tile MessageChannels; Normal Agent review uses the actual React dialog", storage: keyStorage, registeredTools: descriptors.map(tool => tool.name), walletSignatures: seen.walletSignatures.length, walletTransactions: seen.walletTransactions.length, scopedWalletReviews: seen.walletReviews.length, directExchangeRequests: seen.exchange.length, providerReviews: seen.reviews.length, directInfoRequests: seen.info.length, circleQuotes: seen.circle.length, forbiddenNetworkRequests: seen.networkEscapes, limitations: ["Kernel routing/authorization decisions and EVM Wallet signing are synthetic fixtures; actual app and SDK validate inputs and construct scoped contexts. Focused Kernel and Wallet provider tests independently cover their approval implementations.", "All venue, Circle and RPC responses are intercepted fixtures. No funded execution or live venue acceptance is claimed.", "Normal Agent review is rendered and clicked in the actual UI. Own-tile and non-Agent external review responses are fixtures; the separate UI browser test qualifies the owner's rendered dialog."] };
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
