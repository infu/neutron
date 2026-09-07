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
import { decodeFunctionData, encodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, stringToHex, parseAbi } from 'viem';

const app = '/srv/shared/code/neutron/apps/uniswap';
const schema = JSON.parse(await readFile(resolve(app,'dist/schema.json'),'utf8'));
const artifacts = process.env.UNISWAP_BROWSER_ARTIFACTS || '/tmp/neutron-uniswap-usd-browser';
await mkdir(artifacts, {recursive: true});
const mock = `export const callTool = (...args) => window.fixtureCall('callTool', args); export const querySelf = (...args) => window.fixtureCall('querySelf', args); export const updateSelf = (...args) => window.fixtureCall('updateSelf', args);`;
const result = await build({absWorkingDir:app,entryPoints:['src/main.tsx'],bundle:true,write:false,format:'iife',jsx:'automatic',outdir:resolve(artifacts,'build'),plugins:[{name:'kernel-transport',setup(b){b.onResolve({filter:/^neutron-tools\/app$/},()=>({path:'mock',namespace:'fixture'}));b.onResolve({filter:/(?:^|\/)app_entry\.(ts|js)$/},()=>({path:'mock',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:mock,loader:'js'}));}},sassPlugin()]});
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
const V4_QUOTER='0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203', V4_STATE='0x7ffe42c4a5deea5b0fec41c94c136cf115597227', V4_MANAGER='0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e';
const V3_MANAGER='0xc36442b4a4522e871399cd717abdd847ab11fe88', PERMIT2='0x000000000022d473030f116ddee9f6b43ac78ba3';
const ZERO='0x'+'00'.repeat(20), USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const v4QuoteAbi=parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)']);
const v4Pools=new Map([[100,1],[500,10],[3000,60],[10000,200]].map(([fee,tickSpacing])=>[
 keccak256(encodeAbiParameters([{type:'tuple',components:[{name:'currency0',type:'address'},{name:'currency1',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'hooks',type:'address'}]}],[{currency0:ZERO,currency1:USDC,fee,tickSpacing,hooks:ZERO}])),{fee,tickSpacing},
]));
const v4StateAbi=parseAbi([
 'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
 'function getLiquidity(bytes32 poolId) view returns (uint128)',
 'function getPositionInfo(bytes32 poolId,address owner,int24 tickLower,int24 tickUpper,bytes32 salt) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128)',
 'function getFeeGrowthInside(bytes32 poolId,int24 tickLower,int24 tickUpper) view returns (uint256,uint256)',
]);
const managerAbi=parseAbi([
 'function ownerOf(uint256 tokenId) view returns (address)', 'function balanceOf(address owner) view returns (uint256)',
 'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)',
 'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
]);
const permitAbi=parseAbi(['function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)', 'function approve(address token,address spender,uint160 amount,uint48 expiration)']);
const records=new Map(), actions=new Map(), trackedPositions=new Map(), operations=new Map(), transactionEvidence=new Map(), calls=[], toolOverrides=new Map(), metadataRejections=[], indexRequests=[];
let indexedPositionCount=1n;
const actionSummary=({input_json,state_json,...row})=>row;
function pageOf(source,input,summary=(row)=>row){
 const sorted=[...source.values()].sort((a,b)=>BigInt(a.created_at)===BigInt(b.created_at)?b.id.localeCompare(a.id):BigInt(a.created_at)>BigInt(b.created_at)?-1:1);
 const offset=input.cursor===undefined?0:sorted.findIndex(row=>row.id===input.cursor)+1;
 assert(input.cursor===undefined||offset>0,'History cursor must name a retained record');
 const rows=sorted.slice(offset,offset+Number(input.limit));
 return {rows:rows.map(summary),...(offset+rows.length<sorted.length?{next_cursor:rows.at(-1).id}:{})};
}
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
    if(args[0]==='uniswap_action_page_v1')return pageOf(actions,args[1][0],actionSummary);
    if(args[0]==='uniswap_action_get_v1')return actions.get(args[1][0])??null;
    if(args[0]==='uniswap_position_refs_v1')return [...trackedPositions.values()].filter(item=>item.chain_id===args[1][0]);
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
    if(args[0]==='uniswap_action_begin_v1'){
      const old=actions.get(input.id);
      if(old){assert.equal(old.input_json,input.input_json);assert.equal(old.summary,input.summary);return old;}
      const value={...input,revision:'0',created_at:ns(),updated_at:ns()};actions.set(value.id,value);return value;
    }
    if(args[0]==='uniswap_action_update_v1'){
      const old=actions.get(input.id);assert(old);assert.equal(input.expected_revision,old.revision);
      const value={...old,state_json:input.state_json,phase:input.phase,revision:String(BigInt(old.revision)+1n),updated_at:ns()};actions.set(value.id,value);return value;
    }
    if(args[0]==='uniswap_position_track_v1'){
      const value={chain_id:input.chain_id,protocol:input.protocol,token_id:input.token_id};trackedPositions.set([input.chain_id,input.protocol,input.token_id].join(':'),value);return value;
    }
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
      else if(request.to.toLowerCase()===V4_QUOTER){
        const {args:[q]}=decodeFunctionData({abi:v4QuoteAbi,data:request.data});
        const isUsdc=(q.zeroForOne?q.poolKey.currency1:q.poolKey.currency0).toLowerCase()===USDC;
        const output=(q.poolKey.fee===500?4_980_000n:4_880_000n)*(isUsdc?1n:1_000_000_000n);
        result=encodeFunctionResult({abi:v4QuoteAbi,functionName:'quoteExactInputSingle',result:[output,80000n]});
      }
      else if(request.to.toLowerCase()===V4_STATE){
        const {functionName,args:[poolId]}=decodeFunctionData({abi:v4StateAbi,data:request.data});
        assert(v4Pools.has(poolId),'Pool read must preserve the currency, fee and tick-spacing key');
        const values={getSlot0:[2n**96n,0,0,v4Pools.get(poolId).fee],getLiquidity:10n**18n,getPositionInfo:[10n**12n,0n,0n],getFeeGrowthInside:[(2n**128n)/1_000_000n,(2n**128n)/1_000_000n]};
        result=encodeFunctionResult({abi:v4StateAbi,functionName,result:values[functionName]});
      }
      else if([V3_MANAGER,V4_MANAGER].includes(request.to.toLowerCase())){
        const {functionName,args:params}=decodeFunctionData({abi:managerAbi,data:request.data});
        if(functionName==='ownerOf'&&params[0]===77n)indexedPositionCount=2n;
        const values={ownerOf:account.address,balanceOf:request.to.toLowerCase()===V3_MANAGER?0n:indexedPositionCount,getPoolAndPositionInfo:[{currency0:ZERO,currency1:USDC,fee:3000,tickSpacing:60,hooks:ZERO},((0x1000000n-600n)<<8n)|(600n<<32n)],getPositionLiquidity:10n**12n};
        result=encodeFunctionResult({abi:managerAbi,functionName,result:values[functionName]});
      }
      else if(request.to.toLowerCase()===PERMIT2){
        const {functionName}=decodeFunctionData({abi:permitAbi,data:request.data});assert.equal(functionName,'allowance');
        result=encodeFunctionResult({abi:permitAbi,functionName,result:[0n,0,0]});
      }
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
      const action=[...actions.values()].find(r=>JSON.parse(r.state_json).steps.some(step=>step.request.requestId===request.requestId));
      const record=[...records.values()].find(r=>r.approval_request_id===request.requestId||r.swap_request_id===request.requestId);
      assert(action||record,'Wallet prompted before durable intent was saved');
      let approval;
      if(action){
        const state=JSON.parse(action.state_json), index=state.steps.findIndex(step=>step.request.requestId===request.requestId), step=state.steps[index];
        assert.equal(action.phase,'step_'+index+'_requested');assert.equal(step.dispatched,true);assert.equal(step.unresolvedDispatch,true);
        assert.deepEqual(request,step.request);approval=state.plan.steps[index].kind==='approval';
        assert(state.steps.slice(0,index).every(step=>step.operation?.status==='confirmed'&&step.evidence?.receipt?.status==='success'),'Next action ran before the previous receipt was verified');
      }else{
        approval=record.approval_request_id===request.requestId;
        assert.equal(record.phase,approval?'approval_requested':'swap_requested');
        assert.deepEqual(request,JSON.parse(approval?record.approval_request_json:record.swap_request_json));
      }
      assert(!operations.has(request.requestId)||operations.get(request.requestId).status==='prepared','Operation submitted more than once');
      const rejected=approval&&nextApproval==='reject';
      const operation={requestId:request.requestId,accountId:request.accountId,chainId:request.chainId,operationId:String(operations.size+1),kind:'transaction',status:rejected?'rejected':!approval&&['submitted','prepared'].includes(nextSwap)?nextSwap:'confirmed',address:account.address,transactionHash:rejected||!approval&&nextSwap==='prepared'?null:'0x'+BigInt(operations.size+1).toString(16).padStart(64,'0'),signature:null,message:rejected?'Owner declined approval.':null,reviewRevision:'1',receipt:rejected||!approval&&['submitted','prepared'].includes(nextSwap)?null:receipt()};
      operations.set(request.requestId,operation);
      if(operation.transactionHash)transactionEvidence.set(operation.transactionHash,{chainId:request.chainId,transactionHash:operation.transactionHash,walletRequestMatches:null,
        transaction:{from:account.address,to:request.to,data:request.data,valueWei:request.valueWei,nonce:'0',blockNumber:operation.receipt?.blockNumber??null,blockHash:operation.receipt?.blockHash??null},
        receipt:operation.receipt,observedAtNs:ns(),source:'evm_rpc'});
      if(!approval&&nextSwap==='lost-reply'){blockedStatusRequest=request.requestId;throw Error('Simulated lost wallet reply');}
      return operation;
    }
  }
  throw Error('Unexpected fixture call: '+JSON.stringify({kind,args}));
}
const report=[];
function pass(name){report.push(name);console.log('PASS '+name);}
const sends=()=>calls.filter(c=>c.kind==='callTool'&&c.args[0].name==='evm_send_transaction_v1');
const callCount=(name)=>calls.filter(c=>c.kind==='callTool'&&c.args[0].name===name).length;
const completedCount=()=>[...actions.values()].filter(row=>row.phase==='complete').length;
let page;const errors=[], externalRequests=[];
async function readySwap(){await page.locator('button.uni-primary').filter({hasText:/^Swap$/}).waitFor();await page.waitForFunction(()=>!document.querySelector('button.uni-primary')?.disabled);}
async function compact(width,label){
 await page.setViewportSize({width,height:900});
 const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('input, select, button, .uni-shell, .uni-form, .uni-token-menu')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {name:e.getAttribute('aria-label')||e.tagName,left:r.left,right:r.right};})}));
 assert(bounds.scroll<=width,JSON.stringify(bounds));assert(bounds.elements.every(e=>e.left>=0&&e.right<=width+1),JSON.stringify(bounds));
 await page.screenshot({path:resolve(artifacts,label+'-'+width+'.png'),fullPage:true});
}let priceMode='available';
const priceCalls=[];
const pricesFor=(request)=>({source:'defillama',prices:request.assets.map(asset=>{
 const native=asset.address===null||asset.address.toLowerCase()==='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
 const priceUsd=native?2000:1;
 const missing=priceMode==='missing'||priceMode==='partial'&&!native;
 return {...asset,priceUsd:missing?null:priceUsd,observedAtMs:missing?null:Date.now()-(priceMode==='stale'?900_000:0),fetchedAtMs:Date.now(),status:missing?'unavailable':priceMode==='stale'?'stale':'available',basis:asset.address?.toLowerCase()==='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'?'wrapped_underlying':'market',sourceId:missing?null:native?'coingecko:ethereum':'ethereum:'+asset.address,error:missing?'Fixture market price unavailable':priceMode==='stale'?'Fixture provider temporarily unavailable':null};
})});
toolOverrides.set('evm_wallet_prices_v1',request=>{priceCalls.push({mode:priceMode,request:structuredClone(request)});return pricesFor(request);});
async function usd(label, expected){const locator=page.locator('[aria-label]').filter({hasNot:page.locator('___never___')});await page.getByLabel(new RegExp('^'+label+': '+expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))).first().waitFor();}
try{
 page=await browser.newPage({viewport:{width:700,height:1050}});
 page.setDefaultTimeout(15_000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const target=new URL(route.request().url());
  if(target.origin===url)return route.continue();
  if(target.hostname==='eth.blockscout.com'){
    indexRequests.push(target.href);
    assert.equal(target.pathname.toLowerCase(),'/api/v2/tokens/'+V4_MANAGER+'/instances');
    assert.equal(target.searchParams.get('holder_address_hash').toLowerCase(),account.address);
    return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({items:[{id:'42',owner:{hash:account.address},token:{address_hash:V4_MANAGER},token_type:'ERC-721'}],next_page_params:null})});
  }
  externalRequests.push(target.href);return route.abort();
 });
 await page.exposeFunction('fixtureCall',transport);
 await page.goto(url);
 await page.bringToFront();
 await page.getByRole('textbox',{name:'Input amount',exact:true}).fill('0.01');
 await readySwap();
 await usd('Estimated USD value','$20.00');
 await usd('Estimated USD value','$4.99');
 await usd('Input token balance in USD','$10,000.00');
 await usd('Estimated network fee in USD','$0.20');
 pass('Real price watcher, SDK response validation and actual quote UI show input/output, balance and network fee USD amounts');
 for(const width of [375,700]){await compact(width,'swap-usd');pass('Swap USD estimates fit '+width+'px without horizontal overflow');}
 await page.getByRole('button',{name:'Input token',exact:true}).click();
 await page.getByRole('dialog').waitFor();
 const pickerText=await page.getByRole('dialog').innerText();
 assert(pickerText.includes('$10,000.00'),pickerText);
 for(const width of [375,700])await compact(width,'token-picker-usd');
 await page.getByRole('button',{name:'Close token list',exact:true}).click();
 pass('Token picker displays token balances and their USD amounts at both viewport widths');
 await page.locator('.uni-form > details').getByText('Details & settings',{exact:true}).click();
 await usd('Minimum received in USD','$4.97');
 for(const width of [375,700])await compact(width,'swap-details-usd');
 await page.locator('.uni-form > details').getByText('Details & settings',{exact:true}).click();
 pass('Minimum received and expanded fee details retain secondary USD values');
 await page.getByRole('button',{name:'Liquidity',exact:true}).click();
 await page.locator('.uni-position-card').filter({hasText:'#42'}).waitFor();
 const positionUsd=await page.locator('.uni-position-card .uni-usd').allTextContents();
 assert(positionUsd.length>=3,JSON.stringify(positionUsd));assert(positionUsd.every(text=>text.includes('$')),JSON.stringify(positionUsd));
 for(const width of [375,700])await compact(width,'liquidity-positions-usd');
 pass('Verified liquidity position amounts, total and collectible fees display USD values');
 await page.getByRole('button',{name:'+ New position',exact:true}).click();
 await page.getByRole('textbox',{name:'Token A amount',exact:true}).fill('0.001');
 await page.getByRole('textbox',{name:'Token B amount',exact:true}).fill('2');
 await page.locator('.uni-liquidity-preview').waitFor();
 assert(!(await page.getByRole('button',{name:'Create position',exact:true}).isDisabled()));
 const previewUsd=await page.locator('.uni-liquidity-preview .uni-usd').allTextContents();
 assert(previewUsd.length>=1,JSON.stringify(previewUsd));assert(previewUsd.every(text=>text.includes('$')),JSON.stringify(previewUsd));
 for(const width of [375,700])await compact(width,'liquidity-preview-usd');
 pass('Liquidity draft inputs and preview show pair USD estimates without submitting financial actions');
 priceMode='stale';
 await page.reload();await page.bringToFront();
 await page.getByRole('textbox',{name:'Input amount',exact:true}).fill('0.01');await readySwap();
 await page.getByLabel('Estimated USD value: $20.00, price outdated',{exact:true}).waitFor();
 assert(await page.locator('.uni-usd-stale').count()>0);
 for(const width of [375,700])await compact(width,'stale-usd');
 pass('Stale provider observations remain explicitly marked outdated and do not block quotes');
 priceMode='missing';
 await page.reload();await page.bringToFront();
 await page.getByRole('textbox',{name:'Input amount',exact:true}).fill('0.01');await readySwap();
 await page.waitForFunction(()=>[...document.querySelectorAll('.uni-usd')].some(el=>el.textContent==='—'));
 assert(!(await page.locator('button.uni-primary').isDisabled()));
 assert(!(await page.locator('.uni-token-panel .uni-usd').allTextContents()).some(text=>text.includes('$0')));
 for(const width of [375,700])await compact(width,'missing-usd');
 pass('Missing prices use an unavailable dash rather than zero and do not delay or disable executable token quotes');
 priceMode='partial';
 await page.reload();await page.bringToFront();
 await page.getByRole('button',{name:'Liquidity',exact:true}).click();
 await page.locator('.uni-position-card').filter({hasText:'#42'}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.uni-position-card .uni-usd')].some(el=>el.textContent==='—'));
 const partialLabels=await page.locator('.uni-position-card .uni-usd').evaluateAll(els=>els.map(el=>({text:el.textContent,label:el.getAttribute('aria-label')})));
 assert(partialLabels.some(row=>row.label==='Position principal in USD: —'&&row.text==='—'),JSON.stringify(partialLabels));
 await compact(375,'partial-position-usd');
 pass('A position with only one available token price does not report an incomplete pair as a complete total');
 assert.equal(sends().length,0);assert.equal(operations.size,0);assert.equal(actions.size,0);
 assert(!calls.some(c=>c.kind==='callTool'&&c.args[0].target==='kernel'));
 assert.deepEqual(externalRequests,[]);assert.deepEqual(errors,[]);
 pass('All checks performed without real API/RPC calls, permission requests, signing or sending');
 await writeFile(resolve(artifacts,'report.json'),JSON.stringify({checks:report,priceCalls,positionUsd,previewUsd,partialLabels,calls,indexRequests,externalRequests,metadataRejections,errors},null,2));
} catch(error){
 if(page){await writeFile(resolve(artifacts,'failure.txt'),String(error)+'\n'+await page.locator('body').innerText());await page.screenshot({path:resolve(artifacts,'failure.png'),fullPage:true});}
 await writeFile(resolve(artifacts,'failure-report.json'),JSON.stringify({checks:report,calls,priceCalls,errors,externalRequests},null,2));throw error;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
