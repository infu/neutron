/** Local-only feedback regression with real Marketplace detail UI. Reads and
 * writes are fixtures; all external network access is blocked. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sandboxHtml, sandboxPage } from "./sandbox.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = process.env.MARKETPLACE_RATINGS_ARTIFACTS || "/tmp/neutron-marketplace-browser/ratings";
await mkdir(out, { recursive: true });
const stable = { candidateId: "11701", version: "117", digest: "11".repeat(32) };
const beta = { candidateId: "11801", version: "118", digest: "22".repeat(32) };
const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppDetailDialog} from '${root}/apps/marketplace/src/components/detail.tsx';
import '${root}/apps/marketplace/src/style.scss';
const stable=${JSON.stringify(stable)}, beta=${JSON.stringify(beta)};
const owner='3rurp-vyaaa-aaaay-aacua-cai';
const peer='v6g24-3yaaa-aaaay-aacwa-cai';
const releases={stable,beta,promoted:beta,unrated:stable,huge:stable,unpaged:stable,pending:stable};
const comment=(id,author,text)=>({id,owner:author,text,createdAt:'2026-09-01T12:00:00Z',updatedAt:'2026-09-01T12:00:00Z'});
const releaseKey=release=>JSON.stringify([release.candidateId,release.version,release.digest]);
const threads=new Map([
 [releaseKey(stable),[comment('117-peer',peer,'Stable v117 peer comment.'),comment('117-own',owner,'My stable v117 comment.'),comment('117-next',peer,'Stable v117 next page.')]],
 [releaseKey(beta),[comment('118-peer',peer,'Beta v118 peer comment.'),comment('118-own',owner,'My beta v118 comment.'),comment('118-next',peer,'Beta v118 next page.')]],
]);
const state=window.ratingsFixture={calls:[],writes:[],rates:[],scenario:new URL(location.href).searchParams.get('scenario')||'stable',holdComment:false,releaseComment:null,holdPage:false,releasePage:null,show:null};
const buckets={one:'3',two:'6',three:'12',four:'18',five:'21'};
const ownRating={stars:4,text:'Legacy unversioned review must stay out of version comments.'};
function listing(){
 const selectedRelease=releases[state.scenario];
 return {id:'atlas',title:'Atlas',summary:'A focused space for research.',category:'Productivity',publisher:owner,publisherId:'atlas',publisherName:'Atlas Studio',version:selectedRelease.version,selectedRelease,channel:state.scenario==='beta'?'beta':'stable',priceUsdMicros:'0',rating:state.scenario==='unrated'?null:3.8,ratingCount:state.scenario==='unrated'?0:60,ratingBuckets:state.scenario==='unrated'?{one:'0',two:'0',three:'0',four:'0',five:'0'}:state.scenario==='huge'?{one:'9007199254740993',two:'2',three:'3',four:'4',five:'5'}:{...buckets},ratingHistogramComplete:state.scenario!=='pending',owned:true,installed:true,installedVersion:'118'};
}
function detail(){
 const selected=listing(), rows=threads.get(releaseKey(selected.selectedRelease));
 return {...selected,description:'Organize research and ideas.',screenshots:[],audit:null,ownRating:state.scenario==='unrated'?null:{...ownRating},comments:state.scenario==='unpaged'?undefined:{items:rows.slice(0,2).map(row=>({...row})),nextCursor:'page-2'},ownComment:{...rows.find(row=>row.owner===owner)}};
}
const client={
 detail:async id=>{state.calls.push(['detail',id]);return detail()},
 rate:async(id,stars,text)=>{state.rates.push({id,stars,text});const names=['one','two','three','four','five'];buckets[names[ownRating.stars-1]]=String(BigInt(buckets[names[ownRating.stars-1]])-1n);buckets[names[stars-1]]=String(BigInt(buckets[names[stars-1]])+1n);ownRating.stars=stars;ownRating.text=text},
 comments:async(id,release,cursor)=>{
  state.calls.push(['comments',id,{...release},cursor??null]);
  const rows=threads.get(releaseKey(release));
  const result={items:rows.slice(cursor?2:0,cursor?undefined:2).map(row=>({...row})),nextCursor:cursor?null:'page-2'};
  if(state.holdPage)await new Promise(resolve=>state.releasePage=resolve);
  return result;
 },
 comment:async(id,release,text)=>{
  state.writes.push({id,release:{...release},text});
  if(state.holdComment)await new Promise(resolve=>state.releaseComment=resolve);
  const rows=threads.get(releaseKey(release)), previous=rows.find(row=>row.owner===owner);
  const saved={...previous,text,updatedAt:'2026-09-13T12:00:00Z'};
  rows.splice(rows.indexOf(previous),1,saved);
  return saved;
 },
};
function Fixture(){
 const [app,setApp]=useState(()=>listing());
 state.show=scenario=>{state.scenario=scenario;setApp(listing())};
 return <div className="marketplace"><AppDetailDialog client={client} app={app} close={()=>{}} acquire={()=>{throw Error('Unexpected acquisition')}} install={()=>{throw Error('Unexpected installation')}} connected={true} connect={async()=>{throw Error('Unexpected connection')}} publisher={()=>{}}/></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const transport = "export const copyToClipboard=async()=>{};";
await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic", outfile: join(out, "main.js"), logLevel: "warning", plugins: [
  { name: "local-only-feedback-transport", setup(build) {
    build.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "transport", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: transport, loader: "js" }));
  } }, sassPlugin(),
] });
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  res.end(file ? await readFile(join(out, file)) : sandboxHtml(req.url));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const checks = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  page = sandboxPage(await browser.newPage({ viewport: { width: 960, height: 800 } }), errors);
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith(url) ? route.continue() : route.abort());
  const dialog = page.getByRole("dialog", { name: "Atlas", exact: true });
  const ratings = dialog.getByRole("region", { name: "Ratings", exact: true });
  const commentsHeading = version => dialog.getByRole("heading", { name: `Comments for v${version}`, exact: true });
  const commentInput = version => dialog.getByRole("textbox", { name: `Your comment for v${version}`, exact: true });
  const show = async scenario => {
    await page.evaluate(scenario => window.ratingsFixture.show(scenario), scenario);
    await commentsHeading(scenario === "beta" || scenario === "promoted" ? "118" : "117").waitFor();
  };
  const reset = async (scenario = "stable") => {
    await page.goto(`${url}/?scenario=${scenario}`);
    await page.assertSandbox();
    await commentsHeading("117").waitFor();
  };
  const state = () => page.evaluate(() => ({ calls: window.ratingsFixture.calls, writes: window.ratingsFixture.writes, rates: window.ratingsFixture.rates }));
  const histogram = async expected => {
    assert.equal(await ratings.locator(".mp-rating-bucket").count(), 5, "the rating histogram always has all five buckets");
    for (const [stars, count] of Object.entries(expected)) {
      const bucket = ratings.locator(`.mp-rating-bucket[data-stars="${stars}"]`);
      assert.equal(await bucket.getAttribute("data-count"), count, `${stars}-star bucket retains the exact decimal count`);
      assert.equal(await bucket.locator(".mp-rating-bucket-count").innerText(), BigInt(count).toLocaleString("en-US"), `${stars}-star count is visible without precision loss`);
    }
  };
  const ordinaryBuckets = { 1: "3", 2: "6", 3: "12", 4: "18", 5: "21" };

  await reset();
  await histogram(ordinaryBuckets);
  assert.match(await ratings.innerText(), /60 ratings/);
  assert.equal(await dialog.locator(".mp-detail-version .mp-badge").count(), 0, "the stable selection has no Beta badge");
  assert.match(await dialog.innerText(), /installed.*118.*waiting|waiting.*stable/i, "an installed beta ahead of stable explains that it is waiting for stable");
  await dialog.getByText("Stable v117 peer comment.", { exact: true }).waitFor();
  assert.equal(await dialog.getByText("Beta v118 peer comment.", { exact: true }).count(), 0);
  assert.equal(await dialog.getByText("Legacy unversioned review must stay out of version comments.", { exact: true }).count(), 0);
  checks.push("Stable details show only v117 comments, retain the five permanent rating buckets, and explain an installed v118 waiting for stable without displaying a Beta badge.");

  await ratings.getByRole("button", { name: "Edit rating", exact: true }).click();
  assert.equal(await ratings.getByRole("textbox").count(), 0, "star ratings have no review-text editor");
  await ratings.getByRole("radio", { name: "5 stars", exact: true }).click();
  await ratings.getByRole("button", { name: "Save rating", exact: true }).click();
  await ratings.getByRole("button", { name: "Edit rating", exact: true }).waitFor();
  assert.deepEqual((await state()).rates, [{ id: "atlas", stars: 5, text: "" }], "the legacy rating method receives stars with empty text");
  ordinaryBuckets[4] = "17";
  ordinaryBuckets[5] = "22";
  await histogram(ordinaryBuckets);
  checks.push("Saving a star rating sends empty review text and exposes no combined review editor.");

  await dialog.getByRole("button", { name: "Edit comment", exact: true }).click();
  assert.equal(await commentInput("117").inputValue(), "My stable v117 comment.");
  await commentInput("117").fill("  Revised stable comment.  ");
  await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
  await dialog.getByText("Revised stable comment.", { exact: true }).waitFor();
  assert.deepEqual((await state()).writes, [{ id: "atlas", release: stable, text: "  Revised stable comment.  " }], "comment edits preserve the submitted text");
  await histogram(ordinaryBuckets);
  await dialog.getByRole("button", { name: "Show more comments", exact: true }).click();
  await dialog.getByText("Stable v117 next page.", { exact: true }).waitFor();
  assert.deepEqual((await state()).calls.filter(call => call[0] === "comments" && call[3]), [["comments", "atlas", stable, "page-2"]]);
  assert.equal(await dialog.getByRole("button", { name: "Show more comments", exact: true }).count(), 0);
  checks.push("Own-comment edits and pagination use the exact displayed candidate, version and digest, while permanent star counts remain unchanged.");

  await dialog.getByRole("button", { name: "Edit comment", exact: true }).click();
  await commentInput("117").fill("Unsaved stable draft must not reach beta.");
  await show("beta");
  await dialog.getByText("Beta v118 peer comment.", { exact: true }).waitFor();
  assert.equal(await dialog.locator(".mp-detail-version .mp-badge").innerText(), "Beta");
  assert.equal(await dialog.getByText("Stable v117 peer comment.", { exact: true }).count(), 0);
  assert.equal(await dialog.getByText("Stable v117 next page.", { exact: true }).count(), 0);
  if (!await commentInput("118").count()) await dialog.getByRole("button", { name: "Edit comment", exact: true }).click();
  assert.equal(await commentInput("118").inputValue(), "My beta v118 comment.", "changing the selected release discards the prior version's unsaved editor text");
  await commentInput("118").fill("Beta feedback retained after promotion.");
  await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
  await dialog.getByText("Beta feedback retained after promotion.", { exact: true }).waitFor();
  assert.deepEqual((await state()).writes.at(-1), { id: "atlas", release: beta, text: "Beta feedback retained after promotion." });
  await dialog.getByRole("button", { name: "Show more comments", exact: true }).click();
  await dialog.getByText("Beta v118 next page.", { exact: true }).waitFor();
  assert.deepEqual((await state()).calls.filter(call => call[0] === "comments" && call[3]).at(-1), ["comments", "atlas", beta, "page-2"]);
  await histogram(ordinaryBuckets);
  await show("promoted");
  await dialog.getByText("Beta feedback retained after promotion.", { exact: true }).waitFor();
  await commentsHeading("118").waitFor();
  assert.equal(await dialog.locator(".mp-detail-version .mp-badge").count(), 0, "promoting the same exact release removes the Beta badge");
  await histogram(ordinaryBuckets);
  checks.push("Switching stable to beta clears unsaved text and stale pages; beta writes and page reads stay bound to v118. Promotion of the same package retains its comments and permanent ratings.");

  await reset();
  await dialog.getByRole("button", { name: "Edit comment", exact: true }).click();
  await commentInput("117").fill("Stable save completed after switching.");
  await page.evaluate(() => { window.ratingsFixture.holdComment = true; });
  await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
  await page.waitForFunction(() => window.ratingsFixture.releaseComment !== null);
  await show("beta");
  await dialog.getByText("Beta v118 peer comment.", { exact: true }).waitFor();
  await page.evaluate(() => window.ratingsFixture.releaseComment());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => !document.body.textContent.includes("Saving…"));
  assert.deepEqual((await state()).writes, [{ id: "atlas", release: stable, text: "Stable save completed after switching." }]);
  assert.equal(await dialog.getByText("Stable save completed after switching.", { exact: true }).count(), 0, "a late stable save does not replace beta comments");
  await dialog.getByText("My beta v118 comment.", { exact: true }).waitFor();
  await reset();
  await page.evaluate(() => { window.ratingsFixture.holdPage = true; });
  await dialog.getByRole("button", { name: "Show more comments", exact: true }).click();
  await page.waitForFunction(() => window.ratingsFixture.releasePage !== null);
  await show("beta");
  await dialog.getByText("Beta v118 peer comment.", { exact: true }).waitFor();
  await page.evaluate(() => window.ratingsFixture.releasePage());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => !document.body.textContent.includes("Loading comments…"));
  assert.equal(await dialog.getByText("Stable v117 next page.", { exact: true }).count(), 0, "a late stable page does not append to beta comments");
  checks.push("Saving and pagination started on stable remain bound to stable when their replies arrive after a beta switch.");

  await reset("unpaged");
  await dialog.getByText("Stable v117 peer comment.", { exact: true }).waitFor();
  assert.deepEqual((await state()).calls.filter(call => call[0] === "comments"), [["comments", "atlas", stable, null]], "an omitted initial page is fetched for the displayed exact release");
  assert.equal(await dialog.locator('[data-comment-id="117-own"]').count(), 1, "the owner's comment occurs once even when returned in the public page");
  checks.push("When detail omits its initial comment page, the standalone comments read uses the exact displayed release and the owner's comment is not duplicated.");

  await reset("pending");
  await ratings.getByText("The rating breakdown is updating.", { exact: true }).waitFor();
  assert.equal(await ratings.locator(".mp-rating-summary-average").innerText(), "3.8");
  assert.equal(await ratings.locator(".mp-rating-summary-count").innerText(), "60 ratings");
  assert.equal(await ratings.locator(".mp-rating-bucket").count(), 5);
  assert.equal(await ratings.locator(".mp-rating-bucket[data-count]").count(), 0, "unfinished histogram counts are unknown rather than fabricated zeroes");
  assert.deepEqual(await ratings.locator(".mp-rating-bucket-count").allTextContents(), ["…", "…", "…", "…", "…"]);
  checks.push("An incomplete histogram retains the known total and average while all five breakdown counts remain explicitly unavailable.");

  await reset("unrated");
  await ratings.getByText("Unrated", { exact: true }).waitFor();
  assert.match(await ratings.innerText(), /0 ratings/);
  await histogram({ 1: "0", 2: "0", 3: "0", 4: "0", 5: "0" });
  await reset("huge");
  await ratings.locator('.mp-rating-bucket[data-stars="1"][data-count="9007199254740993"]').waitFor();
  await histogram({ 1: "9007199254740993", 2: "2", 3: "3", 4: "4", 5: "5" });
  assert.equal(await ratings.locator(".mp-rating-summary-count").innerText(), "9,007,199,254,741,007 ratings", "the rating total sums authoritative buckets without losing integer precision");
  assert.match(await dialog.locator(".mp-detail-stats").innerText(), /9,007,199,254,741,007 ratings/, "the detail header uses the same exact authoritative total");
  for (const width of [360, 960]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = await dialog.evaluate(node => ({ modal: node.open && node.matches(":modal"), viewport: innerWidth, document: document.documentElement.scrollWidth, scroll: node.scrollWidth, client: node.clientWidth, bodyScroll: node.querySelector(".mp-modal-body").scrollWidth, bodyClient: node.querySelector(".mp-modal-body").clientWidth }));
    assert.equal(bounds.modal, true);
    assert.ok(bounds.document <= width && bounds.scroll <= bounds.client + 1 && bounds.bodyScroll <= bounds.bodyClient + 1, `feedback layout fits ${width}px: ${JSON.stringify(bounds)}`);
    const barWidths = await ratings.locator(".mp-rating-bar").evaluateAll(bars => bars.map(bar => bar.getBoundingClientRect().width));
    assert.ok(barWidths.every(barWidth => barWidth > 0) && Math.max(...barWidths) - Math.min(...barWidths) <= 1, `all five buckets share the same visible scale at ${width}px: ${JSON.stringify(barWidths)}`);
    await page.screenshot({ path: join(out, `ratings-${width}.png`) });
  }
  checks.push("Zero ratings show Unrated and 0 ratings with all five empty buckets. Counts above the safe-integer limit stay exact, all five bars share one width, and the detail dialog fits 360px and 960px.");
  assert.deepEqual(errors, []);
  await writeFile(join(out, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Marketplace rating and comment browser checks passed; artifacts: ${out}`);
} catch (error) {
  await writeFile(join(out, "failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  await page?.screenshot({ path: join(out, "failure.png") });
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
