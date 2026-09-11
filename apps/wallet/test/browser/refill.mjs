/** Real compact refill UI and quote arithmetic; ledger, persistence and financial
 * execution are fixtures. No production request is permitted. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { sassPlugin } from 'esbuild-sass-plugin';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const out = process.env.WALLET_REFILL_BROWSER_ARTIFACTS || '/tmp/neutron-wallet-refill-browser';
const fixture = fileURLToPath(new URL('./refill_fixture.mjs', import.meta.url));
const cyclesFixture = fileURLToPath(new URL('./cycles_conversion_fixture.mjs', import.meta.url));
const owner = '3rurp-vyaaa-aaaay-aacua-cai', other = 'mohjv-bqaaa-aaaag-qjyia-cai';
await mkdir(out, { recursive: true });
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {WalletRefillPage,WalletRefillPromptHost,requestWalletRefillReview} from '${root}/apps/wallet/src/refill_page.tsx'; import '${root}/apps/wallet/src/style.scss'; window.reviewRefill=requestWalletRefillReview; createRoot(document.getElementById('root')).render(<main className="nt-app wallet-app"><div className="wallet-shell"><WalletRefillPage owner="${owner}" tray={new URLSearchParams(location.search).get('scenario')==='tray'} openInTile={async()=>window.__refill.opened++}/><WalletRefillPromptHost/></div></main>);`;
await build({ absWorkingDir:root, entryPoints:['refill-entry'], outfile:out+'/main.js', bundle:true, platform:'browser',format:'esm',jsx:'automatic',logLevel:'warning',plugins:[{name:'refill-fixture',setup(b){
  b.onResolve({filter:/^refill-entry$/},()=>({path:'entry',namespace:'fixture-entry'}));
  b.onLoad({filter:/.*/,namespace:'fixture-entry'},()=>({contents:entry,loader:'tsx',resolveDir:root}));
  b.onResolve({filter:/^\.\/refill\.ts$/},args=>args.importer.endsWith('refill_page.tsx')?{path:fixture}:undefined);
  b.onResolve({filter:/^\.\/cycles_conversion\.ts$/},()=>({path:cyclesFixture}));
}},sassPlugin()] });
const server=createServer(async(req,res)=>{const name=req.url?.split('?')[0]; if(name==='/main.js'||name==='/main.css'){res.setHeader('Content-Type',name.endsWith('css')?'text/css':'text/javascript');res.end(await readFile(out+name));}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/run/current-system/sw/bin/google-chrome-stable',args:['--no-sandbox']});
const errors=[], checks=[];
const calls=page=>page.evaluate(()=>window.__refill.calls.filter(row=>['prepare','execute','continue'].includes(row.method)));
async function open(scenario='normal', width=380){const page=await browser.newPage({viewport:{width,height:860}});page.on('pageerror',error=>errors.push(String(error)));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(errors.push('Unexpected network '+route.request().url()),route.abort()));await page.goto(origin+'/?scenario='+scenario);await page.locator('.wallet-refill-balance').getByText('Available',{exact:false}).waitFor();return page;}
try {
  const page=await open();
  for(const width of [320,380,960]){await page.setViewportSize({width,height:860});await page.getByRole('textbox',{name:'Amount of ICP'}).fill('0.1');assert.equal(await page.locator('.wallet-refill').evaluate(node=>node.scrollWidth<=node.clientWidth),true);await page.screenshot({path:`${out}/refill-${width}.png`});}
  await page.setViewportSize({width:380,height:860});
  assert.equal(await page.getByText('My Neutron',{exact:true}).count(),1);
  await page.getByRole('button',{name:'Review refill',exact:true}).click();
  await page.getByRole('dialog').waitFor();assert.deepEqual(await calls(page),[]);
  assert((await page.getByRole('dialog').innerText()).includes('0.1001 ICP'));
  await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);assert.deepEqual(await calls(page),[]);
  await page.getByRole('button',{name:'Review refill',exact:true}).click();await page.getByRole('button',{name:'Refill now',exact:true}).click();
  await page.getByText('Refill complete',{exact:true}).first().waitFor();
  const paid=await calls(page);assert.deepEqual(paid.map(row=>row.method),['prepare','execute']);assert.equal(paid[0].id,paid[1].id);assert.equal(paid[0].quote.target,owner);
  await page.getByRole('button',{name:'Dismiss refill result'}).click();assert.equal(await page.locator('.wallet-refill-result').count(),0);
  checks.push('Compact 320/380/960px layouts; My Neutron default; exact amount+fee review; cancellation never prepares or pays; one confirmation prepares and executes one retained ID; completed receipt dismisses.');
  await page.close();

  const cycles=await open();await cycles.getByRole('button',{name:'TCYCLES',exact:true}).click();
  await cycles.getByRole('slider',{name:'Percentage of available balance'}).fill('50');
  assert.equal(await cycles.getByRole('textbox',{name:'Amount of TCYCLES'}).inputValue(),'1.24995');
  await cycles.getByText('Advanced options',{exact:true}).click();await cycles.getByRole('checkbox',{name:'Refill another canister'}).check();
  await cycles.getByRole('textbox',{name:'Canister ID'}).fill('invalid');assert.equal(await cycles.getByRole('button',{name:'Review refill',exact:true}).isDisabled(),true);
  await cycles.getByRole('textbox',{name:'Canister ID'}).fill(other);await cycles.getByRole('button',{name:'Review refill',exact:true}).click();
  assert((await cycles.getByRole('dialog').innerText()).includes(other));await cycles.getByRole('button',{name:'Refill now',exact:true}).click();await cycles.getByText('Refill complete',{exact:true}).first().waitFor();
  const transfer=await calls(cycles);assert.equal(transfer[0].quote.kind,'tcycles_topup');assert.equal(transfer[0].quote.target,other);assert.equal(transfer[0].quote.totalDebitAtoms,'1250050000000');
  checks.push('TCYCLES slider reserves the source fee; invalid recipient blocks review; advanced canister destination is explicit in the signed review and exact request.');await cycles.close();

  const convert=await open();await convert.getByRole('button',{name:'Get TCYCLES',exact:true}).click();await convert.getByRole('textbox',{name:'Amount of ICP'}).fill('0.1');
  await convert.getByText('Advanced options',{exact:true}).click();await convert.getByRole('checkbox',{name:'Send TCYCLES to another account'}).check();await convert.getByRole('textbox',{name:'Recipient principal'}).fill(other);
  await convert.getByRole('button',{name:'Review conversion',exact:true}).click();const reviewText=await convert.getByRole('dialog').innerText();assert(reviewText.includes('0.1298 TCYCLES'));assert(reviewText.includes('0.0002 TCYCLES'));
  await convert.getByRole('button',{name:'Convert ICP',exact:true}).click();await convert.getByText('TCYCLES received',{exact:true}).first().waitFor();assert((await convert.locator('.wallet-refill-result').innerText()).includes('0.1298 TCYCLES added'));
  checks.push('ICP→TCYCLES advanced recipient review includes both mint and forwarding fees; completed receipt displays actual net credit rather than gross minted cycles.');await convert.close();

  const recovery=await open('interrupted');await recovery.getByRole('textbox',{name:'Amount of ICP'}).fill('0.1');await recovery.getByRole('button',{name:'Review refill',exact:true}).click();await recovery.getByRole('button',{name:'Refill now',exact:true}).click();await recovery.getByRole('button',{name:'Continue',exact:true}).waitFor();const original=(await calls(recovery))[0].id;
  await recovery.reload();await recovery.getByRole('button',{name:'Continue',exact:true}).click();await recovery.getByText('Refill complete',{exact:true}).first().waitFor();assert.deepEqual(await calls(recovery),[{method:'continue',id:original}]);
  checks.push('After a lost post-payment reply and full reload, original durable refill resumes without another preparation or source debit.');await recovery.close();

  const prepared=await open('prepare-interrupted');await prepared.getByRole('textbox',{name:'Amount of ICP'}).fill('0.1');await prepared.getByRole('button',{name:'Review refill',exact:true}).click();await prepared.getByRole('button',{name:'Refill now',exact:true}).click();await prepared.getByRole('button',{name:'Review saved refill',exact:true}).waitFor();const preparedId=(await calls(prepared))[0].id;
  assert.deepEqual((await calls(prepared)).map(row=>row.method),['prepare']);
  await prepared.reload();await prepared.getByRole('button',{name:'Review saved refill',exact:true}).click();assert.deepEqual(await calls(prepared),[]);await prepared.getByRole('button',{name:'Refill now',exact:true}).click();await prepared.getByText('Refill complete',{exact:true}).first().waitFor();assert.deepEqual(await calls(prepared),[{method:'execute',id:preparedId}]);
  checks.push('A lost preparation reply restores an unsent saved request; a fresh review dispatches that exact prepared request once, never another preparation.');await prepared.close();

  const agentReview=await open();
  await agentReview.evaluate(()=>{window.refillController=new AbortController();window.refillDecision=null;window.reviewRefill({version:1,kind:'icp_topup',owner:'3rurp-vyaaa-aaaay-aacua-cai',target:'3rurp-vyaaa-aaaay-aacua-cai',amountAtoms:'10000000',source:'ICP',sourceDecimals:8,sourceFeeAtoms:'10000',totalDebitAtoms:'10010000',estimatedCycles:'130000000000',estimatedReceivedCycles:'130000000000',icpFeeAtoms:'10000',cyclesFeeAtoms:'100000000',observedAt:1789110000000,warnings:[]},window.refillController.signal).then(value=>window.refillDecision=value);});
  await agentReview.getByRole('dialog').waitFor();await agentReview.evaluate(()=>window.refillController.abort());await agentReview.waitForFunction(()=>window.refillDecision===false);assert.equal(await agentReview.getByRole('dialog').count(),0);assert.deepEqual(await calls(agentReview),[]);
  checks.push('An agent review opens the shared confirmation dialog; abort before approval closes it with a declined result and no saved payment.');await agentReview.close();

  const pages=await open('pages');await pages.getByRole('button',{name:'Load more unfinished refills',exact:true}).click();
  assert.equal(await pages.locator('.wallet-refill-pending .wallet-refill-operation').count(),25);assert.equal(await pages.getByRole('button',{name:'Review saved refill',exact:true}).count(),1);
  await pages.locator('.wallet-refill-history > summary').click();await pages.getByRole('button',{name:'Load more history',exact:true}).click();await pages.getByRole('button',{name:'Load more history',exact:true}).click();
  assert.equal(await pages.locator('.wallet-refill-history .wallet-refill-operation').count(),25);assert.equal(await pages.getByRole('button',{name:'Load more history',exact:true}).count(),0);assert.deepEqual(await calls(pages),[]);
  checks.push('Pending and history pages have independent exact cursors; all 50 saved records remain reachable, including the oldest unsent prepared request, without mutations.');await pages.close();

  const operating=await open();await operating.getByRole('button',{name:'Get TCYCLES',exact:true}).click();await operating.getByRole('button',{name:'Neutron cycles',exact:true}).click();await operating.getByText('Neutron balance',{exact:false}).waitFor();
  await operating.getByRole('button',{name:'Max',exact:true}).first().click();assert.equal(await operating.getByRole('textbox',{name:'Amount of Neutron cycles'}).inputValue(),'49.999995');assert.equal((await operating.locator('.wallet-refill-estimate strong').innerText()).trim(),'49.999895 TCYCLES');await writeFile(out+'/operating-max-values.json',JSON.stringify({input:await operating.getByRole('textbox',{name:'Amount of Neutron cycles'}).inputValue(),estimatedNet:(await operating.locator('.wallet-refill-estimate strong').innerText()).trim(),fee:'0.0001 TCYCLES',balance:'55 T cycles'},null,2));
  for(const width of [320,430,1000]){await operating.setViewportSize({width,height:860});assert.equal(await operating.locator('.wallet-refill').evaluate(node=>node.scrollWidth<=node.clientWidth),true);await operating.screenshot({path:out+`/operating-cycles-max-${width}.png`});}
  await operating.getByRole('button',{name:'Convert Neutron cycles',exact:true}).click();await operating.getByRole('dialog',{name:'Owner confirmation: convert Neutron cycles'}).waitFor();assert.equal(await operating.locator('.wallet-refill-review').count(),0);assert.equal(await operating.getByRole('button',{name:'Approve cycle conversion',exact:true}).isDisabled(),true);
  await operating.getByRole('button',{name:'Cancel owner approval',exact:true}).click();assert.equal(await operating.getByRole('alert').count(),0);assert.equal(await operating.evaluate(()=>window.__operating.operations.length),0);
  await operating.getByRole('button',{name:'Convert Neutron cycles',exact:true}).click();await operating.getByRole('checkbox',{name:'I understand this uses my Neutron cycles'}).check();await operating.getByRole('button',{name:'Approve cycle conversion',exact:true}).click();await operating.waitForFunction(()=>window.__operating.operations.some(row=>row.status==='complete'));
  assert.deepEqual(await operating.evaluate(()=>window.__operating.calls.filter(row=>row.method==='deposit').length),1);assert.equal(await operating.evaluate(()=>window.__operating.calls.find(row=>row.method==='review').quote.allowPartial),true);
  checks.push('Operating-cycle Max leaves 5 T plus call costs, allows only downward trimming, and opens a single Kernel owner approval; cancel leaves no saved action or persistent error.');await operating.close();

  const preflight=await open('cycles-preflight');await preflight.getByRole('button',{name:'Get TCYCLES',exact:true}).click();await preflight.getByRole('button',{name:'Neutron cycles',exact:true}).click();await preflight.getByRole('textbox',{name:'Amount of Neutron cycles'}).fill('1');await preflight.getByRole('button',{name:'Convert Neutron cycles',exact:true}).click();await preflight.getByRole('alert').waitFor();assert((await preflight.getByRole('alert').innerText()).includes('No cycles were sent'));assert.equal(await preflight.getByRole('button',{name:'Check conversion',exact:true}).count(),0);assert.equal(await preflight.evaluate(()=>window.__operating.calls.filter(row=>row.method==='deposit').length),0);
  await preflight.getByRole('button',{name:'Convert Neutron cycles',exact:true}).click();await preflight.getByRole('dialog',{name:'Owner confirmation: convert Neutron cycles'}).waitFor();assert.equal(await preflight.getByRole('alert').count(),0);await preflight.getByRole('button',{name:'Cancel owner approval',exact:true}).click();assert.equal(await preflight.evaluate(()=>window.__operating.operations.length),0);checks.push('A trusted pre-dispatch permission failure stays visible but clears the unsent attempt, so the next click can open owner approval instead of getting stuck on Check conversion.');await preflight.close();

  const exact=await open();await exact.getByRole('button',{name:'Get TCYCLES',exact:true}).click();await exact.getByRole('button',{name:'Neutron cycles',exact:true}).click();await exact.getByRole('textbox',{name:'Amount of Neutron cycles'}).fill('50');assert.equal(await exact.getByRole('button',{name:'Convert Neutron cycles',exact:true}).isDisabled(),true);await exact.getByRole('textbox',{name:'Amount of Neutron cycles'}).fill('2');
  await exact.getByText('Advanced options',{exact:true}).click();await exact.getByRole('checkbox',{name:'Send TCYCLES to another account'}).check();await exact.getByRole('textbox',{name:'Recipient principal'}).fill(other);await exact.getByRole('button',{name:'Convert Neutron cycles',exact:true}).click();
  const exactQuote=await exact.evaluate(()=>window.__operating.calls.find(row=>row.method==='review').quote);assert.equal(exactQuote.amountAtoms,'2000000000000');assert.equal(exactQuote.allowPartial,false);assert.equal(exactQuote.target,other);assert.equal(exactQuote.expectedNetAtoms,'1999900000000');await exact.getByRole('button',{name:'Cancel owner approval',exact:true}).click();
  await exact.setViewportSize({width:320,height:860});assert.equal(await exact.locator('.wallet-refill').evaluate(node=>node.scrollWidth<=node.clientWidth),true);await exact.screenshot({path:out+'/operating-cycles-320.png'});checks.push('Entered operating-cycle amounts are exact, over-reserve spending is rejected, and an advanced TCYCLES recipient is retained in the single owner review.');await exact.close();

  const uncertain=await open('cycles-interrupted');await uncertain.getByRole('button',{name:'Get TCYCLES',exact:true}).click();await uncertain.getByRole('button',{name:'Neutron cycles',exact:true}).click();await uncertain.getByRole('textbox',{name:'Amount of Neutron cycles'}).fill('1');await uncertain.getByRole('button',{name:'Convert Neutron cycles',exact:true}).click();await uncertain.getByRole('checkbox',{name:'I understand this uses my Neutron cycles'}).check();await uncertain.getByRole('button',{name:'Approve cycle conversion',exact:true}).click();await uncertain.getByRole('button',{name:'Check conversion',exact:true}).waitFor();
  await uncertain.evaluate(()=>window.__operating.statusErrorCode='ONE_TIME_CYCLE_CALL_NOT_DISPATCHED');await uncertain.getByRole('button',{name:'Check conversion',exact:true}).click();await uncertain.getByRole('alert').waitFor();assert.equal(await uncertain.getByRole('button',{name:'Convert Neutron cycles',exact:true}).count(),0);await uncertain.evaluate(()=>window.__operating.statusErrorCode=null);await uncertain.getByRole('button',{name:'Check conversion',exact:true}).click();assert.equal(await uncertain.evaluate(()=>window.__operating.calls.filter(row=>row.method==='deposit').length),1);assert.equal(await uncertain.evaluate(()=>window.__operating.calls.filter(row=>row.method==='review').length),1);
  await uncertain.reload();await uncertain.waitForFunction(()=>window.__operating.operations.length===1);await uncertain.evaluate(()=>window.__operating.complete=true);
  await uncertain.getByRole('button',{name:'Check progress',exact:true}).click();await uncertain.waitForFunction(()=>window.__operating.operations[0].status==='complete');assert.equal(await uncertain.evaluate(()=>window.__operating.calls.filter(row=>row.method==='deposit'||row.method==='review').length),0);
  checks.push('An interrupted operating-cycle conversion keeps its original ID; repeated clicks and recovery after reload only read the Kernel receipt and never reopen approval or dispatch another deposit.');await uncertain.close();

  const cyclesPages=await open('cycles-pages');await cyclesPages.locator('.wallet-refill-history > summary').filter({hasText:'Neutron cycles conversions'}).click();
  await cyclesPages.getByRole('button',{name:'Load more conversions',exact:true}).click();await cyclesPages.getByRole('button',{name:'Load more conversions',exact:true}).click();assert.equal(await cyclesPages.getByText('Receipt available',{exact:true}).count(),44);assert.equal(await cyclesPages.locator('[aria-label="Pending Neutron cycles conversions"] .wallet-refill-operation').count(),1);assert.equal(await cyclesPages.evaluate(()=>window.__operating.calls.filter(row=>row.method==='status').length),0);
  const receipt=cyclesPages.locator('.wallet-refill-history .wallet-refill-operation').first();await receipt.locator('summary').click();await receipt.getByText('TCYCLES conversion complete',{exact:true}).waitFor();assert.equal(await cyclesPages.evaluate(()=>window.__operating.calls.filter(row=>row.method==='status').length),1);assert.equal(await cyclesPages.getByRole('button',{name:'Dismiss conversion receipt',exact:true}).count(),0);assert((await receipt.innerText()).includes('1.9999 TCYCLES'));
  checks.push('Operating conversion history reaches all45savedcalls throughcompactpages, keeps olderpending accessible, and loads exactlyonefullreceipt on demand without producing a new-action notice.');await cyclesPages.close();

  const tray=await open('tray');await tray.getByRole('textbox',{name:'Amount of ICP'}).fill('0.1');await tray.getByRole('button',{name:'Open Wallet to continue',exact:true}).click();assert.equal(await tray.evaluate(()=>window.__refill.opened),1);assert.deepEqual(await calls(tray),[]);assert.equal(await tray.getByRole('dialog').count(),0);
  checks.push('Tray offers read/quote UI and opens the Wallet tile before financial execution.');await tray.close();
  assert.deepEqual(errors,[]);await writeFile(out+'/results.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
