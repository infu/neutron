/** Actual PublisherPanel with a typed, local-only MarketplaceClient fixture.
 * All nonlocal requests are blocked. This test never uploads real packages,
 * attaches cycles, contacts a canister, or performs financial effects. */
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
const out = process.env.MARKETPLACE_PUBLISHER_ARTIFACTS || "/tmp/neutron-marketplace-browser/publisher";
await mkdir(out, { recursive: true });
const fixture = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { PublisherPanel } from '${root}/apps/marketplace/src/components/publisher.tsx';
  import type { MarketplaceClient, PublicationInput, PublicationQuote, PublishedApp } from '${root}/apps/marketplace/src/view-types.ts';
  import '${root}/apps/marketplace/src/style.scss';
  const state = (window as any).publisherState = {
    quotes: [], writes: [], refreshes: 0, failQuote: true, failUpload: true,
    holdUpload: false, releaseUpload: null, latestInput: null, latestQuote: null,
    throwRefresh: false, unexpected: [], pageRequests: [],
  };
  const rejected: PublishedApp = {
    id: 'field-notes', title: 'Field Notes', summary: 'Organize notes in your workspace.',
    category: 'Productivity', publisher: 'fixture-publisher', publisherId: 'aae', publisherName: 'AAE', priceUsdMicros: '1999999',
    version: '3', rating: null, ratingCount: 0, status: 'rejected',
    rejectionReason: 'Source archive does not match the submitted package. Include the matching source and submit a corrected release.',
  };
  const { rejectionReason: _reason, ...otherFields } = rejected;
  const other: PublishedApp = { ...otherFields, id: 'reader', title: 'Reader', priceUsdMicros: '0', status: 'approved' };
  const unexpected = async (method: string): Promise<never> => { state.unexpected.push(method); throw Error('Unexpected method ' + method); };
  const client: MarketplaceClient = {
    initialize: () => unexpected('initialize'), configure: () => unexpected('configure'), connect: () => unexpected('connect'),
    catalog: () => unexpected('catalog'), library: () => unexpected('library'), earnings: () => unexpected('earnings'),
    createReferralCode: () => unexpected('createReferralCode'), quotePurchase: () => unexpected('quotePurchase'), purchase: () => unexpected('purchase'),
    operation: () => unexpected('operation'),
    quoteInstallation: async (appIds, operationId) => ({operationId: operationId ?? '11111111111111111111111111111111', appIds: [...appIds], canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai', owner: '3rurp-vyaaa-aaaay-aacua-cai', cycles: {total: '1100000', processing: '1100000', schedule: 'fixed-fixture'}, fee: {feeVersion: '1', processingCycles: '1100000', storageCycles: '0', totalCycles: '1100000', processingBytes: '1024', newStorageBytes: '0'}}),
    install: () => unexpected('install'), rate: () => unexpected('rate'),
    quoteWithdrawal: () => unexpected('quoteWithdrawal'), withdraw: () => unexpected('withdraw'),
    ownPublisherProfile: async () => ({id: 'aae', name: 'AAE', description: 'Apps for your Neutron.', principal: '3rurp-vyaaa-aaaay-aacua-cai', rating: 4.5, ratingCount: 12, totalUsers: '14', statsComplete: true}),
    publisherProfile: () => unexpected('publisherProfile'), publisherCatalog: () => unexpected('publisherCatalog'),
    quotePublisherProfile: () => unexpected('quotePublisherProfile'), savePublisherProfile: () => unexpected('savePublisherProfile'),
    publisherApps: async (cursor) => {
      state.pageRequests.push(cursor ?? null);
      return cursor ? {items: [other], nextCursor: null} : {items: [rejected], nextCursor: 'page-2'};
    },
    detail: async (appId) => ({...(appId === other.id ? other : rejected), description: 'A private notebook for research and everyday writing.', screenshots: [], website: 'https://example.invalid', audit: null}),
    quotePublication: async (input: PublicationInput) => {
      state.quotes.push(input);
      if (state.failQuote) { state.failQuote = false; throw Error('Temporary quote connection error.'); }
      const quote: PublicationQuote = {
        cycles: {total: '3000000000', processing: '1000000000', storage: '2000000000', schedule: 'fixture-fixed-1'},
        bytes: [input.packageFile, input.sourceFile, input.iconFile, ...input.screenshotFiles].reduce((n, file) => n + (file?.size ?? 0), 0),
        coverageEndsAt: '2027-09-10T00:00:00.000Z', warnings: [], opaque: { identity: 'publication-' + state.quotes.length },
      };
      state.latestInput = input; state.latestQuote = quote;
      return quote;
    },
    publish: async (input: PublicationInput, quote: PublicationQuote, progress) => {
      state.writes.push({
        sameInput: input === state.latestInput, sameQuote: quote === state.latestQuote,
        samePackage: input.packageFile === state.latestInput.packageFile,
        price: input.priceUsdMicros, quoteIdentity: (quote.opaque as {identity: string}).identity,
        packageName: input.packageFile?.name, sourceName: input.sourceFile?.name,
        screenshots: input.screenshotFiles.map(file => file.name),
      });
      progress(42);
      if (state.failUpload) { state.failUpload = false; throw Error('Upload response interrupted. Continue the retained upload.'); }
      progress(65);
      if (state.holdUpload) await new Promise<void>(resolve => { state.releaseUpload = resolve; });
      progress(100);
      return { message: 'Package submitted for review.' };
    },
  };
  createRoot(document.getElementById('root')!).render(<main className='nt-app mp-app'><div className='mp-shell'><div className='mp-body'><PublisherPanel client={client} connected={true} refresh={0} onChanged={() => { state.refreshes++; if (state.throwRefresh) throw Error('Fixture surrounding view refresh failed'); }} /></div></div></main>);
`;
await build({ absWorkingDir: root, stdin: { contents: fixture, loader: "tsx", resolveDir: root }, outfile: join(out, "main.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic", logLevel: "warning", plugins: [sassPlugin()] });
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  res.end(file ? await readFile(join(out, file)) : sandboxHtml(req.url));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser, page;
const checks = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  page = sandboxPage(await browser.newPage(), errors);
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith("http://127.0.0.1:") ? route.continue() : route.abort());
  const reset = async width => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.assertSandbox();
    await page.getByRole("heading", { name: "Field Notes", exact: true }).waitFor();
  };
  const snapshot = () => page.evaluate(() => ({
    quotes: window.publisherState.quotes.map(input => ({ appId: input.appId, price: input.priceUsdMicros, packageName: input.packageFile?.name, sourceName: input.sourceFile?.name, screenshots: input.screenshotFiles.map(file => file.name) })),
    writes: window.publisherState.writes, refreshes: window.publisherState.refreshes,
    unexpected: window.publisherState.unexpected, pageRequests: window.publisherState.pageRequests,
  }));
  const geometry = async () => {
    const value = await page.getByRole("dialog").evaluate(node => ({ modal: node.open && node.matches(":modal"), overflow: node.scrollWidth > node.clientWidth, bodyOverflow: node.querySelector('.mp-modal-body').scrollWidth > node.querySelector('.mp-modal-body').clientWidth, documentOverflow: document.documentElement.scrollWidth > innerWidth, right: node.getBoundingClientRect().right }));
    assert.equal(value.modal, true); assert.equal(value.overflow, false); assert.equal(value.bodyOverflow, false); assert.equal(value.documentOverflow, false);
    assert(value.right <= page.viewportSize().width);
  };

  for (const width of [320, 360, 480, 960]) {
    await reset(width);
    assert.match(await page.locator('.mp-publisher-card').innerText(), /Changes requested/);
    assert.match(await page.locator('.mp-review-feedback').innerText(), /Source archive does not match/);
    assert.match(await page.locator('.mp-publisher-card').innerText(), /\$1\.999999/);
    await page.getByRole("button", { name: "Manage", exact: true }).click();
    await page.getByRole("textbox", { name: "Description", exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.mp-publication-form fieldset').disabled);
    assert.equal(await page.getByRole("spinbutton", { name: /Price in USD/ }).inputValue(), "1.999999");
    assert.equal(await page.getByRole("textbox", { name: "App ID", exact: true }).getAttribute('readonly'), "");
    await geometry();
    assert.equal((await snapshot()).writes.length, 0);
    await page.screenshot({ path: join(out, `publisher-edit-${width}.png`) });
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
  }
  checks.push("Actual publisher list/edit views preserve $1.999999, show audit rejection reasons and fit 320/360/480/960px without horizontal overflow; browsing/editing sends no writes.");

  await page.getByRole("button", { name: "Show more apps", exact: true }).click();
  await page.getByRole("heading", { name: "Reader", exact: true }).waitFor();
  assert.deepEqual((await snapshot()).pageRequests, [null, 'page-2']);
  assert.equal(await page.getByRole("button", { name: "Show more apps", exact: true }).count(), 0);
  checks.push("Publisher pagination appends the next page and stops at its terminal cursor.");

  await page.getByRole("button", { name: "Publish an app", exact: true }).click();
  assert.equal(await page.getByRole("form", { name: "App publication", exact: true }).count(), 1);
  assert.equal(await page.locator("form").count(), 0, "sandboxed publication must not depend on native forms");
  await page.getByRole("textbox", { name: "App name", exact: true }).press("Enter");
  assert.equal((await snapshot()).quotes.length, 0, "Enter must still validate required publication fields");
  await page.getByRole("textbox", { name: "App name", exact: true }).fill("Pocket Journal");
  await page.getByRole("textbox", { name: "App ID", exact: true }).fill("pocket-journal");
  await page.getByRole("textbox", { name: "Excerpt", exact: true }).fill("A journal in your workspace.");
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Write private notes and organize your ideas.");
  await page.getByRole("textbox", { name: "Description", exact: true }).press("End");
  await page.getByRole("textbox", { name: "Description", exact: true }).press("Enter");
  assert.equal(await page.getByRole("textbox", { name: "Description", exact: true }).inputValue(), "Write private notes and organize your ideas.\n");
  assert.equal((await snapshot()).quotes.length, 0, "textarea Enter adds a newline without requesting review");
  assert.equal(await page.getByRole("textbox", { name: "Category", exact: true }).count(), 0);
  assert.equal(await page.getByRole("textbox", { name: /^Website/ }).count(), 0);
  assert.equal(await page.getByRole("textbox", { name: /^Release notes/ }).count(), 0);
  await page.getByRole("radio", { name: "Paid", exact: true }).check();
  await page.getByRole("spinbutton", { name: /Price in USD/ }).fill("1.999999");
  await page.getByLabel(/^Neutron package/).setInputFiles({ name: "journal.neutron", mimeType: "application/octet-stream", buffer: Buffer.from("local package fixture") });
  await page.getByLabel(/^Offered source archive/).setInputFiles({ name: "journal-source.tar.gz", mimeType: "application/gzip", buffer: Buffer.from("local source fixture") });
  const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="purple"/></svg>');
  await page.getByLabel(/^Screenshots/).setInputFiles([{ name: "screen.svg", mimeType: "image/svg+xml", buffer: image }]);
  for (const invalidPrice of ['0.99', '50.000001']) {
    await page.getByRole("spinbutton", { name: /Price in USD/ }).fill(invalidPrice);
    await page.getByRole("button", { name: "Review publication", exact: true }).click();
    assert.equal((await snapshot()).quotes.length, 0, "out-of-range paid prices cannot enter quote review");
    assert.equal((await snapshot()).writes.length, 0);
  }
  await page.getByRole("spinbutton", { name: /Price in USD/ }).fill("1.999999");
  const excerpt = page.getByRole("textbox", { name: "Excerpt", exact: true });
  const description = page.getByRole("textbox", { name: "Description", exact: true });
  await excerpt.fill("🪐".repeat(256));
  await page.getByRole("button", { name: "Review publication", exact: true }).click();
  await page.getByText("Keep the excerpt to 255 characters or fewer.", { exact: true }).waitFor();
  assert.equal(await excerpt.getAttribute("aria-invalid"), "true");
  assert.match(await page.locator("#mp-publication-excerpt-help").innerText(), /256 \/ 255 characters/);
  assert.equal((await snapshot()).quotes.length, 0);
  await excerpt.fill("🪐".repeat(255));
  await description.fill("🪐".repeat(5001));
  await page.getByRole("button", { name: "Review publication", exact: true }).click();
  await page.getByText("Keep the description to 5,000 characters or fewer.", { exact: true }).waitFor();
  assert.equal(await description.getAttribute("aria-invalid"), "true");
  assert.match(await page.locator("#mp-publication-description-help").innerText(), /5,001 \/ 5,000 characters/);
  assert.equal((await snapshot()).quotes.length, 0);
  await description.fill("🪐".repeat(5000));
  assert.equal(await excerpt.getAttribute("aria-invalid"), "false");
  assert.equal(await description.getAttribute("aria-invalid"), "false");
  assert.match(await page.locator("#mp-publication-excerpt-help").innerText(), /255 \/ 255 characters/);
  assert.match(await page.locator("#mp-publication-description-help").innerText(), /5,000 \/ 5,000 characters/);
  await page.getByRole("textbox", { name: "App name", exact: true }).press("Enter");
  await page.getByText("Temporary quote connection error.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.publisherState.quotes.map(input => [Array.from(input.summary).length, Array.from(input.description).length])), [[255, 5000]]);
  checks.push("Excerpt and description count Unicode characters, preserve the exact 255/5,000-character values and reject overlong text before quoting or uploading.");
  assert.equal((await snapshot()).writes.length, 0);
  assert.equal(await page.getByRole("textbox", { name: "App name", exact: true }).inputValue(), "Pocket Journal");
  assert.match(await page.getByRole("dialog").innerText(), /journal\.neutron/);
  assert.match(await page.getByRole("dialog").innerText(), /journal-source\.tar\.gz/);
  assert.match(await page.getByRole("dialog").innerText(), /screen\.svg/);
  // Closing the editor after an error must not discard its browser File objects.
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Continue draft", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "App name", exact: true }).inputValue(), "Pocket Journal");
  assert.match(await page.getByRole("dialog").innerText(), /journal\.neutron/);
  assert.match(await page.getByRole("dialog").innerText(), /screen\.svg/);
  await page.getByRole("button", { name: "Review publication", exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByRole("button", { name: "Upload for review", exact: true }).waitFor();
  assert.match(await page.locator('.mp-publication-summary').innerText(), /\$1\.999999/);
  assert.deepEqual((await snapshot()).quotes.map(quote => quote.price), ['1999999', '1999999']);
  assert.equal((await snapshot()).writes.length, 0);
  await page.locator('.mp-cost-detail summary').click();
  assert.match(await page.locator('.mp-cost-detail').innerText(), /3,000,000,000 cycles/);
  assert.match(await page.locator('.mp-cost-detail').innerText(), /operator funds storage after year one/);
  assert.match(await page.locator('.mp-cost-detail').innerText(), /No annual renewal/);
  await page.setViewportSize({ width: 320, height: 720 });
  await geometry();
  await page.screenshot({ path: join(out, "publisher-review-320.png") });
  checks.push("Quote failure preserves fields and File selections across closing/reopening; successful review displays the exact micro-dollar price and fixed first-year cost before any upload.");

  // Two synchronous clicks exercise the handler's guard before React can render
  // the disabled button. The first fixture reply is deliberately interrupted.
  await page.getByRole("button", { name: "Upload for review", exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByText("Upload response interrupted. Continue the retained upload.", { exact: true }).waitFor();
  let value = await snapshot();
  assert.equal(value.writes.length, 1);
  assert.equal(value.writes[0].sameInput, true); assert.equal(value.writes[0].sameQuote, true); assert.equal(value.writes[0].samePackage, true);
  assert.equal(await page.getByRole("button", { name: "Edit details", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Continue publication", exact: true }).click();
  await page.evaluate(() => { window.publisherState.holdUpload = true; window.publisherState.throwRefresh = true; });
  await page.getByRole("button", { name: "Continue this upload", exact: true }).press("Enter");
  await page.waitForFunction(() => window.publisherState.releaseUpload !== null);
  value = await snapshot();
  assert.equal(value.quotes.length, 2, "resuming does not create a new quote or upload identity");
  assert.equal(value.writes.length, 2);
  assert.deepEqual(value.writes[1], value.writes[0], "resume uses the exact input/quote/files and saved identity");
  assert.equal(await page.getByRole("button", { name: "Uploading…", exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#mp-publication-progress').getAttribute('value'), '65');
  await page.screenshot({ path: join(out, "publisher-resume-320.png") });
  await page.evaluate(() => window.publisherState.releaseUpload());
  await page.getByText("Package submitted for review.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Continue this upload", exact: true }).count(), 0);
  assert.equal((await snapshot()).writes.length, 2);
  assert.equal((await snapshot()).refreshes, 1);
  assert.deepEqual((await snapshot()).unexpected, []);
  checks.push("Interrupted upload retries the same quoted identity and original File objects, concurrent clicks dispatch once, and a surrounding refresh exception cannot change a successful upload into another retry.");
  checks.push("Publication runs inside Neutron's iframe sandbox without allow-forms: text-input Enter requests one review, textarea Enter preserves newlines, review double clicks quote once, and keyboard upload activation dispatches once without blocked-form console errors.");

  assert.deepEqual(errors, []);
  await writeFile(join(out, "results.json"), JSON.stringify({ checks, errors, viewports: [320, 360, 480, 960] }, null, 2));
  console.log(`Publisher browser checks passed; artifacts: ${out}`);
} catch (error) {
  await writeFile(join(out, "failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  await page?.screenshot({ path: join(out, "failure.png") });
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
