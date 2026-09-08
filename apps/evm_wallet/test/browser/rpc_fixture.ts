/** Deterministic HTTP server substitute for the actual browser RPC transport.
 * The fixture never contacts a chain and has no signing key or real funds. */
import { encodeAbiParameters, keccak256, parseTransaction, type Hex } from "viem";

const calls: Array<{ method: string; params: unknown[]; url: string }> = [];
const gates = new Map<string, { wait: Promise<void>; release: () => void }>();
const nextErrors = new Map<string, string>();
const transactions = new Map<string, Record<string, unknown>>();
const allowanceResults = new Map<string, string | { error: string }>();
const tokenMetadata = new Map<string, { decimals: number; symbol: string }>();
const originalHash = `0x${"ab".repeat(32)}`;
transactions.set(originalHash, { hash: originalHash, from: "0x2222222222222222222222222222222222222222", to: "0x4444444444444444444444444444444444444444", nonce: "0x11", blockHash: null, blockNumber: null, input: "0x", value: "0x38d7ea4c68000" });
const blockNumber = "0x16cbeb2";
const blockHash = `0x${"ee".repeat(32)}`;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.includes("-rpc.publicnode.com") && url !== "https://hyperliquid.drpc.org") throw new Error(`Unexpected browser RPC URL: ${url}`);
  const body = JSON.parse(String(init?.body));
  const method = String(body.method), params = body.params as unknown[];
  calls.push({ method, params: structuredClone(params), url });
  await gates.get(method)?.wait;
  const nextError = nextErrors.get(method);
  if (nextError !== undefined) {
    nextErrors.delete(method);
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: nextError } });
  }
  let result: unknown;
  switch (method) {
    case "eth_chainId": result = url === "https://hyperliquid.drpc.org" ? "0x3e7" : url.includes("arbitrum") ? "0xa4b1" : "0x1"; break;
    case "eth_blockNumber": result = blockNumber; break;
    case "eth_getBlockByNumber": result = { number: blockNumber, hash: blockHash, baseFeePerGas: "0x2363e7f00" }; break;
    case "eth_getBalance": result = "0x112210f47de98115"; break;
    case "eth_getTransactionCount": result = "0x11"; break;
    case "eth_gasPrice": result = "0x4a817c800"; break;
    case "eth_maxPriorityFeePerGas": result = "0x3b9aca00"; break;
    case "eth_estimateGas": result = "0xfde8"; break;
    case "eth_call": {
      const data = String((params[0] as Record<string, unknown>).data ?? "0x");
      const to = String((params[0] as Record<string, unknown>).to ?? "").toLowerCase();
      const allowance = allowanceResults.get(to), metadata = tokenMetadata.get(to);
      if (data.startsWith("0xdd62ed3e") && allowance !== undefined) {
        if (typeof allowance !== "string") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: allowance.error } }), { headers: { "Content-Type": "application/json" } });
        result = allowance; break;
      }
      result = metadata && data === "0x313ce567" ? encodeAbiParameters([{ type: "uint8" }], [metadata.decimals])
        : metadata && data === "0x95d89b41" ? encodeAbiParameters([{ type: "string" }], [metadata.symbol])
        : to === "0x7777777777777777777777777777777777777777" && data === "0x313ce567" ? encodeAbiParameters([{ type: "uint8" }], [8])
        : to === "0x7777777777777777777777777777777777777777" && data === "0x95d89b41" ? encodeAbiParameters([{ type: "string" }], ["NEW"])
        : data.startsWith("0x70a08231") ? `0x${100_000_000n.toString(16).padStart(64, "0")}`
        : data.startsWith("0xdd62ed3e") ? `0x${"0".repeat(64)}` : "0x";
      break;
    }
    case "eth_sendRawTransaction": {
      const raw = String(params[0]) as Hex, tx = parseTransaction(raw), hash = keccak256(raw);
      transactions.set(hash, { hash, from: "0x2222222222222222222222222222222222222222", to: tx.to, nonce: `0x${BigInt(tx.nonce ?? 0).toString(16)}`, blockHash: null, blockNumber: null, input: tx.data ?? "0x", value: `0x${(tx.value ?? 0n).toString(16)}` });
      result = hash;
      break;
    }
    case "eth_getTransactionByHash": result = transactions.get(String(params[0])) ?? null; break;
    case "eth_getTransactionReceipt": result = null; break;
    default: throw new Error(`Unexpected browser RPC method: ${method}`);
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "Content-Type": "application/json" } });
}) as typeof globalThis.fetch;
(window as any).__evmRpcFixture = {
  calls,
  failNext(method: string, message: string) { nextErrors.set(method, message); },
  setAllowanceResult(to: string, result: string | { error: string }) { allowanceResults.set(to.toLowerCase(), result); },
  setTokenMetadata(to: string, decimals: number, symbol: string) { tokenMetadata.set(to.toLowerCase(), { decimals, symbol }); },
  hold(method: string) {
    if (gates.has(method)) throw new Error(`Already held RPC: ${method}`);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    gates.set(method, { wait, release });
  },
  release(method: string) {
    const gate = gates.get(method);
    if (!gate) throw new Error(`Not held RPC: ${method}`);
    gates.delete(method);
    gate.release();
  },
};
