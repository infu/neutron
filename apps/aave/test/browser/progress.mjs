/** Focused actual-App regressions for durable progress presentation. Only the
 * Kernel transport is synthetic; execution and read promises remain separate
 * so stale replies can arrive in the same turn as a completed execution. */
import { build } from 'esbuild';
import { sassPlugin } from 'esbuild-sass-plugin';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

async function installFixture(page) {
  await page.addInitScript(() => {
    const account = { accountId: 'main', address: '0x' + '11'.repeat(20), publicKey: '0x02' + '22'.repeat(32), keyFingerprint: '0x' + '33'.repeat(32), namespaceVersion: '1' };
    const id = 'ab'.repeat(16);
    const input = { kind: 'supply', chainId: '1', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', amount: '1000000', all: false, useNative: false, maxPaymentAmount: null, collateralEnabled: false, eModeId: 0, quoteValiditySeconds: '1200' };
    const pending = { operationId: id, recordId: id, summary: 'Saved supply progress', state: 'pending', phase: 'step_0_requested', transactionHash: null, steps: [{ label: 'Supply USDC', status: 'unknown', transactionHash: null }], message: 'The previous Wallet reply is unresolved.' };
    const complete = { ...pending, state: 'complete', phase: 'complete', transactionHash: '0x' + '55'.repeat(32), steps: [{ label: 'Supply USDC', status: 'confirmed', transactionHash: '0x' + '55'.repeat(32) }], message: 'The final supply transaction completed successfully.' };
    const fixture = window.progressFixture = {
      mode: 'setup', pending, complete, row: { id, created_at: '1', result: pending, input, humanOwned: true },
      calls: [], historyCount: 0, histories: {}, statuses: [], continuation: null,
    };
    window.progressCall = ({ name, arguments: args }) => {
      fixture.calls.push(name);
      if (name === 'evm_accounts_v1') return Promise.resolve({ accounts: [account] });
      if (name === 'evm_balances_v1') return Promise.resolve({ ...args, address: account.address, nativeBalanceWei: '2000000000000000000', tokens: [], blockNumber: '25922607', observedAtNs: String(BigInt(Date.now()) * 1_000_000n), completeness: 'requested_only' });
      // Saved Activity stays usable during an unrelated market-read outage.
      if (name === 'aave_markets_v1') return Promise.reject(new Error('Market observations are temporarily unavailable.'));
      if (name === 'aave_history_v1') {
        const index = ++fixture.historyCount;
        const snapshot = { rowsJson: JSON.stringify([fixture.row]), nextCursor: null };
        if (fixture.mode === 'setup' || fixture.mode === 'external') return Promise.resolve(snapshot);
        return new Promise(resolve => { fixture.histories[index] = { snapshot, resolve }; });
      }
      if (name === 'aave_reconcile_v1') return Promise.resolve(fixture.pending);
      if (name === 'aave_continue_v1') return new Promise(resolve => { fixture.continuation = resolve; });
      if (name === 'aave_status_v1') return new Promise(resolve => { fixture.statuses.push(resolve); });
      return Promise.reject(new Error('Unexpected progress fixture call: ' + name));
    };
  });
}

async function openPendingActivity(page, url) {
  await page.goto(url);
  await page.getByRole('button', { name: /^Activity/ }).click();
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await page.waitForFunction(() => window.progressFixture.historyCount === 2 && !document.querySelector('.av-wallet button').disabled);
  assert.equal(await page.getByRole('button', { name: 'Continue in wallet', exact: true }).count(), 1);
}

async function confirmedObservation(page) {
  const visible = await page.getByRole('region', { name: 'Transaction progress', exact: true }).innerText();
  assert(visible.includes('Confirmed'), visible);
  assert(visible.includes('The final supply transaction completed successfully.'), visible);
  assert.equal(await page.getByRole('button', { name: 'Continue in wallet', exact: true }).count(), 0);
  return { visible, storedState: await page.evaluate(() => window.progressFixture.row.result.state) };
}

/** Reuses the caller's browser and returns checkpoint names for its report.
 * Writes progress-report.json under artifacts; always closes owned pages/server. */
export async function runProgressChecks({ app, browser, artifacts }) {
  const transport = 'export const callTool = (call) => window.progressCall(call); export const querySelf = () => { throw new Error("Unexpected direct self query"); }; export const updateSelf = () => { throw new Error("Unexpected direct self update"); };';
  const bundle = await build({
    absWorkingDir: app, entryPoints: ['src/main.tsx'], bundle: true, write: false, format: 'iife', jsx: 'automatic', outdir: resolve(artifacts, 'progress-build'),
    plugins: [{ name: 'progress-transport', setup(b) {
      b.onResolve({ filter: /^(?:neutron-tools\/app|\.{1,2}\/app_entry\.ts)$/ }, () => ({ path: 'transport', namespace: 'progress-fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'progress-fixture' }, () => ({ contents: transport, loader: 'js', resolveDir: app }));
    } }, sassPlugin()],
  });
  const scripts = { '/main.js': bundle.outputFiles.find(file => file.path.endsWith('.js')).text, '/main.css': bundle.outputFiles.find(file => file.path.endsWith('.css')).text };
  const server = createServer((req, res) => {
    if (req.url === '/static/icon.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); return; }
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(scripts[req.url] ?? '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/main.css"><div id="root"></div><script src="/main.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const checks = [], observations = [];
  try {
    for (const mode of ['external', 'history', 'status']) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
      const errors = [], externalRequests = [];
      page.setDefaultTimeout(15_000);
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.route('**/*', route => {
          if (new URL(route.request().url()).origin === url) return route.continue();
          externalRequests.push(route.request().url()); return route.abort();
        });
        await installFixture(page);
        await openPendingActivity(page, url);
        await page.evaluate(mode => { window.progressFixture.mode = mode; }, mode);
        if (mode === 'external') {
          await page.evaluate(() => { const fixture = window.progressFixture; fixture.row = { ...fixture.row, result: fixture.complete }; });
          await page.getByRole('button', { name: 'Refresh', exact: true }).click();
          await page.waitForFunction(() => window.progressFixture.historyCount === 3 && !document.querySelector('section[aria-label="Activity"] .av-loading'));
          checks.push('Activity refresh replaces cached local progress after completion in another client');
        } else {
          if (mode === 'history') {
            await page.getByRole('button', { name: 'Refresh', exact: true }).click();
            await page.waitForFunction(() => !!window.progressFixture.histories[3]);
          }
          await page.getByRole('button', { name: 'Continue in wallet', exact: true }).click();
          await page.waitForFunction(() => !!window.progressFixture.continuation);
          if (mode === 'status') await page.waitForFunction(() => window.progressFixture.statuses.length > 0);
          // Resolve both promises in one turn: effect cleanup alone cannot
          // distinguish a stale observation from the execution that just ended.
          await page.evaluate(mode => {
            const fixture = window.progressFixture;
            fixture.row = { ...fixture.row, result: fixture.complete };
            fixture.continuation(fixture.complete);
            if (mode === 'history') fixture.histories[3].resolve(fixture.histories[3].snapshot);
            else for (const resolve of fixture.statuses) resolve({ result: fixture.pending });
          }, mode);
          // Hold the automatic post-execution history refresh so it cannot
          // conceal an earlier stale reply overwriting the completed result.
          await page.waitForFunction(index => !!window.progressFixture.histories[index] && !document.querySelector('.av-wallet button').disabled, mode === 'history' ? 4 : 3);
          checks.push(mode === 'history' ? 'A history reply started before execution cannot overwrite its completed result' : 'An in-flight status reply cannot overwrite an explicitly completed execution');
        }
        observations.push({ mode, ...await confirmedObservation(page) });
        assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
      } finally { await page.close(); }
    }
    await mkdir(artifacts, { recursive: true });
    await writeFile(resolve(artifacts, 'progress-report.json'), JSON.stringify({ checks, observations }, null, 2));
    return checks;
  } finally { await new Promise(resolve => server.close(resolve)); }
}
