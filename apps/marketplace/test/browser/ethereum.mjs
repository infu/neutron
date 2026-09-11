/** Actual App/Checkout/AgentReviewHost with local protocol and wallet fixtures.
 * Provider connection uses the production tile helper. Financial stages are
 * explicitly simulated; all external network requests are blocked. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = process.env.MARKETPLACE_ETHEREUM_BROWSER_ARTIFACTS || "/tmp/neutron-marketplace-ui/ethereum-browser";
await mkdir(output, { recursive: true });
const transport = `
  export const exposeTool=(name,options,handler)=>window.marketplaceTools.set(name,{options,handler});
  export const removeExposedTool=name=>window.marketplaceTools.delete(name);export const copyToClipboard=()=>Promise.reject(Error('Unexpected clipboard action in this regression'));
  export const connectEthereumProvider=()=>window.ethereumFixture.connectBrowser();
`;
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '${root}/apps/marketplace/src/app.tsx';
import '${root}/apps/marketplace/src/style.scss';
window.marketplaceTools=new Map();
const owner='3rurp-vyaaa-aaaay-aacua-cai',marketplace='rrkah-fqaaa-aaaaa-aaaaq-cai';
const payer='0x3333333333333333333333333333333333333333',helper='0x1111111111111111111111111111111111111111',minter='0x2222222222222222222222222222222222222222';
const state=window.ethereumFixture={events:[],quotes:[],purchases:[],resumes:[],verifications:[],installed:[],owned:false,stage:'idle',release:null,rejectConnection:false,interrupt:false,connections:[],lastQuote:null,fullQuote:null,observed:null,installationQuotes:[]};
const app={id:'studio',title:'Canvas Studio',summary:'Create and collect what inspires you.',priceUsdMicros:'5000000',category:'Creativity',publisher:owner,version:'101',rating:4.5,ratingCount:20};
const money=atoms=>({atoms,decimals:6,symbol:'USDC'});
const cost=total=>({total,processing:total,schedule:'fixed-fixture'});
const session={configured:true,canisterId:marketplace,host:'https://icp-api.io',account:owner,connected:true};
state.connectBrowser=()=>{
  state.events.push('browser-connect');
  const connection={
    provider:{request:async({method})=>{
      state.events.push('provider:'+method);
      if(method==='eth_requestAccounts'&&state.rejectConnection){state.rejectConnection=false;throw Object.assign(Error('Browser wallet connection declined.'),{code:4001});}
      if(method==='eth_requestAccounts'||method==='eth_accounts')return [payer];
      if(method==='eth_chainId')return '0x1';
      throw Error('Unexpected provider request '+method);
    }},
    close:async()=>{state.events.push('browser-close');connection.closed=true;},closed:false,
  };
  state.connections.push(connection);return Promise.resolve(connection);
};
const observe=()=>({operationId:state.lastQuote.operationId,state:'pending',nextAction:'resume',message:'Waiting for the original Ethereum payment.',ethereumWallet:state.lastQuote.ethereum.wallet,entitled:false});
const verified=()=>{
  state.events.push('protocol-verified');state.owned=true;state.stage='entitled';
  const result={operationId:state.lastQuote.operationId,state:'complete',nextAction:'none',message:'Ethereum payment verified. Your apps are ready.',appIds:['studio'],entitled:true,ethereumWallet:state.lastQuote.ethereum.wallet,ethereumTransactionHash:'0x'+'a'.repeat(64),settlement:{state:'pending',message:'Wrapping is still processing. Your apps can already be installed.'}};
  state.observed=result;return result;
};
const checkpoint=async stage=>{state.stage=stage;state.events.push(stage);await new Promise(resolve=>state.release=resolve);state.release=null;};
const client={
 discount:async()=>({code:null,active:false,discountBps:0,affiliate:null,error:null}),setDiscountCode:async()=>{throw Error('Unexpected discount change')},
 initialize:async()=>session,configure:async x=>({...session,...x}),connect:async()=>session,
 catalog:async input=>({items:input.tier==='paid'?[{...app,owned:state.owned}]:[],nextCursor:null}),
 detail:async()=>({...app,owned:state.owned,description:'A local checkout test.',screenshots:[],audit:null}),
 library:async()=>({items:state.owned?[{...app,owned:true,acquiredAt:'2026-09-10',installedVersion:null,available:true}]:[],nextCursor:null}),
 publisherApps:async()=>({items:[],nextCursor:null}),earnings:async()=>({referralCode:null,affiliateDiscountBps:1000,affiliateShareBps:3000,balances:[]}),
 recentOperations:async()=>[],operation:async()=>{state.events.push('status');return state.observed??observe();},
 quotePurchase:async input=>{
  state.events.push('quote');state.quotes.push(input);
  if(!input.ethereum)throw Error('Choose Ethereum in this fixture.');
  if(input.ethereum.wallet==='browser'&&input.ethereum.payerAddress!==payer)throw Error('Browser payer was not connected before quote.');
  const quote={operationId:input.ethereum.wallet==='browser'?'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb':'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',commitment:'retained-ethereum-quote',appIds:input.appIds,items:[app],token:'ckUSDC',subtotalUsdMicros:'5000000',discountUsdMicros:'0',payment:money('5000000'),approvalFee:money('0'),collectionFee:money('0'),totalDebit:money('5020000'),allocations:[{kind:'developer',principal:owner,amount:money('1500000')},{kind:'burn',principal:null,amount:money('3500000')}],cycles:cost('50000000000'),affiliateCode:input.affiliateCode,warnings:[],ethereum:{wallet:input.ethereum.wallet,chainId:'1',payerAddress:payer,tokenAddress:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',recipientPrincipal:marketplace,wrappingFee:money('20000'),prepareCycles:cost('1000000000'),verifyCycles:cost('50000000000')},opaque:{retained:true}};
  state.lastQuote=quote;return quote;
 },
 purchase:async(quote,connection)=>{
  state.events.push('purchase');state.purchases.push({sameQuote:quote===state.lastQuote,wallet:quote.ethereum.wallet,connectionMatches:connection===state.connections.at(-1)});
  if(quote.ethereum.wallet==='browser'&&(!connection||connection.closed))throw Error('Original browser connection was not retained for payment.');
  if(quote.ethereum.wallet==='evm_wallet'&&connection)throw Error('EVM Wallet payment received a browser connection.');
  state.fullQuote={...quote,ethereum:{...quote.ethereum,helperAddress:helper,minterAddress:minter}};
  const reviewed=await window.marketplaceTools.get('marketplace_owner_review_v1').handler({reviewJson:JSON.stringify({kind:'purchase',quote:state.fullQuote})},{agentMode:false,caller:{appId:'marketplace',role:'background',endpoint:'app:marketplace:background'}});
  if(!reviewed.approved)return {operationId:quote.operationId,state:'review_required',nextAction:'review',message:'Payment route review declined.'};
  state.events.push('route-approved');
  if(state.interrupt){state.stage='unknown';throw Error('Original Ethereum payment reply interrupted.');}
  await checkpoint('approval-confirmed');
  await checkpoint('deposit-mined');
  await checkpoint('verification-pending');
  return verified();
 },
 resumeOperation:async(id,connection)=>{
  state.events.push('resume');state.resumes.push(id);
  if(id!==state.lastQuote.operationId)throw Error('Lost original payment identity.');
  if(state.lastQuote.ethereum.wallet==='browser'&&(!connection||connection.closed))throw Error('Resume must reconnect through its click.');
  return verified();
 },
 verifyEthereumTransaction:async(operationId,transactionHash)=>{
  state.events.push('verify-original');state.verifications.push({operationId,transactionHash});
  if(operationId!==state.lastQuote.operationId)throw Error('Verification lost the original invoice.');
  if(transactionHash!=='0x'+'a'.repeat(64))throw Error('Verification changed the original payment hash.');
  const reviewed=await window.marketplaceTools.get('marketplace_owner_review_v1').handler({reviewJson:JSON.stringify({kind:'ethereum_verify',operationId,transactionHash,quote:state.fullQuote,cycles:state.fullQuote.ethereum.verifyCycles})},{agentMode:false,caller:{appId:'marketplace',role:'background',endpoint:'app:marketplace:background'}});
  if(!reviewed.approved)return observe();
  await checkpoint('original-hash-verification');
  return verified();
 },
 quoteInstallation:async(ids,operationId)=>{const cycles=cost('1100000');const quote={operationId:operationId??(state.installationQuotes.length+1).toString(16).padStart(32,'0'),appIds:[...ids],canisterId:marketplace,owner,cycles,fee:{feeVersion:'1',processingCycles:cycles.processing,storageCycles:'0',totalCycles:cycles.total,processingBytes:'1024',newStorageBytes:'0'}};state.installationQuotes.push(quote);return quote;},
 install:async(ids,quote)=>{if(!state.owned)throw Error('No verified entitlement yet.');if(!state.installationQuotes.includes(quote)||JSON.stringify(ids)!==JSON.stringify(quote.appIds))throw Error('Install must retain the exact reviewed quote and app selection.');state.installed.push(ids);return {message:'Install review opened.'};},
 rate:async()=>{},createReferralCode:async()=>'',quoteWithdrawal:async()=>{throw Error('Unexpected withdrawal')},withdraw:async()=>{throw Error('Unexpected withdrawal')},quotePublication:async()=>{throw Error('Unexpected publication')},publish:async()=>{throw Error('Unexpected publication')},
};
createRoot(document.getElementById('root')).render(<App client={client}/>);
`;
await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic", outfile: join(output, "fixture.js"), plugins: [
  { name: "local-only-transport", setup(builder) {
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "transport", namespace: "fixture" }));
    builder.onResolve({ filter: /tile_client\.ts$/ }, () => ({ path: "tile-client", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "transport" ? transport : "export const createMarketplaceClient=()=>{throw Error('Use fixture client')}", loader: "js" }));
  } }, sassPlugin(),
] });
const server = createServer(async (req, res) => {
  const asset = req.url === "/fixture.js" || req.url === "/fixture.css" ? req.url.slice(1) : null;
  res.setHeader("content-type", asset?.endsWith("js") ? "text/javascript" : asset ? "text/css" : "text/html");
  res.end(asset ? await readFile(join(output, asset)) : '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;background:#06080b}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser, page; const errors = [], checks = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 380, height: 760 } });
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith(url) ? route.continue() : route.abort());
  const snapshot = () => page.evaluate(() => ({ events: window.ethereumFixture.events, quotes: window.ethereumFixture.quotes, purchases: window.ethereumFixture.purchases, resumes: window.ethereumFixture.resumes, verifications: window.ethereumFixture.verifications, owned: window.ethereumFixture.owned, installed: window.ethereumFixture.installed, stage: window.ethereumFixture.stage, closed: window.ethereumFixture.connections.map(connection=>connection.closed) }));
  const open = async wallet => {
    await page.goto(url);
    await page.getByRole("button", { name: "$5.00", exact: true }).click();
    const checkout = page.getByRole("dialog", { name: "Review purchase", exact: true });
    await checkout.getByLabel("Pay with", { exact: true }).selectOption('ethereum');
    await checkout.getByLabel("Ethereum wallet", { exact: true }).selectOption(wallet);
    return checkout;
  };
  const exactEthereumView = async dialog => {
    assert.match(await dialog.locator('.mp-total-facts').innerText(), /ckUSDC collection fee/);
    assert.match(await dialog.locator('.mp-total-facts').innerText(), /5.02 USDC/);
    assert.match(await dialog.locator('.mp-total-facts').innerText(), /Ethereum gas/);
    assert.match(await dialog.locator('.mp-total-facts').innerText(), /Shown in your wallet/);
    assert.doesNotMatch(await dialog.locator('.mp-total-facts').innerText(), /Wallet approval fee|Payment collection fee/);
    assert.match(await dialog.innerText(), /0x3333333333333333333333333333333333333333/);
    assert.match(await dialog.innerText(), /rrkah-fqaaa-aaaaa-aaaaq-cai/);
    assert.match(await dialog.innerText(), /1,000,000,000 cycles/);
    assert.match(await dialog.innerText(), /50,000,000,000 cycles/);
  };
  const approveRoute = async () => {
    const route = page.getByRole('dialog', { name: 'Review updated purchase costs', exact: true });
    await route.getByRole('button', { name: 'Approve purchase', exact: true }).waitFor();
    await exactEthereumView(route);
    assert.match(await route.innerText(), /0x1111111111111111111111111111111111111111/);
    await route.getByText('Ethereum Mainnet route', { exact: true }).click();
    assert.match(await route.innerText(), /0x2222222222222222222222222222222222222222/);
    assert.equal((await snapshot()).owned, false);
    await route.getByRole('button', { name: 'Approve purchase', exact: true }).click();
  };

  for (const wallet of ['evm_wallet', 'browser']) {
    const checkout = await open(wallet);
    if (wallet === 'browser') {
      await page.evaluate(() => window.ethereumFixture.rejectConnection=true);
      await checkout.getByRole('button', { name: 'Connect wallet & review', exact: true }).click();
      await checkout.getByText('Browser wallet connection declined.', { exact: true }).waitFor();
      assert.equal((await snapshot()).quotes.length, 0, 'declined browser access cannot create a payment quote or app call');
      assert.deepEqual((await snapshot()).closed, [true]);
    }
    await checkout.getByRole('button', { name: wallet === 'browser' ? 'Connect wallet & review' : 'Review costs', exact: true }).click();
    await checkout.getByRole('button', { name: 'Buy · 5.02 USDC', exact: true }).waitFor();
    await exactEthereumView(checkout);
    let value = await snapshot();
    assert.equal(value.purchases.length, 0);
    assert.equal(value.owned, false);
    if (wallet === 'browser') {
      assert.equal(value.quotes[0].ethereum.payerAddress, '0x3333333333333333333333333333333333333333');
      assert(value.events.lastIndexOf('browser-connect') < value.events.indexOf('quote'));
      assert(value.events.lastIndexOf('provider:eth_accounts') < value.events.indexOf('quote'));
    } else assert.equal(value.events.includes('browser-connect'), false);
    for (const width of [320, 380, 480, 960]) {
      await page.setViewportSize({ width, height: 760 });
      const geometry = await checkout.evaluate(node => ({ right: node.getBoundingClientRect().right, overflow: node.scrollWidth > node.clientWidth, bodyOverflow: node.querySelector('.mp-modal-body').scrollWidth > node.querySelector('.mp-modal-body').clientWidth }));
      assert(geometry.right <= width); assert.equal(geometry.overflow, false); assert.equal(geometry.bodyOverflow, false);
      await page.screenshot({ path: join(output, `${wallet}-review-${width}.png`) });
    }
    await page.setViewportSize({ width: 380, height: 760 });
    await checkout.getByRole('button', { name: 'Buy · 5.02 USDC', exact: true }).evaluate(button=>{button.click();button.click();});
    await approveRoute();
    for (const stage of ['approval-confirmed','deposit-mined','verification-pending']) {
      await page.waitForFunction(expected=>window.ethereumFixture.stage===expected, stage);
      value = await snapshot();
      assert.equal(value.owned, false, `${stage} is not a verified marketplace entitlement`);
      assert.equal(value.installed.length, 0);
      assert.equal(value.purchases.length, 1, 'duplicate clicks must not dispatch twice');
      assert.equal(value.purchases[0].sameQuote, true);
      if (wallet === 'browser') assert.equal(value.purchases[0].connectionMatches, true);
      await page.evaluate(()=>window.ethereumFixture.release());
    }
    await page.getByRole('button', { name: 'Install', exact: true }).waitFor();
    assert.equal((await snapshot()).owned, true);
    assert.equal(await page.getByText('Wrapping is still processing. Your apps can already be installed.', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByText('Wrapping is still processing. Your apps can already be installed.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'My Apps', exact: true }).click();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    assert.deepEqual((await snapshot()).installed, [['studio']]);
    if (wallet === 'browser') assert.deepEqual((await snapshot()).closed, [true, true]);
    checks.push(`${wallet}: exact gross Ethereum USDC/wrapping/gas and cycle review, authenticated frozen helper review, approval/mined receipt insufficient before protocol verification, then installation allowed while wrapping remains pending.`);

    await page.evaluate(()=>{window.normalEthereumReview=null;void window.marketplaceTools.get('marketplace_review_v1').handler({reviewJson:JSON.stringify({kind:'purchase',quote:window.ethereumFixture.fullQuote})},{agentMode:false,audience:'foreground_tile'}).then(value=>window.normalEthereumReview=value);});
    const normal = page.getByRole('dialog', { name: 'Agent purchase request', exact: true });
    await normal.getByRole('button', { name: 'Decline', exact: true }).waitFor();
    await exactEthereumView(normal);
    await normal.getByRole('button', { name: 'Decline', exact: true }).click();
    assert.deepEqual(await page.evaluate(()=>window.normalEthereumReview), {approved:false});
  }

  for (const [kind,title,action] of [
    ['ethereum_cancel','Cancel checkout','Decline'],
    ['ethereum_settle','Collect converted payment','Collect payment'],
    ['ethereum_verify','Verify original payment','Verify payment'],
  ]) {
    const before = (await snapshot()).purchases.length;
    await page.evaluate(kind=>{
      const quote=window.ethereumFixture.fullQuote;
      window.invoiceReviewResult=null;
      void window.marketplaceTools.get('marketplace_review_v1').handler({reviewJson:JSON.stringify({kind,operationId:quote.operationId,transactionHash:'0x'+'a'.repeat(64),quote,cycles:{total:'1234500',processing:'1234500',schedule:'fixed-fixture'}})},{agentMode:false,audience:'foreground_tile'}).then(result=>window.invoiceReviewResult=result);
    },kind);
    const maintenance = page.getByRole('dialog',{name:title,exact:true});
    await maintenance.getByRole('button',{name:action,exact:true}).waitFor();
    assert.match(await maintenance.innerText(),/1,234,500 cycles/);
    if(kind==='ethereum_cancel') assert.match(await maintenance.innerText(),/cannot stop an Ethereum payment already sent.*late payment remains recoverable as ckUSDC credit/);
    if(kind==='ethereum_settle') assert.match(await maintenance.innerText(),/protocol accounting without another Ethereum payment/);
    if(kind==='ethereum_verify') {
      assert.match(await maintenance.innerText(),/verify it independently/);
      assert.match(await maintenance.innerText(),new RegExp('0x'+'a'.repeat(64)));
    }
    assert.equal(await maintenance.getByRole('button',{name:'Approve purchase',exact:true}).count(),0);
    await maintenance.getByRole('button',{name:action,exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.invoiceReviewResult),{approved:action!=='Decline'});
    assert.equal((await snapshot()).purchases.length,before);
  }
  const mismatched = await page.evaluate(async()=>{
    try {
      const quote=window.ethereumFixture.fullQuote;
      await window.marketplaceTools.get('marketplace_owner_review_v1').handler({reviewJson:JSON.stringify({kind:'ethereum_verify',operationId:'different-invoice',transactionHash:'0x'+'a'.repeat(64),quote,cycles:{total:'1',processing:'1',schedule:'fixture'}})},{agentMode:false,caller:{appId:'marketplace',role:'background',endpoint:'app:marketplace:background'}});
      return false;
    } catch {return true;}
  });
  assert.equal(mismatched,true);
  checks.push('Normal-agent cancellation, converted-payment collection and original-hash verification show distinct exact-cost reviews without another purchase; verification rejects a mismatched invoice.');

  const checkout = await open('browser');
  await page.evaluate(()=>window.ethereumFixture.interrupt=true);
  await checkout.getByRole('button', { name: 'Connect wallet & review', exact: true }).click();
  await checkout.getByRole('button', { name: 'Buy · 5.02 USDC', exact: true }).click();
  await approveRoute();
  await checkout.getByText('Original Ethereum payment reply interrupted.', { exact: true }).waitFor();
  assert.equal(await checkout.getByLabel('Pay with', { exact: true }).isDisabled(), true);
  assert.equal(await checkout.getByLabel('Ethereum wallet', { exact: true }).isDisabled(), true);
  assert.equal(await checkout.getByLabel(/Affiliate code/).count(), 0, 'discount is a saved preference, not a mutable field on an interrupted checkout');
  await checkout.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Connect wallet & continue', exact: true }).count(), 0, 'recovery controls stay off the app content');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Connect wallet & continue', exact: true }).click();
  await page.waitForFunction(()=>window.ethereumFixture.resumes.length===1);
  const resumed = await snapshot();
  assert.deepEqual(resumed.resumes, ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  assert.equal(resumed.quotes.length, 1);
  assert.equal(resumed.purchases.length, 1);
  assert(resumed.events.lastIndexOf('browser-connect') < resumed.events.indexOf('resume'));
  assert.deepEqual(resumed.closed, [true, true]);
  checks.push('An interrupted browser payment freezes its source/terms, reconnects directly from Continue, and resumes the original operation without a new quote or purchase.');

  const interrupted = await open('evm_wallet');
  await page.evaluate(()=>window.ethereumFixture.interrupt=true);
  await interrupted.getByRole('button', { name: 'Review costs', exact: true }).click();
  await interrupted.getByRole('button', { name: 'Buy · 5.02 USDC', exact: true }).click();
  await approveRoute();
  await interrupted.getByText('Original Ethereum payment reply interrupted.', { exact: true }).waitFor();
  await interrupted.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const pending = page.locator('.mp-activity-card');
  await pending.locator('summary').filter({ hasText: 'Details' }).click();
  const originalHash = '0x'+'a'.repeat(64), originalId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const recover = pending.getByRole('button', { name: 'Review & verify original payment', exact: true });
  await pending.getByLabel('Original Ethereum payment hash', { exact: true }).fill('0x1234');
  assert.equal(await recover.isDisabled(), true, 'an incomplete hash must not begin verification');
  assert.deepEqual((await snapshot()).verifications, []);
  await pending.getByLabel('Original Ethereum payment hash', { exact: true }).fill(' '+originalHash+' ');
  await recover.click();
  const hashReview = page.getByRole('dialog', { name: 'Verify original payment', exact: true });
  await hashReview.getByRole('button', { name: 'Verify payment', exact: true }).waitFor();
  assert.match(await hashReview.innerText(), new RegExp(originalHash));
  assert.match(await hashReview.innerText(), /50,000,000,000 cycles/);
  assert.match(await hashReview.innerText(), /rrkah-fqaaa-aaaaa-aaaaq-cai/);
  assert.match(await hashReview.innerText(), /verify it independently.*does not send another Ethereum payment/);
  await hashReview.getByText('Saved request', { exact: true }).click();
  assert.match(await hashReview.innerText(), new RegExp(originalId));
  let recovered = await snapshot();
  assert.deepEqual(recovered.verifications, [{operationId:originalId,transactionHash:originalHash}]);
  assert.equal(recovered.owned, false, 'opening the exact-cost review must not grant ownership');
  assert.equal(recovered.purchases.length, 1);
  assert.deepEqual(recovered.resumes, []);
  assert.equal(await hashReview.getByRole('button', { name: 'Approve purchase', exact: true }).count(), 0);
  await hashReview.getByRole('button', { name: 'Verify payment', exact: true }).click();
  await page.waitForFunction(()=>window.ethereumFixture.stage==='original-hash-verification');
  assert.equal((await snapshot()).owned, false, 'approval alone is not an independently verified receipt');
  await page.evaluate(()=>window.ethereumFixture.release());
  await page.getByText('Ethereum payment verified. Your apps are ready.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Activity', exact: true }).getAttribute('aria-current'), 'page');
  await page.getByText('Wrapping is still processing. Your apps can already be installed.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'My Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  recovered = await snapshot();
  assert.deepEqual(recovered.verifications, [{operationId:originalId,transactionHash:originalHash}]);
  assert.equal(recovered.quotes.length, 1);
  assert.equal(recovered.purchases.length, 1, 'hash recovery must not create another payment');
  assert.deepEqual(recovered.resumes, []);
  assert.deepEqual(recovered.closed, [], 'hash verification does not connect a browser wallet');
  assert.deepEqual(recovered.installed, [['studio']]);
  checks.push('The actual pending Saved request validates and verifies the original Ethereum hash and invoice through an exact Normal review, without another purchase, resume or wallet connection; verified ownership remains visible in Activity and allows installation from My Apps while conversion remains pending.');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({checks,errors},null,2));
  console.log('Ethereum marketplace browser checks passed. Artifacts: '+output);
} catch (error) {
  await page?.screenshot({path:join(output,'failure.png')});
  await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors},null,2));
  throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
