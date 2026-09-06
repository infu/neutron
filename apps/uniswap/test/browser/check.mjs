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
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseAbi } from 'viem';

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
let nextApproval='confirm', nextSwap='lost-reply', delayedReads=null, releaseReads=null;
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
      assert.equal(call.name,'permissions.request');assert.equal(request.target,'app:evm_wallet:background');
      assert.deepEqual(request.tools,['evm_accounts_v1','evm_balances_v1','evm_call_contract_v1','evm_estimate_transaction_v1','evm_transaction_v1','evm_replacement_transaction_v1']);
      return {granted:true};
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
      else {assert.equal(decodeFunctionData({abi:tokenAbi,data:request.data}).functionName,'allowance');result=encodeFunctionResult({abi:tokenAbi,functionName:'allowance',result:0n});}
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
    if(call.name==='evm_operation_status_v1')return operations.get(request.requestId)??{...request,status:'not_found'};
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
 await page.clock.install({time:new Date()});
 await page.goto(url);
 toolOverrides.set('evm_accounts_v1',()=>{throw Error('No installed provider for app:evm_wallet:background');});
 await page.getByRole('button',{name:'Connect EVM Wallet',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'No installed provider'}).waitFor();
 assert.equal(records.size,0);assert.equal(operations.size,0);
 pass('Missing EVM Wallet provider surfaces an error without saving or sending a swap');
 toolOverrides.set('evm_accounts_v1',()=>({accounts:[{...account,namespaceVersion:'0'}]}));
 await page.getByRole('button',{name:'Connect EVM Wallet',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Invalid EVM Wallet accounts result'}).waitFor();
 assert.equal(records.size,0);assert.equal(operations.size,0);
 pass('Incompatible provider response is rejected by the shared SDK without effects');
 toolOverrides.delete('evm_accounts_v1');
 await page.getByRole('button',{name:'Connect EVM Wallet',exact:true}).click();
 await page.getByRole('button',{name:'Refresh wallet',exact:true}).waitFor();
 await page.getByText('Balance 5 ETH',{exact:true}).waitFor();
 pass('Connect through real SDK and render scoped balances');
 await page.getByLabel('Input token',{exact:true}).selectOption({label:'USDC'});
 await page.getByLabel('Output token',{exact:true}).selectOption('native');
 await page.getByLabel('Input amount',{exact:true}).fill('10');
 const balancesBeforeQuote=calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_balances_v1').length;
 delayedFees=new Promise(resolve=>{releaseFees=resolve;});
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByTestId('uniswap-progress').filter({hasText:'Reading network fees…'}).waitFor();
 assert.equal(await page.locator('output').innerText(),'0.00499');
 assert(await page.getByRole('button',{name:'Save swap and review approval',exact:true}).isDisabled());
 assert.equal(await page.locator('.uni-review').getByText('Reading network fee estimates…',{exact:true}).count(),1);
 assert.equal(operations.size,0);assert.equal(records.size,0);
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_estimate_transaction_v1').length,2);
 pass('Quote and progress appear while both fee reads are still pending; signing remains explicit');
 releaseFees();delayedFees=null;
 await page.waitForFunction(()=>!document.querySelector('button.uni-primary')?.disabled);
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_balances_v1').length,balancesBeforeQuote);
 pass('Quote completion does not repeat unrelated wallet balance reads');
 assert.equal(await page.locator('output').innerText(),'0.00499');
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_call_contract_v1'&&c.args[0].arguments.to.toLowerCase()===QUOTER).length,4);
 pass('Actual QuoterV2 calldata queries four fee tiers and selects best output');
 const quoteReview=page.locator('.uni-review');
 assert.match(await quoteReview.getByTestId('uniswap-approval-fee').innerText(),/^0\.00005 ETH/);
 assert.match(await quoteReview.getByTestId('uniswap-swap-fee').innerText(),/^0\.0001 ETH/);
 assert.equal(await quoteReview.getByTestId('uniswap-total-fee').innerText(),'0.00015 ETH');
 assert.equal(operations.size,0);assert.equal(records.size,0);
 pass('Quote displays separate numeric approval and swap fees and their sum without an effect');
 feeMultiplier=2n;
 await page.getByRole('button',{name:'Refresh quote',exact:true}).click();
 await quoteReview.getByTestId('uniswap-total-fee').filter({hasText:'0.0003 ETH'}).waitFor();
 assert.match(await quoteReview.getByTestId('uniswap-approval-fee').innerText(),/^0\.0001 ETH/);
 assert.match(await quoteReview.getByTestId('uniswap-swap-fee').innerText(),/^0\.0002 ETH/);
 assert.equal(operations.size,0);assert.equal(records.size,0);
 pass('Refreshing a quote re-estimates current fees and updates numeric values');
 feeMultiplier=1n;
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
 swapFeeUnavailable=true;
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByRole('button',{name:'Save swap and review approval',exact:true}).waitFor();
 assert.match(await quoteReview.getByTestId('uniswap-approval-fee').innerText(),/^0\.00005 ETH/);
 assert.match(await quoteReview.getByTestId('uniswap-swap-fee').innerText(),/^Unavailable/);
 assert.match(await quoteReview.getByTestId('uniswap-swap-fee').innerText(),/insufficient allowance/);
 assert.equal(await quoteReview.getByTestId('uniswap-total-fee').innerText(),'Unavailable');
 pass('A swap estimate unavailable before allowance remains explicit alongside its numeric approval estimate');
 nextApproval='reject';
 await page.getByRole('button',{name:'Save swap and review approval',exact:true}).click();
 await page.getByText('approval rejected',{exact:true}).waitFor();
 assert.equal(records.size,1);assert.equal([...operations.values()][0].status,'rejected');assert.equal(await page.getByRole('button',{name:'Review swap',exact:true}).count(),0);
 pass('Intent and requested phase saved before approval; decline blocks swap');
 nextApproval='confirm';swapFeeUnavailable=false;
 await page.getByLabel('Input amount',{exact:true}).fill('12');
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByRole('button',{name:'Save swap and review approval',exact:true}).click();
 await page.getByText('approval confirmed',{exact:true}).waitFor();
 const pending=[...records.values()].find(r=>r.phase==='approval_confirmed');assert(pending);
 const savedApproval=page.locator('.uni-saved').filter({hasText:'12 USDC'});
 const savedBefore=JSON.stringify(records.get(pending.id));
 const feeCallsBefore=calls.length, sendsBeforeFeeRefresh=operations.size;
 await savedApproval.getByRole('button',{name:'Refresh network fees',exact:true}).click();
 await savedApproval.getByText('Network fee estimates',{exact:true}).click();
 await savedApproval.getByText('Estimated remaining network fee',{exact:true}).waitFor();
 assert.equal(await savedApproval.getByTestId('uniswap-approval-fee').count(),0);
 assert.equal(await savedApproval.getByTestId('uniswap-total-fee').innerText(),'0.0001 ETH');
 const refreshedFees=calls.slice(feeCallsBefore).filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_estimate_transaction_v1');
 assert.equal(refreshedFees.length,1);
 const frozenSwap=JSON.parse(pending.swap_request_json), refreshRequest=refreshedFees[0].args[0].arguments;
 for(const key of ['accountId','chainId','to','data','valueWei'])assert.equal(refreshRequest[key],frozenSwap[key]);
 assert.equal(JSON.stringify(records.get(pending.id)),savedBefore);assert.equal(operations.size,sendsBeforeFeeRefresh);
 pass('Saved fee refresh estimates only the remaining frozen swap and preserves request IDs without signing');
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
 await page.getByRole('button',{name:'Review swap in EVM Wallet',exact:true}).waitFor();
 assert.equal(await quoteReview.getByTestId('uniswap-approval-fee').count(),0);
 assert.equal(await quoteReview.getByTestId('uniswap-total-fee').innerText(),'0.00015 ETH');
 await quoteReview.getByText('Arbitrum estimates include L1 posting costs in the RPC gas estimate once; no separate posting fee is added.',{exact:true}).waitFor();
 pass('Arbitrum numeric fee includes its posting costs once and describes that composition');
 await page.getByRole('button',{name:'Review swap in EVM Wallet',exact:true}).click();
 await page.locator('.uni-saved').filter({hasText:'0.001 ETH'}).getByText('swap confirmed',{exact:true}).waitFor();
 const nativeRecord=[...records.values()].find(r=>JSON.parse(r.quote_json).quote.tokenIn.address===null);
 assert(nativeRecord);assert(!Object.hasOwn(nativeRecord,'approval_request_id'));assert(!Object.hasOwn(nativeRecord,'approval_request_json'));
 pass('Native-input swap omits optional approval fields and uses generated backend wire schema');
 // A submitted transaction is replaced while pending; only authenticated
 // Wallet linkage and independent chain evidence can complete its saved step.
 nextSwap='submitted';
 await page.getByLabel('Input amount',{exact:true}).fill('0.002');
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByRole('button',{name:'Review swap in EVM Wallet',exact:true}).click();
 let replacementCard=page.locator('.uni-saved').filter({hasText:'0.002 ETH'});
 await replacementCard.getByText('swap submitted',{exact:true}).waitFor();
 const replaceRecord=[...records.values()].find(r=>JSON.parse(r.quote_json).quote.amountIn==='2000000000000000');assert(replaceRecord);
 const replacementHash='0x'+'cc'.repeat(32), originalOperation=operations.get(replaceRecord.swap_request_id), replacedRequest=JSON.parse(replaceRecord.swap_request_json);
 operations.set(replaceRecord.swap_request_id,{...originalOperation,status:'replaced',replacementTransactionHash:replacementHash,receipt:null});
 const sendsBeforeReplacement=calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1').length;
 await replacementCard.getByRole('button',{name:'Check wallet status',exact:true}).click();
 await replacementCard.getByText('swap unknown',{exact:true}).waitFor();
 await replacementCard.getByText('The linked replacement is not yet visible. Keep checking this saved request; do not repeat it.',{exact:true}).waitFor();
 const replacementReceipt=receipt(), outputToken=JSON.parse(replaceRecord.quote_json).quote.tokenOut.address;
 const transferAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
 replacementReceipt.logs=[{address:outputToken,data:encodeAbiParameters([{type:'uint256'}],[4_990_000n]),topics:encodeEventTopics({abi:transferAbi,eventName:'Transfer',args:{from:replacedRequest.to,to:account.address}}),logIndex:'0'}];
 transactionEvidence.set(replacementHash,{chainId:replaceRecord.chain_id,transactionHash:replacementHash,walletRequestMatches:null,transaction:{from:account.address,to:replacedRequest.to,data:replacedRequest.data,valueWei:replacedRequest.valueWei,nonce:'7',blockNumber:replacementReceipt.blockNumber,blockHash:replacementReceipt.blockHash},receipt:replacementReceipt,observedAtNs:ns(),source:'evm_rpc'});
 await replacementCard.getByRole('button',{name:'Check wallet status',exact:true}).click();
 await replacementCard.getByText('swap confirmed',{exact:true}).waitFor();
 await replacementCard.getByText('Receipt transfers to recipient: 4.99 USDC',{exact:true}).waitFor();
 assert.equal(await replacementCard.getByRole('link',{name:/^Replacement swap /}).getAttribute('href'),'https://arbiscan.io/tx/'+replacementHash);
 assert.equal(await replacementCard.getByRole('link',{name:/^Swap /}).getAttribute('href'),'https://arbiscan.io/tx/'+originalOperation.transactionHash);
 const savedReplacement=JSON.parse(records.get(replaceRecord.id).swap_operation_json);
 assert.equal(savedReplacement.receipt,null);assert.equal(savedReplacement.replacementEvidence.receipt.status,'success');
 assert.equal(records.get(replaceRecord.id).swap_request_id,replaceRecord.swap_request_id);
 assert.equal(calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1').length,sendsBeforeReplacement);
 await page.reload();replacementCard=page.locator('.uni-saved').filter({hasText:'0.002 ETH'});
 await replacementCard.getByText('Receipt transfers to recipient: 4.99 USDC',{exact:true}).waitFor();
 assert.equal(await replacementCard.getByRole('link',{name:/^Replacement swap /}).getAttribute('href'),'https://arbiscan.io/tx/'+replacementHash);
 pass('Replacement status follows authenticated linkage, independent receipt and both explorer links across reload without resending');
 nextSwap='confirm';
 await page.getByRole('button',{name:'Connect EVM Wallet',exact:true}).click();
 await page.getByText('Balance 5 ETH',{exact:true}).waitFor();
 await page.locator('.uni-form .uni-row select').first().selectOption('42161');
 await page.getByRole('button',{name:'Refresh wallet',exact:true}).click();
 await page.getByText('Balance 2 ETH',{exact:true}).waitFor();
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
 delayedFees=new Promise(resolve=>{releaseFees=resolve;});
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByTestId('uniswap-progress').filter({hasText:'Reading network fees…'}).waitFor();
 assert.equal(await page.locator('.uni-review').count(),1);
 await page.getByLabel('Input amount',{exact:true}).fill('3');
 assert.equal(await page.locator('.uni-review').count(),0);
 releaseFees();delayedFees=null;
 await page.getByRole('button',{name:/Get quote|Refresh quote/,exact:true}).waitFor();
 assert.equal(await page.locator('.uni-review').count(),0,'Late fee observations restored an outdated quote');
 pass('Late fee observations cannot restore a quote after its input changes');
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByRole('button',{name:'Review swap in EVM Wallet',exact:true}).waitFor();
 const operationsBeforeExpiry=operations.size;
 await page.clock.fastForward(21*60*1000);
 await quoteReview.getByText('Quote expired · request a fresh quote.',{exact:true}).waitFor();
 assert(await quoteReview.getByRole('button',{name:'Review swap in EVM Wallet',exact:true}).isDisabled());
 assert.equal(operations.size,operationsBeforeExpiry);
 pass('Expired quote is visibly identified and cannot be submitted');
 // Retain enough complete, valid saved intents to exceed the real self-call
 // metadata envelope. No fixture record is truncated or removed for paging.
 const historySeed=structuredClone(nativeRecord), oldestCreated=BigInt(ns())-1_000_000_000_000n;
 for(let i=0;i<20;i++){
  const id=(0xf000n+BigInt(i)).toString(16).padStart(32,'0'), requestId=(0xe000n+BigInt(i)).toString(16).padStart(32,'0');
  const record={...structuredClone(historySeed),id,swap_request_id:requestId,swap_request_json:JSON.stringify({...JSON.parse(historySeed.swap_request_json),requestId}),phase:'queued',revision:'0',created_at:String(oldestCreated-BigInt(i)),updated_at:String(oldestCreated-BigInt(i))};
  delete record.swap_operation_json;delete record.approval_operation_json;
  assert(Buffer.byteLength(JSON.stringify(record))<selfQueryMetadataLimit,'A seeded saved intent must fit individually');
  records.set(id,record);
 }
 const retainedBytes=Buffer.byteLength(JSON.stringify([...records.values()]));
 assert(retainedBytes>selfQueryMetadataLimit,'The retained history must require multiple pages');
 const retainedIdsBeforeSave=new Set(records.keys()), historyStart=calls.length;
 nextSwap='prepared';
 await page.getByLabel('Input amount',{exact:true}).fill('0.003');
 await page.getByRole('button',{name:'Get quote',exact:true}).click();
 await page.getByRole('button',{name:'Review swap in EVM Wallet',exact:true}).click();
 let newestCard=page.locator('.uni-saved').filter({hasText:'0.003 ETH'});
 await newestCard.getByText('swap prepared',{exact:true}).waitFor();
 const newest=[...records.values()].find(r=>!retainedIdsBeforeSave.has(r.id));assert(newest);
 const preparedId=newest.swap_request_id, preparedJson=newest.swap_request_json;
 assert.equal(operations.get(preparedId).status,'prepared');
 await page.reload();newestCard=page.locator('.uni-saved').filter({hasText:'0.003 ETH'});
 await newestCard.getByText('swap prepared',{exact:true}).waitFor();
 assert.equal(await page.getByRole('alert').count(),0,'Known history overflow should be handled by smaller pages');
 assert(metadataRejections.some(r=>r.method==='uniswap_history_v1'&&r.arguments[0].limit==='32'),'Oversized initial history page must exercise actual byte-limit backoff');
 const pageCalls=calls.slice(historyStart).filter(c=>c.kind==='querySelf'&&c.args[0]==='uniswap_history_v1');
 assert(pageCalls.some(c=>BigInt(c.args[1][0].limit)<32n),'History must retry the same page with a smaller size');
 assert(pageCalls.every(c=>c.args[1][0].cursor!==null),'Absent optional history cursor must be omitted on the wire');
 nextSwap='confirm';
 await newestCard.getByRole('button',{name:'Review swap',exact:true}).click();
 await newestCard.getByText('swap confirmed',{exact:true}).waitFor();
 assert.equal(records.get(newest.id).swap_request_id,preparedId);assert.equal(records.get(newest.id).swap_request_json,preparedJson);
 const preparedRequests=calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1'&&c.args[0].arguments.requestId===preparedId);
 assert.equal(preparedRequests.length,2,'Prepare and explicit resume must use the same Wallet request');
 assert.deepEqual(preparedRequests[0].args[0].arguments,preparedRequests[1].args[0].arguments);
 for(let pages=0;await page.getByRole('button',{name:'Load older swaps',exact:true}).isVisible();pages++){
  assert(pages<records.size,'History pagination did not advance');
  const before=await page.locator('.uni-saved').count();
  await page.getByRole('button',{name:'Load older swaps',exact:true}).click();
  await page.waitForFunction(previous=>document.querySelectorAll('.uni-saved').length>previous,before);
 }
 const visibleIds=await page.locator('.uni-saved pre').evaluateAll(nodes=>nodes.map(node=>JSON.parse(node.textContent).id));
 assert.equal(visibleIds.length,records.size);assert.equal(new Set(visibleIds).size,records.size);
 assert.deepEqual([...visibleIds].sort(),[...records.keys()].sort());
 assert(retainedIdsBeforeSave.size+1===records.size,'The entire old history and new swap must remain durable');
 assert(!calls.slice(historyStart).some(c=>c.kind==='querySelf'&&c.args[0]==='uniswap_list_v1'),'UI must never fetch aggregate history');
 pass('Oversized retained history backs off by actual byte limits, preserves every older record and resumes the newest prepared request with its exact ID');
 await page.screenshot({path:resolve(artifacts,'history-paged-320.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 await page.screenshot({path:resolve(artifacts,'recovered-320.png'),fullPage:true});
 await writeFile(resolve(artifacts,'report.json'),JSON.stringify({checks:report,calls,records:[...records.values()],metadataRejections,errors},null,2));
} catch (error) {
 if(page) { await writeFile(resolve(artifacts,'failure.txt'), String(error)+'\n'+await page.locator('body').innerText()); await page.screenshot({path:resolve(artifacts,'failure.png'),fullPage:true}); }
 await writeFile(resolve(artifacts,'failure-report.json'),JSON.stringify({checks:report,calls,records:[...records.values()],metadataRejections,errors},null,2));
 throw error;
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
