/** Local-only UI regression. All protocol/Wallet calls are fixtures; any
 * external network request is blocked and no canister is contacted. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = process.env.MARKETPLACE_BROWSER_ARTIFACTS || "/tmp/neutron-marketplace-ui/browser";
await mkdir(output, { recursive: true });
const transport = `export const exposeTool=(name,options,handler)=>window.marketplaceTools.set(name,{options,handler}); export const removeExposedTool=name=>window.marketplaceTools.delete(name); export const connectEthereumProvider=()=>{throw Error('Unexpected browser wallet connection in IC checkout regression')};`;
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '${root}/apps/marketplace/src/app.tsx';
import '${root}/apps/marketplace/src/style.scss';
window.marketplaceTools=new Map();
const principal='3rurp-vyaaa-aaaay-aacua-cai';
const scenario=new URL(location.href).searchParams;
const state=window.marketplaceFixture={initializations:0,connections:0,paidReadFailed:false,calls:[],owned:['notes','garden'],installed:[],purchased:[],restored:false,installationQuotes:[]};
const entries=[
 ['notes','Quiet Notes','A little space for your biggest ideas.','0'],
 ['garden','Garden','A clearer view of your day.','0'],
 ['studio','Canvas Studio','Create and collect what inspires you.','0'],
 ['atlas','Atlas','Find the connections in your research.','10000000'],
 ['focus','Focus','A considered space for your best work.','1999999'],
 ['folio','Folio','Your portfolio, beautifully in view.','5000000'],
];
const listing=([id,title,summary,priceUsdMicros])=>({id,title,summary,priceUsdMicros,category:'Productivity',publisher:principal,version:'3',rating:id==='studio'?null:4.8,ratingCount:id==='studio'?0:42,owned:state.owned.includes(id)});
const money=atoms=>({atoms,decimals:6,symbol:'ckUSDC'});
const cycles={total:'1100000',processing:'1100000',schedule:'fixed-v1'};
const quote=(args)=>{
 const dependency=args.appIds.includes('studio');
 return {operationId:dependency?'22222222222222222222222222222222':'0123456789abcdef0123456789abcdef',commitment:dependency?'free-root-paid-dependency':'exact-reviewed-quote',appIds:args.appIds,items:entries.filter(x=>args.appIds.includes(x[0])||(dependency&&x[0]==='folio')).map(listing),token:args.token,subtotalUsdMicros:dependency?'5000000':'10000000',discountUsdMicros:dependency?'0':args.affiliateCode?'1000000':'0',payment:money(dependency?'5000000':args.affiliateCode?'9000000':'10000000'),approvalFee:money('10000'),collectionFee:money('10000'),totalDebit:money(dependency?'5020000':args.affiliateCode?'9020000':'10020000'),allocations:dependency?[{kind:'developer',principal,amount:money('1500000')},{kind:'burn',principal:null,amount:money('3500000')}]:[{kind:'developer',principal,amount:money('2700000')},{kind:'affiliate',principal:'aaaaa-aa',amount:money('2700000')},{kind:'burn',principal:null,amount:money('3600000')}],cycles,affiliateCode:args.affiliateCode,warnings:[],opaque:{immutable:true}};
};
const session={configured:true,canisterId:'aaaaa-aa',host:'https://icp-api.io',account:principal,connected:true};
const client={
 initialize:async()=>{state.initializations++;if(scenario.get('setup')==='fatal'&&state.initializations===1)throw Error('Neutron is temporarily unavailable.');if(scenario.get('setup')==='delegate')return {...session,connected:false,connectionError:'Read access could not be prepared.'};return session;},configure:async x=>({...session,...x}),connect:async()=>{state.connections++;return session;},
 catalog:async input=>{state.calls.push(['catalog',input]);if(scenario.get('catalog')==='paid-error'&&input.tier==='paid'&&!state.paidReadFailed){state.paidReadFailed=true;throw Error('Paid charts are temporarily unavailable.');}const matches=entries.filter(x=>(input.tier==='free'?x[3]==='0':x[3]!=='0')&&x[1].toLowerCase().includes(input.search.toLowerCase()));const paged=scenario.get('catalog')==='paged';return {items:(paged?(input.cursor?matches.slice(1):matches.slice(0,1)):matches).map(listing),nextCursor:paged&&!input.cursor&&matches.length>1?input.tier+'-next':null,asOf:'2026-09-10T00:00:00Z'}},
 detail:async id=>({...listing(entries.find(x=>x[0]===id)),description:'Your ideas deserve a place of their own. Work in a calm, focused space, with everything you need at your fingertips.',screenshots:[],audit:{auditor:principal,verdict:'approved',analysis:'The submitted package was checked for malware. No malicious behavior was found in this review.',date:'2026-09-10T00:00:00Z',packageHash:'a'.repeat(64)},ownRating:null}),
 library:async()=>({items:entries.filter(x=>state.owned.includes(x[0])).map(x=>({...listing(x),acquiredAt:'2026-09-10',installedVersion:state.installed.includes(x[0])?'1':null,available:true})),nextCursor:null}),
 publisherApps:async()=>({items:[],nextCursor:null}),
 quotePublication:async()=>{throw Error('Unexpected publication')},publish:async()=>{throw Error('Unexpected publication')},
 quotePurchase:async args=>{state.calls.push(['quotePurchase',args]);return quote(args)},
 purchase:async q=>{state.calls.push(['purchase',q]);state.purchased.push(q.operationId);return {operationId:q.operationId,state:'pending',message:'The payment is being confirmed. Your request is saved.',nextAction:'resume',appIds:q.appIds}},
 operation:async id=>{state.calls.push(['operation',id]);return {operationId:id,state:'pending',message:'Waiting for the original payment.',nextAction:'resume'}},
 resumeOperation:async id=>{state.calls.push(['resumeOperation',id]);return {operationId:id,state:'complete',message:'Your app is ready.',nextAction:'none'}},
 recentOperations:async()=>state.restored?[{operationId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',state:'pending',message:'Saved withdrawal awaits confirmation.',nextAction:'resume'}]:[],
 quoteInstallation:async(ids,operationId)=>{const quote={operationId:operationId??(state.installationQuotes.length+1).toString(16).padStart(32,'0'),appIds:[...ids],canisterId:session.canisterId,owner:principal,cycles,fee:{feeVersion:'1',processingCycles:cycles.processing,storageCycles:'0',totalCycles:cycles.total,processingBytes:'1024',newStorageBytes:'0'}};state.installationQuotes.push(quote);return quote;},
 install:async(ids,quote)=>{if(!state.installationQuotes.includes(quote)||JSON.stringify(ids)!==JSON.stringify(quote.appIds))throw Error('Install must retain the exact reviewed quote and app selection.');state.calls.push(['install',ids]);return {message:'Install review opened.'}},
 rate:async (...args)=>{state.calls.push(['rate',...args])},
 earnings:async()=>({referralCode:'QUIET-CODE',affiliateDiscountBps:1000,affiliateShareBps:3000,balances:[{token:'ckUSDC',available:money('4500000'),reserved:money('250000'),earned:null}]}),
 createReferralCode:async()=> 'QUIET-CODE',
 quoteWithdrawal:async args=>{state.calls.push(['quoteWithdrawal',args]);return {operationId:'withdraw-same-id',token:args.token,destination:args.destination,debit:money(args.amountAtoms),fee:money('10000'),receive:money((BigInt(args.amountAtoms)-10000n).toString()),cycles,warnings:[],opaque:{}}},
 withdraw:async q=>{state.calls.push(['withdraw',q]);return {operationId:q.operationId,state:'complete',message:'Withdrawal confirmed.',nextAction:'none'}},
};
state.review=quote({appIds:['atlas'],token:'ckUSDC',affiliateCode:'QUIET-CODE'});
state.revisedReview={...state.review,approvalFee:money('20000'),collectionFee:money('20000'),totalDebit:money('9040000')};
createRoot(document.getElementById('root')).render(<App client={client}/>);
`;
await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic", outfile: join(output, "fixture.js"), plugins: [
  { name: "local-only-transport", setup(build) {
    build.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "transport", namespace: "fixture" }));
    build.onResolve({ filter: /tile_client\.ts$/ }, () => ({ path: "tile-client", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "transport" ? transport : "export const createMarketplaceClient=()=>{throw Error('Use local fixture client')}", loader: "js" }));
  } }, sassPlugin(),
] });
const html = '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;background:#06080b}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
const server = createServer(async (req, res) => {
  try { if (req.url === "/fixture.js" || req.url === "/fixture.css") { res.setHeader("content-type", req.url.endsWith("css") ? "text/css" : "text/javascript"); res.end(await readFile(join(output, req.url.slice(1)))); } else { res.setHeader("content-type", "text/html"); res.end(html); } }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser, page; const errors = [], checks = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 960, height: 760 } });
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith(url) ? route.continue() : route.abort());
  await page.goto(url);
  await page.getByRole("button", { name: /Quiet Notes/ }).waitFor();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.initializations), 1);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.connections), 0);
  assert.equal(await page.getByRole("button", { name: /^(Connect|Connected|Connect this Neutron)$/ }).count(), 0);
  assert.deepEqual(await page.locator('.mp-catalog-section > h3').allTextContents(), ['Top paid', 'Top free']);
  assert.equal(await page.locator('.mp-rank').count(), 0);
  assert.equal(await page.getByRole("button", { name: /Top (paid|free)/ }).count(), 0);
  checks.push("Marketplace initializes automatically for this Neutron, without a Connect action; paid then free charts are visible together with no rank numbers.");
  for (const width of [320, 380, 480, 960]) {
    await page.setViewportSize({ width, height: 760 });
    const bounds = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.querySelector('.mp-body').scrollWidth, client: document.querySelector('.mp-body').clientWidth, firstCard: document.querySelector('.mp-app-card').getBoundingClientRect().top }));
    assert.ok(bounds.document <= width, `Document overflows at ${width}: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.body <= bounds.client + 1, `Content overflows at ${width}`);
    assert.ok(bounds.firstCard < 320, `First app needs scrolling at ${width}`);
    await page.screenshot({ path: join(output, `explore-${width}.png`) });
  }
  checks.push("Explore is compact and has no horizontal overflow at 320, 380, 480 and 960px.");
  await page.setViewportSize({ width: 380, height: 760 });
  await page.getByRole("combobox", { name: "Ranking period" }).selectOption("month");
  await page.getByRole("button", { name: "$1.999999", exact: true }).waitFor();
  assert.ok(await page.evaluate(() => ['paid','free'].every(tier=>window.marketplaceFixture.calls.some(x=>x[0]==='catalog' && x[1].tier===tier && x[1].window==='month'))));
  checks.push("Ranking controls request the selected rolling window; exact micro-dollar list prices are not truncated.");
  await page.getByRole("button", { name: /Atlas Productivity/ }).click();
  const appDetail = page.getByRole("dialog", { name: "Atlas", exact: true });
  await appDetail.getByText("Audited by AI", { exact: true }).waitFor();
  await appDetail.locator('.mp-audit > summary').click();
  assert.match(await appDetail.locator('.mp-audit').innerText(), /3rurp-vyaaa-aaaay-aacua-cai/);
  assert.match(await appDetail.locator('.mp-audit').innerText(), /submitted package was checked for malware/);
  await appDetail.getByRole("button", { name: "Close dialog", exact: true }).click();
  checks.push("App details display Audited by AI while retaining the auditor principal and exact review analysis.");
  await page.getByRole("button", { name: "$10.00", exact: true }).click();
  const checkout = page.getByRole("dialog", { name: "Review purchase", exact: true });
  await checkout.getByLabel(/Affiliate code/).fill("QUIET-CODE");
  await checkout.getByRole("button", { name: "Review costs", exact: true }).click();
  await checkout.getByRole("heading", { name: "Where your payment goes" }).waitFor();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.purchased.length), 0);
  assert.match(await checkout.innerText(), /9.02 ckUSDC/);
  assert.match(await checkout.innerText(), /3.6 ckUSDC/);
  assert.match(await checkout.innerText(), /3rurp-vyaaa-aaaay-aacua-cai/);
  await page.screenshot({ path: join(output, "checkout-380.png") });
  await checkout.getByRole("button", { name: "Buy · 9 ckUSDC", exact: true }).click();
  await page.getByRole("button", { name: "Check status", exact: true }).waitFor();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.purchased), ["0123456789abcdef0123456789abcdef"]);
  checks.push("Checkout shows exact discounted allocations, principals, fees and total before payment; status refresh makes no second purchase.");
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  await page.getByLabel("Select available", { exact: true }).check();
  await page.getByRole("button", { name: "Install selected", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.calls.find(x=>x[0]==='install')[1]), ["notes", "garden"]);
  checks.push("My Apps installs exactly the selected owned apps together.");
  await page.evaluate(() => { window.marketplaceFixture.installed=['garden']; window.marketplaceFixture.restored=true; });
  await page.getByRole("button", { name: "Refresh marketplace", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Select Garden"]')?.disabled === true);
  assert.match(await page.locator('.mp-library-list').innerText(), /Update to 3 in Settings/);
  await page.getByLabel("Select available", { exact: true }).check();
  await page.getByRole("button", { name: "Install selected", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.calls.filter(x=>x[0]==='install').at(-1)[1]), ["notes"]);
  await page.getByRole("button", { name: "View saved progress", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Your app is ready.", { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => window.marketplaceFixture.calls.some(x=>x[0]==='resumeOperation'&&x[1]==='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')));
  checks.push("Already installed apps are excluded from install selection, updates point to Settings, and restored requests resume their original identity.");

  await page.getByRole("button", { name: "Earnings", exact: true }).click();
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  const withdraw = page.getByRole("dialog", { name: "Withdraw ckUSDC", exact: true });
  await withdraw.getByRole("button", { name: "Max", exact: true }).click();
  await withdraw.getByLabel("Receiving principal", { exact: true }).fill("aaaaa-aa");
  await withdraw.getByRole("button", { name: "Review withdrawal", exact: true }).click();
  assert.match(await withdraw.innerText(), /4.49 ckUSDC/);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.calls.filter(x=>x[0]==='withdraw').length), 0);
  await withdraw.getByRole("button", { name: "Confirm withdrawal", exact: true }).click();
  await page.getByText("Withdrawal confirmed.", { exact: true }).waitFor();
  checks.push("Max withdrawal uses available credits, shows the deducted fee and requires explicit confirmation.");
  await page.evaluate(() => { window.agentReviewResult=null; void window.marketplaceTools.get('marketplace_review_v1').handler({reviewJson:JSON.stringify({kind:'purchase',quote:window.marketplaceFixture.review})},{agentMode:false,audience:'foreground_tile'}).then(x=>window.agentReviewResult=x); });
  const agent = page.getByRole("dialog", { name: "Agent purchase request", exact: true });
  await agent.getByRole("heading", { name: "Where your payment goes" }).waitFor();
  await agent.getByRole("button", { name: "Decline", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.agentReviewResult), { approved: false });
  const rejected = await page.evaluate(async () => { try { await window.marketplaceTools.get('marketplace_review_v1').handler({reviewJson:JSON.stringify({kind:'purchase',quote:window.marketplaceFixture.review})},{agentMode:true,audience:'foreground_tile'}); return false; } catch { return true; } });
  assert.equal(rejected, true);
  checks.push("Normal agent review displays the same exact purchase split, can be declined, and does not accept the root-agent UI route.");

  const beforeOwnerReview = await page.evaluate(() => window.marketplaceFixture.purchased.length);
  await page.evaluate(() => {
    window.ownerReviewResult=null;
    void window.marketplaceTools.get('marketplace_owner_review_v1').handler(
      {reviewJson:JSON.stringify({kind:'purchase',quote:window.marketplaceFixture.revisedReview})},
      {agentMode:false,caller:{appId:'marketplace',role:'background',endpoint:'app:marketplace:background'}},
    ).then(result=>window.ownerReviewResult=result);
  });
  const revised = page.getByRole("dialog", { name: "Review updated purchase costs", exact: true });
  await revised.getByRole("heading", { name: "Where your payment goes" }).waitFor();
  assert.match(await revised.innerText(), /9.04 ckUSDC/);
  assert.match(await revised.innerText(), /3rurp-vyaaa-aaaay-aacua-cai/);
  assert.equal(await page.evaluate(() => window.ownerReviewResult), null);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.purchased.length), beforeOwnerReview);
  await revised.getByRole("button", { name: "Approve purchase", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.ownerReviewResult), { approved: true });
  assert.equal(await page.evaluate(() => window.marketplaceFixture.purchased.length), beforeOwnerReview, "review host grants consent without dispatching the purchase");
  const forgedOwners = await page.evaluate(async () => {
    const good={appId:'marketplace',role:'background',endpoint:'app:marketplace:background'};
    const contexts=[
      {agentMode:false,audience:'foreground_tile'},
      {agentMode:false,caller:{...good,appId:'other-app'}},
      {agentMode:false,caller:{...good,role:'tile'}},
      {agentMode:false,caller:{...good,endpoint:'app:other-app:background'}},
      {agentMode:true,caller:good},
    ];
    return Promise.all(contexts.map(async context=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(new Error('Unauthenticated review was left open')),500);
      try { await window.marketplaceTools.get('marketplace_owner_review_v1').handler({reviewJson:JSON.stringify({kind:'purchase',quote:window.marketplaceFixture.revisedReview})},{...context,signal:controller.signal}); return false; }
      catch (error) { return /requires its authenticated resident/.test(String(error)); }
      finally { clearTimeout(timer); }
    }));
  });
  assert.deepEqual(forgedOwners, [true, true, true, true, true]);
  assert.equal(await page.getByRole("dialog").count(), 0);
  checks.push("Updated-cost owner review accepts only the authenticated marketplace background caller outside agent mode, displays revised exact fees, and performs no payment; forged callers and agent-mode use are rejected.");

  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const studio = page.locator('.mp-app-card').filter({ has: page.getByRole("button", { name: /Canvas Studio/ }) });
  await studio.getByRole("button", { name: "Free", exact: true }).click();
  const freeRoot = page.getByRole("dialog", { name: "Add to My Apps", exact: true });
  await freeRoot.getByRole("button", { name: "Review costs", exact: true }).click();
  const dependencyCheckout = page.getByRole("dialog", { name: "Review purchase", exact: true });
  await dependencyCheckout.getByRole("button", { name: "Buy · 5 ckUSDC", exact: true }).waitFor();
  const dependencyItems = dependencyCheckout.locator('.mp-checkout-item');
  assert.equal(await dependencyItems.count(), 2);
  assert.match(await dependencyItems.filter({ hasText: 'Canvas Studio' }).innerText(), /Free/);
  assert.match(await dependencyItems.filter({ hasText: 'Folio' }).innerText(), /Required app/);
  assert.match(await dependencyItems.filter({ hasText: 'Folio' }).innerText(), /\$5\.00/);
  assert.match(await dependencyCheckout.locator('.mp-total-facts').innerText(), /5.02 ckUSDC/);
  assert.equal(await dependencyCheckout.getByRole("button", { name: "Add to My Apps", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.purchased.length), beforeOwnerReview, "a free root cannot silently acquire its paid dependency during quoting");
  await page.screenshot({ path: join(output, "free-root-paid-dependency-380.png") });
  await dependencyCheckout.getByRole("button", { name: "Buy · 5 ckUSDC", exact: true }).click();
  await page.waitForFunction(() => window.marketplaceFixture.purchased.includes('22222222222222222222222222222222'));
  const dependencyPurchase = await page.evaluate(() => window.marketplaceFixture.calls.filter(call=>call[0]==='purchase').at(-1)[1]);
  assert.deepEqual(dependencyPurchase.appIds, ['studio']);
  assert.deepEqual(dependencyPurchase.items.map(item=>item.id), ['studio', 'folio']);
  assert.equal(dependencyPurchase.payment.atoms, '5000000');
  assert.equal(await page.evaluate(() => window.marketplaceFixture.purchased.length), beforeOwnerReview + 1);
  checks.push("A free Canvas Studio root with paid Folio dependency shows both quoted apps, labels the required app, changes to paid checkout, and waits for explicit 5 ckUSDC purchase confirmation.");
  await page.goto(`${url}/?catalog=paged`);
  await page.getByRole("button", { name: "Show more paid apps", exact: true }).click();
  await page.getByRole("button", { name: /Focus Productivity/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Show more paid apps", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Show more free apps", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /Garden Productivity/ }).count(), 0);
  await page.getByRole("button", { name: "Show more free apps", exact: true }).click();
  await page.getByRole("button", { name: /Garden Productivity/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.calls.filter(call=>call[0]==='catalog'&&call[1].cursor).map(call=>[call[1].tier,call[1].cursor])), [['paid','paid-next'],['free','free-next']]);
  await page.getByRole("searchbox", { name: "Search apps", exact: true }).fill("Atlas");
  await page.getByText("No matching free apps.", { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => ['paid','free'].every(tier=>window.marketplaceFixture.calls.some(call=>call[0]==='catalog'&&call[1].tier===tier&&call[1].search==='Atlas'))));
  checks.push("Paid and free charts page independently, and a shared search applies to both lists without carrying pagination into the new search.");

  await page.goto(`${url}/?catalog=paid-error`);
  await page.getByText("Paid charts are temporarily unavailable.", { exact: true }).waitFor();
  await page.getByRole("button", { name: /Quiet Notes/ }).waitFor();
  await page.getByRole("region", { name: "Top paid", exact: true }).getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("button", { name: /Atlas Productivity/ }).waitFor();
  checks.push("One chart's read error does not block the other chart, and its retry recovers in place.");

  await page.goto(`${url}/?setup=delegate`);
  await page.getByText("Read access could not be prepared.", { exact: true }).waitFor();
  await page.getByRole("button", { name: /Atlas Productivity/ }).waitFor();
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  await page.getByRole("heading", { name: "Your library is unavailable", exact: true }).waitFor();
  assert.equal(await page.getByText("Opening marketplace…", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Retry setup", exact: true }).click();
  await page.getByLabel("Select Quiet Notes", { exact: true }).waitFor();
  assert.equal(await page.getByText("Read access could not be prepared.", { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.connections), 1);
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.purchased), []);
  checks.push("A recoverable setup error preserves public browsing, clearly explains the unavailable library, and Retry setup restores it without a purchase.");

  await page.goto(`${url}/?setup=fatal`);
  await page.getByText("Neutron is temporarily unavailable.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Opening marketplace…", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Retry setup", exact: true }).click();
  await page.getByRole("button", { name: /Atlas Productivity/ }).waitFor();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.initializations), 2);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.connections), 0);
  checks.push("A failed initial Neutron request stops loading and offers a working initialization retry.");
  assert.deepEqual(errors, []);
  await writeFile(join(output, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Marketplace UI checks passed. Artifacts: ${output}`);
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") });
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
