const ledger = 'xevnm-gaaaa-aaaar-qafnq-cai';
const quote = { chain_id: '1', ledger, minter: 'aaaaa-aa', helper_address: '0x2222222222222222222222222222222222222222', helper_mode: { subaccount: null }, minter_address: '0x3333333333333333333333333333333333333333', token_address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', recipient: 'aaaaa-aa', principal_word: '0x'+'00'.repeat(32), subaccount_word: '0x'+'00'.repeat(32) };
const address = '0x1111111111111111111111111111111111111111';
const hash = '0x' + 'aa'.repeat(32);
const key = 'mock-canister-bridge-activity';
const rpcError = 'RPC eth_getCode on chain 1: header not found';
const variant = (key: string) => ({[key]: null});
const seed = (id: number, state: string) => ({ id: Array.from({length:16},(_,i)=>i===15?id:0), quote, source: {evm:null}, account: address, amount: String(id*3000000), steps: [ {kind:{reset_approval:null},state:{ready:null}}, {kind:{approval:null},state:{confirmed:null},operation_id:'saved-approval-'+id, transaction_hash:hash}, {kind:{deposit:null},state:variant(state),...(state==='ready'?{}:{operation_id:'saved-deposit-'+id}),...(state==='submitted'?{transaction_hash:'0x'+'bb'.repeat(32)}:{}),error:rpcError} ], revision:'2',created_at:String(1788730798000000000n-BigInt(id)*1000000000n),updated_at:'1788730798000000000',event_cursor:'0',error:rpcError });
const fresh = {records:[seed(1,'ready'),seed(2,'unknown'),seed(3,'submitted')],dismissed:[],calls:[]};
const state = JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fresh));
const persist = () => localStorage.setItem(key,JSON.stringify(state));
const idHex = (value: number[] | Uint8Array) => Array.from(value,x=>x.toString(16).padStart(2,'0')).join('');
const wire = (value:any) => ({...structuredClone(value),id:Uint8Array.from(value.id)});
const get = (id: number[] | Uint8Array) => {const found=state.records.find((x:any)=>idHex(x.id)===idHex(id));if(!found)throw new Error('Unknown saved deposit');return wire(found);};
const record = (lane:string,method:string,args:any[]) => {state.calls.push({lane,method,args});persist();};
window.__bridgeHarness = {state,seed:fresh,refreshes:0,snapshot:()=>structuredClone(state)};
export const isJsonObject=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export async function querySelf(method:string,args:any[]) {
  record('query',method,args);
  if(method==='wallet_bridge_list_v1')return {records:state.records.map(wire)};
  if(method==='wallet_bridge_activity_v1')return {records:state.dismissed.map((id:string)=>({id:Uint8Array.from(id.match(/../g)!.map(x=>parseInt(x,16))),dismissed_at:'1788820000000000000'}))};
  if(method==='wallet_bridge_status_v1')return get(args[0]);
  throw new Error('Unexpected query '+method);
}
export async function updateSelf(method:string,args:any[]) {
  record('update',method,args);
  if(method==='wallet_bridge_step_v2'&&args[0]?.dismiss){
    const input=args[0].dismiss,id=idHex(input.id),existing=get(input.id);
    state.dismissed=state.dismissed.filter((x:string)=>x!==id);
    if(input.dismissed)state.dismissed.push(id);
    persist();return existing;
  }
  if(method==='wallet_bridge_quote_v1')return structuredClone(quote);
  if(method==='wallet_bridge_refresh_v1'){
    if(window.__bridgeHarness.holdRefresh){window.__bridgeHarness.refreshPending=true;await new Promise(()=>{});}
    throw new Error('RPC unavailable in isolated browser fixture');
  }
  if(method==='wallet_bridge_replacement_v1'&&args[0]?.lookup)return {hash:get(args[0].lookup.id).steps.find((x:any)=>Object.keys(x.kind)[0]===Object.keys(args[0].lookup.step)[0])?.transaction_hash};
  throw new Error('Unexpected financial or bridge mutation '+method);
}
export async function callTool(input:any){record('kernel',input.name,[input]);if(input.name==='permissions.request')return {};throw new Error('Unexpected tool '+input.name);}
export const createMsgBusClient=()=>({});
export const EVM_WALLET_TARGET='evm_wallet';
export const EVM_WALLET_TOOLS={accounts:'evm_accounts_v1',callContract:'evm_call_contract_v1',readContract:'evm_read_contract_v1',operationStatus:'evm_operation_status_v1',transaction:'evm_transaction_v1'};
export function createEvmWalletClient(){return {
  async accounts(){record('evm','accounts',[]);return {accounts:[{accountId:'main',address,keyFingerprint:'fixture-original-key'}]};},
  async readContract(input:any){record('ethereum','readContract',[input]);throw new Error(rpcError);},
  async callContract(input:any){record('ethereum','callContract',[input]);throw new Error(rpcError);},
  async operationStatus(input:any){record('ethereum','operationStatus',[input]);throw new Error(rpcError);},
  async transaction(input:any){record('ethereum','transaction',[input]);throw new Error(rpcError);},
  async sendTransaction(input:any){record('financial','sendTransaction',[input]);throw new Error('No transactions allowed');}
};}
export function createEvmRequestId(){record('financial','createEvmRequestId',[]);throw new Error('No new deposits allowed');}
export async function connectEthereumProvider(){record('financial','connectEthereumProvider',[]);throw new Error('External wallet disabled');}
