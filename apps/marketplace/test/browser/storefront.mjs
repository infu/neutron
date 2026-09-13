/** Render the real app in Neutron's iframe sandbox. Catalog data and prices are
 * local fixtures; images and copy are the reviewed first-party catalog assets. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sandboxHtml, sandboxPage } from "./sandbox.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = process.env.MARKETPLACE_STOREFRONT_ARTIFACTS || path.join(root, "tmp/marketplace-storefront/screenshots");
await mkdir(output, { recursive: true });
const content = JSON.parse(await readFile(path.join(root, "support/marketplace/catalog/first-party-storefront.json"), "utf8"));
const media = JSON.parse(await readFile(path.join(root, "support/marketplace/catalog/first-party-media.json"), "utf8"));
const names = {};
for (const app of content.apps) {
  const manifest = JSON.parse(await readFile(path.join(root, `apps/${app.appId === "files" ? "vfs" : app.appId}/neutron.json`), "utf8"));
  names[app.appId] = manifest.name;
}
const fixture = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import App from '${root}/apps/marketplace/src/app.tsx';
import '${root}/apps/marketplace/src/style.scss';
const content=${JSON.stringify(content)}, media=${JSON.stringify(media)}, names=${JSON.stringify(names)};
const paid=['chess','aave','agent','wallet','uniswap','curve','hyperliquid','evm_wallet','icpswap','snsgov'];
const order=['jetcreeper','hullshift',...paid,'contacts','mail','files','wagyu','openchat','taggr','nuance','spreadsheet','gemma','kitchensink','mysubnet','hello','blast'];
const state=window.storefrontFixture={calls:[],failTier:null,delay:null};
const listings=order.map(id=>{const app=content.apps.find(app=>app.appId===id), images=media.apps.find(app=>app.appId===id);return {
 id,title:names[id],headline:app.title,subtitle:app.subtitle,summary:app.subtitle,category:'Apps',tags:app.tags.map(id=>content.tags.find(tag=>tag.id===id)),
 iconUrl:images?'/media/'+images.icon:undefined,coverUrl:app.cover?'/media/'+app.cover:images?'/media/'+images.screenshots[0]:undefined,
 publisher:'aaaaa-aa',publisherId:'neutron',publisherName:'Neutron',priceUsdMicros:paid.includes(id)?String([3990000,9990000,14990000,2990000][paid.indexOf(id)%4]):'0',
 version:'100',rating:4.8,ratingCount:42,freeAcquisitions:'1240',paidPurchases:'840',owned:false,installed:false,
};});
const matches=(app,input)=>(!input.tag||app.tags.some(tag=>tag.id===input.tag))&&(!input.search||[app.title,app.headline,app.subtitle,...app.tags.map(tag=>tag.name),'neutron'].join(' ').toLowerCase().includes(input.search.toLowerCase()));
const client={
 initialize:async()=>({configured:true,connected:true,canisterId:'aaaaa-aa',host:location.origin,account:'aaaaa-aa'}),
 discount:async()=>({code:null,active:false,discountBps:0,affiliate:null,error:null}),recentOperations:async()=>[],
 storefront:async input=>{state.calls.push(['storefront',input]);return {tags:content.tags,featured:content.featured.map(id=>listings.find(app=>app.id===id)).filter(app=>matches(app,input))};},
 catalog:async input=>{state.calls.push(['catalog',input]);if(state.failTier===input.tier){state.failTier=null;throw Error('Fixture chart unavailable.');}const rows=listings.filter(app=>(input.tier==='paid'?app.priceUsdMicros!=='0':app.priceUsdMicros==='0')&&matches(app,input)&&!input.exclude?.includes(app.id));const start=Number(input.cursor||0);return {items:rows.slice(start,start+7),nextCursor:start+7<rows.length?String(start+7):null};},
 detail:async id=>({...listings.find(app=>app.id===id),description:'Local visual fixture. Prices and acquisition counts are examples.',screenshots:[],audit:null,ownRating:null}),
 publisherProfile:async()=>({id:'neutron',name:'Neutron',description:'Apps for your Neutron.',principal:'aaaaa-aa',rating:null,ratingCount:0,totalUsers:'0',statsComplete:true}),
 publisherCatalog:async()=>({items:listings,nextCursor:null}),
};
window.storefrontFixture.listings=listings;
createRoot(document.getElementById('root')).render(<App client={client}/>);
`;
await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic", outfile: path.join(output, "main.js"), plugins: [
  { name: "fixture-transport", setup(builder) {
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "transport", namespace: "fixture" }));
    builder.onResolve({ filter: /tile_client\.ts$/ }, () => ({ path: "client", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "client" ? "export const createMarketplaceClient=()=>{throw Error('Use fixture')}" : "export const onAppStateChange=()=>()=>{};export const exposeTool=()=>{};export const removeExposedTool=()=>{};export const copyToClipboard=()=>{};export const connectEthereumProvider=()=>{throw Error('Unexpected wallet call')}", loader: "js" }));
  } }, sassPlugin(),
] });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/media/media/")) {
      const relative = url.pathname.slice("/media/".length), file = path.resolve(root, "support/marketplace/catalog", relative);
      if (!file.startsWith(path.join(root, "support/marketplace/catalog/media/"))) throw Error("Invalid media path");
      response.setHeader("content-type", file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".webp") ? "image/webp" : "image/png");
      response.end(await readFile(file));
    } else if (["/main.js", "/main.css"].includes(url.pathname)) {
      response.setHeader("content-type", url.pathname.endsWith(".js") ? "text/javascript" : "text/css");
      response.end(await readFile(path.join(output, url.pathname.slice(1))));
    } else { response.setHeader("content-type", "text/html"); response.end(sandboxHtml(request.url)); }
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const errors = [], checks = [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
const context = await browser.newContext({ deviceScaleFactor: 2 });
await context.route("**/*", route => route.request().url().startsWith(url) ? route.continue() : route.abort());
const host = await context.newPage(), page = sandboxPage(host, errors);
host.on("pageerror", error => errors.push(error.message));
try {
  await page.setViewportSize({ width: 1422, height: 1106 });
  await page.goto(url);
  await page.getByRole("button", { name: names.jetcreeper, exact: true }).waitFor();
  await page.assertSandbox();
  await page.waitForFunction(() => document.querySelectorAll('.mp-card-medium').length === 8);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => {}))); });
  assert.equal(await page.locator('.mp-card-large').count(), 2);
  for (const tier of ['paid', 'free']) assert.equal(await page.getByRole('region', { name: `Top ${tier}`, exact: true }).locator('.mp-card-medium').count(), 4);
  assert.equal(await page.getByRole('button', { name: names.jetcreeper, exact: true }).count(), 1, 'featured apps are not repeated in the charts');
  const blur = await page.locator('.mp-card-large .mp-card-glass').first().evaluate(el => ({ blur: getComputedStyle(el,'::before').backdropFilter, mask: getComputedStyle(el,'::before').maskImage }));
  assert.match(blur.blur, /blur\(18px\)/); assert.match(blur.mask, /linear-gradient/);
  for (const width of [1422, 1800, 960, 390, 320]) {
    await page.setViewportSize({ width, height: width > 1000 ? 1106 : 900 });
    await page.evaluate(() => { document.querySelector('.mp-body').scrollTop=0; });
    const layout = await page.evaluate(() => { const nav=document.querySelector('.mp-categories'), content=document.querySelector('.mp-discover-content'), body=document.querySelector('.mp-body');return {direction:getComputedStyle(nav).flexDirection,nav:nav.getBoundingClientRect().toJSON(),content:content.getBoundingClientRect().toJSON(),overflow:body.scrollWidth>body.clientWidth+1}; });
    assert.equal(layout.overflow,false,`No horizontal overflow at ${width}`);
    assert.equal(layout.direction,width>=1480?'column':'row');
    if (width>=1480) assert.ok(layout.nav.right < layout.content.left); else assert.ok(layout.nav.bottom <= layout.content.top);
    await page.screenshot({ path: path.join(output, `storefront-${width}.png`) });
  }
  checks.push('Two large featured cards, four medium cards per price tier, compact remainder, no duplicate featured apps, CSS blur/mask, responsive tile categories, DPR 2 screenshots at 320/390/960/1422/1800px.');
  await page.setViewportSize({ width: 1422, height: 1106 });
  await page.getByRole('button',{name:'Show more paid apps',exact:true}).click();
  assert.equal(await page.getByRole('region',{name:'Top paid',exact:true}).locator('.mp-card-small').count(),6);
  assert.equal(await page.getByRole('region',{name:'Top free',exact:true}).locator('.mp-card-small').count(),3);
  await page.evaluate(() => { document.querySelector('.mp-body').scrollTop=0; });
  await page.screenshot({ path: path.join(output, 'storefront-reference.png') });
  await page.getByRole('region',{name:'Top free',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'storefront-free.png') });
  await page.getByRole('button',{name:'Games',exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.mp-card-medium').length===1);
  assert.equal(await page.getByRole('button',{name:names.chess,exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:names.wallet,exact:true}).count(),0);
  await page.getByRole('button',{name:'For you',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search apps',exact:true}).fill('lending');
  await page.getByRole('button',{name:names.aave,exact:true}).waitFor();
  assert.equal(await page.locator('.mp-app-card').count(),1);
  await page.getByRole('button',{name:names.aave,exact:true}).click();
  await page.getByRole('dialog',{name:names.aave,exact:true}).waitFor();
  checks.push('Independent paging keeps the four medium leaders fixed. Tags filter both tiers and featured selection; promotional subtitle search opens the actual app details.');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'results.json'),JSON.stringify({checks,errors,fixture:'Real first-party assets; local illustrative prices and counts; no production requests.'},null,2));
  console.log(`Storefront Playwright checks passed. Screenshots: ${output}`);
} catch (error) { await page.screenshot({path:path.join(output,'failure.png')}); throw error; }
finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
