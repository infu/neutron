import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "@playwright/test";
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { serve } from "bun";
import { access, readdir, readFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = "extk7-gaaaa-aaaaq-aacda-cai";
// Fresh contexts isolate app state while avoiding repeated Chromium pipe
// creation, which can close a later browser's transport under Bun 1.2.
let suiteBrowser: Browser | undefined;
beforeAll(async()=>{suiteBrowser=await chromium.launch({headless:true,timeout:15_000,...await chromiumOptions()});},30_000);
afterAll(async()=>{await suiteBrowser?.close();},30_000);
// Shell, Explore, community details, Common, and CSS are real. Separate browser
// suites exercise feed/neuron/access flows; these stubs avoid any signed effect.
const boundary = `
export const calls = globalThis.__calls = [];
const listeners = new Set(); globalThis.__emitView = value => listeners.forEach(fn => fn(value));
export const onTileViewRequest = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const copyToClipboard = async value => { calls.push('copy:' + value); };
export const querySelf = async () => ({});
export const updateSelf = async () => { throw Error('Unexpected write'); };
const operation={version:1,operationId:'action-1',rootCanisterId:'${ROOT}',governanceCanisterId:'eqsml-lyaaa-aaaaq-aacdq-cai',kind:'stake',status:'pending',review:{title:'Stake 25 TOKEN'},input:{kind:'stake'},state:{fundingStatus:'transferred'},createdAtSeconds:'1789124400',updatedAtSeconds:'1789124460',steps:[{stepId:'claim',status:'unknown',error:'Reply interrupted'}],outcomes:[{stepId:'claim',message:'Checking the original neuron before continuing.'}],fundingInstructions:[]};
export const invoke = async (name,args) => {
 calls.push(name);
 if(name==='sns_operation_history_v1'){
  if(globalThis.__historyPending)await new Promise(resolve=>globalThis.__resolveHistory=resolve);
  return {version:1,operations:globalThis.__activity?[{operationId:'action-1',rootCanisterId:'${ROOT}',kind:'stake',title:'Stake 25 TOKEN',governanceCanisterId:operation.governanceCanisterId,status:'recorded',outcomeVerified:false,createdAtSeconds:operation.createdAtSeconds,updatedAtSeconds:operation.updatedAtSeconds,steps:operation.steps}]:[],nextCursor:globalThis.__historyPages?'25':null,total:globalThis.__activity?'1':'0'};
 }
 if(name==='sns_operation_status_v1'){
  if(globalThis.__voteOutcomes)return {...operation,kind:'vote',status:'pending',review:{title:'Vote Yes'},outcomes:[{neuronId:'11'.repeat(32),stepId:'vote_one',status:'succeeded',outcome:{ok:true,command:'RegisterVote'}},{neuronId:'22'.repeat(32),stepId:'vote_two',status:'reconciled',reconciled:true},{neuronId:'33'.repeat(32),stepId:'vote_three',status:'rejected',error:'Voting permission was removed'},{neuronId:'44'.repeat(32),stepId:'vote_four',status:'unknown'},{neuronId:'55'.repeat(32),stepId:'vote_five',status:'unattempted'}]};
  if(args.operationId==='action-2')return {...operation,operationId:'action-2',review:{title:'Change unlock delay'}};
  return globalThis.__continued?{...operation,status:'completed',steps:[{stepId:'claim',status:'replied'}],outcomes:[{stepId:'claim',outcome:{ok:true,command:'ClaimOrRefresh',neuronId:'aa'.repeat(32)}}]}:operation;
 }
 if(name==='sns_continue_v1'){if(globalThis.__continuePending)await new Promise((_resolve,reject)=>globalThis.__rejectContinuation=()=>reject(Error('Previous operation failed')));globalThis.__continued=args.operationId;return {version:1,operationId:args.operationId,status:'completed',operation};}
 return {};
};
export const operationId = () => 'fixture';
export const listDrafts = async () => { calls.push('drafts'); return [{id:'1'}]; };
const entry = { canisters: { root:'${ROOT}', governance:'eqsml-lyaaa-aaaaq-aacdq-cai', ledger:'extk7-gaaaa-aaaaq-aacea-cai', swap:null,index:null }, liveness:{governance:true,ledger:true}, metadata:{ name:'A community with a deliberately long descriptive name',description:'Building applications together, governed by people who stake their tokens and vote on proposals.',url:'https://example.com/community' },token:{name:'Community token',symbol:'TOKEN',decimals:8,fee:10000n,totalSupply:150000000000n} };
export const displayName = value => value.metadata.name;
export const peekRegistry = () => undefined;
export const getProvisionalRegistry = async () => globalThis.__provisional ? { entries:[{...entry,liveness:{governance:false,ledger:false}}],byRoot:new Map(),fetchedAt:0,livenessKnown:false } : undefined;
export const getRegistry = async () => {
  calls.push('registry');
  if(globalThis.__registryPending) await new Promise(resolve => globalThis.__resolveRegistry=resolve);
  if(globalThis.__failRegistry) throw Error('Community refresh unavailable');
  const entries=Array.from({length:36},(_,i)=>({...entry,canisters:{...entry.canisters,root:i===0?entry.canisters.root:'a'+i+'-'+entry.canisters.root},metadata:{...entry.metadata,name:i===0?entry.metadata.name:'Community '+String(i).padStart(2,'0')}}));
  return {entries,byRoot:new Map(entries.map(value=>[value.canisters.root,value])),fetchedAt:0,livenessKnown:true};
};
export const requireEntry = async () => {calls.push('entry');return globalThis.__missingToken?{...entry,token:undefined}:entry;};
export const readParameters=async()=>({neuronMinimumStakeE8s:987654321n,neuronMinimumDissolveDelayToVoteSeconds:15552000n,maxDissolveDelaySeconds:126144000n,rejectCostE8s:100000000n,initialVotingPeriodSeconds:345600n});
export const readMode=async()=>1;
export const readTreasuries=async()=>({tokenE8s:123456789n,icpE8s:100000000n});
export const listNervousSystemFunctions=async()=>[{id:1n,name:'A community proposal type',description:'Changes the community settings.',kind:'native'}];
export const uncategorizedFunctions=()=>[];
export const maxVotingPeriodExtensionSeconds=()=>172800n;
`;
const isolatedViews = `
import {useState} from 'react';
import {PageHeading,Dialog} from './src/ui/Common';
export const FeedView=()=> {const [open,setOpen]=useState(false);return <section className="nt-page"><PageHeading title="Proposal feed" description="Updates from every community."/><p>Feed fixture</p><button type="button" onClick={()=>setOpen(true)}>Open proposal editor</button>{open&&<Dialog title="Proposal editor" onClose={()=>setOpen(false)}><p>Review your proposal.</p></Dialog>}</section>;};
export const ProposalsView=({initialProposalId})=><section><h2>Proposal {initialProposalId==null?'list':String(initialProposalId)}</h2></section>;
export const MyNeuronsView=()=> <section><h2 tabIndex={-1}>My neurons</h2></section>;
export const NeuronsView=()=> <section><h2>My community neurons</h2></section>;
export const SetupView=({onBack})=> <section><PageHeading title="Connections & settings" onBack={onBack}/></section>;
export const DraftsView=({focusDraftId,onBack})=> <section><PageHeading title={focusDraftId?'Draft '+focusDraftId:'Drafts'} onBack={onBack}/></section>;
export const CanistersView=()=> <section><h3>Community canisters</h3></section>;
export const RegistrationButton=()=> <details><summary>Voting access</summary><p>Connected</p></details>;
export const ReviewHost=()=>null;
`;

async function runBrowser(run: (page: Page, frame: Frame) => Promise<void>) {
  const built = await esbuild.build({ absWorkingDir: appRoot,
    stdin: {contents:`import {createRoot} from 'react-dom/client';import {App} from './src/index';createRoot(document.getElementById('fixture')).render(<App/>);`,resolveDir:appRoot,sourcefile:'shell-fixture.tsx',loader:'tsx'},
    bundle:true,format:'esm',jsx:'automatic',outdir:'browser-test-dist',write:false,
    plugins:[{name:'fixtures',setup(build){
      build.onResolve({filter:/^neutron-tools\/app$|\/data\/(?:registry|drafts|governance|ledger|actions_client)$/},()=>({path:'boundary',namespace:'fixtures'}));
      build.onResolve({filter:/\/ui\/(?:Proposals|Neurons|Drafts|Setup|Registration|Canisters|ReviewHost)$|^\.\/(?:Proposals|Neurons|Registration|Canisters)$/},()=>({path:'views',namespace:'fixtures'}));
      build.onLoad({filter:/.*/,namespace:'fixtures'},args=>({contents:args.path==='boundary'?boundary:isolatedViews,loader:'tsx',resolveDir:appRoot}));
    }},sassPlugin()],
  });
  const js=built.outputFiles!.find(file=>file.path.endsWith('.js'))!.text;
  const css=built.outputFiles!.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
  const server=serve({hostname:'127.0.0.1',port:0,fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/bundle.js') return new Response(js,{headers:{'content-type':'text/javascript'}});
    if(path==='/tile') return new Response(`<html><head><meta charset="utf-8"><style>html,body{margin:0}</style><style>${css}</style></head><body><div id="fixture"></div><script type="module" src="/bundle.js"></script></body></html>`,{headers:{'content-type':'text/html'}});
    return new Response('<html><body style="margin:0"><iframe id="tile" title="SNS Gov" sandbox="allow-scripts allow-same-origin" src="/tile" style="display:block;border:0;width:100%;height:100vh"></iframe></body></html>',{headers:{'content-type':'text/html'}});
  }});
  let context: BrowserContext | undefined;
  try{
    context=await suiteBrowser!.newContext({viewport:{width:480,height:900}});
    const page=await context.newPage();
    const errors:string[]=[];
    page.on('pageerror',error=>errors.push(String(error)));
    await page.goto('http://127.0.0.1:'+server.port);
    const frame=page.frames().find(frame=>frame.url().endsWith('/tile'))!;
    await frame.getByRole('heading',{name:'Proposal feed',exact:true}).waitFor();
    await run(page,frame);
    expect(errors).toEqual([]);
  }finally{try{await context?.close();}finally{server.stop(true);}}
}

async function assertReadable(frame: Frame) {
  const result=await frame.evaluate(()=>{
    const width=document.documentElement.clientWidth;
    return {overflow:document.body.scrollWidth-width,
      offscreen:[...document.querySelectorAll('button,input,select,textarea')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.left < -1||r.right>width+1);}).map(el=>el.getAttribute('aria-label')??el.textContent),
      clippedNames:[...document.querySelectorAll('.snsgov-community-name')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.textContent),
    };
  });
  expect(result.overflow).toBeLessThanOrEqual(1);expect(result.offscreen).toEqual([]);expect(result.clippedNames).toEqual([]);
}

test('compact shell keeps named navigation, readable community rows and real iframe scrolling',async()=>{
  await runBrowser(async(page,frame)=>{
    for(const width of [320,360,480,640,960,1200]){
      await page.setViewportSize({width,height:800});
      await frame.getByRole('button',{name:'Explore',exact:true}).click();
      await frame.locator('.snsgov-community-row').first().waitFor();
      expect(await frame.locator('.snsgov-community-row').count()).toBe(36);
      await assertReadable(frame);
      const nameStyle=await frame.locator('.snsgov-community-name').first().evaluate(el=>getComputedStyle(el).whiteSpace);
      expect(nameStyle).not.toBe('nowrap');
      await frame.evaluate(()=>window.scrollTo(0,0));
      if(process.env.SNSGOV_UI_EVIDENCE_DIR&&(width===320||width===960)){await mkdir(process.env.SNSGOV_UI_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.SNSGOV_UI_EVIDENCE_DIR,`redesign-explore-${width}.png`),fullPage:true});}
      const box=await frame.locator('.snsgov-community-row').first().boundingBox();
      await page.mouse.move(box!.x+80,box!.y+25);
      await page.mouse.wheel(40,400);
      await frame.waitForFunction(()=>window.scrollY>0);
      expect(await frame.evaluate(()=>window.scrollY)).toBeGreaterThan(0);
      await frame.evaluate(()=>window.scrollTo(0,0));
    }
    // The tile remains narrow while the workspace itself is wide.
    await page.setViewportSize({width:1200,height:900});
    await page.locator('#tile').evaluate(el=>(el as HTMLElement).style.width='320px');
    await assertReadable(frame);
    for(const label of ['Feed','My neurons','Explore','Activity'])expect(await frame.getByRole('button',{name:label,exact:true}).isVisible()).toBe(true);
    if(process.env.SNSGOV_UI_EVIDENCE_DIR){await mkdir(process.env.SNSGOV_UI_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.SNSGOV_UI_EVIDENCE_DIR,'redesign-explore-320-in-workspace.png'),fullPage:true});}
  });
},120_000);

test('community details are collapsed and concept help works by keyboard inside the sandbox',async()=>{
  await runBrowser(async(page,frame)=>{
    await frame.evaluate(root=>(globalThis as any).__emitView('sns/'+root),'extk7-gaaaa-aaaaq-aacda-cai');
    await frame.getByRole('heading',{name:'A community with a deliberately long descriptive name',exact:true}).waitFor();
    expect(await frame.getByText('Maximum unlock delay',{exact:true}).isVisible()).toBe(false);
    for(const width of [320,480,960]){
      await page.setViewportSize({width,height:800});await assertReadable(frame);
      if(process.env.SNSGOV_UI_EVIDENCE_DIR){await mkdir(process.env.SNSGOV_UI_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.SNSGOV_UI_EVIDENCE_DIR,`redesign-overview-${width}.png`),fullPage:true});}
    }
    await page.setViewportSize({width:480,height:800});
    const help=frame.getByRole('button',{name:'About Unlock delay to vote',exact:true});
    await help.focus();await help.press('Enter');
    await frame.getByRole('tooltip').waitFor();
    expect(await help.getAttribute('aria-expanded')).toBe('true');
    await help.press('Escape');expect(await frame.getByRole('tooltip').count()).toBe(0);
    await frame.getByRole('button',{name:'Details',exact:true}).click();
    expect(await frame.getByText('Maximum unlock delay',{exact:true}).isVisible()).toBe(false);
    await frame.locator('summary').filter({hasText:'Voting & staking rules'}).click();
    expect(await frame.getByText('Maximum unlock delay',{exact:true}).isVisible()).toBe(true);
    await assertReadable(frame);
    await frame.evaluate(root=>(globalThis as any).__emitView('sns/'+root+'/canisters'),ROOT);
    await frame.getByRole('heading',{name:'Community canisters',exact:true}).waitFor();
    expect(await frame.getByRole('heading',{name:'Community canisters',exact:true}).isVisible()).toBe(true);
    if(process.env.SNSGOV_UI_EVIDENCE_DIR)await page.screenshot({path:join(process.env.SNSGOV_UI_EVIDENCE_DIR,'redesign-details-480.png'),fullPage:true});
  });
},120_000);

test('refresh errors preserve community data and incomplete liveness never labels it inactive',async()=>{
  await runBrowser(async(_page,frame)=>{
    await frame.evaluate(()=>{(globalThis as any).__provisional=true;(globalThis as any).__registryPending=true;});
    await frame.getByRole('button',{name:'Explore',exact:true}).click();
    await frame.locator('.snsgov-community-row').waitFor();
    expect(await frame.getByText('Inactive',{exact:true}).count()).toBe(0);
    await frame.evaluate(()=>(globalThis as any).__resolveRegistry());
    await frame.waitForFunction(()=>document.querySelectorAll('.snsgov-community-row').length===36);
    await frame.evaluate(()=>{(globalThis as any).__registryPending=false;(globalThis as any).__failRegistry=true;});
    await frame.getByRole('button',{name:'Refresh communities',exact:true}).click();
    await frame.getByRole('alert').filter({hasText:'Community refresh unavailable'}).waitFor();
    expect(await frame.locator('.snsgov-community-row').count()).toBe(36);
    expect(await frame.getByRole('button',{name:'Try again',exact:true}).isVisible()).toBe(true);
  });
},120_000);

test('legacy deep links still retarget and the shell does not loop on new callbacks',async()=>{
  await runBrowser(async(_page,frame)=>{
    for(const [view,heading] of [['draft/7','Draft 7'],['drafts','Drafts'],['setup','Connections & settings'],['sns/'+ROOT+'/proposals/42','Proposal 42'],['neurons','My neurons'],['list','Explore communities']] as const){
      await frame.evaluate(view=>(globalThis as any).__emitView(view),view);
      await frame.getByRole('heading',{name:heading,exact:true}).waitFor();
    }
    await frame.evaluate(view=>(globalThis as any).__emitView(view),'sns/'+ROOT+'/proposals/42');
    await frame.getByRole('heading',{name:'Proposal 42',exact:true}).waitFor();
    await frame.getByRole('button',{name:'Overview',exact:true}).click();
    await frame.evaluate(view=>(globalThis as any).__emitView(view),'sns/'+ROOT+'/proposals/42');
    await frame.getByRole('heading',{name:'Proposal 42',exact:true}).waitFor();
    const before=await frame.evaluate(()=>(globalThis as any).__calls.length);
    await new Promise(resolve=>setTimeout(resolve,500));
    const after=await frame.evaluate(()=>(globalThis as any).__calls.length);
    expect(after-before).toBeLessThan(3);
    expect(after).toBeLessThan(30);
  });
},120_000);

test('external navigation closes a hidden view’s native dialog without leaving the tile inert',async()=>{
  await runBrowser(async(_page,frame)=>{
    await frame.getByRole('button',{name:'Open proposal editor',exact:true}).click();
    await frame.getByRole('dialog',{name:'Proposal editor',exact:true}).waitFor();
    expect(await frame.locator('dialog:modal').count()).toBe(1);
    await frame.evaluate(()=>(globalThis as any).__emitView('activity'));
    await frame.waitForFunction(()=>document.querySelectorAll('dialog:modal').length===0);
    await frame.getByRole('button',{name:'Explore',exact:true}).click();
    await frame.getByRole('heading',{name:'Explore communities',exact:true}).waitFor();
    await frame.getByRole('button',{name:'Feed',exact:true}).click();
    expect(await frame.getByRole('dialog',{name:'Proposal editor',exact:true}).count()).toBe(0);
  });
},120_000);

test('activity distinguishes recorded transport from confirmed outcomes and resumes only the saved action',async()=>{
  await runBrowser(async(page,frame)=>{
    await frame.evaluate(()=>{(globalThis as any).__activity=true;});
    await frame.getByRole('button',{name:'Activity',exact:true}).click();
    await frame.getByText('View result',{exact:true}).waitFor();
    expect(await frame.getByText('Accepted by the community.',{exact:true}).count()).toBe(0);
    for(const width of [320,960]){
      await page.setViewportSize({width,height:800});await assertReadable(frame);
      if(process.env.SNSGOV_UI_EVIDENCE_DIR){await mkdir(process.env.SNSGOV_UI_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.SNSGOV_UI_EVIDENCE_DIR,`redesign-activity-${width}.png`),fullPage:true});}
    }
    await frame.locator('.snsgov-activity-row').click();
    await frame.getByRole('heading',{name:'Stake 25 TOKEN',exact:true}).waitFor();
    expect(await frame.getByText('Reply not confirmed',{exact:true}).isVisible()).toBe(true);
    expect(await frame.evaluate(()=>(globalThis as any).__calls.filter((call:string)=>call==='sns_continue_v1').length)).toBe(0);
    await frame.getByRole('button',{name:'Check status',exact:true}).click();
    expect(await frame.evaluate(()=>(globalThis as any).__calls.filter((call:string)=>call==='sns_continue_v1').length)).toBe(0);
    await frame.getByRole('button',{name:'Continue this action',exact:true}).click();
    await frame.getByText('Accepted by the community.',{exact:true}).waitFor();
    expect(await frame.evaluate(()=>(globalThis as any).__continued)).toBe('action-1');
    expect(await frame.getByRole('button',{name:'Continue this action',exact:true}).count()).toBe(0);
    for(const width of [320,960]){
      await page.setViewportSize({width,height:800});await assertReadable(frame);
      if(process.env.SNSGOV_UI_EVIDENCE_DIR)await page.screenshot({path:join(process.env.SNSGOV_UI_EVIDENCE_DIR,`redesign-action-result-${width}.png`),fullPage:true});
    }
  });
},120_000);

test('activity renders vote outcome unions and does not mislabel reconciled votes as unknown',async()=>{
  await runBrowser(async(_page,frame)=>{
    await frame.evaluate(()=>{(globalThis as any).__voteOutcomes=true;(globalThis as any).__emitView('activity/action-1');});
    await frame.getByRole('heading',{name:'Vote Yes',exact:true}).waitFor();
    for(const text of ['Accepted by the community.','Confirmed from the current state.','Voting permission was removed','The reply was interrupted. Check the saved result before retrying.','Not sent. Continue the saved action when you are ready.'])expect(await frame.getByText(text,{exact:true}).isVisible()).toBe(true);
    expect(await frame.getByText('No confirmed result yet.',{exact:true}).count()).toBe(0);
  });
},120_000);

test('activity retargeting isolates late results and blocks pagination during refresh',async()=>{
  await runBrowser(async(_page,frame)=>{
    await frame.evaluate(()=>{(globalThis as any).__activity=true;(globalThis as any).__historyPages=true;(globalThis as any).__emitView('activity');});
    await frame.getByRole('button',{name:'Load more',exact:true}).waitFor();
    await frame.evaluate(()=>{(globalThis as any).__historyPending=true;});
    await frame.getByRole('button',{name:'Refresh',exact:true}).click();
    await frame.waitForFunction(()=>typeof (globalThis as any).__resolveHistory==='function');
    expect(await frame.getByRole('button',{name:'Load more',exact:true}).isDisabled()).toBe(true);
    await frame.evaluate(()=>{(globalThis as any).__historyPending=false;(globalThis as any).__resolveHistory();});
    await frame.locator('.snsgov-activity-row').click();
    await frame.getByRole('heading',{name:'Stake 25 TOKEN',exact:true}).waitFor();
    await frame.evaluate(()=>{(globalThis as any).__continuePending=true;});
    await frame.getByRole('button',{name:'Continue this action',exact:true}).click();
    await frame.waitForFunction(()=>typeof (globalThis as any).__rejectContinuation==='function');
    await frame.evaluate(()=>(globalThis as any).__emitView('activity/action-2'));
    await frame.getByRole('heading',{name:'Change unlock delay',exact:true}).waitFor();
    await frame.evaluate(()=>(globalThis as any).__rejectContinuation());
    expect(await frame.getByRole('alert').filter({hasText:'Previous operation failed'}).count()).toBe(0);
    expect(await frame.getByRole('button',{name:'Continue this action',exact:true}).isEnabled()).toBe(true);
  });
},120_000);

test('all app views use sandbox-compatible actions instead of form submission',async()=>{
  const files:string[]=[];
  async function walk(dir:string){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(/\.tsx$/.test(path))files.push(path);}}
  await walk(join(appRoot,'src'));
  const sources=await Promise.all(files.map(async path=>[path,await readFile(path,'utf8')] as const));
  expect(sources.filter(([,text])=>/<form[\s>]/.test(text)).map(([path])=>path)).toEqual([]);
});

async function chromiumOptions(): Promise<{executablePath?:string}> {
  if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)return {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE};
  let store:string[]=[];try{store=await readdir('/nix/store');}catch{}
  const candidates=[...store.filter(name=>name.endsWith('-playwright-chromium')).sort().map(name=>join('/nix/store',name,'chrome-linux64','chrome')),'/run/current-system/sw/bin/google-chrome-stable','/usr/bin/google-chrome','/usr/bin/chromium'];
  for(const executablePath of candidates){try{await access(executablePath,constants.X_OK);return {executablePath};}catch{}}
  return {};
}
