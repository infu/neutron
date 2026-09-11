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
const listingExcerpt = "Find the connections in your research. Explore ideas with agent tools and keep the full context close at hand. ".repeat(3).slice(0, 255);
const listingDescription = "Bring your research together in a workspace built for discovery.\n\nExplore your notes, connect ideas and use agent tools to work with your knowledge.\n\n".repeat(40).slice(0, 5000);
await mkdir(output, { recursive: true });
const transport = `export const exposeTool=(name,options,handler)=>window.marketplaceTools.set(name,{options,handler}); export const removeExposedTool=name=>window.marketplaceTools.delete(name); export const copyToClipboard=text=>{const state=window.marketplaceFixture;state.copies.push({text,active:navigator.userActivation.isActive});return state.copyFailure?Promise.reject(Error('Clipboard temporarily unavailable.')):Promise.resolve();}; export const connectEthereumProvider=()=>{throw Error('Unexpected browser wallet connection in IC checkout regression')};`;
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '${root}/apps/marketplace/src/app.tsx';
import '${root}/apps/marketplace/src/style.scss';
window.marketplaceTools=new Map();
const principal='3rurp-vyaaa-aaaay-aacua-cai';
const scenario=new URL(location.href).searchParams;
const state=window.marketplaceFixture={initializations:0,connections:0,copies:[],copyFailure:false,paidReadFailed:false,calls:[],owned:['notes','garden'],installed:[],purchased:[],restored:false,installationQuotes:[],installations:[],discountCode:localStorage.getItem('discountCode'),discountReads:0,discountSaves:[],operations:JSON.parse(sessionStorage.getItem('canceledCheckoutFixture')||'[]'),cancelPurchase:false,discountRelease:null};
const entries=[
 ['notes','Quiet Notes','A little space for your biggest ideas.','0'],
 ['garden','Garden','A clearer view of your day.','0'],
 ['studio','Canvas Studio','Create and collect what inspires you.','0'],
 ['atlas','Atlas',${JSON.stringify(listingExcerpt)},'10000000'],
 ['focus','Focus','A considered space for your best work.','1999999'],
 ['folio','Folio','Your portfolio, beautifully in view.','5000000'],
];
const listing=([id,title,summary,priceUsdMicros])=>({id,title,summary,priceUsdMicros,category:'Productivity',publisher:principal,publisherId:'aae',publisherName:'AAE',version:'3',rating:id==='studio'?null:4.8,ratingCount:id==='studio'?0:42,owned:state.owned.includes(id),installed:state.installed.includes(id),freeAcquisitions:priceUsdMicros==='0'?'42':'0',paidPurchases:priceUsdMicros==='0'?'0':'1234'});
const money=atoms=>({atoms,decimals:6,symbol:'ckUSDC'});
const cycles={total:'1100000',processing:'1100000',schedule:'fixed-v1'};
const quote=(args)=>{
 const dependency=args.appIds.includes('studio');
 return {operationId:dependency?'22222222222222222222222222222222':'0123456789abcdef0123456789abcdef',commitment:dependency?'free-root-paid-dependency':'exact-reviewed-quote',appIds:args.appIds,items:entries.filter(x=>args.appIds.includes(x[0])||(dependency&&x[0]==='folio')).map(listing),token:args.token,subtotalUsdMicros:dependency?'5000000':'10000000',discountUsdMicros:dependency?'0':args.affiliateCode?'1000000':'0',payment:money(dependency?'5000000':args.affiliateCode?'9000000':'10000000'),approvalFee:money('10000'),collectionFee:money('10000'),totalDebit:money(dependency?'5020000':args.affiliateCode?'9020000':'10020000'),allocations:dependency?[{kind:'developer',principal,amount:money('1500000')},{kind:'burn',principal:null,amount:money('3500000')}]:[{kind:'developer',principal,amount:money('2700000')},{kind:'affiliate',principal:'aaaaa-aa',amount:money('2700000')},{kind:'burn',principal:null,amount:money('3600000')}],cycles,affiliateCode:args.affiliateCode,warnings:[],opaque:{immutable:true}};
};
const session={configured:true,canisterId:'aaaaa-aa',host:'https://icp-api.io',account:principal,connected:true};
const installResult=quote=>({operationId:quote.operationId,appIds:quote.appIds,state:'pending',nextAction:'resume',installation:quote,message:'The package review was opened. This is not an installation receipt. Reopen this saved selection if the review was closed; its prepared download access is retained.'});
const discount=code=>({code,active:!!code,discountBps:code==='OTHER-CODE'?2000:code?1000:0,affiliate:code?'aaaaa-aa':null,error:null});
const client={
 discount:async()=>{state.discountReads++;if(scenario.get('discount')==='delayed')return new Promise(resolve=>state.discountRelease=()=>resolve(discount('QUIET-CODE')));return discount(state.discountCode);},
 setDiscountCode:async input=>{const code=input.trim().toUpperCase();state.discountSaves.push(code);if(code&&code!=='QUIET-CODE'&&code!=='OTHER-CODE')throw Error(code==='SELF-CODE'?'You cannot use your own affiliate code.':'That discount code was not found.');state.discountCode=code||null;if(code)localStorage.setItem('discountCode',code);else localStorage.removeItem('discountCode');return discount(state.discountCode);},
 initialize:async()=>{state.initializations++;if(scenario.get('setup')==='fatal'&&state.initializations===1)throw Error('Neutron is temporarily unavailable.');if(scenario.get('setup')==='delegate')return {...session,connected:false,connectionError:'Read access could not be prepared.'};return session;},configure:async x=>({...session,...x}),connect:async()=>{state.connections++;return session;},
 catalog:async input=>{state.calls.push(['catalog',input]);if(scenario.get('catalog')==='paid-error'&&input.tier==='paid'&&!state.paidReadFailed){state.paidReadFailed=true;throw Error('Paid charts are temporarily unavailable.');}const matches=entries.filter(x=>(input.tier==='free'?x[3]==='0':x[3]!=='0')&&x[1].toLowerCase().includes(input.search.toLowerCase()));const paged=scenario.get('catalog')==='paged';return {items:(paged?(input.cursor?matches.slice(1):matches.slice(0,1)):matches).map(listing),nextCursor:paged&&!input.cursor&&matches.length>1?input.tier+'-next':null,asOf:'2026-09-10T00:00:00Z',warning:'Rankings are refreshing. These results share the displayed snapshot time.'}},
 detail:async id=>({...listing(entries.find(x=>x[0]===id)),description:${JSON.stringify(listingDescription)},screenshots:[],audit:{auditor:principal,verdict:'approved',analysis:'The submitted package was checked for malware. No malicious behavior was found in this review.',date:'2026-09-10T00:00:00Z',packageHash:'a'.repeat(64)},ownRating:null}),
 library:async()=>({items:entries.filter(x=>state.owned.includes(x[0])).map(x=>({...listing(x),acquiredAt:'2026-09-10',installedVersion:state.installed.includes(x[0])?'1':null,available:true})),nextCursor:null}),
 publisherApps:async()=>({items:[],nextCursor:null}),
 ownPublisherProfile:async()=>({id:'aae',name:'AAE',description:'Apps for your Neutron.',principal,rating:4.8,ratingCount:42,totalUsers:'1234',statsComplete:true}),
 publisherProfile:async()=>({id:'aae',name:'AAE',description:'Apps for your Neutron.',principal,rating:4.8,ratingCount:42,totalUsers:'1234',statsComplete:true}),
 publisherCatalog:async()=>({items:entries.map(listing),nextCursor:null}),
 quotePublisherProfile:async()=>{throw Error('Unexpected profile quote')},savePublisherProfile:async()=>{throw Error('Unexpected profile update')},
 quotePublication:async()=>{throw Error('Unexpected publication')},publish:async()=>{throw Error('Unexpected publication')},
 quotePurchase:async input=>{const args={...input,affiliateCode:input.affiliateCode===undefined?(state.discountCode||''):input.affiliateCode};state.calls.push(['quotePurchase',args]);return quote(args)},
 purchase:async q=>{state.calls.push(['purchase',q]);state.purchased.push(q.operationId);if(state.cancelPurchase==='ic')return {operationId:q.operationId,state:'failed',nextAction:'none',checkoutCanceled:true,message:'The Wallet approval was declined. No purchase payment was requested.'};if(state.cancelPurchase)return {operationId:q.operationId,state:'failed',nextAction:'resume',ethereumWallet:'browser',canceledBeforeSubmission:true,message:'The browser wallet declined this transaction before submission.'};return {operationId:q.operationId,state:'pending',message:'The payment is being confirmed. Your request is saved.',nextAction:'resume',appIds:q.appIds}},
 operation:async id=>{state.calls.push(['operation',id]);return state.operations.find(item=>item.operationId===id)??{operationId:id,state:'pending',message:'Waiting for the original payment.',nextAction:'resume'}},
 resumeOperation:async id=>{state.calls.push(['resumeOperation',id]);const result={operationId:id,state:'complete',message:'Your app is ready.',nextAction:'none'};state.operations=[result,...state.operations.filter(item=>item.operationId!==id)];return result;},
 cancelEthereumCheckout:async id=>{state.calls.push(['cancelEthereumCheckout',id]);const canceled={operationId:id,paymentRail:'ethereum',state:'failed',nextAction:'none',checkoutCanceled:true,message:'Checkout canceled.'};state.operations=state.operations.map(item=>item.operationId===id?canceled:item);sessionStorage.setItem('canceledCheckoutFixture',JSON.stringify(state.operations));return canceled;},
 recentOperations:async()=>{state.calls.push(['recentOperations']);return [...state.operations,...state.installations.map(installResult),...(state.restored&&!state.operations.some(item=>item.operationId==='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')?[{operationId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',state:'pending',message:'Saved withdrawal awaits confirmation.',nextAction:'resume'}]:[])];},
 quoteInstallation:async(ids,operationId)=>{const saved=state.installations.find(item=>operationId?item.operationId===operationId:JSON.stringify(item.appIds)===JSON.stringify(ids));const quote=saved??{operationId:operationId??(state.installationQuotes.length+1).toString(16).padStart(32,'0'),appIds:[...ids],canisterId:session.canisterId,owner:principal,cycles,fee:{feeVersion:'1',processingCycles:cycles.processing,storageCycles:'0',totalCycles:cycles.total,processingBytes:'1024',newStorageBytes:'0'}};state.installationQuotes.push(quote);return quote;},
 install:async(ids,quote)=>{if(!state.installationQuotes.includes(quote)||JSON.stringify(ids)!==JSON.stringify(quote.appIds))throw Error('Install must retain the exact reviewed quote and app selection.');state.calls.push(['install',ids,quote.operationId]);let saved=state.installations.find(item=>item.operationId===quote.operationId);if(!saved){saved={...quote,setupUrl:'https://example.invalid/#manifest='+quote.operationId,cycles:{...cycles,total:'0',processing:'0'},fee:{...quote.fee,totalCycles:'0',processingCycles:'0'}};state.installations.push(saved);}return installResult(saved)},
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
  const clickCardPrice = async card => {
    const price = card.locator('.mp-card-price');
    await price.scrollIntoViewIfNeeded();
    const bounds = await price.boundingBox();
    assert.ok(bounds, "card price has visible click coordinates");
    // The native title button's stretched hit area owns this entire region.
    // A real pointer click verifies that price text still opens app details.
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  };
  const appCard = title => page.locator("article.mp-app-card").filter({ has: page.getByRole("button", { name: title, exact: true }) });
  await page.goto(url);
  await page.getByRole("button", { name: /Quiet Notes/ }).waitFor();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.initializations), 1);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.connections), 0);
  assert.equal(await page.getByRole("button", { name: /^(Connect|Connected|Connect this Neutron)$/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Marketplace settings", exact: true }).count(), 0);
  assert.equal(await page.getByRole("dialog", { name: "Marketplace settings", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Marketplace canister", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("IC gateway", { exact: true }).count(), 0);
  assert.deepEqual(await page.locator('.mp-catalog-section > h3').allTextContents(), ['Top paid', 'Top free']);
  assert.equal(await page.locator('.mp-rank').count(), 0);
  assert.equal(await page.getByRole("button", { name: /Top (paid|free)/ }).count(), 0);
  assert.equal(await page.getByText("Rankings are refreshing. These results share the displayed snapshot time.", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("region", { name: "Top paid", exact: true }).getByText("1,234 purchases", { exact: true }).count(), 3);
  assert.equal(await page.getByRole("region", { name: "Top free", exact: true }).getByText("42 added", { exact: true }).count(), 3);
  assert.equal(await page.locator('.mp-app-card').count(), 6);
  assert.equal(await page.locator('article.mp-app-card button.mp-card-open[aria-haspopup="dialog"]').count(), 6);
  assert.equal(await page.locator('.mp-app-card button button, .mp-app-card button a').count(), 0, "app and publisher are separate native controls without nested interaction");
  assert.equal(await page.locator('.mp-app-card button').count(), 12, "each card exposes app details and its publisher independently");
  assert.equal(await appCard('Atlas').locator('.mp-card-summary').innerText(), listingExcerpt);
  checks.push("Marketplace initializes automatically for this Neutron, without a Connect action; paid then free charts are visible together with no rank numbers.");
  for (const width of [320, 380, 480, 960]) {
    await page.setViewportSize({ width, height: 760 });
    const bounds = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.querySelector('.mp-body').scrollWidth, client: document.querySelector('.mp-body').clientWidth, firstCard: document.querySelector('.mp-app-card').getBoundingClientRect().top }));
    assert.ok(bounds.document <= width, `Document overflows at ${width}: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.body <= bounds.client + 1, `Content overflows at ${width}`);
    assert.ok(bounds.firstCard < 320, `First app needs scrolling at ${width}`);
    assert.equal(await page.getByRole("region", { name: "Top paid", exact: true }).getByText("1,234 purchases", { exact: true }).first().isVisible(), true);
    assert.equal(await page.getByRole("region", { name: "Top free", exact: true }).getByText("42 added", { exact: true }).first().isVisible(), true);
    const clippedCounts = await page.locator('.mp-acquisitions').evaluateAll(elements => elements.some(element => element.scrollWidth > element.clientWidth + 1));
    assert.equal(clippedCounts, false, `Acquisition counts must remain readable at ${width}`);
    await page.screenshot({ path: join(output, `explore-${width}.png`) });
  }
  checks.push("Explore is compact at 320, 380, 480 and 960px, with readable paid purchase/free acquisition counts and no ranking-refresh notice or horizontal overflow.");
  await page.setViewportSize({ width: 380, height: 760 });
  await page.getByRole("searchbox", { name: "Search apps", exact: true }).focus();
  const searchFocus = await page.locator('.mp-search input').evaluate(input => {
    const field = getComputedStyle(input), wrapper = getComputedStyle(input.closest('.mp-search'));
    const accent = document.createElement('span'); accent.style.color = wrapper.getPropertyValue('--nt-accent'); document.body.append(accent);
    const accentColor = getComputedStyle(accent).color; accent.remove();
    return { focused: input === document.activeElement, outline: field.outlineStyle, border: field.borderWidth, shadow: field.boxShadow, appearance: field.appearance, wrapperBorder: wrapper.borderColor, accent: accentColor };
  });
  assert.equal(searchFocus.focused, true);
  assert.equal(searchFocus.outline, "none");
  assert.equal(searchFocus.border, "0px");
  assert.equal(searchFocus.shadow, "none");
  assert.equal(searchFocus.appearance, "none");
  assert.equal(searchFocus.wrapperBorder, searchFocus.accent);
  await page.screenshot({ path: join(output, "search-focus-380.png") });
  checks.push("Focused search has one visible accent border around the entire field and no nested input border or focus ring.");
  await page.getByRole("combobox", { name: "Ranking period" }).selectOption("month");
  await page.locator(".mp-card-price").getByText("$1.999999", { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => ['paid','free'].every(tier=>window.marketplaceFixture.calls.some(x=>x[0]==='catalog' && x[1].tier===tier && x[1].window==='month'))));
  checks.push("Ranking controls request the selected rolling window; exact micro-dollar list prices are not truncated.");
  await clickCardPrice(appCard('Atlas'));
  const appDetail = page.getByRole("dialog", { name: "Atlas", exact: true });
  await appDetail.getByText("Audited by AI", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Review purchase", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.calls.filter(call => ['quotePurchase', 'purchase'].includes(call[0])).length), 0, "clicking a price only opens app details");
  assert.equal(await appDetail.locator('.mp-description').first().innerText(), listingDescription);
  assert.equal(await appDetail.locator('.mp-description').first().evaluate(node => getComputedStyle(node).whiteSpace), "pre-wrap");
  const purchases = appDetail.locator('.mp-detail-stats > div').filter({ hasText: 'Purchases · All time' });
  assert.equal(await purchases.locator('strong').innerText(), '1,234');
  await page.setViewportSize({ width: 320, height: 760 });
  assert.equal(await purchases.isVisible(), true);
  assert.equal(await appDetail.locator('.mp-detail-stats').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, "paid detail counts must fit a narrow tile");
  await page.setViewportSize({ width: 380, height: 760 });
  await appDetail.locator('.mp-audit > summary').click();
  assert.match(await appDetail.locator('.mp-audit').innerText(), /3rurp-vyaaa-aaaay-aacua-cai/);
  assert.match(await appDetail.locator('.mp-audit').innerText(), /submitted package was checked for malware/);
  await appDetail.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: 'Quiet Notes', exact: true }).focus();
  await page.keyboard.press("Enter");
  const freeDetail = page.getByRole("dialog", { name: "Quiet Notes", exact: true });
  const additions = freeDetail.locator('.mp-detail-stats > div').filter({ hasText: 'Added · All time' });
  await additions.waitFor();
  assert.equal(await additions.locator('strong').innerText(), '42');
  await page.setViewportSize({ width: 320, height: 760 });
  assert.equal(await freeDetail.locator('.mp-detail-stats').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, "free detail counts must fit a narrow tile");
  await freeDetail.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.setViewportSize({ width: 380, height: 760 });
  checks.push("Paid and free details show their all-time acquisition counts on narrow tiles; Audited by AI retains the auditor principal and exact review analysis.");
  checks.push("Whole cards, including price and Owned labels, open details; separate native app and publisher controls remain keyboard-accessible; 255-character excerpts wrap and full 5,000-character descriptions preserve paragraphs.");
  const installationQuotesBefore = await page.evaluate(() => window.marketplaceFixture.installationQuotes.length);
  await page.evaluate(() => { window.marketplaceFixture.installed = ['atlas', 'studio']; });
  await page.getByRole("button", { name: "Refresh marketplace", exact: true }).click();
  for (const title of ['Atlas', 'Canvas Studio']) {
    const card = appCard(title);
    await card.locator('.mp-card-price').getByText('Owned', { exact: true }).waitFor();
    await clickCardPrice(card);
    const installedDetail = page.getByRole("dialog", { name: title, exact: true });
    await installedDetail.getByText("Audited by AI", { exact: true }).waitFor();
    assert.equal(await installedDetail.getByRole("button", { name: "Installed", exact: true }).isDisabled(), true);
    assert.equal(await installedDetail.getByRole("button", { name: /^(Get|Buy|Install app)/ }).count(), 0);
    assert.equal(await installedDetail.getByRole("button", { name: "Rate app", exact: true }).count(), 0, "local installation does not grant marketplace rating entitlement");
    assert.equal(await installedDetail.locator('.mp-detail-stats').getByText('Owned', { exact: true }).count(), 1);
    assert.equal(await installedDetail.getByText('Installed on this Neutron', { exact: true }).count(), 1);
    assert.equal(await installedDetail.getByText('Future updates included', { exact: true }).count(), 0);
    await installedDetail.getByRole("button", { name: "Close dialog", exact: true }).click();
  }
  assert.equal(await page.evaluate(() => window.marketplaceFixture.installationQuotes.length), installationQuotesBefore, "installed apps do not quote installation or acquisition");
  assert.equal(await page.evaluate(() => window.marketplaceFixture.calls.filter(call => ['quotePurchase', 'purchase'].includes(call[0])).length), 0);
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.owned), ['notes', 'garden'], "installed app display leaves durable entitlements unchanged");
  await page.evaluate(() => { window.marketplaceFixture.installed = []; });
  await page.getByRole("button", { name: "Refresh marketplace", exact: true }).click();
  await appCard('Atlas').locator('.mp-card-price').getByText('$10.00', { exact: true }).waitFor();
  checks.push("Locally installed free and paid apps display Owned immediately on refreshed cards and Installed in details, without acquisition/installation calls or implied marketplace rating entitlements.");
  const headerDiscount = page.locator('.mp-header').getByRole('button', { name: /^Discount code/ });
  await headerDiscount.click();
  const discountDialog = page.getByRole('dialog', { name: 'Discount code', exact: true });
  await discountDialog.getByLabel('Discount code', { exact: true }).fill('INVALID');
  await discountDialog.getByRole('button', { name: 'Activate discount', exact: true }).click();
  await discountDialog.getByText('That discount code was not found.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.discountCode), null);
  await discountDialog.getByLabel('Discount code', { exact: true }).fill(' quiet-code ');
  await discountDialog.getByRole('button', { name: 'Activate discount', exact: true }).click();
  await discountDialog.getByText('10% discount activated!', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.discountCode), 'QUIET-CODE');
  await page.screenshot({ path: join(output, 'discount-activated-380.png') });
  await discountDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.match(await headerDiscount.getAttribute('aria-label'), /10%/);
  const atlasCard = appCard('Atlas');
  assert.match(await atlasCard.locator('del').innerText(), /\$10\.00$/);
  assert.match(await atlasCard.locator('.mp-card-price').innerText(), /\$9\.00/);
  for (const width of [320, 380, 960]) {
    await page.setViewportSize({ width, height: 760 });
    assert.equal(await page.locator('.mp-navigation').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `Activity tab must fit at ${width}px`);
    assert.equal(await page.locator('.mp-header').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `discount and refresh controls must fit at ${width}px`);
    await page.screenshot({ path: join(output, `discounted-explore-${width}.png`) });
  }
  await page.setViewportSize({ width: 380, height: 760 });
  await headerDiscount.click();
  await discountDialog.getByLabel('Discount code', { exact: true }).fill('SELF-CODE');
  await discountDialog.getByRole('button', { name: 'Update discount', exact: true }).click();
  await discountDialog.getByText('You cannot use your own affiliate code.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.discountCode), 'QUIET-CODE', 'invalid replacement preserves the existing activated code');
  await discountDialog.getByLabel('Discount code', { exact: true }).fill('OTHER-CODE');
  await discountDialog.getByRole('button', { name: 'Update discount', exact: true }).click();
  await discountDialog.getByText('20% discount activated!', { exact: true }).waitFor();
  await discountDialog.getByRole('button', { name: 'Remove code', exact: true }).click();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.discountCode), null);
  await discountDialog.getByLabel('Discount code', { exact: true }).fill('QUIET-CODE');
  await discountDialog.getByRole('button', { name: 'Activate discount', exact: true }).click();
  await discountDialog.getByText('10% discount activated!', { exact: true }).waitFor();
  await discountDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
  await atlasCard.locator('del').waitFor();
  assert.match(await headerDiscount.getAttribute('aria-label'), /10%/);
  checks.push('A saved discount activates once, renders crossed-out original and exact discounted prices, restores after reload, rejects invalid/self-code changes without dropping the old code, supports change/clear, and fits alongside the bell tab at 320px.');
  await clickCardPrice(atlasCard);
  await page.getByRole('dialog', { name: 'Atlas', exact: true }).getByRole('button', { name: 'Get · $9.00', exact: true }).click();
  const checkout = page.getByRole("dialog", { name: "Review purchase", exact: true });
  assert.equal(await checkout.getByLabel(/Affiliate code/).count(), 0);
  assert.match(await checkout.innerText(), /QUIET-CODE/);
  assert.match(await checkout.innerText(), /10%/);
  await checkout.getByRole("button", { name: "Review costs", exact: true }).click();
  await checkout.getByRole("heading", { name: "Where your payment goes" }).waitFor();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.purchased.length), 0);
  assert.match(await checkout.innerText(), /9.02 ckUSDC/);
  assert.match(await checkout.innerText(), /3.6 ckUSDC/);
  assert.match(await checkout.innerText(), /3rurp-vyaaa-aaaay-aacua-cai/);
  await page.screenshot({ path: join(output, "checkout-380.png") });
  await checkout.getByRole("button", { name: "Buy · 9 ckUSDC", exact: true }).click();
  assert.equal(await page.locator('.mp-operation').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Check status', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole("button", { name: "Check status", exact: true }).waitFor();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.purchased), ["0123456789abcdef0123456789abcdef"]);
  checks.push("Checkout shows exact discounted allocations, principals, fees and total before payment; status refresh makes no second purchase.");
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  await page.getByLabel("Select available", { exact: true }).check();
  await page.getByRole("button", { name: "Install selected", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.calls.find(x=>x[0]==='install')[1]), ["notes", "garden"]);
  await page.getByRole("button", { name: "Install selected", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Select Quiet Notes", { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel("Select Garden", { exact: true }).isChecked(), true);
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.installed), [], "opening a review must not mark apps installed");
  assert.equal(await page.locator('.mp-operation').filter({ hasText: /package review was opened|Ready to install/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "View saved progress", exact: true }).count(), 0, "saved install handoffs must not become recovery cards");
  await page.getByRole("button", { name: "Install selected", exact: true }).click();
  const repeated = await page.evaluate(() => window.marketplaceFixture.calls.filter(call=>call[0]==='install'));
  assert.deepEqual(repeated.map(call=>call[1]), [["notes", "garden"], ["notes", "garden"]]);
  assert.equal(repeated[0][2], repeated[1][2], "reopening a canceled batch must retain its original request");
  assert.equal(await page.locator('.mp-operation').count(), 0, 'My Apps stays free of payment banners');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  assert.match(await page.locator('.mp-activity-card').innerText(), /Waiting for the original payment/);
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  await page.getByLabel("Select available", { exact: true }).check();
  await page.getByRole("button", { name: "Install selected", exact: true }).click();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.calls.filter(call=>call[0]==='install').at(-1)[2]), repeated[0][2], "a remounted selection must recover the same saved request");
  assert.equal(await page.locator('.mp-operation').filter({ hasText: /package review was opened|Ready to install/ }).count(), 0);
  checks.push("My Apps retains the selected batch for cancel/retry and reuses its saved request after remount, without install-progress cards or false installed status; financial recovery remains available on its Activity page.");
  await page.evaluate(() => { window.marketplaceFixture.installed=['garden']; window.marketplaceFixture.restored=true; });
  await page.getByRole("button", { name: "Refresh marketplace", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Select Garden"]')?.disabled === true);
  assert.match(await page.locator('.mp-library-list').innerText(), /Update to 3 in Settings/);
  assert.equal(await page.getByLabel("Select Garden", { exact: true }).isChecked(), false, "a confirmed installed app must leave the selection");
  await page.getByLabel("Select available", { exact: true }).check();
  await page.getByRole("button", { name: "Install selected", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.calls.filter(x=>x[0]==='install').at(-1)[1]), ["notes"]);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const savedWithdrawal = page.locator('.mp-activity-card').filter({ hasText: 'Saved withdrawal awaits confirmation.' });
  await savedWithdrawal.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText("Your app is ready.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.marketplaceFixture.calls.filter(x=>x[0]==='resumeOperation'&&x[1]==='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').length), 1);
  // A successful continuation persists its terminal receipt before returning.
  // History must not fabricate the earlier pending state on the next refresh.
  assert.equal(await page.evaluate(() => window.marketplaceFixture.operations.find(item=>item.operationId==='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').state), 'complete');
  const historyReads = await page.evaluate(() => window.marketplaceFixture.calls.filter(call=>call[0]==='recentOperations').length);
  await page.getByRole('button', {name:'Refresh activity', exact:true}).click();
  await page.waitForFunction(before => window.marketplaceFixture.calls.filter(call=>call[0]==='recentOperations').length > before, historyReads);
  const completedWithdrawal = page.locator('.mp-activity-card').filter({hasText:'Your app is ready.'});
  await completedWithdrawal.waitFor();
  assert.equal(await completedWithdrawal.getByRole('button', {name:'Continue', exact:true}).count(), 0);
  checks.push("Already installed apps are excluded from install selection, updates point to Settings, and restored requests resume their original identity.");

  await page.getByRole("button", { name: "Earnings", exact: true }).click();
  await page.evaluate(() => {
    window.marketplaceFixture.copyFailure = true;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: () => { throw Error('Direct iframe clipboard access is blocked by Permissions Policy'); },
    } });
  });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByText("Clipboard temporarily unavailable.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Copied", exact: true }).count(), 0);
  await page.evaluate(() => { window.marketplaceFixture.copyFailure = false; });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await page.getByText("Clipboard temporarily unavailable.", { exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.copies), [
    { text: 'QUIET-CODE', active: true }, { text: 'QUIET-CODE', active: true },
  ]);
  checks.push("Referral Copy uses the shared Kernel clipboard API within the click activation, works with direct iframe clipboard access blocked, and clears a failed-copy message after retry.");
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  const withdraw = page.getByRole("dialog", { name: "Withdraw ckUSDC", exact: true });
  await withdraw.getByRole("button", { name: "Max", exact: true }).click();
  await withdraw.getByLabel("Receiving principal", { exact: true }).fill("aaaaa-aa");
  await withdraw.getByRole("button", { name: "Review withdrawal", exact: true }).click();
  assert.match(await withdraw.innerText(), /4.49 ckUSDC/);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.calls.filter(x=>x[0]==='withdraw').length), 0);
  await withdraw.getByRole("button", { name: "Confirm withdrawal", exact: true }).click();
  assert.equal(await page.getByText('Withdrawal confirmed.', { exact: true }).count(), 0, 'completed payments do not pin a top-level notice');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByText('Withdrawal confirmed.', { exact: true }).waitFor();
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

  await headerDiscount.click();
  await discountDialog.getByRole('button', { name: 'Remove code', exact: true }).click();
  await discountDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const studio = appCard('Canvas Studio');
  await clickCardPrice(studio);
  await page.getByRole("dialog", { name: "Canvas Studio", exact: true }).getByRole("button", { name: "Get app", exact: true }).click();
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
  await page.goto(url);
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
  await page.evaluate(() => {
    window.marketplaceFixture.operations = [
      {operationId:'cccccccccccccccccccccccccccccccc',state:'failed',nextAction:'resume',ethereumWallet:'browser',canceledBeforeSubmission:true,message:'The browser wallet declined this transaction before submission.'},
      {operationId:'dddddddddddddddddddddddddddddddd',state:'pending',nextAction:'resume',ethereumWallet:'browser',message:'The original browser payment outcome is unknown.'},
      {operationId:'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',state:'failed',nextAction:'resume',ethereumWallet:'browser',message:'A retained payment needs attention.'},
    ];
  });
  await page.getByRole('button', { name: 'Refresh marketplace', exact: true }).click();
  assert.equal(await page.locator('.mp-operation').count(), 0);
  assert.equal(await page.getByText('The browser wallet declined this transaction before submission.', { exact: true }).count(), 0);
  assert.equal(await page.getByText('The original browser payment outcome is unknown.', { exact: true }).count(), 0);
  const activityTab = page.getByRole('button', { name: 'Activity', exact: true });
  await activityTab.click();
  await page.getByText('The original browser payment outcome is unknown.', { exact: true }).waitFor();
  assert.equal(await page.getByText('The browser wallet declined this transaction before submission.', { exact: true }).count(), 0);
  assert.equal(await page.locator('.mp-activity-card').count(), 2, 'known pre-submission cancellation is quiet, unknown and unclassified failures remain recoverable');
  assert.equal(await activityTab.getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('.mp-activity-actions .mp-primary').first().evaluate(element => getComputedStyle(element).color), 'rgb(31, 24, 49)', 'Activity primary actions need dark text with readable contrast on the accent background');
  for (const width of [320, 380, 960]) {
    await page.setViewportSize({ width, height: 760 });
    assert.equal(await page.locator('.mp-navigation').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    assert.equal(await page.locator('.mp-activity').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    await page.screenshot({ path: join(output, `activity-${width}.png`) });
  }
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.purchased), [], 'opening activity cannot dispatch or replay a payment');
  checks.push('The bell is a fifth Activity tab; confirmed pre-submission browser cancellation is absent, uncertain and unclassified failures remain recoverable, and no wallet status is pinned over browsing. Activity fits 320/380/960px without replay.');
  await page.goto(url);
  await page.getByRole("button", { name: 'Atlas', exact: true }).click();
  await page.getByRole('dialog', { name: 'Atlas', exact: true }).getByRole('button', { name: 'Get · $10.00', exact: true }).click();
  await page.evaluate(() => { window.marketplaceFixture.cancelPurchase = true; });
  const canceledCheckout = page.getByRole('dialog', { name: 'Review purchase', exact: true });
  await canceledCheckout.getByRole('button', { name: 'Review costs', exact: true }).click();
  await canceledCheckout.getByRole('button', { name: 'Buy · 10 ckUSDC', exact: true }).click();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('heading', { name: "You're all caught up", exact: true }).waitFor();
  await page.evaluate(() => {
    window.marketplaceFixture.operations = [{operationId:'0123456789abcdef0123456789abcdef',state:'complete',nextAction:'none',ethereumWallet:'browser',ethereumTransactionHash:'0x'+'a'.repeat(64),entitled:true,canceledBeforeSubmission:true,message:'A later verified receipt is available.'}];
  });
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await page.getByText('A later verified receipt is available.', { exact: true }).waitFor();
  assert.equal(await page.locator('.mp-activity-card').count(), 1, 'fresh saved receipt supersedes the earlier local cancellation and remains visible even if an obsolete cancellation flag remains');
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.purchased), ['0123456789abcdef0123456789abcdef']);
  checks.push('A later durable receipt supersedes a locally canceled observation on refresh; visibility is based on the newest evidence, without a replacement purchase.');

  await page.goto(url);
  await page.getByRole("button", { name: 'Atlas', exact: true }).click();
  await page.getByRole('dialog', { name: 'Atlas', exact: true }).getByRole('button', { name: 'Get · $10.00', exact: true }).click();
  await page.evaluate(() => { window.marketplaceFixture.cancelPurchase = 'ic'; });
  const declinedIcCheckout = page.getByRole('dialog', { name: 'Review purchase', exact: true });
  await declinedIcCheckout.getByRole('button', { name: 'Review costs', exact: true }).click();
  await declinedIcCheckout.getByRole('button', { name: 'Buy · 10 ckUSDC', exact: true }).click();
  await declinedIcCheckout.waitFor({ state: 'hidden' });
  await activityTab.click();
  await page.getByRole('heading', { name: "You're all caught up", exact: true }).waitFor();
  assert.equal(await page.locator('.mp-notification-badge').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.purchased), ['0123456789abcdef0123456789abcdef']);
  checks.push('An explicitly rejected IC approval closes Checkout quietly and leaves no Activity card or badge.');

  await page.goto(url);
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
  await page.evaluate(() => {
    window.marketplaceFixture.operations = [{operationId:'ffffffffffffffffffffffffffffffff',paymentRail:'ethereum',state:'pending',nextAction:'resume',message:'An unpaid checkout is waiting.'}];
  });
  await page.getByRole('button', { name: 'Refresh marketplace', exact: true }).click();
  await page.locator('.mp-notification-badge').getByText('1', { exact: true }).waitFor();
  await activityTab.click();
  await page.getByText('An unpaid checkout is waiting.', { exact: true }).waitFor();
  await page.locator('.mp-activity-details summary').click();
  await page.getByRole('button', { name: 'Cancel checkout', exact: true }).click();
  await page.getByRole('heading', { name: "You're all caught up", exact: true }).waitFor();
  assert.equal(await page.locator('.mp-notification-badge').count(), 0, 'successful Cancel checkout clears the badge immediately');
  for (const refresh of ['Refresh activity', 'Refresh marketplace']) {
    await page.getByRole('button', { name: refresh, exact: true }).click();
    await page.getByRole('heading', { name: "You're all caught up", exact: true }).waitFor();
    assert.equal(await page.locator('.mp-notification-badge').count(), 0, 'saved canceled invoice cannot reappear as an unresolved failure');
  }
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.calls.filter(call => call[0]==='cancelEthereumCheckout')), [['cancelEthereumCheckout','ffffffffffffffffffffffffffffffff']]);
  await page.reload();
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
  await activityTab.click();
  await page.getByRole('heading', { name: "You're all caught up", exact: true }).waitFor();
  assert.equal(await page.locator('.mp-notification-badge').count(), 0, 'the persisted protocol cancellation also stays quiet after a browser reload');
  await page.evaluate(() => {
    window.marketplaceFixture.operations = [{operationId:'ffffffffffffffffffffffffffffffff',paymentRail:'ethereum',state:'failed',nextAction:'review',checkoutCanceled:true,ethereumTransactionHash:'0x'+'b'.repeat(64),settlement:{state:'pending',message:'Buyer credit still needs settlement.'},message:'An earlier payment now needs reconciliation.'}];
  });
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await page.getByText('An earlier payment now needs reconciliation.', { exact: true }).waitFor();
  assert.equal(await page.locator('.mp-notification-badge').textContent(), '1', 'a later payment must remain visible even with an obsolete canceled flag');
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.purchased), []);
  await page.evaluate(() => sessionStorage.removeItem('canceledCheckoutFixture'));
  checks.push('Cancel checkout removes the unpaid card and badge immediately, survives app refresh and browser reload, and later payment evidence restores recovery without another cancellation or payment.');

  await page.goto(url);
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
  await page.evaluate(() => {
    window.marketplaceFixture.operations = [
      {operationId:'11111111111111111111111111111111',state:'approval_required',nextAction:'resume',canDismiss:true,message:'An ICP approval is saved. No marketplace payment is recorded.'},
      {operationId:'22222222222222222222222222222222',state:'failed',nextAction:'none',checkoutCanceled:true,message:'The IC approval was rejected before payment.'},
    ];
    sessionStorage.setItem('canceledCheckoutFixture', JSON.stringify(window.marketplaceFixture.operations));
  });
  await page.getByRole('button', { name: 'Refresh marketplace', exact: true }).click();
  await activityTab.click();
  await page.getByText('An ICP approval is saved. No marketplace payment is recorded.', { exact: true }).waitFor();
  assert.equal(await page.locator('.mp-activity-card').count(), 1, 'a fully rejected IC approval needs no activity card');
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await page.getByRole('heading', { name: "You're all caught up", exact: true }).waitFor();
  assert.equal(await page.locator('.mp-notification-badge').count(), 0);
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await page.getByRole('heading', { name: "You're all caught up", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
  await activityTab.click();
  await page.getByRole('heading', { name: "You're all caught up", exact: true }).waitFor();
  assert.equal(await page.locator('.mp-notification-badge').count(), 0, 'dismissed approval-only history remains quiet after browser reload');
  await page.evaluate(() => {
    window.marketplaceFixture.operations[0] = {...window.marketplaceFixture.operations[0],state:'pending',canDismiss:false,message:'The original ICP payment outcome is unknown.'};
  });
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await page.getByText('The original ICP payment outcome is unknown.', { exact: true }).waitFor();
  assert.equal(await page.locator('.mp-notification-badge').textContent(), '1');
  assert.equal(await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count(), 0, 'a submitted or uncertain payment retains recovery');
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.purchased), []);
  await page.evaluate(() => {
    sessionStorage.removeItem('canceledCheckoutFixture');
    for (const key of Object.keys(localStorage)) if (key.startsWith('marketplace:activity-dismissed:')) localStorage.removeItem(key);
  });
  checks.push('Rejected IC approvals disappear; approval-only reminders can be dismissed across refresh/reload, while later unknown payments resurface and retain recovery without replay.');

  await page.goto(`${url}/?discount=delayed`);
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
  await headerDiscount.click();
  assert.equal(await discountDialog.getByLabel('Discount code', { exact: true }).inputValue(), '');
  await page.evaluate(() => window.marketplaceFixture.discountRelease());
  await discountDialog.getByText('10% discount activated!', { exact: true }).waitFor();
  assert.equal(await discountDialog.getByLabel('Discount code', { exact: true }).inputValue(), 'QUIET-CODE', 'a pristine modal adopts the saved code once its initial read resolves');
  await page.goto(`${url}/?discount=delayed`);
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
  await headerDiscount.click();
  await discountDialog.getByLabel('Discount code', { exact: true }).fill('OTHER-CODE');
  await page.evaluate(() => window.marketplaceFixture.discountRelease());
  await page.waitForFunction(() => document.querySelector('.mp-header [aria-label*="activated"]'));
  assert.equal(await discountDialog.getByLabel('Discount code', { exact: true }).inputValue(), 'OTHER-CODE', 'late saved-code reads must not replace edits already entered in the modal');
  checks.push('Opening the discount dialog before saved preferences resolve fills a pristine input when ready while preserving any edits already typed.');
  await page.goto(`${url}/?catalog=paged`);
  await page.getByRole("button", { name: "Show more paid apps", exact: true }).click();
  await page.getByRole("button", { name: 'Focus', exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Show more paid apps", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Show more free apps", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: 'Garden', exact: true }).count(), 0);
  await page.getByRole("button", { name: "Show more free apps", exact: true }).click();
  await page.getByRole("button", { name: 'Garden', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.marketplaceFixture.calls.filter(call=>call[0]==='catalog'&&call[1].cursor).map(call=>[call[1].tier,call[1].cursor])), [['paid','paid-next'],['free','free-next']]);
  await page.getByRole("searchbox", { name: "Search apps", exact: true }).fill("Atlas");
  await page.getByText("No matching free apps.", { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => ['paid','free'].every(tier=>window.marketplaceFixture.calls.some(call=>call[0]==='catalog'&&call[1].tier===tier&&call[1].search==='Atlas'))));
  checks.push("Paid and free charts page independently, and a shared search applies to both lists without carrying pagination into the new search.");

  await page.goto(`${url}/?catalog=paid-error`);
  await page.getByText("Paid charts are temporarily unavailable.", { exact: true }).waitFor();
  await page.getByRole("button", { name: /Quiet Notes/ }).waitFor();
  await page.getByRole("region", { name: "Top paid", exact: true }).getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
  checks.push("One chart's read error does not block the other chart, and its retry recovers in place.");

  await page.goto(`${url}/?setup=delegate`);
  await page.getByText("Read access could not be prepared.", { exact: true }).waitFor();
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
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
  await page.getByRole("button", { name: 'Atlas', exact: true }).waitFor();
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
