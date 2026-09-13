/** Actual PublisherPanel release channels and promotion recovery with local fixtures.
 * All nonlocal requests are blocked; no package or canister write is performed. */
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
const out = process.env.MARKETPLACE_PUBLISHER_RELEASE_ARTIFACTS || "/tmp/neutron-marketplace-browser/publisher-releases";
await mkdir(out, { recursive: true });
const fixture = `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { PublisherPanel } from '${root}/apps/marketplace/src/components/publisher.tsx';
  import type { MarketplaceClient, PromotionQuote, PublicationInput, PublicationQuote, PublishedApp } from '${root}/apps/marketplace/src/view-types.ts';
  import '${root}/apps/marketplace/src/style.scss';
  const storageKey = 'publisher-release-fixture:' + location.search;
  const retained = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
  const state = (window as any).publisherReleaseState = {
    quoteCalls: retained.quoteCalls || [], writes: retained.writes || [], pending: retained.pending || [],
    publisherReads: 0, detailReads: [], publicationQuotes: [], publicationWrites: [],
    failPromotion: retained.failPromotion ?? true, holdPromotion: false, releasePromotion: null,
    throwRefresh: false, refreshes: 0, refreshList: null, unexpected: [],
  };
  const save = () => sessionStorage.setItem(storageKey, JSON.stringify({
    quoteCalls: state.quoteCalls, writes: state.writes, pending: state.pending,
    failPromotion: state.failPromotion,
  }));
  const release = (version: string) => ({ candidateId: 'candidate-' + version, version, digest: version.repeat(64).slice(0, 64), sourceDigest: 'e'.repeat(64) });
  const base = {
    title: 'Field Notes', id: 'field-notes', summary: 'Organize notes in your workspace.',
    category: 'Productivity', publisher: 'fixture-publisher', publisherId: 'aae', publisherName: 'AAE',
    priceUsdMicros: '1999999', rating: 4.5, ratingCount: 12,
  };
  const apps: PublishedApp[] = state.apps = [
    { ...base, version: '3', stableVersion: '3', betaVersion: '4', candidateVersion: '5', betaRelease: release('4'), status: 'in_review' },
    { ...base, id: 'reader', title: 'Reader', version: '8', stableVersion: '8', betaVersion: null, candidateVersion: '9', status: 'rejected', rejectionReason: 'Include the matching source for v9.' },
    { ...base, id: 'first-release', title: 'First Release', version: '', stableVersion: null, betaVersion: '1', candidateVersion: '1', betaRelease: release('1'), status: 'approved' },
    { ...base, id: 'unavailable-heads', title: 'Unavailable Heads', version: '10', stableVersion: '10', stableAvailable: false, betaVersion: '11', betaAvailable: false, candidateVersion: '12', status: 'in_review' },
  ];
  const unexpected = async (method: string): Promise<never> => { state.unexpected.push(method); throw Error('Unexpected method ' + method); };
  const client: MarketplaceClient = {
    initialize: () => unexpected('initialize'), connect: () => unexpected('connect'),
    discount: () => unexpected('discount'), setDiscountCode: () => unexpected('setDiscountCode'),
    catalog: () => unexpected('catalog'), detail: () => unexpected('consumer detail'), library: () => unexpected('library'),
    publisherProfile: () => unexpected('publisherProfile'), publisherCatalog: () => unexpected('publisherCatalog'),
    quotePublisherProfile: () => unexpected('quotePublisherProfile'), savePublisherProfile: () => unexpected('savePublisherProfile'),
    earnings: () => unexpected('earnings'), createReferralCode: () => unexpected('createReferralCode'),
    quotePurchase: () => unexpected('quotePurchase'), purchase: () => unexpected('purchase'), operation: () => unexpected('operation'),
    recentOperations: () => unexpected('recentOperations'), resumeOperation: () => unexpected('resumeOperation'),
    cancelEthereumCheckout: () => unexpected('cancelEthereumCheckout'), verifyEthereumTransaction: () => unexpected('verifyEthereumTransaction'),
    quoteInstallation: () => unexpected('quoteInstallation'), install: () => unexpected('install'), openInstallation: () => unexpected('openInstallation'),
    rate: () => unexpected('rate'), comments: () => unexpected('comments'), comment: () => unexpected('comment'),
    quoteWithdrawal: () => unexpected('quoteWithdrawal'), withdraw: () => unexpected('withdraw'),
    ownPublisherProfile: async () => ({ id: 'aae', name: 'AAE', description: 'Apps for your Neutron.', principal: '3rurp-vyaaa-aaaay-aacua-cai', rating: 4.5, ratingCount: 12, totalUsers: '14', statsComplete: true }),
    publisherApps: async () => { state.publisherReads++; return { items: apps.map(app => ({ ...app })), nextCursor: null }; },
    publisherDetail: async (appId) => {
      state.detailReads.push(appId);
      return { ...apps.find(app => app.id === appId)!, title: 'Field Notes publisher draft', description: 'Publisher draft description.', screenshots: [], website: '', audit: null };
    },
    pendingPromotions: async () => [...state.pending],
    quotePromotion: async (appId: string) => {
      state.quoteCalls.push(appId);
      const app = apps.find(app => app.id === appId)!;
      const quote: PromotionQuote = { appId, operationId: 'promotion-request-' + state.quoteCalls.length, release: { ...app.betaRelease! }, cycles: { total: '1700000000', processing: '1700000000', schedule: 'fixture-promotion' }, opaque: { requestId: 'same-request-' + state.quoteCalls.length } };
      state.pending = [quote]; save();
      return quote;
    },
    promote: async (quote: PromotionQuote) => {
      state.writes.push({ sameQuote: quote === state.pending[0], appId: quote.appId, operationId: quote.operationId, release: { ...quote.release }, requestId: (quote.opaque as { requestId: string }).requestId });
      if (state.failPromotion) { state.failPromotion = false; save(); throw Error('Release response interrupted. Continue the retained release.'); }
      save();
      if (state.holdPromotion) await new Promise<void>(resolve => { state.releasePromotion = resolve; });
      const app = apps.find(app => app.id === quote.appId)!;
      app.stableVersion = quote.release.version;
      if (app.betaVersion === quote.release.version) { app.betaVersion = null; app.betaRelease = undefined; }
      state.pending = []; save();
      return { message: 'Version ' + quote.release.version + ' is now stable.' };
    },
    quotePublication: async (input: PublicationInput) => {
      state.publicationQuotes.push(input);
      return { cycles: { total: '23000000', processing: '23000000', schedule: 'fixture-listing' }, bytes: input.packageFile?.size || 0, coverageEndsAt: '', warnings: [], opaque: { identity: 'listing-' + state.publicationQuotes.length } };
    },
    publish: async (input: PublicationInput, quote: PublicationQuote, progress) => {
      state.publicationWrites.push({ packageName: input.packageFile?.name ?? null, releaseNotes: input.releaseNotes, title: input.title, identity: (quote.opaque as { identity: string }).identity });
      progress(100); return { message: input.packageFile ? 'Package submitted for review.' : 'Listing changes saved.' };
    },
  };
  function Fixture() {
    const [refresh, setRefresh] = useState(0);
    state.refreshList = () => setRefresh(value => value + 1);
    return <main className='nt-app mp-app'><div className='mp-shell'><div className='mp-body'><PublisherPanel client={client} connected={true} refresh={refresh} onChanged={() => { state.refreshes++; if (state.throwRefresh) throw Error('Fixture surrounding refresh failed'); }} /></div></div></main>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture />);
`;
await build({ absWorkingDir: root, stdin: { contents: fixture, loader: "tsx", resolveDir: root }, outfile: join(out, "main.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic", logLevel: "warning", plugins: [sassPlugin()] });
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  res.end(file ? await readFile(join(out, file)) : sandboxHtml(req.url));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser, page, fixtureNumber = 0;
const checks = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  page = sandboxPage(await browser.newPage(), errors);
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith("http://127.0.0.1:") ? route.continue() : route.abort());
  const reset = async width => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?fixture=${++fixtureNumber}`);
    await page.assertSandbox();
    await page.getByRole("heading", { name: "Field Notes", exact: true }).waitFor();
  };
  const card = title => page.locator(".mp-publisher-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const rowText = (title, label) => card(title).locator(".mp-publisher-release").filter({ has: page.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }) }).innerText();
  const snapshot = () => page.evaluate(() => ({
    quoteCalls: window.publisherReleaseState.quoteCalls, writes: window.publisherReleaseState.writes,
    pending: window.publisherReleaseState.pending, publicationQuotes: window.publisherReleaseState.publicationQuotes.map(input => ({ appId: input.appId, packageName: input.packageFile?.name ?? null, releaseNotes: input.releaseNotes })),
    publicationWrites: window.publisherReleaseState.publicationWrites, detailReads: window.publisherReleaseState.detailReads,
    refreshes: window.publisherReleaseState.refreshes, unexpected: window.publisherReleaseState.unexpected,
  }));
  const geometry = async () => {
    const value = await page.getByRole("dialog").evaluate(node => ({
      modal: node.open && node.matches(":modal"), overflow: node.scrollWidth > node.clientWidth,
      bodyOverflow: node.querySelector(".mp-modal-body").scrollWidth > node.querySelector(".mp-modal-body").clientWidth,
      documentOverflow: document.documentElement.scrollWidth > innerWidth, right: node.getBoundingClientRect().right,
    }));
    assert.equal(value.modal, true); assert.equal(value.overflow, false); assert.equal(value.bodyOverflow, false); assert.equal(value.documentOverflow, false);
    assert(value.right <= page.viewportSize().width);
  };

  for (const width of [320, 360, 960]) {
    await reset(width);
    assert.match(await rowText("Field Notes", "Stable"), /v3/);
    assert.match(await rowText("Field Notes", "Beta"), /v4/);
    assert.match(await rowText("Field Notes", "Latest candidate"), /v5[\s\S]*Under review/);
    assert.match(await rowText("Reader", "Stable"), /v8/);
    assert.match(await rowText("Reader", "Latest candidate"), /v9[\s\S]*Changes requested/);
    assert.equal(await card("Reader").getByRole("button", { name: /^Release v/ }).count(), 0);
    assert.equal(await card("First Release").getByRole("button", { name: "Release v1", exact: true }).count(), 1);
    assert.match(await rowText("Unavailable Heads", "Stable"), /v10[\s\S]*Unavailable/);
    assert.match(await rowText("Unavailable Heads", "Beta"), /v11[\s\S]*Unavailable/);
    assert.match(await rowText("Unavailable Heads", "Latest candidate"), /v12[\s\S]*Under review/);
    assert.doesNotMatch(await rowText("Unavailable Heads", "Latest candidate"), /Unavailable/);
    assert.equal(await card("Unavailable Heads").getByRole("button", { name: /^Release v/ }).count(), 0, "a revoked beta cannot be offered for release");
    assert.equal((await snapshot()).writes.length, 0);
    await card("Field Notes").getByRole("button", { name: "Release v4", exact: true }).click();
    await page.getByRole("heading", { name: "Release v4 to stable", exact: true }).waitFor();
    assert.equal((await snapshot()).quoteCalls.length, 1);
    assert.equal((await snapshot()).writes.length, 0, "opening release review cannot execute promotion");
    await page.locator(".mp-cost-detail summary").click();
    assert.match(await page.locator(".mp-cost-detail").innerText(), /1,700,000,000 cycles/);
    await geometry();
    await page.screenshot({ path: join(out, `publisher-release-${width}.png`) });
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: "Continue release", exact: true }).click();
    await page.getByRole("heading", { name: "Release v4 to stable", exact: true }).waitFor();
    assert.equal((await snapshot()).quoteCalls.length, 1, "closing and reopening retains the reviewed quote");
  }
  checks.push("Publisher rows show stable v3, beta v4 and pending v5 independently; approved beta-only apps have a Release action and rejected candidates cannot be released. Promotion review shows its cost before a write and fits 320/360/960px.");
  checks.push("Revoked stable v10 and beta v11 are marked Unavailable independently of candidate v12 being under review; the revoked beta has no Release action.");

  await page.getByRole("dialog").getByRole("button", { name: "Release v4", exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByText("Release response interrupted. Continue the retained release.", { exact: true }).waitFor();
  let value = await snapshot();
  assert.equal(value.writes.length, 1, "two synchronous release clicks dispatch once");
  assert.equal(value.writes[0].sameQuote, true);
  assert.equal(value.writes[0].release.version, "4");
  assert.equal(value.writes[0].release.candidateId, "candidate-4");
  assert.equal(value.writes[0].release.digest, "4".repeat(64));
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.evaluate(() => {
    const state = window.publisherReleaseState;
    state.apps[0].betaVersion = "6";
    state.apps[0].betaRelease = { candidateId: "candidate-6", version: "6", digest: "6".repeat(64) };
    state.refreshList();
  });
  await card("Field Notes").locator(".mp-publisher-release").filter({ hasText: /Beta/ }).getByText("v6", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Continue release", exact: true }).click();
  await page.getByRole("heading", { name: "Release v4 to stable", exact: true }).waitFor();
  assert.equal((await snapshot()).quoteCalls.length, 1, "a newer beta does not replace the retained release selection");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await page.assertSandbox();
  await page.getByRole("button", { name: "Continue release v4", exact: true }).click();
  await page.getByRole("heading", { name: "Release v4 to stable", exact: true }).waitFor();
  await page.evaluate(() => { window.publisherReleaseState.holdPromotion = true; window.publisherReleaseState.throwRefresh = true; });
  await page.getByRole("dialog").getByRole("button", { name: "Continue release", exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => window.publisherReleaseState.releasePromotion !== null);
  value = await snapshot();
  assert.equal(value.quoteCalls.length, 1, "page reload recovery cannot requote a retained release");
  assert.equal(value.writes.length, 2);
  assert.deepEqual(value.writes[1], value.writes[0], "resume preserves the same request, candidate, version, digest and recovered quote");
  await page.evaluate(() => window.publisherReleaseState.releasePromotion());
  await page.getByText("Version 4 is now stable.", { exact: true }).waitFor();
  value = await snapshot();
  assert.equal(value.pending.length, 0);
  assert.equal(value.refreshes, 1);
  assert.equal(value.writes.length, 2);
  assert.equal(await page.getByRole("button", { name: "Continue release", exact: true }).count(), 0);
  checks.push("Interrupted promotion resumes the exact candidate, version, digest and request across closing/reopening, a newer beta and page reload. Duplicate clicks dispatch once, and a refresh exception cannot turn confirmed success into another promotion.");

  await reset(360);
  await page.evaluate(() => {
    // The server's beta advances after the card read but before preparation.
    const app = window.publisherReleaseState.apps[0];
    app.betaVersion = "6";
    app.betaRelease = { candidateId: "candidate-6", version: "6", digest: "6".repeat(64) };
  });
  await card("Field Notes").getByRole("button", { name: "Release v4", exact: true }).click();
  await page.getByRole("heading", { name: "Release v6 to stable", exact: true }).waitFor();
  assert.equal((await snapshot()).pending[0].release.version, "6");
  assert.equal((await snapshot()).writes.length, 0);
  checks.push("When beta advances between listing and preparation, review explicitly shows the version returned by the promotion quote before any release is submitted.");

  await reset(360);
  await card("Field Notes").getByRole("button", { name: "Manage", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".mp-publication-form fieldset").disabled);
  assert.equal(await page.getByRole("textbox", { name: "App name", exact: true }).inputValue(), "Field Notes publisher draft");
  assert.deepEqual((await snapshot()).detailReads, ["field-notes"]);
  assert.equal(await page.getByRole("textbox", { name: /^Release notes/ }).count(), 0);
  await page.getByRole("button", { name: "Review publication", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Upload for review", exact: true }).count(), 0);
  assert.equal((await snapshot()).publicationWrites.length, 0);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("Listing changes saved.", { exact: true }).waitFor();
  assert.deepEqual((await snapshot()).publicationWrites, [{ packageName: null, releaseNotes: "", title: "Field Notes publisher draft", identity: "listing-1" }]);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await card("Field Notes").getByRole("button", { name: "Manage", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".mp-publication-form fieldset").disabled);
  await page.getByLabel(/^Neutron package/).setInputFiles({ name: "field-notes-v6.neutron", mimeType: "application/octet-stream", buffer: Buffer.from("local beta package fixture") });
  await page.getByRole("textbox", { name: /^Release notes/ }).fill("Improved note organization.");
  await page.getByRole("button", { name: "Review publication", exact: true }).click();
  await page.getByRole("button", { name: "Upload for review", exact: true }).waitFor();
  assert.match(await page.getByRole("dialog").innerText(), /beta/i);
  assert.equal((await snapshot()).publicationWrites.length, 1, "package quote does not upload or promote");
  assert.equal((await snapshot()).publicationQuotes[1].releaseNotes, "Improved note organization.");
  assert.equal((await snapshot()).quoteCalls.length, 0);
  assert.deepEqual((await snapshot()).unexpected, []);
  checks.push("Manage loads publisher draft details independently of consumer selection. Listing-only edits use Save changes; a selected package exposes release notes and review text explains beta publication.");

  assert.deepEqual(errors, []);
  await writeFile(join(out, "results.json"), JSON.stringify({ checks, errors, viewports: [320, 360, 960] }, null, 2));
  console.log(`Publisher release browser checks passed; artifacts: ${out}`);
} catch (error) {
  await writeFile(join(out, "failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  await page?.screenshot({ path: join(out, "failure.png") });
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
