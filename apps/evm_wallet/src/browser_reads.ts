import {
  parseEvmBalancesRequest, parseEvmBalancesResult,
  parseEvmCallContractRequest, parseEvmCallContractResult,
  parseEvmReadContractRequest, parseEvmReadContractResult,
  parseEvmEstimateTransactionRequest, parseEvmEstimateTransactionResult,
  parseEvmTransactionRequest, parseEvmTransactionResult, parseEvmReceipt,
  type EvmBalancesRequest, type EvmCallContractRequest, type EvmReadContractRequest,
  type EvmEstimateTransactionRequest, type EvmEstimateTransactionResult,
  type EvmTransactionRequest, type EvmReceipt,
} from "neutron-tools/evm_wallet";
import { BrowserEvmRpcError, browserEvmRpc } from "./browser_rpc.ts";
import { address as parseAddress, hex, record, errorMessage, type Asset } from "./data.ts";

export type BrowserReadRpc = Pick<typeof browserEvmRpc, "request">;
const uint256Limit = 1n << 256n;
const observedAt = () => (BigInt(Date.now()) * 1_000_000n).toString();
export function rpcQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`Invalid RPC ${label}`);
  const result = BigInt(value);
  if (result >= uint256Limit) throw new Error(`RPC ${label} exceeds uint256`);
  return result;
}
const quantityHex = (value: bigint) => `0x${value.toString(16)}`;
function hash(value: unknown, label: string): string {
  const result = hex(value, label).toLowerCase();
  if (result.length !== 66) throw new Error(`Invalid ${label}`);
  return result;
}
function sameHash(value: unknown, expected: string, label: string): void {
  if (hash(value, label) !== expected.toLowerCase()) throw new Error(`RPC returned a mismatched ${label}`);
}
async function blockNumber(chainId: string, requested: string | undefined, rpc: BrowserReadRpc): Promise<bigint> {
  return requested === undefined || requested === "latest"
    ? rpcQuantity(await rpc.request(chainId, "eth_blockNumber", []), "block number")
    : BigInt(requested);
}

async function latestObservation<T>(chainId: string, rpc: BrowserReadRpc, read: (block: bigint) => Promise<T>): Promise<T> {
  const block = await blockNumber(chainId, undefined, rpc);
  try {
    return await read(block);
  } catch (error) {
    if (!(error instanceof BrowserEvmRpcError) || !/\bheader not found\b/i.test(error.message)) throw error;
    // Public RPC backends can disagree briefly about the latest available
    // header. Discard every partial result, resolve the head again and replay
    // this read once. Keep each result pinned; never substitute another block
    // for an explicitly requested historical read or retry a transaction.
    return read(await blockNumber(chainId, undefined, rpc));
  }
}

export async function browserCallContract(input: EvmCallContractRequest, address: string, rpc: BrowserReadRpc = browserEvmRpc) {
  const request = parseEvmCallContractRequest(input);
  const from = parseAddress(address);
  const read = async (block: bigint) => {
    const result = hex(await rpc.request(request.chainId, "eth_call", [{ from, to: request.to, data: request.data }, quantityHex(block)]), "contract return bytes");
    return parseEvmCallContractResult({ accountId: request.accountId, chainId: request.chainId, address: from,
      to: request.to, data: request.data, result, blockNumber: block.toString(), observedAtNs: observedAt() }, request);
  };
  return request.blockTag === undefined || request.blockTag === "latest"
    ? latestObservation(request.chainId, rpc, read)
    : read(BigInt(request.blockTag));
}

export async function browserReadContract(input: EvmReadContractRequest, address: string, rpc: BrowserReadRpc = browserEvmRpc) {
  const request = parseEvmReadContractRequest(input);
  return latestObservation(request.chainId, rpc, async (block) => {
    const result = await browserCallContract({ ...request, blockTag: block.toString() }, address, rpc);
    const code = hex(await rpc.request(request.chainId, "eth_getCode", [request.to, quantityHex(block)]), "contract code");
    return parseEvmReadContractResult({ ...result, code, observedAtNs: observedAt() }, request);
  });
}

export async function browserBalances(input: EvmBalancesRequest, address: string, assets: readonly Asset[] = [], rpc: BrowserReadRpc = browserEvmRpc) {
  const request = parseEvmBalancesRequest(input), from = parseAddress(address);
  const block = quantityHex(await blockNumber(request.chainId, undefined, rpc));
  const [nativeBalance, tokens] = await Promise.all([
    rpc.request(request.chainId, "eth_getBalance", [from, block]).then((value) => rpcQuantity(value, "native balance").toString()),
    Promise.all(request.tokens.map(async (token) => {
      const known = assets.find((asset) => asset.chainId === request.chainId && asset.address.toLowerCase() === token);
      const metadata = { address: token, decimals: known ? String(known.decimals) : null, symbol: known?.symbol ?? null };
      try {
        const data = `0x70a08231${from.slice(2).toLowerCase().padStart(64, "0")}`;
        const word = hex(await rpc.request(request.chainId, "eth_call", [{ to: token, data }, block]), "token balance");
        if (word.length !== 66) throw new Error("ERC20 balanceOf returned an invalid uint256 word");
        return { ...metadata, balanceAtoms: BigInt(word).toString(), error: null };
      } catch (error) {
        return { ...metadata, balanceAtoms: null, error: errorMessage(error) };
      }
    })),
  ]);
  return parseEvmBalancesResult({ accountId: request.accountId, chainId: request.chainId, address: from,
    nativeBalanceWei: nativeBalance, tokens, blockNumber: BigInt(block).toString(), observedAtNs: observedAt(), completeness: "requested_only" }, request);
}

/** Read-only estimates: failed simulation keeps any independently obtained fee facts. */
export async function browserEstimateTransaction(input: EvmEstimateTransactionRequest, address: string, rpc: BrowserReadRpc = browserEvmRpc) {
  const request = parseEvmEstimateTransactionRequest(input), from = parseAddress(address), reasons: string[] = [];
  const read = async <T>(method: string, params: unknown[], parse: (value: unknown) => T): Promise<T | null> => {
    try { return parse(await rpc.request(request.chainId, method, params)); }
    catch (error) { reasons.push(`${method}: ${errorMessage(error)}`); return null; }
  };
  let number: bigint | null = null, base: bigint | null = null;
  const [block, gasPrice, priority] = await Promise.all([
    read("eth_getBlockByNumber", ["latest", false], (value) => record(value, "latest block")),
    read("eth_gasPrice", [], (value) => rpcQuantity(value, "gas price")),
    request.chainId === "42161" ? Promise.resolve(0n) : read("eth_maxPriorityFeePerGas", [], (value) => rpcQuantity(value, "priority fee")),
  ]);
  if (block) {
    try { number = rpcQuantity(block.number, "block number"); } catch (error) { reasons.push(errorMessage(error)); }
    try { base = rpcQuantity(block.baseFeePerGas, "base fee"); } catch (error) { reasons.push(errorMessage(error)); }
  }
  const gas = await read("eth_estimateGas", [{ from, to: request.to, value: quantityHex(BigInt(request.valueWei)), data: request.data }, number === null ? "latest" : quantityHex(number)], (value) => {
    const gas = rpcQuantity(value, "gas estimate");
    if (gas === 0n) throw new Error("Returned zero gas for a transaction");
    return gas;
  });
  let maximumPrice: bigint | null = null, effectivePrice: bigint | null = null;
  let feeBasis: EvmEstimateTransactionResult["feeBasis"];
  if (request.chainId === "42161") {
    feeBasis = "arbitrum_total_gas";
    effectivePrice = gasPrice ?? base;
    if (base !== null) maximumPrice = base * 2n;
  } else {
    feeBasis = "base_fee_plus_priority";
    if (base !== null && priority !== null) {
      effectivePrice = base + priority;
      maximumPrice = base * 2n + priority;
    }
    if (effectivePrice === null || effectivePrice >= uint256Limit) { effectivePrice = gasPrice; feeBasis = "gas_price"; }
  }
  if (maximumPrice !== null && maximumPrice >= uint256Limit) { maximumPrice = null; reasons.push("Suggested maximum fee per gas exceeds uint256"); }
  const estimatedFee = gas !== null && effectivePrice !== null ? gas * effectivePrice : null;
  const maximumFee = gas !== null && maximumPrice !== null ? gas * maximumPrice : null;
  if (estimatedFee === null && reasons.length === 0) reasons.push("Complete gas and fee observations are unavailable");
  const decimal = (value: bigint | null) => value === null ? null : value.toString();
  return parseEvmEstimateTransactionResult({ ...request, address: from,
    status: estimatedFee === null ? "unavailable" : "available", gasLimit: decimal(gas), gasPriceWei: decimal(gasPrice),
    baseFeePerGasWei: decimal(base), maxPriorityFeePerGasWei: decimal(priority), maxFeePerGasWei: decimal(maximumPrice),
    estimatedFeeWei: decimal(estimatedFee), maximumFeeWei: decimal(maximumFee), blockNumber: decimal(number), observedAtNs: observedAt(),
    feeBasis: estimatedFee === null ? "unavailable" : feeBasis,
    postingCosts: request.chainId !== "42161" ? "not_applicable" : gas === null ? "unavailable" : "included", reasons,
    // The released protocol label means Ethereum JSON-RPC evidence. Transport
    // now runs directly in the browser; it is not an IC EVM RPC canister claim.
    source: "evm_rpc",
  }, request);
}

export async function browserTransaction(input: EvmTransactionRequest, walletRequestMatches: boolean | null = null, rpc: BrowserReadRpc = browserEvmRpc) {
  const request = parseEvmTransactionRequest(input);
  const [rawTransaction, rawReceipt] = await Promise.all([
    rpc.request(request.chainId, "eth_getTransactionByHash", [request.transactionHash]),
    rpc.request(request.chainId, "eth_getTransactionReceipt", [request.transactionHash]),
  ]);
  const at = observedAt();
  let transaction = null, receipt: EvmReceipt | null = null;
  if (rawTransaction !== null) {
    const tx = record(rawTransaction, "transaction");
    sameHash(tx.hash, request.transactionHash, "transaction hash");
    if (tx.chainId != null && rpcQuantity(tx.chainId, "transaction chain").toString() !== request.chainId) throw new Error("RPC returned a mismatched transaction chain");
    transaction = { from: parseAddress(tx.from), to: tx.to === null ? null : parseAddress(tx.to),
      data: hex(tx.input), valueWei: rpcQuantity(tx.value, "transaction value").toString(), nonce: rpcQuantity(tx.nonce, "transaction nonce").toString(),
      blockNumber: tx.blockNumber === null ? null : rpcQuantity(tx.blockNumber, "transaction block").toString(), blockHash: tx.blockHash === null ? null : hash(tx.blockHash, "transaction block hash") };
  }
  if (rawReceipt !== null) {
    const raw = record(rawReceipt, "receipt");
    sameHash(raw.transactionHash, request.transactionHash, "receipt transaction hash");
    const number = rpcQuantity(raw.blockNumber, "receipt block"), blockHash = hash(raw.blockHash, "receipt block hash");
    const canonical = record(await rpc.request(request.chainId, "eth_getBlockByNumber", [quantityHex(number), false]), "canonical receipt block");
    sameHash(canonical.hash, blockHash, "canonical receipt block hash");
    if (rpcQuantity(canonical.number, "canonical block number") !== number) throw new Error("RPC returned a mismatched canonical block number");
    let finality: EvmReceipt["finality"] = "included";
    const heads = await Promise.allSettled(["safe", "finalized"].map((tag) => rpc.request(request.chainId, "eth_getBlockByNumber", [tag, false])));
    heads.forEach((head, index) => {
      if (head.status === "fulfilled" && head.value !== null) {
        try { if (rpcQuantity(record(head.value, "finality head").number, "finality head") >= number) finality = index === 1 ? "finalized" : "safe"; } catch { /* Unsupported finality leaves inclusion evidence intact. */ }
      }
    });
    const status = rpcQuantity(raw.status, "receipt status");
    if (status > 1n) throw new Error("Unexpected receipt execution status");
    if (!Array.isArray(raw.logs)) throw new Error("Invalid receipt logs");
    receipt = parseEvmReceipt({ blockNumber: number.toString(), blockHash, status: status === 1n ? "success" : "reverted",
      gasUsed: rpcQuantity(raw.gasUsed, "gas used").toString(), effectiveGasPriceWei: rpcQuantity(raw.effectiveGasPrice, "effective gas price").toString(),
      logs: raw.logs.map((value) => { const log = record(value, "receipt log");
        if (log.removed === true) throw new Error("Receipt contains a removed log");
        if (log.transactionHash !== undefined) sameHash(log.transactionHash, request.transactionHash, "log transaction hash");
        if (log.blockHash !== undefined) sameHash(log.blockHash, blockHash, "log block hash");
        if (log.blockNumber !== undefined && rpcQuantity(log.blockNumber, "log block") !== number) throw new Error("Receipt log block mismatch");
        if (!Array.isArray(log.topics)) throw new Error("Invalid receipt topics");
        return { address: parseAddress(log.address), data: hex(log.data), topics: log.topics.map((topic) => hash(topic, "log topic")), logIndex: rpcQuantity(log.logIndex, "log index").toString() };
      }), finality, observedAtNs: at });
  }
  return parseEvmTransactionResult({ chainId: request.chainId, transactionHash: request.transactionHash, transaction, receipt,
    walletRequestMatches, observedAtNs: at, source: "evm_rpc" }, request);
}
