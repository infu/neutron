/** ICWallet funding followed by SNS claim/configuration, with retained identity. */
import { Principal } from "@dfinity/principal";
import type { JsonObject } from "neutron-tools/app";
import type { Command } from "../candid/sns_governance.did";
import { encodeManageNeuron, decodeManageNeuronRequest } from "./manage_neuron";
import { balanceOf } from "./ledger";
import { toHex, fromHex, formatDuration } from "./format";
import { commandEvidence, createOperationClient, mergeOperationState, operationJson, operationJsonText, operationObject, type OperationDetail } from "./operations";
import { executeNeuronOperation, operationResult, readActionSnapshot, displayTokenAmount, isNeuronsFundControlled, normalizedNeuronId, NEURON_PERMISSIONS, type NeuronActionServices, type NeuronOperationResult } from "./neuron_actions";
import { prepareWalletFundingRequest, invokeWalletFunding, parseWalletFundingResult, rootFundingInstruction, verifyWalletFundingReceipt, readWalletTokenSelection, invokeWalletLedgerAddition, walletLedgerInstruction, type WalletFundingRequest } from "./wallet_funding";

export interface StakeInput {
  operationId:string;sns:string;governance:string;ledger:string;amountAtoms:string;
  nonce?:string;fundingRequestId?:string;validUntilNs?:string;dissolveDelaySeconds?:string;autoStakeMaturity?:boolean;
}
export interface TopUpInput extends Omit<StakeInput,"nonce"|"dissolveDelaySeconds"|"autoStakeMaturity"> {neuronId:string}
interface StakeIntent {
  version:1;kind:"stake"|"topup";principal:string;original:JsonObject;neuronId:string;nonce:string|null;
  funding:WalletFundingRequest;walletSelectionNeeded:boolean;fundingRoot:boolean;fundingCallerAppId:string;
  amountAtoms:string;baselineStakeAtoms:string;dissolveDelaySeconds:string|null;autoStakeMaturity:boolean|null;
}
interface BuiltStake {intent:StakeIntent;review:JsonObject;steps:{step_id:string;args:Uint8Array}[]}
const nat64=(value:string,label:string):bigint=>{if(!/^(0|[1-9][0-9]*)$/.test(value))throw new Error(`${label} must be an exact nonnegative integer`);const n=BigInt(value);if(n>18446744073709551615n)throw new Error(`${label} exceeds the SNS uint64 range`);return n;};

/** Same domain separation and byte order as dfinity/ic nervous_system/common. */
export async function neuronStakingSubaccount(principal:string,nonce:bigint|string):Promise<Uint8Array>{
  const n=nat64(nonce.toString(),"Neuron nonce"),owner=Principal.fromText(principal).toUint8Array(),domain=new TextEncoder().encode("neuron-stake");
  const data=new Uint8Array(1+domain.length+owner.length+8);data[0]=domain.length;data.set(domain,1);data.set(owner,1+domain.length);new DataView(data.buffer).setBigUint64(data.length-8,n,false);
  return new Uint8Array(await crypto.subtle.digest("SHA-256",data));
}
export async function neuronStakingAccount(governance:string,principal:string,nonce:bigint|string){return{owner:Principal.fromText(governance),subaccount:await neuronStakingSubaccount(principal,nonce)};}
async function nonceForOperation(operationId:string):Promise<string>{
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`snsgov-neuron:${operationId}`));return new DataView(hash).getBigUint64(0,false).toString();
}
function savedIntent(operation:OperationDetail):StakeIntent{
  const value=operationObject(operation.input_json,"staking input");
  if(value.version!==1||(value.kind!=="stake"&&value.kind!=="topup")||typeof value.principal!=="string"||typeof value.neuronId!=="string"||!value.funding)throw new Error("This operation is not a compatible staking operation");
  return value as unknown as StakeIntent;
}
function originalInput(input:StakeInput|TopUpInput):JsonObject{return operationJson(input) as JsonObject;}
function assertIdentity(intent:StakeIntent,services:NeuronActionServices):void{
  const root=services.funding?.root??false,caller=root?services.funding?.callerAppId:"snsgov";
  if(intent.principal!==services.principal||intent.fundingRoot!==root||intent.fundingCallerAppId!==caller)throw new Error("Continue this staking operation using its original Neutron and Normal or Root funding caller");
}
async function buildStake(input:StakeInput|TopUpInput,services:NeuronActionServices):Promise<BuiltStake>{
  if(!input.operationId)throw new Error("An operation ID is required");
  Principal.fromText(input.sns);Principal.fromText(input.governance);Principal.fromText(input.ledger);Principal.fromText(services.principal);
  const topup="neuronId" in input,amount=nat64(input.amountAtoms,"Stake amount");if(amount===0n)throw new Error("Stake amount must be positive");
  const nonce=topup?null:input.nonce??await nonceForOperation(input.operationId);
  const neuronId=topup?normalizedNeuronId(input.neuronId):toHex(await neuronStakingSubaccount(services.principal,nonce!));
  const claim:Command=topup?{ClaimOrRefresh:{by:[{NeuronId:{}}]}}:{ClaimOrRefresh:{by:[{MemoAndController:{memo:BigInt(nonce!),controller:[Principal.fromText(services.principal)]}}]}};
  const snapshot=await readActionSnapshot(input.governance,neuronId,claim,services),p=snapshot.parameters;
  if(snapshot.mode===2)throw new Error("This SNS is not accepting ordinary neuron staking before launch initialization");
  if(topup&&!snapshot.neuron)throw new Error("The neuron to top up was not found");
  if(!topup&&snapshot.neuron)throw new Error("This neuron nonce is already in use. Resume its saved operation, or choose a different nonce before funding");
  if(snapshot.neuron && isNeuronsFundControlled(snapshot.neuron))throw new Error("SNS neurons controlled by the Neurons’ Fund cannot be topped up and refreshed");
  const ledgerBalance=topup?await stakingBalance(input.ledger,input.governance,neuronId,services):0n;
  if(p.neuronMinimumStakeE8s!==undefined&&ledgerBalance+amount<p.neuronMinimumStakeE8s)throw new Error(`The neuron account needs at least ${p.neuronMinimumStakeE8s} atomic tokens after funding`);
  const delay=topup?undefined:input.dissolveDelaySeconds===undefined?undefined:nat64(input.dissolveDelaySeconds,"Dissolve delay");
  if(delay!==undefined&&p.maxDissolveDelaySeconds!==undefined&&delay>p.maxDissolveDelaySeconds)throw new Error(`The SNS maximum dissolve delay is ${p.maxDissolveDelaySeconds} seconds`);
  if(delay!==undefined&&delay>4294967295n)throw new Error("This dissolve-delay increment exceeds the SNS uint32 command range");
  const configureNeeded=(delay!==undefined&&delay>0n)||(!topup&&input.autoStakeMaturity===true);
  const permissions=p.neuronClaimerPermissions??[];
  const grantConfigure=configureNeeded&&!permissions.includes(1);
  if(grantConfigure&&!(permissions.includes(2)&&p.neuronGrantablePermissions?.includes(1)))throw new Error("This SNS does not grant the Neutron permission to configure the requested new neuron");
  const fundingRoot=services.funding?.root??false,fundingCallerAppId=fundingRoot?services.funding?.callerAppId:"snsgov";
  if(!fundingCallerAppId)throw new Error("Root staking requires the authenticated Wallet caller identity");
  const walletSelection=await readWalletTokenSelection(services.kernel,input.ledger);
  const fundingRequestId=input.fundingRequestId??input.operationId;
  const funding=prepareWalletFundingRequest({requestId:fundingRequestId,ledger:input.ledger,amountAtoms:input.amountAtoms,
    validUntilNs:input.validUntilNs??(BigInt(Date.now())*1000000n+600000000000n).toString(),destination:{owner:input.governance,subaccount:fromHex(neuronId)},memoHex:fundingRequestId});
  const steps=[{step_id:topup?"refresh":"claim",args:encodeManageNeuron({subaccount:fromHex(neuronId),command:[claim]})}];
  if(grantConfigure)steps.push({step_id:"configure_permission",args:encodeManageNeuron({subaccount:fromHex(neuronId),command:[{AddNeuronPermissions:{principal_id:[Principal.fromText(services.principal)],permissions_to_add:[{permissions:Int32Array.from([1])}]}}]})});
  if(delay!==undefined&&delay>0n)steps.push({step_id:"dissolve_delay",args:encodeManageNeuron({subaccount:fromHex(neuronId),command:[{Configure:{operation:[{IncreaseDissolveDelay:{additional_dissolve_delay_seconds:Number(delay)}}]}}]})});
  if(!topup&&input.autoStakeMaturity===true)steps.push({step_id:"auto_stake",args:encodeManageNeuron({subaccount:fromHex(neuronId),command:[{Configure:{operation:[{ChangeAutoStakeMaturity:{requested_setting_for_auto_stake_maturity:input.autoStakeMaturity}}]}}]})});
  const intent:StakeIntent={version:1,kind:topup?"topup":"stake",principal:services.principal,original:originalInput(input),neuronId,nonce,funding,walletSelectionNeeded:!walletSelection.selected,fundingRoot,fundingCallerAppId,
    amountAtoms:input.amountAtoms,baselineStakeAtoms:ledgerBalance.toString(),dissolveDelaySeconds:delay?.toString()??null,autoStakeMaturity:!topup?input.autoStakeMaturity??null:null};
  const review=operationJson({title:topup?"Increase neuron stake":"Stake SNS tokens",rootCanisterId:input.sns,governance:input.governance,ledger:input.ledger,neuronId,principal:services.principal,
    fields:[{label:"Stake amount",value:displayTokenAmount(amount,services.token)},{label:"Dissolve delay",value:delay===undefined?"No change requested":formatDuration(delay)},{label:"Funding account",value:services.principal},{label:"Staking destination",value:funding.route.to},
      {label:"New neuron permissions",value:topup?"Existing permissions are retained":permissions.map(p=>NEURON_PERMISSIONS[p]??String(p)).join(", ")}],
    details:[...(!walletSelection.selected?["Add this SNS token to ICWallet, preserving every other selected token, before funding."]:[]),"ICWallet reviews the token and live transfer fee. Funding and neuron configuration have separate retained steps."],
    warnings:topup?["Increasing token stake can reduce the neuron’s existing age bonus."]:["Staked tokens are controlled by SNS governance. Claim creates a neuron with zero dissolve delay before the requested configuration is applied.","If funding succeeds but claiming fails, recovery continues with this same neuron account; the transfer is not automatically refunded."],
    funding:funding,commandSteps:steps.map(s=>({stepId:s.step_id,args:commandEvidence(s.args)}))}) as JsonObject;
  return{intent,review,steps};
}
export async function previewStake(input:StakeInput,services:NeuronActionServices):Promise<JsonObject>{return(await buildStake(input,services)).review;}
export async function previewTopUp(input:TopUpInput,services:NeuronActionServices):Promise<JsonObject>{return(await buildStake(input,services)).review;}
export async function prepareStake(input:StakeInput,services:NeuronActionServices):Promise<NeuronOperationResult>{return prepareStaking(input,services);}
export async function prepareTopUp(input:TopUpInput,services:NeuronActionServices):Promise<NeuronOperationResult>{return prepareStaking(input,services);}
async function prepareStaking(input:StakeInput|TopUpInput,services:NeuronActionServices):Promise<NeuronOperationResult>{
  const client=createOperationClient(services.kernel),existing=await client.get(input.operationId);
  if(existing){const intent=savedIntent(existing);assertIdentity(intent,services);if(operationJsonText(intent.original)!==operationJsonText(originalInput(input))||existing.sns!==input.sns||existing.governance!==input.governance)throw new Error("This operation ID is already bound to another staking intent");return operationResult(existing);}
  const built=await buildStake(input,services);
  return operationResult(await client.prepare({operation_id:input.operationId,sns:input.sns,governance:input.governance,input_json:operationJsonText(built.intent),review_json:operationJsonText(built.review),initiator:services.initiator??"user",state_json:operationJsonText({version:1,completedSteps:[],fundingStatus:"prepared"}),steps:built.steps}));
}

/** Root replies are verified against the exact Wallet transfer before claiming. */
export async function continueStake(operationId:string,input:{fundingResults?:unknown[]}={},services:NeuronActionServices):Promise<NeuronOperationResult>{
  const client=createOperationClient(services.kernel);let operation=await client.get(operationId);if(!operation)throw new Error("Staking operation was not found");
  const intent=savedIntent(operation);assertIdentity(intent,services);
  const known=operationResult(operation);if(known.status==="completed"||known.status==="rejected")return known;
  if(operationObject(operation.state_json).fundingStatus==="rejected")return{...known,status:"rejected",message:"ICWallet rejected this retained funding request."};
  await services.authorize(operationObject(operation.review_json,"staking review"));services.signal?.throwIfAborted();
  let state=operationObject(operation.state_json);
  if(state.fundingStatus!=="transferred"){
    if(state.fundingStatus==="rejected")return{...operationResult(operation),status:"rejected",message:"ICWallet rejected this funding request. No replacement request has been created."};
    if(state.fundingStatus==="prepared"&&!(intent.fundingRoot&&input.fundingResults?.length)){
      await preflightUnfundedStake(operation,intent,services);
      const selection=await readWalletTokenSelection(services.kernel,intent.funding.ledger);
      if(!selection.selected){
        if(!intent.walletSelectionNeeded)throw new Error("ICWallet token selection changed after review. Add the token to Wallet before continuing this saved funding request");
        if(intent.fundingRoot)return{...operationResult(operation),status:"pending",fundingInstructions:[walletLedgerInstruction(intent.funding.ledger,{root:true}) as unknown as JsonObject],message:"Add the reviewed SNS token to ICWallet as the root agent, then continue this same staking operation before funding."};
        await invokeWalletLedgerAddition(services.kernel,intent.funding.ledger);
      }
    }
    operation=await saveFundingState(client,operation,{fundingStatus:"requested"});state=operationObject(operation.state_json);
    if(state.fundingStatus==="transferred")return executeNeuronOperation(operationId,{...services,authorize:async()=>{}});
    if(state.fundingStatus==="rejected")return{...operationResult(operation),status:"rejected"};
    let raw:unknown;
    if(intent.fundingRoot){
      const retainedResult=state.fundingResult;
      const supplied=input.fundingResults?.length?input.fundingResults:retainedResult&&typeof retainedResult==="object"&&!Array.isArray(retainedResult)&&retainedResult.status==="transferred"?[retainedResult]:[];
      if(!supplied.length)return{...operationResult(operation),status:"pending",fundingInstructions:[rootFundingInstruction(intent.funding) as unknown as JsonObject],message:"Call the exact Wallet funding instruction as the root agent, then continue this operation with fundingResults. Retain its IDs and deadline."};
      raw=supplied.find(value=>value!==null&&typeof value==="object"&&"commandId" in value&&value.commandId===`${intent.fundingCallerAppId}:${intent.funding.requestId}`);
      if(!raw)throw new Error("No Wallet result matched this operation’s original funding caller and request ID");
    }else{
      try{raw=await invokeWalletFunding(services.kernel,intent.funding,{root:false,expectedCallerAppId:"snsgov"});}
      catch(error){return{...operationResult(operation),status:"pending",message:`Wallet funding outcome is unknown. Continue the same operation and request: ${String(error)}`};}
    }
    const result=parseWalletFundingResult(raw,intent.funding,{expectedCallerAppId:intent.fundingCallerAppId});
    if(result.status!=="transferred"){
      operation=await saveFundingState(client,operation,{fundingStatus:result.status,fundingResult:operationJson(result)});
      if(operationObject(operation.state_json).fundingStatus!=="transferred")return{...operationResult(operation),status:result.status==="rejected"?"rejected":"pending",message:result.message??"Wallet funding is awaiting reconciliation"};
      return executeNeuronOperation(operationId,{...services,authorize:async()=>{}});
    }
    let evidence:unknown=null;
    if(intent.fundingRoot){
      try{evidence=await verifyWalletFundingReceipt(services.kernel,intent.funding,result,{expectedSourceAccount:intent.principal});}
      catch(error){operation=await saveFundingState(client,operation,{fundingStatus:"pending",fundingResult:operationJson(result)});return{...operationResult(operation),status:"pending",message:`The supplied funding receipt is not yet verified: ${String(error)}. Retain the original funding request.`};}
    }
    operation=await saveFundingState(client,operation,{fundingStatus:"transferred",fundingResult:operationJson(result),fundingEvidence:operationJson(evidence)});state=operationObject(operation.state_json);
  }
  // A successful payment does not imply claim/configuration success. Reconcile
  // only a retained attempted step whose deterministic state is observable.
  const completed=Array.isArray(state.completedSteps)?[...state.completedSteps]:[];
  for(const step of operation.steps){
    if(completed.includes(step.step_id)||step.status==="prepared"||step.status==="replied")continue;
    const command=decodeManageNeuronRequest(step.args).command[0];if(!command)continue;
    const snapshot=await readActionSnapshot(operation.governance,intent.neuronId,command,services),neuron=snapshot.neuron;
    if(!neuron)continue;
    if((step.step_id==="claim"||step.step_id==="refresh")&&neuron.stakeE8s>=BigInt(intent.baselineStakeAtoms)+BigInt(intent.amountAtoms))completed.push(step.step_id);
    if(step.step_id==="dissolve_delay"&&neuron.dissolveState?.kind==="delay"&&intent.dissolveDelaySeconds!==null&&neuron.dissolveState.value>=BigInt(intent.dissolveDelaySeconds))completed.push(step.step_id);
  }
  if(operationJsonText(completed)!==operationJsonText(state.completedSteps))operation=await mergeOperationState(client,operation,current=>({...current,completedSteps:[...new Set([...(Array.isArray(current.completedSteps)?current.completedSteps:[]),...completed])]}));
  return executeNeuronOperation(operationId,{...services,authorize:async()=>{}});
}

async function stakingBalance(ledger:string,governance:string,neuronId:string,services:NeuronActionServices):Promise<bigint>{
  return services.reads?.balance?services.reads.balance(ledger,governance,neuronId):balanceOf(ledger,{owner:Principal.fromText(governance),subaccount:fromHex(neuronId)});
}
/** Recheck protocol facts before first funding; never reinterpret a dispatched transfer. */
async function preflightUnfundedStake(operation:OperationDetail,intent:StakeIntent,services:NeuronActionServices):Promise<void>{
  const command=decodeManageNeuronRequest(operation.steps[0]!.args).command[0]!;
  const snapshot=await readActionSnapshot(operation.governance,intent.neuronId,command,services),p=snapshot.parameters;
  if(snapshot.mode===2)throw new Error("The SNS is not currently accepting this neuron funding operation");
  if(intent.kind==="stake"&&snapshot.neuron)throw new Error("The chosen neuron ID became occupied before funding. No transfer was requested");
  if(intent.kind==="topup"&&!snapshot.neuron)throw new Error("The neuron to top up no longer exists");
  if(snapshot.neuron&&isNeuronsFundControlled(snapshot.neuron))throw new Error("The SNS does not permit refreshing a neuron currently controlled by the Neurons’ Fund");
  const balance=await stakingBalance(intent.funding.ledger,operation.governance,intent.neuronId,services);
  if(p.neuronMinimumStakeE8s!==undefined&&balance+BigInt(intent.amountAtoms)<p.neuronMinimumStakeE8s)throw new Error(`The SNS now requires ${p.neuronMinimumStakeE8s} atomic tokens in the neuron account. This saved amount has not been transferred`);
  if(intent.kind==="stake"&&(intent.dissolveDelaySeconds!==null&&BigInt(intent.dissolveDelaySeconds)>0n||intent.autoStakeMaturity===true)){
    const permissions=p.neuronClaimerPermissions??[];
    if(!permissions.includes(1)&&!(permissions.includes(2)&&p.neuronGrantablePermissions?.includes(1)))throw new Error("The SNS no longer grants the permissions needed for this reviewed neuron configuration");
    // A required permission step was fixed before funding; a newly required
    // step cannot silently replace the reviewed immutable plan.
    if(!permissions.includes(1)&&!operation.steps.some(s=>s.step_id==="configure_permission"))throw new Error("New neuron permissions changed after preparation. No transfer was requested");
    if(intent.dissolveDelaySeconds!==null&&p.maxDissolveDelaySeconds!==undefined&&BigInt(intent.dissolveDelaySeconds)>p.maxDissolveDelaySeconds)throw new Error("The SNS maximum dissolve delay changed after this operation was prepared");
  }
}

async function saveFundingState(client:ReturnType<typeof createOperationClient>,operation:OperationDetail,patch:JsonObject):Promise<OperationDetail>{
  return mergeOperationState(client,operation,current=>{
    if(current.fundingStatus==="transferred")return current;
    if(current.fundingStatus==="rejected"&&patch.fundingStatus!=="transferred")return current;
    return{...current,...patch};
  });
}
