import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import type { EvmWalletClient } from "neutron-tools/evm_wallet";

export type ChainId = "1" | "42161";
export type Family = "stable-ng" | "stable-meta-ng" | "twocrypto-ng" | "tricrypto-ng" | "legacy-2" | "legacy-3";
export type PoolRef = { chainId: ChainId; address: Address; family: Family };
export type Token = { chainId: ChainId; address: Address | null; symbol: string; decimals: number };
export type Pool = PoolRef & {
  id: string; name: string; coins: Token[]; lpToken: Address; tvlUsd: number | null;
  apiObservedAtMs: number | null;
};
export type VerifiedPool = Pool & { blockNumber: string; supply: string; balances: string[]; lpDecimals: number };
export type Reader = (chainId: ChainId, to: Address, data: Hex, blockNumber?: string) => Promise<{ data: Hex; blockNumber: string }>;
export type Transaction = { chainId: ChainId; accountId: "main"; to: Address; valueWei: string; data: Hex };

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const NATIVE = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
export const FAMILIES: Family[] = ["stable-ng", "stable-meta-ng", "twocrypto-ng", "tricrypto-ng", "legacy-2", "legacy-3"];
export const CHAINS = {
  "1": { name: "Ethereum", api: "ethereum", explorer: "https://etherscan.io", router: getAddress("0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e"), weth: getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"),
    factories: { "stable-ng": getAddress("0x6a8cbed756804b16e05e741edabd5cb544ae21bf"), "twocrypto-ng": getAddress("0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f"), "tricrypto-ng": getAddress("0x0c0e5f2ff0ff18a3be9b835635039256dc4b4963") } },
  "42161": { name: "Arbitrum", api: "arbitrum", explorer: "https://arbiscan.io", router: getAddress("0x2191718cd32d02b8e60badffea33e4b5dd9a0a0d"), weth: getAddress("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"),
    factories: { "stable-ng": getAddress("0x9af14d26075f142eb3f292d5065eb3faa646167b"), "twocrypto-ng": getAddress("0x98ee851a00abee0d95d08cf4ca2bdce32aeaaf7f"), "tricrypto-ng": getAddress("0xbc0797015fcfc47d9c1856639cae50d0e69fbee8") } },
} as const;

// Exact legacy deployments, from the pinned official Curve pool definitions.
// Their base liquidity overloads pay the caller; no receiver is invented.
export const LEGACY_POOLS: Record<ChainId, Record<string, { family: Family; lpToken: Address; name: string }>> = {
  "1": {
    "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7": { family: "legacy-3", lpToken: getAddress("0x6c3f90f043a72fa612cbac8115ee7e52bde6e490"), name: "3pool" },
    "0xdc24316b9ae028f1497c275eb9192a3ea0f67022": { family: "legacy-2", lpToken: getAddress("0x06325440d014e39736583c165c2963ba99faf14e"), name: "ETH / stETH" },
  },
  "42161": {
    "0x7f90122bf0700f9e7e1f688fe926940e8839f353": { family: "legacy-2", lpToken: getAddress("0x7f90122bf0700f9e7e1f688fe926940e8839f353"), name: "2pool" },
    "0x6eb2dc694eb516b16dc9fbc678c60052bbdd7d80": { family: "legacy-2", lpToken: getAddress("0xdbcd16e622c95acb2650b38ec799f76bfc557a0b"), name: "ETH / wstETH" },
  },
};

export const ROUTER_EXCHANGE = "function exchange(address[11] route,uint256[5][5] params,uint256 amount,uint256 minimum,address[5] pools,address receiver) payable returns (uint256)";
export const ROUTER_QUOTE = "function get_dy(address[11] route,uint256[5][5] params,uint256 amount,address[5] pools) view returns (uint256)";
export const TOKEN_BALANCE = "function balanceOf(address owner) view returns (uint256)";
export const TOKEN_ALLOWANCE = "function allowance(address owner,address spender) view returns (uint256)";
export const TOKEN_APPROVE = "function approve(address spender,uint256 amount) returns (bool)";

export function encode(signature: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi: parseAbi([signature] as string[]) as Abi, functionName: signature.match(/^function (\w+)/)![1]!, args });
}
export async function call(read: Reader, chainId: ChainId, to: Address, signature: string, args: readonly unknown[] = [], blockNumber?: string) {
  const result = await read(chainId, to, encode(signature, args), blockNumber);
  return { value: decodeFunctionResult({ abi: parseAbi([signature] as string[]) as Abi, functionName: signature.match(/^function (\w+)/)![1]!, data: result.data }), blockNumber: result.blockNumber };
}
export function walletReader(wallet: EvmWalletClient, signal?: AbortSignal): Reader {
  return async (chainId, to, data, blockNumber) => {
    const result = await wallet.callContract({ accountId: "main", chainId, to, data,
      ...(blockNumber === undefined ? {} : { blockTag: `0x${BigInt(blockNumber).toString(16)}` }) }, signal ? { signal } : undefined);
    return { data: result.result as Hex, blockNumber: result.blockNumber };
  };
}
export function chain(value: unknown): ChainId {
  if (value !== "1" && value !== "42161") throw new Error("Choose Ethereum or Arbitrum.");
  return value;
}
export function poolRef(value: unknown): PoolRef {
  if (!value || typeof value !== "object") throw new Error("A Curve pool is required.");
  const raw = value as Record<string, unknown>;
  if (!FAMILIES.includes(raw.family as Family)) throw new Error("Unknown Curve pool family.");
  const address = getAddress(String(raw.address));
  if (address === ZERO || address === NATIVE) throw new Error("Enter the pool contract address.");
  return { chainId: chain(raw.chainId), address, family: raw.family as Family };
}
export function uint(value: unknown, label: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must use exact atomic decimal units.`);
  const number = BigInt(value);
  if (number >= 1n << 256n || (positive && number === 0n)) throw new Error(`${label} must be ${positive ? "positive and " : ""}within uint256.`);
  return number;
}
export function bps(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10000) throw new Error("Slippage must be between 0% and 100%.");
  return value;
}
export function minimum(amount: bigint, slippageBps: number): bigint { return amount * BigInt(10000 - bps(slippageBps)) / 10000n; }
export function tokenKey(token: Pick<Token, "chainId" | "address">): string { return `${token.chainId}:${token.address?.toLowerCase() ?? "native"}`; }
export function poolKey(pool: PoolRef): string { return `${pool.chainId}:${pool.address.toLowerCase()}`; }
export function isLegacy(pool: PoolRef): boolean { return pool.family.startsWith("legacy-"); }
export function liquiditySignatures(pool: PoolRef) {
  const array = pool.family === "stable-ng" ? "uint256[]" : pool.family === "tricrypto-ng" || pool.family === "legacy-3" ? "uint256[3]" : "uint256[2]";
  const index = pool.family.includes("crypto") ? "uint256" : "int128";
  const tail = pool.family === "tricrypto-ng" ? ",bool useEth,address receiver" : isLegacy(pool) ? "" : ",address receiver";
  return {
    deposit: `function add_liquidity(${array} amounts,uint256 minimum${tail}) payable`,
    withdraw: `function remove_liquidity(uint256 amount,${array} minima${tail})`,
    withdrawOne: `function remove_liquidity_one_coin(uint256 amount,${index} coin,uint256 minimum${tail})`,
    quoteDeposit: `function calc_token_amount(${array} amounts,bool deposit) view returns (uint256)`,
    quoteOne: `function calc_withdraw_one_coin(uint256 amount,${index} coin) view returns (uint256)`,
  };
}
