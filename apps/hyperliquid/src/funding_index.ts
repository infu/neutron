import { FUNDING_CHAINS, type FundingChainId } from "./funding_protocol.ts";

const INDEX_ORIGINS: Record<FundingChainId, string> = {
  "1": "https://eth.blockscout.com",
  "42161": "https://arbitrum.blockscout.com",
};
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ADDRESS = /^0x[\da-f]{40}$/i;
const HASH = /^0x[\da-f]{64}$/i;

type Cursor = { block: bigint; index: bigint };
type MintSearch = { chainId: FundingChainId; recipient: string; amountAtoms: string; fromBlock: string };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function unsignedInteger(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

function cursor(value: unknown): Cursor | null {
  if (value === null) return null;
  const row = object(value), block = unsignedInteger(row?.block_number), index = unsignedInteger(row?.index);
  if (!row || block === null || index === null) throw new Error("Invalid withdrawal index pagination cursor.");
  // Only these documented numeric fields become query parameters. Never follow
  // an index-provided URL or allow it to override the recipient/token filters.
  return { block, index };
}

/** Discover transaction hash hints when the destination RPC cannot serve old
 * logs. The index is not settlement evidence: every candidate must still pass
 * the canonical RPC receipt and original CCTP-message verification.
 * https://docs.blockscout.com/api-reference/get-address-token-transfers */
export async function* indexedWithdrawalMintCandidates(
  input: MintSearch,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): AsyncGenerator<string[]> {
  const origin = Object.hasOwn(INDEX_ORIGINS, input.chainId) ? INDEX_ORIGINS[input.chainId] : undefined;
  const amount = unsignedInteger(input.amountAtoms);
  const fromBlock = /^0x[\da-f]+$/i.test(input.fromBlock) ? BigInt(input.fromBlock) : unsignedInteger(input.fromBlock);
  if (!origin || !ADDRESS.test(input.recipient) || amount === null || amount <= 0n || fromBlock === null) {
    throw new Error("Invalid withdrawal index search identity.");
  }
  const recipient = input.recipient.toLowerCase(), usdc = FUNDING_CHAINS[input.chainId].usdc;
  const seen = new Set<string>();
  let previous: Cursor | null = null;
  while (true) {
    signal?.throwIfAborted();
    const url = new URL(`/api/v2/addresses/${recipient}/token-transfers`, origin);
    url.searchParams.set("type", "ERC-20");
    url.searchParams.set("filter", "to");
    url.searchParams.set("token", usdc);
    if (previous) {
      url.searchParams.set("block_number", previous.block.toString());
      url.searchParams.set("index", previous.index.toString());
    }
    const timeout = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetcher.call(globalThis, url.toString(), {
      method: "GET", credentials: "omit", redirect: "error", signal: requestSignal,
    });
    if (!response.ok) throw new Error(`Withdrawal destination index request failed (HTTP ${response.status}).`);
    const page = object(await response.json());
    requestSignal.throwIfAborted();
    if (!page || !Array.isArray(page.items)) throw new Error("Invalid withdrawal destination index page.");
    const next = cursor(page.next_page_params);
    if (previous && next && (next.block > previous.block || (next.block === previous.block && next.index >= previous.index))) {
      throw new Error("Withdrawal destination index pagination did not advance.");
    }
    const hashes: string[] = [];
    let passedFromBlock = false;
    for (const value of page.items) {
      const row = object(value), block = unsignedInteger(row?.block_number);
      if (block === null) continue;
      if (block < fromBlock) { passedFromBlock = true; continue; }
      const token = object(row?.token), from = object(row?.from), to = object(row?.to), total = object(row?.total);
      const atoms = unsignedInteger(total?.value), hash = row?.transaction_hash;
      if (typeof token?.address_hash !== "string" || token.address_hash.toLowerCase() !== usdc
        || typeof from?.hash !== "string" || from.hash.toLowerCase() !== ZERO_ADDRESS
        || typeof to?.hash !== "string" || to.hash.toLowerCase() !== recipient
        || atoms === null || atoms <= 0n || atoms > amount
        || typeof hash !== "string" || !HASH.test(hash)) continue;
      const normalized = hash.toLowerCase();
      if (!seen.has(normalized)) { seen.add(normalized); hashes.push(normalized); }
    }
    yield hashes;
    if (passedFromBlock || !next || next.block < fromBlock) return;
    previous = next;
  }
}
