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
const state=window.installRecovery={calls:[],quotes:[],preparations:[],offers:[],opened:[],publicResults:[],gesture:false,installed:false,failed:false,saved:null,retained:{},latestIds:[],latestFailed:false};
const failureMode=new URL(location.href).searchParams.get('failure')||'ready';
const latestMode=failureMode==='revoked'||failureMode==='retired';
// Expire at the end of the click task; installation preparation deliberately
// waits past it to verify the generic handoff does not require live activation.
document.addEventListener('click',()=>{state.gesture=true;setTimeout(()=>state.gesture=false,0)},true);
const app={id:'editor',title:'Canvas Studio',summary:'Create a canvas.',description:'A local app.',category:'Creativity',publisher:owner,priceUsdMicros:'0',version:'101',rating:null,ratingCount:0,owned:true,available:true,installedVersion:null,screenshots:[],audit:null};
const page=items=>({items,nextCursor:null});
const originalId='1'.padStart(32,'0');
const quote=(appIds,id)=>{const amount=latestMode&&id!==originalId?'2400000':'1200000';return {operationId:id,appIds:[...appIds],canisterId,owner,cycles:{total:amount,processing:amount,storage:'0',schedule:'1'},sourceAccess:{source:canisterId,feeVersion:'1',cycles:'0'},fee:{feeVersion:'1',processingCycles:amount,storageCycles:'0',totalCycles:amount,processingBytes:'100',newStorageBytes:'0'}}};
const setupUrl=latest=>'https://'+owner+'.icp0.io/#repo='+canisterId+'&manifest='+(latest?'c':'a').repeat(64)+'&digest='+(latest?'d':'b').repeat(64);
if(failureMode==='revoked'){state.saved={quote:quote(['editor'],originalId),setupUrl:setupUrl(false),opened:false};state.retained[originalId]=state.saved;}
const readyQuote=saved=>({...saved.quote,setupUrl:saved.setupUrl,cycles:{...saved.quote.cycles,total:'0',processing:'0'},fee:{...saved.quote.fee,processingCycles:'0',totalCycles:'0',processingBytes:'0'}});
const savedQuote=saved=>saved.setupUrl?readyQuote(saved):({...saved.quote,...(saved.unavailableReason?{unavailableReason:saved.unavailableReason}:{})});
const operation=saved=>({operationId:saved.quote.operationId,appIds:saved.quote.appIds,state:saved.unavailableReason?'failed':'pending',nextAction:'resume',message:saved.unavailableReason|| (saved.opened?'The package review was opened. This is not an installation receipt. Reopen this saved selection if the review was closed; its prepared download access is retained.':saved.setupUrl?'The original installation is ready. Open its installer.':'The original preparation reply was interrupted. Continue this saved request.'),installation:savedQuote(saved)});
function result(value){state.publicResults.push(structuredClone(value));return {resultJson:JSON.stringify(value)}}
function prepared(saved){const handoff={url:saved.setupUrl,appIds:saved.quote.appIds,access:{source:canisterId,token:'private-install-token',paths:['/packages/editor.v0.0.1.neutron']}};return {resultJson:JSON.stringify({result:operation(saved),handoff})}}
window.marketplaceTransport={async callTool(call){
 if(call.target==='kernel'){
  state.offers.push({call:structuredClone(call),gesture:state.gesture});
  if(call.name!=='apps.install_prepared') throw Error('Only the generic prepared installer should be used');
  if(call.arguments.access?.token!=='private-install-token') throw Error('The private download access was lost');
  if(failureMode==='revoked'&&call.arguments.url===setupUrl(false))return Promise.reject(Error('The selected release is no longer approved'));
  if(call.arguments.url!==state.saved?.setupUrl) return Promise.reject(Error('The original setup URL was replaced'));
  return Promise.resolve({presented:true,requestId:'kernel-offer'});
 }
 if(call.target!=='app:marketplace:background')return Promise.reject(Error('Unexpected application endpoint'));
 const method=call.arguments.method,args=JSON.parse(call.arguments.paramsJson);state.calls.push({method,args});
 if(method==='initialize'||method==='connect')return Promise.resolve(result({configured:true,connected:true,canisterId,account:owner,host:'https://icp-api.io'}));
 if(method==='discount')return Promise.resolve(result({code:null,active:false,discountBps:0,affiliate:null,error:null}));
 if(method==='catalog')return Promise.resolve(result(page(args.tier==='free'?[app]:[])));
 if(method==='library')return Promise.resolve(result(page([{...app,installedVersion:state.installed?'101':null}])));
 if(method==='detail')return Promise.resolve(result(app));
 if(method==='recentOperations')return Promise.resolve(result(state.saved?[operation(state.saved)]:[]));
 if(method==='operation')return Promise.resolve(result(operation(state.saved)));
 if(method==='quoteInstallation'){
  const saved=args.operationId?(state.retained[args.operationId]??(state.saved?.quote.operationId===args.operationId?state.saved:null)):state.saved&&JSON.stringify(state.saved.quote.appIds)===JSON.stringify(args.appIds)?state.saved:null;
  const value=saved?savedQuote(saved):quote(args.appIds,args.operationId||originalId);
  if(latestMode&&args.operationId&&args.operationId!==originalId&&!state.latestIds.includes(args.operationId))state.latestIds.push(args.operationId);
  state.quotes.push({requested:args.operationId??null,returned:value.operationId,ready:!!value.setupUrl});
  return Promise.resolve(result(value));
 }
 if(method==='install'){
  state.preparations.push(args.quote.operationId);
  await new Promise(resolve=>setTimeout(resolve,25));
  if(failureMode==='revoked'&&args.quote.operationId===originalId)return prepared(state.saved);
  if(failureMode==='retired'&&args.quote.operationId===originalId){
   state.saved??={quote:structuredClone(args.quote),setupUrl:null,opened:false};state.retained[originalId]=state.saved;
   if(!state.failed){state.failed=true;return Promise.reject(Error('Original installation response interrupted'))}
   state.saved.unavailableReason='A release in this saved selection is no longer approved or accessible.';
   return Promise.reject(Error(state.saved.unavailableReason));
  }
  if(latestMode){
   if(args.quote.operationId===originalId||!state.latestIds.includes(args.quote.operationId))return Promise.reject(Error('Latest preparation did not use the explicitly reviewed fresh request'));
   state.saved=state.retained[args.quote.operationId]??{quote:structuredClone(args.quote),setupUrl:null,opened:false};state.retained[args.quote.operationId]=state.saved;
   if(!state.latestFailed){state.latestFailed=true;return Promise.reject(Error('Latest preparation response interrupted'))}
   state.saved.setupUrl=setupUrl(true);return prepared(state.saved);
  }
  if(state.saved&&state.saved.quote.operationId!==args.quote.operationId)return Promise.reject(Error('Duplicate installation identity'));
  state.saved??={quote:structuredClone(args.quote),setupUrl:null,opened:false};
  if(failureMode==='success'||failureMode==='ready'||state.failed)state.saved.setupUrl=setupUrl(false);
  if(failureMode!=='success'&&!state.failed){state.failed=true;return Promise.reject(Error('Original installation response interrupted'))}
  return prepared(state.saved);
 }
 if(method==='installationOpened'){
  state.opened.push(args);state.saved.opened=true;
  return Promise.resolve(result(operation(state.saved)));
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
      ? "export const callTool=(call)=>window.marketplaceTransport.callTool(call);export const exposeTool=(name,options,handler)=>window.marketplaceTools.set(name,{options,handler});export const removeExposedTool=name=>window.marketplaceTools.delete(name);export const copyToClipboard=()=>Promise.reject(Error('Unexpected clipboard action in this regression'));export const connectEthereumProvider=()=>{throw Error('Unexpected wallet')};export const isJsonObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);export const requestBackendCallReservationsForTool=()=>{throw Error('Unexpected reservation')};"
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
  await page.goto(`${url}/?failure=success`);
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.waitForFunction(() => window.installRecovery.opened.length === 1);
  const successful = await page.evaluate(() => ({ preparations:window.installRecovery.preparations,offers:window.installRecovery.offers,publicResults:window.installRecovery.publicResults,calls:window.installRecovery.calls }));
  assert.deepEqual(successful.preparations, ["1".padStart(32,"0")]);
  assert.equal(successful.offers.length, 1, "one Install click opens the manifest installer after preparation");
  assert.equal(successful.offers[0].call.name, "apps.install_prepared");
  assert.equal(successful.offers[0].gesture, false, "asynchronous preparation may outlive the original activation");
  assert.equal(successful.offers[0].call.arguments.access.token, "private-install-token");
  assert.equal(JSON.stringify(successful.publicResults).includes("private-install-token"), false, "download tokens must not appear in public operations, quotes or history");
  assert.equal(JSON.stringify(successful.calls).includes("private-install-token"), false, "public background requests must not receive private access tokens");
  assert.equal((await page.locator("body").innerText()).includes("private-install-token"), false);
  assert.equal(await page.getByRole("button", { name: "Open installer", exact: true }).count(), 0, "no second install click is required after successful preparation");
  assert.equal(await page.locator('.mp-operation').count(), 0);
  assert.equal(await page.getByText("Saved request", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "View saved progress", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.installRecovery.installed), false, "presented does not mean installed");
  assert.equal(await page.getByLabel("Select Canvas Studio", { exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  const pendingRow = page.locator('.mp-library-row');
  await pendingRow.getByRole("button", { name: "Install", exact: true }).waitFor();
  assert.equal(await page.locator('.mp-operation').count(), 0, "retained pending handoffs must not return as saved-action cards after remount");
  await pendingRow.getByRole("button", { name: "Install", exact: true }).click();
  await page.waitForFunction(() => window.installRecovery.opened.length === 2);
  const reopened = await page.evaluate(() => ({ preparations:window.installRecovery.preparations,offers:window.installRecovery.offers,saved:window.installRecovery.saved,installed:window.installRecovery.installed }));
  assert.deepEqual(reopened.preparations, ["1".padStart(32,"0"), "1".padStart(32,"0")]);
  assert.deepEqual(reopened.offers[1].call.arguments, reopened.offers[0].call.arguments, "cancel/retry must reuse the exact private handoff");
  assert.equal(reopened.installed, false);
  assert.equal(await page.locator('.mp-operation').count(), 0);
  await page.evaluate(() => { window.installRecovery.installed = true; });
  await page.getByRole("button", { name: "Refresh marketplace", exact: true }).click();
  await pendingRow.getByText("Installed · Up to date", { exact: true }).waitFor();
  assert.equal(await pendingRow.getByRole("button", { name: "Installed", exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.mp-operation').count(), 0, "installed apps must not retain a stale install banner");
  assert.equal(await page.getByText("Saved request", { exact: true }).count(), 0);
  await page.screenshot({ path: join(output, "installed-without-banner.png") });
  checks.push("One Install click opens the generic review with private access confined to the handoff; canceled reviews reuse the saved request after remount without banners, and only a confirmed library read marks the app installed.");
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
    assert.equal(await page.locator(".mp-operation").count(), 0, "interrupted installs recover through the library control without duplicate cards");
    const recovered = await page.evaluate(() => window.installRecovery.quotes.at(-1));
    assert.equal(recovered.returned, original, "remount must recover the existing durable identity");
    const resume = page.locator(".mp-library-row").getByRole("button", { name: "Install", exact: true });
    await resume.click();
    await page.waitForFunction(() => window.installRecovery.opened.length === 1);
    const observed = await page.evaluate(() => ({ preparations: window.installRecovery.preparations, offers: window.installRecovery.offers, saved: window.installRecovery.saved, publicResults:window.installRecovery.publicResults }));
    assert.deepEqual(observed.preparations, [original, original], "recovery always asks the backend for the same saved private handoff");
    assert.equal(observed.offers.length, 1);
    assert.equal(observed.offers[0].gesture, false, "a saved handoff resumes after asynchronous backend work");
    assert.equal(observed.offers[0].call.target, "kernel");
    assert.equal(observed.offers[0].call.name, "apps.install_prepared");
    assert.equal(observed.offers[0].call.arguments.url, observed.saved.setupUrl);
    assert.equal(observed.saved.quote.operationId, original);
    assert.equal(JSON.stringify(observed.publicResults).includes("private-install-token"), false);
    await page.screenshot({ path: join(output, `${mode}-recovered.png`) });
    checks.push(`${mode}: interrupted installation survives tab remount with its original ID; one resume click recovers its private handoff under that same ID and opens the manifest installer.`);
  }
  await page.goto(`${url}/?failure=revoked`);
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  const row = page.locator(".mp-library-row");
  await row.getByRole("button", { name: "Install", exact: true }).waitFor();
  const old = await page.evaluate(() => ({ id: window.installRecovery.saved.quote.operationId, value: JSON.stringify(window.installRecovery.saved), url: window.installRecovery.saved.setupUrl }));
  await row.getByRole("button", { name: "Refresh installation cost", exact: true }).click();
  await page.waitForFunction(() => window.installRecovery.quotes.length >= 2);
  assert.equal(await page.evaluate(() => window.installRecovery.quotes.at(-1).returned), old.id, "ordinary refresh must preserve the old request");
  await row.getByRole("button", { name: "Install", exact: true }).click();
  await row.getByRole("alert").getByText("The selected release is no longer approved", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.installRecovery.latestIds), [], "a rejected old offer must never create a replacement automatically");
  assert.deepEqual(await page.evaluate(() => window.installRecovery.preparations), [old.id]);
  await row.getByRole("button", { name: "Prepare latest selection", exact: true }).click();
  await page.waitForFunction(() => window.installRecovery.latestIds.length === 1);
  await row.getByText("2,400,000 cycles", { exact: true }).waitFor();
  const freshId = await page.evaluate(() => window.installRecovery.latestIds[0]);
  assert.match(freshId, /^[0-9a-f]{32}$/);
  assert.notEqual(freshId, old.id, "the explicit new selection must not rebind the old manifest");
  assert.deepEqual(await page.evaluate(() => window.installRecovery.preparations), [old.id], "reviewing the latest cost must not charge or prepare");
  assert.equal(await page.evaluate(id => JSON.stringify(window.installRecovery.retained[id]), old.id), old.value);
  await row.getByRole("button", { name: "Install", exact: true }).click();
  await row.getByRole("alert").getByText("Latest preparation response interrupted", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.installRecovery.preparations), [old.id, freshId]);
  assert.deepEqual(await page.evaluate(() => window.installRecovery.latestIds), [freshId], "a lost new response must retain that new request rather than generate another");
  await row.getByRole("button", { name: "Refresh installation cost", exact: true }).click();
  await row.getByText("2,400,000 cycles", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.installRecovery.quotes.at(-1).returned), freshId);
  await row.getByRole("button", { name: "Install", exact: true }).click();
  await page.waitForFunction(() => !!window.installRecovery.saved?.setupUrl);
  await page.waitForFunction(() => window.installRecovery.opened.length === 1);
  const refreshed = await page.evaluate(id => ({ preparations: window.installRecovery.preparations, latestIds: window.installRecovery.latestIds, offers: window.installRecovery.offers, old: JSON.stringify(window.installRecovery.retained[id]), current: window.installRecovery.saved }), old.id);
  assert.deepEqual(refreshed.preparations, [old.id, freshId, freshId]);
  assert.deepEqual(refreshed.latestIds, [freshId]);
  assert.equal(refreshed.old, old.value, "the original unavailable record and URL remain unchanged");
  assert.notEqual(refreshed.current.setupUrl, old.url);
  assert.equal(refreshed.offers.length, 2);
  assert.equal(refreshed.offers[0].call.arguments.url, old.url);
  assert.equal(refreshed.offers[1].call.arguments.url, refreshed.current.setupUrl);
  assert.equal(refreshed.offers[1].gesture, false);
  await page.screenshot({ path: join(output, "latest-selection-recovered.png") });
  checks.push("An unavailable prepared release keeps its old ID on refresh. Only Prepare latest selection reads a new ID and cost; explicit Install dispatches it, a lost reply retries that same new ID, and the old record and URL remain unchanged.");
  await page.goto(`${url}/?failure=retired`);
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  const retiredRow = page.locator(".mp-library-row");
  await retiredRow.getByRole("button", { name: "Install", exact: true }).click();
  await retiredRow.getByRole("alert").getByText("Original installation response interrupted", { exact: true }).waitFor();
  assert.equal(await retiredRow.getByRole("button", { name: "Prepare latest selection", exact: true }).count(), 0, "unknown preparation must not be classified as retired");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  await retiredRow.getByRole("button", { name: "Install", exact: true }).click();
  await retiredRow.getByRole("alert").getByText("A release in this saved selection is no longer approved or accessible.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.installRecovery.preparations), ["1".padStart(32, "0"), "1".padStart(32, "0")]);
  assert.deepEqual(await page.evaluate(() => window.installRecovery.latestIds), [], "definitive retirement must not create a new request automatically");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "My Apps", exact: true }).click();
  await retiredRow.getByText("Selection no longer available", { exact: true }).waitFor();
  assert.equal(await retiredRow.getByRole("button", { name: "Install", exact: true }).isDisabled(), true);
  const retired = await page.evaluate(() => ({ id: window.installRecovery.saved.quote.operationId, value: JSON.stringify(window.installRecovery.saved) }));
  assert.equal(await page.evaluate(() => window.installRecovery.saved.setupUrl), null, "original successful preparation reply was never locally saved");
  await retiredRow.getByRole("button", { name: "Refresh installation cost", exact: true }).click();
  await retiredRow.getByText("Selection no longer available", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.installRecovery.quotes.at(-1).returned), retired.id);
  await retiredRow.getByRole("button", { name: "Prepare latest selection", exact: true }).click();
  await retiredRow.getByText("2,400,000 cycles", { exact: true }).waitFor();
  const replacement = await page.evaluate(() => window.installRecovery.latestIds[0]);
  assert.match(replacement, /^[0-9a-f]{32}$/);
  assert.notEqual(replacement, retired.id);
  assert.deepEqual(await page.evaluate(() => window.installRecovery.preparations), [retired.id, retired.id], "reviewing latest selection is read-only");
  await retiredRow.getByRole("button", { name: "Install", exact: true }).click();
  await retiredRow.getByRole("alert").getByText("Latest preparation response interrupted", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.installRecovery.latestIds), [replacement]);
  await retiredRow.getByRole("button", { name: "Refresh installation cost", exact: true }).click();
  await retiredRow.getByText("2,400,000 cycles", { exact: true }).waitFor();
  await retiredRow.getByRole("button", { name: "Install", exact: true }).click();
  await page.waitForFunction(() => window.installRecovery.opened.length === 1);
  assert.deepEqual(await page.evaluate(() => window.installRecovery.preparations), [retired.id, retired.id, replacement, replacement]);
  assert.equal(await page.evaluate(id => JSON.stringify(window.installRecovery.retained[id]), retired.id), retired.value);
  assert.deepEqual(await page.evaluate(() => window.installRecovery.latestIds), [replacement]);
  assert.equal(await page.evaluate(() => window.installRecovery.offers.length), 1);
  assert.equal(await page.evaluate(() => window.installRecovery.offers[0].gesture), false);
  await page.screenshot({ path: join(output, "lost-reply-retired-recovered.png") });
  checks.push("Lost preparation reply followed by definitive retirement survives remount with its original ID and no setup URL. Only explicit Prepare latest selection reviews a fresh ID, the old record is retained, and an interrupted replacement resumes without another ID.");
  assert.deepEqual(errors, []);
  await writeFile(join(output, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Marketplace installation recovery browser checks passed. Artifacts: ${output}`);
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") });
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
