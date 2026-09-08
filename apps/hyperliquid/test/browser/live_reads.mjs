/** Opt-in live, read-only browser qualification. Requires network access and Chromium.
 * Run from either repository or app cwd: node <path>/test/browser/live_reads.mjs.
 * Evidence stays outside the repository. No wallet, signature, /exchange request,
 * transaction, user account, private key, or funded fixture is used.
 */
import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../../", import.meta.url));
const evidencePath = process.env.HL_LIVE_EVIDENCE || "/tmp/neutron-hyperliquid-live-evidence.json";
const evidence = {
  startedAt: new Date().toISOString(),
  scope: "Read-only qualification; source adapters bundled into a real Chromium browser with normal web security.",
  publicAccount: "0x0000000000000000000000000000000000000000",
  sources: [
    "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint",
    "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions",
    "https://developers.circle.com/cctp/references/hypercore-contract-addresses",
    "https://developers.circle.com/cctp/howtos/transfer-usdc-from-ethereum-to-hypercore",
    "https://developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-evm",
  ],
  sourceSha256: {},
  checks: [],
  rejectedRequests: [],
};
for (const file of ["src/market.ts", "src/funding_protocol.ts"]) {
  evidence.sourceSha256[file] = createHash("sha256").update(await readFile(resolve(app, file))).digest("hex");
}
const bundle = await build({
  absWorkingDir: app,
  stdin: {
    contents: 'export * from "./src/market.ts"; export * from "./src/funding_protocol.ts"; export { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";',
    resolveDir: app,
    loader: "ts",
  },
  bundle: true, write: false, format: "iife", globalName: "HLLive", platform: "browser",
});
const javascript = bundle.outputFiles[0].text;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : "text/html");
  response.end(request.url === "/app.js" ? javascript : '<!doctype html><meta charset="utf-8"><title>Hyperliquid live read qualification</title><script src="/app.js"></script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;

// This guard makes accidental protocol effects a test failure before transmission.
const infoTypes = new Set(["metaAndAssetCtxs", "l2Book", "candleSnapshot", "clearinghouseState", "frontendOpenOrders", "userFees", "userAbstraction", "spotClearinghouseState", "userFills", "userFillsByTime", "fundingHistory", "activeAssetData", "orderStatus"]);
const rpcMethods = new Set(["eth_chainId", "eth_getCode", "eth_call"]);
async function onlyReadRequests(route) {
  const request = route.request(), target = new URL(request.url());
  if (target.origin === url) return route.continue();
  let permitted = false;
  try {
    const body = request.postDataJSON();
    if (["api.hyperliquid.xyz", "api.hyperliquid-testnet.xyz"].includes(target.hostname)) {
      permitted = target.pathname === "/info" && request.method() === "POST" && infoTypes.has(body?.type);
    } else if (target.hostname === "iris-api.circle.com") {
      permitted = request.method() === "GET" && /^\/v2\/(burn\/USDC\/fees\/(0|3)\/19|messages\/(0|3))$/.test(target.pathname);
    } else if (["rpc.hyperliquid.xyz", "ethereum-rpc.publicnode.com", "arbitrum-one-rpc.publicnode.com"].includes(target.hostname)) {
      permitted = request.method() === "POST" && rpcMethods.has(body?.method);
    }
  } catch { /* A request that cannot be classified is blocked. */ }
  if (permitted) return route.continue();
  evidence.rejectedRequests.push({ method: request.method(), url: request.url() });
  return route.abort("blockedbyclient");
}

async function check(page, name, kind, configuration = {}) {
  const started = Date.now();
  const result = await page.evaluate(async ({ kind, configuration, zero }) => {
    const app = globalThis.HLLive;
    const must = (condition, message) => {
      if (!condition) throw Object.assign(new Error(message), { category: "schema_mismatch" });
    };
    const decimal = value => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value);
    const signal = AbortSignal.timeout(25_000);
    const getJson = async (url, init = {}, expectedStatus = 200) => {
      const response = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store", ...init, signal });
      if (response.status !== expectedStatus) {
        throw Object.assign(new Error(`HTTP ${response.status}: ${url}`), { category: response.status === 429 || response.status >= 500 ? "external_unavailable" : "schema_mismatch" });
      }
      return response.json();
    };
    const rpc = async (endpoint, method, params) => {
      const response = await getJson(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      must(response.jsonrpc === "2.0" && response.id === 1 && !response.error, `JSON-RPC response error: ${JSON.stringify(response.error)}`);
      must(typeof response.result === "string" && /^0x[0-9a-f]*$/i.test(response.result), "JSON-RPC result must be hex.");
      return response.result;
    };
    const call = async (endpoint, address, abi, functionName, args = []) => app.decodeFunctionResult({ abi, functionName,
      data: await rpc(endpoint, "eth_call", [{ to: address, data: app.encodeFunctionData({ abi, functionName, args }) }, "latest"]) });
    try {
      const data = configuration.environment ? new app.HyperliquidData(configuration.environment) : null;
      let summary;
      if (kind === "markets") {
        const response = await data.markets(signal);
        must(response.complete && response.markets.length > 10, "Default perpetual universe must be populated.");
        must(response.markets.every((market, index) => market.asset === index && app.isDefaultPerpCoin(market.name)), "Asset indices must retain default-perps metadata ordering.");
        const eth = response.markets.find(market => market.name === "ETH");
        const btc = response.markets.find(market => market.name === "BTC");
        must(eth && btc && !eth.isDelisted && !btc.isDelisted && Number(eth.context.markPx) > 0, "ETH and BTC must be active default perpetual markets.");
        summary = { universe: response.markets.length, active: response.markets.filter(market => !market.isDelisted).length, collateralToken: response.collateralToken, ethAsset: eth.asset, ethMarkPrice: eth.context.markPx };
      } else if (kind === "book") {
        const response = await data.book("ETH", signal);
        must(response.complete && response.levels.every(levels => levels.length > 0), "ETH book must contain bids and asks.");
        must(Date.now() - response.time < 120_000, "ETH book timestamp is stale.");
        must(Number(response.levels[0][0].px) <= Number(response.levels[1][0].px), "ETH book is crossed.");
        for (let side = 0; side < 2; side++) {
          must(response.levels[side].every((level, index, levels) => index === 0 || (side === 0 ? Number(levels[index - 1].px) >= Number(level.px) : Number(levels[index - 1].px) <= Number(level.px))), "Book levels must be ordered from best price.");
        }
        summary = { coin: response.coin, time: response.time, depths: response.levels.map(levels => levels.length), bestBid: response.levels[0][0].px, bestAsk: response.levels[1][0].px };
      } else if (kind === "candles") {
        const end = Date.now(), response = await data.candles("ETH", "15m", end - 86_400_000, end, signal);
        must(response.complete && response.candles.length >= 80, "One day of ETH 15m candles must include substantial history.");
        must(end - response.candles.at(-1).t < 3_600_000, "Latest candle is stale.");
        must(response.candles.every(candle => Number(candle.h) >= Math.max(Number(candle.o), Number(candle.c)) && Number(candle.l) <= Math.min(Number(candle.o), Number(candle.c)) && Number(candle.v) >= 0), "Candle OHLCV relationships are invalid.");
        summary = { count: response.candles.length, first: response.candles[0].t, last: response.candles.at(-1).t, possiblyTruncated: response.possiblyTruncated };
      } else if (kind === "account") {
        const response = await data.account(zero, signal);
        must(response.complete, `Public account adapter returned incomplete reads: ${JSON.stringify(response.errors)}`);
        must(Array.isArray(response.positions) && Array.isArray(response.openOrders) && response.fees && response.clearinghouseState, "Public account must retain complete empty-or-populated state.");
        must(decimal(response.fees.userCrossRate) && decimal(response.fees.userAddRate), "Account fees must be decimal rates.");
        summary = { abstraction: response.abstraction, balanceSource: response.balanceSource, positions: response.positions.length, openOrders: response.openOrders.length, observations: response.observations.map(value => value.source), warnings: response.warnings };
      } else if (kind === "accountExtras") {
        const [active, fills, status] = await Promise.all([data.activeAsset(zero, "ETH", signal), data.fills(zero, undefined, signal), data.orderStatus(zero, 0, signal)]);
        must(active.complete && fills.complete && active.coin === "ETH" && active.availableToTrade.length === 2, "Active asset and fill adapters must return structured state.");
        must(status.status === "unknownOid", "Unknown public order must remain unknown rather than being treated as filled.");
        summary = { activeAsset: active.coin, leverage: active.leverage, fills: fills.fills.length, orderStatus: status.status };
      } else if (kind === "funding") {
        const end = Date.now(), response = await data.funding("ETH", end - 86_400_000, end, signal);
        must(response.complete && response.funding.length >= 12, "ETH funding history must contain recent observations.");
        summary = { count: response.funding.length, latest: response.funding.at(-1), possiblyTruncated: response.possiblyTruncated };
      } else if (kind === "websocket") {
        summary = await new Promise((resolve, reject) => {
          const socket = new WebSocket(app.API_URLS[configuration.environment].ws);
          const timer = setTimeout(() => finish(Object.assign(new Error("WebSocket ETH book timeout."), { category: "external_unavailable" })), 25_000);
          let finished = false;
          function finish(error, value) { if (finished) return; finished = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value); }
          socket.onopen = () => socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: "ETH" } }));
          socket.onerror = () => finish(Object.assign(new Error("WebSocket connection failed."), { category: "external_unavailable" }));
          socket.onclose = event => { if (!finished) finish(Object.assign(new Error(`WebSocket closed before data (${event.code}).`), { category: "external_unavailable" })); };
          socket.onmessage = event => {
            try {
              const message = JSON.parse(event.data);
              if (message.channel !== "l2Book") return;
              const book = app.parseBook(message.data, "ETH");
              must(book.levels.every(levels => levels.length > 0), "WebSocket book must contain both sides.");
              must(Date.now() - book.time < 120_000, "WebSocket book is stale.");
              socket.send(JSON.stringify({ method: "unsubscribe", subscription: { type: "l2Book", coin: "ETH" } }));
              finish(null, { channel: message.channel, coin: book.coin, time: book.time, depths: book.levels.map(levels => levels.length) });
            } catch (error) { finish(error); }
          };
        });
      } else if (kind === "circleFees") {
        const endpoint = `${app.CCTP.circleApi}/v2/burn/USDC/fees/${configuration.domain}/19?forward=true&hyperCoreDeposit=true`;
        const response = await getJson(endpoint);
        const fast = app.depositFees(response, 100_000_000n, "fast"), standard = app.depositFees(response, 100_000_000n, "standard");
        must(BigInt(fast.maxFeeAtoms) < 100_000_000n && BigInt(standard.maxFeeAtoms) < 100_000_000n, "Quoted route must support the read-only 100 USDC example.");
        summary = { sourceDomain: configuration.domain, destinationDomain: 19, exampleAmountAtoms: "100000000", fast, standard };
      } else if (kind === "circleMessages") {
        const endpoint = `${app.CCTP.circleApi}/v2/messages/${configuration.domain}?transactionHash=0x${"0".repeat(64)}`;
        const response = await fetch(endpoint, { mode: "cors", credentials: "omit", cache: "no-store", signal });
        const body = await response.json();
        const message = body.error ?? body.message;
        must((response.status === 200 && Array.isArray(body.messages) && body.messages.length === 0) || (response.status === 404 && typeof message === "string" && /not found|no messages/i.test(message)), `Unknown CCTP source transaction must have a structured empty/not-found response: HTTP ${response.status} ${JSON.stringify(body)}`);
        summary = { sourceDomain: configuration.domain, status: response.status, body };
      } else if (kind === "hyperEvm") {
        const endpoint = app.CCTP.hyperEvmRpc, address = app.CCTP.coreDepositWallet, abi = app.CORE_DEPOSIT_ABI;
        const [chain, code, ethereum, arbitrum, activation, perpsEnabled, disabled] = await Promise.all([
          rpc(endpoint, "eth_chainId", []), rpc(endpoint, "eth_getCode", [address, "latest"]),
          call(endpoint, address, abi, "calculateCrossChainWithdrawalFee", [true, 0]),
          call(endpoint, address, abi, "calculateCrossChainWithdrawalFee", [true, 3]),
          call(endpoint, address, abi, "newCoreAccountFee"),
          call(endpoint, address, abi, "enabledDestinationDexes", [0]),
          call(endpoint, address, abi, "isDexForwardingDisabled"),
        ]);
        must(BigInt(chain) === 999n && code.length > 2, "CoreDepositWallet must be deployed on HyperEVM mainnet.");
        must(perpsEnabled === true && disabled === false, "CCTP forwarding to default perpetuals is not currently enabled.");
        summary = { chainId: "999", address, ethereumFeeAtoms: ethereum.toString(), arbitrumFeeAtoms: arbitrum.toString(), newAccountFeeCoreAtoms: activation.toString(), perpsEnabled, forwardingDisabled: disabled };
      } else if (kind === "sourceContracts") {
        const chain = app.FUNDING_CHAINS[configuration.chainId], abi = app.parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
        const [chainId, tokenCode, messengerCode, transmitterCode, decimals, symbol] = await Promise.all([
          rpc(chain.rpc, "eth_chainId", []), rpc(chain.rpc, "eth_getCode", [chain.usdc, "latest"]),
          rpc(chain.rpc, "eth_getCode", [app.CCTP.tokenMessenger, "latest"]), rpc(chain.rpc, "eth_getCode", [app.CCTP.messageTransmitter, "latest"]),
          call(chain.rpc, chain.usdc, abi, "decimals"), call(chain.rpc, chain.usdc, abi, "symbol"),
        ]);
        must(BigInt(chainId) === BigInt(configuration.chainId), "USDC RPC returned the wrong chain.");
        must(tokenCode.length > 2 && messengerCode.length > 2 && transmitterCode.length > 2, "Native USDC and CCTP v2 contracts must be deployed.");
        must(Number(decimals) === 6 && symbol === "USDC", "Native token must identify as six-decimal USDC.");
        summary = { chainId: configuration.chainId, token: chain.usdc, decimals: Number(decimals), symbol, tokenMessenger: app.CCTP.tokenMessenger, messageTransmitter: app.CCTP.messageTransmitter };
      } else throw new Error(`Unknown read qualification: ${kind}`);
      return { status: "passed", origin: globalThis.origin, summary };
    } catch (error) {
      return { status: "failed", origin: globalThis.origin, category: error.category ?? (((error.name === "TypeError" && /failed to fetch|network/i.test(error.message)) || error.name === "TimeoutError" || error.name === "AbortError" || error.status === 429 || error.status >= 500) ? "external_unavailable" : "schema_mismatch"), error: error.message };
    }
  }, { kind, configuration, zero: evidence.publicAccount });
  evidence.checks.push({ name, durationMs: Date.now() - started, ...result });
  console.log(`${result.status === "passed" ? "PASS" : "FAIL"} ${name}${result.error ? ` [${result.category}] ${result.error}` : ""}`);
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable" });
  evidence.browser = { version: browser.version(), webSecurityDisabled: false };
  const context = await browser.newContext();
  await context.route("**/*", onlyReadRequests);
  const page = await context.newPage();
  await page.goto(url);
  for (const environment of ["mainnet", "testnet"]) {
    for (const kind of ["markets", "book", "candles", "account", "accountExtras", "funding", "websocket"]) {
      await check(page, `${environment} ${kind}`, kind, { environment });
    }
  }
  for (const domain of [0, 3]) {
    await check(page, `Circle deposit fee domain ${domain} to 19`, "circleFees", { domain });
    await check(page, `Circle messages domain ${domain}`, "circleMessages", { domain });
  }
  await check(page, "HyperEVM withdrawal fees and perpetual forwarding", "hyperEvm");
  for (const chainId of ["1", "42161"]) await check(page, `Native USDC and CCTP v2 contracts chain ${chainId}`, "sourceContracts", { chainId });

  // Neutron also supports sandboxed ephemeral tiles. Confirm the browser adapter
  // can read from an opaque-origin iframe, without disabling browser security.
  await page.evaluate(() => { const frame = document.createElement("iframe"); frame.sandbox = "allow-scripts"; frame.srcdoc = "<!doctype html><title>Opaque origin</title>"; document.body.append(frame); });
  await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow !== null);
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  await frame.waitForLoadState();
  await frame.addScriptTag({ content: javascript });
  await check(frame, "Opaque-origin mainnet adapter", "markets", { environment: "mainnet" });
} catch (error) {
  evidence.harnessError = { message: error.message, stack: error.stack };
  console.error(error);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  evidence.finishedAt = new Date().toISOString();
  evidence.summary = {
    passed: evidence.checks.filter(check => check.status === "passed").length,
    externalUnavailable: evidence.checks.filter(check => check.category === "external_unavailable").length,
    schemaMismatch: evidence.checks.filter(check => check.category === "schema_mismatch").length,
    rejectedRequests: evidence.rejectedRequests.length,
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Live evidence: ${evidencePath}`);
  console.log(JSON.stringify(evidence.summary));
  if (evidence.harnessError || evidence.rejectedRequests.length || evidence.checks.some(check => check.status !== "passed")) process.exitCode = 1;
}
