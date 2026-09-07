/** Read-only Aave V3 production transport checks from a sandboxed opaque origin.
 * Deployments: https://github.com/aave-dao/aave-address-book/tree/main/src
 * These are the public Ethereum / Arbitrum endpoints configured in EVM Wallet.
 * No account connection, signing or transaction submission is performed.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const abi = parseAbi([
  'function getPool() view returns (address)',
  'function getReservesList() view returns (address[])',
  'function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
  'function getReserveTokensAddresses(address) view returns (address,address,address)',
  'function getWETHAddress() view returns (address)',
]);
const account = '0x1111111111111111111111111111111111111111';
const networks = [
  { name: 'Ethereum Core', chain: '0x1', url: 'https://ethereum-rpc.publicnode.com', provider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e', pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', dataProvider: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD', gateway: '0xd01607c3C5eCABa394D8be377a08590149325722', weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  { name: 'Arbitrum', chain: '0xa4b1', url: 'https://arbitrum-one-rpc.publicnode.com', provider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', dataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b', gateway: '0x5283BEcEd7ADF6D003225C13896E536f2D4264FF', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
].map(network => ({ ...network, calls: [
  { name: 'getPool', to: network.provider, data: encodeFunctionData({ abi, functionName: 'getPool' }) },
  { name: 'getReservesList', to: network.pool, data: encodeFunctionData({ abi, functionName: 'getReservesList' }) },
  { name: 'getUserAccountData', to: network.pool, data: encodeFunctionData({ abi, functionName: 'getUserAccountData', args: [account] }) },
  { name: 'getReserveTokensAddresses', to: network.dataProvider, data: encodeFunctionData({ abi, functionName: 'getReserveTokensAddresses', args: [network.weth] }) },
  { name: 'getWETHAddress', to: network.gateway, data: encodeFunctionData({ abi, functionName: 'getWETHAddress' }) },
] }));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/run/current-system/sw/bin/google-chrome-stable' });
try {
  const page = await browser.newPage();
  await page.setContent('<iframe sandbox="allow-scripts" srcdoc="<p>Read-only Aave transport check</p>"></iframe>');
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../src/markets.ts', import.meta.url))], bundle: true, write: false, format: 'iife', globalName: 'AaveLive', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  await frame.evaluate(source => { (0, eval)(source); }, bundle.outputFiles[0].text);
  const results = await frame.evaluate(async networks => Promise.all(networks.map(async network => {
    const rpc = async (method, params) => {
      const response = await fetch(network.url, { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!response.ok) throw Error(network.name + ': HTTP ' + response.status);
      const body = await response.json();
      if (body.error) throw Error(network.name + ': ' + body.error.message);
      return body.result;
    };
    const [chain, block] = await Promise.all([rpc('eth_chainId', []), rpc('eth_blockNumber', [])]);
    const calls = await Promise.all(network.calls.map(async call => ({ name: call.name, data: await rpc('eth_call', [{ from: '0x1111111111111111111111111111111111111111', to: call.to, data: call.data }, block]) })));
    const read = async (chainId, to, data, blockNumber) => {
      if (BigInt(chainId) !== BigInt(chain)) throw Error('App selected the wrong network');
      const tag = blockNumber === undefined ? block : '0x' + BigInt(blockNumber).toString(16);
      return { data: await rpc('eth_call', [{ from: '0x1111111111111111111111111111111111111111', to, data }, tag]), blockNumber: BigInt(tag).toString() };
    };
    const market = await globalThis.AaveLive.readMarket(read, BigInt(chain).toString(), '0x1111111111111111111111111111111111111111', { blockNumber: BigInt(block).toString() });
    return { name: network.name, chain, block, calls, appMarket: { reserveCount: market.reserves.length, eModeCount: market.eModes.length, errors: market.errors, blockNumber: market.blockNumber } };
  })), networks);
  for (let i = 0; i < results.length; i++) {
    const result = results[i], network = networks[i];
    assert.equal(result.chain, network.chain);
    const values = Object.fromEntries(result.calls.map(call => [call.name, decodeFunctionResult({ abi, functionName: call.name, data: call.data })]));
    assert.equal(values.getPool.toLowerCase(), network.pool.toLowerCase());
    assert(values.getReservesList.length > 10);
    assert(values.getReservesList.some(address => address.toLowerCase() === network.weth.toLowerCase()));
    assert.equal(values.getUserAccountData.length, 6);
    assert.notEqual(values.getReserveTokensAddresses[0], '0x0000000000000000000000000000000000000000');
    assert.notEqual(values.getReserveTokensAddresses[2], '0x0000000000000000000000000000000000000000');
    assert.equal(values.getWETHAddress.toLowerCase(), network.weth.toLowerCase());
    assert.equal(result.appMarket.reserveCount, values.getReservesList.length);
    assert.equal(result.appMarket.blockNumber, BigInt(result.block).toString());
    assert(result.appMarket.eModeCount > 0);
    assert.deepEqual(result.appMarket.errors, []);
    console.log(JSON.stringify({ origin: 'opaque sandbox', market: result.name, chain: result.chain, block: BigInt(result.block).toString(), reserveCount: values.getReservesList.length, providerPool: values.getPool, wethAToken: values.getReserveTokensAddresses[0], wethVariableDebtToken: values.getReserveTokensAddresses[2], gatewayWeth: values.getWETHAddress, appMarket: result.appMarket }));
  }
} finally { await browser.close(); }
