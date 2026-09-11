import { chromium, type Browser, type Frame, type Page } from "@playwright/test";
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { serve } from "bun";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "bun:test";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const boundary = `
export const calls = globalThis.__calls = [];
export const pending = globalThis.__pending = {};
export const A = { canisters: { root: "extk7-gaaaa-aaaaq-aacda-cai", governance: "gov-a", ledger:"ledger-a", swap:null,index:null }, liveness:{governance:true,ledger:true}, metadata:{name:"A community with a very long readable name"}, token:{name:"Token A",symbol:"AAA",decimals:8,fee:10000n} };
export const B = { ...A, canisters:{...A.canisters,root:"csyra-haaaa-aaaaq-aacva-cai",governance:"gov-b"}, metadata:{name:"Second community"} };
export const ids = ["11".repeat(32),"22".repeat(32),"33".repeat(32),"44".repeat(32),"55".repeat(32)];
const now = BigInt(Math.floor(Date.now()/1000));
export const proposal = (id, extra={}) => ({ id:BigInt(id),title:globalThis.__proposalTitle ?? "Readable proposal title " + id,summary:globalThis.__proposalSummary ?? "A detailed summary that stays readable in the proposal feed. ".repeat(9),url:"https://example.com/proposal",status:"open",actionKind:"Motion",createdAtSeconds:now-(100n-BigInt(id)),deadlineSeconds:now+10000n,tally:{yes:25n,no:5n,total:100n,timestampSeconds:now},...extra });
let ballots = ids.map(id=>({neuronId:id,vote:0,votingPower:100n,castAtSeconds:0n}));
let operation = 0;
export const MAX_PROPOSALS_PER_CALL = 100;
export const listDeployedSnses = async()=>[A.canisters,B.canisters];
export const getRegistry = async()=>({entries:[A,B],byRoot:new Map([[A.canisters.root,A],[B.canisters.root,B]]),livenessKnown:true});
export const peekRegistry = ()=>{const cachedB=globalThis.__knownDeadB?{...B,liveness:{governance:false,ledger:true}}:B;return {entries:[A,cachedB],byRoot:new Map([[A.canisters.root,A],[B.canisters.root,cachedB]])};};
export const requireEntry = async root=>root===B.canisters.root?B:A;
export const displayName = entry=>entry.metadata?.name??entry.canisters.root;
export const readMetadata = async gov=>(gov==="gov-b"?B:A).metadata;
export const listProposals = async (gov, options) => {
  calls.push({kind:"list",gov,before:options.beforeProposal?.toString()});
  if (globalThis.__failRead) throw Error("Proposal refresh unavailable");
  if (gov === "gov-b" && globalThis.__slowB) await new Promise(resolve=>pending.feedB=resolve);
  if (gov === "gov-b" && globalThis.__deadB) throw Error("IC0537: Canister contains no Wasm module");
  if (gov === "gov-b" && globalThis.__failB) throw Error("Second community unavailable");
  const all = globalThis.__olderOnly ? Array.from({length:24},(_,i)=>proposal(30-i,{status:"rejected",deadlineSeconds:now-1n,...(i===23?{title:"Older proposal accepting votes",deadlineSeconds:now+10000n}: {})})) : [proposal(3,{title:globalThis.__proposalTitle ?? (gov==="gov-b"?"Second community proposal":"Readable proposal title 3")}),proposal(2),proposal(1)];
  const rows=all.filter(p=>options.beforeProposal===undefined||p.id<options.beforeProposal).slice(0,options.limit);
  return {proposals:rows,...(rows.length===options.limit&&rows.at(-1).id>7n?{nextBefore:rows.at(-1).id}: {})};
};
export const getProposal = async (gov,id)=>{
  if (id===2n && globalThis.__slowDetail) await new Promise(resolve=>pending.detail=resolve);
  return {...proposal(id),ballots:[...ballots],rejectCostE8s:100000000n,payloadTextRendering:"A safe plain text proposal change."};
};
export const readHotkey=async()=>({principal:"aaaaa-aa",canManageNeuron:true});
export const querySelf=async()=>({snses:[A,B].map(entry=>({sns:entry.canisters.root,voting_enabled:true}))});
export const copyToClipboard=async()=>{};
export const scanForNeuronsDetailed=async()=>({value:[{rootCanisterId:A.canisters.root,status:{found:[{neuronId:ids[0]}]}}],failures:[]});
export const readRegistration=async gov=>{
  if(gov==="gov-error")throw Error("Registration unavailable");
  const id=gov==="gov-b"?ids[1]:ids[0];
  return {found:[{neuronId:id,missing:[],readiness:"ready"}],ready:1,truncated:false,repairable:[],blocked:[],failures:[]};
};
export const buildVotePlan=async()=>({eligibleNeuronIds:ballots.filter(b=>b.vote===0).map(b=>b.neuronId),alreadyVotedNeuronIds:ballots.filter(b=>b.vote!==0).map(b=>b.neuronId),alreadyVoted:ballots.filter(b=>b.vote!==0),acceptsVotes:true,excludedNeurons:[],discoveryComplete:true,failures:[]});
export const readParameters=async()=>({rejectCostE8s:100000000n});
export const listNervousSystemFunctions=async()=>[];
export const drafts=[
 {id:"1",sns:A.canisters.root,governance:"gov-a",title:"First draft",summary:"Review first proposal",url:"",actionKind:"Motion",motionText:"First motion",createdBy:"agent",updatedAtSeconds:1n},
 {id:"2",sns:B.canisters.root,governance:"gov-b",title:"Second draft",summary:"Review second proposal",url:"",actionKind:"Motion",motionText:"Second motion",createdBy:"agent",updatedAtSeconds:2n},
 {id:"3",sns:B.canisters.root,governance:"gov-b",title:"Ineligible preset",summary:"Choose its own proposer",url:"",actionKind:"Motion",motionText:"Third motion",proposer:new Uint8Array(32).fill(0x11),createdBy:"agent",updatedAtSeconds:3n},
 {id:"4",sns:A.canisters.root,governance:"gov-error",title:"Unavailable registration",summary:"Read error",url:"",actionKind:"Motion",motionText:"Fourth motion",createdBy:"agent",updatedAtSeconds:4n}
];
export const listDrafts=async()=>{if(globalThis.__failDraftRead)throw Error("Draft refresh unavailable");return drafts;};
export const canPropose=missing=>!missing.includes(3);
export const operationId=()=>String(++operation).padStart(32,"0");
export const invoke=async(name,args)=>{
 calls.push({kind:"invoke",name,args});
 if(name==="sns_vote"){
  if(globalThis.__holdVote)await new Promise(resolve=>pending.vote=resolve);
  const selected=args.neuronIds;
  const vote=args.adopt?1:2;
  ballots=ballots.map(b=>b.neuronId===selected[0]?{...b,vote}:b.neuronId===selected[1]?{...b,vote:2}:b);
  return {operationId:args.operationId,status:"completed",alreadyVoted:selected[1]?[{neuronId:selected[1],vote:2}]:[],outcomes:selected.slice(0,3).filter((id,i)=>i!==1).map((id,i)=>({neuronId:id,status:i===0?"succeeded":"rejected",outcome:i===0?{ok:true}:{ok:false,errorType:5,errorMessage:"Governance rejected this ballot"}})),unattemptedNeuronIds:selected.slice(3)};
 }
 if(name==="sns_submit_draft_v1"){
  if(globalThis.__loseDraftReply)throw Error("Submission reply was interrupted");
  return {operationId:"draft-operation-"+args.draftId,status:"completed",outcomes:[{stepId:"proposal",outcome:{ok:true,proposalId:"42"}}],cleanupWarning:"Draft removal failed; do not submit it again."};
 }
 if(name==="sns_drafts")return {drafts:drafts.map(draft=>({id:draft.id,operationId:"draft-operation-"+draft.id}))};
 if(name==="sns_operation_status_v1")return {operationId:args.operationId,status:"pending",outcomes:[]};
 if(name==="sns_continue_v1")return {operationId:args.operationId,status:"pending",outcomes:[]};
 if(name==="sns_preview_proposal_v1")return {status:"prepared",review:{title:args.title,action:args.action}};
 if(name==="sns_submit_proposal_v1")return {status:"completed",operationId:args.operationId,outcomes:[{outcome:{ok:true,proposalId:"99"}}]};
 if(name==="sns_draft_proposal")return {draftId:"8"};
 if(name==="sns_delete_draft_v1")return {deleted:true,draftId:args.draftId};
 throw Error("Unexpected tool: "+name);
};
`;
let bundlePromise: Promise<{ js: string; css: string }> | undefined;
async function bundle() {
  if (!bundlePromise) bundlePromise = (async () => {
    const built = await esbuild.build({
      absWorkingDir: appRoot,
      stdin: { contents: `
import {useState} from "react"; import {createRoot} from "react-dom/client";
import {FeedView} from "./src/ui/Feed"; import {ProposalsView} from "./src/ui/Proposals"; import {DraftsView} from "./src/ui/Drafts"; import {A} from "test:boundary"; import "./src/style.scss";
function Harness(){const [view,setView]=useState({kind:"feed"});globalThis.__show=setView;return <main className="nt-app nt-app--fill snsgov-app"><div className="nt-page"><section className="snsgov-content">{view.kind==="feed"?<FeedView/>:view.kind==="proposals"?<ProposalsView entry={A} initialProposalId={view.id==null?undefined:BigInt(view.id)}/>:<DraftsView onBack={()=>setView({kind:"feed"})} focusDraftId={view.id??null}/>}</section></div></main>;} createRoot(document.getElementById("fixture")).render(<Harness/>);`, resolveDir: appRoot, loader: "tsx", sourcefile: "proposal-ui-harness.tsx" },
      bundle: true, format: "esm", jsx: "automatic", outdir: "browser-test-dist", write: false,
      plugins: [{ name: "proposal-ui-boundary", setup(build) {
        build.onResolve({ filter: /^(?:test:boundary|neutron-tools\/app)$|(?:\/data\/|^\.\/)(?:registry|discovery|drafts|governance|registration|relay|voting|actions_client)$/ }, () => ({path:"boundary",namespace:"proposal-ui-boundary"}));
        build.onLoad({filter:/.*/,namespace:"proposal-ui-boundary"},()=>({contents:boundary,loader:"ts"}));
      } }, sassPlugin()],
    });
    return {js:built.outputFiles!.find(file=>file.path.endsWith(".js"))!.text,css:built.outputFiles!.find(file=>file.path.endsWith(".css"))!.text};
  })();
  return bundlePromise;
}
export async function proposalBrowser(run: (ui: Frame, page: Page) => Promise<void>, options: { width?: number; flags?: Record<string, boolean> } = {}) {
  const built = await bundle();
  const server = serve({hostname:"127.0.0.1",port:0,fetch(request){
    const path = new URL(request.url).pathname;
    if(path==="/bundle.js")return new Response(built.js,{headers:{"content-type":"text/javascript"}});
    if(path==="/frame")return new Response(`<html><head><style>html,body{margin:0;height:100%}#fixture{height:100%}</style><style>${built.css}</style></head><body><div id="fixture"></div><script>${Object.entries(options.flags??{}).map(([key,value])=>`globalThis[${JSON.stringify(key)}]=${JSON.stringify(value)};`).join("")}</script><script type="module" src="/bundle.js"></script></body></html>`,{headers:{"content-type":"text/html"}});
    return new Response('<html><body style="margin:0"><iframe title="SNS Governance" sandbox="allow-scripts allow-same-origin" src="/frame" style="width:100vw;height:100vh;border:0"></iframe></body></html>',{headers:{"content-type":"text/html"}});
  }});
  let browser: Browser | undefined;
  try {
    browser=await chromium.launch({headless:true,timeout:15_000,...await chromiumOptions()});
    const page=await browser.newPage({viewport:{width:options.width??960,height:800}});
    page.setDefaultTimeout(12000); const crashes:string[]=[];page.on("pageerror",error=>crashes.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.port}`);
    const ui = page.frames().find(frame=>frame.url().endsWith("/frame"))!;
    await ui.getByRole("heading",{name:"Feed",exact:true}).waitFor();
    try { await run(ui,page); } catch(error) {
      const diagnostic = await ui.locator("body").innerText({ timeout: 1_000 }).catch(() => "Browser content unavailable during failure cleanup.");
      console.error(diagnostic.slice(0, 2500), crashes);
      throw error;
    } expect(crashes).toEqual([]);
  } finally {
    // Stop HTTP connections even if launch failed or browser teardown stalls.
    server.stop(true);
    if (browser) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          browser.close(),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Browser cleanup exceeded 15 seconds.")), 15_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    }
  }
}
export async function show(ui: Frame, view: object){await ui.evaluate(value=>(globalThis as any).__show(value),view);}
async function chromiumOptions():Promise<{executablePath?:string}>{
 if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)return{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE};
 let store:string[]=[];try{store=await readdir("/nix/store");}catch{}
 const candidates=[...store.filter(name=>name.endsWith("-playwright-chromium")).sort().map(name=>join("/nix/store",name,"chrome-linux64","chrome")),"/run/current-system/sw/bin/google-chrome-stable","/usr/bin/chromium","/usr/bin/google-chrome"];
 for(const executablePath of candidates){try{await access(executablePath,constants.X_OK);return{executablePath};}catch{}}
 return{};
}
