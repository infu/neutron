/** Full production tile and real parsing/math/review components. Transport
 * responses and value-moving tool endpoints are deterministic local fixtures;
 * every nonlocal browser request is intercepted and no real asset is touched. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = process.env.ICPSWAP_APP_ARTIFACTS || "/tmp/neutron-icpswap-integration/ui";
await mkdir(out, { recursive: true });
const ids = ["ryjl3-tyaaa-aaaaa-aaaba-cai", "ss2fx-dyaaa-aaaar-qacoq-cai", "xevnm-gaaaa-aaaar-qafnq-cai", "mxzaz-hqaaa-aaaar-qaada-cai"];
const names = ["Internet Computer", "Chain-key Ethereum", "Chain-key USD Coin", "Chain-key Bitcoin"];
const symbols = ["ICP", "ckETH", "ckUSDC", "ckBTC"];
const prices = [2.42, 2485, 1, 78340];
const rows = ids.map((address, i) => ({ address, symbol: symbols[i], name: names[i], standard: "ICRC2", decimals: i === 2 ? 6 : i === 1 ? 18 : 8, price_usd: prices[i], price_icp: prices[i] / 2.42, quote: null, pool_count: 12, pinned: i === 0, note: "", added_at: Date.now() / 1000, verified: true, sample_count: 10, sparkline: [2, 3, 2.5, 4] }));
const tokens = rows.map((row, i) => ({ tokenLedgerId: row.address, tokenSymbol: row.symbol, tokenName: row.name, price: row.price_usd, priceChange24H: i === 1 ? -1.24 : 2.1, volumeUSD24H: 430000 / (i + 1), volumeUSD7D: 1300000, tvlUSD: 900000, marketCap: 300000000, priceLow24H: row.price_usd * .98, priceHigh24H: row.price_usd * 1.04, priceLow7D: row.price_usd * .96, priceHigh7D: row.price_usd * 1.08, priceLow30D: row.price_usd * .9, priceHigh30D: row.price_usd * 1.12, tvlUSDChange24H: 1.2, txCount24H: 100, totalVolumeUSD: 12000000 }));
const status = { last_refresh_at: Date.now() / 1000, last_refresh_error: null, cache_ready: true, icp_price_usd: 2.42, universe_tokens: 1200, universe_pools: 855, priced_tokens: 4, watchlist_size: 4 };
const candles = Array.from({ length: 30 }, (_, i) => {
  const v = 2.3 + Math.sin(i * .42) * .08 + i * .004;
  return { beginTime: (1788825600 - (30 - i) * 86400) * 1000, open: v, close: v + (i % 3 === 0 ? -.025 : .019), high: v + .045, low: v - .035, volumeUSD: 20000 + Math.sin(i) * 7000, tvlUSD: 900000 };
});
const fixture = `
  import {Principal} from '@icp-sdk/core/principal';
  import {getSqrtRatioAtTick} from '${root}/apps/icpswap/src/liquidity_math.ts';
  import {createDirectFundingRequest} from '${root}/apps/icpswap/src/funding.ts';
  import {createActionBackend} from '${root}/apps/icpswap/src/action_backend.ts';
  export {isJsonObject, isMsgBusInstallationUid} from '${root}/packages/neutron-tools/src/protocol.ts';
  const rows=${JSON.stringify(rows)}, status=${JSON.stringify(status)}, owner='3rurp-vyaaa-aaaay-aacua-cai';
  const pool='aaaaa-aa', retainedPool='2vxsx-fae', index='rrkah-fqaaa-aaaaa-aaaaq-cai';
  const t0={address:rows[0].address,standard:'ICRC2'}, t1={address:rows[2].address,standard:'ICRC2'};
  const listeners=new Set(), methods=new Map();
  const initialInput={kind:'claim',pool:retainedPool,positionId:'90',operationId:'f'.repeat(32)};
  const initial={plan_json:'',funding_json:'',result_json:'',revision:'0',id:initialInput.operationId,input_json:JSON.stringify({version:1,owner:{appId:'icpswap',rootMode:false},input:initialInput}),state:'uncertain',detail:'Saved payout requires a fresh pool observation.',created_at:'1788880800000000000',updated_at:'1788880800000000000',effects:[]};
  const recoverySourceId='d'.repeat(32), fundingRequestId='1'.repeat(32);
  const directRequest=createDirectFundingRequest({requestId:fundingRequestId,ledger:t1.address,pool:retainedPool,owner,amountAtoms:'1000000',feeAtoms:'10000',nowMs:1788880000000});
  const recoverySourcePlan={request:{pool:retainedPool,kind:'mint',position_id:null,tick_lower:'-39000',tick_upper:'-37800',amount0:'0',amount1:'1000000',liquidity:'0',withdraw_token:'',withdraw_amount:'0'},pool:retainedPool,owner,token0:t0,token1:{...t1,standard:'ICRC1'},fee:'3000',tick_spacing:'60',tick:'-37200',sqrt_price_x96:getSqrtRatioAtTick(-37200).toString(),fee0:'10000',fee1:'10000',funding0:'0',funding1:'1000000',expected_amount0:'0',expected_amount1:'1000000',expected_liquidity:'10000000',unused0:'0',unused1:'0',baseline_positions:[],observed_at:'1788880000000000000',price_protection:false,detail:'Direct token-1 funding only.'};
  const recoverySource={...initial,id:recoverySourceId,input_json:JSON.stringify({version:1,kind:'liquidity',owner:{appId:'agent',installationUid:'77',rootMode:true},input:{operationId:recoverySourceId,kind:'mint',pool:retainedPool,amount0:'0',amount1:'1000000',tickLower:-39000,tickUpper:-37800}}),plan_json:JSON.stringify(recoverySourcePlan),funding_json:JSON.stringify([directRequest]),result_json:JSON.stringify({kind:'wallet_funding_v1',results:[{requestId:fundingRequestId,result:{status:'transferred',commandId:'agent:'+fundingRequestId,blockIndex:'9007199254740993',duplicate:false,message:null}}]}),state:'funding_requested',detail:'Confirmed token-1 transfer awaits pool credit.'};
  const effect=(key,method,state)=>({key,canister:retainedPool,method,state,error:'',dispatched_at:'1788880900000000000',completed_at:state==='succeeded'?'1788880900000000001':null,result_nat:null,result_amount0:null,result_amount1:null});
  const summary=({plan_json,funding_json,result_json,...value})=>({...value,effects:value.effects.map(({result_nat,result_amount0,result_amount1,...item})=>item)});
  let durable=JSON.parse(localStorage.getItem('icpswap.browser.fixture')||'null')||{history:[initial,recoverySource],positionLiquidity:'1000000000',fees:true,unused0:'100000000',unused1:'1000000',newPosition:false};
  const state=window.__app={calls:[],queries:[],walletMissing:false,walletInfoActive:false,walletInfoOverlap:0,methods,durable};
  const persist=()=>{localStorage.setItem('icpswap.browser.fixture',JSON.stringify(durable));for(const fn of listeners)fn();};
  const record=(operationId,input,approved)=>({plan_json:'',funding_json:'',result_json:'',revision:'0',id:operationId,input_json:JSON.stringify({version:1,owner:{appId:'icpswap',rootMode:false},input}),state:approved?'complete':'stopped',detail:approved?'Fixture action completed and payout observed.':'Owner declined this prepared action.',created_at:'1788880900000000000',updated_at:'1788880900000000000',effects:[effect(input.kind||'swap',input.kind||'swap',approved?'succeeded':'not_requested')]});
  const progress=(operation)=>({operationId:operation.id,state:operation.state,message:operation.detail,operation});
  export const exposeTool=(name,definition,handler)=>methods.set(name,{definition,handler});
  export const onAppStateChange=(_,callback)=>{listeners.add(callback);return()=>listeners.delete(callback);};
  export const onTileViewRequest=()=>()=>{};
  export const loadNeutronCanisterId=async()=>owner;
  export const copyToClipboard=async(value)=>{state.clipboard=value;};
  export async function callTool(request){
    state.calls.push(structuredClone(request));
    const args=request.arguments||{}, name=request.name;
    if(name==='wallet_token_info_v1'){
      // A Wallet read can need owner consent. The real Kernel permits one
      // active owner request; overlapping pair reads must not race its dialog.
      if(state.walletInfoActive){state.walletInfoOverlap++;throw Error('Another app request is active');}
      state.walletInfoActive=true;
      try{
        await new Promise(resolve=>setTimeout(resolve,40));
        if(state.walletMissing)throw Error('Fixture Wallet metadata unavailable');
        const row=rows.find(row=>row.address===args.ledger); if(!row)throw Error('Unknown fixture ledger');
        return {ledger:row.address,account:owner,name:row.name,symbol:row.symbol,decimals:row.decimals,feeAtoms:'10000',balanceAtoms:(13n*10n**BigInt(row.decimals)).toString(),observedAtNs:'1788880800000000000'};
      }finally{state.walletInfoActive=false;}
    }
    if(name==='icpswap_history_v1'){const page=await createActionBackend({querySelf,updateSelf}).actionPage({cursor:args.cursor??null,limit:args.limit??20});state.lastHistory=structuredClone(page.items);return page;}
    if(name==='icpswap_reconcile_v1'){
      const operation=durable.history.find(row=>row.id===args.operationId);if(!operation)throw Error('Unknown saved operation');
      state.queries.push({canister:JSON.parse(operation.input_json).input.pool||pool,method:'fixture-status-fresh-pool-observation'});
      if(operation.id===recoverySourceId)return {...progress(structuredClone(operation)),plan:recoverySourcePlan,pool:{unused0:'0',unused1:'500000',queue:[],transactions:[],protocol_diagnostics:''}};
      operation.state='complete';operation.detail='Reconciled against a fresh fixture pool observation.';persist();return {...progress(operation),plan:{},pool:{unused0:'0',unused1:'500000',queue:[],transactions:[],protocol_diagnostics:''}};
    }
    if(name==='icpswap_recover_deposit_v1'){
      if(args.sourceOperationId!==recoverySourceId||args.tokenIndex!==1||args.operationId===recoverySourceId)throw Error('Recovery changed source identity or canonical token leg');
      let operation=durable.history.find(row=>row.id===args.operationId);
      if(!operation){operation={...initial,id:args.operationId,input_json:JSON.stringify({version:1,kind:'recover_deposit',owner:{appId:'icpswap',installationUid:'42',rootMode:false},input:{sourceOperationId:args.sourceOperationId,tokenIndex:args.tokenIndex}}),state:'prepared',detail:'Existing transfer prepared for pool credit.'};durable.history.push(operation);persist();}
      const decision=await methods.get('icpswap_owner_review_v1').handler({reviewJson:JSON.stringify({title:'Recover an ICPSwap pool deposit',sourceOperationId:args.sourceOperationId,token:'ckUSDC',amountAlreadyTransferred:'1.01 ckUSDC',depositFee:'0.01 ckUSDC',expectedPoolCredit:'1 ckUSDC',notes:['No new Wallet funding is requested.'],exactAction:args})},{caller:{appId:'icpswap',installationUid:'42',role:'background',endpoint:'app:icpswap:background'},agentMode:false,signal:new AbortController().signal});
      if(!decision.approved)throw Error('Owner declined recovery');
      operation.state='complete';operation.detail='Existing transfer credited to unused pool funds.';operation.revision='1';operation.effects=[effect('recover_deposit','deposit','succeeded')];
      const source=durable.history.find(row=>row.id===recoverySourceId);source.effects=[effect('deposit1','deposit','succeeded')];source.revision='1';source.detail='Token-1 direct deposit recovered into unused pool funds.';persist();
      return {...progress(structuredClone(operation)),plan:{source_id:recoverySourceId,token_index:'1',pool:retainedPool},fundingInstructions:[]};
    }
    if(['icpswap_liquidity_v1','icpswap_swap_v1','icpswap_continue_v1'].includes(name)){
      const existing=durable.history.find(row=>row.id===args.operationId);
      const input=name==='icpswap_continue_v1'?JSON.parse(existing.input_json).input:structuredClone(args);
      const decision=await methods.get('icpswap_owner_review_v1').handler({reviewJson:JSON.stringify({title:name==='icpswap_swap_v1'?'Review swap':'Review '+input.kind,...input})},{caller:{appId:'icpswap',installationUid:'42',role:'background',endpoint:'app:icpswap:background'},agentMode:false,signal:new AbortController().signal});
      const operation=record(args.operationId,input,decision.approved);
      if(existing)Object.assign(existing,operation);else durable.history.push(operation);
      if(decision.approved){if(input.kind==='decrease')durable.positionLiquidity=(BigInt(durable.positionLiquidity)-BigInt(input.liquidity)).toString();if(input.kind==='claim')durable.fees=false;if(input.kind==='withdraw')durable[input.token===t0.address?'unused0':'unused1']='0';if(input.kind==='mint')durable.newPosition=true;}
      persist();return {...progress(operation),plan:{},pool:{unused0:'0',unused1:'500000',queue:[],transactions:[],protocol_diagnostics:''}};
    }
    throw Error('Unexpected fixture tool '+name);
  }
  export async function querySelf(name,args){
    if(name==='icpswap_action_page'){
      const all=[...durable.history].reverse().map(summary), {cursor,limit}=args[0];
      const start=cursor==null?0:all.findIndex(item=>item.id===cursor)+1, items=all.slice(start,start+Number(limit));
      // The Kernel omits absent optional record fields, including the final
      // cursor and completion timestamps of pending protocol effects.
      const projected=items.map(item=>({...item,effects:item.effects.map(({completed_at,...effect})=>completed_at==null?effect:{...effect,completed_at})}));
      return start+items.length<all.length?{items:projected,next_cursor:items.at(-1).id}:{items:projected};
    }
    if(name==='icpswap_market')return {rows,status};
    if(name==='icpswap_token')return {row:rows.find(row=>row.address===args[0]),profile:null,pools:[],pool_count:0,history:[],status};
    if(name==='icpswap_swap_journal')return {entries:[],slippage:500,total:0,completed:0};
    if(name==='icpswap_search')return {items:rows,total:rows.length,universe:rows.length,offset:0,cache_age_seconds:0};
    throw Error('Unexpected fixture query '+name);
  }
  export async function updateSelf(name,args){
    if(name==='icpswap_set_token_info')return true;
    if(name==='icpswap_set_slippage')return args[0];
    if(name==='icpswap_refresh')return {refreshed:true,status,errors:[]};
    if(['icpswap_add','icpswap_remove','icpswap_set_pinned','icpswap_set_note'].includes(name))return {ok:true,message:'Saved',watchlist_size:rows.length};
    if(name==='icpswap_swap_quote'){
      const r=args[0],first=rows.find(row=>row.address===r.input_address),second=rows.find(row=>row.address===r.output_address);
      const result=BigInt(Math.floor(Number(r.amount_in)/10**first.decimals*first.price_usd/second.price_usd*10**second.decimals));
      return {pool,pool_key:'ICP/ckUSDC',fee_tier:3000,...r,decimals_in:first.decimals,decimals_out:second.decimals,zero_for_one:true,quoted_out:result.toString(),amount_out_minimum:(result*995n/1000n).toString(),expected_out:(result-10000n).toString(),token_in_fee:'10000',token_out_fee:'10000',funding_amount:(BigInt(r.amount_in)+10000n).toString(),total_debit:(BigInt(r.amount_in)+20000n).toString(),price_impact:0.0003,warn:false,funding_ledger:first.address,funding_spender:pool,at:1788880800};
    }
    throw Error('Unexpected fixture update '+name);
  }
  export const createMsgBusClient=()=>({callTool,querySelf,updateSelf});
  state.queryPool=async({canister,method,args,signal})=>{
    signal.throwIfAborted();state.queries.push({canister,method,args:args.map(arg=>typeof arg==='bigint'?arg.toString():arg?.toText?.()||arg)});
    if(method==='getPools')return {ok:[pool,retainedPool].map(id=>({key:id,token0:t0,token1:t1,fee:3000n,tickSpacing:60n,canisterId:Principal.fromText(id)}))};
    if(method==='getInitArgs')return {ok:{positionIndexCid:Principal.fromText(index)}};
    if(method==='getUserPools')return {ok:[pool]};
    if(method==='metadata')return {ok:{key:canister,token0:t0,token1:t1,fee:3000n,sqrtPriceX96:getSqrtRatioAtTick(-37200),tick:-37200n,liquidity:1000000000000n}};
    if(method==='getCachedTokenFee')return {token0Fee:10000n,token1Fee:10000n};
    if(method==='getAvailabilityState')return {available:true,whiteList:[]};
    const position={id:7n,tickLower:-37800n,tickUpper:-36600n,liquidity:BigInt(durable.positionLiquidity),tokensOwed0:durable.fees?12345n:0n,tokensOwed1:durable.fees?23456n:0n};
    if(method==='getUserPositionsByPrincipal'&&state.incompleteOwnership)throw Error('Fixture ownership query unavailable');
    if(method==='getUserPositionsByPrincipal')return {ok:canister===pool?[position,...(durable.newPosition?[{...position,id:8n,liquidity:100000000n}]:[])]:[]};
    if(method==='getUserPosition')return {ok:position};
    if(method==='getUserUnusedBalance'&&state.incompleteOwnership)return {ok:{balance0:0n,balance1:0n}};
    if(method==='getUserUnusedBalance')return {ok:{balance0:canister===pool?BigInt(durable.unused0):0n,balance1:canister===pool?BigInt(durable.unused1):state.failedWithdrawal?0n:500000n}};
    if(method==='getWithdrawQueueInfo')return {ok:{items:[],isProcessing:false,queueSize:0n}};
    if(method==='getTransactionsByOwner'){const failed=state.failedWithdrawal&&canister===retainedPool, reserved=state.reserveWithdrawal&&canister===pool; return {ok:failed||reserved?[[71n,{id:71n,owner:Principal.fromText(owner),timestamp:1788880800000000000n,action:{Withdraw:{status:failed?{Failed:null}:{Created:null},err:failed?['Fixture ledger transfer failed']:[],transfer:{token:Principal.fromText(t0.address),amount:20000000n,fee:10000n}}}}]]:[]};}
    throw Error('Unexpected direct protocol query '+method);
  };
`;
const wrapper = `import {createLiquidityReadClient as realClient} from '${root}/apps/icpswap/src/liquidity_reads.ts'; export const createLiquidityReadClient=()=>realClient({query:(request)=>window.__app.queryPool(request)});`;
const output = await build({
  absWorkingDir: root, entryPoints: ["apps/icpswap/src/index.tsx"], bundle: true, write: false, format: "iife", jsx: "automatic", outdir: out,
  plugins: [{ name: "local-transports", setup(builder) {
    builder.onResolve({ filter: /^(neutron-tools\/app|\.\/liquidity_reads\.ts|\.\/logos\.ts)$/ }, args => ({ path: args.path, namespace: "local-transports" }));
    builder.onLoad({ filter: /.*/, namespace: "local-transports" }, args => ({ contents: args.path === "neutron-tools/app" ? fixture : args.path === "./liquidity_reads.ts" ? wrapper : "export const peekLogo=()=>null;export const onLogoResolved=()=>()=>{};export const resolveLogo=async()=>null;export const markLogoBroken=()=>{};", loader: "js", resolveDir: root }));
  } }, sassPlugin()], logLevel: "warning",
});
const assets = { "/main.js": output.outputFiles.find(file => file.path.endsWith(".js")).text, "/main.css": output.outputFiles.find(file => file.path.endsWith(".css")).text, "/static/icon.svg": await readFile(join(root, "apps/icpswap/public/static/icon.svg")) };
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url.endsWith(".css") ? "text/css" : req.url.endsWith(".svg") ? "image/svg+xml" : req.url.endsWith(".js") ? "text/javascript" : "text/html");
  res.end(assets[req.url] ?? '<!doctype html><html><head><link rel="stylesheet" href="/main.css"><style>body{margin:0}#root{height:100dvh}</style></head><body><div id="root"></div><script src="/main.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const checks = [], errors = [];
let positionHistoryAvailable = true;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:")) return route.continue();
    if (url.startsWith("https://api.icpswap.com/info/")) {
      const parsed = new URL(url), path = parsed.pathname;
      let data = path === "/info/token/all" ? tokens : path === "/info/token/chart/list" ? [] : path.includes("/chart/") ? { content: candles, totalElements: candles.length } : path.includes("/transaction/") ? { content: [], totalElements: 0 } : [];
      if (path === "/info/transaction/find" || path === "/info/record/transferPosition/list") {
        const pool = parsed.searchParams.get("poolId") || parsed.searchParams.get("poolIds");
        const history = positionHistoryAvailable && path === "/info/transaction/find" && pool === "aaaaa-aa" ? [{
          poolId: pool, positionId: 7, txHash: "fixture-original-position-7", txTime: 1788880000000,
          fromPrincipalId: "3rurp-vyaaa-aaaay-aacua-cai", fromSubaccount: "0".repeat(64),
          token0LedgerId: ids[0], token1LedgerId: ids[2], actionType: "AddLiquidity", liquidity: "1000000000",
          token0AmountIn: "1", token1AmountIn: "4", token0AmountOut: "0", token1AmountOut: "0",
          token0Price: "2.3", token1Price: "1",
        }] : [];
        data = { content: history, totalElements: history.length, page: 1, limit: 100 };
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 200, data }), headers: { "Access-Control-Allow-Origin": "*" } });
    }
    return route.abort();
  });
  const navigate = name => page.getByRole("navigation", { name: "ICPSwap views" }).getByRole("button", { name, exact: true }).click();
  const noOverflow = async (name, selector = ".ics-body") => {
    const geometry = await page.locator(selector).evaluate(node => ({ page: document.documentElement.scrollWidth > innerWidth, content: node.scrollWidth > node.clientWidth, box: node.getBoundingClientRect().toJSON() }));
    assert.equal(geometry.page, false, `${name}: page overflow`);
    assert.equal(geometry.content, false, `${name}: component overflow ${JSON.stringify(geometry)}`);
  };
  const showPositions = async () => { await navigate("Liquidity"); await page.getByText("Position #7", { exact: true }).waitFor(); };
  const lastAction = async () => page.evaluate(() => [...window.__app.calls].reverse().find(call => ["icpswap_liquidity_v1", "icpswap_swap_v1"].includes(call.name)));
  const approve = async (yes = true) => { await page.getByRole("dialog").waitFor(); await page.getByRole("button", { name: yes ? "Approve action" : "Decline", exact: true }).click(); await page.waitForFunction(() => !document.querySelector("dialog")); };
  for (const width of [320, 360, 480, 960, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("heading", { name: "via ICPSwap", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "ICPSwap views" }).getByRole("button").count(), 5);
    assert.equal(await page.locator(".ics-tab").evaluateAll(nodes => nodes.every(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length === 1; })), true, `Navigation labels stay on one line at ${width}px`);
    await page.getByRole("button", { name: "Show balance", exact: true }).click();
    await page.getByRole("slider", { name: "Percentage of spendable balance" }).waitFor();
    await page.locator(".ics-swap-leg-foot").getByRole("button", { name: "Max", exact: true }).click();
    assert.equal(await page.getByLabel("You pay", { exact: true }).inputValue(), "12.9998");
    await noOverflow(`swap-${width}`, ".ics-swap");
    await page.screenshot({ path: join(out, `swap-${width}.png`) });
    await navigate("Markets");
    await noOverflow(`markets-${width}`);
    await page.screenshot({ path: join(out, `markets-${width}.png`) });
    await page.locator(width < 700 ? ".ics-market-card" : ".ics-table tbody tr").first().click();
    await page.locator(".ics-chart-canvas").first().waitFor();
    assert((await page.locator(".ics-chart-canvas").first().boundingBox()).y < 450, `chart above initial fold ${width}`);
    await noOverflow(`detail-${width}`);
    await page.screenshot({ path: join(out, `detail-${width}.png`) });
    await showPositions();
    assert.equal(await page.getByText("Pool data incomplete", { exact: true }).count(), 0, "healthy transport fixture has complete pool data");
    assert.equal(await page.getByText("Some liquidity data is unavailable", { exact: true }).count(), 0, "omitted history cursor must not break saved pool discovery");
    const card = page.getByRole("article", { name: "Position 7", exact: true });
    await card.getByText("Est. before fees", { exact: true }).waitFor();
    assert.equal(await card.locator(".ics-position-value > strong").innerText(), "$9.19", "principal value excludes separately displayed uncollected fees");
    assert.deepEqual(await card.locator(".ics-position-token-name > span:last-child").allTextContents(), ["ICP", "ckUSDC"]);
    assert.deepEqual(await card.locator(".ics-position-token-value > strong").allTextContents(), ["1.898231", "4.601022"]);
    assert.deepEqual(await card.locator(".ics-position-token-value > strong").evaluateAll(nodes => nodes.map(node => node.title)), ["1.89823109 ICP", "4.601022 ckUSDC"], "full precision holdings remain available");
    assert.equal(await card.getByRole("region", { name: "Uncollected fees", exact: true }).count(), 1);
    assert.equal(await card.locator(".ics-position-fees > header > strong").innerText(), "$0.02");
    assert.deepEqual(await card.locator(".ics-position-fee-tokens > span").evaluateAll(nodes => nodes.map(node => node.title)), ["0.00012345 ICP", "0.023456 ckUSDC"]);
    assert.equal(await card.locator(".ics-position-pnl > strong").innerText(), "+$2.92", "return includes current holdings plus uncollected fees less the $6.30 historical contribution");
    assert.match(await card.locator(".ics-position-range-view").innerText(), /Price range\nNow /);
    assert.equal(await card.locator(".ics-position-range-bounds > span").count(), 2);
    await noOverflow(`liquidity-${width}`);
    await page.screenshot({ path: join(out, `liquidity-${width}.png`) });
    if (width === 320) {
      for (const label of ["About position value", "About position profit and loss", "About uncollected fees"]) {
        const control = card.getByLabel(label, { exact: true });
        await control.click();
        const disclosure = control.locator("..").locator("p");
        const box = await disclosure.boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width, `${label} fits the narrow tile`);
        await noOverflow(label);
        if (label === "About position profit and loss") {
          assert.match(await disclosure.innerText(), /\$6\.30 added; \$0\.00 withdrawn/);
          assert.match(await disclosure.innerText(), /before ledger and network fees/);
          await page.screenshot({ path: join(out, "position-pnl-info-320.png") });
        }
        await control.click();
      }
    }
    await navigate("Activity");
    await page.locator(".ics-action-card").first().waitFor();
    await noOverflow(`activity-${width}`);
    await page.screenshot({ path: join(out, `activity-${width}.png`) });
  }
  checks.push("All four views and token detail fit 320/360/480/960/1200px tiles; charts remain above the initial fold; Wallet balance and exact fee-adjusted Max work.");
  checks.push("Activity and Liquidity decode backend history with omitted optional cursors and completion timestamps through the real action backend.");
  checks.push("Position cards show exact token holdings, principal value excluding uncollected fees, current fee amounts, price range and history-backed estimated P&L at every tile width; information controls fit 320px.");

  await page.setViewportSize({ width: 320, height: 900 });
  positionHistoryAvailable = false;
  await showPositions();
  const unpricedHistory = page.getByRole("article", { name: "Position 7", exact: true });
  await unpricedHistory.getByText("Unavailable", { exact: true }).waitFor();
  assert.equal(await unpricedHistory.locator(".ics-position-pnl > strong").innerText(), "—", "missing acquisition history must not display zero or stale profit");
  assert.equal(await unpricedHistory.locator(".ics-position-value > strong").innerText(), "$9.19", "missing history does not hide known holdings");
  await unpricedHistory.getByLabel("About position profit and loss", { exact: true }).click();
  assert.match(await unpricedHistory.locator(".ics-position-pnl details p").innerText(), /Original liquidity addition is missing/);
  await noOverflow("unavailable P&L disclosure");
  await page.screenshot({ path: join(out, "position-pnl-unavailable-320.png") });
  positionHistoryAvailable = true;
  await page.getByRole("button", { name: "Refresh liquidity", exact: true }).click();
  await unpricedHistory.getByText("Est. before fees", { exact: true }).waitFor();
  assert.equal(await unpricedHistory.locator(".ics-position-pnl > strong").innerText(), "+$2.92", "a fresh complete history recovers the estimate");
  checks.push("Missing original liquidity history displays unavailable P&L with its reason while preserving current holdings; a fresh complete history restores the estimate.");

  await page.setViewportSize({ width: 360, height: 900 });
  await navigate("Swap");
  await page.getByLabel("Token to pay").selectOption(ids[0]);
  await page.getByLabel("You receive", { exact: true }).selectOption(ids[2]);
  await page.getByLabel("You pay", { exact: true }).fill("1");
  await page.getByRole("button", { name: /Review swap|^Swap$/ }).last().click();
  await approve(false);
  let action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", from_ledger_id: ids[0], to_ledger_id: ids[2], amount: "100000000", slippage: 500 });
  assert.match(await page.locator(".ics-swap").innerText(), /declined/);
  checks.push("Swap uses the real quote parser and saved action client; exact atomic input reaches the tool and owner decline returns a stopped result.");

  await showPositions();
  await page.getByRole("button", { name: "+ Position", exact: true }).click();
  await page.locator(".ics-pool-option").first().click();
  await page.waitForFunction(() => !document.querySelector('.ics-liquidity-editor')?.textContent.includes('Reading pool'));
  assert.equal(await page.evaluate(() => window.__app.walletInfoOverlap), 0, "opening a pool must not overlap Wallet owner requests");
  assert.equal(await page.getByText(/Wallet token details unavailable/).count(), 0);
  await page.getByRole("button", { name: "±5%", exact: true }).click();
  await page.locator("#ics-liquidity-amount-0").fill("1");
  await page.locator("#ics-liquidity-amount-1").fill("2");
  await noOverflow("mint-editor", ".ics-liquidity-editor");
  await page.screenshot({ path: join(out, "mint-360.png") });
  await page.getByRole("button", { name: "Review new position", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "mint", pool: "aaaaa-aa", tickLower: -37740, tickUpper: -36660, amount0: "100000000", amount1: "2000000" });
  await page.getByRole("button", { name: "Back to positions", exact: true }).click();
  await page.getByText("Position #8", { exact: true }).waitFor();
  checks.push("Opening a pool serializes both Wallet token reads across consent; mint range presets use actual price/tick/liquidity math, exact atomic maxima reach the action, and a refreshed position appears after approval.");

  const position = page.locator(".ics-position-card").filter({ has: page.getByText("Position #7", { exact: true }) });
  await position.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("#ics-liquidity-amount-0").fill("0.1");
  await page.locator("#ics-liquidity-amount-1").fill("0.2");
  await page.getByRole("button", { name: "Review add liquidity", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "increase", pool: "aaaaa-aa", positionId: "7", amount0: "10000000", amount1: "200000" });
  await page.getByRole("button", { name: "Back to positions", exact: true }).click();
  await page.getByText("Position #7", { exact: true }).waitFor();
  const walletReadsBeforeRecovery = await page.evaluate(() => window.__app.calls.filter(call => call.name === "wallet_token_info_v1").length);
  await page.evaluate(() => { window.__app.walletMissing = true; });
  await position.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "50%", exact: true }).click();
  await page.getByRole("button", { name: "Review remove liquidity", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "decrease", pool: "aaaaa-aa", positionId: "7", liquidity: "500000000" });
  await page.getByRole("button", { name: "Back to positions", exact: true }).click();
  await page.getByText("Position #7", { exact: true }).waitFor();
  await position.getByRole("button", { name: "Collect fees", exact: true }).click();
  await page.getByRole("button", { name: "Review collect fees", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "claim", pool: "aaaaa-aa", positionId: "7" });
  await page.getByRole("button", { name: "Back to positions", exact: true }).click();
  await page.getByText("Position #7", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__app.calls.filter(call => call.name === "wallet_token_info_v1").length), walletReadsBeforeRecovery, "decrease and claim need no Wallet reads");
  await page.evaluate(() => { window.__app.walletMissing = false; window.__app.reserveWithdrawal = true; });
  await page.locator(".ics-unused-funds").first().getByRole("button", { name: "Withdraw", exact: true }).first().click();
  await page.getByRole("button", { name: "Max", exact: true }).click();
  assert.equal(await page.locator("#ics-unused-amount").inputValue(), "0.8");
  await page.getByRole("button", { name: "Review withdraw unused funds", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "withdraw", pool: "aaaaa-aa", token: ids[0], amount: "80000000" });
  checks.push("Increase, 50% decrease, fee claim and unused-fund Max withdrawal send exact typed action fields; Max subtracts credit reserved by a pending withdrawal. Decrease and claim remain usable when Wallet metadata fails.");

  await page.reload();
  await navigate("Activity");
  await page.locator(".ics-action-card").first().waitFor();
  assert.equal(await page.locator(".ics-action-card").count(), 8);
  const uncertain = page.locator(".ics-action-card").filter({ hasText: "Saved payout requires a fresh pool observation." });
  await uncertain.getByRole("button", { name: "Check status", exact: true }).click();
  await page.getByText("Reconciled against a fresh fixture pool observation.", { exact: true }).waitFor();
  const statusCall = await page.evaluate(() => [...window.__app.calls].reverse().find(call => call.name === "icpswap_reconcile_v1"));
  assert.deepEqual(statusCall.arguments, { operationId: "f".repeat(32) });
  const recoverySourceCard = page.locator(".ics-action-card").filter({ hasText: "Confirmed token-1 transfer awaits pool credit." });
  const compactSource = await page.evaluate(() => window.__app.lastHistory.find(operation => operation.id === "d".repeat(32)));
  assert.equal("funding_json" in compactSource, false);
  assert.equal("result_json" in compactSource, false);
  assert.equal("plan_json" in compactSource, false);
  assert.equal(await page.getByRole("button", { name: /^Recover deposit/ }).count(), 0, "compact history cannot establish funded-deposit eligibility");
  await recoverySourceCard.getByRole("button", { name: "Check status", exact: true }).click();
  const recoverButton = page.getByRole("button", { name: "Recover deposit · token 1", exact: true });
  await recoverButton.waitFor();
  assert.equal(await page.getByRole("button", { name: "Recover deposit · token 0", exact: true }).count(), 0, "canonical token leg differs from the funding array index");
  const walletCallsBefore = await page.evaluate(() => window.__app.calls.filter(call => call.target === "app:wallet:background").length);
  await recoverButton.click();
  await approve(false);
  await recoverySourceCard.getByRole("alert").filter({ hasText: "Owner declined recovery" }).waitFor();
  const firstRecovery = await page.evaluate(() => [...window.__app.calls].reverse().find(call => call.name === "icpswap_recover_deposit_v1"));
  assert.match(firstRecovery.arguments.operationId, /^[0-9a-f]{32}$/);
  assert.notEqual(firstRecovery.arguments.operationId, "d".repeat(32));
  assert.deepEqual({ ...firstRecovery.arguments, operationId: "new" }, { operationId: "new", sourceOperationId: "d".repeat(32), tokenIndex: 1 });
  await noOverflow("direct-recovery-declined");
  await page.screenshot({ path: join(out, "direct-recovery-declined-360.png") });
  await recoverButton.click();
  await approve(true);
  await page.getByText("Token-1 direct deposit recovered into unused pool funds.", { exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some(button => /^Recover deposit/.test(button.textContent)));
  const recoveryCalls = await page.evaluate(() => window.__app.calls.filter(call => call.name === "icpswap_recover_deposit_v1"));
  assert.equal(recoveryCalls.length, 2);
  assert.deepEqual(recoveryCalls[0].arguments, recoveryCalls[1].arguments, "retry retains the new recovery id, original source id and canonical token leg");
  assert.equal(await page.evaluate(() => window.__app.calls.filter(call => call.target === "app:wallet:background").length), walletCallsBefore, "recovery does not send new Wallet requests");
  assert.equal(await page.getByText("Recover funded deposit", { exact: true }).count(), 1, "retries keep a single saved recovery action");
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(`direct-recovery-complete-${width}`);
    await page.screenshot({ path: join(out, `direct-recovery-complete-${width}.png`) });
  }
  checks.push("Compact history alone cannot offer direct-deposit recovery. Reconciliation reveals a confirmed token-1 transfer with exact Wallet namespace/account proof; decline and retry preserve one NEW recovery id and canonical tokenIndex 1 despite a one-element funding array, without Wallet calls. Credited source markers remove the recovery button.");
  await page.evaluate(() => { window.__app.failedWithdrawal = true; });
  await showPositions();
  await page.getByText("Withdraw #71 · Failed: Fixture ledger transfer failed", { exact: true }).waitFor();
  assert.match(await page.locator(".ics-protocol-transactions").innerText(), /even when unused balances are zero/);
  assert(await page.evaluate(() => window.__app.queries.some(query => query.canister === "2vxsx-fae" && query.method === "getUserUnusedBalance")), "retained historical pool is queried even though absent from owner index");
  checks.push("Durable fixture activity survives reload, status checks retain the exact operation id, and saved pool references recover unused funds outside the position index; failed payouts remain visible even with zero unused balance.");
  await page.evaluate(() => { window.__app.incompleteOwnership = true; window.__app.failedWithdrawal = false; });
  await page.getByRole("button", { name: "Refresh liquidity", exact: true }).click();
  await page.getByText("Liquidity data is incomplete", { exact: true }).waitFor();
  assert.equal(await page.getByText("No liquidity positions yet", { exact: true }).count(), 0);
  await noOverflow("incomplete-ownership");
  await page.screenshot({ path: join(out, "incomplete-liquidity-360.png") });
  checks.push("Failed ownership queries are reported as incomplete liquidity data instead of an empty account.");
  assert.deepEqual(errors, []);
  await writeFile(join(out, "app-results.json"), JSON.stringify({ checks, viewports: [320, 360, 480, 960, 1200], errors }, null, 2));
  console.log(`App browser checks passed; artifacts: ${out}`);
} catch (error) {
  await writeFile(join(out, "app-failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
