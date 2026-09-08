/** Actual React UI, resident Aave service, descriptor validators and Wallet SDK.
 * Only Kernel transport/backend storage and chain observations are fixtures.
 * Every send must already exist in the durable journal. No signing or RPC. */
import { build } from 'esbuild';
import { sassPlugin } from 'esbuild-sass-plugin';
import { chromium } from 'playwright';
import { runProgressChecks } from './progress.mjs';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import icblast from 'icblast';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi, stringToHex } from 'viem';

const app = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = process.env.AAVE_BROWSER_ARTIFACTS || '/tmp/neutron-aave-browser';
await mkdir(artifacts, { recursive: true });
const schema = JSON.parse(await readFile(resolve(app, 'dist/schema.json'), 'utf8'));
const mock = `
import {normalizeToolDescriptor,validateToolArguments,validateToolResult} from 'neutron-tools/protocol';
const registered = new Map();
export function exposeTool(name,spec,handler) { registered.set(name,{spec:normalizeToolDescriptor({name,...spec}),handler}); }
export const querySelf = (name,args) => window.fixture('querySelf',[name,args]);
export const updateSelf = (name,args) => window.fixture('updateSelf',[name,args]);
export async function callTool(call,options) {
  if(call.target==='app:aave:background') {
    const tool=registered.get(call.name); if(!tool)throw Error('Tool missing: '+call.name);
    validateToolArguments(tool.spec,call.arguments);
    const context={caller:{appId:'aave',installationUid:'1',role:'tile'},agentMode:false,signal:options?.signal,reportProgress:()=>{},kernel:{callTool,querySelf,updateSelf}};
    const result=await tool.handler(call.arguments,context); validateToolResult(tool.spec,result); window.fixtureToolResults??={}; window.fixtureToolResults[call.name]=(window.fixtureToolResults[call.name]??0)+1; return result;
  }
  return window.fixture('callTool',[call]);
}`;
const bundle = await build({ absWorkingDir: app, stdin: { contents: 'import "./src/service.ts"; import "./src/main.tsx";', resolveDir: app, loader: 'ts' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', outdir: resolve(artifacts, 'build'), plugins: [
  { name: 'transport', setup(b) {
    b.onResolve({ filter: /^(?:neutron-tools\/app|\.{1,2}\/app_entry\.ts)$/ }, () => ({ path: 'mock', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mock, loader: 'js', resolveDir: app }));
  } }, sassPlugin(),
] });
const scripts = {
  '/main.js': bundle.outputFiles.find(f => f.path.endsWith('.js')).text,
  '/main.css': bundle.outputFiles.find(f => f.path.endsWith('.css')).text,
  '/static/icon.svg': await readFile(resolve(app, 'public/static/icon.svg'), 'utf8'),
};
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.svg') ? 'image/svg+xml' : req.url.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(scripts[req.url] ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/main.css"><div id="root"></div><script src="/main.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/run/current-system/sw/bin/google-chrome-stable' });
const account = { accountId: 'main', address: '0x1111111111111111111111111111111111111111', publicKey: '0x02' + '22'.repeat(32), keyFingerprint: '0x' + '33'.repeat(32), namespaceVersion: '1' };
const ZERO = '0x0000000000000000000000000000000000000000', MAX = (1n << 256n) - 1n, WAD = 10n ** 18n, UNIT = 10n ** 8n;
const networks = {
  '1': { pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', provider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e', oracle: '0x54586bE62E3c3580375aE3723C145253060Ca0C2', gateway: '0xd01607c3C5eCABa394D8be377a08590149325722', weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', native: 2n * WAD, eMode: 0, reward: 2500000n },
  '42161': { pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', provider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', oracle: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7', gateway: '0x5283BEcEd7ADF6D003225C13896E536f2D4264FF', weth: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', native: 3n * WAD, eMode: 0, reward: 2500000n },
};
const lower = value => value.toLowerCase();
const tokenId = (chainId, address) => chainId + ':' + lower(address);
const reserves = new Map();
for (const [chainId, network] of Object.entries(networks)) {
  const assets = [
    { id: 0, address: network.weth, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, price: 3000n * UNIT, wallet: 3n * WAD, supplied: 2n * WAD, debt: 0n },
    { id: 1, address: network.usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, price: UNIT, wallet: 1000n * 10n ** 6n, supplied: 1000n * 10n ** 6n, debt: 100n * 10n ** 6n },
  ];
  for (const asset of assets) reserves.set(tokenId(chainId, asset.address), {
    ...asset, chainId, collateral: true, ltv: 7500n, liquidation: 8000n,
    aToken: getAddress('0x' + (chainId === '1' ? 'a' : 'b') + String(asset.id + 1).padStart(39, '0')),
    debtToken: getAddress('0x' + (chainId === '1' ? 'c' : 'd') + String(asset.id + 1).padStart(39, '0')),
    liquidity: 1000000n * 10n ** BigInt(asset.decimals),
  });
}
const records = new Map(), operations = new Map(), transactions = new Map(), allowances = new Map(), delegations = new Map(), calls = [], sends = [];
let clock = 1n, mode = 'confirm', rpcFails = false, readGate = null, healthFactorOverride = null, nextAccountReadGate = null;
let lostStatusRequest = null;
let feeUnavailable = false, maxFeeGate = null, maxFeeObserved = null;
const ns = () => String(BigInt(Date.now()) * 1000000n);
const receipt = chainId => ({ blockNumber: chainId === '1' ? '25922608' : '502541974', blockHash: '0x' + '44'.repeat(32), status: 'success', gasUsed: '90000', effectiveGasPriceWei: '1000000000', logs: [], finality: 'included', observedAtNs: ns() });
const assetFor = (chainId, address) => {
  const asset = [...reserves.values()].find(asset => asset.chainId === chainId && [asset.address, asset.aToken, asset.debtToken].some(candidate => lower(candidate) === lower(address)));
  assert(asset, 'Unknown fixture token ' + chainId + ':' + address); return asset;
};
const position = chainId => {
  const assets = [...reserves.values()].filter(asset => asset.chainId === chainId);
  const collateral = assets.reduce((sum, asset) => sum + (asset.collateral ? asset.supplied * asset.price / 10n ** BigInt(asset.decimals) : 0n), 0n);
  const debt = assets.reduce((sum, asset) => sum + asset.debt * asset.price / 10n ** BigInt(asset.decimals), 0n);
  const weights = assets.reduce((weights, asset) => {
    const value = asset.collateral ? asset.supplied * asset.price / 10n ** BigInt(asset.decimals) : 0n;
    const enhanced = networks[chainId].eMode && asset.id === 1;
    return { ltv: weights.ltv + value * (enhanced ? 9000n : asset.ltv), threshold: weights.threshold + value * (enhanced ? 9300n : asset.liquidation) };
  }, { ltv: 0n, threshold: 0n });
  const capacity = weights.ltv / 10000n;
  return [collateral, debt, capacity > debt ? capacity - debt : 0n, collateral ? weights.threshold / collateral : 0n, collateral ? weights.ltv / collateral : 0n, healthFactorOverride ?? (debt ? weights.threshold * WAD / (10000n * debt) : MAX)];
};

// ABI observations and browser flows follow below. These independent fragments
// intentionally exercise ABI encoding/decoding through the actual Wallet SDK.
const single = signature => parseAbi([signature]);
const signatures = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])',
  'function getPool() view returns (address)',
  'function getPriceOracle() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function POOL() view returns (address)',
  'function getReservesList() view returns (address[])',
  'function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
  'function getUserEMode(address) view returns (uint256)',
  'function BASE_CURRENCY() view returns (address)',
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
  'function getReserveData(address) view returns (((uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
  'function getUserReserveData(address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40,bool)',
  'function getReserveTokensAddresses(address) view returns (address,address,address)',
  'function getVirtualUnderlyingBalance(address) view returns (uint128)',
  'function getDebtCeiling(address) view returns (uint256)',
  'function getSiloedBorrowing(address) view returns (bool)',
  'function getAssetPrice(address) view returns (uint256)',
  'function getEModeCategoryData(uint8) view returns ((uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus,address priceSource,string label))',
  'function getEModeCategoryCollateralBitmap(uint8) view returns (uint128)',
  'function getEModeCategoryBorrowableBitmap(uint8) view returns (uint128)',
  'function getEModeCategoryLtvzeroBitmap(uint8) view returns (uint128)',
  'function getIsEModeCategoryIsolated(uint8) view returns (bool)',
  'function getAllUserRewards(address[],address) view returns (address[],uint256[])',
  'function getWETHAddress() view returns (address)',
  'function WETH() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function borrowAllowance(address,address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
];
const views = parseAbi(signatures);
const dataProviderReserve = single('function getReserveData(address) view returns (uint256 unbacked,uint256 accruedToTreasuryScaled,uint256 totalAToken,uint256 totalStableDebt,uint256 totalVariableDebt,uint256 liquidityRate,uint256 variableBorrowRate,uint256 stableBorrowRate,uint256 averageStableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex,uint40 lastUpdateTimestamp)');
const effects = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function supply(address,uint256,address,uint16)',
  'function withdraw(address,uint256,address) returns (uint256)',
  'function borrow(address,uint256,uint256,uint16,address)',
  'function repay(address,uint256,uint256,address) returns (uint256)',
  'function repayWithATokens(address,uint256,uint256) returns (uint256)',
  'function setUserUseReserveAsCollateral(address,bool)',
  'function setUserEMode(uint8)',
  'function claimAllRewards(address[],address) returns (address[],uint256[])',
  'function depositETH(address,address,uint16) payable',
  'function withdrawETH(address,uint256,address)',
  'function borrowETH(address,uint256,uint16)',
  'function repayETH(address,uint256,address) payable',
  'function approveDelegation(address,uint256)',
]);
function observe(chainId, to, data) {
  const network = networks[chainId], decoded = decodeFunctionData({ abi: views, data }), args = decoded.args ?? [];
  let value, abi = views;
  const reserve = () => assetFor(chainId, args[0]);
  switch (decoded.functionName) {
    case 'aggregate3': value = args[0].map(call => {
      try { return { success: true, returnData: observe(chainId, call.target, call.callData) }; }
      catch (error) { if (!call.allowFailure) throw error; return { success: false, returnData: '0x' }; }
    }); break;
    case 'getPool': case 'POOL': value = getAddress(network.pool); break;
    case 'ADDRESSES_PROVIDER': value = getAddress(network.provider); break;
    case 'getPriceOracle': value = getAddress(network.oracle); break;
    case 'getPoolDataProvider': value = getAddress(chainId === '1' ? '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD' : '0x243Aa95cAC2a25651eda86e80bEe66114413c43b'); break;
    case 'getReservesList': value = [getAddress(network.weth), getAddress(network.usdc)]; break;
    case 'getUserAccountData': value = position(chainId); break;
    case 'getUserEMode': value = BigInt(network.eMode); break;
    case 'BASE_CURRENCY': value = ZERO; break;
    case 'BASE_CURRENCY_UNIT': value = UNIT; break;
    case 'getReserveData': {
      const asset = reserve(), ray = 10n ** 27n;
      if (lower(to) !== lower(network.pool)) {
        abi = dataProviderReserve;
        value = [0n, 0n, asset.liquidity + asset.debt, 0n, asset.debt, ray / 25n, ray / 20n, 0n, 0n, ray, ray, 1788739200];
      } else {
        const configuration = asset.ltv | (asset.liquidation << 16n) | (10500n << 32n) | (BigInt(asset.decimals) << 48n) | (1n << 56n) | (1n << 58n) | (1n << 61n);
        value = { configuration: { data: configuration }, liquidityIndex: ray, currentLiquidityRate: ray / 25n, variableBorrowIndex: ray, currentVariableBorrowRate: ray / 20n, currentStableBorrowRate: 0n, lastUpdateTimestamp: 1788739200, id: asset.id, aTokenAddress: asset.aToken, stableDebtTokenAddress: ZERO, variableDebtTokenAddress: asset.debtToken, interestRateStrategyAddress: ZERO, accruedToTreasury: 0n, unbacked: 0n, isolationModeTotalDebt: 0n };
      }
      break;
    }
    case 'getUserReserveData': { const asset = reserve(); value = [asset.supplied, 0n, asset.debt, 0n, asset.debt, 0n, 10n ** 27n / 25n, 1788739200, asset.collateral]; break; }
    case 'getReserveTokensAddresses': { const asset = reserve(); value = [asset.aToken, ZERO, asset.debtToken]; break; }
    case 'getVirtualUnderlyingBalance': value = reserve().liquidity; break;
    case 'getDebtCeiling': value = 0n; break;
    case 'getSiloedBorrowing': value = false; break;
    case 'getAssetPrice': value = reserve().price; break;
    case 'getEModeCategoryData': value = { ltv: Number(args[0]) === 1 ? 9000 : 0, liquidationThreshold: Number(args[0]) === 1 ? 9300 : 0, liquidationBonus: Number(args[0]) === 1 ? 10100 : 0, priceSource: ZERO, label: Number(args[0]) === 1 ? 'Stablecoins' : '' }; break;
    case 'getEModeCategoryCollateralBitmap': case 'getEModeCategoryBorrowableBitmap': value = 2n; break;
    case 'getEModeCategoryLtvzeroBitmap': value = 0n; break;
    case 'getIsEModeCategoryIsolated': value = false; break;
    case 'getAllUserRewards': value = network.reward ? [[getAddress(network.usdc)], [network.reward]] : [[], []]; break;
    case 'getWETHAddress': case 'WETH': value = getAddress(network.weth); break;
    case 'balanceOf': {
      const asset = assetFor(chainId, to);
      value = lower(to) === lower(asset.aToken) ? asset.supplied : lower(to) === lower(asset.debtToken) ? asset.debt : lower(args[0]) === lower(asset.aToken) ? asset.liquidity : asset.wallet;
      break;
    }
    case 'allowance': value = allowances.get(tokenId(chainId, to) + ':' + lower(args[1])) ?? 0n; break;
    case 'borrowAllowance': value = delegations.get(tokenId(chainId, to) + ':' + lower(args[1])) ?? 0n; break;
    case 'symbol': value = assetFor(chainId, to).symbol; break;
    case 'name': value = assetFor(chainId, to).name; break;
    case 'decimals': value = assetFor(chainId, to).decimals; break;
    default: throw Error('Unimplemented chain observation ' + decoded.functionName);
  }
  return encodeFunctionResult({ abi, functionName: decoded.functionName, result: value });
}
function applyEffect(input) {
  const network = networks[input.chainId], decoded = decodeFunctionData({ abi: effects, data: input.data }), args = decoded.args;
  const native = ['depositETH', 'withdrawETH', 'borrowETH', 'repayETH'].includes(decoded.functionName);
  if (native) {
    assert.equal(lower(input.to), lower(network.gateway), 'Native effects use the exact gateway on the selected chain');
    assert.equal(lower(args[0]), lower(network.pool), 'Gateway parameters retain the selected Pool');
  } else if (['supply', 'withdraw', 'borrow', 'repay', 'repayWithATokens', 'setUserUseReserveAsCollateral', 'setUserEMode'].includes(decoded.functionName)) {
    assert.equal(lower(input.to), lower(network.pool), 'Lending effects use the selected Aave Pool');
    assert.equal(input.valueWei, '0');
  } else if (decoded.functionName === 'claimAllRewards') {
    assert.equal(lower(input.to), lower(input.chainId === '1' ? '0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb' : '0x929EC64c34a17401F460460D4B9390518E5B473e'));
  }
  const recipientIndex = { supply: 2, withdraw: 2, borrow: 4, repay: 3, depositETH: 1, withdrawETH: 2, repayETH: 2, claimAllRewards: 1 }[decoded.functionName];
  if (recipientIndex !== undefined) assert.equal(lower(args[recipientIndex]), lower(account.address), 'Aave effects retain the signing account as recipient and debt owner');
  const amount = (asset, value, kind) => value === MAX ? kind === 'debt' ? asset.debt : asset.supplied : value;
  const spendAllowance = (token, spender, atoms, delegation = false) => {
    const map = delegation ? delegations : allowances, key = tokenId(input.chainId, token) + ':' + lower(spender), available = map.get(key) ?? 0n;
    assert(available >= atoms, 'The previous approval must confirm before its dependent action');
    if (available !== MAX) map.set(key, available - atoms);
  };
  switch (decoded.functionName) {
    case 'approve': allowances.set(tokenId(input.chainId, input.to) + ':' + lower(args[0]), args[1]); break;
    case 'approveDelegation': delegations.set(tokenId(input.chainId, input.to) + ':' + lower(args[0]), args[1]); break;
    case 'supply': { const asset = assetFor(input.chainId, args[0]); spendAllowance(asset.address, network.pool, args[1]); asset.wallet -= args[1]; asset.supplied += args[1]; break; }
    case 'withdraw': { const asset = assetFor(input.chainId, args[0]), atoms = amount(asset, args[1], 'supplied'); asset.supplied -= atoms; asset.wallet += atoms; break; }
    case 'borrow': { const asset = assetFor(input.chainId, args[0]); asset.debt += args[1]; asset.wallet += args[1]; break; }
    case 'repay': case 'repayWithATokens': {
      const asset = assetFor(input.chainId, args[0]), atoms = amount(asset, args[1], 'debt');
      asset.debt -= atoms; if (decoded.functionName === 'repay') { spendAllowance(asset.address, network.pool, atoms); asset.wallet -= atoms; } else asset.supplied -= atoms; break;
    }
    case 'depositETH': { const asset = assetFor(input.chainId, network.weth), atoms = BigInt(input.valueWei); asset.supplied += atoms; network.native -= atoms; break; }
    case 'withdrawETH': { const asset = assetFor(input.chainId, network.weth), atoms = amount(asset, args[1], 'supplied'); spendAllowance(asset.aToken, network.gateway, atoms); asset.supplied -= atoms; network.native += atoms; break; }
    case 'borrowETH': { const asset = assetFor(input.chainId, network.weth); spendAllowance(asset.debtToken, network.gateway, args[1], true); asset.debt += args[1]; network.native += args[1]; break; }
    case 'repayETH': { const asset = assetFor(input.chainId, network.weth), atoms = args[1] > asset.debt ? asset.debt : args[1]; asset.debt -= atoms; network.native -= atoms; break; }
    case 'setUserUseReserveAsCollateral': assetFor(input.chainId, args[0]).collateral = args[1]; break;
    case 'setUserEMode': network.eMode = Number(args[0]); break;
    case 'claimAllRewards': assetFor(input.chainId, network.usdc).wallet += network.reward; network.reward = 0n; break;
    default: throw Error('Unknown effect ' + decoded.functionName);
  }
}
async function fixture(kind, [call, args]) {
  calls.push({ kind, call: structuredClone(call), args: structuredClone(args) });
  if (kind === 'querySelf' || kind === 'updateSelf') {
    const method = schema.methods[call]; assert(method, 'Missing backend schema: ' + call);
    const validation = icblast.validateMethodInputSchema(method, args); assert(validation.ok, call + ' input: ' + JSON.stringify(validation.errors));
    const input = args[0]; let value;
    if (call === 'aave_get_v1') value = records.get(input) ?? null;
    else if (call === 'aave_page_v1') {
      const all = [...records.values()].filter(row => row.id === row.root_id).sort((a, b) => BigInt(a.created_at) > BigInt(b.created_at) ? -1 : 1);
      const start = input.cursor ? all.findIndex(row => row.id === input.cursor) + 1 : 0, rows = all.slice(start, start + Number(input.limit));
      value = { rows: rows.map(({ root_id, input_json, state_json, ...summary }) => summary), ...(start + rows.length < all.length ? { next_cursor: rows.at(-1).id } : {}) };
    } else if (call === 'aave_begin_v1') {
      value = records.get(input.id);
      if (value) { assert.equal(input.input_json, value.input_json); assert.equal(input.summary, value.summary); }
      else { value = { ...input, revision: '0', created_at: String(clock++), updated_at: ns() }; records.set(value.id, value); }
    } else if (call === 'aave_update_v1') {
      const prior = records.get(input.id); assert(prior);
      if (prior.phase === input.phase && prior.state_json === input.state_json) value = prior;
      else { assert.equal(prior.revision, input.expected_revision); value = { ...prior, state_json: input.state_json, phase: input.phase, revision: String(BigInt(prior.revision) + 1n), updated_at: ns() }; records.set(value.id, value); }
    } else throw Error(call);
    const validationOut = icblast.validateMethodInputSchema({ input: method.output }, value); assert(validationOut.ok, call + ' output: ' + JSON.stringify(validationOut.errors));
    return structuredClone(value);
  }
  const { name, arguments: input } = call; assert.equal(call.target, 'app:evm_wallet:background');
  const network = networks[input.chainId], blockNumber = input.chainId === '42161' ? '502541973' : '25922607';
  if (name === 'evm_accounts_v1') { const gate = nextAccountReadGate; nextAccountReadGate = null; if (gate) await gate; return { accounts: [account] }; }
  if (name === 'evm_wallet_prices_v1') return { source: 'defillama', prices: input.assets.map(asset => ({ ...asset, priceUsd: asset.address === null ? 3000 : Number(assetFor(asset.chainId, asset.address).price) / Number(UNIT), observedAtMs: Date.now(), fetchedAtMs: Date.now(), status: 'available', basis: 'market', sourceId: 'fixture', error: null })) };
  if (name === 'evm_balances_v1') return { ...input, tokens: input.tokens.map(address => {
    const asset = assetFor(input.chainId, address); return { address, balanceAtoms: String(asset.wallet), decimals: String(asset.decimals), symbol: asset.symbol, error: null };
  }), address: account.address, nativeBalanceWei: String(network.native), blockNumber, observedAtNs: ns(), completeness: 'requested_only' };
  if (name === 'evm_call_contract_v1') {
    if (readGate) await readGate;
    if (rpcFails) throw Error('RPC is temporarily unavailable. Try again.');
    const { blockTag, ...request } = input;
    const isSimulation = effects.some(item => item.type === 'function' && keccak256(stringToHex(item.name + '(' + item.inputs.map(input => input.type).join(',') + ')')).slice(0, 10) === input.data.slice(0, 10));
    let result;
    if (isSimulation) {
      const decoded = decodeFunctionData({ abi: effects, data: input.data });
      const returningAmount = ['withdraw', 'repay', 'repayWithATokens'].includes(decoded.functionName);
      result = encodeFunctionResult({ abi: effects, functionName: decoded.functionName, result: returningAmount ? decoded.args[1] : decoded.functionName === 'claimAllRewards' ? [[], []] : decoded.functionName === 'approve' ? true : undefined });
    } else result = observe(input.chainId, input.to, input.data);
    return { ...request, address: account.address, result, blockNumber, observedAtNs: ns() };
  }
  if (name === 'evm_estimate_transaction_v1') {
    if (feeUnavailable) throw Error('Fixture fee observation unavailable');
    if (input.valueWei === String(network.native)) { maxFeeObserved?.(); if (maxFeeGate) await maxFeeGate; }
    return { ...input, address: account.address, status: 'available', gasLimit: '100000', gasPriceWei: '1000000000', baseFeePerGasWei: '900000000', maxPriorityFeePerGasWei: '100000000', maxFeePerGasWei: '2000000000', estimatedFeeWei: '100000000000000', maximumFeeWei: '200000000000000', blockNumber, observedAtNs: ns(), feeBasis: input.chainId === '42161' ? 'arbitrum_total_gas' : 'base_fee_plus_priority', postingCosts: input.chainId === '42161' ? 'included' : 'not_applicable', reasons: [], source: 'evm_rpc' };
  }
  if (name === 'evm_operation_status_v1') {
    if (lostStatusRequest === input.requestId) { lostStatusRequest = null; throw Error('Wallet status observation unavailable after lost reply'); }
    return operations.get(input.requestId) ?? { ...input, status: 'not_found' };
  }
  if (name === 'evm_transaction_v1') return transactions.get(input.transactionHash);
  if (name === 'evm_send_transaction_v1') {
    const prior = operations.get(input.requestId); if (prior) return prior;
    assert([...records.values()].some(row => JSON.parse(row.state_json).steps.some(step => step.request.requestId === input.requestId && step.dispatched && step.unresolved)), 'Wallet dispatch must be recorded before sending');
    sends.push(structuredClone(input));
    const hash = keccak256(stringToHex(input.requestId)), mined = mode !== 'hold', block = String(BigInt(blockNumber) + 1n);
    const operation = { accountId: input.accountId, chainId: input.chainId, requestId: input.requestId, operationId: String(sends.length), kind: 'transaction', status: mined ? 'confirmed' : 'submitted', address: account.address, transactionHash: hash, signature: null, reviewRevision: '1', message: null, receipt: mined ? receipt(input.chainId) : null };
    operations.set(input.requestId, operation);
    transactions.set(hash, { chainId: input.chainId, transactionHash: hash, walletRequestMatches: null, transaction: { from: account.address, to: input.to, valueWei: input.valueWei, data: input.data, nonce: String(sends.length - 1), blockNumber: mined ? block : null, blockHash: mined ? '0x' + '44'.repeat(32) : null }, receipt: operation.receipt, observedAtNs: ns(), source: 'evm_rpc' });
    if (mined) applyEffect(input);
    if (mode === 'lost' || mode === 'lost_status') {
      if (mode === 'lost_status') lostStatusRequest = input.requestId;
      mode = 'confirm'; throw Error('Wallet reply lost after broadcast');
    }
    return operation;
  }
  throw Error('Unimplemented Wallet call ' + name);
}
const errors = []; let fixturePage;
const functionOf = input => decodeFunctionData({ abi: effects, data: input.data }).functionName;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  fixturePage = page;
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fixture', fixture);
  // Trigger the app's actual refresh callbacks without a 30-second test sleep.
  await page.addInitScript(() => {
    const repeat = window.setInterval.bind(window), stop = window.clearInterval.bind(window), polls = new Map();
    window.setInterval = (callback, delay, ...args) => {
      const id = repeat(callback, delay, ...args);
      if (delay === 30000) polls.set(id, () => callback(...args));
      return id;
    };
    window.clearInterval = id => { polls.delete(id); stop(id); };
    window.fixturePoll = () => { for (const poll of [...polls.values()]) poll(); };
  });
  // Any accidental live RPC/API call fails qualification; observations are
  // supplied only by the exact Wallet transport described above.
  await page.route('https://**', route => route.abort('blockedbyclient'));
  let releaseRead;
  readGate = new Promise(resolve => { releaseRead = resolve; });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('status').filter({ hasText: /market|Aave|position|loading/i }).first().waitFor();
  await page.screenshot({ path: resolve(artifacts, 'loading-desktop.png'), fullPage: true });
  readGate = null; releaseRead();
  await page.getByRole('button', { name: 'Supply USDC', exact: true }).first().waitFor();
  await page.getByText('Health factor', { exact: true }).first().waitFor();
  await page.screenshot({ path: resolve(artifacts, 'position-desktop.png'), fullPage: true });

  // Price failure must not retain a plausible borrowing-capacity total, and
  // rounding must not hide that a position is below the liquidation threshold.
  const pricedWeth = assetFor('1', networks['1'].weth), originalPrice = pricedWeth.price;
  pricedWeth.price = 0n;
  await page.getByRole('button', { name: 'Refresh wallet and markets', exact: true }).click();
  await page.getByText(/Oracle prices are unavailable for WETH/).waitFor();
  assert.equal(await page.locator('.av-stat').filter({ hasText: 'Available to borrow' }).locator('strong').innerText(), 'Unavailable');
  await page.getByRole('button', { name: 'Borrow USDC', exact: true }).first().click();
  const unpricedDialog = page.locator('dialog[open]');
  await unpricedDialog.getByText('Available: Unavailable', { exact: true }).waitFor();
  assert(await unpricedDialog.locator('.av-presets button').evaluateAll(buttons => buttons.length === 4 && buttons.every(button => button.disabled)), 'Unknown borrowing capacity cannot populate percentage or Max amounts');
  assert(await unpricedDialog.getByLabel('Borrow amount', { exact: true }).isEnabled(), 'Oracle failure does not disable manual amount entry');
  await unpricedDialog.getByLabel('Borrow amount', { exact: true }).fill('1');
  await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === 'Review borrow' && !button.disabled));
  await page.keyboard.press('Escape');
  pricedWeth.price = originalPrice;
  healthFactorOverride = 999n * 10n ** 15n;
  await page.getByRole('button', { name: 'Refresh wallet and markets', exact: true }).click();
  await page.getByText('< 1.00', { exact: true }).waitFor();
  assert(await page.locator('.av-health-value').evaluate(element => element.classList.contains('av-warning')));
  healthFactorOverride = null;
  await page.getByRole('button', { name: 'Refresh wallet and markets', exact: true }).click();
  await page.getByText('< 1.00', { exact: true }).waitFor({ state: 'hidden' });

  const dialog = () => page.locator('dialog[open]');
  const openAction = async (kind, symbol) => {
    await page.getByRole('button', { name: `${kind} ${symbol}`, exact: true }).first().click();
    await dialog().getByLabel(`${kind} amount`, { exact: true }).waitFor();
  };
  const waitReview = async kind => {
    const button = dialog().getByRole('button', { name: `Review ${kind}`, exact: true });
    await button.waitFor(); await page.waitForFunction(label => [...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === label && !button.disabled), `Review ${kind}`);
    return button;
  };
  const finish = async kind => {
    await (await waitReview(kind)).click();
    await page.getByText('Confirmed. The final transaction completed successfully.', { exact: true }).waitFor();
  };

  // Wallet identity can change while the independent account header read is
  // still pending. Fresh balances, market data and quotes must remain scoped
  // to the displayed account until the new identity is known.
  await openAction('Supply', 'USDC');
  await dialog().getByLabel('Supply amount', { exact: true }).fill('1');
  await waitReview('supply');
  const originalAccount = structuredClone(account), originalNative = networks['1'].native;
  const originalHealth = await page.locator('.av-health-value').innerText();
  const originalWalletBalance = await page.locator('.av-wallet .av-right').innerText();
  const completedMarketReads = await page.evaluate(() => window.fixtureToolResults.aave_markets_v1);
  const completedQuoteReads = await page.evaluate(() => window.fixtureToolResults.aave_quote_v1);
  let releaseAccount;
  nextAccountReadGate = new Promise(resolve => { releaseAccount = resolve; });
  account.address = '0x3333333333333333333333333333333333333333';
  account.keyFingerprint = '0x' + '55'.repeat(32);
  networks['1'].native = 4n * WAD;
  healthFactorOverride = 42n * WAD;
  // A manual refresh races all three reads in the same way as a poll.
  await page.getByRole('button', { name: 'Refresh wallet and markets', exact: true }).evaluate(element => element.click());
  await page.waitForFunction(([market, quote]) => window.fixtureToolResults.aave_markets_v1 > market && window.fixtureToolResults.aave_quote_v1 > quote, [completedMarketReads, completedQuoteReads]);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.av-wallet a').getAttribute('title'), originalAccount.address);
  assert.equal(await page.locator('.av-wallet .av-right').innerText(), originalWalletBalance, 'New-account native balance cannot appear under the old account header');
  assert.equal(await page.locator('.av-health-value').innerText(), originalHealth, 'New-account positions cannot appear under the old account header');
  assert(await dialog().getByRole('button', { name: 'Review supply', exact: true }).isDisabled(), 'A quote for another wallet cannot enable review');
  releaseAccount();
  await page.locator(`.av-wallet a[title="${account.address}"]`).waitFor();
  await dialog().waitFor({ state: 'hidden' });
  await page.getByText('42.00', { exact: true }).waitFor();
  assert.equal(await page.locator('.av-wallet .av-right').innerText(), '4 ETH');
  assert.equal(sends.length, 0, 'Changing account does not dispatch the previously open action');
  // Switching back through the periodic refresh must also update the account
  // header; previously only the market and balance reads were polled.
  Object.assign(account, originalAccount);
  networks['1'].native = originalNative;
  healthFactorOverride = null;
  await page.evaluate(() => window.fixturePoll());
  await page.locator(`.av-wallet a[title="${account.address}"]`).waitFor();
  await page.getByText('42.00', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Supply USDC', exact: true }).first().waitFor();

  // Native Max sizes an exact read-only candidate from an empty draft and
  // retains the maximum observed signing fee, not the lower estimated fee.
  await openAction('Supply', 'WETH');
  await dialog().getByLabel('Use native ETH', { exact: true }).check();
  await dialog().getByRole('button', { name: 'Max', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Supply amount"]').value === '1.9998');
  await waitReview('supply');
  assert.equal(sends.length, 0, 'Choosing Max is read-only');
  feeUnavailable = true;
  await dialog().getByLabel('Supply amount', { exact: true }).fill('0.123');
  await dialog().getByRole('button', { name: 'Max', exact: true }).click();
  await dialog().getByRole('alert').filter({ hasText: 'Max unavailable.' }).waitFor();
  assert.equal(await dialog().getByLabel('Supply amount', { exact: true }).inputValue(), '0.123', 'Failed Max estimate preserves a manually entered amount');
  feeUnavailable = false;
  let releaseMaxFee;
  maxFeeGate = new Promise(resolve => { releaseMaxFee = resolve; });
  const maxFeeStarted = new Promise(resolve => { maxFeeObserved = resolve; });
  await dialog().getByRole('button', { name: 'Max', exact: true }).click();
  await maxFeeStarted;
  await dialog().getByLabel('Supply amount', { exact: true }).fill('0.456');
  releaseMaxFee(); maxFeeGate = null; maxFeeObserved = null;
  await dialog().getByRole('button', { name: 'Max', exact: true }).waitFor();
  assert.equal(await dialog().getByLabel('Supply amount', { exact: true }).inputValue(), '0.456', 'A stale Max reply cannot overwrite a newer manual amount');
  assert.equal(sends.length, 0, 'Max estimation never dispatches a transaction');
  await page.keyboard.press('Escape');

  // Native ETH supply consumes no ERC20 approval, while six-decimal USDC
  // supply persists and confirms the exact allowance before its lending call.
  await openAction('Supply', 'WETH');
  await dialog().getByLabel('Use native ETH', { exact: true }).check();
  await dialog().getByLabel('Supply amount', { exact: true }).fill('0.1');
  await waitReview('supply');
  await page.screenshot({ path: resolve(artifacts, 'supply-native-desktop.png'), fullPage: false });
  await finish('supply');
  assert.equal(sends.length, 1); assert.equal(functionOf(sends[0]), 'depositETH'); assert.equal(sends[0].valueWei, '100000000000000000');
  // A mined transaction can lose its receipt during a reorganization. Keep
  // reconciliation reachable even after the UI has shown Confirmed.
  const completedHash = operations.get(sends[0].requestId).transactionHash;
  const completedObservation = structuredClone(transactions.get(completedHash));
  transactions.set(completedHash, { ...completedObservation, transaction: { ...completedObservation.transaction, blockNumber: null, blockHash: null }, receipt: null });
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await page.locator('.av-progress.av-pending').waitFor();
  assert.equal(sends.length, 1, 'Read-only reconciliation does not resend the lending action');
  transactions.set(completedHash, completedObservation);
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await page.locator('.av-progress.av-complete').waitFor();
  assert.equal(sends.length, 1, 'A recovered receipt confirms the original transaction');
  await openAction('Supply', 'USDC');
  await dialog().getByLabel('Supply amount', { exact: true }).fill('12.345678');
  let start = sends.length; await finish('supply');
  assert.deepEqual(sends.slice(start).map(functionOf), ['approve', 'supply']);
  const supplyArgs = decodeFunctionData({ abi: effects, data: sends.at(-1).data }).args;
  assert.equal(supplyArgs[1], 12345678n, 'USDC decimal precision must remain exact');
  assert.equal(lower(supplyArgs[0]), networks['1'].usdc);

  await page.getByRole('button', { name: 'Markets', exact: true }).click();
  await page.getByRole('button', { name: 'Borrow USDC', exact: true }).first().waitFor();
  await page.screenshot({ path: resolve(artifacts, 'markets-desktop.png'), fullPage: true });
  await openAction('Borrow', 'USDC');
  await dialog().getByLabel('Borrow amount', { exact: true }).fill('50');
  await waitReview('borrow');
  await dialog().getByText(/Health factor/i).first().waitFor();
  await page.screenshot({ path: resolve(artifacts, 'borrow-review-desktop.png'), fullPage: false });
  start = sends.length; await finish('borrow');
  assert.deepEqual(sends.slice(start).map(functionOf), ['borrow']);
  assert.equal(decodeFunctionData({ abi: effects, data: sends.at(-1).data }).args[2], 2n, 'Borrow uses variable-rate debt');

  await openAction('Borrow', 'WETH');
  await dialog().getByLabel('Use native ETH', { exact: true }).check();
  await dialog().getByLabel('Borrow amount', { exact: true }).fill('0.02');
  start = sends.length; await finish('borrow');
  assert.deepEqual(sends.slice(start).map(functionOf), ['approveDelegation', 'borrowETH']);
  assert.equal(decodeFunctionData({ abi: effects, data: sends[start].data }).args[1], 20000000000000000n);
  await page.getByRole('button', { name: 'Your position', exact: true }).click();
  await openAction('Repay', 'WETH');
  await dialog().getByLabel('Use native ETH', { exact: true }).check();
  await dialog().getByRole('button', { name: 'Max', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Repay amount"]').value === '0.02');
  const nativeBeforeRepay = networks['1'].native;
  networks['1'].native = assetFor('1', networks['1'].weth).debt;
  await page.getByRole('button', { name: 'Refresh wallet and markets', exact: true }).evaluate(element => element.click());
  await page.waitForFunction(() => document.querySelector('.av-wallet .av-right').textContent.trim() === '0.02 ETH');
  await dialog().getByRole('button', { name: 'Max', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Repay amount"]').value === '0.0198');
  networks['1'].native = nativeBeforeRepay;
  await page.getByRole('button', { name: 'Refresh wallet and markets', exact: true }).evaluate(element => element.click());
  await page.waitForFunction(() => document.querySelector('.av-wallet .av-right').textContent.trim() === '1.92 ETH');
  await dialog().getByLabel('Repay full debt', { exact: true }).check();
  assert.equal(await dialog().getByLabel('Maximum payment', { exact: true }).inputValue(), '0.02002');
  start = sends.length; await finish('repay');
  assert.deepEqual(sends.slice(start).map(functionOf), ['repayETH']);
  assert.equal(decodeFunctionData({ abi: effects, data: sends.at(-1).data }).args[1], MAX);
  assert.equal(sends.at(-1).valueWei, '20020000000000000', 'Native full repayment has an explicit finite payment budget');
  assert.equal(assetFor('1', networks['1'].weth).debt, 0n);
  await openAction('Withdraw', 'WETH');
  await dialog().getByLabel('Use native ETH', { exact: true }).check();
  await dialog().getByLabel('Withdraw amount', { exact: true }).fill('0.05');
  start = sends.length; await finish('withdraw');
  assert.deepEqual(sends.slice(start).map(functionOf), ['approve', 'withdrawETH']);
  assert.equal(lower(sends[start].to), lower(assetFor('1', networks['1'].weth).aToken));
  await openAction('Repay', 'USDC');
  await dialog().getByLabel('Repay amount', { exact: true }).fill('20');
  start = sends.length; await finish('repay');
  assert.equal(functionOf(sends.at(-1)), 'repay');
  assert.equal(decodeFunctionData({ abi: effects, data: sends.at(-1).data }).args[1], 20000000n);
  await openAction('Repay', 'USDC');
  await dialog().getByLabel('Use supplied aTokens', { exact: true }).check();
  await dialog().getByLabel('Repay amount', { exact: true }).fill('5');
  start = sends.length; await finish('repay');
  assert.deepEqual(sends.slice(start).map(functionOf), ['repayWithATokens']);
  await openAction('Withdraw', 'USDC');
  await dialog().getByLabel('Withdraw amount', { exact: true }).fill('25');
  start = sends.length; await finish('withdraw');
  assert.deepEqual(sends.slice(start).map(functionOf), ['withdraw']);

  await page.getByRole('button', { name: 'Manage USDC collateral', exact: true }).click();
  await dialog().getByRole('button', { name: 'Review collateral change', exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifacts, 'collateral-desktop.png'), fullPage: false });
  await dialog().getByRole('button', { name: 'Review collateral change', exact: true }).click();
  await page.getByText('Confirmed. The final transaction completed successfully.', { exact: true }).waitFor();
  assert.equal(functionOf(sends.at(-1)), 'setUserUseReserveAsCollateral');
  assert.equal(assetFor('1', networks['1'].usdc).collateral, false);
  await page.getByRole('button', { name: 'Manage E-mode', exact: true }).click();
  await dialog().getByLabel('Stablecoins', { exact: false }).check();
  await dialog().getByRole('button', { name: 'Review E-mode change', exact: true }).click();
  await page.getByText('Confirmed. The final transaction completed successfully.', { exact: true }).waitFor();
  assert.equal(functionOf(sends.at(-1)), 'setUserEMode'); assert.equal(networks['1'].eMode, 1);
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await dialog().getByRole('button', { name: 'Review claim', exact: true }).click();
  await page.getByText('Confirmed. The final transaction completed successfully.', { exact: true }).waitFor();
  assert.equal(functionOf(sends.at(-1)), 'claimAllRewards'); assert.equal(networks['1'].reward, 0n);

  // A lost send reply with an available receipt resolves immediately, so the
  // UI must show completion without asking the owner to continue again.
  await openAction('Supply', 'WETH');
  await dialog().getByLabel('Use native ETH', { exact: true }).check();
  await dialog().getByLabel('Supply amount', { exact: true }).fill('0.01');
  const beforeLostReply = sends.length;
  mode = 'lost'; await (await waitReview('supply')).click();
  await page.getByText('Confirmed. The final transaction completed successfully.', { exact: true }).waitFor();
  assert.equal(sends.length, beforeLostReply + 1, 'Available receipt must resolve a lost reply without another send');
  assert.equal(await page.getByRole('button', { name: 'Continue in wallet', exact: true }).count(), 0);

  // If both the send reply and its first status observation are unavailable,
  // reloading still recovers that original request without duplicating it.
  await openAction('Supply', 'WETH');
  await dialog().getByLabel('Use native ETH', { exact: true }).check();
  await dialog().getByLabel('Supply amount', { exact: true }).fill('0.011');
  mode = 'lost_status'; await (await waitReview('supply')).click();
  await page.getByRole('button', { name: 'Continue in wallet', exact: true }).waitFor();
  const count = sends.length;
  await page.reload();
  await page.getByRole('button', { name: /saved operation needs attention/ }).click();
  await page.getByRole('button', { name: 'Continue in wallet', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.av-progress.av-pending') && !document.querySelector('.av-progress.av-review'));
  assert.equal(sends.length, count, 'Reload must reconcile the original request without duplicate effects');

  await page.setViewportSize({ width: 360, height: 900 });
  await page.getByRole('button', { name: 'Your position', exact: true }).click();
  await page.screenshot({ path: resolve(artifacts, 'position-narrow.png'), fullPage: true });
  await openAction('Borrow', 'USDC');
  await dialog().getByLabel('Borrow amount', { exact: true }).fill('10');
  await waitReview('borrow');
  await page.screenshot({ path: resolve(artifacts, 'borrow-narrow.png'), fullPage: false });
  assert(await dialog().evaluate(element => element.scrollWidth <= element.clientWidth), 'Narrow action dialog overflow');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Borrow USDC', exact: true }).first().evaluate(element => element === document.activeElement), true, 'Escape restores keyboard focus');

  await page.getByLabel('Network', { exact: true }).selectOption('42161');
  await page.getByRole('button', { name: 'Markets', exact: true }).click();
  await openAction('Supply', 'USDC');
  await dialog().getByLabel('Supply amount', { exact: true }).fill('1.000001');
  await finish('supply');
  assert.equal(sends.at(-1).chainId, '42161');
  assert.equal(lower(sends.at(-1).to), lower(networks['42161'].pool));
  assert.equal(lower(decodeFunctionData({ abi: effects, data: sends.at(-1).data }).args[0]), networks['42161'].usdc);
  assert.equal(decodeFunctionData({ abi: effects, data: sends.at(-1).data }).args[1], 1000001n);
  await page.screenshot({ path: resolve(artifacts, 'arbitrum-narrow.png'), fullPage: true });

  rpcFails = true;
  await openAction('Borrow', 'USDC');
  await dialog().getByLabel('Borrow amount', { exact: true }).fill('1');
  await dialog().getByRole('alert').filter({ hasText: /RPC|unavailable/i }).first().waitFor();
  assert(await dialog().getByRole('button', { name: 'Review borrow', exact: true }).isDisabled());
  await page.screenshot({ path: resolve(artifacts, 'provider-error-narrow.png'), fullPage: false });
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '360px page overflow');
  assert.deepEqual(errors, [], 'No unhandled browser errors');
  const progressCoverage = await runProgressChecks({ app, browser, artifacts });
  const evidence = { result: 'passed', sends: sends.length, records: records.size, coverage: ['actual service registration and descriptor validation', 'Wallet SDK ABI and response validation', 'durable journal before dispatch', 'loading', 'native ETH supply', 'USDC six-decimal approval and supply', 'variable-rate borrowing', 'native borrow delegation', 'bounded full native repayment', 'aWETH approval and native withdrawal', 'wallet repayment', 'aToken repayment', 'withdrawal', 'health factor and collateral', 'efficiency mode', 'incentive rewards claim', 'lost send reply resolves an available receipt immediately without another send', 'lost-reply reload without duplicate send', 'Ethereum and Arbitrum contract separation', 'exact gateway, Pool and recipient identity', 'Escape and restored focus', '360px responsive layout', 'RPC failure disables review', 'missing oracle prices hide borrowing capacity and disable automatic amount presets while retaining manual protocol checks', 'health-factor rounding preserves liquidation threshold', 'completed operations can reconcile reorganized receipts without duplicate sends', 'account refresh race cannot mix wallet balances, positions or quotes', 'periodic refresh detects wallet identity changes and clears old dialogs', 'native Max deducts observed maximum network fee from an empty draft', 'failed Max fee observation retains the manually entered amount', 'stale Max fee reply cannot overwrite a newer manual amount', 'native repayment Max respects both debt and fee-adjusted wallet balance', ...progressCoverage] };
  await writeFile(resolve(artifacts, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  if (fixturePage) { await fixturePage.screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true }); console.error((await fixturePage.locator('body').innerText()).slice(-6500)); console.error(errors); }
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
