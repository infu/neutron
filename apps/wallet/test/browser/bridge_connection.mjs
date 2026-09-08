/** Actual React bridge control and Ethereum deposit executor; only the Kernel
 * connection, backend persistence and Ethereum provider observations are mocked.
 * Every scenario runs in a fresh browser page and makes no real transactions. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const out = process.env.WALLET_BROWSER_ARTIFACTS || '/tmp/neutron-wallet-browser-access';
const fixture = fileURLToPath(new URL('./bridge_connection_fixture.mjs', import.meta.url));
await mkdir(out, { recursive: true });
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {WalletBridgeDeposit} from '${root}/apps/wallet/src/bridge_control.tsx'; createRoot(document.getElementById('root')).render(<WalletBridgeDeposit ledger="ss2fx-dyaaa-aaaar-qacoq-cai" symbol="ckETH" decimals={18} onRefresh={()=>window.__bridge.refreshes++} tray={false} openInTile={async()=>{}}/>);`;
await build({absWorkingDir:root, entryPoints:['access-fixture'], outfile:out+'/main.js', bundle:true, platform:'browser', format:'esm', jsx:'automatic', logLevel:'warning', plugins:[{name:'fixture',setup(b){
  b.onResolve({filter:/^access-fixture$/},()=>({path:'entry',namespace:'fixture-entry'}));
  b.onLoad({filter:/.*/,namespace:'fixture-entry'},()=>({contents:entry,loader:'tsx',resolveDir:root}));
  b.onResolve({filter:/^(?:\.\/bridge\.ts|\.\/evm_bridge\.ts|neutron-tools\/app|neutron-tools\/evm_wallet)$/},()=>({path:fixture}));
}}]});
const server = createServer(async(req,res)=>{res.setHeader('Content-Type',req.url==='/main.js'?'text/javascript':'text/html');res.end(req.url==='/main.js'?await readFile(out+'/main.js'):'<!doctype html><html><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try { browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/run/current-system/sw/bin/google-chrome-stable',args:['--no-sandbox']}); }
catch (error) { await new Promise(resolve=>server.close(resolve)); throw error; }
const checks=[], errors=[];
const counts = page => page.evaluate(()=>({connections:window.__bridge.calls.filter(x=>x.method==='connect').length, closes:window.__bridge.calls.filter(x=>x.method==='close').length, accounts:window.__bridge.calls.filter(x=>x.method==='eth_requestAccounts').length, sends:window.__bridge.sends}));
async function open(scenario){const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));await page.goto(`http://127.0.0.1:${server.address().port}/?scenario=${scenario}`);await page.getByRole('combobox',{name:'Deposit source'}).waitFor();await page.waitForFunction(()=>!document.querySelector('select').disabled);return page;}
async function draft(page){await page.getByRole('combobox',{name:'Deposit source'}).selectOption('external');await page.getByRole('textbox',{name:'Amount of ETH to deposit'}).fill('0.012');}
try {
  const quotePage=await open('quote');await draft(quotePage);await quotePage.getByRole('button',{name:'Wrap ETH',exact:true}).click();
  await quotePage.waitForFunction(()=>window.__bridge.releaseQuote);
  assert.deepEqual(await quotePage.evaluate(()=>window.__bridge.calls.filter(x=>['connect','quote:start'].includes(x.method))),[{method:'connect',detail:{active:true}},{method:'quote:start',detail:null}]);
  assert.equal(await quotePage.getByRole('button',{name:'Connecting…',exact:true}).isDisabled(),true);
  await quotePage.evaluate(()=>{window.__bridge.quoteError='The current minter helper is unavailable';window.__bridge.releaseQuote();});
  await quotePage.getByRole('alert').waitFor();await quotePage.waitForFunction(()=>window.__bridge.calls.some(x=>x.method==='close'));
  assert.equal(await quotePage.getByRole('alert').innerText(),'The current minter helper is unavailable');
  assert.equal(await quotePage.locator('.wallet-bridge-details').getAttribute('open'),null);
  assert.deepEqual(await counts(quotePage),{connections:1,closes:1,accounts:0,sends:0});
  checks.push('Browser connection begins with click activation before delayed quote; busy button blocks reentry; failed quote closes session and exposes actual cause inline.');
  await quotePage.evaluate(()=>window.__bridge.quoteError=null);await quotePage.getByRole('button',{name:'Wrap ETH',exact:true}).click();
  await quotePage.waitForFunction(()=>window.__bridge.calls.filter(x=>x.method==='close').length===2);
  assert.deepEqual(await counts(quotePage),{connections:2,closes:2,accounts:3,sends:1});
  assert.deepEqual(await quotePage.evaluate(()=>window.__bridge.calls.find(x=>x.method==='eth_sendTransaction').detail), [{
    from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20),
    value: '0x' + (12_000_000_000_000_000n).toString(16), data: '0x17c819c4' + '00'.repeat(64),
  }]);
  assert.equal(await quotePage.getByRole('alert').count(),0);
  const submitted=await quotePage.evaluate(()=>window.__bridge.records[0]);
  assert.equal(submitted.steps[2].state,'confirmed');assert.equal(submitted.id,'02'.repeat(16));
  await quotePage.getByRole('button',{name:'Check progress',exact:true}).click();
  assert.deepEqual(await counts(quotePage),{connections:2,closes:2,accounts:3,sends:1});
  checks.push('Retry after preflight failure opens a fresh session and submits one exact deposit; confirmed Check progress does not reconnect or resend.');
  await quotePage.close();

  const refreshPage=await open('refresh');await refreshPage.waitForFunction(()=>window.__bridge.releaseRefresh);await draft(refreshPage);
  await refreshPage.getByRole('button',{name:'Wrap ETH',exact:true}).click();await refreshPage.waitForFunction(()=>window.__bridge.calls.some(x=>x.method==='connect'));
  assert.equal(await refreshPage.evaluate(()=>window.__bridge.calls.some(x=>x.method==='quote:start')),false);
  assert.deepEqual(await refreshPage.evaluate(()=>window.__bridge.calls.find(x=>x.method==='connect').detail),{active:true});
  await refreshPage.evaluate(()=>{window.__bridge.quoteError='The current minter helper is unavailable';window.__bridge.releaseRefresh();});
  await refreshPage.waitForFunction(()=>window.__bridge.calls.some(x=>x.method==='close'));
  const flow=await refreshPage.evaluate(()=>window.__bridge.calls.map(x=>x.method));
  assert(flow.indexOf('connect')<flow.indexOf('refresh:end'));assert(flow.indexOf('refresh:end')<flow.indexOf('quote:start'));
  assert.deepEqual(await counts(refreshPage),{connections:1,closes:1,accounts:0,sends:0});
  checks.push('An outstanding background refresh does not delay opening the clicked browser session; refresh completion still precedes quote and failed quote releases session.');
  await refreshPage.close();

  const savedPage=await open('saved');await savedPage.getByRole('button',{name:'1 deposit to continue',exact:true}).click();
  await savedPage.evaluate(()=>window.__bridge.account='0x'+'44'.repeat(20));
  await savedPage.getByRole('button',{name:'Continue deposit',exact:true}).click();await savedPage.waitForFunction(()=>window.__bridge.calls.some(x=>x.method==='close'));
  assert.equal(await savedPage.getByRole('alert').innerText(),'Connect the same wallet account you used to start this deposit.');
  assert.deepEqual(await counts(savedPage),{connections:1,closes:1,accounts:2,sends:0});
  assert.equal(await savedPage.evaluate(()=>window.__bridge.records[0].steps[2].state),'ready');
  await savedPage.evaluate(()=>window.__bridge.account='0x'+'11'.repeat(20));await savedPage.getByRole('button',{name:'Continue deposit',exact:true}).click();
  await savedPage.waitForFunction(()=>window.__bridge.calls.filter(x=>x.method==='close').length===2);
  assert.deepEqual(await counts(savedPage),{connections:2,closes:2,accounts:5,sends:1});
  assert.equal(await savedPage.evaluate(()=>window.__bridge.calls.filter(x=>x.method==='prepare').length),0);
  assert.equal(await savedPage.evaluate(()=>window.__bridge.records[0].id),'01'.repeat(16));
  checks.push('Wrong account closes session without claiming/sending; retry with original account continues original saved ID without another prepare.');
  await savedPage.close();

  const unknownPage=await open('unknown');await unknownPage.getByRole('button',{name:'1 deposit to continue',exact:true}).click();
  assert.equal(await unknownPage.getByRole('button',{name:'Continue deposit',exact:true}).isDisabled(),true);
  assert.equal(await unknownPage.getByRole('textbox',{name:'Existing browser transaction hash'}).isVisible(),true);
  assert.deepEqual(await counts(unknownPage),{connections:0,closes:0,accounts:0,sends:0});
  checks.push('A saved browser send with unknown outcome still requires transaction-hash recovery and cannot be resent.');await unknownPage.close();
  assert.deepEqual(errors,[]);await writeFile(out+'/results.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
