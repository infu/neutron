/** Real tile/client recovery with a local durable-protocol fixture; no network effects. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = process.env.MARKETPLACE_INSTALL_RECOVERY_ARTIFACTS || "/tmp/neutron-marketplace-ui/install-recovery";
await mkdir(output, { recursive: true });
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '${root}/apps/marketplace/src/app.tsx';
import '${root}/apps/marketplace/src/style.scss';
window.marketplaceTools=new Map();
const owner='3rurp-vyaaa-aaaay-aacua-cai',canisterId='rrkah-fqaaa-aaaaa-aaaaq-cai';
const state=window.installRecovery={calls:[],quotes:[],preparations:[],offers:[],opened:[],gesture:false,installed:false,failed:false,saved:null};
const failureMode=new URL(location.href).searchParams.get('failure')||'ready';
// Expire at the end of this click task. Microtask checkpoints can run between
// native capture and React's delegated listener; the unit handoff test checks
// the stricter before-first-await property directly on the real client.
document.addEventListener('click',()=>{state.gesture=true;setTimeout(()=>state.gesture=false,0)},true);
const app={id:'editor',title:'Canvas Studio',summary:'Create a canvas.',description:'A local app.',category:'Creativity',publisher:owner,priceUsdMicros:'0',version:'101',rating:null,ratingCount:0,owned:true,available:true,installedVersion:null,screenshots:[],audit:null};
const page=items=>({items,nextCursor:null});
const quote=(appIds,id)=>({operationId:id,appIds:[...appIds],canisterId,owner,cycles:{total:'1200000',processing:'1200000',storage:'0',schedule:'1'},fee:{feeVersion:'1',processingCycles:'1200000',storageCycles:'0',totalCycles:'1200000',processingBytes:'100',newStorageBytes:'0'}});
const readyQuote=saved=>({...saved.quote,setupUrl:saved.setupUrl,cycles:{...saved.quote.cycles,total:'0',processing:'0'},fee:{...saved.quote.fee,processingCycles:'0',totalCycles:'0',processingBytes:'0'}});
const operation=saved=>({operationId:saved.quote.operationId,appIds:saved.quote.appIds,state:'pending',nextAction:'resume',message:saved.setupUrl?'The original installation is ready. Open its installer.':'The original preparation reply was interrupted. Continue this saved request.',installation:saved.setupUrl?readyQuote(saved):saved.quote});
function result(value){return {resultJson:JSON.stringify(value)}}
window.marketplaceTransport={callTool(call){
 if(call.target==='kernel'){
  state.offers.push({call:structuredClone(call),gesture:state.gesture});
  if(call.name!=='apps.install_offer'||!state.gesture) return Promise.reject(Object.assign(Error('USER_INTERACTION_REQUIRED: direct tile gesture required'),{code:'USER_INTERACTION_REQUIRED'}));
  if(call.arguments.url!==state.saved?.setupUrl) return Promise.reject(Error('The original setup URL was replaced'));
  return Promise.resolve({presented:true,requestId:'kernel-offer'});
 }
 if(call.target!=='app:marketplace:background')return Promise.reject(Error('Unexpected application endpoint'));
 const method=call.arguments.method,args=JSON.parse(call.arguments.paramsJson);state.calls.push({method,args});
 if(method==='initialize'||method==='connect')return Promise.resolve(result({configured:true,connected:true,canisterId,account:owner,host:'https://icp-api.io'}));
 if(method==='catalog')return Promise.resolve(result(page([app])));
 if(method==='library')return Promise.resolve(result(page([{...app,installedVersion:state.installed?'101':null}])));
 if(method==='detail')return Promise.resolve(result(app));
 if(method==='recentOperations')return Promise.resolve(result(state.saved&&!state.saved.opened?[operation(state.saved)]:[]));
 if(method==='operation')return Promise.resolve(result(operation(state.saved)));
 if(method==='quoteInstallation'){
  const saved=state.saved&&!state.saved.opened&&JSON.stringify(state.saved.quote.appIds)===JSON.stringify(args.appIds)?state.saved:null;
  const value=saved?(saved.setupUrl?readyQuote(saved):saved.quote):quote(args.appIds,args.operationId||'1'.padStart(32,'0'));
  state.quotes.push({requested:args.operationId??null,returned:value.operationId,ready:!!value.setupUrl});
  return Promise.resolve(result(value));
 }
 if(method==='install'){
  state.preparations.push(args.quote.operationId);
  if(state.saved&&state.saved.quote.operationId!==args.quote.operationId)return Promise.reject(Error('Duplicate installation identity'));
  state.saved??={quote:structuredClone(args.quote),setupUrl:null,opened:false};
  if(failureMode==='ready'||state.failed)state.saved.setupUrl='https://'+owner+'.icp0.io/#repo='+canisterId+'&manifest='+'a'.repeat(64)+'&digest='+'b'.repeat(64);
  if(!state.failed){state.failed=true;return Promise.reject(Error('Original installation response interrupted'))}
  return Promise.resolve(result(operation(state.saved)));
 }
 if(method==='installationOpened'){
  state.opened.push(args);state.saved.opened=true;state.installed=true;
  return Promise.resolve(result({operationId:state.saved.quote.operationId,appIds:state.saved.quote.appIds,state:'complete',nextAction:'none',message:'Installer opened.'}));
 }
 return Promise.reject(Error('Unexpected background method '+method));
}};
createRoot(document.getElementById('root')).render(<App/>);
`;
await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic", outfile: join(output, "fixture.js"), plugins: [
  { name: "local-only-install-transport", setup(builder) {
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "transport", namespace: "fixture" }));
    builder.onResolve({ filter: /\/publication\.ts$|^\.\/publication\.ts$/ }, () => ({ path: "publication", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "transport"
      ? "export const callTool=(call)=>window.marketplaceTransport.callTool(call);export const exposeTool=(name,options,handler)=>window.marketplaceTools.set(name,{options,handler});export const removeExposedTool=name=>window.marketplaceTools.delete(name);export const connectEthereumProvider=()=>{throw Error('Unexpected wallet')};export const isJsonObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);export const requestBackendCallReservationsForTool=()=>{throw Error('Unexpected reservation')};"
      : "export const base64=()=>{throw Error('Unexpected publication')};export const preparePublication=base64;export const publicationFiles=base64;export const UPLOAD_CHUNK_BYTES=49152;", loader: "js" }));
  } }, sassPlugin(),
] });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const asset = pathname === "/fixture.js" || pathname === "/fixture.css" ? pathname.slice(1) : null;
  res.setHeader("content-type", asset?.endsWith("js") ? "text/javascript" : asset ? "text/css" : "text/html");
  res.end(asset ? await readFile(join(output, asset)) : '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;background:#06080b}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser, page; const errors = [], checks = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 380, height: 800 } });
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith(url) ? route.continue() : route.abort());
  for (const mode of ["ready", "unknown"]) {
    await page.goto(`${url}/?failure=${mode}`);
    await page.getByRole("button", { name: "My Apps", exact: true }).click();
    await page.getByRole("button", { name: "Install", exact: true }).waitFor();
    await page.getByRole("button", { name: "Install", exact: true }).click();
    await page.getByText("Original installation response interrupted", { exact: true }).first().waitFor();
    const original = await page.evaluate(() => window.installRecovery.preparations[0]);
    assert(original);
    assert.equal(await page.evaluate(() => window.installRecovery.offers.length), 0, "preparation must not attempt a background install offer");
    await page.getByRole("button", { name: "Explore", exact: true }).click();
    await page.getByRole("button", { name: "My Apps", exact: true }).click();
    await page.waitForFunction(() => window.installRecovery.quotes.length >= 2);
    const recovered = await page.evaluate(() => window.installRecovery.quotes.at(-1));
    assert.equal(recovered.returned, original, "remount must recover the existing durable identity");
    if (mode === "unknown") {
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await page.waitForFunction(() => !!window.installRecovery.saved?.setupUrl);
      assert.deepEqual(await page.evaluate(() => window.installRecovery.preparations), [original, original]);
    }
    const opening = page.getByRole("button", { name: /Open installer/i }).first();
    await opening.waitFor();
    await opening.click();
    await page.waitForFunction(() => window.installRecovery.opened.length === 1);
    const observed = await page.evaluate(() => ({ preparations: window.installRecovery.preparations, offers: window.installRecovery.offers, saved: window.installRecovery.saved }));
    assert.deepEqual(observed.preparations, mode === "unknown" ? [original, original] : [original]);
    assert.equal(observed.offers.length, 1);
    assert.equal(observed.offers[0].gesture, true, "the tile handoff must precede any awaited background call");
    assert.equal(observed.offers[0].call.target, "kernel");
    assert.equal(observed.offers[0].call.arguments.url, observed.saved.setupUrl);
    assert.equal(observed.saved.quote.operationId, original);
    await page.screenshot({ path: join(output, `${mode}-recovered.png`) });
    checks.push(`${mode}: interrupted installation survives tab remount with its original ID; the ready click opens the original URL directly from the tile without another prepare.`);
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Marketplace installation recovery browser checks passed. Artifacts: ${output}`);
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") });
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
