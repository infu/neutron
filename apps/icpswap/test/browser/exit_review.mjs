/** Actual LiquidityView -> action handlers -> provider -> native ReviewHost.
 * Backend writes are held local fixtures. Every nonlocal request is blocked;
 * this test never contacts a ledger or dispatches a real protocol action. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = process.env.ICPSWAP_EXIT_REVIEW_ARTIFACTS || "/tmp/neutron-icpswap-report-7/browser/exit-review";
await mkdir(out, { recursive: true });
const transport = `
  export {isJsonObject,isMsgBusInstallationUid} from '${root}/packages/neutron-tools/src/protocol.ts';
  globalThis.exitReviewMethods ??= new Map();
  export const exposeTool=(name,definition,handler)=>globalThis.exitReviewMethods.set(name,{definition,handler});
  export const callTool=(...args)=>window.exitState.uiCall(...args);
  export const querySelf=(...args)=>window.exitState.kernel.querySelf(...args);
  export const updateSelf=(...args)=>window.exitState.kernel.updateSelf(...args);
  export const createMsgBusClient=()=>({callTool,querySelf,updateSelf});
  export const loadNeutronCanisterId=async()=>window.exitState.owner;
  export const publishAppStateChange=async()=>{};
  export const onAppStateChange=()=>()=>{};
`;
const reader = `
  export * from '${root}/apps/icpswap/src/liquidity_reads.ts';
  export const createLiquidityReadClient=()=>window.exitState.reads;
`;
const fixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {LiquidityView} from '${root}/apps/icpswap/src/liquidity.tsx';
  import {ReviewHost} from '${root}/apps/icpswap/src/review.tsx';
  import {createActionHandlers} from '${root}/apps/icpswap/src/action_tools.ts';
  import {authorizeAction} from '${root}/apps/icpswap/src/provider.ts';
  import '${root}/apps/icpswap/src/style.scss';
  const owner='3rurp-vyaaa-aaaay-aacua-cai',pool='mohjv-bqaaa-aaaag-qjyia-cai';
  const icp='ryjl3-tyaaa-aaaaa-aaaba-cai',usdc='xevnm-gaaaa-aaaar-qafnq-cai';
  const token0={address:icp,standard:'ICRC2'},token1={address:usdc,standard:'ICRC2'};
  const state=window.exitState={owner,events:[],calls:[],reviews:[],records:new Map(),holdPrepare:true,
    prepareEntered:false,releasePrepare:null,fee0:'10000',results:[],errors:[],latestInput:null};
  const view={
    pool:{pool,key:'icp-usdc',token0,token1,fee:3000,tickSpacing:60},owner,
    metadata:{sqrtPriceX96:'79228162514264337593543950336',tick:0,liquidity:'999999999'},
    positions:[{id:'5090',tickLower:-60,tickUpper:60,liquidity:'1000000',amount0:'2995',amount1:'2995',tokensOwed0:'50',tokensOwed1:'90',feeError:null}],
    unused:{balance0:'1000000',balance1:'1000000'},reserved:{balance0:'0',balance1:'0'},availableUnused:{balance0:'1000000',balance1:'1000000'},
    cachedFees:{token0Fee:'10000',token1Fee:'10000'},available:true,withdrawals:[],transactions:[],errors:[],
    source:{kind:'direct-canister-query',host:'https://icp-api.io',observedAt:'2026-09-09T01:30:00Z'},
  };
  state.reads={
    discoverPools:async()=>({pools:[structuredClone(view.pool)],errors:[]}),
    discoverOwnedPools:async()=>({pools:[structuredClone(view.pool)],errors:[]}),
    readPool:async(poolId,account,signal)=>{signal?.throwIfAborted();if(poolId!==pool||account!==owner)throw Error('Unexpected pool/account');state.events.push('browser-pool');return structuredClone(view);},
    invalidate:()=>{},
  };
  const resident={appId:'icpswap',installationUid:'42',role:'background',endpoint:'app:icpswap:background'};
  const caller={appId:'icpswap',installationUid:'42',role:'tile',endpoint:'app:icpswap:tile:main:instance:exit-review'};
  state.kernel={
    querySelf:async(method)=>{state.events.push('query:'+method);if(method!=='icpswap_market')throw Error('Unexpected display query');return {status:{},rows:[{address:icp,symbol:'ICP',decimals:8},{address:usdc,symbol:'ckUSDC',decimals:6}]};},
    updateSelf:async(method)=>{state.events.push('update:'+method);throw Error('An exit must not update display metadata');},
    callTool:async(request,options)=>{
      state.calls.push(structuredClone(request));
      if(request.name!=='icpswap_owner_review_v1')throw Error('An exit must not query Wallet balances or fund a deposit');
      if(request.target!==caller.endpoint)throw Error('Review must return to its originating tile');
      state.reviews.push(JSON.parse(request.arguments.reviewJson));state.events.push('review');
      const result=await globalThis.exitReviewMethods.get(request.name).handler(request.arguments,{caller:resident,agentMode:false,signal:options?.signal,kernel:state.kernel,reportProgress(){}});
      state.events.push(result.approved?'approved':'declined');return result;
    },
  };
  const backend={
    account:async()=>{state.events.push('account');return owner;},
    actionGet:async(id)=>{state.events.push('get');return structuredClone(state.records.get(id)?.operation??null);},
    liquidityStatus:async(id)=>structuredClone(state.records.get(id)??null),
    liquidityPrepare:async(request)=>{
      state.events.push('prepare');state.prepareEntered=true;
      if(state.holdPrepare)await new Promise(resolve=>{state.releasePrepare=resolve;});
      const retained=state.records.get(request.id);if(retained)return structuredClone(retained);
      const effective={...request.request,tick_lower:'-60',tick_upper:'60'};
      if(effective.kind==='close')effective.liquidity='1000000';
      const prepared={operation:{id:request.id,input_json:request.input_json,plan_json:'',funding_json:'',result_json:'',state:'prepared',detail:'Fixture preparation confirmed',revision:'0',created_at:'1788917400000000000',updated_at:'1788917400000000000',effects:[]},
        plan:{request:effective,pool,owner,token0,token1,fee:'3000',tick_spacing:'60',tick:'1',sqrt_price_x96:'79232123823359799118286999568',fee0:state.fee0,fee1:'10000',funding0:'0',funding1:'0',price_protection:false,
          expected_amount0:'3100',expected_amount1:'2980',expected_liquidity:effective.liquidity,baseline_positions:[],unused0:'1000000',unused1:'1000000',observed_at:'1788917401000000000',detail:'Independent durable backend observation.'}};
      state.records.set(request.id,prepared);return structuredClone(prepared);
    },
    actionUpdate:async()=>{state.events.push('journal-update');throw Error('No empty funding journal updates are needed for this exit');},
    liquidityExecute:async(request)=>{
      state.events.push('execute');const retained=state.records.get(request.id);
      if(request.expected_revision!==retained.operation.revision)throw Error('Changed revision');
      retained.operation={...retained.operation,state:'settlement_pending',detail:'Fixture protocol call succeeded; payout is unverified.',revision:'1'};
      return structuredClone(retained);
    },
  };
  const handlers=createActionHandlers({backendFor:()=>backend,authorize:authorizeAction,reads:state.reads});
  state.uiCall=async(request)=>{
    if(request.name==='icpswap_history_v1')return {items:[...state.records.values()].map(value=>structuredClone(value.operation)),nextCursor:null};
    if(request.name!=='icpswap_liquidity_v1')throw Error('Unexpected UI call '+request.name);
    state.latestInput=structuredClone(request.arguments);
    const controller=new AbortController();state.controller=controller;
    try{const result=await handlers.liquidity(request.arguments,{caller,kernel:state.kernel,agentMode:false,signal:controller.signal,reportProgress(){}});state.results.push(result);return result;}
    catch(error){state.errors.push(String(error));throw error;}
  };
  createRoot(document.getElementById('root')).render(<main className="nt-app ics-app"><LiquidityView tokens={[{address:icp,symbol:'ICP',decimals:8},{address:usdc,symbol:'ckUSDC',decimals:6}]}/><ReviewHost/></main>);
`;
await build({
  absWorkingDir: root, stdin: { contents: fixture, loader: "tsx", resolveDir: root },
  outfile: join(out, "main.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic", logLevel: "warning",
  plugins: [sassPlugin(), { name: "exit-transports", setup(builder) {
    builder.onResolve({ filter: /^(neutron-tools\/app|\.\/liquidity_reads\.ts|\.\/logos\.ts)$/ }, args => ({ path: args.path, namespace: "exit-transports" }));
    builder.onLoad({ filter: /.*/, namespace: "exit-transports" }, args => ({ contents: args.path === "neutron-tools/app" ? transport : args.path === "./liquidity_reads.ts" ? reader : "export const peekLogo=()=>null;export const onLogoResolved=()=>()=>{};export const resolveLogo=async()=>null;export const markLogoBroken=()=>{};", loader: "js", resolveDir: root }));
  } }],
});
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  res.end(file ? await readFile(join(out, file)) : '<!doctype html><html><head><link rel="stylesheet" href="/main.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser, page;
const checks = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  page = await browser.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith("http://127.0.0.1:") ? route.continue() : route.abort());
  const openRemove = async width => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("article", { name: "Position 5090" }).getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("slider", { name: "Percentage of position to remove" }).fill("25");
    const submit = page.getByRole("button", { name: "Review remove liquidity", exact: true });
    await submit.click();
    await page.getByRole("dialog", { name: "Remove ICPSwap liquidity", exact: true }).waitFor();
  };
  const snapshot = () => page.evaluate(() => ({ events: window.exitState.events, calls: window.exitState.calls, records: window.exitState.records.size, reviews: window.exitState.reviews, prepareEntered: window.exitState.prepareEntered, latestInput: window.exitState.latestInput, results: window.exitState.results, errors: window.exitState.errors }));
  const noWritesOrWallet = value => {
    assert.equal(value.prepareEntered, false, "approval appears before the deliberately blocked backend preparation");
    assert.equal(value.records, 0, "no durable action is saved before approval");
    assert.equal(value.events.some(event => event === "execute" || event === "journal-update" || event.startsWith("update:")), false);
    assert(value.calls.every(call => call.name === "icpswap_owner_review_v1"), "no Wallet read or funding call is made to format an exit");
  };
  for (const width of [320, 360, 480, 960]) {
    await openRemove(width);
    const value = await snapshot();
    noWritesOrWallet(value);
    assert.equal(value.reviews.length, 1);
    assert.equal(value.reviews[0].pair, "ICP / ckUSDC");
    assert.equal(value.reviews[0].liquidityToRemove, "250000");
    assert.equal(value.reviews[0].exactAction.operationId, value.latestInput.operationId);
    assert.equal(value.reviews[0].fees.token0LedgerFee, "0.0001 ICP");
    const geometry = await page.getByRole("dialog").evaluate(node => ({ modal: node.open && node.matches(":modal"), overflow: node.scrollWidth > node.clientWidth, documentOverflow: document.documentElement.scrollWidth > innerWidth, right: node.getBoundingClientRect().right }));
    assert.equal(geometry.modal, true); assert.equal(geometry.overflow, false); assert.equal(geometry.documentOverflow, false); assert(geometry.right <= width);
    await page.screenshot({ path: join(out, `remove-review-${width}.png`) });
    await page.getByRole("button", { name: "Decline", exact: true }).click();
    await page.waitForFunction(() => window.exitState.errors.length === 1);
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const declined = await snapshot();
    noWritesOrWallet(declined);
    assert.match(declined.errors[0], /review declined/);
    assert.match(await page.locator('.ics-editor-error').innerText(), /Use Continue action to check or resume this same attempt/);
    assert.doesNotMatch(await page.locator('.ics-editor-error').innerText(), /Check Activity or continue this exact saved operation/);
    assert.equal(await page.getByRole("slider", { name: "Percentage of position to remove" }).inputValue(), "25");
  }
  checks.push("The actual Remove button opens a formatted native review at 320/360/480/960px before any backend preparation, journal write or Wallet formatting read; decline preserves the selected amount and creates no durable action.");

  // Continue the declined invocation: the editor retains its original request
  // identity even though the owner declined before durable preparation.
  const originalId = (await snapshot()).latestInput.operationId;
  await page.getByRole("button", { name: "Continue action", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal((await snapshot()).latestInput.operationId, originalId);
  await page.getByRole("button", { name: "Approve action", exact: true }).click();
  await page.waitForFunction(() => window.exitState.prepareEntered);
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const held = await snapshot();
  assert.equal(held.records, 0);
  assert.equal(held.events.includes("execute"), false);
  assert(held.events.indexOf("approved") < held.events.indexOf("prepare"));
  await page.evaluate(() => window.exitState.releasePrepare());
  await page.waitForFunction(() => window.exitState.results.length === 1);
  const completed = await snapshot();
  assert.equal(completed.results[0].state, "settlement_pending");
  assert.equal(completed.records, 1);
  assert.equal(completed.events.filter(event => event === "execute").length, 1);
  assert.equal(completed.reviews.length, 2, "unchanged saved terms reuse the accepted preview despite updated output observations");
  assert.equal(completed.events.includes("journal-update"), false);
  assert(completed.calls.every(call => call.name === "icpswap_owner_review_v1"));
  checks.push("Approving the retained request begins the held backend preparation only after owner approval; releasing unchanged terms dispatches the local fixture once without another approval or empty funding writes.");

  await openRemove(360);
  await page.evaluate(() => { window.exitState.fee0 = '20000'; });
  await page.getByRole("button", { name: "Approve action", exact: true }).click();
  await page.waitForFunction(() => window.exitState.prepareEntered);
  await page.evaluate(() => window.exitState.releasePrepare());
  await page.waitForFunction(() => window.exitState.reviews.length === 2);
  await page.getByRole("dialog").waitFor();
  const changed = await snapshot();
  assert.deepEqual(changed.reviews.map(review => review.fees.token0LedgerFee), ["0.0001 ICP", "0.0002 ICP"]);
  assert.equal(changed.events.includes("execute"), false);
  assert.equal(changed.records, 1);
  await page.screenshot({ path: join(out, "remove-changed-fee-review-360.png") });
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page.waitForFunction(() => window.exitState.errors.length === 1);
  assert.equal((await snapshot()).events.includes("execute"), false);
  assert.equal(await page.evaluate(() => [...window.exitState.records.values()][0].operation.state), "prepared");
  checks.push("A changed outgoing fee opens a second real review of the durable terms before dispatch; declining retains the prepared operation and sends no protocol action.");

  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("article", { name: "Position 5090" }).getByRole("button", { name: "Collect fees", exact: true }).click();
  await page.getByRole("heading", { name: "Fees before transfer costs", exact: true }).waitFor();
  assert.match(await page.locator('.ics-liquidity-estimate').innerText(), /ICP and ckUSDC fees are at or below the transfer fee/);
  assert.match(await page.locator('.ics-liquidity-estimate').innerText(), /stay in your pool balance; no Wallet payout is expected/);
  await page.getByRole("button", { name: "Review collect fees", exact: true }).click();
  await page.getByRole("dialog", { name: "Collect ICPSwap fees", exact: true }).waitFor();
  const claim = await snapshot();
  noWritesOrWallet(claim);
  assert.deepEqual(claim.reviews[0].estimatedWalletAmountsNet, ["0 ICP", "0 ckUSDC"]);
  assert.equal(claim.reviews[0].notes.filter(note => note.includes('no Wallet payout or transfer fee debit is expected')).length, 2);
  await page.screenshot({ path: join(out, "claim-retained-pool-credit-360.png") });
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await page.waitForFunction(() => window.exitState.errors.length === 1);
  noWritesOrWallet(await snapshot());
  checks.push("A claim below both transfer fees explicitly shows retained pool credit and zero estimated Wallet payouts in the editor and approval; declining creates no durable action.");

  assert.deepEqual(errors, []);
  await writeFile(join(out, "results.json"), JSON.stringify({ checks, errors, viewports: [320, 360, 480, 960] }, null, 2));
  console.log(`Exit approval browser checks passed; artifacts: ${out}`);
} catch (error) {
  await writeFile(join(out, "failure.json"), JSON.stringify({ error: String(error), checks, errors, state: await page?.evaluate(() => ({ events: window.exitState?.events, errors: window.exitState?.errors })) }, null, 2));
  await page?.screenshot({ path: join(out, "failure.png") });
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
