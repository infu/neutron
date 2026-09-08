/** Real editor and stylesheet; deferred local writes reproduce save/typing races. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = await mkdtemp(join(tmpdir(), "nuance-editor-"));
const fixture = `
  import React, { StrictMode, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { EditorView } from '${root}/apps/nuance/src/editor.tsx';
  import '${root}/apps/nuance/src/style.scss';
  const state = window.fixture = {
    draft: { id: '1', title: 'An article', subtitle: '', body: 'Initial body', tagIds: ['1'], revision: '1',
      created: '1', modified: '1', modifiedBy: 'human', wordCount: '2', isActive: true },
    writes: [], pending: [], publishes: [], discarded: [], notices: [],
    finish(kind = 'ok') {
      const pending = this.pending.shift();
      if (!pending) throw new Error('No pending write');
      if (kind === 'err') return pending.resolve({ err: 'Save failed for this test' });
      if (kind === 'conflict') {
        this.draft = { ...this.draft, body: 'Agent body', modifiedBy: 'agent', revision: String(BigInt(this.draft.revision) + 1n) };
        return pending.resolve({ conflict: structuredClone(this.draft) });
      }
      if (pending.input.expectedRevision !== this.draft.revision) throw new Error('Save reused a stale revision');
      this.draft = { ...this.draft, ...pending.input, revision: String(BigInt(this.draft.revision) + 1n) };
      pending.resolve({ ok: structuredClone(this.draft) });
    },
  };
  const api = {
    draftRead: async () => ({ ok: structuredClone(state.draft) }),
    draftSet: input => { state.writes.push(input); return new Promise(resolve => state.pending.push({ input, resolve })); },
    publish: async () => { state.publishes.push(structuredClone(state.draft)); return { ok: { url: 'https://nuance.xyz/article', isDraft: false } }; },
    draftDiscard: async id => { state.discarded.push(id); return { ok: 'Draft discarded' }; },
  };
  function Fixture() {
    const [shown, setShown] = useState(true); state.show = setShown;
    return <div className="nt-app nuance-app"><div className="nuance-shell"><div className="nuance-content">
      {shown && <EditorView key={state.draft.id} api={api} draftId={state.draft.id} tags={[['1', 'Technology']]}
        onPublished={() => {}} onStatus={text => { state.notices.push(text); setShown(false); }} />}
    </div></div></div>;
  }
  createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);
`;
await build({
  absWorkingDir: root, stdin: { contents: fixture, loader: "tsx", resolveDir: root },
  outfile: join(out, "main.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
  plugins: [sassPlugin(), {
    name: "local-kernel-transport",
    setup(builder) {
      builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "kernel", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const onAppStateChange = () => () => {};
        export const querySelf = () => { throw new Error('Unexpected Kernel read'); };
        export const updateSelf = () => { throw new Error('Unexpected Kernel write'); };
      `, loader: "js" }));
    },
  }], logLevel: "warning",
});
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  res.end(file ? await readFile(join(out, file)) : '<!doctype html><html><head><link rel="stylesheet" href="/main.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith("http://127.0.0.1:") ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const body = page.locator('[data-tid="nuance-editor-body"]');
  const status = page.locator('[data-tid="nuance-editor-status"]');
  const save = page.getByRole("button", { name: "Save now", exact: true });
  const publish = page.getByRole("button", { name: "Publish to Nuance", exact: true });
  await body.waitFor();

  await body.fill("First edit");
  await save.click();
  await page.waitForFunction(() => window.fixture.pending.length === 1);
  await body.fill("Newer typing while the older save is pending");
  await save.click();
  assert.equal(await page.evaluate(() => window.fixture.writes.length), 1, "concurrent save shares the pending request");
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(() => window.fixture.writes.length === 2);
  assert.equal(await page.evaluate(() => window.fixture.writes[1].expectedRevision), "2");
  assert.equal(await page.evaluate(() => window.fixture.writes[1].body), "Newer typing while the older save is pending");
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(() => document.querySelector('[data-tid="nuance-editor-status"]').textContent.includes('rev 3'));
  assert.equal(await body.inputValue(), "Newer typing while the older save is pending");
  assert.match(await status.innerText(), /saved/);

  await body.fill("This must not publish if saving fails");
  await publish.click();
  await page.waitForFunction(() => window.fixture.pending.length === 1);
  await page.evaluate(() => window.fixture.finish('err'));
  await page.getByRole("alert").waitFor();
  assert.equal(await page.evaluate(() => window.fixture.publishes.length), 0);
  assert.equal(await body.isDisabled(), false);
  assert.equal(await body.inputValue(), "This must not publish if saving fails");

  await publish.click();
  await page.waitForFunction(() => window.fixture.pending.length === 1);
  await page.evaluate(() => window.fixture.finish('conflict'));
  await page.getByRole("button", { name: "Keep mine", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.publishes.length), 0);
  assert.equal(await publish.isDisabled(), true);
  await page.getByRole("button", { name: "Keep mine", exact: true }).click();
  await publish.click();
  await page.waitForFunction(() => window.fixture.pending.length === 1);
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(() => window.fixture.publishes.length === 1);
  assert.equal(await page.evaluate(() => window.fixture.publishes[0].body), "This must not publish if saving fails");

  for (const width of [320, 360, 480, 960]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `editor fits ${width}px tile`);
  }
  await page.setViewportSize({ width: 360, height: 900 });
  await page.screenshot({ path: join(out, "editor-360.png") });

  const beforeUnmount = await page.evaluate(() => window.fixture.writes.length);
  await body.fill("Saving before leaving");
  await save.click();
  await page.waitForFunction(() => window.fixture.pending.length === 1);
  await body.fill("Latest typing before leaving the editor");
  await page.evaluate(() => window.fixture.show(false));
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(count => window.fixture.writes.length === count + 2, beforeUnmount);
  await page.evaluate(() => window.fixture.finish());
  assert.equal(await page.evaluate(() => window.fixture.draft.body), "Latest typing before leaving the editor");

  await page.evaluate(() => window.fixture.show(true));
  await body.waitFor();
  await body.fill("Discard during a save");
  await save.click();
  await page.waitForFunction(() => window.fixture.pending.length === 1);
  await page.getByRole("button", { name: "Discard this draft", exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.discarded.length), 0);
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(() => window.fixture.discarded.length === 1);
  assert.equal(await page.evaluate(() => window.fixture.pending.length), 0, "discard does not trigger another unmount save");
  assert.equal(await body.count(), 0);
  assert.deepEqual(errors, []);
  const checks = ["typing survives a delayed save", "concurrent writes use one request and current revision", "failed or conflicting save prevents publish", "explicit conflict resolution publishes the visible body", "320/360/480/960px compact geometry", "unmount flush preserves newer typing", "discard waits for in-flight save without resaving"];
  await writeFile(join(out, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Nuance editor browser checks passed; artifacts: ${out}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
