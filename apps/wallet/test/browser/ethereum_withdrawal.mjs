import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixture = fileURLToPath(new URL('./ethereum_withdrawal_fixture.mjs', import.meta.url));
const out = '/tmp/neutron-wallet-ethereum-withdrawal-browser';
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['withdrawal-entry'], outfile: `${out}/main.js`, bundle: true,
  platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'warning',
  plugins: [{ name: 'withdrawal-fixture', setup(builder) {
    builder.onResolve({ filter: /^withdrawal-entry$/ }, () => ({ path: 'entry', namespace: 'fixture-entry' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture-entry' }, () => ({ loader: 'tsx', resolveDir: root, contents: `
      import { createRoot } from 'react-dom/client';
      import { WalletEthereumWithdrawal } from '${root}/apps/wallet/src/ethereum_withdrawal.tsx';
      import { ledger } from '${fixture}';
      createRoot(document.getElementById('root')).render(<WalletEthereumWithdrawal ledger={ledger} mode="address" onMode={() => {}} onBack={() => {}} onNetwork={() => {}} operations={[]} onOperation={() => {}} />);
    ` }));
    builder.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: fixture }));
  } }],
});
const bundle = await readFile(`${out}/main.js`);
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH || '/run/current-system/sw/bin/google-chrome-stable', args: ['--no-sandbox'] });
const errors = [];
try {
  for (const scenario of ['rejected', 'lost']) {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.fulfill(route.request().url().includes('/main.js')
      ? { contentType: 'text/javascript', body: bundle }
      : { contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/main.js"></script>' }));
    await page.goto(`https://wallet.test/?${scenario}`);
    await page.getByText('Adjust maximum gas').click();
    const maximum = page.getByLabel('Maximum gas (ckETH)');
    assert.equal(await maximum.inputValue(), '0.000158738076432');
    await page.getByLabel('Ethereum recipient address').fill('0x1111111111111111111111111111111111111111');
    await page.getByLabel('Withdrawal amount').fill('12');
    await maximum.fill('0.00013');
    assert.equal(await page.getByRole('button', { name: 'Withdraw ckUSDT', exact: true }).isDisabled(), true);
    await maximum.fill('0.0002');
    await page.getByRole('button', { name: 'Withdraw ckUSDT', exact: true }).click();
    await page.waitForFunction(() => window.__withdrawal.resumes === 1);
    const reviewAgain = page.getByRole('button', { name: 'Refresh costs and review again' });
    if (scenario === 'rejected') {
      await reviewAgain.click();
      assert.equal(await page.getByLabel('Withdrawal amount').inputValue(), '12');
      assert.equal(await page.getByLabel('Ethereum recipient address').inputValue(), '0x1111111111111111111111111111111111111111');
      await page.getByRole('button', { name: 'Withdraw ckUSDT', exact: true }).click();
      await page.getByText('On its way to Ethereum', { exact: true }).waitFor();
      const result = await page.evaluate(() => ({ prepared: window.__withdrawal.prepared.map(p => ({ id: [...p.request_id], budget: p.withdrawal_quote.gas.budget })), burns: window.__withdrawal.burns }));
      assert.equal(result.prepared.length, 2);
      assert.notDeepEqual(result.prepared[0].id, result.prepared[1].id);
      assert.equal(result.prepared[0].budget, '200000000000000');
      assert.equal(result.prepared[1].budget, '158738076432000');
      assert.equal(result.burns, 1);
    } else {
      await page.getByText('Your request is saved. Lost minter response').waitFor();
      assert.equal(await reviewAgain.count(), 0);
      await page.getByRole('button', { name: 'Continue withdrawal', exact: true }).click();
      await page.getByText('On its way to Ethereum', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => ({ prepared: window.__withdrawal.prepared.length, burns: window.__withdrawal.burns, resumes: window.__withdrawal.resumes })), { prepared: 1, burns: 1, resumes: 1 });
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('Ethereum withdrawal browser checks passed: adjustable gas, rejection review, exact saved-request recovery');
} finally { await browser.close(); }
