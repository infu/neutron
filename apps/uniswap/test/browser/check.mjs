/** Actual Uniswap UI + shared EVM Wallet SDK. Only the Kernel transport is mocked.
 * Run: node apps/uniswap/test/browser/check.mjs
 * The in-process journal/wallet survive browser reload; no network chain effects.
 */
import { build } from 'esbuild';
import { sassPlugin } from 'esbuild-sass-plugin';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import icblast from 'icblast';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';

const app = fileURLToPath(new URL('../../', import.meta.url));
const schema = JSON.parse(await readFile(resolve(app,'dist/schema.json'),'utf8'));
const artifacts = process.env.UNISWAP_BROWSER_ARTIFACTS || '/tmp/neutron-uniswap-browser';
await mkdir(artifacts, {recursive: true});
const mock = `export const callTool = (...args) => window.fixtureCall('callTool', args); export const querySelf = (...args) => window.fixtureCall('querySelf', args); export const updateSelf = (...args) => window.fixtureCall('updateSelf', args);`;
const result = await build({absWorkingDir:app,entryPoints:['src/main.tsx'],bundle:true,write:false,format:'iife',jsx:'automatic',outdir:resolve(artifacts,'build'),plugins:[{name:'kernel-transport',setup(b){b.onResolve({filter:/^neutron-tools\/app$/},()=>({path:'mock',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:mock,loader:'js'}));}},sassPlugin()]});
const scripts = {'/main.js': result.outputFiles.find(f=>f.path.endsWith('.js')).text, '/main.css': result.outputFiles.find(f=>f.path.endsWith('.css')).text};
const server=createServer((req,res)=>{const script=scripts[req.url];res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':script?'text/javascript':'text/html');res.end(script??'<link rel="stylesheet" href="/main.css"><div id="root"></div><script src="/main.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/run/current-system/sw/bin/google-chrome-stable'});
const account={accountId:'main',address:'0x1111111111111111111111111111111111111111',publicKey:'0x02'+'22'.repeat(32),keyFingerprint:'0x'+'33'.repeat(32),namespaceVersion:'1'};
const QUOTER='0x61ffe014ba17989e743c5f6cb21bf9697530b21e', FACTORY='0x1f98431c8ad98523631ae4a59f267346ea31f984', POOL='0x3333333333333333333333333333333333333333';
const quoteAbi=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const factoryAbi=parseAbi(['function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)']);
const poolAbi=parseAbi(['function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)']);
const tokenAbi=parseAbi(['function allowance(address owner,address spender) view returns (uint256)','function approve(address spender,uint256 amount) returns (bool)']);
const records=new Map(), operations=new Map(), calls=[];
let nextApproval='confirm', nextSwap='lost-reply', delayedReads=null, releaseReads=null;
const ns=()=>String(BigInt(Date.now())*1_000_000n);
function receipt(){return {blockNumber:'21000000',blockHash:'0x'+'44'.repeat(32),status:'success',gasUsed:'90000',effectiveGasPriceWei:'1000000000',logs:[],finality:'included',observedAtNs:ns()};}
async function transport(kind,args){
  const method=kind==='querySelf'||kind==='updateSelf'?schema.methods[args[0]]:null;
  if(method){const validation=icblast.validateMethodInputSchema(method,args[1]);assert(validation.ok,'Generated input schema rejected '+args[0]+': '+JSON.stringify(validation.errors));}
  const value=await fixtureTransport(kind,args);
  if(method){const validation=icblast.validateMethodInputSchema({input:method.output},value);assert(validation.ok,'Generated output schema rejected '+args[0]+': '+JSON.stringify(validation.errors));}
  return value;
}
async function fixtureTransport(kind,args){
  calls.push({kind,args:structuredClone(args)});
  if(kind==='querySelf'){
    if(args[0]==='uniswap_list_v1')return [...records.values()];
    if(args[0]==='uniswap_get_v1')return records.get(args[1][0])??null;
  }
  if(kind==='updateSelf'){
    const input=args[1][0];
    if(args[0]==='uniswap_begin_v1'){
      assert(!records.has(input.id));
      const value={...input,phase:'queued',revision:'0',created_at:ns(),updated_at:ns()};
      records.set(value.id,value);return value;
    }
    if(args[0]==='uniswap_update_v1'){
      const old=records.get(input.id);assert(old);assert.equal(input.expected_revision,old.revision);
      const next={...old,phase:input.phase,revision:String(BigInt(old.revision)+1n),updated_at:ns()};
      if(input.operation_json!=null)next[input.stage+'_operation_json']=input.operation_json;
      records.set(input.id,next);return next;
    }
  }
  if(kind==='callTool'){
    const call=args[0], request=call.arguments;assert.equal(call.target,'app:evm_wallet:background');
    if(call.name==='evm_accounts_v1')return {accounts:[account]};
    if(call.name==='evm_balances_v1')return {...request,address:account.address,nativeBalanceWei:request.chainId==='1'?'5000000000000000000':'2000000000000000000',tokens:request.tokens.map(address=>({address,balanceAtoms:'120000000',decimals:address.toLowerCase().startsWith('0xa0b')||address.toLowerCase().startsWith('0xaf88')?'6':'18',symbol:'TOKEN',error:null})),blockNumber:'21000000',observedAtNs:ns(),completeness:'requested_only'};
    if(call.name==='evm_read_contract_v1'){
      if(delayedReads)await delayedReads;
      let result;
      if(request.to.toLowerCase()===QUOTER){const decoded=decodeFunctionData({abi:quoteAbi,data:request.data});assert.equal(decoded.functionName,'quoteExactInputSingle');const q=decoded.args[0];const isUsdc=q.tokenOut.toLowerCase().startsWith('0xa0b')||q.tokenOut.toLowerCase().startsWith('0xaf88');const output=(q.fee===500?4_990_000n:4_900_000n)*(isUsdc?1n:1_000_000_000n);result=encodeFunctionResult({abi:quoteAbi,functionName:'quoteExactInputSingle',result:[output,2n**96n,1,90000n]});}
      else if(request.to.toLowerCase()===FACTORY)result=encodeFunctionResult({abi:factoryAbi,functionName:'getPool',result:POOL});
      else if(request.to.toLowerCase()===POOL)result=encodeFunctionResult({abi:poolAbi,functionName:'slot0',result:[(2n**96n*22_360_679_774_997_896n)/1_000_000_000_000n,0,0,1,1,0,true]});
      else {assert.equal(decodeFunctionData({abi:tokenAbi,data:request.data}).functionName,'allowance');result=encodeFunctionResult({abi:tokenAbi,functionName:'allowance',result:0n});}
      return {...request,address:account.address,result,code:'0x6000',blockNumber:'21000000',observedAtNs:ns()};
    }
    if(call.name==='evm_operation_status_v1')return operations.get(request.requestId)??{...request,status:'not_found'};
    if(call.name==='evm_send_transaction_v1'){
      const record=[...records.values()].find(r=>r.approval_request_id===request.requestId||r.swap_request_id===request.requestId);
      assert(record,'Wallet prompted before durable swap intent was saved');
      const approval=record.approval_request_id===request.requestId;
      assert.equal(record.phase,approval?'approval_requested':'swap_requested');
      assert.deepEqual(request,JSON.parse(approval?record.approval_request_json:record.swap_request_json));
      assert(!operations.has(request.requestId),'Operation submitted more than once');
      const rejected=approval&&nextApproval==='reject';
      const operation={requestId:request.requestId,accountId:request.accountId,chainId:request.chainId,operationId:String(operations.size+1),kind:'transaction',status:rejected?'rejected':'confirmed',address:account.address,transactionHash:rejected?null:'0x'+(approval?'aa':'bb').repeat(32),signature:null,message:rejected?'Owner declined approval.':null,reviewRevision:'1',receipt:rejected?null:receipt()};
      operations.set(request.requestId,operation);
      if(!approval&&nextSwap==='lost-reply')throw Error('Simulated lost wallet reply');
      return operation;
    }
  }
  throw Error('Unexpected fixture call: '+JSON.stringify({kind,args}));
}
const report=[];
function pass(name){report.push(name);console.log('PASS '+name);}
let page; const errors=[];
try{
 page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('fixtureCall',transport);
 await page.goto(url);
 await page.getByRole('button',{name:'Connect EVM Wallet',exact:true}).click();
 await page.getByRole('button',{name:'Refresh wallet',exact:true}).waitFor();
 await page.getByText('Balance 5 ETH',{exact:true}).waitFor();
 pass('Connect through real SDK and render scoped balances');
 await page.getByLabel('Input token',{exact:true}).selectOption({label:'USDC'});
 await page.getByLabel('Output token',{exact:true}).selectOption('native');
 await page.getByLabel('Input amount',{exact:true}).fill('10');
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByRole('button',{name:'Save swap and review approval',exact:true}).waitFor();
 assert.equal(await page.locator('output').innerText(),'0.00499');
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_read_contract_v1'&&c.args[0].arguments.to.toLowerCase()===QUOTER).length,4);
 pass('Actual QuoterV2 calldata queries four fee tiers and selects best output');
 for(const width of [1440,375,320]){
  await page.setViewportSize({width,height:1000});
  await page.getByText('Swap settings and custom token',{exact:true}).evaluate(e=>e.parentElement.open=true);
  const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('input, select, button, .uni-shell, .uni-form')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {name:e.getAttribute('aria-label')||e.tagName,left:r.left,right:r.right};})}));
  assert(bounds.scroll<=width,JSON.stringify(bounds));assert(bounds.elements.every(e=>e.left>=0&&e.right<=width+1),JSON.stringify(bounds));
  await page.screenshot({path:resolve(artifacts,'quote-'+width+'.png'),fullPage:true});pass('Quote, settings, and controls fit '+width+'px');
 }
 await page.getByLabel('Input amount',{exact:true}).fill('11');
 assert.equal(await page.locator('.uni-review').count(),0);
 pass('Editing amount invalidates completed quote');
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByRole('button',{name:'Save swap and review approval',exact:true}).waitFor();
 nextApproval='reject';
 await page.getByRole('button',{name:'Save swap and review approval',exact:true}).click();
 await page.getByText('approval rejected',{exact:true}).waitFor();
 assert.equal(records.size,1);assert.equal([...operations.values()][0].status,'rejected');assert.equal(await page.getByRole('button',{name:'Review swap',exact:true}).count(),0);
 pass('Intent and requested phase saved before approval; decline blocks swap');
 nextApproval='confirm';
 await page.getByLabel('Input amount',{exact:true}).fill('12');
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByRole('button',{name:'Save swap and review approval',exact:true}).click();
 await page.getByText('approval confirmed',{exact:true}).waitFor();
 const pending=[...records.values()].find(r=>r.phase==='approval_confirmed');assert(pending);
 await page.getByRole('button',{name:'Review swap',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Simulated lost wallet reply'}).waitFor();
 assert.equal(records.get(pending.id).phase,'swap_requested');
 const sendsBefore=calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1').length;
 await page.reload();await page.getByText('swap requested',{exact:true}).waitFor();
 await page.locator('.uni-saved').filter({hasText:'12 USDC'}).getByRole('button',{name:'Check wallet status',exact:true}).click();
 await page.getByText('swap confirmed',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1').length,sendsBefore);
 assert.equal(records.get(pending.id).swap_request_id,pending.swap_request_id);
 pass('Approval receipt gates swap; lost swap reply survives reload and reconciles same ID without repeating');
 await page.getByRole('button',{name:'Connect EVM Wallet',exact:true}).click();
 await page.getByText('Balance 5 ETH',{exact:true}).waitFor();
 await page.locator('.uni-form .uni-row select').first().selectOption('42161');
 assert.equal(await page.getByText('Balance 5 ETH',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Refresh wallet',exact:true}).click();
 await page.getByText('Balance 2 ETH',{exact:true}).waitFor();
 pass('Changing network clears Ethereum balance and refreshes Arbitrum-scoped balance');
 nextSwap='confirm';
 await page.getByLabel('Input amount',{exact:true}).fill('0.001');
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByRole('button',{name:'Review swap in EVM Wallet',exact:true}).click();
 await page.locator('.uni-saved').filter({hasText:'0.001 ETH'}).getByText('swap confirmed',{exact:true}).waitFor();
 const nativeRecord=[...records.values()].find(r=>JSON.parse(r.quote_json).quote.tokenIn.address===null);
 assert(nativeRecord);assert(!Object.hasOwn(nativeRecord,'approval_request_id'));assert(!Object.hasOwn(nativeRecord,'approval_request_json'));
 pass('Native-input swap omits optional approval fields and uses generated backend wire schema');
 // Reproduce edits while a quote is in flight, not only after it finishes.
 await page.getByLabel('Input amount',{exact:true}).fill('1');
 delayedReads=new Promise(resolve=>{releaseReads=resolve;});
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('button.uni-primary')?.textContent==='Working…');
 await page.getByLabel('Input amount',{exact:true}).fill('2');
 releaseReads();delayedReads=null;
 await page.getByRole('button',{name:/Get quote|Refresh quote/,exact:true}).waitFor();
 assert.equal(await page.locator('.uni-review').count(),0,'An in-flight quote was committed after its amount changed');
 pass('An in-flight quote cannot reappear after its input amount changes');
 await page.getByText('Swap settings and custom token',{exact:true}).evaluate(e=>e.parentElement.open=true);
 delayedReads=new Promise(resolve=>{releaseReads=resolve;});
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('button.uni-primary')?.textContent==='Working…');
 await page.getByLabel('Recipient',{exact:true}).fill('0x2222222222222222222222222222222222222222');
 releaseReads();delayedReads=null;
 await page.getByRole('button',{name:/Get quote|Refresh quote/,exact:true}).waitFor();
 assert.equal(await page.locator('.uni-review').count(),0,'An in-flight quote was committed after its recipient changed');
 pass('An in-flight quote cannot reappear after its recipient changes');
 assert.deepEqual(errors,[]);
 await page.screenshot({path:resolve(artifacts,'recovered-320.png'),fullPage:true});
 await writeFile(resolve(artifacts,'report.json'),JSON.stringify({checks:report,calls,records:[...records.values()],errors},null,2));
} catch (error) {
 if(page) { await writeFile(resolve(artifacts,'failure.txt'), String(error)+'\n'+await page.locator('body').innerText()); await page.screenshot({path:resolve(artifacts,'failure.png'),fullPage:true}); }
 await writeFile(resolve(artifacts,'failure-report.json'),JSON.stringify({checks:report,calls,records:[...records.values()],errors},null,2));
 throw error;
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
