import { expect, test } from "bun:test";
import { chromium, type Browser, type Frame, type Page } from "@playwright/test";
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { serve } from "bun";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const boundary = `
  export const calls = globalThis.__neuronCalls = [];
  globalThis.__failedCommunity = true;
  const ids = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
  export const entry = { canisters: { root: "extk7-gaaaa-aaaaq-aacda-cai", governance: "eqsml-lyaaa-aaaaq-aacdq-cai", ledger: "extk7-gaaaa-aaaaq-aacea-cai", swap: null, index: null }, liveness: { governance: true, ledger: true }, metadata: { name: "A community with a readable long name" }, token: { symbol: "TOKEN", name: "Token", decimals: 8, fee: 10000n } };
  export const other = { ...entry, canisters: { ...entry.canisters, root: "other-root", governance: "unavailable" }, metadata: { name: "Temporarily unavailable community" } };
  export const makeNeuron = (id=ids[0], full=false) => ({ id, stakeE8s: 1234567890123456n, maturityE8s: 123456789n, stakedMaturityE8s: 0n, feesE8s: 1000n, votingPowerMultiplierPercent: 100n, createdAtSeconds: 1n, agingSinceSeconds: 1n, dissolveState: { kind: "delay", value: 864000n }, permissions: [{ principal: "aaaaa-aa", permissions: full ? [1,2,3,4,5,6,7,8,9,10] : [4] }] });
  export const displayName = item => item.metadata.name;
  export const getRegistry = async () => ({ entries: [entry, other], livenessKnown: true, byRoot: new Map([[entry.canisters.root,entry],[other.canisters.root,other]]), fetchedAt: 0 });
  export const readHotkey = async () => ({ principal: "aaaaa-aa", canManageNeuron: true });
  export const listAllNeurons = async governance => {
    calls.push({ kind: "scan", governance });
    if (governance === "unavailable" && globalThis.__failedCommunity) throw new Error("Community read unavailable");
    if (globalThis.__refreshFailure) throw new Error("Refresh unavailable");
    return { neurons: governance === "unavailable" ? [] : [makeNeuron()], truncated: false, failures: [] };
  };
  export const listNeurons = async (_governance, args) => {
    calls.push({ kind: "page", principal: args.ofPrincipal ?? null, cursor: args.startPageAt ? [...args.startPageAt] : null });
    if (args.ofPrincipal === "slow") await new Promise(resolve => globalThis.__resolveSlow = resolve);
    if (globalThis.__publicFailure) throw new Error("Page unavailable");
    if (args.startPageAt) return { neurons: [makeNeuron(ids[1])], truncated: false };
    return { neurons: [makeNeuron(args.ofPrincipal ? ids[2] : ids[0])], truncated: true, nextStartPageAt: new Uint8Array([1]) };
  };
  export const getNeuron = async (_gov,id) => makeNeuron(id,!!globalThis.__full);
  export const getProposal = async () => undefined;
  export const readMode = async () => 1;
  export const readParameters = async () => ({ neuronMinimumStakeE8s: 100000000n, transactionFeeE8s: 10000n, neuronMinimumDissolveDelayToVoteSeconds: 86400n, maxDissolveDelaySeconds: 100000000n, neuronGrantablePermissions: [1,2,3,4,5,6,7,8,9,10] });
  export const readTokenInfo = async () => { if(globalThis.__metadataFailure) throw new Error("Token metadata unavailable"); return entry.token; };
  export const balanceOf = async () => 10000000000n;
  export const copyToClipboard = async text => { calls.push({ kind: "copy", text }); };
  let nextOperation = 0; export const operationId = () => (++nextOperation).toString(16).padStart(32,"0");
  export const invoke = async (name,args) => {
    calls.push({ kind:"tool", name, args });
    if(name === "sns_stake_preview_v1" || name === "sns_preview_neuron_v1") return {version:1,operationId:args.operationId??"preview",status:"preview",review:{title:"Exact review",...args},token:{symbol:"TOKEN",decimals:8,feeAtoms:"10000"}};
    if(globalThis.__operationFailure) throw new Error("Reply interrupted");
    return {version:1,operationId:args.operationId,status:"completed",outcomes:[{stepId:"command",outcome:{ok:true,command:"Configure"}}],fundingInstructions:[]};
  };
`;

async function runBrowser(run: (frame: Frame, page: Page) => Promise<void>) {
  const built = await esbuild.build({ absWorkingDir: appRoot,
    stdin: { contents: `import {useState} from "react"; import {createRoot} from "react-dom/client";
      import {MyNeuronsView,NeuronsView} from "./src/ui/Neurons";
      import {NeuronDetail} from "./src/ui/NeuronDetail";
      import {entry} from "test:neurons-boundary";
      import "./src/style.scss";
      function Harness(){const [view,setView]=useState("mine"); globalThis.__neuronView=setView;
        return <main className="nt-app nt-app--fill snsgov-app">{view==="mine" ? <MyNeuronsView/> : view==="public" ? <div className="nt-page"><section className="nt-page-main"><NeuronsView entry={entry}/></section></div> : <NeuronDetail entry={entry} principal="aaaaa-aa" neuronId={"11".repeat(32)} onBack={()=>setView("mine")}/>}</main>;}
      createRoot(document.getElementById("fixture")).render(<Harness/>);`, loader: "tsx", sourcefile: "neuron-browser-harness.tsx", resolveDir: appRoot },
    bundle: true, format: "esm", jsx: "automatic", outdir: "browser-test-dist", write: false,
    plugins: [{name:"neuron-boundary",setup(build){
      build.onResolve({filter:/^(?:test:neurons-boundary|neutron-tools\/app)$|\/data\/(?:governance|registry|relay|ledger|actions_client)$/},()=>({path:"boundary",namespace:"neuron-boundary"}));
      build.onLoad({filter:/.*/,namespace:"neuron-boundary"},()=>({contents:boundary,loader:"ts"}));
    }},sassPlugin()],
  });
  const js = built.outputFiles!.find(file=>file.path.endsWith(".js"))!.text;
  const css = built.outputFiles!.find(file=>file.path.endsWith(".css"))!.text;
  const server = serve({hostname:"127.0.0.1",port:0,fetch(request){
    const path = new URL(request.url).pathname;
    if(path==="/bundle.js")return new Response(js,{headers:{"content-type":"text/javascript"}});
    if(path==="/frame")return new Response(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}</style><style>${css}</style></head><body><div id="fixture"></div><script type="module" src="/bundle.js"></script></body></html>`,{headers:{"content-type":"text/html"}});
    return new Response(`<html><body style="margin:0"><iframe title="SNS Governance" sandbox="allow-scripts allow-same-origin" src="/frame" style="border:0;width:100vw;height:100vh"></iframe></body></html>`,{headers:{"content-type":"text/html"}});
  }});
  let browser: Browser | undefined;
  try{
    browser=await chromium.launch({headless:true,timeout:15_000,...await chromiumOptions()});
    const page=await browser.newPage({viewport:{width:480,height:900}}), crashes:string[]=[];
    page.on("pageerror",error=>crashes.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.port}`);
    const frame=page.frames().find(value=>value.parentFrame())!;
    await frame.getByRole("heading",{name:"My neurons",exact:true}).waitFor();
    await frame.locator(".snsgov-neuron-row").waitFor();
    await run(frame,page); expect(crashes).toEqual([]);
  }finally{
    try { await browser?.close(); }
    finally { server.stop(true); }
  }
}

test("personal neuron discovery distinguishes unavailable communities and preserves readable data on refresh",async()=>{
  await runBrowser(async (frame,page)=>{
    await frame.getByText("Neuron discovery is incomplete",{exact:false}).waitFor();
    await capture(page,"my-neurons");
    expect(await frame.locator(".snsgov-neuron-row").count()).toBe(1);
    await frame.evaluate(()=>{(globalThis as any).__failedCommunity=false;});
    await frame.getByRole("button",{name:"Retry unavailable communities"}).click();
    await frame.getByText("Neuron discovery is incomplete",{exact:false}).waitFor({state:"hidden"});
    expect(await frame.locator(".snsgov-neuron-row").count()).toBe(1);
    await frame.evaluate(()=>{(globalThis as any).__refreshFailure=true;});
    await frame.getByRole("button",{name:"Refresh neurons",exact:true}).click();
    await frame.getByText("Neuron discovery is incomplete",{exact:false}).waitFor();
    expect(await frame.locator(".snsgov-neuron-row").count()).toBe(1);
    expect(await frame.getByText("No connected neurons yet",{exact:false}).count()).toBe(0);
    await frame.getByRole("button",{name:"Connect existing neurons",exact:true}).click();
    await frame.getByRole("button",{name:"Copy Neutron principal"}).click();
    expect(await frame.getByText("Copying a principal does not grant any permissions.",{exact:false}).count()).toBe(1);
  });
},120_000);

test("shared Vote permission offers following without enabled custody actions",async()=>{
  await runBrowser(async frame=>{
    await frame.locator(".snsgov-neuron-open").click();
    await frame.getByRole("heading",{name:"Manage neuron",exact:true}).waitFor();
    expect(await frame.getByText("Connected neuron · Vote",{exact:true}).count()).toBe(1);
    expect(await frame.getByRole("button",{name:"Start unlocking",exact:true}).count()).toBe(0);
    expect(await frame.getByRole("button",{name:"Withdraw stake",exact:true}).count()).toBe(0);
    await frame.getByText("More management actions",{exact:true}).click();
    expect(await frame.getByRole("button",{name:"Follow by topic",exact:true}).isEnabled()).toBe(true);
    expect(await frame.getByRole("button",{name:"Transfer control",exact:true}).count()).toBe(0);
    await frame.getByRole("button",{name:"Go back",exact:true}).click();
    await frame.locator(".snsgov-neuron-row").waitFor();
    expect(await frame.evaluate(()=>document.activeElement?.getAttribute("data-neuron-id"))).toBe("11".repeat(32));
  });
},120_000);

test("public pagination retains earlier neurons on a failed next page and rejects stale filter responses",async()=>{
  await runBrowser(async frame=>{
    await frame.evaluate(()=>(globalThis as any).__neuronView("public"));
    await frame.getByRole("button",{name:"Load more neurons"}).waitFor();
    await frame.evaluate(()=>{(globalThis as any).__publicFailure=true;});
    await frame.getByRole("button",{name:"Load more neurons"}).click();
    await frame.getByRole("alert").filter({hasText:"Page unavailable"}).waitFor();
    expect(await frame.locator(".snsgov-neuron-row").count()).toBe(1);
    await frame.evaluate(()=>{(globalThis as any).__publicFailure=false;});
    await frame.getByRole("button",{name:"Load more neurons"}).click();
    await frame.waitForFunction(()=>document.querySelectorAll(".snsgov-neuron-row").length===2);
    const filter=frame.getByLabel("Filter by principal",{exact:true});
    await filter.fill("slow"); await filter.press("Enter");
    await frame.waitForFunction(()=>typeof(globalThis as any).__resolveSlow==="function");
    await filter.fill(""); await filter.press("Enter");
    await frame.locator(".snsgov-neuron-row").waitFor();
    await frame.evaluate(()=>(globalThis as any).__resolveSlow());
    await frame.waitForTimeout(50);
    expect(await frame.locator(".snsgov-neuron-row").textContent()).toContain("11111111");
    expect(await frame.locator(".snsgov-neuron-row").textContent()).not.toContain("33333333");
  });
},120_000);

test("staking preserves exact token atoms and operation recovery after an interrupted reply",async()=>{
  await runBrowser(async (frame,page)=>{
    await frame.getByRole("button",{name:"Stake tokens",exact:true}).click();
    await frame.getByLabel("Amount (TOKEN)",{exact:true}).waitFor();
    await frame.getByLabel("Amount (TOKEN)",{exact:true}).fill("1.00000001");
    await frame.getByLabel("Unlock delay",{exact:true}).fill("1");
    await frame.getByRole("button",{name:"Preview stake",exact:true}).click();
    await frame.getByRole("button",{name:"Continue to stake review"}).waitFor();
    await capture(page,"stake-dialog");
    const preview=await frame.evaluate(()=>(globalThis as any).__neuronCalls.find((call:any)=>call.name==="sns_stake_preview_v1"));
    expect(preview.args.amountAtoms).toBe("100000001"); expect(preview.args.dissolveDelaySeconds).toBe("86400");
    expect(await frame.evaluate(()=>(globalThis as any).__neuronCalls.filter((call:any)=>call.name==="sns_stake_v1").length)).toBe(0);
    await frame.evaluate(()=>{(globalThis as any).__operationFailure=true;});
    await frame.getByRole("button",{name:"Continue to stake review"}).click();
    await frame.getByRole("alert").filter({hasText:"Reply interrupted"}).waitFor();
    expect(await frame.getByRole("button",{name:"Continue to stake review"}).count()).toBe(0);
    await frame.evaluate(()=>{(globalThis as any).__operationFailure=false;});
    await frame.getByRole("button",{name:"Check saved status"}).click();
    await frame.getByText("Completed",{exact:true}).waitFor();
    expect(await frame.evaluate(()=>(globalThis as any).__neuronCalls.filter((call:any)=>call.name==="sns_stake_v1").length)).toBe(1);
    expect(await frame.evaluate(()=>(globalThis as any).__neuronCalls.find((call:any)=>call.name==="sns_stake_v1").args.operationId)).toBe(preview.args.operationId);
  });
},120_000);

test("all manage commands and capability forms remain usable in a narrow sandbox without forms",async()=>{
  await runBrowser(async(frame,page)=>{
    await frame.evaluate(()=>{(globalThis as any).__full=true;(globalThis as any).__neuronView("detail");});
    await frame.getByRole("button",{name:"Start unlocking",exact:true}).waitFor();
    for(const width of [320,480,960]){
      await page.setViewportSize({width,height:800});
      expect(await frame.locator(".snsgov-neuron-balance").textContent()).toContain("TOKEN");
      const layout=await frame.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.body.scrollWidth,clipped:[...document.querySelectorAll("button,input,select")].filter(element=>{const r=element.getBoundingClientRect();return r.width>0&&(r.left< -1||r.right>innerWidth+1);}).map(element=>element.textContent)}));
      expect(layout.scroll).toBeLessThanOrEqual(layout.width+1); expect(layout.clipped).toEqual([]);
      if (process.env.SNSGOV_UI_EVIDENCE_DIR) await page.screenshot({path:join(process.env.SNSGOV_UI_EVIDENCE_DIR, `neuron-detail-${width}.png`),fullPage:true});
    }
    await frame.getByRole("button",{name:"Increase unlock delay",exact:true}).click();
    await frame.getByLabel("Additional unlock delay",{exact:true}).fill("2");
    await frame.getByLabel("Additional unlock delay unit",{exact:true}).selectOption("2592000");
    await capture(page,"neuron-delay-dialog");
    await frame.getByRole("button",{name:"Preview change"}).click();
    await frame.getByRole("button",{name:"Continue to review",exact:true}).waitFor();
    const delayPreview=await frame.evaluate(()=>(globalThis as any).__neuronCalls.filter((call:any)=>call.name==="sns_preview_neuron_v1").at(-1));
    expect(delayPreview.args.command.Configure.operation.IncreaseDissolveDelay.additional_dissolve_delay_seconds).toBe("5184000");
    await frame.getByRole("button",{name:"Close",exact:true}).click();
    await frame.getByRole("button",{name:"Start unlocking",exact:true}).click();
    await capture(page,"neuron-management-dialog");
    await frame.getByRole("button",{name:"Preview change"}).click();
    await frame.getByRole("button",{name:"Continue to review",exact:true}).click();
    await frame.getByText("Completed",{exact:true}).waitFor();
    const manage=await frame.evaluate(()=>(globalThis as any).__neuronCalls.find((call:any)=>call.name==="sns_manage_neuron_v1"));
    expect(manage.args.command).toEqual({Configure:{operation:{StartDissolving:{}}}});
    await frame.getByRole("button",{name:"Close",exact:true}).click();
    await frame.getByText("More management actions",{exact:true}).click();
    await frame.getByRole("button",{name:"Follow by topic",exact:true}).click();
    await frame.getByLabel("Followee neuron IDs",{exact:true}).fill("22".repeat(32));
    await frame.getByRole("button",{name:"Preview change"}).click();
    await frame.getByRole("button",{name:"Continue to review",exact:true}).waitFor();
    const following=await frame.evaluate(()=>(globalThis as any).__neuronCalls.filter((call:any)=>call.name==="sns_preview_neuron_v1").at(-1));
    expect(following.args.command.SetFollowing.topic_following[0].followees[0].neuron_id.id).toEqual({hex:"22".repeat(32)});
    await frame.getByRole("button",{name:"Close",exact:true}).click();
    await frame.getByRole("button",{name:"Advanced command",exact:true}).click();
    expect(await frame.getByLabel("Command",{exact:true}).locator("option").count()).toBe(13);
    await frame.getByLabel("Command",{exact:true}).selectOption("ClaimOrRefresh");
    await frame.getByRole("button",{name:"Preview change"}).click();
    await frame.getByRole("button",{name:"Continue to review",exact:true}).waitFor();
    expect(await frame.locator("form").count()).toBe(0);
    expect(await frame.locator("button:not([type='button'])").count()).toBe(0);
  });
},120_000);

test("missing token metadata blocks financial preview without inventing a scale",async()=>{
  await runBrowser(async frame=>{
    await frame.evaluate(()=>{(globalThis as any).__metadataFailure=true;});
    await frame.getByRole("button",{name:"Stake tokens",exact:true}).click();
    await frame.getByRole("alert").filter({hasText:"Token metadata unavailable"}).waitFor();
    await frame.getByLabel("Amount",{exact:true}).fill("1");
    expect(await frame.getByRole("button",{name:"Preview stake",exact:true}).isDisabled()).toBe(true);
    expect(await frame.evaluate(()=>(globalThis as any).__neuronCalls.some((call:any)=>call.name==="sns_stake_preview_v1"))).toBe(false);
  });
},120_000);

async function capture(page:Page,name:string){
  if(!process.env.SNSGOV_UI_EVIDENCE_DIR)return;
  const previous=page.viewportSize();
  for(const width of [320,960]){await page.setViewportSize({width,height:800});await page.screenshot({path:join(process.env.SNSGOV_UI_EVIDENCE_DIR,`${name}-${width}.png`),fullPage:true});}
  if(previous)await page.setViewportSize(previous);
}

async function chromiumOptions():Promise<{executablePath?:string}>{
  if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)return{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE};
  let store:string[]=[];try{store=await readdir("/nix/store");}catch{}
  for(const executablePath of [...store.filter(name=>name.endsWith("-playwright-chromium")).sort().map(name=>join("/nix/store",name,"chrome-linux64","chrome")),"/run/current-system/sw/bin/google-chrome-stable","/usr/bin/google-chrome","/usr/bin/chromium"]){try{await access(executablePath,constants.X_OK);return{executablePath};}catch{}}
  return{};
}
