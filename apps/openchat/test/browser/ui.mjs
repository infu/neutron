/** Production tile/components/styles; only the local Kernel tool bus is mocked. Never contacts OpenChat. */
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
const out = await mkdtemp(join(tmpdir(), "openchat-ui-"));
const bus = `
  const person = { status: 'awaiting_email', ocPrincipal: null, userId: null, username: null, pendingEmail: 'owner@example.test' };
  const chat = (id, title, kind = 'direct') => ({ id, title, kind, subtitle: null, lastMessage: null, unread: 1, lastUpdatedMs: Date.now() });
  const f = window.fixture = {
    who: person, calls: [], listeners: new Map(), confirmed: false, profileFails: true, readFails: false,
    directoryFails: false, whoFails: new URL(location.href).searchParams.has("unavailable"), markFails: false, signoutFails: false, pendingRead: null, deferRead: false,
    chats: [chat('direct:alice', 'Alice'), chat('direct:bob', 'Bob'), chat('group:team', 'Team', 'group')],
    publish() { for (const callback of this.listeners.get('chats') ?? []) callback({ revision: String(Date.now()) }); },
    message(id) { return { messageId: 'm:' + id, index: 0, senderId: id, senderName: id, senderAvatarUrl: null, text: 'Hello ' + id,
      contentKind: 'text', image: null, timestampMs: Date.now(), mine: false, edited: false }; },
  };
  export const loadTileContext = () => ({ tile: 'chats' });
  export const onTileViewRequest = () => () => {};
  export const onAppStateChange = (topic, cb) => {
    const entries = f.listeners.get(topic) ?? new Set(); entries.add(cb); f.listeners.set(topic, entries);
    return () => entries.delete(cb);
  };
  export async function callTool(request) {
    if (request.target !== 'app:openchat:background') throw new Error('Unexpected target');
    const name = request.name.replace('openchat.', ''); const a = request.arguments;
    f.calls.push({ name, args: structuredClone(a) });
    switch (name) {
      case 'whoami': if (f.whoFails) throw new Error('Resident unavailable'); return structuredClone(f.who);
      case 'take_pending_nav': return null;
      case 'sign_in_email_status': return { phase: 'ready', email: 'owner@example.test', emailSent: true, code: '123456' };
      case 'sign_in_email_start': return { accepted: true, message: null };
      case 'sign_in_email_complete': f.confirmed = true; return { ok: true, message: null };
      case 'sign_in_email_poll':
        if (!f.confirmed) return { status: 'pending', message: null };
        if (!a.username) return { status: 'pending', message: 'username_required' };
        f.who = { status: 'logged_in', ocPrincipal: 'owner', userId: 'me', username: a.username, pendingEmail: null };
        return { status: 'logged_in', message: null };
      case 'list_chats': case 'refresh': return { chats: structuredClone(f.chats) };
      case 'read_messages':
        if (f.readFails) throw new Error('Message read unavailable');
        if (f.deferRead) { f.deferRead = false; return new Promise(resolve => { f.pendingRead = () => resolve({ messages: [f.message(a.chatId)] }); }); }
        return { messages: [f.message(a.chatId)] };
      case 'send_message': return a.accept_rules ? { kind: 'sent', messageId: 'sent', message: null } : { kind: 'rules_required', messageId: '', message: null, rulesText: 'Rules for ' + a.chatId };
      case 'get_profile': if (f.profileFails) throw new Error('Profile unavailable'); return { username: 'owner', displayName: 'Owner', bio: 'Existing profile bio', avatarUrl: null };
      case 'save_profile': return { ok: true, message: null };
      case 'mark_all_read': return { ok: !f.markFails, message: f.markFails ? 'Read update failed' : null };
      case 'sign_out': if (f.signoutFails) throw new Error('Sign out failed'); f.who = { ...person, status: 'logged_out', pendingEmail: null }; return { ok: true };
      case 'explore_communities': if (f.directoryFails) throw new Error('Directory unavailable'); return { communities: [] };
      case 'explore_groups': return { groups: [] };
      case 'search': throw new Error('Search unavailable');
      default: throw new Error('Unexpected mock call ' + name);
    }
  }
`;
await build({
  absWorkingDir: root, entryPoints: [join(root, "apps/openchat/src/tile/index.tsx")],
  outfile: join(out, "main.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
  plugins: [sassPlugin(), {
    name: "mock-local-tool-bus",
    setup(builder) {
      builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "bus", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: bus, loader: "js" }));
    },
  }], logLevel: "warning",
});
// Exercise the installed IndexedDB format in real Chromium across document reloads.
await build({
  absWorkingDir: root, stdin: { loader: "ts", resolveDir: root, contents: `
    import { ECDSAKeyIdentity, DelegationChain } from '@dfinity/identity';
    import { loadOrCreateSessionKey, restoreOcIdentity, clearOcSession, clearPendingEmail, loadPendingEmail } from '${root}/apps/openchat/src/oc/identity.ts';
    import { keystore, keystoreIsDurable, KEYS } from '${root}/apps/openchat/src/oc/keystore.ts';
    const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    window.storageTest = {
      async seedInstalledSession() {
        const key = await ECDSAKeyIdentity.generate({ extractable: false, keyUsages: ['sign', 'verify'] });
        const issuer = await ECDSAKeyIdentity.generate();
        const expirationMs = Date.now() + 120000;
        const chain = await DelegationChain.create(issuer, key.getPublicKey(), new Date(expirationMs));
        const profile = { ocPrincipal: issuer.getPrincipal().toText(), userId: 'aaaaa-aa', username: 'retained-owner' };
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('neutron-openchat', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('kv');
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite'); const store = tx.objectStore('kv');
          store.put(key.getKeyPair(), 'session.keypair.v1');
          store.put({ chain: chain.toJSON(), expirationMs, profile }, 'session.oc.v1');
          store.put({ email: 'retained@example.test', userKey: new Uint8Array([1, 2]), expiration: BigInt(expirationMs) * 1000000n, code: '123456', createdAtMs: Date.now() }, 'session.pending-email.v1');
          store.put('keep', 'unrelated');
          tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
        });
        db.close();
        return { publicKey: hex(key.getPublicKey().toDer()), principal: profile.ocPrincipal };
      },
      async inspect() {
        const key = await loadOrCreateSessionKey();
        const restored = await restoreOcIdentity(key);
        const kv = await keystore();
        const payload = new TextEncoder().encode('browser persistence proof');
        const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.getKeyPair().publicKey, await key.sign(payload), payload);
        return { durable: keystoreIsDurable(), publicKey: hex(key.getPublicKey().toDer()), extractable: key.getKeyPair().privateKey.extractable, verified,
          principal: restored?.identity.getPrincipal().toText() ?? null, username: restored?.session.profile.username ?? null,
          pendingEmail: (await loadPendingEmail())?.email ?? null, unrelated: await kv.get('unrelated'),
          databases: await indexedDB.databases(), keys: KEYS };
      },
      async signOut() { await clearOcSession(); await clearPendingEmail(); },
    };
  ` },
  outfile: join(out, "storage.js"), bundle: true, platform: "browser", format: "esm", logLevel: "warning",
});
const server = createServer(async (req, res) => {
  const file = req.url === "/main.js" ? "main.js" : req.url === "/storage.js" ? "storage.js" : req.url === "/main.css" ? "main.css" : null;
  res.setHeader("Content-Type", file?.endsWith('.js') ? "text/javascript" : file ? "text/css" : "text/html");
  const entry = req.url === "/storage" ? "storage.js" : "main.js";
  res.end(file ? await readFile(join(out, file)) : `<!doctype html><html><head><link rel="stylesheet" href="/main.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`);
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
  const link = page.locator('[data-tid="oc-link"]');
  await link.waitFor();
  assert.equal(await page.locator('[data-tid="oc-email"]').count(), 0, "pending sign-in restores without sending another email");
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c => c.name === 'sign_in_email_start').length), 0);
  for (const width of [320, 360, 480, 960]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `sign-in fits ${width}px`);
  }
  await page.screenshot({ path: join(out, "signin-960.png") });
  await link.fill("https://identity.example.test/mock-link");
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.locator('[data-tid="oc-username"]').fill("owner");
  await page.locator('[data-tid="oc-username"]').press("Enter");
  await page.locator('[data-tid="oc-chat-row"]').first().waitFor();
  await page.locator('[data-tid="oc-refresh"]').click();
  await page.waitForFunction(() => window.fixture.calls.some(c => c.name === 'refresh'));

  const alice = page.locator('[data-tid="oc-chat-row"]').filter({ hasText: "Alice" });
  const bob = page.locator('[data-tid="oc-chat-row"]').filter({ hasText: "Bob" });
  await alice.click();
  const composer = page.locator('[data-tid="oc-composer-input"]');
  await composer.fill("Private draft for Alice");
  // Committing an IME composition must not send a message.
  await composer.evaluate(el => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c => c.name === 'send_message').length), 0);
  await page.locator('[data-tid="oc-send"]').click();
  await page.getByRole("group", { name: "Chat rules" }).waitFor();
  await bob.click();
  assert.equal(await composer.inputValue(), "", "chat switch cannot send another recipient's draft");
  assert.equal(await page.getByRole("group", { name: "Chat rules" }).count(), 0, "rules acceptance belongs to the selected chat");

  await page.evaluate(() => { window.fixture.deferRead = true; });
  await alice.click();
  await page.waitForFunction(() => window.fixture.pendingRead !== null);
  await bob.click();
  await page.getByText("Hello direct:bob", { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.pendingRead(); window.fixture.pendingRead = null; });
  assert.equal(await page.getByText("Hello direct:alice", { exact: true }).count(), 0, "late read cannot leak into another conversation");

  await page.evaluate(() => { window.fixture.readFails = true; });
  await alice.click();
  await page.getByRole("alert").filter({ hasText: "Message read unavailable" }).waitFor();
  assert.equal(await page.getByText("No messages", { exact: true }).count(), 0);
  await page.evaluate(() => { window.fixture.readFails = false; });
  await page.getByRole("button", { name: "Retry messages", exact: true }).click();
  await page.getByText("Hello direct:alice", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Servers & groups", exact: true }).click();
  assert.equal(await composer.count(), 0, "switching top-level views closes the old recipient");
  await page.locator('[data-tid="oc-chat-row"]').filter({ hasText: "Team" }).click();
  for (const width of [320, 360, 480, 960, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `chat fits ${width}px`);
    const box = await composer.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width, `composer visible at ${width}px`);
    assert(box.y + box.height <= 900, `composer fits tile height at ${width}px`);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: join(out, "chat-320.png") });
  await page.getByRole("button", { name: "Back to chats", exact: true }).click();
  await page.locator('[data-tid="oc-profile-open"]').click();
  await page.getByRole("alert").filter({ hasText: "Profile unavailable" }).waitFor();
  assert.equal(await page.locator('[data-tid="oc-profile-save"]').count(), 0, "failed profile load cannot clear existing fields");
  await page.evaluate(() => { window.fixture.profileFails = false; });
  await page.getByRole("button", { name: "Retry profile", exact: true }).click();
  await page.locator('[data-tid="oc-profile-save"]').waitFor();
  await page.locator('[data-tid="oc-profile-save"]').click();
  await page.waitForFunction(() => window.fixture.calls.some(c => c.name === 'save_profile'));
  assert.equal(await page.evaluate(() => window.fixture.calls.find(c => c.name === 'save_profile').args.bio), "Existing profile bio");

  await page.evaluate(() => { window.fixture.markFails = true; });
  await page.locator('[data-tid="oc-mark-read"]').click();
  await page.getByRole("alert").filter({ hasText: "Read update failed" }).waitFor();
  await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
  await page.evaluate(() => { window.fixture.directoryFails = true; });
  await page.getByRole("button", { name: "Browse & discover", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Directory unavailable" }).waitFor();
  assert.equal(await page.getByText("Nothing found", { exact: true }).count(), 0);
  await page.locator('[data-tid="oc-search-input"]').fill("person");
  await page.locator('[data-tid="oc-search-go"]').click();
  await page.getByRole("alert").filter({ hasText: "Search unavailable" }).waitFor();
  assert.equal(await page.getByText("No users found", { exact: true }).count(), 0);
  await page.evaluate(() => { window.fixture.signoutFails = true; });
  await page.locator('[data-tid="oc-signout"]').click();
  await page.getByRole("alert").filter({ hasText: "Sign out failed" }).waitFor();
  await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
  await page.evaluate(() => { window.fixture.signoutFails = false; });
  await page.locator('[data-tid="oc-signout"]').click();
  await page.locator('[data-tid="oc-email"]').waitFor();
  await page.locator('[data-tid="oc-email"]').fill("owner@example.test");
  await page.getByRole("button", { name: "Send magic link", exact: true }).click();
  await link.waitFor();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c => c.name === 'sign_in_email_start').length), 1);
  await page.goto(`http://127.0.0.1:${server.address().port}/?unavailable=1`);
  await page.getByRole("alert").filter({ hasText: "Resident unavailable" }).waitFor();
  assert.equal(await page.locator('[data-tid="oc-email"]').count(), 0, "unreachable resident cannot be interpreted as logged out");
  await page.evaluate(() => { window.fixture.whoFails = false; });
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await link.waitFor();

  await page.goto(`http://127.0.0.1:${server.address().port}/storage`);
  await page.waitForFunction(() => !!window.storageTest);
  const installed = await page.evaluate(() => window.storageTest.seedInstalledSession());
  await page.reload();
  await page.waitForFunction(() => !!window.storageTest);
  const retained = await page.evaluate(() => window.storageTest.inspect());
  assert.equal(retained.durable, true);
  assert.equal(retained.publicKey, installed.publicKey);
  assert.equal(retained.principal, installed.principal);
  assert.equal(retained.extractable, false);
  assert.equal(retained.verified, true);
  assert.equal(retained.username, "retained-owner");
  assert.equal(retained.pendingEmail, "retained@example.test");
  assert.deepEqual(retained.databases, [{ name: "neutron-openchat", version: 1 }]);
  assert.deepEqual(retained.keys, { sessionKeyPair: "session.keypair.v1", ocSession: "session.oc.v1", pendingEmail: "session.pending-email.v1" });
  await page.evaluate(() => window.storageTest.signOut());
  await page.reload();
  await page.waitForFunction(() => !!window.storageTest);
  const signedOut = await page.evaluate(() => window.storageTest.inspect());
  assert.equal(signedOut.principal, null);
  assert.equal(signedOut.pendingEmail, null);
  assert.equal(signedOut.publicKey, installed.publicKey);
  assert.equal(signedOut.unrelated, "keep");
  assert.deepEqual(errors, []);
  const checks = ["pending sign-in restoration and local mocked completion", "refresh reaches network-refresh tool", "IME Enter does not send", "recipient-isolated drafts and rules", "late reads ignored after navigation", "read errors and retry", "navigation clears recipient", "320/360/480/960/1200px responsive chat", "failed profile read cannot overwrite profile", "directory/search failures remain errors", "mark-read/signout rejection visible without unhandled errors", "mock email sign-in start", "resident failure stays unavailable and reconnects without fake logout", "existing real IndexedDB v1 keypair/delegation/pending-email restore across reload", "real non-extractable stored key signs and verifies", "signout persists while preserving signer and unrelated data"];
  await writeFile(join(out, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(`OpenChat browser checks passed; artifacts: ${out}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
