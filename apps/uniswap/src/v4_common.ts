import { encodeAbiParameters, getAddress, isAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { network, type Token } from "./swap.ts";

// Official V4 deployments and UR 2.1.1, checked 2026-09-06:
// https://developers.uniswap.org/docs/protocols/v4/deployments
export const V4_DEPLOYMENTS = {
  "1": {
    router: getAddress("0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca"),
    quoter: getAddress("0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203"),
    poolManager: getAddress("0x000000000004444c5dc75cb358380d2e3de08a90"),
    positionManager: getAddress("0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e"),
    stateView: getAddress("0x7ffe42c4a5deea5b0fec41c94c136cf115597227"),
  },
  "42161": {
    router: getAddress("0x8b844f885672f333bc0042cb669255f93a4c1e6b"),
    quoter: getAddress("0x3972c00f7ed4885e145823eb7c655375d275a1c5"),
    poolManager: getAddress("0x360e68faccca8ca495c1b759fd9eee466db9fb32"),
    positionManager: getAddress("0xd88f38f930b7952f2db2432cb002e7abbf3dd869"),
    stateView: getAddress("0x76fd297e2d437cd7f76d50f01afe6160f86e9990"),
  },
} as const;

export type V4PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] as const;
export const V4_STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
export const V4_DEFAULT_POOLS = [
  { fee: 100, tickSpacing: 1 }, { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 }, { fee: 10000, tickSpacing: 200 },
] as const;

export function v4Deployment(chainId: string) {
  network(chainId);
  return V4_DEPLOYMENTS[chainId as keyof typeof V4_DEPLOYMENTS];
}

export function v4Currency(token: Token): Address { return token.address === null ? zeroAddress : getAddress(token.address); }

export function validateV4PoolKey(key: V4PoolKey): V4PoolKey {
  if (!key || !isAddress(key.currency0) || !isAddress(key.currency1) || !isAddress(key.hooks)) throw new Error("Invalid V4 pool currencies or hooks address.");
  if (BigInt(key.currency0) >= BigInt(key.currency1)) throw new Error("V4 pool currencies must be different and sorted by address.");
  // PoolManager's protocol bounds, not an app fee-tier policy. Dynamic pools use
  // exactly the flag 0x800000; static fees may be any value through 1,000,000.
  if (!Number.isInteger(key.fee) || (key.fee !== 0x800000 && (key.fee < 0 || key.fee > 1_000_000))) throw new Error("Invalid V4 pool fee.");
  if (!Number.isInteger(key.tickSpacing) || key.tickSpacing < 1 || key.tickSpacing > 32767) throw new Error("Invalid V4 pool tick spacing.");
  return { currency0: getAddress(key.currency0), currency1: getAddress(key.currency1), fee: key.fee, tickSpacing: key.tickSpacing, hooks: getAddress(key.hooks) };
}

export function v4PoolId(key: V4PoolKey): Hex {
  return keccak256(encodeAbiParameters([{ type: "tuple", components: POOL_KEY_COMPONENTS }], [validateV4PoolKey(key)]));
}
