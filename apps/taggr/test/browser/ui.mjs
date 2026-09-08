/** Real app, parsers and styles in a scripts-only sandbox; only local tool replies are mocked. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = await mkdtemp(join(tmpdir(), "taggr-ui-"));
const bus = `
  const f = window.fixture = {
    calls: [], listeners: new Set(), pageFails: true, readFails: false, settingsFails: new URL(location.href).searchParams.has('unavailable'),
    userFails: false, registered: true, importFails: false, deferNew: false, pendingNew: null, pendingPost: null, pendingExport: null, validations: [],
    settings: { canister: '6qfxa-ryaaa-aaaai-qbhsq-cai', domain: 'taggr.link', domainPinned: false, domains: [{ name: 'taggr.link', maxDownvotes: 20, owner: null, scope: 'blacklist', realms: [] }], principal: 'aaaaa-aa', network: 'ic', stored: true, storageError: null },
    post(id, body = 'Post body ' + id) { return [{ id, body, user: 1, timestamp: Date.now() * 1000000, parent: null, children: [], tags: [], realm: null, reactions: {}, files: {}, tree_size: 0 }, { author_name: 'aVeryLongAuthorHandleForNarrowTiles', nsfw: false }]; },
    person() { return { id: 1, name: 'owner', principal: this.settings.principal, num_posts: 2, balance: 1000000, cycles: 20 }; },
    finishPost(ok = true) { const p = this.pendingPost; if (!p) throw new Error('No pending post'); this.pendingPost = null; ok ? p.resolve({ postId: 99 }) : p.reject(new Error('Post rejected for test')); },
    publish() { for (const callback of this.listeners) callback({ revision: String(Date.now()) }); },
  };
  export const loadTileContext = () => ({ app: 'taggr', tile: 'main' });
  export const onAppStateChange = (topic, cb) => { f.listeners.add(cb); return () => f.listeners.delete(cb); };
  export const onTileViewRequest = () => () => {};
  export const copyToClipboard = async () => {};
  export async function callTool(request) {
    if (request.target !== 'app:taggr:background') throw new Error('Unexpected target');
    const a = request.arguments; f.calls.push({ name: request.name, args: structuredClone(a) });
    switch (request.name) {
      case 'ui_settings': if (f.settingsFails) throw new Error('Settings unavailable'); return structuredClone(f.settings);
      case 'ui_add_post': return new Promise((resolve, reject) => { f.pendingPost = { resolve, reject, args: structuredClone(a) }; });
      case 'ui_identity':
        if (a.action === 'export') return new Promise(resolve => { f.pendingExport = () => resolve({ backup: 'mock-secret-do-not-retain' }); });
        if (a.action === 'import' && f.importFails) throw new Error('Restore rejected');
        f.settings.principal = a.action === 'reset' ? '2vxsx-fae' : 'rrkah-fqaaa-aaaaa-aaaaq-cai'; f.registered = false;
        return { principal: f.settings.principal };
      case 'ui_registration_quote': return { amountAtoms: '10000', paid: false, account: 'mock-own-invoice' };
      case 'ui_validate_username': return new Promise(resolve => { f.validations.push({ name: a.name, resolve }); });
      case 'ui_read': {
        const p = JSON.parse(a.payload); let result;
        if (a.method === 'user') { if (f.userFails) throw new Error('Account read unavailable'); result = f.registered ? f.person() : null; }
        else if (a.method === 'stats') result = { users: 3, posts: 31, comments: 0, realms: 1 };
        else if (a.method === 'recent_tags') result = [];
        else if (a.method === 'hot_posts') {
          if (f.readFails) throw new Error('Feed read unavailable');
          if (p[2] === 1 && f.pageFails) { f.pageFails = false; throw new Error('Page one failed'); }
          result = p[2] === 0 ? Array.from({ length: 30 }, (_, i) => f.post(i + 1)) : [f.post(30), f.post(31)];
        }
        else if (a.method === 'last_posts') {
          if (f.deferNew) { f.deferNew = false; return new Promise(resolve => { f.pendingNew = () => resolve({ json: JSON.stringify([f.post(88, 'Abandoned newest reply')]) }); }); }
          result = [f.post(88, 'Newest post')];
        }
        else if (a.method === 'thread') { if (f.readFails) throw new Error('Thread read unavailable'); result = [f.post(p, 'Thread body ' + p)]; }
        else if (a.method === 'posts') result = p.map(id => f.post(id));
        else if (a.method === 'user_posts') result = [f.post(7, 'Profile post')];
        else if (a.method === 'posts_by_tags') result = [f.post(8, 'Tag post')];
        else if (a.method === 'search') {
          if (p[1] === 'broken') throw new Error('Search unavailable');
          result = [{ id: 7, user_id: 0, generic_id: '', result: 'user', relevant: 'another-user' },
            { id: 0, user_id: 0, generic_id: 'ICP', result: 'realm', relevant: 'ICP realm' },
            { id: 0, user_id: 0, generic_id: '', result: 'tag', relevant: 'one' },
            { id: 0, user_id: 0, generic_id: '', result: 'tag', relevant: 'two' }];
        }
        else if (a.method === 'realm_search') result = [['AnExtremelyLongRealmNameForCompactFrames', { description: 'A community description that wraps', num_members: 1234, num_posts: 321 }]];
        else throw new Error('Unexpected read ' + a.method);
        return { json: JSON.stringify(result) };
      }
      case 'ui_write': return { json: JSON.stringify({ Ok: true }) };
      default: throw new Error('Unexpected tool ' + request.name);
    }
  }
`;
await build({
  absWorkingDir: root, entryPoints: [join(root, "apps/taggr/src/index.tsx")],
  outfile: join(out, "main.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
  plugins: [sassPlugin(), {
    name: "mock-local-tool-bus",
    setup(builder) {
      builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "bus", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: bus, loader: "js" }));
    },
  }], logLevel: "warning",
});
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", file === "main.js" ? "text/javascript" : file ? "text/css" : "text/html");
  res.end(file ? await readFile(join(out, file)) : req.url.startsWith('/tile') ? '<!doctype html><html><head><link rel="stylesheet" href="/main.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/main.js"></script></body></html>' : '<!doctype html><html><body style="margin:0"><iframe title="Taggr" sandbox="allow-scripts" src="/tile" style="width:100vw;height:100vh;border:0;display:block"></iframe></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
let page;
try {
  const executablePath = process.env.CHROMIUM_PATH || ["/run/current-system/sw/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => route.request().url().startsWith("http://127.0.0.1:") ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const frame = await page.locator('iframe').elementHandle().then(handle => handle.contentFrame());
  await frame.locator('article').first().waitFor();
  const more = frame.getByRole('button', { name: 'Load more', exact: true });
  await more.click();
  await frame.getByRole('alert').filter({ hasText: 'Page one failed' }).waitFor();
  await more.click();
  await frame.getByText('Post body 31', { exact: true }).waitFor();
  const pages = await frame.evaluate(() => window.fixture.calls.filter(c => c.name === 'ui_read' && c.args.method === 'hot_posts').map(c => JSON.parse(c.args.payload)[2]));
  assert.deepEqual(pages, [0, 1, 1], 'failed page retries the same page');
  assert.equal(await frame.locator('article').count(), 31, 'overlapping pages do not duplicate posts');

  await frame.evaluate(() => { window.fixture.deferNew = true; });
  await frame.getByRole('button', { name: 'Newest posts', exact: true }).click();
  await frame.waitForFunction(() => !!window.fixture.pendingNew);
  assert.equal(await frame.locator('article').count(), 0, 'new view cannot show old feed');
  await frame.getByRole('button', { name: 'Hot posts', exact: true }).click();
  await frame.getByText('Post body 1', { exact: true }).waitFor();
  await frame.evaluate(() => window.fixture.pendingNew());
  assert.equal(await frame.getByText('Abandoned newest reply', { exact: true }).count(), 0);

  await frame.getByRole('button', { name: 'Write a post', exact: true }).click();
  const draft = frame.getByRole('textbox', { name: 'Post body', exact: true });
  const publish = frame.getByRole('button', { name: 'Publish to Taggr', exact: true });
  await draft.fill('First submitted body');
  await publish.click();
  await frame.waitForFunction(() => !!window.fixture.pendingPost);
  await draft.fill('Newer typing while publishing');
  await frame.evaluate(() => window.fixture.finishPost());
  await frame.getByText('Published post #99', { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), 'Newer typing while publishing', 'confirmed publication preserves newer typing');
  await publish.click();
  await frame.waitForFunction(() => !!window.fixture.pendingPost);
  await frame.getByRole('button', { name: 'Discard this draft', exact: true }).click();
  await frame.getByRole('button', { name: 'Write a post', exact: true }).click();
  await draft.fill('A different draft');
  await frame.evaluate(() => window.fixture.finishPost());
  await frame.waitForFunction(() => !window.fixture.pendingPost);
  assert.equal(await draft.inputValue(), 'A different draft', 'late publication never closes a replacement draft');
  await publish.click();
  await frame.waitForFunction(() => !!window.fixture.pendingPost);
  await frame.evaluate(() => window.fixture.finishPost(false));
  await frame.getByRole('alert').filter({ hasText: 'Post rejected for test' }).waitFor();
  assert.equal(await draft.inputValue(), 'A different draft');
  await frame.getByRole('button', { name: 'Discard this draft', exact: true }).click();

  await frame.getByRole('button', { name: 'Settings', exact: true }).click();
  await frame.getByRole('button', { name: 'Show identity backup', exact: true }).click();
  await frame.waitForFunction(() => !!window.fixture.pendingExport);
  await frame.getByRole('button', { name: 'Hot posts', exact: true }).click();
  await frame.evaluate(() => window.fixture.pendingExport());
  await frame.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await frame.getByRole('textbox', { name: 'Taggr identity backup', exact: true }).count(), 0, 'late export cannot reveal in another view');
  await frame.getByRole('button', { name: 'Start a new identity', exact: true }).click();
  await frame.getByRole('button', { name: 'Replace the key', exact: true }).click();
  await frame.getByText('New identity 2vxsx-fae', { exact: true }).waitFor();
  assert.equal(await frame.getByTitle('2vxsx-fae', { exact: true }).count(), 1, 'identity change updates displayed principal');

  await frame.getByRole('button', { name: 'Check the price', exact: true }).click();
  const handle = frame.getByPlaceholder('2-16 letters and digits', { exact: true });
  const registration = frame.getByRole('heading', { name: 'Register on Taggr', exact: true });
  await handle.fill('oldname'); await registration.click();
  await handle.fill('newname'); await registration.click();
  await frame.waitForFunction(() => window.fixture.validations.length === 2);
  await frame.evaluate(() => {
    window.fixture.validations[1].resolve({ error: null });
    window.fixture.validations[0].resolve({ error: 'Stale handle failure' });
  });
  assert.equal(await frame.getByText('Stale handle failure', { exact: true }).count(), 0);
  const pay = frame.getByRole('button', { name: /^Pay .* ICP and register$/ });
  assert.equal(await pay.isDisabled(), false);
  await handle.fill('takenname'); await registration.click();
  await frame.waitForFunction(() => window.fixture.validations.length === 3);
  await frame.evaluate(() => window.fixture.validations[2].resolve({ error: 'Handle taken' }));
  await frame.getByText('Handle taken', { exact: true }).waitFor();
  await handle.fill('freshname');
  assert.equal(await frame.getByText('Handle taken', { exact: true }).count(), 0);
  assert.equal(await pay.isDisabled(), false, 'editing clears validation for the old handle');

  const restore = frame.getByPlaceholder('paste an identity backup', { exact: true });
  await frame.evaluate(() => { window.fixture.importFails = true; });
  await restore.fill('mock-retained-backup');
  await frame.getByRole('button', { name: 'Restore this identity', exact: true }).click();
  await frame.getByRole('alert').filter({ hasText: 'Restore rejected' }).waitFor();
  assert.equal(await restore.inputValue(), 'mock-retained-backup');
  await frame.evaluate(() => { window.fixture.importFails = false; window.fixture.userFails = true; });
  await frame.getByRole('button', { name: 'Restore this identity', exact: true }).click();
  await frame.getByText('Now posting as rrkah-fqaaa-aaaaa-aaaaq-cai', { exact: true }).waitFor();
  await frame.getByText('Could not read the Taggr account:', { exact: false }).waitFor();
  assert.equal(await frame.getByRole('button', { name: 'Check the price', exact: true }).count(), 0);
  assert.equal(await restore.inputValue(), '', 'successful identity change clears restore input');

  await frame.getByRole('button', { name: 'Search Taggr', exact: true }).click();
  const search = frame.getByRole('textbox', { name: 'Search Taggr', exact: true });
  await search.fill('broken');
  await search.press('Enter');
  await frame.getByRole('alert').filter({ hasText: 'Search unavailable' }).waitFor();
  assert.equal(await frame.getByText('No matches.', { exact: true }).count(), 0);
  await search.fill('people');
  await frame.getByRole('button', { name: 'Run the search', exact: true }).click();
  await frame.locator('.taggr-result').first().waitFor();
  await frame.locator('.taggr-result').first().click();
  await frame.waitForFunction(() => window.fixture.calls.some(c => c.name === 'ui_read' && c.args.method === 'user' && JSON.parse(c.args.payload)[1][0] === '7'));
  assert.equal(await frame.evaluate(() => window.fixture.calls.some(c => c.name === 'ui_read' && c.args.method === 'thread' && JSON.parse(c.args.payload) === 7)), false, 'user search result opens user, not post');

  await frame.getByRole('button', { name: 'Search Taggr', exact: true }).click();
  await frame.getByTitle('Open ICP', { exact: true }).click();
  await frame.waitForFunction(() => window.fixture.calls.some(c => c.name === 'ui_read' && c.args.method === 'last_posts' && JSON.parse(c.args.payload)[1] === 'ICP'));
  await frame.getByRole('button', { name: 'Search Taggr', exact: true }).click();
  await frame.getByTitle('Open #two', { exact: true }).click();
  await frame.waitForFunction(() => window.fixture.calls.some(c => c.name === 'ui_read' && c.args.method === 'posts_by_tags' && JSON.parse(c.args.payload)[2][0] === 'two'));

  await frame.evaluate(() => { window.fixture.userFails = false; window.fixture.registered = true; });
  await frame.getByRole('button', { name: 'Settings', exact: true }).click();
  await frame.getByRole('button', { name: 'Reload from Taggr', exact: true }).click();
  await frame.getByText('@owner', { exact: true }).waitFor();
  assert.equal(await frame.getByText('Could not read the Taggr account:', { exact: false }).count(), 0, 'settings reload recovers account read');
  await frame.getByRole('button', { name: 'Hot posts', exact: true }).click();
  await frame.locator('article').first().waitFor();
  await frame.getByRole('button', { name: 'Add a reaction', exact: true }).first().click();
  await frame.getByRole('button', { name: 'Write a post', exact: true }).click();
  await draft.fill('Pending while palette is open');
  await publish.click();
  await frame.waitForFunction(() => !!window.fixture.pendingPost);
  assert.equal(await frame.getByRole('button', { name: 'Thumbs up', exact: true }).isDisabled(), true);
  assert.equal(await frame.getByRole('button', { name: 'Downvote', exact: true }).isDisabled(), true);
  await frame.evaluate(() => window.fixture.finishPost());
  await frame.getByRole('button', { name: 'Close reactions', exact: true }).click();
  for (const width of [320, 360, 480, 960]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `feed fits ${width}px`);
    const clipped = await frame.evaluate(() => Array.from(document.querySelectorAll('.taggr-nav button, .taggr-post button')).map(el => ({ label: el.getAttribute('aria-label') || el.textContent, right: el.getBoundingClientRect().right })).filter(el => el.right > innerWidth + 1));
    assert.deepEqual(clipped, [], `feed controls fit ${width}px`);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: join(out, 'feed-320.png') });
  await frame.getByRole('button', { name: 'Browse realms', exact: true }).click();
  await frame.locator('.taggr-realm-row').waitFor();
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'long realm fits compact tile');
  await frame.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'settings fit compact tile');
  await page.screenshot({ path: join(out, 'settings-320.png') });

  await frame.goto(`http://127.0.0.1:${server.address().port}/tile?unavailable=1`);
  await frame.getByRole('alert').filter({ hasText: 'Settings unavailable' }).waitFor();
  assert.equal(await frame.getByText('Loading app settings…', { exact: true }).count(), 0);
  await frame.evaluate(() => { window.fixture.settingsFails = false; });
  await frame.getByRole('button', { name: 'Reload from Taggr', exact: true }).click();
  await frame.locator('article').first().waitFor();
  assert.deepEqual(errors, []);
  const checks = ['failed pagination retries same page', 'overlap deduplicates posts', 'view change clears stale content and discards late read', 'pending publish preserves newer edits and replacement draft', 'publish error retains draft', 'late export never reveals after navigation', 'identity mutation updates principal', 'failed restore retains backup', 'post-import lookup failure remains unavailable without false registration', 'stale handle validation ignored and edits clear old errors', 'open palette respects pending writes', 'account lookup recovers on reload', 'sandbox search Enter and failed search semantics', 'user/realm/tag search results route correctly', 'responsive 320/360/480/960 feed, settings and realms', 'bootstrap failure can retry'];
  await writeFile(join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Taggr browser checks passed; artifacts: ${out}`);
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true });
  console.error('Browser failure artifacts:', out);
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
