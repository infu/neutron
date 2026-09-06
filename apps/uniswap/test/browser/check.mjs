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
import { decodeFunctionData, encodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseAbi } from 'viem';

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
const records=new Map(), operations=new Map(), transactionEvidence=new Map(), calls=[], toolOverrides=new Map(), metadataRejections=[];
const selfQueryMetadataLimit=65_536;
let nextApproval='confirm', nextSwap='confirm', blockedStatusRequest=null, allowanceAtoms=0n, delayedReads=null, releaseReads=null;
let feeMultiplier=1n, swapFeeUnavailable=false, delayedFees=null, releaseFees=null;
const ns=()=>String(BigInt(Date.now())*1_000_000n);
function receipt(){return {blockNumber:'21000000',blockHash:'0x'+'44'.repeat(32),status:'success',gasUsed:'90000',effectiveGasPriceWei:'1000000000',logs:[],finality:'included',observedAtNs:ns()};}
async function transport(kind,args){
  const method=kind==='querySelf'||kind==='updateSelf'?schema.methods[args[0]]:null;
  if(kind==='querySelf'||kind==='updateSelf')assert(method,'Generated backend schema must contain '+args[0]);
  if(method){const validation=icblast.validateMethodInputSchema(method,args[1]);assert(validation.ok,'Generated input schema rejected '+args[0]+': '+JSON.stringify(validation.errors));}
  const value=await fixtureTransport(kind,args);
  if(kind==='querySelf'){const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>selfQueryMetadataLimit){metadataRejections.push({method:args[0],arguments:structuredClone(args[1]),bytes});throw Error('Self-call result exceeds the metadata byte limit');}}
  if(method){const validation=icblast.validateMethodInputSchema({input:method.output},value);assert(validation.ok,'Generated output schema rejected '+args[0]+': '+JSON.stringify(validation.errors));}
  return value;
}
async function fixtureTransport(kind,args){
  calls.push({kind,args:structuredClone(args)});
  if(kind==='querySelf'){
    if(args[0]==='uniswap_list_v1')return [...records.values()];
    if(args[0]==='uniswap_history_v1'){
      const input=args[1][0];
      const sorted=[...records.values()].sort((a,b)=>BigInt(a.created_at)===BigInt(b.created_at)?b.id.localeCompare(a.id):BigInt(a.created_at)>BigInt(b.created_at)?-1:1);
      const offset=input.cursor===undefined?0:sorted.findIndex(row=>row.id===input.cursor)+1;
      assert(input.cursor===undefined||offset>0,'History cursor must name a retained record');
      const rows=sorted.slice(offset,offset+Number(input.limit));
      return {rows,...(offset+rows.length<sorted.length?{next_cursor:rows.at(-1).id}:{})};
    }
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
    const call=args[0], request=call.arguments;
    if(call.target==='kernel'){
      assert.fail('Wallet access is declared at installation; the UI must not request runtime permission');
    }
    assert.equal(call.target,'app:evm_wallet:background');
    if(toolOverrides.has(call.name))return toolOverrides.get(call.name)(request);
    if(call.name==='evm_accounts_v1')return {accounts:[account]};
    if(call.name==='evm_balances_v1')return {...request,address:account.address,nativeBalanceWei:request.chainId==='1'?'5000000000000000000':'2000000000000000000',tokens:request.tokens.map(address=>({address,balanceAtoms:'120000000',decimals:address.toLowerCase().startsWith('0xa0b')||address.toLowerCase().startsWith('0xaf88')?'6':'18',symbol:'TOKEN',error:null})),blockNumber:'21000000',observedAtNs:ns(),completeness:'requested_only'};
    if(call.name==='evm_call_contract_v1'){
      if(delayedReads)await delayedReads;
      let result;
      if(request.to.toLowerCase()===QUOTER){const decoded=decodeFunctionData({abi:quoteAbi,data:request.data});assert.equal(decoded.functionName,'quoteExactInputSingle');const q=decoded.args[0];const isUsdc=q.tokenOut.toLowerCase().startsWith('0xa0b')||q.tokenOut.toLowerCase().startsWith('0xaf88');const output=(q.fee===500?4_990_000n:4_900_000n)*(isUsdc?1n:1_000_000_000n);result=encodeFunctionResult({abi:quoteAbi,functionName:'quoteExactInputSingle',result:[output,2n**96n,1,90000n]});}
      else if(request.to.toLowerCase()===FACTORY)result=encodeFunctionResult({abi:factoryAbi,functionName:'getPool',result:POOL});
      else if(request.to.toLowerCase()===POOL)result=encodeFunctionResult({abi:poolAbi,functionName:'slot0',result:[(2n**96n*22_360_679_774_997_896n)/1_000_000_000_000n,0,0,1,1,0,true]});
      else {assert.equal(decodeFunctionData({abi:tokenAbi,data:request.data}).functionName,'allowance');result=encodeFunctionResult({abi:tokenAbi,functionName:'allowance',result:allowanceAtoms});}
      return {accountId:request.accountId,chainId:request.chainId,to:request.to,data:request.data,address:account.address,result,blockNumber:'21000000',observedAtNs:ns()};
    }
    if(call.name==='evm_estimate_transaction_v1'){
      if(delayedFees)await delayedFees;
      assert(!Object.hasOwn(request,'requestId'),'A readonly estimate must not allocate an operation identity');
      const approval=request.data.startsWith('0x095ea7b3'), arbitrum=request.chainId==='42161';
      if(swapFeeUnavailable&&!approval)return {...request,address:account.address,status:'unavailable',gasLimit:null,gasPriceWei:null,baseFeePerGasWei:null,maxPriorityFeePerGasWei:null,maxFeePerGasWei:null,estimatedFeeWei:null,maximumFeeWei:null,blockNumber:'21000000',observedAtNs:ns(),feeBasis:'unavailable',postingCosts:'unavailable',reasons:['ERC20: insufficient allowance for swap simulation.'],source:'evm_rpc'};
      const gas=approval?50_000n:arbitrum?150_000n:100_000n, price=1_000_000_000n*feeMultiplier;
      return {...request,address:account.address,status:'available',gasLimit:String(gas),gasPriceWei:String(price),baseFeePerGasWei:String(price/2n),maxPriorityFeePerGasWei:String(price/2n),maxFeePerGasWei:String(price*2n),estimatedFeeWei:String(gas*price),maximumFeeWei:String(gas*price*2n),blockNumber:'21000000',observedAtNs:ns(),feeBasis:arbitrum?'arbitrum_total_gas':'base_fee_plus_priority',postingCosts:arbitrum?'included':'not_applicable',reasons:[],source:'evm_rpc'};
    }
    if(call.name==='evm_transaction_v1')return transactionEvidence.get(request.transactionHash)??{...request,walletRequestMatches:null,transaction:null,receipt:null,observedAtNs:ns(),source:'evm_rpc'};
    if(call.name==='evm_operation_status_v1'){if(blockedStatusRequest===request.requestId)throw Error('Simulated temporary status read failure');return operations.get(request.requestId)??{...request,status:'not_found'};}
    if(call.name==='evm_send_transaction_v1'){
      const record=[...records.values()].find(r=>r.approval_request_id===request.requestId||r.swap_request_id===request.requestId);
      assert(record,'Wallet prompted before durable swap intent was saved');
      const approval=record.approval_request_id===request.requestId;
      assert.equal(record.phase,approval?'approval_requested':'swap_requested');
      assert.deepEqual(request,JSON.parse(approval?record.approval_request_json:record.swap_request_json));
      assert(!operations.has(request.requestId)||operations.get(request.requestId).status==='prepared','Operation submitted more than once');
      const rejected=approval&&nextApproval==='reject';
      const operation={requestId:request.requestId,accountId:request.accountId,chainId:request.chainId,operationId:String(operations.size+1),kind:'transaction',status:rejected?'rejected':!approval&&['submitted','prepared'].includes(nextSwap)?nextSwap:'confirmed',address:account.address,transactionHash:rejected||!approval&&nextSwap==='prepared'?null:'0x'+BigInt(operations.size+1).toString(16).padStart(64,'0'),signature:null,message:rejected?'Owner declined approval.':null,reviewRevision:'1',receipt:rejected||!approval&&['submitted','prepared'].includes(nextSwap)?null:receipt()};
      operations.set(request.requestId,operation);
      if(!approval&&nextSwap==='lost-reply'){blockedStatusRequest=request.requestId;throw Error('Simulated lost wallet reply');}
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
 toolOverrides.set('evm_accounts_v1',()=>{throw Error('Wallet is starting');});
 await page.goto(url);
 await page.getByText('Wallet unavailable · retrying automatically',{exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'Wallet unavailable',exact:true}).isDisabled());
 assert.equal(await page.getByRole('button',{name:/Connect|Reconnect/i}).count(),0);
 assert(!calls.some(c=>c.kind==='callTool'&&c.args[0].target==='kernel'));
 toolOverrides.delete('evm_accounts_v1');
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.getByText('Balance: 5 ETH',{exact:true}).waitFor();
 pass('Temporary Wallet startup failure recovers automatically on focus without a permission request');
 assert.equal(await page.getByRole('button',{name:/Connect|Reconnect|Refresh wallet|Refresh history|Get quote/i}).count(),0);
 pass('Wallet accounts and balances load automatically without connection, refresh, or quote buttons');
 await page.getByRole('button',{name:'Input token',exact:true}).click();
 await page.getByRole('textbox',{name:'Input token search',exact:true}).fill('usd');
 await page.getByRole('button',{name:'Select USDC',exact:true}).click();
 assert(await page.locator('.uni-token-trigger img').count()>=2);
 assert((await page.locator('.uni-token-trigger img').first().getAttribute('src')).startsWith('data:'));
 await page.getByRole('textbox',{name:'Input amount',exact:true}).fill('1');
 await page.getByRole('textbox',{name:'Input amount',exact:true}).fill('10');
 await page.getByRole('button',{name:'Swap',exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('button.uni-primary')?.disabled);
 assert.equal(await page.locator('output').innerText(),'0.00499');
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_call_contract_v1'&&c.args[0].arguments.to.toLowerCase()===QUOTER).length,4);
 assert.equal(records.size,0);assert.equal(operations.size,0);
 assert.equal(await page.locator('.uni-form > details[open]').count(),0);
 pass('Searchable local token icons and debounced quote render with technical details collapsed');
 const balanceCallsBeforeSwap=calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_balances_v1').length;
 await page.getByRole('button',{name:'Swap',exact:true}).click();
 await page.locator('.uni-saved-complete').waitFor();
 const first=[...records.values()][0];
 const firstSends=calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1');
 assert.deepEqual(firstSends.map(c=>c.args[0].arguments.requestId),[first.approval_request_id,first.swap_request_id]);
 await page.waitForFunction(()=>!document.querySelector('button.uni-primary')?.disabled || document.querySelector('button.uni-primary')?.textContent==='Enter an amount');
 assert(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_balances_v1').length>balanceCallsBeforeSwap);
 pass('One Swap action automatically completes approval then swap and refreshes balances');
 nextSwap='lost-reply';
 await page.getByRole('textbox',{name:'Input amount',exact:true}).fill('5');
 await page.getByRole('button',{name:'Swap',exact:true}).waitFor();
 await page.getByRole('button',{name:'Swap',exact:true}).click();
 await page.getByRole('alert').waitFor();
 const lost=[...records.values()].find(r=>r.id!==first.id);
 const sendsBeforeResume=calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1').length;
 await page.getByRole('button',{name:'Continue swap',exact:true}).waitFor();
 await page.getByText('Updates delayed · retrying automatically',{exact:true}).waitFor();
 blockedStatusRequest=null;
 await page.getByRole('button',{name:'Continue swap',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.uni-saved-complete').length===2);
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1').length,sendsBeforeResume);
 assert.equal(records.get(lost.id).swap_request_id,lost.swap_request_id);
 pass('Lost swap reply retains a visible Continue action and recovers without another signature');
 const beforeFocus=calls.length;
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(()=>!document.querySelector('button.uni-primary')?.textContent.includes('progress'));
 await new Promise(resolve=>setTimeout(resolve,200));
 assert(calls.slice(beforeFocus).some(c=>c.kind==='callTool'&&c.args[0].name==='evm_balances_v1'));
 assert(calls.slice(beforeFocus).some(c=>c.kind==='querySelf'&&c.args[0]==='uniswap_history_v1'));
 assert(!calls.slice(beforeFocus).some(c=>c.kind==='callTool'&&c.args[0].target==='kernel'));
 pass('Focus automatically refreshes accounts, balances, and history without requesting permission');
 const routerAbi=parseAbi(['function multicall(uint256 deadline,bytes[] data) payable returns(bytes[] results)']);
 const saved=JSON.parse(first.quote_json), oldDeadline=String(Math.floor(Date.now()/1000)-60);
 saved.quote.deadline=oldDeadline;
 const decoded=decodeFunctionData({abi:routerAbi,data:saved.swap.data});
 saved.swap.data=encodeFunctionData({abi:routerAbi,functionName:'multicall',args:[BigInt(oldDeadline),decoded.args[1]]});
 const approvalRequest={...JSON.parse(first.approval_request_json),requestId:'aa'.repeat(16)};
 const swapRequest={...JSON.parse(first.swap_request_json),requestId:'bb'.repeat(16),data:saved.swap.data};
 const oldApproval={...JSON.parse(first.approval_operation_json),requestId:approvalRequest.requestId};
 const old={...first,id:'expired-approved-swap',quote_json:JSON.stringify(saved),approval_request_id:approvalRequest.requestId,approval_request_json:JSON.stringify(approvalRequest),swap_request_id:swapRequest.requestId,swap_request_json:JSON.stringify(swapRequest),approval_operation_json:JSON.stringify(oldApproval),phase:'approval_confirmed',created_at:ns(),updated_at:ns()};
 delete old.swap_operation_json;
 records.set(old.id,old);operations.set(approvalRequest.requestId,oldApproval);allowanceAtoms=100_000_000n;nextSwap='confirm';
 const beforeReload=calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1').length;
 await page.reload();
 await page.getByRole('button',{name:'Refresh swap',exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1').length,beforeReload);
 await page.getByRole('button',{name:'Refresh swap',exact:true}).click();
 await page.getByRole('button',{name:'Swap',exact:true}).waitFor();
 await page.getByRole('button',{name:'Swap',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.uni-saved-complete').length===3);
 const fresh=[...records.values()].find(r=>![first.id,lost.id,old.id].includes(r.id));
 assert(fresh);assert.equal(fresh.approval_request_id,undefined);
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1').length,beforeReload+1);
 assert.equal(records.get(old.id).swap_request_id,swapRequest.requestId);
 pass('Expired approved swap survives reload, requotes after one click, and uses existing allowance for a newly reviewed swap');
 const externalRequestIds=[];
 for(const [mode,seed] of [['agent','cc'],['provider','dd']]){
  const externalIntent={...JSON.parse(first.quote_json),executionMode:mode};
  const externalApproval={...JSON.parse(first.approval_request_json),requestId:seed.repeat(16)};
  const externalSwap={...JSON.parse(first.swap_request_json),requestId:seed.repeat(15)+'ee'};
  externalRequestIds.push(externalApproval.requestId,externalSwap.requestId);
  const external={...first,id:mode+'-managed-swap',quote_json:JSON.stringify(externalIntent),approval_request_id:externalApproval.requestId,approval_request_json:JSON.stringify(externalApproval),swap_request_id:externalSwap.requestId,swap_request_json:JSON.stringify(externalSwap),phase:'approval_requested',created_at:ns(),updated_at:ns()};
  delete external.approval_operation_json;delete external.swap_operation_json;
  records.set(external.id,external);
 }
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.getByText('Managed by your agent.',{exact:true}).waitFor();
 await page.getByText('Managed by the requesting app.',{exact:true}).waitFor();
 for(const text of ['Managed by your agent.','Managed by the requesting app.'])assert.equal(await page.locator('article').filter({hasText:text}).getByRole('button',{name:/Continue|Refresh swap|Try swap again/i}).count(),0);
 const beforeExternalRefresh=calls.length;
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await new Promise(resolve=>setTimeout(resolve,250));
 assert(!calls.slice(beforeExternalRefresh).some(c=>c.kind==='callTool'&&externalRequestIds.includes(c.args[0].arguments?.requestId)));
 pass('Automatic refresh and UI actions leave Agent and provider-owned swaps with their original owner');
 for(const width of [375,320]){
  await page.setViewportSize({width,height:900});
  await page.getByRole('button',{name:'Input token',exact:true}).click();
  const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('input, select, button, .uni-shell, .uni-form, .uni-token-menu')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {name:e.getAttribute('aria-label')||e.tagName,left:r.left,right:r.right};})}));
  assert(bounds.scroll<=width,JSON.stringify(bounds));assert(bounds.elements.every(e=>e.left>=0&&e.right<=width+1),JSON.stringify(bounds));
  await page.screenshot({path:resolve(artifacts,'compact-'+width+'.png'),fullPage:true});
  await page.getByRole('button',{name:'Close token list',exact:true}).click();
  pass('Compact swap and token picker fit '+width+'px');
 }
 assert(!calls.some(c=>c.kind==='callTool'&&c.args[0].target==='kernel'));
 assert.deepEqual(errors,[]);
 await writeFile(resolve(artifacts,'report.json'),JSON.stringify({checks:report,calls,records:[...records.values()],metadataRejections,errors},null,2));
} catch (error) {
 if(page) { await writeFile(resolve(artifacts,'failure.txt'), String(error)+'\n'+await page.locator('body').innerText()); await page.screenshot({path:resolve(artifacts,'failure.png'),fullPage:true}); }
 await writeFile(resolve(artifacts,'failure-report.json'),JSON.stringify({checks:report,calls,records:[...records.values()],metadataRejections,errors},null,2));
 throw error;
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
