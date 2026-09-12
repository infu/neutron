import { expect, test } from "bun:test";
import { spawn } from "bun";
import { fileURLToPath } from "node:url";

test("scoped actions preserve approval, root funding identity and immutable recovery", async () => {
  const child = spawn([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    import { IDL } from "@dfinity/candid";
    import { idlFactory } from "./src/candid/sns_governance.did.js";
    const principal="rrkah-fqaaa-aaaaa-aaaaq-cai",sns="qaa6y-5yaaa-aaaaa-aaafa-cai",governance="ryjl3-tyaaa-aaaaa-aaaba-cai";
    const entry={canisters:{root:sns,governance,ledger:"mxzaz-hqaaa-aaaar-qaada-cai"},liveness:{governance:true,ledger:true},token:{symbol:"TEST",decimals:8,fee:10n}};
    const handlers=new Map(),methods=idlFactory({IDL})._fields,journal=new Map(),calls=[],approvals=[],prepares=[];
    let allow=true,config=[],sequence=0,stakingCalls=0;
    mock.module("neutron-tools/app",()=>({exposeTool:(name,descriptor,handler)=>handlers.set(name,handler),querySelf:()=>{throw Error("ambient query")},updateSelf:()=>{throw Error("ambient update")},callTool:()=>{throw Error("ambient tool")}}));
    mock.module("./src/data/registry",()=>({requireEntry:async()=>entry,displayName:()=>"Test SNS"}));
    const governanceReads=await import("./src/data/governance");
    mock.module("./src/data/governance",()=>({...governanceReads,getNeuron:async()=>null,readParameters:async()=>({}),listTopics:async()=>({}),readRunningSnsVersion:async()=>({}),readUpgradeJournal:async()=>({}),listProposals:async()=>({proposals:[]})}));
    mock.module("./src/data/staking",()=>({prepareStake:async(input,services)=>{
      stakingCalls++;prepares.push({input,services});
      const operation={operation_id:input.operationId,sns,governance,input_json:JSON.stringify({kind:"stake",principal,fundingRoot:services.funding.root,fundingCallerAppId:services.funding.callerAppId}),review_json:JSON.stringify({title:"Stake"}),state_json:JSON.stringify({fundingStatus:"prepared"}),initiator:services.initiator,seq:"1",revision:"0",created_at_seconds:"1",updated_at_seconds:"1",steps:[]};
      return{operationId:input.operationId,status:"prepared",review:{title:"Stake"},operation,outcomes:[],fundingInstructions:[]};
    },continueStake:async()=>{throw Error("restricted prep must not dispatch")}}));
    const kernel={
      querySelf:async(method,args)=>{calls.push({method,args});if(method==="snsgov_hotkey")return{principal,can_manage_neuron:true};if(method==="snsgov_config")return{snses:config};if(method==="snsgov_operation_get")return journal.get(args[0])??null;throw Error("unexpected query "+method)},
      updateSelf:async(method,args)=>{calls.push({method,args});if(method==="snsgov_sns_upsert"){config=[args[0]];return null}if(method==="snsgov_operation_prepare"){const input=args[0],old=journal.get(input.operation_id);if(old)return old;const op={...input,seq:String(++sequence),revision:"0",created_at_seconds:"1",updated_at_seconds:"1",steps:input.steps.map(step=>({...step,status:"prepared"}))};journal.set(op.operation_id,op);return op;}if(method==="snsgov_operation_dispatch"){const op=journal.get(args[0].operation_id),step=op.steps.find(step=>step.step_id===args[0].step_id);assert.equal(step.status,"prepared");step.status="replied";step.reply=new Uint8Array(IDL.encode(methods.find(([name])=>name===step.method)[1].retTypes,[{}]));return op;}throw Error("unexpected update "+method)},
      callTool:async()=>{throw Error("unexpected Wallet or tile call")}
    };
    const root={kernel,caller:{appId:"agent",installationUid:"4",role:"background",endpoint:"app:agent:background"},agentMode:true,audience:"agent_root",requestApproval:async(review)=>{approvals.push(review);if(!allow)throw Error("declined")},reportProgress(){}};
    const nested={...root,audience:"normal",caller:{appId:"nested-worker",installationUid:"5",role:"background",endpoint:"app:nested-worker:background"}};
    await import("./src/action_tools.ts");
    const stake={operationId:"1".repeat(32),rootCanisterId:sns,amountAtoms:"100"};
    const delegation=await handlers.get("sns_stake_v1")(stake,nested);
    assert.equal(delegation.status,"root_preparation_required");assert.equal(stakingCalls,0);assert.equal(journal.size,0);
    assert.deepEqual(delegation.rootPreparationInstructions,[{target:"app:snsgov:background",name:"sns_stake_root_v1",arguments:stake}]);
    await assert.rejects(()=>handlers.get("sns_stake_root_v1")(stake,nested),/root-agent attestation/);
    const prepared=await handlers.get("sns_stake_root_v1")(stake,root);
    assert.equal(stakingCalls,1);assert.equal(prepares[0].services.funding.callerAppId,"agent");assert.equal(prepares[0].services.funding.root,true);
    assert.deepEqual(prepared.fundingInstructions,[]);assert.equal(prepared.continuationInstructions[0].name,"sns_continue_v1");assert.equal(approvals.length,0);
    const maintenance={operationId:"2".repeat(32),rootCanisterId:sns,method:"reset_timers"};
    allow=false;await assert.rejects(()=>handlers.get("sns_governance_recovery_v1")(maintenance,root),/declined/);
    assert.equal(journal.size,1);assert.equal(calls.filter(call=>call.method==="snsgov_operation_dispatch").length,0);assert.equal(config.length,0);
    allow=true;const completed=await handlers.get("sns_governance_recovery_v1")(maintenance,root);
    assert.equal(completed.status,"completed");assert.equal(config[0].voting_enabled,true);assert.equal(config[0].agent_voting_enabled,false);
    assert.equal(approvals.at(-1).snsAccess.action,"Enable Neutron access to this SNS");
    assert.equal(journal.get(maintenance.operationId).steps[0].method,"reset_timers");
    const dispatches=calls.filter(call=>call.method==="snsgov_operation_dispatch").length;
    const restored=await handlers.get("sns_operation_status_v1")({operationId:maintenance.operationId},root);
    assert.equal(restored.status,"completed");assert.deepEqual(restored.result,{});
    await handlers.get("sns_governance_recovery_v1")(maintenance,root);
    assert.equal(calls.filter(call=>call.method==="snsgov_operation_dispatch").length,dispatches);
    await assert.rejects(()=>handlers.get("sns_governance_recovery_v1")({...maintenance,method:"fail_stuck_upgrade_in_progress"},root),/different saved governance request/);
    journal.get(maintenance.operationId).steps[0].reply=new Uint8Array([1,2]);
    const undecodable=await handlers.get("sns_continue_v1")({operationId:maintenance.operationId},root);
    assert.equal(undecodable.status,"pending");assert.match(undecodable.message,/retained but could not be decoded/);
    assert.equal(calls.filter(call=>call.method==="snsgov_operation_dispatch").length,dispatches);
    const catalog=await handlers.get("sns_governance_query_v1")({rootCanisterId:sns},root);
    assert.ok(catalog.methods.some(method=>method.name==="get_metrics"));assert.ok(!catalog.methods.some(method=>method.name==="get_metrics_replicated"));assert.ok(!catalog.methods.some(method=>method.name==="set_mode"));assert.ok(catalog.methods.some(method=>method.name==="list_topics"));
    console.log(JSON.stringify({rootPreparation:true,exactReview:true,retainedRecovery:true,queryCatalog:true}));
  `], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(stdout).retainedRecovery).toBe(true);
}, 30_000);
