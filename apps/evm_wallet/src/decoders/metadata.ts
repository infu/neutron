import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { browserCallContract, rpcQuantity, type BrowserReadRpc } from "../browser_reads.ts";
import { browserEvmRpc } from "../browser_rpc.ts";
import { address as parseAddress, type Asset } from "../data.ts";

export type TokenMetadataOptions = {
  signal?: AbortSignal;
  rpc?: BrowserReadRpc;
  from?: string;
};

const zeroAddress = `0x${"00".repeat(20)}`;
const nativePlaceholder = `0x${"ee".repeat(20)}`;
const decimalsSelector = "0x313ce567";
const symbolSelector = "0x95d89b41";
const symbolOutput = [{ type: "string" }] as const;
const observed = new Map<string, Readonly<Asset>>();
const pending = new Map<string, Promise<Readonly<Asset> | null>>();
let generation = 0;

const identity = (chainId: string, address: string) => `${chainId}:${address.toLowerCase()}`;

/** Manual refresh also prevents a previous in-flight observation repopulating the cache. */
export function clearTokenMetadataCache(): void {
  generation++;
  observed.clear();
  pending.clear();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Token metadata read cancelled", "AbortError");
}

function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function decodeDecimals(value: string): number {
  // decimals() is uint8, including its ABI padding. A uint256-sized value must
  // not be truncated to a different scale by a permissive ABI decoder.
  if (value.length !== 66 || BigInt(value) > 255n) throw new Error("Invalid ERC20 decimals return value");
  return Number(BigInt(value));
}

function decodeSymbol(value: string): string {
  if (value.length === 66) {
    // Some older ERC20 contracts expose symbol() as bytes32. Decode the same
    // observed result, removing only trailing ABI null padding.
    const bytes = Uint8Array.from(value.slice(2).match(/../g)!, byte => parseInt(byte, 16));
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
  }
  const [symbol] = decodeAbiParameters(symbolOutput, value as Hex);
  if (encodeAbiParameters(symbolOutput, [symbol]).toLowerCase() !== value.toLowerCase()) {
    throw new Error("Invalid ERC20 symbol return value");
  }
  // This remains an inert text string, including any markup-like characters.
  // Consumers render it as text; metadata never supplies HTML or executable UI.
  return symbol;
}

async function readMetadata(chainId: string, token: string, rpc: BrowserReadRpc, from: string): Promise<Readonly<Asset> | null> {
  try {
    const blockTag = rpcQuantity(await rpc.request(chainId, "eth_blockNumber", []), "block number").toString();
    const input = { chainId, accountId: "main" as const, to: token, blockTag };
    const [decimals, symbol] = await Promise.all([
      browserCallContract({ ...input, data: decimalsSelector }, from, rpc),
      browserCallContract({ ...input, data: symbolSelector }, from, rpc),
    ]);
    return Object.freeze({ chainId, address: token, decimals: decodeDecimals(decimals.result), symbol: decodeSymbol(symbol.result) });
  } catch {
    // ERC20 metadata is optional. A failed observation is neither zero nor an
    // assumed 18-decimal token, and must not hide other successful results.
    return null;
  }
}

function observation(chainId: string, token: string, rpc: BrowserReadRpc, from: string): Promise<Readonly<Asset> | null> {
  const key = identity(chainId, token);
  const cached = observed.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const started = generation;
  // Shared observations use the existing RPC transport deadline. Cancelling a
  // component's wait must not cancel another component's read of the same token.
  const work = readMetadata(chainId, token, rpc, from).then(result => {
    if (result && generation === started) observed.set(key, result);
    return result;
  }).finally(() => {
    if (pending.get(key) === work) pending.delete(key);
  });
  pending.set(key, work);
  return work;
}

/**
 * Read optional token labels/scales for transaction presentation only. Saved
 * asset metadata wins, and no observation is saved to the wallet's asset list.
 * Addresses and exact atomic amounts remain the source of transaction identity.
 */
export async function resolveTokenMetadata(
  chainId: string,
  addresses: readonly string[],
  known: readonly Asset[],
  options: TokenMetadataOptions = {},
): Promise<Asset[]> {
  if (options.signal?.aborted) throw abortReason(options.signal);
  const merged = new Map<string, Asset>();
  for (const asset of known) {
    const key = identity(asset.chainId, asset.address);
    if (!merged.has(key)) merged.set(key, { ...asset });
  }
  if (!/^[1-9][0-9]*$/.test(chainId)) return [...merged.values()];
  const requested = new Map<string, string>();
  for (const value of addresses) {
    try {
      const token = parseAddress(value);
      const lower = token.toLowerCase();
      const key = identity(chainId, token);
      if (lower !== zeroAddress && lower !== nativePlaceholder && !merged.has(key)) requested.set(key, token);
    } catch { /* Invalid decoder references cannot turn into contract reads. */ }
  }
  const rpc = options.rpc ?? browserEvmRpc;
  const from = options.from ?? zeroAddress;
  const results = await waitFor(Promise.all([...requested.values()].map(token => observation(chainId, token, rpc, from))), options.signal);
  for (const result of results) {
    if (result) merged.set(identity(result.chainId, result.address), { ...result });
  }
  return [...merged.values()];
}
