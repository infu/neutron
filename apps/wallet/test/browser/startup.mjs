/** Actual Wallet tile and tray startup with a private Kernel message port.
 * A failed initial read must show its error and permit a read-only retry. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const out=process.env.WALLET_STARTUP_BROWSER_ARTIFACTS||'/tmp/neutron-wallet-startup-browser';
const owner='3rurp-vyaaa-aaaay-aacua-cai',kernelOrigin=`https://${owner}.icp0.io`,appOrigin=`https://awalleta--${owner}.icp0.io`;
await mkdir(out,{recursive:true});
await build({absWorkingDir:root,entryPoints:['startup-fixture'],outfile:out+'/main.js',bundle:true,platform:'browser',format:'esm',jsx:'automatic',logLevel:'warning',plugins:[{name:'startup-entry',setup(b){
  b.onResolve({filter:/^startup-fixture$/},()=>({path:'entry',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'ts',resolveDir:root,contents:`import {mountWallet} from '${root}/apps/wallet/src/mount.tsx'; mountWallet(new URLSearchParams(location.search).get('surface')==='tray'?'tray':'tile'); parent.postMessage({fixtureReady:true},'*');`}));
  b.onLoad({filter:/\.scss$/},()=>({contents:'',loader:'css'}));
}}]});
const bundle=await readFile(out+'/main.js');
function kernelFixture({owner,appOrigin,failedRead}){
  const state=window.__startup={calls:[],errors:[],fail:true};
  addEventListener('message',event=>{
    const frame=document.getElementById('wallet');if(!event.data?.fixtureReady||event.source!==frame.contentWindow)return;
    const channel=new MessageChannel();channel.port1.onmessage=({data:message})=>{
      state.calls.push(message);let ok,error;
      try {
        if(message.type!=='neutron:self-call:exec')throw Error('Unexpected non-read route '+message.type);
        if(message.method==='wallet_read_v1'){
          const kind=Object.keys(message.args[0])[0];
          if(state.fail&&kind===failedRead)throw Error('Temporary Wallet '+kind+' read failure');
          ok={[kind]:kind==='snapshot'?{owner,configured:true,ledgers:[]}:[]};
        }else if(message.method==='wallet_transfers_pending_v2')ok=[];
        else throw Error('Unexpected backend method '+message.method);
      } catch(reason){error={name:'Error',message:reason.message};}
      channel.port1.postMessage({type:'neutron:self-call:response',version:1,id:message.id,...(error?{error}:{ok,blobs:[]})});
    };
    event.source.postMessage({type:'neutron:msgbus:connect',version:1,sessionId:'0123456789abcdef0123456789abcdef'},appOrigin,[channel.port2]);
  });
}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/run/current-system/sw/bin/google-chrome-stable',args:['--no-sandbox']});
const errors=[],checks=[];
try {
  for(const surface of ['tile','tray'])for(const failedRead of ['snapshot','catalog']){
    const page=await browser.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(String(error)));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin===kernelOrigin)await route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><script>(${kernelFixture.toString()})(${JSON.stringify({owner,appOrigin,failedRead})})</script><iframe id="wallet" src="${appOrigin}/app/wallet/index.html?app=wallet&tile=wallet&surface=${surface}"></iframe></body></html>`});
      else if(url.origin===appOrigin&&url.pathname==='/main.js')await route.fulfill({contentType:'text/javascript',body:bundle});
      else if(url.origin===appOrigin&&url.pathname==='/app/wallet/index.html')await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>'});
      else {errors.push('Unexpected network '+url);await route.abort();}
    });
    await page.goto(kernelOrigin);const wallet=page.frameLocator('#wallet');
    await wallet.getByRole('heading',{name:"Wallet couldn't load"}).waitFor();
    assert((await wallet.getByRole('alert').innerText()).includes(`Temporary Wallet ${failedRead} read failure`));
    assert.equal(await wallet.getByLabel('Loading Wallet',{exact:true}).count(),0);
    await page.evaluate(()=>window.__startup.fail=false);
    await wallet.getByRole('button',{name:'Retry',exact:true}).click();
    await wallet.getByRole('button',{name:'Assets',exact:true}).waitFor();
    assert.equal(await wallet.getByRole('button',{name:'Refill',exact:true}).count(),1);
    assert.equal(await wallet.getByRole('alert').count(),0);
    const calls=await page.evaluate(()=>window.__startup.calls);
    assert.equal(calls.filter(call=>call.method==='wallet_read_v1'&&failedRead in call.args[0]).length,2);
    assert(calls.every(call=>call.method==='wallet_read_v1'||call.method==='wallet_transfers_pending_v2'));
    checks.push(`${surface}: initial ${failedRead} failure shows its error, Retry reloads only reads, and Assets/Activity/Approvals/Refill navigation becomes available.`);await page.close();
  }
  assert.deepEqual(errors,[]);await writeFile(out+'/results.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
