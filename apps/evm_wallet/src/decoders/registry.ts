import type { Asset, Network, Operation } from "../data.ts";
import type { OperationPresentation } from "../presentation.ts";
import { presentUniswapSwap } from "./adapters/swap_presentation.ts";
import { presentUniswapV4Swap } from "./adapters/v4_swap_presentation.ts";
import { presentUniswapLiquidity, presentPermit2Approval } from "./adapters/liquidity_presentation.ts";
import { presentCurve } from "./adapters/curve_presentation.ts";
import { presentAave } from "./adapters/aave_presentation.ts";
import { presentHyperliquidAuthorization, presentHyperliquidDeposit } from "./adapters/hyperliquid_presentation.ts";
import { decodeDescriptorPack, descriptorTokens, type DecoderPack } from "./descriptor.ts";

/** Pure adapters interpret exact bytes. They receive no signing or network
 * capability; adding an adapter never changes transaction execution. */
export type TransactionDecoder = {
  id: string;
  name: string;
  version: string;
  decode(operation: Operation, assets: readonly Asset[], network?: Network): OperationPresentation | null;
};
export type ActiveDecoderPack = { pack: DecoderPack; sha256: string };

export const builtinDecoders: readonly TransactionDecoder[] = [
  { id: "uniswap-v3-swap", name: "Uniswap V3", version: "1", decode: presentUniswapSwap },
  { id: "uniswap-v4-swap", name: "Uniswap V4", version: "1", decode: presentUniswapV4Swap },
  { id: "uniswap-liquidity", name: "Uniswap liquidity", version: "1", decode: presentUniswapLiquidity },
  { id: "permit2", name: "Permit2", version: "1", decode: presentPermit2Approval },
  { id: "curve", name: "Curve and pool interfaces", version: "1", decode: presentCurve },
  { id: "aave-v3", name: "Aave V3", version: "1", decode: presentAave },
  { id: "hyperliquid-authorization", name: "Hyperliquid authorization", version: "1", decode: presentHyperliquidAuthorization },
  { id: "hyperliquid-cctp", name: "Circle CCTP to Hyperliquid", version: "1", decode: presentHyperliquidDeposit },
];

export function decodeBuiltin(operation: Operation, assets: readonly Asset[], network?: Network): OperationPresentation | null {
  for (const adapter of builtinDecoders) {
    try {
      const result = adapter.decode(operation, assets, network);
      if (result) return { ...result, decoder: { id: adapter.id, name: adapter.name, version: adapter.version, kind: "built-in" } };
    } catch { /* An unsupported interface keeps the generic transaction review. */ }
  }
  return null;
}

export function decodeImported(operation: Operation, assets: readonly Asset[], network: Network | undefined, packs: readonly ActiveDecoderPack[]): { presentation: OperationPresentation | null; warning?: string } {
  const matches = packs.flatMap(({ pack, sha256 }) => {
    try {
      const decoded = decodeDescriptorPack(pack, operation, assets, network);
      return decoded ? [{ ...decoded, tokenAddresses: descriptorTokens(pack, operation), decoder: { id: pack.id, name: pack.name, version: pack.version, kind: "imported" as const, sha256, ...(pack.source ? { source: pack.source } : {}) } }] : [];
    } catch { return []; }
  });
  if (matches.length > 1) return { presentation: null, warning: `Multiple enabled decoder packs match this transaction: ${matches.map(result => result.decoder.name).join(", ")}. Showing the exact transaction without choosing a pack.` };
  return { presentation: matches[0] ?? null };
}

/** Explicit token references only; contract parties are not presumed ERC20s. */
export function presentationTokens(presentation: OperationPresentation): string[] {
  return [...new Set([
    ...(presentation.tokenAddresses ?? []), presentation.tokenAddress,
    presentation.swap?.tokenIn, presentation.swap?.tokenOut,
    presentation.liquidity?.token0, presentation.liquidity?.token1,
    presentation.permit2Approval?.token,
  ].filter((value): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value)).map(value => value.toLowerCase()))];
}
