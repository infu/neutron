/** Actual UI + resident service + shared Wallet SDK. Only Kernel transport and
 * public observations are fixtures; state survives reload. Never signs funds. */
import { build } from 'esbuild';
import { sassPlugin } from 'esbuild-sass-plugin';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import icblast from 'icblast';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi, stringToHex } from 'viem';

const app = fileURLToPath(new URL('../../', import.meta.url)), artifacts = process.env.CURVE_BROWSER_ARTIFACTS || '/tmp/neutron-curve-browser';
await mkdir(artifacts, {recursive:true});
const schema = JSON.parse(await readFile(resolve(app,'dist/schema.json'),'utf8'));
const mock = `
import {normalizeToolDescriptor,validateToolArguments,validateToolResult} from 'neutron-tools/protocol';
const registered = new Map();
export function exposeTool(name, spec, handler) { registered.set(name, {spec:normalizeToolDescriptor({name,...spec}),handler}); window.curveTools = registered; }
export const querySelf = (name,args) => window.fixture('querySelf',[name,args]);
export const updateSelf = (name,args) => window.fixture('updateSelf',[name,args]);
export async function callTool(call,options) {
  if(call.target === 'app:curve:background') {
    const tool=registered.get(call.name); if(!tool) throw Error('Tool missing: '+call.name);
    validateToolArguments(tool.spec,call.arguments);
    const context={caller:{appId:'curve',installationUid:'1',role:'tile'},agentMode:false,signal:options?.signal,reportProgress:()=>{},kernel:{callTool,querySelf,updateSelf}};
    const result=await tool.handler(call.arguments,context); validateToolResult(tool.spec,result); return result;
  }
  return window.fixture('callTool',[call]);
}`;
const bundle = await build({absWorkingDir:app,stdin:{contents:'import "./src/service.ts"; import "./src/main.tsx";',resolveDir:app,loader:'ts'},bundle:true,write:false,format:'iife',jsx:'automatic',outdir:resolve(artifacts,'build'),plugins:[{name:'transport',setup(b){b.onResolve({filter:/^(?:neutron-tools\/app|\.{1,2}\/app_entry\.ts)$/},()=>({path:'mock',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:mock,loader:'js',resolveDir:app}));}},sassPlugin()]});
const scripts={'/main.js':bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,'/main.css':bundle.outputFiles.find(f=>f.path.endsWith('.css')).text,'/static/icon.svg':await readFile(resolve(app,'public/static/icon.svg'),'utf8')};
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':req.url.endsWith('.svg')?'image/svg+xml':req.url.endsWith('.js')?'text/javascript':'text/html');res.end(scripts[req.url]??'<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/main.css"><div id="root"></div><script src="/main.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/run/current-system/sw/bin/google-chrome-stable'});
const account={accountId:'main',address:'0x1111111111111111111111111111111111111111',publicKey:'0x02'+'22'.repeat(32),keyFingerprint:'0x'+'33'.repeat(32),namespaceVersion:'1'};
const POOL='0x3333333333333333333333333333333333333333', WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', CRVUSD='0xf939e0a03fb07f59a73314e73794be0e57ac1b4e', ARBWETH='0x82af49447d8a07e3bd95bd0d56f35241523fbab1', ARBUSD='0x498bf2b1e120fed3ad3d42ea2165e9b73f99c1e5';
const USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT='0xdac17f958d2ee523a2206206994597c13d831ec7', FAKE_USDC='0x0000000000000000000000000000000000000011', FAKE_USDT='0x0000000000000000000000000000000000000012';
const ARBUSDC='0xaf88d065e77c8cc2239327c5edb3a432268e5831', BRIDGED_USDC='0xff970a61a04b1ca14834a43f5de4533ebddb5cc8';
const views=parseAbi(['function get_coins(address) view returns (address[])','function is_meta(address) view returns (bool)','function coins(uint256) view returns (address)','function balances(uint256) view returns (uint256)','function totalSupply() view returns (uint256)','function decimals() view returns (uint8)','function symbol() view returns (string)','function balanceOf(address) view returns (uint256)','function allowance(address,address) view returns (uint256)','function get_dy(address[11],uint256[5][5],uint256,address[5]) view returns (uint256)','function calc_token_amount(uint256[],bool) view returns (uint256)','function calc_withdraw_one_coin(uint256,int128) view returns (uint256)','function remove_liquidity(uint256,uint256[],address) returns (uint256[])','function remove_liquidity_one_coin(uint256,int128,uint256,address) returns (uint256)']);
const effects=parseAbi(['function approve(address,uint256) returns (bool)','function exchange(address[11],uint256[5][5],uint256,uint256,address[5],address) payable returns (uint256)','function add_liquidity(uint256[],uint256,address) payable','function remove_liquidity(uint256,uint256[],address)','function remove_liquidity_one_coin(uint256,int128,uint256,address)']);
const records=new Map(), tracked=new Map(), operations=new Map(), transactions=new Map(), allowances=new Map(), calls=[], sends=[];
let lpBalance=10n**20n, clock=1n, mode='confirm', discoveryFails=false, rpcFails=false;
const ns=()=>String(BigInt(Date.now())*1000000n);
const receipt=()=>({blockNumber:'25922608',blockHash:'0x'+'44'.repeat(32),status:'success',gasUsed:'90000',effectiveGasPriceWei:'1000000000',logs:[],finality:'included',observedAtNs:ns()});
const normalize=(a)=>a.toLowerCase();
async function fixture(kind,[call,args]) {
  calls.push({kind,call:structuredClone(call),args:structuredClone(args)});
  if(kind==='querySelf'||kind==='updateSelf') {
    const method=schema.methods[call]; assert(method,'Missing backend schema: '+call);
    const validation=icblast.validateMethodInputSchema(method,args);assert(validation.ok,call+' input: '+JSON.stringify(validation.errors));
    const input=args[0]; let value;
    if(call==='curve_get_v1')value=records.get(input)??null;
    else if(call==='curve_page_v1') {
      const all=[...records.values()].filter(r=>r.id===r.root_id).sort((a,b)=>BigInt(a.created_at)>BigInt(b.created_at)?-1:1);
      const start=input.cursor?all.findIndex(r=>r.id===input.cursor)+1:0, rows=all.slice(start,start+Number(input.limit));
      value={rows:rows.map(({root_id,input_json,state_json,...summary})=>summary),...(start+rows.length<all.length?{next_cursor:rows.at(-1).id}:{})};
    } else if(call==='curve_begin_v1') {
      value=records.get(input.id);
      if(value){assert.equal(input.input_json,value.input_json);assert.equal(input.summary,value.summary);}
      else{value={...input,revision:'0',created_at:String(clock++),updated_at:ns()};records.set(value.id,value);}
    } else if(call==='curve_update_v1') {
      const prior=records.get(input.id);assert(prior);
      if(prior.phase===input.phase&&prior.state_json===input.state_json)value=prior;
      else{assert.equal(prior.revision,input.expected_revision);value={...prior,state_json:input.state_json,phase:input.phase,revision:String(BigInt(prior.revision)+1n),updated_at:ns()};records.set(value.id,value);}
    } else if(call==='curve_track_pool_v1'){value=input;tracked.set(input.chain_id+':'+input.address,input);}
    else if(call==='curve_tracked_pools_v1')value=[...tracked.values()].filter(p=>p.chain_id===input);
    else throw Error(call);
    const validationOut=icblast.validateMethodInputSchema({input:method.output},value);assert(validationOut.ok,call+' output: '+JSON.stringify(validationOut.errors));
    return structuredClone(value);
  }
  const {name,arguments:input}=call; assert.equal(call.target,'app:evm_wallet:background');
  if(name==='evm_accounts_v1')return {accounts:[account]};
  if(name==='evm_wallet_prices_v1')return {source:'defillama',prices:input.assets.map(asset=>({...asset,priceUsd:asset.address===null||[WETH,ARBWETH].includes(normalize(asset.address))?3000:1,observedAtMs:Date.now(),fetchedAtMs:Date.now(),status:'available',basis:'market',sourceId:'fixture',error:null}))};
  if(name==='evm_balances_v1')return {...input,tokens:input.tokens.map(address=>{
    const decimals=[USDC,USDT,FAKE_USDC,FAKE_USDT,ARBUSDC,BRIDGED_USDC].includes(normalize(address))?'6':'18';
    const symbol=[WETH,ARBWETH].includes(normalize(address))?'WETH':decimals==='6'?[USDT,FAKE_USDT].includes(normalize(address))?'USDT':'USDC':'crvUSD';
    return {address,balanceAtoms:String(100n*10n**BigInt(decimals)),decimals,symbol,error:null};
  }),address:account.address,nativeBalanceWei:'2000000000000000000',blockNumber:'25922607',observedAtNs:ns(),completeness:'requested_only'};
  if(name==='evm_call_contract_v1') {
    if(rpcFails)throw Error('RPC is temporarily unavailable. Try again.');
    const decoded=decodeFunctionData({abi:views,data:input.data}), a=decoded.args, symbol=[WETH,ARBWETH].includes(normalize(input.to))?'WETH':input.to.toLowerCase()===POOL?'Curve LP':'crvUSD';let value;
    const coins=input.chainId==='1'?[WETH,CRVUSD]:[ARBWETH,ARBUSD];
    switch(decoded.functionName){
      case 'get_coins':value=coins;break;case 'is_meta':value=false;break;case 'coins':value=coins[Number(a[0])];break;
      case 'decimals':value=18;break;case 'symbol':value=symbol;break;case 'totalSupply':value=10n**24n;break;case 'balances':value=10n**24n;break;
      case 'balanceOf':value=normalize(input.to)===POOL?lpBalance:10n**23n;break;
      case 'allowance':value=allowances.get(normalize(input.to)+':'+normalize(a[1]))??0n;break;
      case 'get_dy':value=a[2]*3000n;break;case 'calc_token_amount':value=a[0].reduce((sum,v)=>sum+v,0n);break;
      case 'calc_withdraw_one_coin':case 'remove_liquidity_one_coin':value=a[0];break;case 'remove_liquidity':value=[a[0]/2n,a[0]/2n];break;
      default:throw Error(decoded.functionName);
    }
    const {blockTag,...request}=input;
    return {...request,address:account.address,result:encodeFunctionResult({abi:views,functionName:decoded.functionName,result:value}),blockNumber:'25922607',observedAtNs:ns()};
  }
  if(name==='evm_estimate_transaction_v1')return {...input,address:account.address,status:'available',gasLimit:'100000',gasPriceWei:'1000000000',baseFeePerGasWei:'900000000',maxPriorityFeePerGasWei:'100000000',maxFeePerGasWei:'2000000000',estimatedFeeWei:'100000000000000',maximumFeeWei:'200000000000000',blockNumber:'25922607',observedAtNs:ns(),feeBasis:input.chainId==='42161'?'arbitrum_total_gas':'base_fee_plus_priority',postingCosts:input.chainId==='42161'?'included':'not_applicable',reasons:[],source:'evm_rpc'};
  if(name==='evm_operation_status_v1')return operations.get(input.requestId)??{...input,status:'not_found'};
  if(name==='evm_transaction_v1')return transactions.get(input.transactionHash);
  if(name==='evm_send_transaction_v1') {
    const prior=operations.get(input.requestId); if(prior)return prior;
    // The exact request exists in durable state before the wallet sees it.
    assert([...records.values()].some(row=>JSON.parse(row.state_json).steps.some(step=>step.request.requestId===input.requestId&&step.dispatched&&step.unresolved)));
    sends.push(structuredClone(input));const hash=keccak256(stringToHex(input.requestId)), mined=mode!=='hold';
    const op={accountId:input.accountId,chainId:input.chainId,requestId:input.requestId,operationId:String(sends.length),kind:'transaction',status:mined?'confirmed':'submitted',address:account.address,transactionHash:hash,signature:null,reviewRevision:'1',message:null,receipt:mined?receipt():null};
    operations.set(input.requestId,op);transactions.set(hash,{chainId:input.chainId,transactionHash:hash,walletRequestMatches:null,transaction:{from:account.address,to:input.to,valueWei:input.valueWei,data:input.data,nonce:String(sends.length-1),blockNumber:mined?'25922608':null,blockHash:mined?'0x'+'44'.repeat(32):null},receipt:op.receipt,observedAtNs:ns(),source:'evm_rpc'});
    const decoded=decodeFunctionData({abi:effects,data:input.data});
    if(decoded.functionName==='approve')allowances.set(normalize(input.to)+':'+normalize(decoded.args[0]),decoded.args[1]);
    if(decoded.functionName==='add_liquidity')lpBalance+=decoded.args[0].reduce((sum,v)=>sum+v,0n);
    if(decoded.functionName.startsWith('remove_liquidity'))lpBalance-=decoded.args[0];
    if(mode==='lost'){mode='confirm';throw Error('Wallet reply lost after broadcast');}
    return op;
  }
  throw Error('Unimplemented wallet call '+name);
}
const errors=[]; let fixturePage;
try {
  const page=await browser.newPage({viewport:{width:1000,height:1080}});
  fixturePage=page;
  page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('fixture',fixture);
  // JSON schemas are validated with the same library used by the app's tool
  // contract tests; nested ABI results additionally pass the actual Wallet SDK.
  await page.route('https://api.curve.finance/**',async route=>{
    if(discoveryFails)return route.fulfill({status:503,body:'Unavailable'});
    const chain=route.request().url().includes('/arbitrum/')?'42161':'1',coins=chain==='1'?[WETH,CRVUSD]:[ARBWETH,ARBUSD];
    const data=route.request().url().endsWith('factory-stable-ng')?[{id:'factory-stable-ng-1',address:POOL,name:'crvUSD / WETH',lpTokenAddress:POOL,isMetaPool:false,usdTotal:14850000,coins:coins.map((address,i)=>({address,symbol:i?'crvUSD':'WETH',decimals:18}))}]:[];
    if(data.length) {
      // Same-symbol impostors in a pool advertising much more TVL than the
      // working fixture must never receive a listed badge or top priority.
      data.push({id:'factory-stable-ng-2',address:'0x4444444444444444444444444444444444444444',name:'Duplicate symbols',isMetaPool:false,usdTotal:1e15,
        coins:(chain==='1'?[[FAKE_USDC,'USDC'],[USDC,'USDC'],[FAKE_USDT,'USDT'],[USDT,'USDT']]:[[ARBUSDC,'USDC'],[BRIDGED_USDC,'USDC']])
          .map(([address,symbol])=>({address,symbol,decimals:6,listed:true}))});
    }
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,generatedTimeMs:Date.now(),data:{poolData:data}})});
  });
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByLabel('You pay amount').fill('0.1');
  await page.getByRole('button',{name:'Review swap',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('.cv-primary').disabled);
  assert((await page.getByLabel('You receive',{exact:true}).textContent()).includes('300'));
  await page.screenshot({path:resolve(artifacts,'swap-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Review swap',exact:true}).click();
  await page.getByText('Confirmed. The final transaction completed successfully.',{exact:true}).waitFor();
  assert.equal(sends.length,1,'Native swap needs no token approval');
  await page.getByRole('button',{name:'Liquidity',exact:true}).click();
  await page.getByRole('button',{name:/crvUSD \/ WETH/}).click();
  await page.getByLabel('Deposit WETH amount').fill('0.01');
  await page.getByLabel('Deposit crvUSD amount').fill('30');
  await page.waitForFunction(()=>document.querySelector('.cv-primary')?.textContent==='Review deposit'&&!document.querySelector('.cv-primary').disabled);
  await page.screenshot({path:resolve(artifacts,'liquidity-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Review deposit',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.cv-progress header strong')?.textContent==='Add liquidity to crvUSD / WETH'&&document.querySelector('.cv-progress .cv-badge')?.textContent==='Confirmed');
  assert.deepEqual(sends.slice(1).map(s=>decodeFunctionData({abi:effects,data:s.data}).functionName),['approve','approve','add_liquidity']);
  await page.getByRole('button',{name:'Remove liquidity',exact:true}).click();
  await page.getByRole('button',{name:'25%',exact:true}).click();
  await page.getByLabel('Withdrawal assets').selectOption('1');
  await page.waitForFunction(()=>document.querySelector('.cv-primary')?.textContent==='Review withdrawal'&&!document.querySelector('.cv-primary').disabled);
  await page.getByRole('button',{name:'Review withdrawal',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.cv-progress header strong')?.textContent==='Remove liquidity from crvUSD / WETH'&&document.querySelector('.cv-progress .cv-badge')?.textContent==='Confirmed');
  assert.equal(decodeFunctionData({abi:effects,data:sends.at(-1).data}).functionName,'remove_liquidity_one_coin');
  await page.getByRole('button',{name:'Swap',exact:true}).click();
  await page.getByLabel('You pay amount').fill('0.02');
  await page.waitForFunction(()=>!document.querySelector('.cv-primary').disabled);
  mode='lost';await page.getByRole('button',{name:'Review swap',exact:true}).click();
  await page.getByRole('button',{name:'Continue in wallet',exact:true}).waitFor();
  const count=sends.length;
  await page.reload();
  await page.getByRole('button',{name:/saved operation needs attention/}).click();
  await page.getByRole('button',{name:'Continue in wallet',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.cv-progress.cv-pending'));
  assert.equal(sends.length,count,'Reload must reconcile existing effects without duplicating them');
  await page.setViewportSize({width:360,height:900});
  await page.getByRole('button',{name:'Swap',exact:true}).click();
  await page.getByLabel('You pay amount').fill('0.03');
  await page.waitForFunction(()=>!document.querySelector('.cv-primary').disabled);
  await page.screenshot({path:resolve(artifacts,'swap-narrow.png'),fullPage:true});
  await page.getByRole('button',{name:'Select token, currently ETH',exact:true}).click();
  const picker=page.locator('dialog[open]'), options=picker.locator('.cv-token-option');
  await picker.getByLabel('Search tokens').fill('USDC');
  await options.filter({hasText:'Circle · native USDC'}).waitFor();
  assert.equal(await options.count(),2);
  assert.match(await options.first().getAttribute('aria-label'),new RegExp('Select USDC, listed token, '+USDC,'i'));
  assert.match(await options.last().getAttribute('aria-label'),new RegExp('Select USDC, unlisted token, '+FAKE_USDC,'i'));
  assert.equal(await picker.getByRole('link',{name:'View USDC contract on Ethereum'}).first().getAttribute('href'),'https://etherscan.io/token/'+getAddress(USDC));
  assert(await picker.evaluate(el=>el.scrollWidth<=el.clientWidth),'Token dialog overflow');
  await page.screenshot({path:resolve(artifacts,'duplicate-tokens-narrow.png'),fullPage:true});
  await picker.getByText('What do the labels mean?',{exact:true}).click();
  await picker.getByText(/This menu is not sorted by liquidity/).waitFor();
  await picker.getByText('What do the labels mean?',{exact:true}).click();
  await picker.getByLabel('Search tokens').fill('USDT');
  await options.filter({hasText:'Tether USD'}).waitFor();
  assert.match(await options.first().getAttribute('aria-label'),new RegExp('Select USDT, listed token, '+USDT,'i'));
  assert.match(await options.last().getAttribute('aria-label'),/unlisted token/);
  await picker.getByLabel('Search tokens').fill(FAKE_USDC);
  await options.filter({hasText:'USDC'}).waitFor();
  assert.equal(await options.count(),1);
  await options.first().click();
  const selectedIdentity=page.locator('.cv-amount').first().locator('.cv-token-identity');
  assert.match(await selectedIdentity.locator('summary').textContent(),/Unlisted/);
  await selectedIdentity.locator('summary').click();
  assert.equal(await selectedIdentity.getByRole('link',{name:'View USDC contract',exact:true}).getAttribute('href'),'https://etherscan.io/token/'+FAKE_USDC);
  await page.screenshot({path:resolve(artifacts,'unlisted-selection-narrow.png'),fullPage:true});
  await selectedIdentity.locator('summary').click();
  await page.getByRole('button',{name:'Select token, currently USDC',exact:true}).click();
  await picker.getByLabel('Search tokens').fill('0x9999999999999999999999999999999999999999');
  await options.filter({hasText:'crvUSD'}).waitFor();
  assert.equal(await options.count(),1);
  assert.match(await options.first().getAttribute('aria-label'),/unlisted token/,'Custom onchain symbol must not confer listing');
  await picker.getByLabel('Search tokens').fill('ETH');
  await picker.getByRole('button',{name:'Select ETH, listed token, native Ether',exact:true}).click();
  await page.getByRole('button',{name:'Select token, currently ETH',exact:true}).click();
  await page.locator('dialog[open]').getByLabel('Search tokens').fill('crvUSD');
  await page.getByRole('button',{name:/crvUSD.*0xf939/i}).waitFor();
  await page.screenshot({path:resolve(artifacts,'token-picker-narrow.png'),fullPage:true});
  await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);
  rpcFails=true;await page.getByLabel('You pay amount').fill('0.04');
  await page.getByRole('alert').filter({hasText:/RPC|quote|routes/i}).first().waitFor();
  assert(await page.getByRole('button',{name:'Review swap',exact:true}).isDisabled());
  await page.screenshot({path:resolve(artifacts,'provider-error-narrow.png'),fullPage:true});
  rpcFails=false;await page.getByLabel('Network',{exact:true}).selectOption('42161');
  await page.getByLabel('You pay amount').fill('0.01');
  await page.waitForFunction(()=>!document.querySelector('.cv-primary').disabled);
  await page.getByRole('button',{name:'Review swap',exact:true}).click();
  await page.getByText('Confirmed. The final transaction completed successfully.',{exact:true}).waitFor();assert.equal(sends.at(-1).chainId,'42161');
  await page.getByRole('button',{name:'Select token, currently ETH',exact:true}).click();
  await picker.getByLabel('Search tokens').fill('USDC');
  await options.filter({hasText:'Bridged USDC from Ethereum'}).waitFor();
  assert.equal(await options.count(),2);
  assert.match(await options.first().getAttribute('aria-label'),new RegExp('Select USDC, listed token, '+ARBUSDC,'i'));
  assert.match(await options.last().getAttribute('aria-label'),new RegExp('Select USDC.e, listed token, '+BRIDGED_USDC,'i'));
  assert.equal(await picker.getByRole('link',{name:'View USDC.e contract on Arbitrum'}).getAttribute('href'),'https://arbiscan.io/token/'+getAddress(BRIDGED_USDC));
  await page.screenshot({path:resolve(artifacts,'arbitrum-usdc-narrow.png'),fullPage:true});
  await page.keyboard.press('Escape');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Narrow UI overflow');
  assert.deepEqual(errors,[]);
  const evidence={result:'passed',sends:sends.length,records:records.size,coverage:['live automatic quote','balances and USD','native swap','exact sequential approvals and deposit','single-coin withdrawal','saved reload after lost reply','token search and Escape','duplicate USDC/USDT address ordering and listing','full contract explorer links','selected unlisted identity','custom address remains unlisted','native versus bridged Arbitrum USDC','RPC failure','Arbitrum chain isolation','360px layout']};
  await writeFile(resolve(artifacts,'result.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
} catch(error) {
  if(fixturePage){await fixturePage.screenshot({path:resolve(artifacts,'failure.png'),fullPage:true});console.error((await fixturePage.locator('body').innerText()).slice(-4500));console.error(errors);}
  throw error;
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
