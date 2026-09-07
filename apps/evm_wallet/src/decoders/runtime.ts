import type { Asset, Network, Operation } from "../data.ts";
import { presentOperation, type OperationPresentation } from "../presentation.ts";
import type { BrowserReadRpc } from "../browser_reads.ts";
import { presentationTokens, type ActiveDecoderPack } from "./registry.ts";
import { resolveTokenMetadata } from "./metadata.ts";

/** Shared enrichment for owner review, Agent review and old saved activity.
 * Reads can improve labels, but never mutate transaction bytes or history. */
export async function resolveOperationPresentation(
  operation: Operation, assets: readonly Asset[], network?: Network,
  options: { packs?: readonly ActiveDecoderPack[]; signal?: AbortSignal; rpc?: BrowserReadRpc } = {},
): Promise<OperationPresentation> {
  const packs = options.packs ?? [];
  const initial = presentOperation(operation, assets, network, packs);
  const metadata = await resolveTokenMetadata(operation.chainId, presentationTokens(initial), assets, { from: operation.address, ...(options.signal ? { signal: options.signal } : {}), ...(options.rpc ? { rpc: options.rpc } : {}) });
  options.signal?.throwIfAborted();
  const result = presentOperation(operation, metadata, network, packs);
  const token = result.tokenAddress ? metadata.find(asset => asset.chainId === operation.chainId && asset.address.toLowerCase() === result.tokenAddress!.toLowerCase()) : undefined;
  return { ...result, ...(token ? { amountDecimals: token.decimals } : result.tokenAddress === null ? { amountDecimals: 18 } : {}) };
}
