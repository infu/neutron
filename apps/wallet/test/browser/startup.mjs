/** Actual Wallet tile and tray startup with a private Kernel message port.
 * Reads are retryable; selected ledgers require exclusive access before their
 * connection is complete, using the existing reviewed Apply flow. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const out=process.env.WALLET_STARTUP_BROWSER_ARTIFACTS||'/tmp/neutron-wallet-startup-browser';
const owner='3rurp-vyaaa-aaaay-aacua-cai',kernelOrigin=`https://${owner}.icp0.io`,appOrigin=`https://awalleta--${owner}.icp0.io`;
const customLedger='rrkah-fqaaa-aaaaa-aaaaq-cai';
const accessNotice='Approve exclusive ledger access to finish connecting your selected assets.';
const exactReservations=['icrc1_metadata','icrc1_balance_of','icrc1_fee','icrc1_transfer','icrc2_allowance','icrc2_approve','icrc103_get_allowances','icrc3_get_blocks']
  .map(method=>({scopeKind:'exact',principal:customLedger,method}));
const principalReservation={scopeKind:'principal',principal:customLedger};
const cmcPrincipal='rkp4c-7iaaa-aaaaa-aaaca-cai';
const baseReservations=['ryjl3-tyaaa-aaaaa-aaaba-cai','um5iw-rqaaa-aaaaq-qaaba-cai',cmcPrincipal]
  .map(principal=>({scopeKind:'principal',principal}));
await mkdir(out,{recursive:true});
await build({absWorkingDir:root,entryPoints:['startup-fixture'],outfile:out+'/main.js',bundle:true,platform:'browser',format:'esm',jsx:'automatic',logLevel:'warning',plugins:[{name:'startup-entry',setup(b){
  b.onResolve({filter:/^startup-fixture$/},()=>({path:'entry',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'ts',resolveDir:root,contents:`import {mountWallet} from '${root}/apps/wallet/src/mount.tsx'; mountWallet(new URLSearchParams(location.search).get('surface')==='tray'?'tray':'tile'); parent.postMessage({fixtureReady:true},'*');`}));
  b.onLoad({filter:/\.scss$/},()=>({contents:'',loader:'css'}));
}}]});
const bundle=await readFile(out+'/main.js');
function kernelFixture({owner,appOrigin,failedRead,selected=[],reservations=[]}){
  const state=window.__startup={calls:[],errors:[],fail:failedRead!==null,selected,reservations,reviews:[],mutations:0};
  const snapshot=()=>({owner,configured:true,ledgers:state.selected.map((principal,id)=>({id:String(id),principal,name:'Custom token',symbol:'TEST'}))});
  const scopeKey=scope=>`${scope.scopeKind}:${scope.principal||''}:${scope.method||''}`;
  addEventListener('message',event=>{
    const frame=document.getElementById('wallet');if(!event.data?.fixtureReady||event.source!==frame.contentWindow)return;
    const channel=new MessageChannel();
    const reply=(message,ok,error)=>channel.port1.postMessage({
      type:message.type==='neutron:self-call:exec'?'neutron:self-call:response':'response',
      ...(message.type==='neutron:self-call:exec'?{version:1,...(error?{}:{blobs:[]})}:{}),id:message.id,...(error?{error}:{ok}),
    });
    const review=message=>{
      if(message.method!=='wallet_set_ledgers'||message.args.length!==1||JSON.stringify(message.args[0])!==JSON.stringify(state.selected))throw Error('Unexpected Wallet selection mutation');
      state.reviews.push(message);
      const dialog=document.createElement('dialog');dialog.open=true;
      const title=document.createElement('h2');title.textContent='Approve exclusive Wallet ledger access';
      const scopes=document.createElement('pre');scopes.textContent=JSON.stringify(message.actions);
      const approve=document.createElement('button');approve.textContent='Approve ledger access';
      const decline=document.createElement('button');decline.textContent='Decline ledger access';
      approve.onclick=()=>{
        for(const action of message.actions){
          const scope={scopeKind:action.scope.kind,...(action.scope.principal?{principal:action.scope.principal}:{}),...(action.scope.method?{method:action.scope.method}:{})};
          state.reservations=state.reservations.filter(current=>scopeKey(current)!==scopeKey(scope));
          if(action.kind==='reserve')state.reservations.push(scope);
        }
        state.mutations++;dialog.remove();reply(message,{callResult:snapshot()});
      };
      decline.onclick=()=>{
        dialog.remove();reply(message,null,{name:'KernelPolicyError',code:'REQUEST_CANCELLED',message:'Owner declined exclusive ledger access'});
      };
      dialog.append(title,scopes,approve,decline);document.body.append(dialog);
    };
    channel.port1.onmessage=({data:message})=>{
      state.calls.push(message);
      try {
        if(message.type==='neutron:self-call:exec'){
          if(message.tool==='backend_calls.request')return review(message);
          if(message.method==='wallet_read_v1'){
            const kind=Object.keys(message.args[0])[0];
            if(state.fail&&kind===failedRead)return reply(message,null,{name:'Error',message:`Temporary Wallet ${kind} read failure`});
            return reply(message,{[kind]:kind==='snapshot'?snapshot():[]});
          }
          if(message.method==='wallet_transfers_pending_v2')return reply(message,[]);
          throw Error('Unexpected backend method '+message.method);
        }
        if(message.type==='exec'){
          const {action,payload}=message.payload;
          if(action==='tools.call'&&payload.name==='backend_calls.list'){
            if(state.fail&&failedRead==='reservations')return reply(message,null,{name:'Error',message:'Temporary Wallet reservations read failure'});
            return reply(message,{reservations:state.reservations});
          }
          if(action==='app.state.publish')return reply(message,{});
          throw Error(`Unexpected Kernel route ${action} ${payload?.name||''}`);
        }
        throw Error('Unexpected message type '+message.type);
      }catch(reason){state.errors.push(String(reason));reply(message,null,{name:'Error',message:reason.message});}
    };
    event.source.postMessage({type:'neutron:msgbus:connect',version:1,sessionId:'0123456789abcdef0123456789abcdef'},appOrigin,[channel.port2]);
  });
}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/run/current-system/sw/bin/google-chrome-stable',args:['--no-sandbox']});
const errors=[],checks=[];
async function open({surface='tile',failedRead=null,selected=[],reservations=baseReservations}={}){
  const page=await browser.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin===kernelOrigin)await route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><script>(${kernelFixture.toString()})(${JSON.stringify({owner,appOrigin,failedRead,selected,reservations})})</script><iframe id="wallet" src="${appOrigin}/app/wallet/index.html?app=wallet&tile=wallet&surface=${surface}"></iframe></body></html>`});
    else if(url.origin===appOrigin&&url.pathname==='/main.js')await route.fulfill({contentType:'text/javascript',body:bundle});
    else if(url.origin===appOrigin&&url.pathname==='/app/wallet/index.html')await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>'});
    else {errors.push('Unexpected network '+url);await route.abort();}
  });
  await page.goto(kernelOrigin);return page;
}
const isReservationList=message=>message.type==='exec'&&message.payload.action==='tools.call'&&message.payload.payload.name==='backend_calls.list';
try {
  for(const surface of ['tile','tray'])for(const failedRead of ['snapshot','catalog']){
    const page=await open({surface,failedRead});const wallet=page.frameLocator('#wallet');
    await wallet.getByRole('heading',{name:"Wallet couldn't load"}).waitFor();
    const startupError=await wallet.getByRole('alert').innerText();
    assert(startupError.includes(`Temporary Wallet ${failedRead} read failure`),startupError);
    assert.equal(await wallet.getByLabel('Loading Wallet',{exact:true}).count(),0);
    await page.evaluate(()=>window.__startup.fail=false);
    await wallet.getByRole('button',{name:'Retry',exact:true}).click();
    await wallet.getByRole('button',{name:'Assets',exact:true}).waitFor();
    assert.equal(await wallet.getByRole('button',{name:'Refill',exact:true}).count(),1);
    assert.equal(await wallet.getByRole('alert').count(),0);
    const calls=await page.evaluate(()=>window.__startup.calls);
    assert.equal(calls.filter(call=>call.method==='wallet_read_v1'&&failedRead in call.args[0]).length,2);
    assert(calls.every(call=>call.method==='wallet_read_v1'||call.method==='wallet_transfers_pending_v2'));
    assert.deepEqual(await page.evaluate(()=>window.__startup.errors),[]);
    checks.push(`${surface}: initial ${failedRead} failure shows its error, Retry reloads only reads, and Assets/Activity/Approvals/Refill navigation becomes available.`);await page.close();
  }

  {
    const currentReservations=[...baseReservations,...exactReservations];
    const page=await open({selected:[customLedger],reservations:currentReservations});const wallet=page.frameLocator('#wallet');
    await wallet.getByRole('alert').filter({hasText:accessNotice}).waitFor();
    assert.equal(await wallet.getByRole('button',{name:'Assets',exact:true}).count(),0);
    assert.equal(await wallet.getByRole('button',{name:/^Send /}).count(),0);
    assert.equal(await wallet.getByRole('button',{name:/^Deposit /}).count(),0);
    assert.equal((await page.evaluate(()=>window.__startup)).reviews.length,0);
    await wallet.getByRole('button',{name:'Cancel',exact:true}).click();
    await wallet.getByRole('button',{name:'Review ledger access',exact:true}).waitFor();
    assert.equal(await wallet.getByRole('button',{name:'Assets',exact:true}).count(),0);
    assert.equal(await wallet.getByRole('button',{name:/^Send /}).count(),0);
    assert.equal(await wallet.getByRole('button',{name:/^Deposit /}).count(),0);
    assert.equal(await wallet.getByRole('alert').filter({hasText:accessNotice}).count(),1);
    await wallet.getByRole('button',{name:'Review ledger access',exact:true}).click();

    await wallet.getByRole('button',{name:'Apply',exact:true}).click();
    await page.getByRole('button',{name:'Decline ledger access',exact:true}).waitFor();
    let state=await page.evaluate(()=>window.__startup);
    assert.deepEqual(state.reviews[0].actions,[{kind:'reserve',scope:{kind:'principal',principal:customLedger}}]);
    assert.deepEqual(state.reviews[0].args,[[customLedger]]);
    assert.equal(state.mutations,0);assert.deepEqual(state.reservations,currentReservations);
    await page.getByRole('button',{name:'Decline ledger access',exact:true}).click();
    await wallet.getByRole('alert').filter({hasText:'Owner declined exclusive ledger access'}).waitFor();
    assert.equal(await wallet.getByRole('button',{name:'Assets',exact:true}).count(),0);
    state=await page.evaluate(()=>window.__startup);
    assert.equal(state.mutations,0);assert.deepEqual(state.reservations,currentReservations);

    await wallet.getByRole('button',{name:'Apply',exact:true}).click();
    await page.getByRole('button',{name:'Approve ledger access',exact:true}).click();
    await wallet.getByRole('button',{name:'Assets',exact:true}).waitFor();
    assert.equal(await wallet.getByRole('alert').count(),0);
    state=await page.evaluate(()=>window.__startup);
    assert.equal(state.mutations,1);assert.equal(state.reviews.length,2);
    assert.deepEqual(state.reviews[1].actions,[{kind:'reserve',scope:{kind:'principal',principal:customLedger}}]);
    assert.deepEqual(state.reservations,[...currentReservations,principalReservation]);assert.deepEqual(state.selected,[customLedger]);
    assert.deepEqual(state.errors,[]);
    checks.push('An already-selected custom token with exact-only grants requires access approval. Cancel shows a disconnected view, declined approval preserves grants and selection, and approved Apply reserves the principal before Assets opens.');
    await page.close();
  }

  for(const surface of ['tile','tray']){
    const page=await open({surface,selected:[customLedger],reservations:[...baseReservations,principalReservation]});const wallet=page.frameLocator('#wallet');
    await wallet.getByRole('button',{name:'Assets',exact:true}).waitFor();
    assert.equal(await wallet.getByRole('alert').count(),0);
    const state=await page.evaluate(()=>window.__startup);
    assert.equal(state.calls.filter(isReservationList).length,1);
    assert.equal(state.reviews.length,0);assert.equal(state.mutations,0);assert.deepEqual(state.errors,[]);
    checks.push(`${surface}: an existing principal reservation opens Assets directly after the read-only access check.`);
    await page.close();
  }

  {
    const page=await open({failedRead:'reservations',selected:[customLedger],reservations:[...baseReservations,principalReservation]});const wallet=page.frameLocator('#wallet');
    await wallet.getByRole('heading',{name:"Wallet couldn't load"}).waitFor();
    assert((await wallet.getByRole('alert').innerText()).includes('Temporary Wallet reservations read failure'));
    assert.equal(await wallet.getByRole('button',{name:'Assets',exact:true}).count(),0);
    await page.evaluate(()=>window.__startup.fail=false);
    await wallet.getByRole('button',{name:'Retry',exact:true}).click();
    await wallet.getByRole('button',{name:'Assets',exact:true}).waitFor();
    const state=await page.evaluate(()=>window.__startup);
    assert.equal(state.calls.filter(isReservationList).length,2);
    assert.equal(state.reviews.length,0);assert.equal(state.mutations,0);assert.deepEqual(state.errors,[]);
    checks.push('A failed reservation read leaves startup incomplete; Retry verifies existing exclusive access without requesting permission changes.');
    await page.close();
  }

  assert.deepEqual(errors,[]);await writeFile(out+'/results.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
