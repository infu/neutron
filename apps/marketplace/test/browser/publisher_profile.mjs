/** Local-only publisher-profile regression with real Marketplace UI. Public
 * reads and owner profile writes are fixtures; no network, cycles or uploads. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = process.env.MARKETPLACE_PROFILE_ARTIFACTS || "/tmp/neutron-marketplace-browser/publisher-profile";
await mkdir(out, { recursive: true });
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '${root}/apps/marketplace/src/app.tsx';
import '${root}/apps/marketplace/src/style.scss';
window.marketplaceTools=new Map();
const scenario=new URL(location.href).searchParams;
const principal='3rurp-vyaaa-aaaay-aacua-cai';
const profile={id:'aae',name:'AAE',description:'Independent apps for your Neutron.\\n\\nTools for people and their agents.',principal,rating:4.2,ratingCount:17,totalUsers:'1234',statsComplete:scenario.get('stats')!=='pending'};
const state=window.profileFixture={calls:[],quotes:[],writes:[],copies:[],profile:scenario.get('profile')==='new'?null:{...profile},failQuote:false,failSave:false,holdSave:false,releaseSave:null,latestInput:null,latestQuote:null};
const cycles={total:'1100000',processing:'1100000',schedule:'fixed-v1'};
const listing=(id,title,price='0')=>({id,title,summary:'Useful tools for your Neutron.',category:'Productivity',publisher:principal,publisherId:'aae',publisherName:'AAE',version:'1',priceUsdMicros:price,rating:4.2,ratingCount:17,owned:false,installed:false,freeAcquisitions:'42',paidPurchases:'42'});
const entries=[listing('notes','Quiet Notes'),listing('atlas','Atlas','5000000'),listing('reader','Reader')];
const unexpected=async method=>{state.calls.push(['unexpected',method]);throw Error('Unexpected '+method)};
const client={
 initialize:async()=>({configured:true,canisterId:'aaaaa-aa',host:'https://icp-api.io',account:principal,connected:true}),
 connect:()=>unexpected('connect'),discount:async()=>({code:null,active:false,discountBps:0,affiliate:null,error:null}),recentOperations:async()=>[],
 catalog:async input=>({items:entries.slice(0,2).filter(item=>input.tier==='paid'?item.priceUsdMicros!=='0':item.priceUsdMicros==='0'),nextCursor:null}),
 detail:async id=>{state.calls.push(['detail',id]);return {...entries.find(item=>item.id===id),description:'A useful app.',screenshots:[],audit:null}},
 publisherProfile:async id=>{state.calls.push(['publisherProfile',id]);return {...profile}},
 publisherCatalog:async(id,cursor)=>{state.calls.push(['publisherCatalog',id,cursor??null]);return cursor?{items:[entries[2]],nextCursor:null}:{items:entries.slice(0,2),nextCursor:'public-page-2'}},
 ownPublisherProfile:async()=>{state.calls.push(['ownPublisherProfile']);return state.profile},
 publisherApps:async()=>{state.calls.push(['publisherApps']);return {items:[],nextCursor:null}},
 quotePublisherProfile:async input=>{state.quotes.push({...input});if(state.failQuote){state.failQuote=false;throw Error('Profile quote temporarily unavailable.')}state.latestInput=input;state.latestQuote={input,operation:state.profile?'update':'register',cycles:{...cycles}};return state.latestQuote},
 savePublisherProfile:async(input,quote)=>{state.writes.push({input:{...input},sameInput:input===state.latestInput,sameQuote:quote===state.latestQuote,operation:quote.operation,quotedInput:quote.input});if(state.failSave){state.failSave=false;throw Error('Profile update temporarily unavailable.')}if(state.holdSave)await new Promise(resolve=>state.releaseSave=resolve);state.profile={...profile,...input};return {...state.profile}},
 library:async()=>({items:[],nextCursor:null}),earnings:()=>unexpected('earnings'),quotePublication:()=>unexpected('quotePublication'),publish:()=>unexpected('publish'),
 quotePurchase:()=>unexpected('quotePurchase'),purchase:()=>unexpected('purchase'),quoteInstallation:()=>unexpected('quoteInstallation'),install:()=>unexpected('install'),
};
createRoot(document.getElementById('root')).render(<App client={client}/>);
`;
const transport = `export const exposeTool=(name,options,handler)=>window.marketplaceTools.set(name,{options,handler});export const removeExposedTool=name=>window.marketplaceTools.delete(name);export const copyToClipboard=async text=>{window.profileFixture.copies.push(text)};export const connectEthereumProvider=()=>{throw Error('Unexpected browser wallet connection')};`;
await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic", outfile: join(out, "main.js"), logLevel: "warning", plugins: [
  { name: "local-only-profile-transport", setup(build) {
    build.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "transport", namespace: "fixture" }));
    build.onResolve({ filter: /tile_client\.ts$/ }, () => ({ path: "tile-client", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "transport" ? transport : "export const createMarketplaceClient=()=>{throw Error('Use local fixture')}", loader: "js" }));
  } }, sassPlugin(),
] });
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  res.end(file ? await readFile(join(out, file)) : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/main.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const checks = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 960, height: 760 } });
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith(url) ? route.continue() : route.abort());
  const reset = async query => { await page.goto(url + (query ? `?${query}` : "")); await page.getByRole("button", { name: "Atlas", exact: true }).waitFor(); };
  const state = () => page.evaluate(() => ({ calls:window.profileFixture.calls,quotes:window.profileFixture.quotes,writes:window.profileFixture.writes,profile:window.profileFixture.profile }));
  const noOverflow = async width => {
    const bounds=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth,dialog:[...document.querySelectorAll('dialog')].map(node=>({modal:node.open&&node.matches(':modal'),scroll:node.scrollWidth,client:node.clientWidth,right:node.getBoundingClientRect().right,bodyScroll:node.querySelector('.mp-modal-body').scrollWidth,bodyClient:node.querySelector('.mp-modal-body').clientWidth}))}));
    assert.ok(bounds.document<=width, `document overflow at ${width}: ${JSON.stringify(bounds)}`);
    for(const item of bounds.dialog){assert.equal(item.modal,true);assert.ok(item.scroll<=item.client+1);assert.ok(item.bodyScroll<=item.bodyClient+1);assert.ok(item.right<=width+1);}
  };
  await reset();
  assert.equal(await page.locator('.mp-app-card button button').count(),0);
  const atlas=page.locator('article.mp-app-card').filter({has:page.getByRole('button',{name:'Atlas',exact:true})});
  const publisher=atlas.getByRole('button',{name:'View publisher aae',exact:true});
  const positions=await atlas.evaluate(node=>{const title=node.querySelector('.mp-card-open').getBoundingClientRect(),publisher=node.querySelector('.mp-publisher-link').getBoundingClientRect();return {titleBottom:title.bottom,publisherTop:publisher.top}});
  assert.ok(positions.publisherTop>=positions.titleBottom-1,'publisher ID appears below the app name');
  await publisher.focus();await page.keyboard.press('Enter');
  const profileDialog=page.getByRole('dialog',{name:'Publisher',exact:true});
  await profileDialog.getByRole('heading',{name:'AAE',exact:true}).waitFor();
  assert.deepEqual((await state()).calls.filter(call=>call[0]==='detail'),[],'publisher click must not open app details');
  assert.equal(await profileDialog.locator('.mp-profile-id').innerText(),'aae');
  assert.equal(await profileDialog.locator('.mp-description').innerText(),'Independent apps for your Neutron.\n\nTools for people and their agents.');
  assert.match(await profileDialog.locator('.mp-profile-principal').innerText(),/3rurp-vyaaa-aaaay-aacua-cai/);
  assert.match(await profileDialog.locator('.mp-profile-stats').innerText(),/4\.2 ★/);
  assert.match(await profileDialog.locator('.mp-profile-stats').innerText(),/17 app ratings/);
  assert.match(await profileDialog.locator('.mp-profile-stats').innerText(),/1,234/);
  assert.equal(await profileDialog.locator('article.mp-app-card').count(),2);
  for(const width of [320,380,960]){await page.setViewportSize({width,height:760});await noOverflow(width);await page.screenshot({path:join(out,`public-profile-${width}.png`)});}
  await profileDialog.getByRole('button',{name:'Show more apps',exact:true}).click();
  await profileDialog.getByRole('button',{name:'Reader',exact:true}).waitFor();
  assert.equal(await profileDialog.locator('article.mp-app-card').count(),3);
  assert.equal(await profileDialog.getByRole('button',{name:'Show more apps',exact:true}).count(),0);
  assert.deepEqual((await state()).calls.filter(call=>call[0]==='publisherCatalog'),[['publisherCatalog','aae',null],['publisherCatalog','aae','public-page-2']]);
  await profileDialog.getByRole('button',{name:'Reader',exact:true}).click();
  await page.getByRole('dialog',{name:'Reader',exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog',{name:'Publisher',exact:true}).count(),0);
  assert.deepEqual((await state()).calls.filter(call=>call[0]==='detail'),[['detail','reader']]);
  checks.push('Independent app/publisher controls support keyboard navigation; publisher profiles show identity, principal, aggregate rating, distinct acquired users and paginated public apps, without opening app details on a publisher click. Fits 320/380/960px.');

  await reset('stats=pending');
  await page.getByRole('button',{name:'View publisher aae',exact:true}).first().click();
  await profileDialog.getByText('Ratings updating',{exact:true}).waitFor();
  assert.equal(await profileDialog.locator('.mp-profile-stats strong').allTextContents().then(values=>values.every(value=>value==='—')),true);
  assert.equal(await profileDialog.getByText('No ratings yet',{exact:true}).count(),0,'incomplete aggregates must not look like zero users or no reviews');
  checks.push('Incomplete aggregate backfill is shown as unavailable, not fabricated zero users or ratings.');

  // Owner profile enrollment and editing are checked below using the real Publish tab.
  await reset('profile=new');
  await page.getByRole('button',{name:'Publish',exact:true}).click();
  await page.getByRole('heading',{name:'Create your publisher profile',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Publish an app',exact:true}).count(),0,'publication is gated on profile creation');
  const id=page.getByRole('textbox',{name:'Publisher ID',exact:true});
  const name=page.getByRole('textbox',{name:'Publisher name',exact:true});
  const description=page.getByRole('textbox',{name:'Publisher description',exact:true});
  await name.fill('Future Studio');await description.fill('Our apps help people do more.');
  for(const invalid of ['aa','Aae','abc1','a-b','a'.repeat(21)]){
    await id.fill(invalid);await page.getByRole('button',{name:'Review profile',exact:true}).click();
    assert.equal((await state()).quotes.length,0,`invalid publisher ID ${invalid} must be rejected before a quote`);
    assert.equal((await state()).writes.length,0);
  }
  await id.fill('future');
  await page.evaluate(()=>{window.profileFixture.failQuote=true});
  await page.getByRole('button',{name:'Review profile',exact:true}).click();
  await page.getByText('Profile quote temporarily unavailable.',{exact:true}).waitFor();
  assert.equal(await id.inputValue(),'future');assert.equal(await name.inputValue(),'Future Studio');assert.equal(await description.inputValue(),'Our apps help people do more.');
  await page.getByRole('button',{name:'Review profile',exact:true}).click();
  await page.getByRole('button',{name:'Create profile',exact:true}).waitFor();
  assert.equal((await state()).writes.length,0,'profile review alone does not write');
  assert.match(await page.locator('.mp-profile-form').innerText(),/permanent|cannot be changed/i);
  for(const width of [320,380,960]){await page.setViewportSize({width,height:760});await noOverflow(width);await page.screenshot({path:join(out,`profile-registration-review-${width}.png`)});}
  await page.evaluate(()=>{window.profileFixture.failSave=true});
  await page.getByRole('button',{name:'Create profile',exact:true}).click();
  await page.getByText('Profile update temporarily unavailable.',{exact:true}).waitFor();
  assert.equal((await state()).writes.length,1);
  await page.evaluate(()=>{window.profileFixture.holdSave=true});
  await page.getByRole('button',{name:'Create profile',exact:true}).evaluate(button=>{button.click();button.click()});
  await page.waitForFunction(()=>window.profileFixture.releaseSave!==null);
  assert.equal((await state()).writes.length,2,'double click must not dispatch duplicate registration');
  assert.ok((await state()).writes.every(write=>write.sameInput&&write.sameQuote),'saved review identity must reach write unchanged');
  assert.deepEqual((await state()).writes.map(write=>write.operation),['register','register'],'registration retry preserves the original bound operation');
  assert.ok((await state()).writes.every(write=>JSON.stringify(write.input)===JSON.stringify(write.quotedInput)),'written profile fields match the original reviewed quote');
  await page.evaluate(()=>window.profileFixture.releaseSave());
  await page.getByRole('button',{name:'Publish an app',exact:true}).waitFor();
  assert.equal((await state()).profile.id,'future');
  checks.push('Publish is gated on a profile; IDs reject short, uppercase, digits, punctuation and overlong input before quoting. Registration requires a permanent-ID/name cost review, preserves fields after errors and dispatches once under concurrent clicks.');

  await page.getByRole('button',{name:'Edit profile',exact:true}).click();
  await id.waitFor();
  assert.equal(await id.inputValue(),'future');assert.equal(await id.getAttribute('readonly'),'');
  assert.equal(await name.inputValue(),'Future Studio');assert.equal(await name.getAttribute('readonly'),'');
  await description.fill('Updated description for all our apps.');
  await page.getByRole('button',{name:'Review changes',exact:true}).click();
  await page.getByRole('button',{name:'Save description',exact:true}).waitFor();
  await page.evaluate(()=>{window.profileFixture.holdSave=false});
  await page.getByRole('button',{name:'Save description',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.equal((await state()).profile.id,'future');assert.equal((await state()).profile.name,'Future Studio');assert.equal((await state()).profile.description,'Updated description for all our apps.');
  assert.equal((await state()).writes.at(-1).operation,'update','description changes use a separately reviewed update operation');
  const profileReadsBefore=(await state()).calls.filter(call=>call[0]==='ownPublisherProfile').length;
  await page.evaluate(()=>{window.profileFixture.profile={...window.profileFixture.profile,description:'Changed through the publisher CLI.'}});
  await page.getByRole('button',{name:'Refresh marketplace',exact:true}).click();
  await page.waitForFunction(previous=>window.profileFixture.calls.filter(call=>call[0]==='ownPublisherProfile').length>previous,profileReadsBefore);
  await page.getByRole('button',{name:'Edit profile',exact:true}).click();
  await description.waitFor();
  assert.equal(await description.inputValue(),'Changed through the publisher CLI.','owner Refresh must use the fresh protocol profile after a previous local edit');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  assert.deepEqual((await state()).calls.filter(call=>call[0]==='unexpected'),[]);
  checks.push('An established publisher can change only its description; permanent ID and name remain read-only and survive the exact reviewed update; Refresh imports later CLI changes.');
  assert.deepEqual(errors,[]);
  await writeFile(join(out,'results.json'),JSON.stringify({checks,errors},null,2));
  console.log(`Publisher profile browser checks passed; artifacts: ${out}`);
} catch(error) {
  await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),checks,errors},null,2));
  await page?.screenshot({path:join(out,'failure.png')});throw error;
} finally { await browser?.close();await new Promise(resolve=>server.close(resolve)); }
