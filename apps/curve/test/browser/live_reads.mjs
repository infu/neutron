/** Read-only production endpoint checks from a sandboxed opaque browser origin. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi } from 'viem';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/run/current-system/sw/bin/google-chrome-stable'});
try {
  const page=await browser.newPage();
  await page.setContent('<iframe sandbox="allow-scripts" srcdoc="<p>Read-only Curve transport check</p>"></iframe>');
  const frame=page.frames().find(f=>f!==page.mainFrame());
  const requests=['ethereum','arbitrum'].flatMap(network=>['factory-stable-ng','factory-twocrypto','factory-tricrypto','main'].map(family=>({network,family,url:`https://api.curve.finance/api/getPools/${network}/${family}`})));
  const catalogs=await frame.evaluate(async requests=>Promise.all(requests.map(async request=>{const response=await fetch(request.url,{mode:'cors',credentials:'omit'});if(!response.ok)throw Error(request.url+': '+response.status);const body=await response.json();return {...request,success:body.success,pools:body.data?.poolData?.length};})),requests);
  for(const result of catalogs){assert.equal(result.success,true);assert(result.pools>0);}
  const abi=parseAbi(['function get_coins(address) view returns (address[])']);
  const networks=[{chain:'0x1',url:'https://ethereum-rpc.publicnode.com',factory:'0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf',pool:'0xD001aE433f254283FeCE51d4ACcE8c53263aa186'},{chain:'0xa4b1',url:'https://arbitrum-one-rpc.publicnode.com',factory:'0x9AF14D26075f142eb3F292D5065EB3faa646167b',pool:'0x186cF879186986A20aADFb7eAD50e3C20cb26CeC'}].map(network=>({...network,data:encodeFunctionData({abi,functionName:'get_coins',args:[network.pool]})}));
  const rpc=await frame.evaluate(async networks=>Promise.all(networks.map(async network=>{
    const call=async(method,params)=>{const response=await fetch(network.url,{method:'POST',mode:'cors',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(!response.ok)throw Error(network.url+': '+response.status);const body=await response.json();if(body.error)throw Error(body.error.message);return body.result;};
    const chain=await call('eth_chainId',[]),block=await call('eth_blockNumber',[]),coins=await call('eth_call',[{from:'0x1111111111111111111111111111111111111111',to:network.factory,data:network.data},block]);return {chain,expected:network.chain,block,coinBytes:(coins.length-2)/2};
  })),networks);
  for(const result of rpc){assert.equal(result.chain,result.expected);assert(result.coinBytes>=128);}
  console.log(JSON.stringify({origin:'opaque sandbox',catalogs:catalogs.map(({url,...row})=>row),rpc},null,2));
} finally {await browser.close();}
