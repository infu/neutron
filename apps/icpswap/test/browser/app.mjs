/** Full production tile and real parsing/math/review components. Transport
 * responses and value-moving tool endpoints are deterministic local fixtures;
 * every nonlocal browser request is intercepted and no real asset is touched. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const out = process.env.ICPSWAP_APP_ARTIFACTS || "/tmp/neutron-icpswap-integration/ui";
await mkdir(out, { recursive: true });
const ids = ["ryjl3-tyaaa-aaaaa-aaaba-cai", "ss2fx-dyaaa-aaaar-qacoq-cai", "xevnm-gaaaa-aaaar-qafnq-cai", "mxzaz-hqaaa-aaaar-qaada-cai"];
const names = ["Internet Computer", "Chain-key Ethereum", "Chain-key USD Coin", "Chain-key Bitcoin"];
const symbols = ["ICP", "ckETH", "ckUSDC", "ckBTC"];
const prices = [2.42, 2485, 1, 78340];
const rows = ids.map((address, i) => ({ address, symbol: symbols[i], name: names[i], standard: "ICRC2", decimals: i === 2 ? 6 : i === 1 ? 18 : 8, price_usd: prices[i], price_icp: prices[i] / 2.42, quote: null, pool_count: 12, pinned: i === 0, note: "", added_at: Date.now() / 1000, verified: true, sample_count: 10, sparkline: [2, 3, 2.5, 4] }));
const tokens = rows.map((row, i) => ({ tokenLedgerId: row.address, tokenSymbol: row.symbol, tokenName: row.name, price: row.price_usd, priceChange24H: i === 1 ? -1.24 : 2.1, volumeUSD24H: 430000 / (i + 1), volumeUSD7D: 1300000, tvlUSD: 900000, marketCap: 300000000, priceLow24H: row.price_usd * .98, priceHigh24H: row.price_usd * 1.04, priceLow7D: row.price_usd * .96, priceHigh7D: row.price_usd * 1.08, priceLow30D: row.price_usd * .9, priceHigh30D: row.price_usd * 1.12, tvlUSDChange24H: 1.2, txCount24H: 100, totalVolumeUSD: 12000000 }));
const poolBase = { poolFee: 3000, token0Price: 1, token1Price: 2.42, token1LedgerId: ids[0], token1Name: names[0], token1Symbol: "ICP", tvlUSDChange24H: 0, txCount24H: 1, feesUSD24H: 0.01, volumeUSD7D: 1, totalVolumeUSD: 1, createTime: 1788880000000 };
const analyticsPools = [
  { ...poolBase, poolId: "aaaaa-aa", token0LedgerId: "r7inp-6aaaa-aaaaa-aaabq-cai", token0Name: "Test AETH", token0Symbol: "AETH", token0LiquidityAmount: "9.00000138", token1LiquidityAmount: "0.09449168", tvlUSD: 210364157, volumeUSD24H: 3 },
  { ...poolBase, poolId: "2vxsx-fae", token0LedgerId: "renrk-eyaaa-aaaaa-aaada-cai", token0Name: "Test ICPENGU", token0Symbol: "ICPENGU", token0LiquidityAmount: "99822760.50857113", token1LiquidityAmount: "0.00000016", tvlUSD: 130710517, volumeUSD24H: 2 },
  { ...poolBase, poolId: "rrkah-fqaaa-aaaaa-aaaaq-cai", token0LedgerId: "rdmx6-jaaaa-aaaaa-aaadq-cai", token0Name: "Unknown liquidity", token0Symbol: "UNKNOWN", token1LiquidityAmount: "0", tvlUSD: 0, volumeUSD24H: 1 },
];
const status = { last_refresh_at: Date.now() / 1000, last_refresh_error: null, cache_ready: true, icp_price_usd: 2.42, universe_tokens: 1200, universe_pools: 855, priced_tokens: 4, watchlist_size: 4 };
const candles = Array.from({ length: 30 }, (_, i) => {
  const v = 2.3 + Math.sin(i * .42) * .08 + i * .004;
  return { beginTime: (1788825600 - (30 - i) * 86400) * 1000, open: v, close: v + (i % 3 === 0 ? -.025 : .019), high: v + .045, low: v - .035, volumeUSD: 20000 + Math.sin(i) * 7000, tvlUSD: 900000 };
});
const fixture = `
  import {Principal} from '@icp-sdk/core/principal';
  import {getSqrtRatioAtTick} from '${root}/apps/icpswap/src/liquidity_math.ts';
  import {createDirectFundingRequest} from '${root}/apps/icpswap/src/funding.ts';
  import {createActionBackend} from '${root}/apps/icpswap/src/action_backend.ts';
  import {authorizeAction, ActionReviewDeclinedError} from '${root}/apps/icpswap/src/provider.ts';
  export {isJsonObject, isMsgBusInstallationUid} from '${root}/packages/neutron-tools/src/protocol.ts';
  const rows=${JSON.stringify(rows)}, status=${JSON.stringify(status)}, owner='3rurp-vyaaa-aaaay-aacua-cai';
  const pool='aaaaa-aa', retainedPool='2vxsx-fae', index='rrkah-fqaaa-aaaaa-aaaaq-cai';
  const t0={address:rows[0].address,standard:'ICRC2'}, t1={address:rows[2].address,standard:'ICRC2'};
  const listeners=new Set(), methods=new Map();
  const initialInput={kind:'claim',pool:retainedPool,positionId:'90',operationId:'f'.repeat(32)};
  const initial={plan_json:'',funding_json:'',result_json:'',revision:'0',id:initialInput.operationId,input_json:JSON.stringify({version:1,owner:{appId:'icpswap',rootMode:false},input:initialInput}),state:'uncertain',detail:'Saved payout requires a fresh pool observation.',created_at:'1788880800000000000',updated_at:'1788880800000000000',effects:[]};
  const recoverySourceId='d'.repeat(32), fundingRequestId='1'.repeat(32);
  const directRequest=createDirectFundingRequest({requestId:fundingRequestId,ledger:t1.address,pool:retainedPool,owner,amountAtoms:'1000000',feeAtoms:'10000',nowMs:1788880000000});
  const recoverySourcePlan={request:{pool:retainedPool,kind:'mint',position_id:null,tick_lower:'-39000',tick_upper:'-37800',amount0:'0',amount1:'1000000',liquidity:'0',withdraw_token:'',withdraw_amount:'0'},pool:retainedPool,owner,token0:t0,token1:{...t1,standard:'ICRC1'},fee:'3000',tick_spacing:'60',tick:'-37200',sqrt_price_x96:getSqrtRatioAtTick(-37200).toString(),fee0:'10000',fee1:'10000',funding0:'0',funding1:'1000000',expected_amount0:'0',expected_amount1:'1000000',expected_liquidity:'10000000',unused0:'0',unused1:'0',baseline_positions:[],observed_at:'1788880000000000000',price_protection:false,detail:'Direct token-1 funding only.'};
  const recoverySource={...initial,id:recoverySourceId,input_json:JSON.stringify({version:1,kind:'liquidity',owner:{appId:'agent',installationUid:'77',rootMode:true},input:{operationId:recoverySourceId,kind:'mint',pool:retainedPool,amount0:'0',amount1:'1000000',tickLower:-39000,tickUpper:-37800}}),plan_json:JSON.stringify(recoverySourcePlan),funding_json:JSON.stringify([directRequest]),result_json:JSON.stringify({kind:'wallet_funding_v1',results:[{requestId:fundingRequestId,result:{status:'transferred',commandId:'agent:'+fundingRequestId,blockIndex:'9007199254740993',duplicate:false,message:null}}]}),state:'funding_requested',detail:'Confirmed token-1 transfer awaits pool credit.'};
  const effect=(key,method,state)=>({key,canister:retainedPool,method,state,error:'',dispatched_at:'1788880900000000000',completed_at:state==='succeeded'?'1788880900000000001':null,result_nat:null,result_amount0:null,result_amount1:null});
  const summary=({plan_json,funding_json,result_json,...value})=>({...value,effects:value.effects.map(({result_nat,result_amount0,result_amount1,...item})=>item)});
  let durable=JSON.parse(localStorage.getItem('icpswap.browser.fixture')||'null')||{history:[initial,recoverySource],positionLiquidity:'1000000000',fees:true,unused0:'100000000',unused1:'1000000',newPosition:false};
  const state=window.__app={calls:[],queries:[],selfQueries:[],protocolDispatches:[],loseSwapReply:false,walletMissing:false,walletUnselected:[],quoteQueries:[],holdTokenInfo:true,releaseTokenInfo:[],walletInfoActive:false,walletInfoOverlap:0,walletDelay:40,walletBalances:{},walletFees:{},reverseMarkets:false,failQuote:false,failMarket:new URL(location.href).searchParams.has('market-failure'),addHold:false,updates:[],methods,durable};
  const persist=()=>{localStorage.setItem('icpswap.browser.fixture',JSON.stringify(durable));for(const fn of listeners)fn();};
  state.activityEvidence=new Map();
  state.installActivityEvidence=result=>{state.activityEvidence.set(result.operationId,structuredClone(result));const current=durable.history.find(row=>row.id===result.operationId);if(current)Object.assign(current,result.operation);else durable.history.push(structuredClone(result.operation));persist();};
  const record=(operationId,input,approved)=>({plan_json:'',funding_json:'',result_json:'',revision:'0',id:operationId,input_json:JSON.stringify({version:1,owner:{appId:'icpswap',rootMode:false},input}),state:approved?'complete':'stopped',detail:approved?'Fixture action completed and payout observed.':'Owner declined this prepared action.',created_at:'1788880900000000000',updated_at:'1788880900000000000',effects:[effect(input.kind||'swap',input.kind||'swap',approved?'succeeded':'not_requested')]});
  const progress=(operation)=>({operationId:operation.id,state:operation.state,message:operation.detail,operation});
  export const exposeTool=(name,definition,handler)=>methods.set(name,{definition,handler});
  export const onAppStateChange=(_,callback)=>{listeners.add(callback);return()=>listeners.delete(callback);};
  export const onTileViewRequest=()=>()=>{};
  export const loadNeutronCanisterId=async()=>owner;
  export const copyToClipboard=async(value)=>{state.clipboard=value;};
  export async function callTool(request){
    state.calls.push(structuredClone(request));
    const args=request.arguments||{}, name=request.name;
    if(name==='icpswap_owner_review_v1')return methods.get(name).handler(args,{caller:{appId:'icpswap',installationUid:'42',role:'background',endpoint:'app:icpswap:background'},agentMode:false,signal:new AbortController().signal});
    if(name==='wallet_token_info_v1'){
      // A Wallet read can need owner consent. The real Kernel permits one
      // active owner request; overlapping pair reads must not race its dialog.
      if(state.walletInfoActive){state.walletInfoOverlap++;throw Error('Another app request is active');}
      state.walletInfoActive=true;
      try{
        await new Promise(resolve=>setTimeout(resolve,state.walletDelay));
        if(state.walletMissing)throw Error('Fixture Wallet metadata unavailable');
        if(state.walletUnselected.includes(args.ledger))throw Error('Ledger is not selected in Wallet');
        const row=rows.find(row=>row.address===args.ledger); if(!row)throw Error('Unknown fixture ledger');
        return {ledger:row.address,account:owner,name:row.name,symbol:row.symbol,decimals:row.decimals,feeAtoms:state.walletFees[row.address]||'10000',balanceAtoms:state.walletBalances[row.address]||(13n*10n**BigInt(row.decimals)).toString(),observedAtNs:'1788880800000000000'};
      }finally{state.walletInfoActive=false;}
    }
    if(name==='wallet_add_ledger_v1'){
      if(state.walletInfoActive){state.walletInfoOverlap++;throw Error('Another app request is active');}
      state.walletInfoActive=true;
      try{
        const decision=await methods.get('icpswap_owner_review_v1').handler({reviewJson:JSON.stringify({title:'Add token to Wallet',ledger:args.ledger,notes:['This selects a ledger without moving funds.']})},{caller:{appId:'icpswap',installationUid:'42',role:'background',endpoint:'app:icpswap:background'},agentMode:false,signal:new AbortController().signal});
        if(!decision.approved)throw Error('Wallet token setup declined.');
        state.walletUnselected=state.walletUnselected.filter(ledger=>ledger!==args.ledger);
        return {ledger:args.ledger,selected:true};
      }finally{state.walletInfoActive=false;}
    }
    if(name==='icpswap_history_v1'){const page=await createActionBackend({querySelf,updateSelf}).actionPage({cursor:args.cursor??null,limit:args.limit??20});state.lastHistory=structuredClone(page.items);return page;}
    if(name==='icpswap_reconcile_v1'){
      if(state.activityEvidence.has(args.operationId))return structuredClone(state.activityEvidence.get(args.operationId));
      const operation=durable.history.find(row=>row.id===args.operationId);if(!operation)throw Error('Unknown saved operation');
      state.queries.push({canister:JSON.parse(operation.input_json).input.pool||pool,method:'fixture-status-fresh-pool-observation'});
      if(operation.id===recoverySourceId)return {...progress(structuredClone(operation)),plan:recoverySourcePlan,pool:{unused0:'0',unused1:'500000',queue:[],transactions:[],protocol_diagnostics:''}};
      operation.state='complete';operation.detail='Reconciled against a fresh fixture pool observation.';persist();return {...progress(operation),plan:{},pool:{unused0:'0',unused1:'500000',queue:[],transactions:[],protocol_diagnostics:''}};
    }
    if(name==='icpswap_recover_deposit_v1'){
      if(args.sourceOperationId!==recoverySourceId||args.tokenIndex!==1||args.operationId===recoverySourceId)throw Error('Recovery changed source identity or canonical token leg');
      let operation=durable.history.find(row=>row.id===args.operationId);
      if(!operation){operation={...initial,id:args.operationId,input_json:JSON.stringify({version:1,kind:'recover_deposit',owner:{appId:'icpswap',installationUid:'42',rootMode:false},input:{sourceOperationId:args.sourceOperationId,tokenIndex:args.tokenIndex}}),state:'prepared',detail:'Existing transfer prepared for pool credit.'};durable.history.push(operation);persist();}
      const decision=await methods.get('icpswap_owner_review_v1').handler({reviewJson:JSON.stringify({title:'Recover an ICPSwap pool deposit',sourceOperationId:args.sourceOperationId,token:'ckUSDC',amountAlreadyTransferred:'1.01 ckUSDC',depositFee:'0.01 ckUSDC',expectedPoolCredit:'1 ckUSDC',notes:['No new Wallet funding is requested.'],exactAction:args})},{caller:{appId:'icpswap',installationUid:'42',role:'background',endpoint:'app:icpswap:background'},agentMode:false,signal:new AbortController().signal});
      if(!decision.approved)throw Error('Owner declined recovery');
      operation.state='complete';operation.detail='Existing transfer credited to unused pool funds.';operation.revision='1';operation.effects=[effect('recover_deposit','deposit','succeeded')];
      const source=durable.history.find(row=>row.id===recoverySourceId);source.effects=[effect('deposit1','deposit','succeeded')];source.revision='1';source.detail='Token-1 direct deposit recovered into unused pool funds.';persist();
      return {...progress(structuredClone(operation)),plan:{source_id:recoverySourceId,token_index:'1',pool:retainedPool},fundingInstructions:[]};
    }
    if(['icpswap_liquidity_v1','icpswap_swap_v1','icpswap_continue_v1'].includes(name)){
      const existing=durable.history.find(row=>row.id===args.operationId);
      const input=name==='icpswap_continue_v1'?JSON.parse(existing.input_json).input:structuredClone(args);
      if(name==='icpswap_swap_v1'){
        if(existing&&existing.state==='complete')return {...progress(existing),plan:{},fundingInstructions:[]};
        const operation=existing||{...record(args.operationId,input,false),state:'prepared',detail:'Saved swap awaits owner review.',effects:[]};
        if(!existing){durable.history.push(operation);persist();}
        try{
          await authorizeAction({caller:{appId:'icpswap',installationUid:'42',role:'tile',endpoint:'app:icpswap:tile:main:instance:browser'},kernel:{callTool},agentMode:false,signal:new AbortController().signal},{title:'Review swap',...input});
        }catch(error){
          // Only the actual provider's explicit refusal, with this fixture's
          // pristine prepared journal, establishes the no-dispatch result.
          // Transport failures are deliberately allowed to reach the UI.
          if(error instanceof ActionReviewDeclinedError&&operation.state==='prepared'&&!operation.funding_json&&!operation.result_json&&operation.effects.length===0){
            return {...progress(operation),state:'review_declined',message:'ICPSwap action review declined. No funding or protocol action was requested. You can edit this swap.',plan:{},fundingInstructions:[]};
          }
          throw error;
        }
        state.protocolDispatches.push({operationId:args.operationId,input:structuredClone(input)});
        Object.assign(operation,record(args.operationId,input,true));persist();
        if(state.loseSwapReply){state.loseSwapReply=false;throw Error('Fixture swap reply was interrupted after the saved effect.');}
        return {...progress(operation),plan:{},fundingInstructions:[]};
      }
      const decision=await methods.get('icpswap_owner_review_v1').handler({reviewJson:JSON.stringify({title:name==='icpswap_swap_v1'?'Review swap':'Review '+input.kind,...input})},{caller:{appId:'icpswap',installationUid:'42',role:'background',endpoint:'app:icpswap:background'},agentMode:false,signal:new AbortController().signal});
      const operation=record(args.operationId,input,decision.approved);
      if(existing)Object.assign(existing,operation);else durable.history.push(operation);
      if(decision.approved){if(input.kind==='decrease')durable.positionLiquidity=(BigInt(durable.positionLiquidity)-BigInt(input.liquidity)).toString();if(input.kind==='claim')durable.fees=false;if(input.kind==='withdraw')durable[input.token===t0.address?'unused0':'unused1']='0';if(input.kind==='mint')durable.newPosition=true;}
      persist();return {...progress(operation),plan:{},pool:{unused0:'0',unused1:'500000',queue:[],transactions:[],protocol_diagnostics:''}};
    }
    throw Error('Unexpected fixture tool '+name);
  }
  export async function querySelf(name,args){
    state.selfQueries.push({name,args:structuredClone(args)});
    if(name==='icpswap_action_page'){
      const all=[...durable.history].reverse().map(summary), {cursor,limit}=args[0];
      const start=cursor==null?0:all.findIndex(item=>item.id===cursor)+1, items=all.slice(start,start+Number(limit));
      // The Kernel omits absent optional record fields, including the final
      // cursor and completion timestamps of pending protocol effects.
      const projected=items.map(item=>({...item,effects:item.effects.map(({completed_at,...effect})=>completed_at==null?effect:{...effect,completed_at})}));
      return start+items.length<all.length?{items:projected,next_cursor:items.at(-1).id}:{items:projected};
    }
    if(name==='icpswap_market'&&state.failMarket)throw Error('Fixture saved token read failed');
    if(name==='icpswap_market')return {rows:state.reverseMarkets?[...rows].reverse():rows,status};
    if(name==='icpswap_token')return {row:rows.find(row=>row.address===args[0]),profile:null,pools:[],pool_count:0,history:[],status};
    if(name==='icpswap_swap_journal')return {entries:[],slippage:500,total:0,completed:0};
    if(name==='icpswap_search')return {items:rows,total:rows.length,universe:rows.length,offset:0,cache_age_seconds:0};
    throw Error('Unexpected fixture query '+name);
  }
  export async function updateSelf(name,args){
    state.updates.push({name,args});
    if(name==='icpswap_add'&&state.addHold)await new Promise(resolve=>{state.releaseAdd=resolve;});
    if(name==='icpswap_set_token_info'){if(state.holdTokenInfo)await new Promise(resolve=>state.releaseTokenInfo.push(resolve));return true;}
    if(name==='icpswap_set_slippage')return args[0];
    if(name==='icpswap_refresh')return {refreshed:true,status,errors:[]};
    if(['icpswap_add','icpswap_remove','icpswap_set_pinned','icpswap_set_note'].includes(name))return {ok:true,message:'Saved',watchlist_size:rows.length};
    if(name==='icpswap_swap_quote')throw Error('Browser quotes must not route through the ICPSwap backend');
    throw Error('Unexpected fixture update '+name);
  }
  export const createMsgBusClient=()=>({callTool,querySelf,updateSelf});
  const swapPoolIds=['aaaaa-aa','2vxsx-fae','rrkah-fqaaa-aaaaa-aaaaq-cai','r7inp-6aaaa-aaaaa-aaabq-cai','renrk-eyaaa-aaaaa-aaada-cai','rdmx6-jaaaa-aaaaa-aaadq-cai'];
  const swapPools=[];
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
    const first=rows[i],second=rows[j],canisterId=Principal.fromText(swapPoolIds[swapPools.length]);
    swapPools.push({key:first.address+'/'+second.address+'/3000',token0:{address:first.address,standard:'ICRC2'},token1:{address:second.address,standard:'ICRC2'},fee:3000n,tickSpacing:60n,canisterId});
  }
  state.querySwapQuote=async({canister,method,args,signal})=>{
    signal?.throwIfAborted();
    state.quoteQueries.push({canister,method,args:structuredClone(args)});
    if(method==='getPool'){
      const request=args[0];
      const found=swapPools.find(pool=>[pool.token0.address,pool.token1.address].includes(request.token0.address)&&[pool.token0.address,pool.token1.address].includes(request.token1.address));
      return BigInt(request.fee)===3000n&&found?{ok:found}:{err:{CommonError:null}};
    }
    const pool=swapPools.find(pool=>pool.canisterId.toText()===canister);if(!pool)throw Error('Unknown fixture quote pool');
    const token0=rows.find(row=>row.address===pool.token0.address),token1=rows.find(row=>row.address===pool.token1.address);
    if(method==='metadata'){
      const tick=Math.floor(Math.log(token0.price_usd/token1.price_usd*10**(token1.decimals-token0.decimals))/Math.log(1.0001));
      return {ok:{key:pool.key,token0:pool.token0,token1:pool.token1,fee:pool.fee,sqrtPriceX96:getSqrtRatioAtTick(tick),tick:BigInt(tick),liquidity:100000000000000000000n}};
    }
    if(method==='getCachedTokenFee')return {token0Fee:10000n,token1Fee:10000n};
    if(method==='quote'){
      if(state.failQuote)throw Error('Fixture route currently unavailable');
      const request=args[0],first=request.zeroForOne?token0:token1,second=request.zeroForOne?token1:token0;
      const output=BigInt(Math.floor(Number(request.amountIn)/10**first.decimals*first.price_usd/second.price_usd*10**second.decimals*.997));
      return {ok:output};
    }
    throw Error('Unexpected direct swap quote query '+method);
  };
  state.queryPool=async({canister,method,args,signal})=>{
    signal.throwIfAborted();state.queries.push({canister,method,args:args.map(arg=>typeof arg==='bigint'?arg.toString():arg?.toText?.()||arg)});
    if(method==='getPools')return {ok:[pool,retainedPool].map(id=>({key:id,token0:t0,token1:t1,fee:3000n,tickSpacing:60n,canisterId:Principal.fromText(id)}))};
    if(method==='getInitArgs')return {ok:{positionIndexCid:Principal.fromText(index)}};
    if(method==='getUserPools')return {ok:[pool]};
    if(method==='metadata')return {ok:{key:canister,token0:t0,token1:t1,fee:3000n,sqrtPriceX96:getSqrtRatioAtTick(-37200),tick:-37200n,liquidity:1000000000000n}};
    if(method==='getCachedTokenFee')return {token0Fee:10000n,token1Fee:10000n};
    if(method==='getAvailabilityState')return {available:true,whiteList:[]};
    const position={id:7n,tickLower:-37800n,tickUpper:-36600n,liquidity:BigInt(durable.positionLiquidity),tokensOwed0:durable.fees?12345n:0n,tokensOwed1:durable.fees?23456n:0n};
    if(method==='getUserPositionsByPrincipal'&&state.incompleteOwnership)throw Error('Fixture ownership query unavailable');
    if(method==='getUserPositionsByPrincipal')return {ok:canister===pool?[position,...(durable.newPosition?[{...position,id:8n,liquidity:100000000n}]:[])]:[]};
    if(method==='getUserPosition')return {ok:position};
    if(method==='getUserUnusedBalance'&&state.incompleteOwnership)return {ok:{balance0:0n,balance1:0n}};
    if(method==='getUserUnusedBalance')return {ok:{balance0:canister===pool?BigInt(durable.unused0):0n,balance1:canister===pool?BigInt(durable.unused1):state.failedWithdrawal?0n:500000n}};
    if(method==='getWithdrawQueueInfo')return {ok:{items:[],isProcessing:false,queueSize:0n}};
    if(method==='getTransactionsByOwner'){const failed=state.failedWithdrawal&&canister===retainedPool, reserved=state.reserveWithdrawal&&canister===pool; return {ok:failed||reserved?[[71n,{id:71n,owner:Principal.fromText(owner),timestamp:1788880800000000000n,action:{Withdraw:{status:failed?{Failed:null}:{Created:null},err:failed?['Fixture ledger transfer failed']:[],transfer:{token:Principal.fromText(t0.address),amount:20000000n,fee:10000n}}}}]]:[]};}
    throw Error('Unexpected direct protocol query '+method);
  };
`;
const wrapper = `import {createLiquidityReadClient as realClient} from '${root}/apps/icpswap/src/liquidity_reads.ts'; export const createLiquidityReadClient=()=>realClient({query:(request)=>window.__app.queryPool(request)});`;
const quoteWrapper = `export * from '${root}/apps/icpswap/src/swap_quote.ts'; import {createSwapQuoteReader} from '${root}/apps/icpswap/src/swap_quote.ts'; export const swapQuoteReader=createSwapQuoteReader({query:(request)=>window.__app.querySwapQuote(request)});`;
const output = await build({
  absWorkingDir: root, entryPoints: ["apps/icpswap/src/index.tsx"], bundle: true, write: false, format: "iife", jsx: "automatic", outdir: out,
  plugins: [{ name: "local-transports", setup(builder) {
    builder.onResolve({ filter: /^(neutron-tools\/app|\.\/liquidity_reads\.ts|\.\/swap_quote\.ts|\.\/logos\.ts)$/ }, args => ({ path: args.path, namespace: "local-transports" }));
    builder.onLoad({ filter: /.*/, namespace: "local-transports" }, args => ({ contents: args.path === "neutron-tools/app" ? fixture : args.path === "./liquidity_reads.ts" ? wrapper : args.path === "./swap_quote.ts" ? quoteWrapper : "export const peekLogo=()=>null;export const onLogoResolved=()=>()=>{};export const resolveLogo=async()=>null;export const markLogoBroken=()=>{};", loader: "js", resolveDir: root }));
  } }, sassPlugin()], logLevel: "warning",
});
const assets = { "/main.js": output.outputFiles.find(file => file.path.endsWith(".js")).text, "/main.css": output.outputFiles.find(file => file.path.endsWith(".css")).text, "/static/icon.svg": await readFile(join(root, "apps/icpswap/public/static/icon.svg")) };
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url.endsWith(".css") ? "text/css" : req.url.endsWith(".svg") ? "image/svg+xml" : req.url.endsWith(".js") ? "text/javascript" : "text/html");
  res.end(assets[req.url] ?? '<!doctype html><html><head><link rel="stylesheet" href="/main.css"><style>body{margin:0}#root{height:100dvh}</style></head><body><div id="root"></div><script src="/main.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const checks = [], errors = [];
const analyticsRequests = [];
let positionHistoryAvailable = true;
  let analyticsUnavailable = false;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/google-chrome-stable", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:")) return route.continue();
    if (url.startsWith("https://api.icpswap.com/info/")) {
      const parsed = new URL(url), path = parsed.pathname;
      analyticsRequests.push(path);
      if (analyticsUnavailable && path === "/info/token/all") return route.fulfill({contentType:"application/json",body:JSON.stringify({code:500,message:"Fixture analytics unavailable"})});
      let data = path === "/info/token/all" ? [...tokens, {...tokens[0],tokenLedgerId:"r7inp-6aaaa-aaaaa-aaabq-cai",tokenSymbol:"TEST",tokenName:"Test discovery token"}] : path === "/info/token/chart/list" ? [] : path.includes("/chart/") ? { content: candles, totalElements: candles.length } : path.includes("/transaction/") ? { content: [], totalElements: 0 } : [];
      if (/^\/info\/token\/[^/]+\/pool$/.test(path)) data = analyticsPools;
      if (path === "/info/transaction/find" || path === "/info/record/transferPosition/list") {
        const pool = parsed.searchParams.get("poolId") || parsed.searchParams.get("poolIds");
        const history = positionHistoryAvailable && path === "/info/transaction/find" && pool === "aaaaa-aa" ? [{
          poolId: pool, positionId: 7, txHash: "fixture-original-position-7", txTime: 1788880000000,
          fromPrincipalId: "3rurp-vyaaa-aaaay-aacua-cai", fromSubaccount: "0".repeat(64),
          token0LedgerId: ids[0], token1LedgerId: ids[2], actionType: "AddLiquidity", liquidity: "1000000000",
          token0AmountIn: "1", token1AmountIn: "4", token0AmountOut: "0", token1AmountOut: "0",
          token0Price: "2.3", token1Price: "1",
        }] : [];
        data = { content: history, totalElements: history.length, page: 1, limit: 100 };
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 200, data }), headers: { "Access-Control-Allow-Origin": "*" } });
    }
    return route.abort();
  });
  const navigate = name => page.getByRole("navigation", { name: "ICPSwap views" }).getByRole("button", { name, exact: true }).click();
  const tokenTrigger = leg => page.getByRole("button", { name: leg === "pay" ? "Token to pay" : "Token to receive", exact: true });
  const pickerSearch = () => page.getByLabel("Search by token name, symbol, or address", { exact: true });
  const pickerToken = address => page.locator(".ics-picker-row").filter({ has: page.locator(`[title="Token address: ${address}"]`) });
  const chooseSwapToken = async (leg, address) => {
    await tokenTrigger(leg).click();
    await page.getByRole("dialog", { name: leg === "pay" ? "Pay with" : "Receive token", exact: true }).waitFor();
    await pickerSearch().fill(address);
    await pickerToken(address).click();
    await page.locator(".ics-picker-dialog").waitFor({ state: "detached" });
  };
  const noOverflow = async (name, selector = ".ics-body") => {
    const geometry = await page.locator(selector).evaluate(node => ({ page: document.documentElement.scrollWidth > innerWidth, content: node.scrollWidth > node.clientWidth, box: node.getBoundingClientRect().toJSON() }));
    assert.equal(geometry.page, false, `${name}: page overflow`);
    assert.equal(geometry.content, false, `${name}: component overflow ${JSON.stringify(geometry)}`);
  };
  const showPositions = async () => { await navigate("Liquidity"); await page.getByText("Position #7", { exact: true }).waitFor(); };
  const lastAction = async () => page.evaluate(() => [...window.__app.calls].reverse().find(call => ["icpswap_liquidity_v1", "icpswap_swap_v1"].includes(call.name)));
  const approve = async (yes = true) => { await page.getByRole("dialog").waitFor(); await page.getByRole("button", { name: yes ? "Approve action" : "Decline", exact: true }).click(); await page.waitForFunction(() => !document.querySelector("dialog")); };
  for (const width of [320, 360, 480, 960, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("heading", { name: "via ICPSwap", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "ICPSwap views" }).getByRole("button").count(), 5);
    assert.equal(await page.locator(".ics-tab").evaluateAll(nodes => nodes.every(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length === 1; })), true, `Navigation labels stay on one line at ${width}px`);
    await page.getByRole("slider", { name: "Percentage of spendable balance" }).waitFor();
    assert.equal(await page.locator(".ics-trade-markets, .ics-market-card, .ics-table").count(), 0, `Swap contains only the trade panel at ${width}px`);
    assert.equal(await page.locator(".ics-swap select").count(), 0, "both swap legs use the shared token picker");
    await page.locator(".ics-allocation-presets").getByRole("button", { name: "Max", exact: true }).click();
    assert.equal(await page.getByLabel("You pay", { exact: true }).inputValue(), "12.9998");
    assert.equal(await page.getByRole("slider", { name: "Percentage of spendable balance" }).inputValue(), "100");
    assert.match(await page.locator(".ics-swap-balance").innerText(), /Balance 13 ICP/);
    await page.locator(".ics-allocation-presets").getByRole("button", { name: "50%", exact: true }).click();
    assert.equal(await page.getByLabel("You pay", { exact: true }).inputValue(), "6.4999");
    await page.getByRole("slider", { name: "Percentage of spendable balance" }).fill("25");
    assert.equal(await page.getByLabel("You pay", { exact: true }).inputValue(), "3.24995");
    await page.locator(".ics-allocation-presets").getByRole("button", { name: "0%", exact: true }).click();
    assert.equal(await page.getByLabel("You pay", { exact: true }).inputValue(), "0");
    assert.equal(await page.getByText("Enter an amount greater than zero.", { exact: true }).count(), 0);
    await page.locator(".ics-allocation-presets").getByRole("button", { name: "Max", exact: true }).click();
    await page.locator(".ics-swap-minimum").waitFor();
    await page.waitForFunction(() => !window.__app.walletInfoActive);
    if(width===320){
      const warmBefore=await page.evaluate(()=>({queries:window.__app.quoteQueries.length,updates:window.__app.updates.length}));
      await page.getByLabel("You pay",{exact:true}).fill("1");
      await page.locator(".ics-swap-minimum").waitFor();
      assert.deepEqual(await page.evaluate(from=>window.__app.quoteQueries.slice(from).map(query=>query.method),warmBefore.queries),["quote"],"warm amount change makes only one direct pool quote query");
      assert.equal(await page.evaluate(from=>window.__app.updates.slice(from).some(update=>['icpswap_swap_quote','icpswap_set_token_info'].includes(update.name)),warmBefore.updates),false,"amount edits do not wait on backend quote or metadata persistence updates");
      await page.locator(".ics-allocation-presets").getByRole("button",{name:"Max",exact:true}).click();
      await page.locator(".ics-swap-minimum").waitFor();
    }
    assert.equal(await page.evaluate(()=>window.__app.updates.some(update=>update.name==='icpswap_set_token_info')),false,"a ready browser quote must not require token-info persistence updates");
    await page.evaluate(()=>{window.__app.holdTokenInfo=false;for(const release of window.__app.releaseTokenInfo)release();window.__app.releaseTokenInfo=[];});
    const selectionBefore = await page.evaluate(() => ({ updates: window.__app.updates.length, effects: window.__app.calls.filter(call => call.name === "icpswap_swap_v1" || call.name === "icpswap_liquidity_v1" || call.name.startsWith("wallet_fund") || call.name === "wallet_add_ledger_v1").length }));
    const selectedAmount = await page.getByLabel("You pay", { exact: true }).inputValue();
    await tokenTrigger("pay").click();
    await page.getByRole("dialog", { name: "Pay with", exact: true }).waitFor();
    assert.equal(await pickerSearch().evaluate(node => node === document.activeElement), true, "opening the token picker focuses search");
    await pickerSearch().fill("Internet Computer");
    const watchedPay = pickerToken(ids[0]);
    assert.equal(await watchedPay.isDisabled(), false, "a watched selected token remains selectable in swap mode");
    assert.match(await watchedPay.innerText(), /Internet Computer/);
    assert.match(await watchedPay.innerText(), /Selected/);
    assert.match(await watchedPay.locator(".ics-picker-stats").innerText(), /\$2\.42/);
    assert.match(await watchedPay.locator(".ics-picker-stats").innerText(), /2\.1/);
    assert.match(await watchedPay.locator(".ics-picker-stats").textContent(), /vol/);
    assert.equal(await watchedPay.locator(".ics-picker-canister").getAttribute("title"), `Token address: ${ids[0]}`);
    await noOverflow(`pay-token-picker-${width}`, ".ics-picker");
    await page.screenshot({ path: join(out, `swap-pay-picker-${width}.png`) });
    await pickerSearch().press("Escape");
    await page.locator(".ics-picker-dialog").waitFor({ state: "detached" });
    assert.equal(await tokenTrigger("pay").evaluate(node => node === document.activeElement), true, "Escape restores focus to the pay selector");
    assert.equal(await page.getByLabel("You pay", { exact: true }).inputValue(), selectedAmount, "dismissal preserves the amount");
    await tokenTrigger("pay").click();
    await pickerSearch().fill(ids[0]);
    await pickerSearch().press("Enter");
    await page.locator(".ics-picker-dialog").waitFor({ state: "detached" });
    assert.equal(await page.getByLabel("You pay", { exact: true }).inputValue(), selectedAmount, "reselecting the current watched token preserves the amount");
    await tokenTrigger("receive").click();
    await page.getByRole("dialog", { name: "Receive token", exact: true }).waitFor();
    await pickerSearch().fill(ids[0]);
    assert.equal(await pickerToken(ids[0]).count(), 0, "receive choices exclude the token being paid");
    await page.getByText(`No token matches “${ids[0]}”.`, { exact: true }).waitFor();
    await pickerSearch().fill("Chain-key");
    await page.locator('.ics-picker-row[data-index="1"]').waitFor();
    await pickerSearch().press("ArrowDown");
    assert.equal(await page.locator('.ics-picker-row[data-index="1"]').evaluate(node => node.classList.contains("nt-tag--selected")), true, "search arrow keys move the active token");
    await noOverflow(`receive-token-picker-${width}`, ".ics-picker");
    await page.screenshot({ path: join(out, `swap-receive-picker-${width}.png`) });
    await pickerSearch().press("Enter");
    await page.locator(".ics-picker-dialog").waitFor({ state: "detached" });
    assert.match(await tokenTrigger("receive").innerText(), /ckETH/, "keyboard commit selects the second symbol-ranked matching token");
    assert.equal(await page.getByLabel("You pay", { exact: true }).inputValue(), selectedAmount, "receive selection preserves the pay amount");
    await tokenTrigger("pay").click();
    await pickerSearch().fill(ids[1]);
    assert.equal(await pickerToken(ids[1]).count(), 0, "pay choices exclude the token being received");
    await pickerSearch().press("Escape");
    await page.locator(".ics-picker-dialog").waitFor({ state: "detached" });
    if (width === 320) {
      await page.getByRole("button", { name: "Reverse swap direction", exact: true }).click();
      assert.equal(await tokenTrigger("pay").getAttribute("data-ledger"), ids[1]);
      assert.equal(await tokenTrigger("receive").getAttribute("data-ledger"), ids[0]);
      assert.equal(await page.getByLabel("You pay", { exact: true }).inputValue(), "", "reversing the pair cannot reuse a numeric amount in another token");
      assert.equal(await page.locator(".ics-swap-minimum").count(), 0, "reversing the pair clears the old executable quote");
      await page.getByRole("button", { name: "Reverse swap direction", exact: true }).click();
      assert.equal(await tokenTrigger("pay").getAttribute("data-ledger"), ids[0]);
      assert.equal(await tokenTrigger("receive").getAttribute("data-ledger"), ids[1]);
      await page.waitForFunction(() => !document.querySelector('[aria-label="Percentage of spendable balance"]').disabled);
      await page.locator(".ics-allocation-presets").getByRole("button", { name: "Max", exact: true }).click();
      await page.locator(".ics-swap-minimum").waitFor();
    }
    assert.deepEqual(await page.evaluate(() => ({ updates: window.__app.updates.length, effects: window.__app.calls.filter(call => call.name === "icpswap_swap_v1" || call.name === "icpswap_liquidity_v1" || call.name.startsWith("wallet_fund") || call.name === "wallet_add_ledger_v1").length })), selectionBefore, "browsing and selecting known swap tokens never writes the backend or starts Wallet setup/funding/trades");
    await noOverflow(`swap-${width}`, ".ics-swap");
    await page.screenshot({ path: join(out, `swap-${width}.png`) });
    await navigate("Markets");
    await noOverflow(`markets-${width}`);
    await page.screenshot({ path: join(out, `markets-${width}.png`) });
    const detailReadsBefore = await page.evaluate(() => ({ queries: window.__app.queries.length, updates: window.__app.updates.length, selfQueries: window.__app.selfQueries.length }));
    const detailAnalyticsBefore = analyticsRequests.length;
    await page.locator(width < 700 ? ".ics-market-card" : ".ics-table tbody tr").first().click();
    await page.locator(".ics-chart-canvas").first().waitFor();
    assert((await page.locator(".ics-chart-canvas").first().boundingBox()).y < 450, `chart above initial fold ${width}`);
    await noOverflow(`detail-${width}`);
    await page.screenshot({ path: join(out, `detail-${width}.png`) });
    const poolsSection = page.locator("section.nt-section").filter({ has: page.getByRole("heading", { name: "Pools", exact: true }) });
    await poolsSection.locator(".ics-pool-composition").first().waitFor();
    assert.equal(await poolsSection.getByRole("columnheader", { name: "Reported TVL", exact: true }).count(), 1, "analytics USD value is explicitly attributed as reported TVL");
    const compositionRows = poolsSection.locator("tbody > tr");
    assert.equal(await compositionRows.count(), 3);
    assert.deepEqual(await compositionRows.nth(0).locator(".ics-pool-composition__token").evaluateAll(nodes => nodes.map(node => node.title)), ["9.00000138 AETH", "0.09449168 ICP"], "large reported TVL retains both exact underlying token amounts");
    assert.deepEqual(await compositionRows.nth(1).locator(".ics-pool-composition__token").evaluateAll(nodes => nodes.map(node => node.title)), ["99822760.50857113 ICPENGU", "0.00000016 ICP"], "extreme pool price cannot hide the tiny ICP reserve or round its exact evidence to zero");
    assert.match(await compositionRows.nth(2).locator(".ics-pool-composition__token").nth(0).innerText(), /Unavailable/, "an omitted token reserve is unavailable, not an observed zero");
    assert.equal(await compositionRows.nth(2).locator(".ics-pool-composition__token").nth(1).getAttribute("title"), "0 ICP", "an actual reported zero remains distinct from an unavailable reserve");
    assert.match(await poolsSection.innerText(), /token prices.*inflat|inflat.*token prices/i);
    await poolsSection.scrollIntoViewIfNeeded();
    for (const item of await compositionRows.locator(".ics-pool-composition__token").all()) {
      const box = await item.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width, `both reserve amounts stay inside the visible pair cell at ${width}px`);
    }
    await noOverflow(`pool-composition-${width}`);
    await page.screenshot({ path: join(out, `pool-composition-${width}.png`) });
    assert.deepEqual(await page.evaluate(() => ({ queries: window.__app.queries.length, updates: window.__app.updates.length })), { queries: detailReadsBefore.queries, updates: detailReadsBefore.updates }, "pool composition reuses direct analytics without extra protocol reads or backend updates");
    assert.deepEqual(await page.evaluate(before => window.__app.selfQueries.slice(before).map(query => query.name), detailReadsBefore.selfQueries), ["icpswap_token"], "token detail performs only its existing saved-token query");
    assert.equal(analyticsRequests.slice(detailAnalyticsBefore).filter(path => /^\/info\/token\/[^/]+\/pool$/.test(path)).length, 1, "pool composition comes from the single existing browser analytics pool read");
    await showPositions();
    assert.equal(await page.getByText("Pool data incomplete", { exact: true }).count(), 0, "healthy transport fixture has complete pool data");
    assert.equal(await page.getByText("Some liquidity data is unavailable", { exact: true }).count(), 0, "omitted history cursor must not break saved pool discovery");
    const card = page.getByRole("article", { name: "Position 7", exact: true });
    await card.getByText("Est. before fees", { exact: true }).waitFor();
    assert.equal(await card.locator(".ics-position-value > strong").innerText(), "$9.19", "principal value excludes separately displayed uncollected fees");
    assert.deepEqual(await card.locator(".ics-position-token-name > span:last-child").allTextContents(), ["ICP", "ckUSDC"]);
    assert.deepEqual(await card.locator(".ics-position-token-value > strong").allTextContents(), ["1.898231", "4.601022"]);
    assert.deepEqual(await card.locator(".ics-position-token-value > strong").evaluateAll(nodes => nodes.map(node => node.title)), ["1.89823109 ICP", "4.601022 ckUSDC"], "full precision holdings remain available");
    assert.equal(await card.getByRole("region", { name: "Uncollected fees", exact: true }).count(), 1);
    assert.equal(await card.locator(".ics-position-fees > header > strong").innerText(), "$0.02");
    assert.deepEqual(await card.locator(".ics-position-fee-tokens > span").evaluateAll(nodes => nodes.map(node => node.title)), ["0.00012345 ICP", "0.023456 ckUSDC"]);
    assert.equal(await card.locator(".ics-position-pnl > strong").innerText(), "+$2.92", "return includes current holdings plus uncollected fees less the $6.30 historical contribution");
    assert.match(await card.locator(".ics-position-range-view").innerText(), /Price range\nNow /);
    assert.equal(await card.locator(".ics-position-range-bounds > span").count(), 2);
    await noOverflow(`liquidity-${width}`);
    await page.screenshot({ path: join(out, `liquidity-${width}.png`) });
    if (width === 320) {
      for (const label of ["About position value", "About position profit and loss", "About uncollected fees"]) {
        const control = card.getByLabel(label, { exact: true });
        await control.click();
        const disclosure = control.locator("..").locator("p");
        const box = await disclosure.boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width, `${label} fits the narrow tile`);
        await noOverflow(label);
        if (label === "About position profit and loss") {
          assert.match(await disclosure.innerText(), /\$6\.30 added; \$0\.00 withdrawn/);
          assert.match(await disclosure.innerText(), /before ledger and network fees/);
          await page.screenshot({ path: join(out, "position-pnl-info-320.png") });
        }
        await control.click();
      }
    }
    await navigate("Activity");
    await page.locator(".ics-action-card").first().waitFor();
    await noOverflow(`activity-${width}`);
    await page.screenshot({ path: join(out, `activity-${width}.png`) });
  }
  checks.push("All four views and token detail fit 320/360/480/960/1200px tiles; charts remain above the initial fold; Wallet balance and exact fee-adjusted Max work.");
  checks.push("Warm amount edits issue only one anonymous direct pool quote query; quote display never calls the ICPSwap backend quote update or waits for token-info persistence.");
  checks.push("Activity and Liquidity decode backend history with omitted optional cursors and completion timestamps through the real action backend.");
  checks.push("Position cards show exact token holdings, principal value excluding uncollected fees, current fee amounts, price range and history-backed estimated P&L at every tile width; information controls fit 320px.");
  checks.push("Swap contains no market table or cards at every width. Both legs use the shared searchable token picker with identity, price, change, volume and address; watched tokens remain selectable, opposite tokens are excluded, keyboard selection and Escape/focus work, and selection preserves amounts without backend writes or Wallet actions.");
  checks.push("Token-detail pools show both exact reserve amounts beside reported TVL at every tile width, including huge token valuations with tiny ICP reserves and missing-versus-zero reserves. Composition uses the existing single browser analytics response without extra canister reads or backend updates.");

  await page.setViewportSize({ width: 320, height: 900 });
  positionHistoryAvailable = false;
  await showPositions();
  const unpricedHistory = page.getByRole("article", { name: "Position 7", exact: true });
  await unpricedHistory.getByText("Unavailable", { exact: true }).waitFor();
  assert.equal(await unpricedHistory.locator(".ics-position-pnl > strong").innerText(), "—", "missing acquisition history must not display zero or stale profit");
  assert.equal(await unpricedHistory.locator(".ics-position-value > strong").innerText(), "$9.19", "missing history does not hide known holdings");
  await unpricedHistory.getByLabel("About position profit and loss", { exact: true }).click();
  assert.match(await unpricedHistory.locator(".ics-position-pnl details p").innerText(), /Original liquidity addition is missing/);
  await noOverflow("unavailable P&L disclosure");
  await page.screenshot({ path: join(out, "position-pnl-unavailable-320.png") });
  positionHistoryAvailable = true;
  await page.getByRole("button", { name: "Refresh liquidity", exact: true }).click();
  await unpricedHistory.getByText("Est. before fees", { exact: true }).waitFor();
  assert.equal(await unpricedHistory.locator(".ics-position-pnl > strong").innerText(), "+$2.92", "a fresh complete history recovers the estimate");
  checks.push("Missing original liquidity history displays unavailable P&L with its reason while preserving current holdings; a fresh complete history restores the estimate.");

  await page.setViewportSize({ width: 360, height: 900 });
  await navigate("Swap");
  const payAmount = page.getByLabel("You pay", { exact: true });
  const paySlider = page.getByRole("slider", { name: "Percentage of spendable balance" });
  await page.locator(".ics-allocation-presets").getByRole("button", { name: "50%", exact: true }).click();
  const originalPair = await tokenTrigger("pay").innerText();
  await page.evaluate(() => { window.__app.reverseMarkets = true; });
  await page.getByRole("button", { name: "Refresh market data", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Refresh market data"]') !== null);
  assert.equal(await tokenTrigger("pay").innerText(), originalPair, "market reordering must not change the selected pay token");
  assert.equal(await payAmount.inputValue(), "6.4999", "market refresh must retain the chosen amount");
  assert.equal(await page.evaluate(() => window.__app.updates.some(update => update.name === 'icpswap_refresh')), false, "market refresh uses direct reads without a backend refresh update");
  await page.evaluate(() => { window.__app.failMarket = true; });
  await page.getByRole("button", { name: "Refresh market data", exact: true }).click();
  await page.getByText("Saved token data is unavailable", { exact: true }).waitFor();
  assert.equal(await tokenTrigger("pay").innerText(), originalPair, "failed refresh retains the selected pair");
  assert.equal(await payAmount.inputValue(), "6.4999");
  await page.evaluate(() => { window.__app.failMarket = false; });
  await page.evaluate(() => { window.__app.failQuote = true; });
  await payAmount.fill("1");
  await page.getByText("Could not get a price", { exact: true }).waitFor();
  assert.equal(await page.locator(".ics-swap-amount--readonly").innerText(), "—", "a missing quote must never appear as zero output");
  await page.screenshot({ path: join(out, "swap-quote-unavailable-360.png") });
  await page.evaluate(() => { window.__app.failQuote = false; });
  await page.getByRole("button", { name: "Retry quote", exact: true }).click();
  await page.locator(".ics-swap-minimum").waitFor();
  await payAmount.fill("6.4999");
  await page.evaluate(() => { window.__app.walletBalances['ryjl3-tyaaa-aaaaa-aaaba-cai'] = '100000101'; });
  await page.getByRole("button", { name: "Refresh Wallet balance", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Percentage of spendable balance"]').disabled);
  assert.equal(await payAmount.inputValue(), "6.4999", "a fresh balance must not rewrite manual input");
  await page.locator(".ics-allocation-presets").getByRole("button", { name: "50%", exact: true }).click();
  assert.equal(await payAmount.inputValue(), "0.4999005", "odd atomic maxima round down exactly");
  assert.equal(await paySlider.inputValue(), "50", "atomic rounding must not move the selected slider step");
  await page.evaluate(() => { window.__app.walletMissing = true; });
  await page.getByRole("button", { name: "Refresh Wallet balance", exact: true }).click();
  await page.getByText("Balance unavailable", { exact: true }).waitFor();
  assert.equal(await paySlider.isDisabled(), true, "failed refresh must not use a previously observed balance");
  assert.equal(await page.getByRole("button", {name:/^Add .* to Wallet$/}).count(), 0, "network errors must not be interpreted as missing token setup");
  assert.equal(await page.locator(".ics-allocation-presets").getByRole("button", { name: "Max", exact: true }).isDisabled(), true);
  await payAmount.fill("0.2");
  assert.equal(await payAmount.inputValue(), "0.2", "balance failure still permits manual amounts");
  await page.screenshot({ path: join(out, "swap-balance-unavailable-360.png") });
  await page.evaluate(() => { window.__app.walletMissing = false; window.__app.walletBalances['ryjl3-tyaaa-aaaaa-aaaba-cai'] = '19999'; });
  await page.getByRole("button", { name: "Refresh Wallet balance", exact: true }).click();
  await page.getByText("Balance reserved for fees", { exact: true }).waitFor();
  assert.equal(await paySlider.isDisabled(), true);
  await page.evaluate(() => { window.__app.walletDelay = 180; window.__app.walletBalances['ryjl3-tyaaa-aaaaa-aaaba-cai'] = '1300000000'; window.__app.walletBalances['xevnm-gaaaa-aaaar-qafnq-cai'] = '23000000'; });
  await page.getByRole("button", { name: "Refresh Wallet balance", exact: true }).click();
  await chooseSwapToken("pay", ids[2]);
  await page.waitForFunction(() => document.querySelector('.ics-swap-balance')?.textContent.includes('23 ckUSDC'));
  assert.match(await tokenTrigger("pay").innerText(), /ckUSDC/);
  await page.locator(".ics-allocation-presets").getByRole("button", { name: "Max", exact: true }).click();
  assert.equal(await payAmount.inputValue(), "22.98", "late old-token read cannot replace the selected token balance");
  assert.equal(await page.evaluate(() => window.__app.walletInfoOverlap), 0);
  await page.evaluate(() => { window.__app.walletDelay = 40; window.__app.walletBalances = {}; window.__app.reverseMarkets = false; });
  checks.push("Swap reads Wallet balance on opening, supports exact 0–100% sizing and refresh, preserves input across reordered market data, disables stale/fee-reserved balance sizing, and ignores late old-token reads.");

  await page.evaluate(() => { window.__app.walletUnselected = ['ss2fx-dyaaa-aaaar-qacoq-cai']; });
  await chooseSwapToken("receive", ids[0]);
  await chooseSwapToken("pay", ids[1]);
  await payAmount.fill("0.002");
  const setupSwap = page.getByRole("button", {name:"Add ckETH to Wallet",exact:true});
  await setupSwap.waitFor();
  const financialCallsBeforeSetup = await page.evaluate(() => window.__app.calls.filter(call => ['icpswap_swap_v1','icpswap_liquidity_v1','icpswap_continue_v1'].includes(call.name) || call.name.startsWith('wallet_fund')).length);
  await setupSwap.click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await tokenTrigger("pay").isDisabled(), true, "pending Wallet setup cannot be retargeted by editing the form");
  await approve(false);
  await setupSwap.waitFor();
  assert.equal(await payAmount.inputValue(), "0.002", "declining token setup keeps the typed amount");
  assert.equal(await paySlider.isDisabled(), true);
  await page.screenshot({path:join(out,"swap-wallet-setup-360.png")});
  await setupSwap.click();
  await approve(true);
  await page.waitForFunction(() => document.querySelector('.ics-swap-balance')?.textContent.includes('13 ckETH'));
  assert.equal(await payAmount.inputValue(), "0.002");
  assert.equal(await paySlider.isDisabled(), false);
  assert.equal(await page.evaluate(() => window.__app.calls.filter(call => ['icpswap_swap_v1','icpswap_liquidity_v1','icpswap_continue_v1'].includes(call.name) || call.name.startsWith('wallet_fund')).length), financialCallsBeforeSetup, "Wallet token setup never funds or dispatches a trade");
  assert.deepEqual(await page.evaluate(() => window.__app.calls.filter(call => call.name==='wallet_add_ledger_v1').map(call=>call.arguments)), [{ledger:ids[1]},{ledger:ids[1]}]);
  checks.push("Missing Wallet token selection exposes an explicit setup action; declining preserves input and retrying adds only the same ledger before refreshing its balance, without financial calls.");

  await chooseSwapToken("receive", ids[2]);
  await chooseSwapToken("pay", ids[0]);
  await page.getByLabel("You pay", { exact: true }).fill("1");
  const beforeDeclinedSwap = await page.evaluate(() => ({ dispatched: window.__app.protocolDispatches.length, funding: window.__app.calls.filter(call => call.name.startsWith("wallet_fund")).length }));
  await page.getByRole("button", { name: /Review swap|^Swap$/ }).last().click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await tokenTrigger("pay").isDisabled(), true, "a pending review retains the exact pay token");
  assert.equal(await tokenTrigger("receive").isDisabled(), true, "a pending review retains the exact receive token");
  assert.equal(await payAmount.isDisabled(), true, "a pending review retains the exact amount");
  await approve(false);
  let action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", from_ledger_id: ids[0], to_ledger_id: ids[2], amount: "100000000", slippage: 500 });
  assert.match(await page.locator(".ics-swap").innerText(), /declined/);
  assert.equal(await tokenTrigger("pay").isDisabled(), false, "an explicit no-dispatch refusal unlocks the pay token");
  assert.equal(await tokenTrigger("receive").isDisabled(), false, "an explicit no-dispatch refusal unlocks the receive token");
  assert.equal(await payAmount.isDisabled(), false, "declining review does not trap the user in a locked form");
  assert.equal(await payAmount.inputValue(), "1", "declining keeps the owner's typed amount");
  assert.equal(await page.getByRole("button", { name: "Continue saved swap", exact: true }).count(), 0, "a known no-dispatch refusal can be edited instead of requiring continuation");
  assert.deepEqual(await page.evaluate(() => ({ dispatched: window.__app.protocolDispatches.length, funding: window.__app.calls.filter(call => call.name.startsWith("wallet_fund")).length })), beforeDeclinedSwap, "declining sends neither protocol actions nor Wallet funding");
  const declinedJournal = await page.evaluate(id => window.__app.durable.history.find(operation => operation.id === id), action.arguments.operationId);
  assert.equal(declinedJournal.state, "prepared", "the transient refusal does not fabricate a durable stopped operation");
  assert.deepEqual(declinedJournal.effects, []);
  assert.equal(declinedJournal.funding_json, "");
  await payAmount.fill("0.75");
  assert.equal(await payAmount.inputValue(), "0.75", "the owner can edit after declining");
  checks.push("Swap uses the actual authorization provider and owner review: explicit refusal produces the verified no-dispatch result, preserves its prepared audit record and typed amount, unlocks editing, and sends no funding or protocol action.");

  await page.evaluate(() => { window.__app.loseSwapReply = true; });
  await page.getByRole("button", { name: "Review swap", exact: true }).click();
  await approve(true);
  const continueSwap = page.getByRole("button", { name: "Continue saved swap", exact: true });
  await continueSwap.waitFor();
  assert.match(await page.locator(".ics-swap").innerText(), /reply was interrupted/);
  const interruptedSwap = await lastAction();
  assert.notEqual(interruptedSwap.arguments.operationId, action.arguments.operationId, "editing after a known refusal creates a distinct intentional swap");
  assert.equal(interruptedSwap.arguments.amount, "75000000");
  assert.equal(await tokenTrigger("pay").getAttribute("data-ledger"), ids[0]);
  assert.equal(await tokenTrigger("receive").getAttribute("data-ledger"), ids[2]);
  assert.equal(await payAmount.inputValue(), "0.75");
  for (const control of [tokenTrigger("pay"), tokenTrigger("receive"), payAmount, paySlider, page.getByRole("button", { name: "Reverse swap direction", exact: true })]) {
    assert.equal(await control.isDisabled(), true, "an unknown reply retains the immutable saved swap terms");
  }
  assert.equal(await page.locator(".ics-swap-slippage button").evaluateAll(nodes => nodes.every(node => node.disabled)), true, "unknown replies keep the saved slippage immutable too");
  const recoveryBefore = await page.evaluate(() => ({ dispatched: window.__app.protocolDispatches.length, reviews: window.__app.calls.filter(call => call.name === "icpswap_owner_review_v1").length }));
  await continueSwap.click();
  await page.getByText("Fixture action completed and payout observed.", { exact: true }).waitFor();
  assert.deepEqual((await lastAction()).arguments, interruptedSwap.arguments, "continuation uses the exact original operation ID, pair, amount and slippage");
  assert.deepEqual(await page.evaluate(() => ({ dispatched: window.__app.protocolDispatches.length, reviews: window.__app.calls.filter(call => call.name === "icpswap_owner_review_v1").length })), recoveryBefore, "recovering a known complete journal neither reapproves nor redispatches its effect");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await tokenTrigger("pay").isDisabled(), false);
  assert.equal(await payAmount.isDisabled(), false);
  assert.equal(await payAmount.inputValue(), "", "a recovered successful swap clears only its completed input");
  await payAmount.fill("0.25");
  checks.push("A lost swap reply after one saved successful effect keeps the exact operation ID and all inputs locked. Continue recovers the same terminal record without another review or dispatch, then restores editing.");

  await showPositions();
  await page.getByRole("button", { name: "+ Position", exact: true }).click();
  await page.evaluate(() => { window.__app.walletMissing = true; });
  await page.locator(".ics-pool-option").first().click();
  await page.getByRole("button", { name: "Retry loading", exact: true }).waitFor();
  await page.evaluate(() => { window.__app.walletMissing = false; window.__app.walletUnselected = ['ryjl3-tyaaa-aaaaa-aaaba-cai']; });
  await page.getByRole("button", { name: "Retry loading", exact: true }).click();
  const setupLiquidity = page.getByRole("button", {name:"Add ICP to Wallet",exact:true});
  await setupLiquidity.waitFor();
  await page.locator("#ics-liquidity-amount-1").fill("2");
  const financialBeforeLiquiditySetup = await page.evaluate(() => window.__app.calls.filter(call => call.name==='icpswap_liquidity_v1' || call.name.startsWith('wallet_fund')).length);
  await setupLiquidity.click();
  await approve(false);
  await setupLiquidity.waitFor();
  assert.equal(await page.locator("#ics-liquidity-amount-1").inputValue(), "2");
  await setupLiquidity.click();
  await approve(true);
  await page.waitForFunction(() => !document.querySelector('#ics-liquidity-amount-0').disabled);
  assert.equal(await page.locator("#ics-liquidity-amount-1").inputValue(), "2", "token setup preserves the other deposit leg");
  assert.equal(await page.evaluate(() => window.__app.calls.filter(call => call.name==='icpswap_liquidity_v1' || call.name.startsWith('wallet_fund')).length), financialBeforeLiquiditySetup);
  checks.push("Liquidity can add an unselected token through Wallet review, preserving the other entered deposit and keeping funding separate from setup.");
  await page.waitForFunction(() => !document.querySelector('.ics-liquidity-editor')?.textContent.includes('Reading pool'));
  assert.equal(await page.evaluate(() => window.__app.walletInfoOverlap), 0, "opening a pool must not overlap Wallet owner requests");
  assert.equal(await page.evaluate(() => window.__app.updates.some(update => update.name === 'icpswap_set_token_info')), false, "opening a liquidity editor must not persist Wallet token metadata before showing balances");
  assert.equal(await page.getByText(/Wallet token details unavailable/).count(), 0);
  await page.getByRole("button", { name: "±5%", exact: true }).click();
  const icpDeposit = page.locator('.ics-liquidity-amount').filter({has:page.locator('#ics-liquidity-amount-0')});
  await icpDeposit.getByRole("button", { name: "Max", exact: true }).last().click();
  assert.equal(await page.locator("#ics-liquidity-amount-0").inputValue(), "12.9998");
  await page.getByRole("slider", { name: "ICP deposit percentage", exact: true }).fill("50");
  assert.equal(await page.locator("#ics-liquidity-amount-0").inputValue(), "6.4999");
  await page.locator("#ics-liquidity-amount-0").fill("1");
  assert.equal(await page.getByRole("slider", { name: "ICP deposit percentage", exact: true }).inputValue(), "8");
  await page.locator("#ics-liquidity-amount-1").fill("2");
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(`mint-editor-${width}`, ".ics-liquidity-editor");
    await page.screenshot({ path: join(out, `mint-${width}.png`) });
  }
  await page.getByRole("button", { name: "Review new position", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "mint", pool: "aaaaa-aa", tickLower: -37740, tickUpper: -36660, amount0: "100000000", amount1: "2000000" });
  await page.getByRole("button", { name: "Back to positions", exact: true }).click();
  await page.getByText("Position #8", { exact: true }).waitFor();
  checks.push("Opening a pool serializes both Wallet token reads across consent; mint range presets use actual price/tick/liquidity math, exact atomic maxima reach the action, and a refreshed position appears after approval.");

  const position = page.locator(".ics-position-card").filter({ has: page.getByText("Position #7", { exact: true }) });
  await position.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("#ics-liquidity-amount-0").fill("0.1");
  await page.locator("#ics-liquidity-amount-1").fill("0.2");
  await page.getByRole("button", { name: "Review add liquidity", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "increase", pool: "aaaaa-aa", positionId: "7", amount0: "10000000", amount1: "200000" });
  await page.getByRole("button", { name: "Back to positions", exact: true }).click();
  await page.getByText("Position #7", { exact: true }).waitFor();
  const walletReadsBeforeRecovery = await page.evaluate(() => window.__app.calls.filter(call => call.name === "wallet_token_info_v1").length);
  await page.evaluate(() => { window.__app.walletMissing = true; });
  await position.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "50%", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await noOverflow("remove-editor-320", ".ics-liquidity-editor");
  await page.screenshot({ path: join(out, "remove-320.png") });
  await page.getByRole("button", { name: "Review remove liquidity", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "decrease", pool: "aaaaa-aa", positionId: "7", liquidity: "500000000" });
  await page.getByRole("button", { name: "Back to positions", exact: true }).click();
  await page.getByText("Position #7", { exact: true }).waitFor();
  await position.getByRole("button", { name: "Collect fees", exact: true }).click();
  await noOverflow("claim-editor-320", ".ics-liquidity-editor");
  await page.screenshot({ path: join(out, "claim-320.png") });
  await page.getByRole("button", { name: "Review collect fees", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "claim", pool: "aaaaa-aa", positionId: "7" });
  await page.getByRole("button", { name: "Back to positions", exact: true }).click();
  await page.getByText("Position #7", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__app.calls.filter(call => call.name === "wallet_token_info_v1").length), walletReadsBeforeRecovery, "decrease and claim need no Wallet reads");
  await page.evaluate(() => { window.__app.walletMissing = false; window.__app.reserveWithdrawal = true; });
  await page.locator(".ics-unused-funds").first().getByRole("button", { name: "Withdraw", exact: true }).first().click();
  await page.getByRole("button", { name: "Max", exact: true }).click();
  assert.equal(await page.locator("#ics-unused-amount").inputValue(), "0.8");
  await page.getByRole("button", { name: "Review withdraw unused funds", exact: true }).click();
  await approve(true);
  action = await lastAction();
  assert.deepEqual({ ...action.arguments, operationId: "id" }, { operationId: "id", kind: "withdraw", pool: "aaaaa-aa", token: ids[0], amount: "80000000" });
  checks.push("Increase, 50% decrease, fee claim and unused-fund Max withdrawal send exact typed action fields; Max subtracts credit reserved by a pending withdrawal. Decrease and claim remain usable when Wallet metadata fails.");

  await page.reload();
  await navigate("Activity");
  await page.locator(".ics-action-card").first().waitFor();
  assert.equal(await page.locator(".ics-action-card").count(), 9);
  const uncertain = page.locator(".ics-action-card").filter({ hasText: "Saved payout requires a fresh pool observation." });
  await uncertain.getByRole("button", { name: "Check status", exact: true }).click();
  await page.getByText("Reconciled against a fresh fixture pool observation.", { exact: true }).waitFor();
  const statusCall = await page.evaluate(() => [...window.__app.calls].reverse().find(call => call.name === "icpswap_reconcile_v1"));
  assert.deepEqual(statusCall.arguments, { operationId: "f".repeat(32) });
  const recoverySourceCard = page.locator(".ics-action-card").filter({ hasText: "Confirmed token-1 transfer awaits pool credit." });
  const compactSource = await page.evaluate(() => window.__app.lastHistory.find(operation => operation.id === "d".repeat(32)));
  assert.equal("funding_json" in compactSource, false);
  assert.equal("result_json" in compactSource, false);
  assert.equal("plan_json" in compactSource, false);
  assert.equal(await page.getByRole("button", { name: /^Recover deposit/ }).count(), 0, "compact history cannot establish funded-deposit eligibility");
  await recoverySourceCard.getByRole("button", { name: "Check status", exact: true }).click();
  const recoverButton = page.getByRole("button", { name: /^Recover deposit/ });
  await recoverButton.waitFor();
  assert.equal(await recoverButton.count(), 1);
  assert.match(await recoverButton.getAttribute("title"), /xevnm-gaaaa-aaaar-qafnq-cai/, "recovery identifies the funded token ledger, not a misleading funding array index");
  const walletCallsBefore = await page.evaluate(() => window.__app.calls.filter(call => call.target === "app:wallet:background").length);
  await recoverButton.click();
  await approve(false);
  await recoverySourceCard.getByRole("alert").filter({ hasText: "Owner declined recovery" }).waitFor();
  const firstRecovery = await page.evaluate(() => [...window.__app.calls].reverse().find(call => call.name === "icpswap_recover_deposit_v1"));
  assert.match(firstRecovery.arguments.operationId, /^[0-9a-f]{32}$/);
  assert.notEqual(firstRecovery.arguments.operationId, "d".repeat(32));
  assert.deepEqual({ ...firstRecovery.arguments, operationId: "new" }, { operationId: "new", sourceOperationId: "d".repeat(32), tokenIndex: 1 });
  await noOverflow("direct-recovery-declined");
  await page.screenshot({ path: join(out, "direct-recovery-declined-360.png") });
  await recoverButton.click();
  await approve(true);
  await page.getByText("Token-1 direct deposit recovered into unused pool funds.", { exact: true }).waitFor({ state: "attached" });
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some(button => /^Recover deposit/.test(button.textContent)));
  const recoveryCalls = await page.evaluate(() => window.__app.calls.filter(call => call.name === "icpswap_recover_deposit_v1"));
  assert.equal(recoveryCalls.length, 2);
  assert.deepEqual(recoveryCalls[0].arguments, recoveryCalls[1].arguments, "retry retains the new recovery id, original source id and canonical token leg");
  assert.equal(await page.evaluate(() => window.__app.calls.filter(call => call.target === "app:wallet:background").length), walletCallsBefore, "recovery does not send new Wallet requests");
  assert.equal(await page.getByText("Recover funded deposit", { exact: true }).count(), 1, "retries keep a single saved recovery action");
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(`direct-recovery-complete-${width}`);
    await page.screenshot({ path: join(out, `direct-recovery-complete-${width}.png`) });
  }
  checks.push("Compact history alone cannot offer direct-deposit recovery. Reconciliation reveals a confirmed token-1 transfer with exact Wallet namespace/account proof; decline and retry preserve one NEW recovery id and canonical tokenIndex 1 despite a one-element funding array, without Wallet calls. Credited source markers remove the recovery button.");
  await page.evaluate(() => { window.__app.failedWithdrawal = true; });
  await showPositions();
  await page.getByText("Withdraw #71 · Failed: Fixture ledger transfer failed", { exact: true }).waitFor();
  assert.match(await page.locator(".ics-protocol-transactions").innerText(), /even when unused balances are zero/);
  assert(await page.evaluate(() => window.__app.queries.some(query => query.canister === "2vxsx-fae" && query.method === "getUserUnusedBalance")), "retained historical pool is queried even though absent from owner index");
  checks.push("Durable fixture activity survives reload, status checks retain the exact operation id, and saved pool references recover unused funds outside the position index; failed payouts remain visible even with zero unused balance.");
  await page.evaluate(() => { window.__app.incompleteOwnership = true; window.__app.failedWithdrawal = false; });
  await page.getByRole("button", { name: "Refresh liquidity", exact: true }).click();
  await page.getByText("Liquidity data is incomplete", { exact: true }).waitFor();
  assert.equal(await page.getByText("No liquidity positions yet", { exact: true }).count(), 0);
  await noOverflow("incomplete-ownership");
  await page.screenshot({ path: join(out, "incomplete-liquidity-360.png") });
  checks.push("Failed ownership queries are reported as incomplete liquidity data instead of an empty account.");

  await page.evaluate(() => { window.__app.incompleteOwnership = false; });
  await page.getByRole("button", { name: "Refresh liquidity", exact: true }).click();
  await page.getByText("Position #7", { exact: true }).waitFor();
  analyticsUnavailable = true;
  await page.getByRole("button", { name: "Refresh market data", exact: true }).click();
  await page.getByText("Market data is delayed", { exact: true }).waitFor();
  const delayedCard = page.getByRole("article", { name: "Position 7", exact: true });
  await delayedCard.getByText("Value unavailable", { exact: true }).waitFor();
  assert.equal(await delayedCard.locator(".ics-position-value > strong").innerText(), "—");
  await delayedCard.locator(".ics-position-pnl").getByText("Unavailable", { exact: true }).waitFor();
  await navigate("Markets");
  assert.match(await page.locator(".ics-market-card").first().locator(".ics-market-card-values strong").innerText(), /^\$2\.42\s+\(last saved price\)$/, "market fallback uses saved pool prices after analytics failure");
  assert.equal(await page.locator(".ics-market-summary").getByText("—", { exact: true }).count(), 1, "unavailable movers are not reported as a flat market");
  await navigate("Swap");
  await tokenTrigger("pay").click();
  await pickerSearch().fill("ICP");
  const unavailablePickerToken = pickerToken(ids[0]);
  assert.equal(await unavailablePickerToken.isDisabled(), false, "known tokens remain selectable while analytics are unavailable");
  assert.equal(await unavailablePickerToken.locator(".ics-picker-stats > span").first().innerText(), "—", "unavailable swap-token prices never appear as zero or stale current prices");
  assert.equal(await unavailablePickerToken.locator(".ics-change").count(), 0, "unavailable daily change must not appear as zero percent");
  await noOverflow("swap-picker-unavailable-320", ".ics-picker");
  await page.screenshot({ path: join(out, "swap-picker-unavailable-320.png") });
  await pickerSearch().press("Escape");
  await page.locator(".ics-picker-dialog").waitFor({ state: "detached" });
  await navigate("Markets");
  await page.setViewportSize({width:320,height:900});
  await page.getByRole("button", { name: "+ Token", exact: true }).click();
  await page.getByText("Market prices unavailable", {exact:true}).waitFor();
  assert.equal(await page.locator('.ics-picker-row').first().locator('.ics-picker-stats > span').first().innerText(), "—", "cached token identities must not carry stale prices into discovery");
  assert.equal(await pickerToken(ids[0]).isDisabled(), true, "the same shared picker retains watched-token protection in add mode");
  await page.getByRole("dialog").getByRole("button", {name:"Close",exact:true}).click();
  analyticsUnavailable = false;
  await page.getByRole("button", { name: "Refresh market data", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.ics-body')?.textContent.includes('Market data is delayed'));
  await page.getByRole("button", { name: "+ Token", exact: true }).click();
  await page.getByLabel("Search by token name, symbol, or address").fill("TEST");
  await page.evaluate(() => { window.__app.addHold = true; });
  await page.getByLabel("Search by token name, symbol, or address").press("Enter");
  await page.waitForFunction(() => document.querySelector(".ics-picker-row")?.disabled);
  await page.getByLabel("Search by token name, symbol, or address").press("Enter");
  assert.equal(await page.evaluate(() => window.__app.updates.filter(update => update.name==='icpswap_add').length), 1, "keyboard add respects the same pending state as its button");
  await noOverflow("token-picker-320", ".ics-picker");
  await page.screenshot({ path: join(out, "token-picker-320.png") });
  await page.evaluate(() => { window.__app.releaseAdd(); });
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  checks.push("Analytics failure disables stale position value/P&L and shows honest saved-price/mover availability; token picker prevents duplicate keyboard adds.");

  await page.goto(`http://127.0.0.1:${server.address().port}?market-failure=1`);
  await page.getByText("Your tokens could not be loaded", { exact: true }).waitFor();
  assert.equal(await page.getByText("Your watchlist is empty", { exact: true }).count(), 0, "unknown saved state must not be presented as an empty account");
  await page.evaluate(() => { window.__app.failMarket = false; });
  await page.getByRole("button", { name: "Refresh tokens", exact: true }).click();
  await page.getByRole("slider", { name: "Percentage of spendable balance", exact: true }).waitFor();
  checks.push("A failed initial watchlist read shows a retry state and restores Swap without pretending saved tokens were removed.");

  await navigate("Activity");
  const evidenceCallsBefore = await page.evaluate(() => window.__app.calls.length);
  await page.evaluate(() => {
    for (const [suffix, positionId, amount1] of [["01", "5097", "0"], ["02", "5098", "46000"]]) {
      const operationId = "202609090011000000000000000000" + suffix, pool = "mohjv-bqaaa-aaaag-qjyia-cai";
      const operation = { id: operationId, input_json: JSON.stringify({ kind: "claim", pool, positionId }),
        plan_json: "", funding_json: "", result_json: "", state: "settlement_pending", detail: "Protocol claim succeeded; payout unverified.",
        created_at: "1788960000000000000", updated_at: "1788960000000000010", revision: "9",
        effects: [{ key: "liquidity", canister: pool, method: "claim", state: "succeeded", error: "",
          dispatched_at: "1788960000000000001", completed_at: "1788960000000000010", result_nat: null, result_amount0: "297", result_amount1: amount1 }] };
      const plan = { pool, owner: "3rurp-vyaaa-aaaay-aacua-cai", request: { kind: "claim", pool, position_id: positionId },
        token0: { address: "ryjl3-tyaaa-aaaaa-aaaba-cai", standard: "ICRC2" }, token1: { address: "xevnm-gaaaa-aaaar-qafnq-cai", standard: "ICRC2" },
        fee0: "10000", fee1: "10000", observed_at: "1788960000000000000" };
      window.__app.installActivityEvidence({ operationId, state: operation.state, message: operation.detail, operation, plan,
        pool: { unused0: "297", unused1: "0", reserved0: "0", reserved1: "0", fee0: "10000", fee1: "10000", queue: [], transactions: [] } });
    }
  });
  const claimCard = page.locator(".ics-action-card").filter({ hasText: "Position #5097" });
  const mixedCard = page.locator(".ics-action-card").filter({ hasText: "Position #5098" });
  await claimCard.waitFor();
  assert.match(await claimCard.getByRole("status").innerText(), /Payment to your Wallet has not been verified/, "compact history does not fabricate fee or retained-credit evidence");
  assert.equal(await page.evaluate(from => window.__app.calls.slice(from).filter(call => call.name === "icpswap_reconcile_v1").length, evidenceCallsBefore), 0, "activity does not automatically poll individual rows");
  await claimCard.getByRole("button", { name: "Check status", exact: true }).click();
  await claimCard.getByRole("status").filter({ hasText: "expected to remain as pool credit at the saved fees" }).waitFor();
  assert.equal(await claimCard.locator(".ics-action-state").innerText(), "Payout unverified");
  assert.match(await claimCard.getByRole("status").innerText(), /Wallet payouts remain unverified/);
  assert.match(await claimCard.locator(".ics-pool-recovery").innerText(), /cannot be withdrawn at the observed fee/);
  assert.equal(await claimCard.getByRole("button", { name: "Continue", exact: true }).count(), 0);
  await mixedCard.getByRole("button", { name: "Check status", exact: true }).click();
  await mixedCard.getByRole("status").filter({ hasText: "expected to remain as pool credit at the saved fees" }).waitFor();
  assert.equal(await mixedCard.locator(".ics-action-state").innerText(), "Payout unverified");
  await page.setViewportSize({ width: 320, height: 900 });
  await noOverflow("retained-pool-credit-320");
  await claimCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, "retained-pool-credit-320.png") });
  await page.evaluate(() => {
    const previous = window.__app.activityEvidence.get("20260909001100000000000000000001");
    const operation = { ...previous.operation, state: "uncertain", detail: "A newer observation requires reconciliation.", revision: "10", updated_at: "1788960000000000011", effects: [] };
    window.__app.installActivityEvidence({ ...previous, operation, state: operation.state, message: operation.detail });
  });
  await claimCard.getByText("Needs reconciliation", { exact: true }).waitFor();
  assert.doesNotMatch(await claimCard.getByRole("status").innerText(), /expected to remain|pool completed this action/);
  const evidenceCalls = await page.evaluate(from => window.__app.calls.slice(from), evidenceCallsBefore);
  assert.equal(evidenceCalls.filter(call => call.name === "icpswap_reconcile_v1").length, 2);
  assert(evidenceCalls.every(call => ["icpswap_history_v1", "icpswap_reconcile_v1"].includes(call.name)), "retained-credit guidance only uses explicit status reads and existing history refreshes; no extra Wallet or financial calls");
  checks.push("Report-10 297-atom claim and mixed payout show fee-aware pool-credit guidance only after explicit status evidence, retain unverified settlement, and make no extra financial/Wallet calls or per-row polling. A newer uncertain history revision discards stale successful guidance.");
  assert.deepEqual(errors, []);
  await writeFile(join(out, "app-results.json"), JSON.stringify({ checks, viewports: [320, 360, 480, 960, 1200], errors }, null, 2));
  console.log(`App browser checks passed; artifacts: ${out}`);
} catch (error) {
  await writeFile(join(out, "app-failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
