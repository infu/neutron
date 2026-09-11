/** Actual Wallet funding dialog in the ordinary app sandbox. A declined fresh
 * preview must finish without preparing, rejecting, or executing a payment. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixture = fileURLToPath(new URL('./funding_cancel_fixture.mjs', import.meta.url));
const out = process.env.WALLET_FUNDING_BROWSER_ARTIFACTS || '/tmp/neutron-wallet-funding-browser';
const kernelOrigin = 'https://3rurp-vyaaa-aaaay-aacua-cai.icp0.io';
const appOrigin = 'https://awalleta--3rurp-vyaaa-aaaay-aacua-cai.icp0.io';
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['funding-entry'], outfile: `${out}/main.js`,
  bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'warning',
  plugins: [{ name: 'funding-fixture', setup(builder) {
    builder.onResolve({ filter: /^funding-entry$/ }, () => ({ path: 'entry', namespace: 'fixture-entry' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture-entry' }, () => ({
      loader: 'ts', resolveDir: root, contents: `
        import { mountWallet } from '${root}/apps/wallet/src/mount.tsx';
        import { handleWalletFundingPresentation } from '${root}/apps/wallet/src/index.tsx';
        import { context, readFacts, request, state } from '${fixture}';
        mountWallet('tile');
        window.startFundingReview = () => {
          handleWalletFundingPresentation(request, context, readFacts).then(
            result => { state.result = result; state.settled = true; },
            error => { state.failure = String(error); state.settled = true; },
          );
        };
      `,
    }));
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: fixture }));
    builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: '', loader: 'css' }));
  } }],
});
const bundle = await readFile(`${out}/main.js`);
const browser = await chromium.launch({
  headless: true, executablePath: process.env.CHROMIUM_PATH || '/run/current-system/sw/bin/google-chrome-stable',
  args: ['--no-sandbox'],
});
const errors = [], checks = [];
try {
  for (const scenario of ['omitted', 'explicit-null']) {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === kernelOrigin) await route.fulfill({ contentType: 'text/html', body:
        `<!doctype html><html><body style="margin:0"><iframe id="wallet" title="IC Wallet" sandbox="allow-scripts allow-same-origin" style="width:100vw;height:100vh;border:0" src="${appOrigin}/app/wallet/index.html?app=wallet&tile=wallet&scenario=${scenario}"></iframe></body></html>` });
      else if (url.origin === appOrigin && url.pathname === '/main.js') {
        await route.fulfill({ contentType: 'text/javascript', body: bundle });
      } else if (url.origin === appOrigin && url.pathname === '/app/wallet/index.html') {
        await route.fulfill({ contentType: 'text/html', body:
          '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>' });
      } else {
        errors.push(`Unexpected network request: ${url}`);
        await route.abort();
      }
    });
    await page.goto(kernelOrigin);
    assert.equal(await page.locator('#wallet').getAttribute('sandbox'), 'allow-scripts allow-same-origin');
    const wallet = page.frameLocator('#wallet');
    await wallet.getByRole('button', { name: 'Assets', exact: true }).waitFor();
    const frame = page.frames().find(item => item.url().startsWith(appOrigin));
    await frame.evaluate(() => window.startFundingReview());
    const dialog = wallet.getByRole('dialog');
    await dialog.waitFor();
    assert((await dialog.innerText()).includes('Request from swap'));
    assert.equal(await dialog.getByRole('button', { name: 'Approve allowance', exact: true }).count(), 1);
    assert.deepEqual(await frame.evaluate(() => window.__funding.updates), []);

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await frame.waitForFunction(() => window.__funding.releaseLookup !== null);
    assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
    assert.equal(await frame.evaluate(() => window.__funding.settled), false);
    assert.deepEqual(await frame.evaluate(() => window.__funding.updates), []);
    await frame.evaluate(() => window.__funding.releaseLookup());

    await frame.waitForFunction(() => window.__funding.settled);
    await dialog.waitFor({ state: 'detached' });
    const state = await frame.evaluate(() => ({ ...window.__funding, releaseLookup: undefined }));
    assert.equal(state.failure, null);
    assert.deepEqual(state.result, {
      status: 'rejected', commandId: 'swap:00112233445566778899aabbccddeeff',
      blockIndex: null, duplicate: null,
      message: 'The Wallet approval was declined before submission.',
    });
    assert.deepEqual(state.updates, []);
    assert.equal(state.factsReads, 1);
    const previews = state.queries.filter(call => call.args[0] && 'funding_preview' in call.args[0]);
    assert.equal(previews.length, 2);
    assert(previews.every(call => call.method === 'wallet_read_v1'));
    assert.deepEqual(previews.map(call => call.args[0].funding_preview.lookup_only), [false, true]);
    assert.equal(previews[1].args[0].funding_preview.facts, null);
    assert.equal(await wallet.getByRole('alert').count(), 0);
    checks.push(`${scenario}: Cancel waits for the original-command lookup, returns a declined receipt, and removes the real dialog with zero update/payment calls in a sandbox without allow-forms.`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${out}/results.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  const frames = await Promise.all(browser.contexts().flatMap(context => context.pages()).flatMap(page => page.frames())
    .map(async frame => ({ url: frame.url(), body: await frame.locator('body').innerText(),
      state: await frame.evaluate(() => window.__funding ? { ...window.__funding, releaseLookup: undefined } : null) })));
  await writeFile(`${out}/failure.json`, JSON.stringify({ error: String(error), errors, frames }, null, 2));
  throw error;
} finally {
  await browser.close();
}
