import { getAddress, hexToString, type Address, type Hex } from "viem";
import { curatedEvmTokens } from "neutron-tools/src/evm_assets.js";
import { call, CHAINS, decode, encode, MAX_UINT256, MULTICALL, POOL_RESERVE, RAY, rayApy, TOKEN_BALANCE, USER_ACCOUNT, ZERO, type AccountPosition, type ChainId, type EMode, type Market, type Reader, type Reserve, type Reward } from "./contracts.ts";

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export const MULTICALL_READ = "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)";
export const PROVIDER_RESERVE = "function getReserveData(address asset) view returns (uint256 unbacked,uint256 accruedToTreasuryScaled,uint256 totalAToken,uint256 totalStableDebt,uint256 totalVariableDebt,uint256 liquidityRate,uint256 variableBorrowRate,uint256 stableBorrowRate,uint256 averageStableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex,uint40 lastUpdateTimestamp)";
export const PROVIDER_USER = "function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)";
export const EMODE_DATA = "function getEModeCategoryData(uint8 id) view returns ((uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus,address priceSource,string label))";
export type ReadSpec = { to: Address; signature: string; args?: readonly unknown[]; optional?: boolean; label?: string };

/** One RPC roundtrip; every nested eth_call observes the same requested block. */
export async function readBatch(read: Reader, chainId: ChainId, requests: readonly ReadSpec[], blockNumber: string): Promise<unknown[]> {
  if (!requests.length) return [];
  const result = await call(read, chainId, MULTICALL, MULTICALL_READ, [requests.map((r) => ({ target: r.to, allowFailure: true, callData: encode(r.signature, r.args) }))], blockNumber);
  const rows = result.value as { success: boolean; returnData: Hex }[];
  if (!Array.isArray(rows) || rows.length !== requests.length) throw new Error("Aave returned an incomplete contract read.");
  return rows.map((row, i) => {
    const request = requests[i]!;
    try {
      if (!row.success) throw new Error("Contract reverted");
      return decode(request.signature, row.returnData);
    } catch (error) {
      // Older ERC20s (MKR) use bytes32 names and symbols.
      if (row.success && /function (name|symbol)\(/.test(request.signature) && row.returnData.length === 66) return hexToString(row.returnData, { size: 32 }).replace(/\0+$/, "");
      if (request.optional) return null;
      throw new Error(`${request.label ?? request.signature.match(/function (\w+)/)?.[1]} failed for ${request.to}: ${errorMessage(error)}`);
    }
  });
}
export function decodeConfiguration(value: bigint) {
  const bits = (start: number, length: number) => (value >> BigInt(start)) & ((1n << BigInt(length)) - 1n);
  return { ltvBps: Number(bits(0, 16)), liquidationThresholdBps: Number(bits(16, 16)), liquidationBonusBps: Number(bits(32, 16)), decimals: Number(bits(48, 8)),
    active: bits(56, 1) !== 0n, frozen: bits(57, 1) !== 0n, borrowingEnabled: bits(58, 1) !== 0n, paused: bits(60, 1) !== 0n,
    borrowableInIsolation: bits(61, 1) !== 0n, siloedBorrowing: bits(62, 1) !== 0n,
    borrowCap: bits(80, 36).toString(), supplyCap: bits(116, 36).toString(), debtCeiling: bits(212, 40).toString() };
}
export function positionFromContract(value: readonly bigint[], eModeId: number): AccountPosition {
  return { totalCollateralBase: String(value[0]), totalDebtBase: String(value[1]), availableBorrowsBase: String(value[2]), liquidationThresholdBps: Number(value[3]), ltvBps: Number(value[4]), healthFactor: value[5] === MAX_UINT256 ? null : String(value[5]), eModeId };
}
export async function readEModes(read: Reader, chainId: ChainId, blockNumber: string): Promise<EMode[]> {
  const pool = CHAINS[chainId].pool;
  // All values accepted by the uint8 protocol ABI; do not assume contiguous IDs.
  const ids = Array.from({ length: 255 }, (_, i) => i + 1);
  const data = await readBatch(read, chainId, ids.map((id) => ({ to: pool, signature: EMODE_DATA, args: [id] })), blockNumber);
  const categories = data.flatMap((raw, i) => {
    const row = raw as { ltv: number; liquidationThreshold: number; liquidationBonus: number; priceSource: Address; label: string };
    if (!row.liquidationThreshold) return [];
    return [{ id: ids[i]!, label: row.label, ltvBps: Number(row.ltv), liquidationThresholdBps: Number(row.liquidationThreshold), liquidationBonusBps: Number(row.liquidationBonus), collateralBitmap: "0", borrowableBitmap: "0", ltvzeroBitmap: "0", isolated: false }];
  });
  const configs = await readBatch(read, chainId, categories.flatMap(({ id }) => [
    { to: pool, signature: "function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)", args: [id] },
    { to: pool, signature: "function getEModeCategoryBorrowableBitmap(uint8 id) view returns (uint128)", args: [id] },
    { to: pool, signature: "function getEModeCategoryLtvzeroBitmap(uint8 id) view returns (uint128)", args: [id], optional: true },
    { to: pool, signature: "function getIsEModeCategoryIsolated(uint8 id) view returns (bool)", args: [id], optional: true },
  ]), blockNumber);
  return categories.map((category, i) => ({ ...category, collateralBitmap: String(configs[i * 4]), borrowableBitmap: String(configs[i * 4 + 1]), ltvzeroBitmap: String(configs[i * 4 + 2] ?? 0n), isolated: configs[i * 4 + 3] === true }));
}

export async function readMarket(read: Reader, chainId: ChainId, accountAddress: Address, options: { now?: number; signal?: AbortSignal; onProgress?: (message: string) => void; blockNumber?: string } = {}): Promise<Market> {
  const network = CHAINS[chainId], owner = getAddress(accountAddress), errors: string[] = [];
  options.signal?.throwIfAborted(); options.onProgress?.("Reading Aave market contracts…");
  const identity = await call(read, chainId, network.provider, "function getPool() view returns (address)", [], options.blockNumber);
  if (getAddress(String(identity.value)) !== network.pool) throw new Error("Aave's registered Pool changed. This app needs an updated market definition.");
  const block = identity.blockNumber;
  const initial = await readBatch(read, chainId, [
    { to: network.pool, signature: "function ADDRESSES_PROVIDER() view returns (address)" },
    { to: network.provider, signature: "function getPriceOracle() view returns (address)" },
    { to: network.provider, signature: "function getPoolDataProvider() view returns (address)" },
    { to: network.dataProvider, signature: "function POOL() view returns (address)" },
    { to: network.pool, signature: "function getReservesList() view returns (address[])" },
    { to: network.pool, signature: USER_ACCOUNT, args: [owner] },
    { to: network.pool, signature: "function getUserEMode(address user) view returns (uint256)", args: [owner] },
    { to: network.oracle, signature: "function BASE_CURRENCY() view returns (address)" },
    { to: network.oracle, signature: "function BASE_CURRENCY_UNIT() view returns (uint256)" },
  ], block);
  if (getAddress(String(initial[0])) !== network.provider || getAddress(String(initial[1])) !== network.oracle || getAddress(String(initial[2])) !== network.dataProvider || getAddress(String(initial[3])) !== network.pool) throw new Error("Aave market contract identities no longer match this release. Refresh the app before continuing.");
  if (getAddress(String(initial[7])) !== ZERO || BigInt(String(initial[8])) <= 0n) throw new Error("This Aave market no longer uses the supported USD reference currency.");
  const assets = (initial[4] as Address[]).map(address => getAddress(address));
  const eModePromise = readEModes(read, chainId, block);
  // Register immediately: market failure must not leave a detached rejection.
  const eModeResult = eModePromise.then(value => ({ value, error: null }), error => ({ value: [] as EMode[], error }));
  const requests = assets.flatMap((asset): ReadSpec[] => [
    { to: network.pool, signature: POOL_RESERVE, args: [asset] },
    { to: network.dataProvider, signature: PROVIDER_RESERVE, args: [asset] },
    { to: network.dataProvider, signature: PROVIDER_USER, args: [asset, owner] },
    { to: asset, signature: TOKEN_BALANCE, args: [owner] },
    { to: asset, signature: "function symbol() view returns (string)", optional: true },
    { to: asset, signature: "function name() view returns (string)", optional: true },
    { to: network.oracle, signature: "function getAssetPrice(address asset) view returns (uint256)", args: [asset] },
    { to: network.pool, signature: "function getVirtualUnderlyingBalance(address asset) view returns (uint128)", args: [asset] },
    { to: network.dataProvider, signature: "function getDebtCeiling(address asset) view returns (uint256)", args: [asset] },
    { to: network.dataProvider, signature: "function getSiloedBorrowing(address asset) view returns (bool)", args: [asset] },
  ]);
  const data = await readBatch(read, chainId, requests, block);
  const reserves = assets.map((address, i): Reserve => {
    const j = i * 10, pool = data[j] as { configuration: { data: bigint }; id: number; aTokenAddress: Address; variableDebtTokenAddress: Address; isolationModeTotalDebt: bigint; liquidityIndex: bigint }, totals = data[j + 1] as bigint[], user = data[j + 2] as (bigint | boolean)[];
    const config = decodeConfiguration(pool.configuration.data);
    const listed = curatedEvmTokens(chainId).find((t) => t.address?.toLowerCase() === address.toLowerCase());
    const symbol = listed?.symbol ?? (typeof data[j + 4] === "string" ? String(data[j + 4]) : `${address.slice(0, 6)}…${address.slice(-4)}`);
    const name = listed?.name ?? (typeof data[j + 5] === "string" ? String(data[j + 5]) : symbol);
    return { ...config, chainId, address, name, symbol, id: Number(pool.id), aTokenAddress: getAddress(pool.aTokenAddress), variableDebtTokenAddress: getAddress(pool.variableDebtTokenAddress),
      supplyRateRay: String(totals[5]), borrowRateRay: String(totals[6]), supplyApy: rayApy(String(totals[5])), borrowApy: rayApy(String(totals[6])),
      totalSupplied: String(totals[2]), totalDebt: String(totals[4]), walletBalance: String(data[j + 3]), supplied: String(user[0]), variableDebt: String(user[2]), collateralEnabled: user[8] === true,
      priceBase: String(data[j + 6]), availableLiquidity: String(data[j + 7]), debtCeiling: String(data[j + 8]), siloedBorrowing: data[j + 9] === true, isolationModeTotalDebt: String(pool.isolationModeTotalDebt),
      accruedToTreasury: ((BigInt(String(totals[1])) * pool.liquidityIndex + RAY / 2n) / RAY).toString() };
  });
  options.signal?.throwIfAborted();
  const eModeRead = await eModeResult;
  if (eModeRead.error) throw new Error(`Could not read current efficiency-mode rules: ${errorMessage(eModeRead.error)}`);
  const eModeId = Number(initial[6]);
  if (eModeId !== 0 && !eModeRead.value.some(mode => mode.id === eModeId)) throw new Error("The account's active efficiency mode could not be read.");
  let rewards: Reward[] = [];
  try {
    const rewardAssets = reserves.flatMap(r => [r.aTokenAddress, r.variableDebtTokenAddress]);
    const rewardResult = await call(read, chainId, network.rewardsController, "function getAllUserRewards(address[] assets,address user) view returns (address[] rewardsList,uint256[] unclaimedAmounts)", [rewardAssets, owner], block);
    const [rewardTokens, amounts] = rewardResult.value as [Address[], bigint[]];
    if (rewardTokens.length !== amounts.length) throw new Error("Reward amount list is incomplete.");
    const earned = rewardTokens.map((address, index) => ({ address: getAddress(address), amount: amounts[index]! })).filter(r => r.amount > 0n);
    const metadata = await readBatch(read, chainId, earned.flatMap(({ address }) => [
      { to: address, signature: "function decimals() view returns (uint8)" },
      { to: address, signature: "function symbol() view returns (string)", optional: true },
      { to: address, signature: "function name() view returns (string)", optional: true },
    ]), block);
    rewards = earned.map(({ address, amount }, i) => ({ chainId, address, decimals: Number(metadata[i * 3]), symbol: String(metadata[i * 3 + 1] ?? `${address.slice(0, 6)}…`), name: String(metadata[i * 3 + 2] ?? "Reward token"), amount: amount.toString(), controller: network.rewardsController, assets: rewardAssets }));
  } catch (error) { errors.push(`Rewards are unavailable: ${errorMessage(error)}`); }
  return { chainId, name: network.marketName, pool: network.pool, accountAddress: owner, blockNumber: block, fetchedAtMs: options.now ?? Date.now(), baseCurrencyUnit: String(initial[8]), baseCurrencyUsd: "1", reserves,
    account: positionFromContract(initial[5] as bigint[], eModeId), eModes: eModeRead.value, rewards, errors };
}
