/** Actual installation controls and review host with read-only local quotes. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = process.env.MARKETPLACE_INSTALL_BROWSER_ARTIFACTS || "/tmp/neutron-marketplace-ui/install-browser";
await mkdir(output, { recursive: true });
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {InstallControl} from '${root}/apps/marketplace/src/components/install.tsx';
import {AppDetailDialog} from '${root}/apps/marketplace/src/components/detail.tsx';
import {AgentReviewHost} from '${root}/apps/marketplace/src/components/agent_review.tsx';
import '${root}/apps/marketplace/src/style.scss';
window.marketplaceTools=new Map();
const owner='3rurp-vyaaa-aaaay-aacua-cai',canisterId='rrkah-fqaaa-aaaaa-aaaaq-cai';
const initialMode=new URL(location.href).searchParams.get('mode')??'control';
const state=window.installFixture={requests:[],installed:[],prepared:[],handoffs:[],acquired:[],reviews:[],mode:initialMode,rejectInstall:false};
const listing={id:'alpha',title:'Canvas Studio',summary:'Create a canvas.',category:'Creativity',publisher:owner,priceUsdMicros:'0',version:'101',rating:null,ratingCount:0,owned:true};
const quote=(appIds,index,operationId)=>{const total=String(5000000007n+BigInt(index)),processing=String(BigInt(total)-250000000n);return {operationId:operationId??'installation-'+index,appIds:[...appIds],canisterId,owner,cycles:{total,processing,schedule:'fixed-fixture'},sourceAccess:{source:canisterId,feeVersion:'1',cycles:'250000000'},fee:{feeVersion:'1',processingCycles:processing,storageCycles:'0',totalCycles:processing,processingBytes:'128',newStorageBytes:'0'}};};
const client={
 quoteInstallation:(appIds,operationId)=>new Promise((resolve,reject)=>{const index=state.requests.length,saved=state.prepared.find(quote=>operationId?quote.operationId===operationId:JSON.stringify(quote.appIds)===JSON.stringify(appIds));const exact=saved?{...saved,appIds:[...saved.appIds]}:quote(appIds,index,operationId);state.requests.push({appIds:[...appIds],operationId,quote:exact,resolve,reject});if(saved)resolve(exact);}),
 detail:async()=>({...listing,owned:state.mode!=='public',description:'A local installation fixture.',screenshots:[],audit:null}),
 rate:async()=>{},
};
const install=async(ids,quote)=>{
 state.installed.push({ids,operationId:quote.operationId,retained:state.requests.some(request=>request.quote===quote),total:quote.cycles.total});
 if(state.rejectInstall){state.rejectInstall=false;throw Error('Installation fee changed. Refresh the cost before installing.');}
 if(!quote.setupUrl)state.prepared.push({...quote,cycles:{...quote.cycles,total:'0',processing:'0'},sourceAccess:{...quote.sourceAccess,cycles:'0'},fee:{...quote.fee,totalCycles:'0',processingCycles:'0'},setupUrl:'https://marketplace-fixture.invalid/install/'+quote.operationId});
 const saved=state.prepared.find(item=>item.operationId===quote.operationId);
 await new Promise(resolve=>setTimeout(resolve,10));
 state.handoffs.push({operationId:quote.operationId,setupUrl:saved.setupUrl});
 return {operationId:quote.operationId,state:'complete',nextAction:'none',message:'Installer opened.',appIds:ids};
};
function Fixture(){
 const [appIds,setAppIds]=useState(['alpha']),[mode,setMode]=useState(initialMode);
 state.select=ids=>setAppIds(ids);state.setMode=value=>{state.mode=value;setMode(value);};
 return <main className="nt-app mp-app"><div className="mp-shell"><div className="mp-body">
 {mode==='control'&&<InstallControl client={client} appIds={appIds} onInstall={install}/>}
 {(mode==='owned'||mode==='public')&&<AppDetailDialog key={mode} client={client} app={{...listing,owned:mode==='owned'}} close={()=>state.setMode('control')} acquire={app=>state.acquired.push(app.id)} install={install} connected={true} connect={async()=>{}}/>}
 <AgentReviewHost/></div></div></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic", outfile: join(output, "fixture.js"), plugins: [
  { name: "local-only-transport", setup(builder) {
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "transport", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const exposeTool=(name,options,handler)=>window.marketplaceTools.set(name,{options,handler});export const removeExposedTool=name=>window.marketplaceTools.delete(name);export const copyToClipboard=()=>Promise.reject(Error('Unexpected clipboard action in this regression'));export const connectEthereumProvider=()=>{throw Error('Unexpected wallet connection')};", loader: "js" }));
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
  const waitRequests = count => page.waitForFunction(expected => window.installFixture.requests.length === expected, count);
  const resolveQuote = index => page.evaluate(index => { const request=window.installFixture.requests[index]; request.resolve(request.quote); }, index);
  const installed = () => page.evaluate(() => window.installFixture.installed);

  await page.goto(url);
  await waitRequests(1);
  const button = page.getByRole('button', { name: 'Install', exact: true });
  assert.equal(await button.isDisabled(), true);
  assert.deepEqual(await installed(), []);
  await resolveQuote(0);
  await page.getByText('5,000,000,007 cycles', { exact: true }).waitFor();
  assert.equal(await button.isEnabled(), true);
  assert.equal(await page.locator('.mp-install-cost').getAttribute('title'), 'Includes selection preparation and private download access. Neutron reviews app permissions and installation costs next.');
  await button.click();
  await waitRequests(2);
  await page.getByText('Ready · No additional access charge', { exact: true }).waitFor();
  assert.deepEqual(await installed(), [{ids:['alpha'],operationId:'installation-0',retained:true,total:'5000000007'}]);
  assert.equal(await page.getByRole('dialog').count(), 0, 'the existing Install click must not add another owner confirmation');
  assert.equal(await page.evaluate(()=>window.installFixture.requests[1].operationId),'installation-0','successful preparation refreshes only the original request');
  await page.getByText('Ready · No additional access charge', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open installer', exact: true }).count(),0,'normal installation never requires an additional Open installer click');
  assert.deepEqual(await page.evaluate(()=>window.installFixture.handoffs),[{operationId:'installation-0',setupUrl:'https://marketplace-fixture.invalid/install/installation-0'}]);
  assert.equal(await page.evaluate(()=>window.installFixture.prepared.length),1,'one Install click prepares once and opens its handoff');
  await page.evaluate(()=>window.installFixture.setMode('review'));
  // Wait for React to commit the unmount before requesting the next mode;
  // consecutive browser evaluations can otherwise batch into one render.
  await page.locator('.mp-install-control').waitFor({ state: 'detached' });
  await page.evaluate(()=>window.installFixture.setMode('control'));
  await waitRequests(3);
  await page.getByText('Ready · No additional access charge', { exact: true }).waitFor();
  assert.equal(await page.evaluate(()=>window.installFixture.requests[2].operationId),undefined);
  assert.equal(await page.evaluate(()=>window.installFixture.requests[2].quote.operationId),'installation-0','a remounted control discovers the durable prepared request');
  checks.push('Combined preparation and source-access cost is visible before installation; one click opens its handoff, and a remounted control recovers the same ID without another charge.');

  await page.goto(url);
  await waitRequests(1);
  await resolveQuote(0);
  await page.getByText('5,000,000,007 cycles', { exact: true }).waitFor();
  await page.evaluate(() => window.installFixture.select(['beta']));
  await waitRequests(2);
  assert.equal(await page.evaluate(()=>window.installFixture.requests[1].operationId),undefined,'a different selection starts its own request identity');
  assert.equal(await button.isDisabled(), true);
  assert.equal(await page.getByText('5,000,000,007 cycles', { exact: true }).count(), 0);
  await page.evaluate(() => window.installFixture.select(['alpha','beta']));
  await waitRequests(3);
  await resolveQuote(1);
  assert.equal(await button.isDisabled(), true, 'an older selection resolving late cannot enable installation');
  await resolveQuote(2);
  await page.getByText('5,000,000,009 cycles', { exact: true }).waitFor();
  await button.click();
  await waitRequests(4);
  await page.getByText('Ready · No additional access charge', { exact: true }).waitFor();
  assert.deepEqual(await installed(), [{ids:['alpha','beta'],operationId:'installation-2',retained:true,total:'5000000009'}]);
  assert.equal(await page.evaluate(()=>window.installFixture.requests[3].operationId),'installation-2');
  checks.push('Changed selections clear the old quote immediately; late earlier responses cannot install the wrong apps or attach their fee.');

  await page.goto(url);
  await waitRequests(1);
  await page.evaluate(() => window.installFixture.requests[0].reject(Error('Installation quote is temporarily unavailable.')));
  await page.getByRole('alert').getByText('Installation quote is temporarily unavailable.', { exact: true }).waitFor();
  assert.equal(await button.isDisabled(), true);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await waitRequests(2);
  await resolveQuote(1);
  await page.getByText('5,000,000,008 cycles', { exact: true }).waitFor();
  assert.equal(await button.isEnabled(), true);
  assert.deepEqual(await installed(),[]);
  await page.getByRole('button', { name: 'Refresh installation cost', exact: true }).click();
  assert.equal(await button.isDisabled(),true,'refresh invalidates the old fee before another dispatch can occur');
  await waitRequests(3);
  assert.equal(await page.getByText('5,000,000,008 cycles', { exact: true }).count(),0);
  assert.equal(await page.evaluate(()=>window.installFixture.requests[2].operationId),'installation-1');
  await resolveQuote(2);
  await page.getByText('5,000,000,009 cycles', { exact: true }).waitFor();
  assert.deepEqual(await installed(),[]);
  await button.click();
  await waitRequests(4);
  assert.deepEqual(await installed(),[{ids:['alpha'],operationId:'installation-1',retained:true,total:'5000000009'}]);
  checks.push('Failed quotes and cost refreshes only perform reads; stale fees disable dispatch, and the fresh visible fee retains the original request ID.');

  await page.goto(url+'/?mode=owned');
  await waitRequests(1);
  const detail = page.getByRole('dialog', { name: 'Canvas Studio', exact: true });
  const detailInstall = detail.getByRole('button', { name: 'Install app', exact: true });
  assert.equal(await detailInstall.isDisabled(), true);
  await resolveQuote(0);
  await detail.getByText('5,000,000,007 cycles', { exact: true }).waitFor();
  for (const width of [320,380,960]) {
    await page.setViewportSize({width,height:760});
    const layout = await detail.evaluate(node=>({right:node.getBoundingClientRect().right,overflow:node.scrollWidth>node.clientWidth,footerOverflow:node.querySelector('.mp-modal-footer').scrollWidth>node.querySelector('.mp-modal-footer').clientWidth}));
    assert(layout.right <= width); assert.equal(layout.overflow,false); assert.equal(layout.footerOverflow,false);
    await page.screenshot({path:join(output,`owned-detail-${width}.png`)});
  }
  await detailInstall.click();
  await waitRequests(2);
  await detail.getByText('Ready · No additional access charge', { exact: true }).waitFor();
  assert.deepEqual(await installed(), [{ids:['alpha'],operationId:'installation-0',retained:true,total:'5000000007'}]);
  await page.evaluate(() => window.installFixture.setMode('public'));
  await page.getByRole('dialog', { name: 'Canvas Studio', exact: true }).getByRole('button', { name: 'Get app', exact: true }).click();
  assert.deepEqual(await page.evaluate(()=>window.installFixture.acquired),['alpha']);
  assert.equal(await page.evaluate(()=>window.installFixture.requests.length),2,'public acquisition does not quote installation before ownership');
  checks.push('Owned app details share the cost-aware one-click Install control at narrow and wide tile sizes; public Get retains acquisition behavior.');

  await page.goto(url);
  await waitRequests(1);
  await page.evaluate(() => window.installFixture.select(['alpha','beta']));
  await waitRequests(2);
  await page.evaluate(() => window.installFixture.setMode('review'));
  await page.evaluate(() => {
    const review={kind:'installation',quote:window.installFixture.requests[1].quote};
    window.installFixture.reviewResult=null;
    void window.marketplaceTools.get('marketplace_review_v1').handler({reviewJson:JSON.stringify(review)},{agentMode:false,audience:'foreground_tile'}).then(value=>window.installFixture.reviewResult=value);
  });
  const review = page.getByRole('dialog', { name: 'Agent installation request', exact: true });
  await review.getByRole('button', { name: 'Install apps', exact: true }).waitFor();
  const contents = await review.innerText();
  assert.match(contents,/alpha/); assert.match(contents,/beta/);
  assert.match(contents,/5,000,000,008 cycles/);
  assert.match(contents,/rrkah-fqaaa-aaaaa-aaaaq-cai/);
  assert.match(contents,/3rurp-vyaaa-aaaay-aacua-cai/);
  assert.match(contents,/includes selection preparation and private download access/);
  assert.match(contents,/Neutron will review app permissions and installation costs in the installer/);
  await review.getByRole('button', { name: 'Decline', exact: true }).click();
  assert.deepEqual(await page.evaluate(()=>window.installFixture.reviewResult),{approved:false});
  assert.deepEqual(await installed(),[]);
  const invalid = await page.evaluate(async () => {
    const quote=window.installFixture.requests[1].quote;
    try { await window.marketplaceTools.get('marketplace_review_v1').handler({reviewJson:JSON.stringify({kind:'installation',quote:{...quote,cycles:{...quote.cycles,total:'1'}}})},{agentMode:false,audience:'foreground_tile'}); return false; } catch { return true; }
  });
  assert.equal(invalid,true);
  checks.push('Normal agent installation review displays exact apps, principals and cost; declining causes no installation, and inconsistent fee summaries are rejected.');

  await page.goto(url+'/?mode=owned');
  await waitRequests(1);
  await resolveQuote(0);
  await detail.getByText('5,000,000,007 cycles', { exact: true }).waitFor();
  await page.evaluate(() => window.installFixture.rejectInstall=true);
  await detailInstall.evaluate(button=>{button.click();button.click();});
  await detail.getByRole('alert').getByText('Installation fee changed. Refresh the cost before installing.', { exact: true }).waitFor();
  assert.equal((await installed()).length,1,'same-tick clicks must dispatch installation only once');
  assert.equal(await detailInstall.isDisabled(),true,'a rejected installation invalidates its reviewed quote');
  assert.equal(await page.evaluate(()=>window.installFixture.requests.length),1,'rejection must not refresh or retry automatically');
  assert.equal(await page.evaluate(()=>window.installFixture.prepared.length),0);
  await detail.getByRole('button', { name: 'Refresh installation cost', exact: true }).click();
  await waitRequests(2);
  assert.equal(await page.evaluate(()=>window.installFixture.requests[1].operationId),'installation-0');
  await resolveQuote(1);
  await detail.getByText('5,000,000,008 cycles', { exact: true }).waitFor();
  assert.equal((await installed()).length,1,'reviewing a fresh fee must not redispatch installation');
  assert.equal(await detail.getByRole('alert').count(),0);
  await detailInstall.click();
  await waitRequests(3);
  await detail.getByText('Ready · No additional access charge', { exact: true }).waitFor();
  assert.deepEqual((await installed()).at(-1),{ids:['alpha'],operationId:'installation-0',retained:true,total:'5000000008'});
  assert.equal((await installed()).length,2);
  assert.equal(await page.evaluate(()=>window.installFixture.prepared.length),1);
  assert.equal(await page.evaluate(()=>window.installFixture.requests[2].operationId),'installation-0');
  checks.push('Rejected installation errors stay visible in the detail dialog; duplicate clicks dispatch once, and only explicit cost refresh plus another Install prepares the original ID.');
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'results.json'),JSON.stringify({checks,errors},null,2));
  console.log('Marketplace installation browser checks passed. Artifacts: '+output);
} catch (error) {
  await page?.screenshot({path:join(output,'failure.png')});
  await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors},null,2));
  throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
