import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import type { EvmWalletClient } from "neutron-tools/evm_wallet";

export type ChainId = "1" | "42161";
export type Token = { chainId: ChainId; address: Address; symbol: string; name: string; decimals: number };
export type Reader = (chainId: ChainId, to: Address, data: Hex, blockNumber?: string) => Promise<{ data: Hex; blockNumber: string }>;
export type Transaction = { chainId: ChainId; accountId: "main"; to: Address; valueWei: string; data: Hex };
export type Reserve = Token & {
  id: number; aTokenAddress: Address; variableDebtTokenAddress: Address;
  supplyRateRay: string; borrowRateRay: string; supplyApy: number | null; borrowApy: number | null;
  priceBase: string; totalSupplied: string; totalDebt: string; availableLiquidity: string;
  walletBalance: string; supplied: string; variableDebt: string; collateralEnabled: boolean;
  ltvBps: number; liquidationThresholdBps: number; liquidationBonusBps: number;
  active: boolean; frozen: boolean; paused: boolean; borrowingEnabled: boolean;
  supplyCap: string; borrowCap: string; debtCeiling: string; isolationModeTotalDebt: string;
  borrowableInIsolation: boolean; siloedBorrowing: boolean; accruedToTreasury: string;
};
export type EMode = { id: number; label: string; ltvBps: number; liquidationThresholdBps: number; liquidationBonusBps: number; collateralBitmap: string; borrowableBitmap: string; ltvzeroBitmap: string; isolated: boolean };
export type AccountPosition = { totalCollateralBase: string; totalDebtBase: string; availableBorrowsBase: string; liquidationThresholdBps: number; ltvBps: number; healthFactor: string | null; eModeId: number };
export type Reward = Token & { amount: string; controller: Address; assets: Address[] };
export type Market = {
  chainId: ChainId; name: string; pool: Address; accountAddress: Address; blockNumber: string; fetchedAtMs: number;
  baseCurrencyUnit: string; baseCurrencyUsd: string; reserves: Reserve[]; account: AccountPosition;
  eModes: EMode[]; rewards: Reward[]; errors: string[];
};

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const MAX_UINT256 = (1n << 256n) - 1n;
export const WAD = 10n ** 18n;
export const RAY = 10n ** 27n;
// Aave DAO address book 12963110f29699d214531b9ab4c7cfcec460c298.
export const CHAINS = {
  "1": { name: "Ethereum", marketName: "Ethereum Core", explorer: "https://etherscan.io", provider: getAddress("0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e"), pool: getAddress("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"), oracle: getAddress("0x54586bE62E3c3580375aE3723C145253060Ca0C2"), dataProvider: getAddress("0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD"), gateway: getAddress("0xd01607c3C5eCABa394D8be377a08590149325722"), weth: getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), rewardsController: getAddress("0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb") },
  "42161": { name: "Arbitrum", marketName: "Arbitrum", explorer: "https://arbiscan.io", provider: getAddress("0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb"), pool: getAddress("0x794a61358D6845594F94dc1DB02A252b5b4814aD"), oracle: getAddress("0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7"), dataProvider: getAddress("0x243Aa95cAC2a25651eda86e80bEe66114413c43b"), gateway: getAddress("0x5283BEcEd7ADF6D003225C13896E536f2D4264FF"), weth: getAddress("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"), rewardsController: getAddress("0x929EC64c34a17401F460460D4B9390518E5B473e") },
} as const;
export const MULTICALL = getAddress("0xca11bde05977b3631167028862be2a173976ca11");
export const TOKEN_BALANCE = "function balanceOf(address owner) view returns (uint256)";
export const TOKEN_ALLOWANCE = "function allowance(address owner,address spender) view returns (uint256)";
export const TOKEN_APPROVE = "function approve(address spender,uint256 amount) returns (bool)";
export const POOL_RESERVE = "function getReserveData(address asset) view returns (((uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))";
export const USER_ACCOUNT = "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)";
export const EFFECTS = {
  supply: "function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)",
  withdraw: "function withdraw(address asset,uint256 amount,address to) returns (uint256)",
  borrow: "function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)",
  repay: "function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)",
  repay_atokens: "function repayWithATokens(address asset,uint256 amount,uint256 interestRateMode) returns (uint256)",
  collateral: "function setUserUseReserveAsCollateral(address asset,bool useAsCollateral)",
  emode: "function setUserEMode(uint8 categoryId)",
  rewards: "function claimAllRewards(address[] assets,address to) returns (address[] rewardsList,uint256[] claimedAmounts)",
  supply_native: "function depositETH(address pool,address onBehalfOf,uint16 referralCode) payable",
  withdraw_native: "function withdrawETH(address pool,uint256 amount,address to)",
  borrow_native: "function borrowETH(address pool,uint256 amount,uint16 referralCode)",
  repay_native: "function repayETH(address pool,uint256 amount,address onBehalfOf) payable",
  delegation: "function approveDelegation(address delegatee,uint256 amount)",
} as const;

export function encode(signature: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi: parseAbi([signature] as string[]) as Abi, functionName: signature.match(/^function (\w+)/)![1]!, args });
}
export function decode(signature: string, data: Hex): unknown {
  return decodeFunctionResult({ abi: parseAbi([signature] as string[]) as Abi, functionName: signature.match(/^function (\w+)/)![1]!, data });
}
export async function call(read: Reader, chainId: ChainId, to: Address, signature: string, args: readonly unknown[] = [], blockNumber?: string) {
  const result = await read(chainId, to, encode(signature, args), blockNumber);
  if (blockNumber !== undefined && BigInt(result.blockNumber) !== BigInt(blockNumber)) throw new Error("Aave reads returned inconsistent block numbers. Refresh the market.");
  return { value: decode(signature, result.data), blockNumber: result.blockNumber };
}
export function walletReader(wallet: EvmWalletClient, signal?: AbortSignal): Reader {
  return async (chainId, to, data, blockNumber) => {
    const result = await wallet.callContract({ accountId: "main", chainId, to, data, ...(blockNumber === undefined ? {} : { blockTag: `0x${BigInt(blockNumber).toString(16)}` }) }, signal ? { signal } : undefined);
    return { data: result.result as Hex, blockNumber: result.blockNumber };
  };
}
export function chain(value: unknown): ChainId { if (value !== "1" && value !== "42161") throw new Error("Choose Ethereum or Arbitrum."); return value; }
export function uint(value: unknown, label: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must use exact atomic decimal units.`);
  const n = BigInt(value); if (n > MAX_UINT256 || (positive && n === 0n)) throw new Error(`${label} must be ${positive ? "positive and " : ""}within uint256.`); return n;
}
export function tokenKey(token: Pick<Token, "chainId" | "address">): string { return `${token.chainId}:${token.address.toLowerCase()}`; }
export function rayApy(rate: string): number | null {
  const secondsPerYear = 31536000;
  const n = Math.expm1(secondsPerYear * Math.log1p(Number(rate) / Number(RAY) / secondsPerYear));
  return Number.isFinite(n) ? n : null;
}
