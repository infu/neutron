import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root='/srv/shared/code/neutron', out='/tmp/neutron-ckwithdraw-ui-browser';
const require=createRequire(root+'/package.json');
const {build}=require('esbuild'),{sassPlugin}=require('esbuild-sass-plugin'),{chromium}=require('playwright');
const ledger='xevnm-gaaaa-aaaar-qafnq-cai',address='0x1111111111111111111111111111111111111111',direct='0x2222222222222222222222222222222222222222';
const mock=`
export {isJsonObject} from 'neutron-tools/protocol';
const ledger='${ledger}', minter='sv3dd-oaaaa-aaaar-qacoa-cai', gasLedger='ss2fx-dyaaa-aaaar-qacoq-cai', address='${address}';
const calls=[];let operation=null;
window.__calls=calls;window.__operation=()=>operation;
export function createMsgBusClient(){return{callTool:async request=>{calls.push({method:request.name,args:[request.arguments],target:request.target});if(request.name!=='evm_accounts_v1')throw new Error('Unexpected tool '+request.name);if(new URLSearchParams(location.search).has('accountError'))throw new Error('EVM account unavailable');return{accounts:[{accountId:'main',address,publicKey:'0x02'+'78'.repeat(32),keyFingerprint:'0x'+'ef'.repeat(32),namespaceVersion:'1'}]}}};}
export async function updateSelf(method,args){
 calls.push({method,args}); const input=args[0];
 if(method==='wallet_withdrawal_quote_v1'){
  const amount=input.amount??null, balance='20000000',fee='10000',budget='100000000000000',gasFee='2000000000000',gasBalance=new URLSearchParams(location.search).has('gasShort')?'0':'10000000000000000';
  return{ledger,minter,observed_at_ns:'1788746400000000000',amount,asset_fee:fee,asset_balance:balance,asset_allowance:amount,asset_total_debit:amount===null?null:(BigInt(amount)+BigInt(fee)).toString(),asset_sufficient:amount===null?null:BigInt(amount)+BigInt(fee)<=BigInt(balance),gas:{ledger:gasLedger,budget,ledger_fee:gasFee,allowance:budget,total_debit:(BigInt(budget)+BigInt(gasFee)).toString(),balance:gasBalance,sufficient:BigInt(gasBalance)>=BigInt(budget)+BigInt(gasFee)},authorization:{asset_fee:fee,gas:{ledger:gasLedger,minter,budget,ledger_fee:gasFee}}};
 }
 if(method==='wallet_ethereum_withdraw_prepare_v1'){
  operation={request_id:input.request_id,ledger:input.ledger,amount:input.amount,destination:input.address,status:{pending:null},message:'Withdrawal prepared',native:true,settlement:null};
  return operation;
 }
 if(method==='wallet_transfer_resume_v2'){
  if(!operation)throw new Error('Resume before prepare');
  if(Array.from(input).join()!==Array.from(operation.request_id).join())throw new Error('Wrong resume ID');
  operation={...operation,status:{succeeded:{duplicate:false,native:true,block_index:'10'}},message:'Withdrawal queued',settlement:{status:{pending:'Waiting for Ethereum settlement'}}};return operation;
 }
 if(method==='wallet_transfer_refresh_v2')return operation;
 throw new Error('Unexpected method '+method);
}
`;
const entry=`
import {createRoot} from 'react-dom/client';import {useState} from 'react';
import {WalletEthereumWithdrawal} from '${root}/apps/wallet/src/ethereum_withdrawal.tsx';
import '${root}/apps/wallet/src/style.scss';
const ledger={id:'ckusdc',principal:'${ledger}',name:'Chain-key USDC',symbol:'ckUSDC',decimals:6,fee:'10000',balance:'20000000',logo:null,metadataUpdatedAt:null,balanceUpdatedAt:null,metadataError:null,balanceError:null,nativeAddress:null,nativeAddressUpdatedAt:null,nativeAddressError:null,nativeRefreshUpdatedAt:null,nativeRefreshError:null,nativeDepositProgress:null};
function Harness(){const[mode,setMode]=useState('evm'),[operations,setOperations]=useState([]),[back,setBack]=useState(false);window.__setOperations=setOperations;window.__operations=operations;return <main className="nt-app wallet-app wallet-app--tile"><div className="wallet-shell">{back?<p>Back to tokens</p>:mode==='contacts'?<p>Contacts destination chooser</p>:<WalletEthereumWithdrawal ledger={ledger} mode={mode} onMode={setMode} onBack={()=>setBack(true)} onNetwork={()=>setBack(true)} operations={operations} onOperation={next=>setOperations(current=>[...current.filter(item=>item.requestId!==next.requestId),next])}/>}</div></main>};
createRoot(document.getElementById('root')).render(<Harness/>);
`;
await mkdir(out,{recursive:true});await writeFile(out+'/mock-app.ts',mock);await writeFile(out+'/entry.tsx',entry);
await build({absWorkingDir:root,stdin:{contents:entry,sourcefile:'withdrawal-qualification.tsx',loader:'tsx',resolveDir:root},outfile:out+'/main.js',bundle:true,platform:'browser',format:'esm',jsx:'automatic',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/^neutron-tools\/app$/},()=>({path:'app',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:mock,loader:'ts',resolveDir:root}));}},sassPlugin()],logLevel:'warning'});
const html='<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>';
const server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('content-type','text/html');return res.end(html)}const files={'/main.js':'application/javascript','/main.css':'text/css'};if(!files[pathname]){res.writeHead(404);return res.end()}res.setHeader('content-type',files[pathname]);res.end(await readFile(out+pathname))}catch(e){res.writeHead(500);res.end(String(e))}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:'/run/current-system/sw/bin/google-chrome-stable',headless:true,args:['--no-sandbox']});
const checks=[],bugs=[],errors=[],screenshots=[];
async function screen(page,name){const path=out+'/'+name+'.png';await page.screenshot({path,fullPage:true});screenshots.push(path)}
async function overflow(page,label){const m=await page.evaluate(()=>({width:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth,form:document.querySelector('.wallet-ethereum-withdrawal').getBoundingClientRect().toJSON(),amount:document.querySelector('[aria-label="Withdrawal amount"]').getBoundingClientRect().toJSON()}));assert(m.doc<=m.width+1,label+' document overflow '+JSON.stringify(m));assert(m.form.right<=m.width+1,label+' form outside viewport '+JSON.stringify(m));assert(m.amount.width>60,label+' amount input too narrow '+JSON.stringify(m));checks.push({label,...m})}
async function init(width,query=''){const page=await browser.newPage({viewport:{width,height:900}});page.on('pageerror',e=>errors.push(String(e)));await page.goto('http://127.0.0.1:'+server.address().port+'/'+query);await page.getByText('Approval fee',{exact:true}).first().waitFor();return page}
try{
 for(const width of [1440,375]){
  for(const mode of ['evm','address']){
   const page=await init(width);
   await page.locator('.wallet-ethereum-recipient code').filter({hasText:address}).waitFor();
   assert.equal(await page.getByRole('button',{name:'EVM Wallet',exact:true}).getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('details[open]').count(),0,'Advanced details not collapsed');
   assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.method.includes('contacts')).length),0,'Contact lookup required');
   if(mode==='address'){
    await page.getByRole('button',{name:'Ethereum address',exact:true}).click();
    await page.getByRole('textbox',{name:'Ethereum recipient address'}).fill('bad');
    assert(await page.getByRole('alert').filter({hasText:'Enter a valid Ethereum address'}).isVisible());
    assert(!(await page.getByRole('button',{name:'Withdraw ckUSDC',exact:true}).isEnabled()));
    await page.getByRole('textbox',{name:'Ethereum recipient address'}).fill(direct);
   }
   await page.getByRole('textbox',{name:'Withdrawal amount'}).fill('3');
   await page.waitForFunction(()=>!document.querySelector('button.nt-button')?.disabled);
   await overflow(page,width+' '+mode+' ready');await screen(page,width+'-'+mode+'-ready');
   const before=await page.evaluate(()=>window.__calls.filter(c=>c.method.includes('prepare')||c.method.includes('resume')).length);assert.equal(before,0,'Effects before Withdraw');
   await page.getByRole('button',{name:'Withdraw ckUSDC',exact:true}).click();
   await page.waitForFunction(()=>window.__calls.some(c=>c.method==='wallet_transfer_resume_v2')||[...document.querySelectorAll('[role="alert"]')].some(e=>e.textContent.includes('quote does not match')));
   const called=await page.evaluate(()=>window.__calls);
   if(!called.some(c=>c.method==='wallet_transfer_resume_v2')){bugs.push({width,mode,message:await page.locator('[role="alert"]').allTextContents(),calls:called});await screen(page,width+'-'+mode+'-submit-error');await page.close();continue}
   await page.getByText('On its way to Ethereum',{exact:true}).waitFor();
   const prep=called.filter(c=>c.method==='wallet_ethereum_withdraw_prepare_v1'),resume=called.filter(c=>c.method==='wallet_transfer_resume_v2');
   assert.equal(prep.length,1);assert.equal(resume.length,1);assert.equal(prep[0].args[0].address,mode==='evm'?address:direct);assert.equal(prep[0].args[0].amount,'3000000');
   assert.deepEqual(prep[0].args[0].request_id,resume[0].args[0]);
   await overflow(page,width+' '+mode+' pending');await screen(page,width+'-'+mode+'-pending');
   await page.evaluate(()=>{const op=window.__operations[0];window.__setOperations([{...op,settlement:{status:'confirmed',message:'Confirmed',transactionHash:'0x'+'ab'.repeat(32)}}])});
   await page.getByText('Withdrawal complete',{exact:true}).waitFor();
   assert(await page.getByRole('button',{name:'Done',exact:true}).isVisible());
   assert.equal(await page.getByRole('link',{name:'View on Etherscan'}).getAttribute('href'),'https://etherscan.io/tx/0x'+'ab'.repeat(32));
   await page.evaluate(()=>window.__setOperations([]));await page.waitForTimeout(50);assert(await page.getByText('Withdrawal complete',{exact:true}).isVisible(),'Cleared acknowledged journal removed terminal result');
   const end=await page.evaluate(()=>window.__calls);assert.equal(end.filter(c=>c.method==='wallet_ethereum_withdraw_prepare_v1').length,1);assert.equal(end.filter(c=>c.method==='wallet_transfer_resume_v2').length,1,'Automatic progress resent withdrawal');
   await overflow(page,width+' '+mode+' complete');await screen(page,width+'-'+mode+'-complete');await page.close();
  }
 }
 const fallback=await init(375,'?accountError');await fallback.getByRole('alert').filter({hasText:'EVM account unavailable'}).waitFor();await fallback.getByRole('button',{name:'Ethereum address',exact:true}).click();await fallback.getByRole('textbox',{name:'Ethereum recipient address'}).fill(direct);await fallback.getByRole('textbox',{name:'Withdrawal amount'}).fill('3');await fallback.waitForFunction(()=>!document.querySelector('button.nt-button')?.disabled);checks.push({label:'Direct address usable when EVM account unavailable'});await fallback.close();
 const gas=await init(375,'?gasShort');await gas.getByRole('textbox',{name:'Withdrawal amount'}).fill('3');await gas.getByRole('alert').filter({hasText:'cover Ethereum gas'}).waitFor();assert(!(await gas.getByRole('button',{name:'Withdraw ckUSDC',exact:true}).isEnabled()));checks.push({label:'Insufficient ckETH gas is visible and submission disabled'});await screen(gas,'375-insufficient-gas');await gas.close();
 assert.deepEqual(errors,[],'Runtime errors');
 const report={passed:bugs.length===0,checks,bugs,errors,screenshots,fixture:'Real WalletEthereumWithdrawal, EthereumWithdrawalController, format, quote parsing, shared EVM SDK, and app styles. Only Kernel self-calls and message bus transport mocked. Full index integration inspected separately.'};await writeFile(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(out+'/failure.json',JSON.stringify({error:String(error),checks,bugs,errors,screenshots},null,2));throw error}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
