import { afterEach, expect, test } from "bun:test";
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { BrowserReadRpc } from "../src/browser_reads.ts";
import type { BrowserEvmChainId } from "../src/browser_rpc.ts";
import type { Asset, Network, Operation } from "../src/data.ts";
import { presentOperation } from "../src/presentation.ts";
import { parseDecoderPack, type DecoderField } from "../src/decoders/descriptor.ts";
import { clearTokenMetadataCache } from "../src/decoders/metadata.ts";
import type { ActiveDecoderPack } from "../src/decoders/registry.ts";
import { resolveOperationPresentation } from "../src/decoders/runtime.ts";

const token: Address = "0xabababababababababababababababababababab";
const vault: Address = "0x1111111111111111111111111111111111111111";
const owner: Address = "0x2222222222222222222222222222222222222222";
const receiver: Address = "0x3333333333333333333333333333333333333333";
const gateway: Address = "0xd01607c3c5ecaba394d8be377a08590149325722";
const pool: Address = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const network: Network = { chainId: "1", name: "Ethereum", nativeSymbol: "ETH", explorerUrl: "https://etherscan.io", testnet: false, finalityDescription: "" };
const huge = 9007199254740993123456789n;
const abi = parseAbi(["function stakeFor(address asset,uint256 amount,address recipient)"]);
const stakeData = encodeFunctionData({ abi, functionName: "stakeFor", args: [token, huge, receiver] });

function pack(fields: DecoderField[] = [{ path: "args.1", label: "You stake", format: "tokenAmount", tokenPath: "args.0", role: "amount" }]): ActiveDecoderPack {
  return { sha256: "ab".repeat(32), pack: parseDecoderPack({
    format: 1, id: "future-vault", version: "1", name: "Future vault", description: "Exact vault inputs.",
    deployments: [{ chainId: "1", address: vault }, { chainId: "42161", address: vault }],
    functions: [{ signature: "stakeFor(address asset,uint256 amount,address recipient) payable", title: "Stake in future vault", value: "payable", fields }],
  }) };
}
function operation(data: Hex = stakeData, to: Address = vault, chainId = "1"): Operation {
  return { id: "old-operation", kind: "transaction", status: "finalized", chainId, address: owner,
    caller: { appId: "unrelated-app", installationUid: "old-caller", endpoint: "service" },
    intent: { transaction: { to, data, value: "0" } }, preparedTransaction: null,
  } as unknown as Operation;
}
type RpcCall = { chainId: string; method: string; params: readonly unknown[] };
function rpcFixture(fail = false) {
  const calls: RpcCall[] = [];
  const rpc: BrowserReadRpc = { async request<T>(chainId: BrowserEvmChainId, method: string, params: readonly unknown[] = []): Promise<T> {
    calls.push({ chainId: String(chainId), method, params });
    if (fail) throw new Error("Provider unavailable");
    if (method === "eth_blockNumber") return "0x555" as T;
    if (method !== "eth_call") throw new Error(`Presentation attempted non-read RPC ${method}`);
    const tx = params[0] as { to: string; data: string };
    if (tx.to.toLowerCase() !== token) throw new Error("Unexpected metadata destination");
    if (tx.data === "0x313ce567") return encodeAbiParameters([{ type: "uint8" }], [String(chainId) === "1" ? 6 : 8]) as T;
    if (tx.data === "0x95d89b41") return encodeAbiParameters([{ type: "string" }], [String(chainId) === "1" ? "USDX" : "OTHER"]) as T;
    throw new Error("Unexpected contract read");
  } };
  return { rpc, calls };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
afterEach(clearTokenMetadataCache);

test("historical custom-protocol amounts improve asynchronously without changing any saved operation bytes", async () => {
  const op = freeze(operation()), original = JSON.stringify(op), imported = pack(), { rpc, calls } = rpcFixture();
  expect(presentOperation(op, [], network, [imported]).amount).toBe(`${huge} atomic units`);
  const shown = await resolveOperationPresentation(op, [], network, { packs: [imported], rpc });
  expect(shown).toMatchObject({ title: "Stake in future vault", amount: "9007199254740993123.456789 USDX", amountAtoms: huge.toString(), amountDecimals: 6, tokenSymbol: "USDX" });
  expect(shown.decoder?.id).toBe("future-vault");
  expect(JSON.stringify(op)).toBe(original);
  expect(calls.filter(call => call.method === "eth_call")).toHaveLength(2);
  expect(calls.every(call => call.method === "eth_call" || call.method === "eth_blockNumber")).toBe(true);
});

test("unknown metadata remains exact raw atomic units without a fabricated decimal scale", async () => {
  const imported = pack(), { rpc } = rpcFixture(true);
  const shown = await resolveOperationPresentation(operation(), [], network, { packs: [imported], rpc });
  expect(shown.amount).toBe(`${huge} atomic units`);
  expect(shown.amountAtoms).toBe(huge.toString());
  expect(shown.amountDecimals).toBeUndefined();
  expect(shown.tokenSymbol).toBeNull();
  expect(shown.decoder?.kind).toBe("imported");
});

test("ERC20 activity receives the same asynchronous labels and exact quantities as protocol activity", async () => {
  const transfer = encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [receiver, huge] });
  const { rpc } = rpcFixture();
  const shown = await resolveOperationPresentation(operation(transfer, token), [], network, { rpc });
  expect(shown).toMatchObject({ title: "Send USDX", amount: "9007199254740993123.456789 USDX", amountAtoms: huge.toString(), amountDecimals: 6 });
});

test("saved custom token metadata is honored without extra reads or asset mutation", async () => {
  const known: readonly Asset[] = freeze([{ chainId: "1", address: token, decimals: 3, symbol: "MY TOKEN" }]);
  const { rpc, calls } = rpcFixture();
  const shown = await resolveOperationPresentation(operation(), known, network, { packs: [pack()], rpc });
  expect(shown).toMatchObject({ amount: "9007199254740993123456.789 MY TOKEN", amountDecimals: 3 });
  expect(calls).toEqual([]);
  expect(known).toEqual([{ chainId: "1", address: token, decimals: 3, symbol: "MY TOKEN" }]);
});

test("same-address tokens on different chains receive independent metadata and wrong destinations trigger none", async () => {
  const { rpc, calls } = rpcFixture(), imported = pack();
  const eth = await resolveOperationPresentation(operation(), [], network, { packs: [imported], rpc });
  const arb = await resolveOperationPresentation(operation(stakeData, vault, "42161"), [], { ...network, chainId: "42161" }, { packs: [imported], rpc });
  expect(eth.amountDecimals).toBe(6); expect(eth.tokenSymbol).toBe("USDX");
  expect(arb.amountDecimals).toBe(8); expect(arb.tokenSymbol).toBe("OTHER");
  expect(arb.amount).toBe("90071992547409931.23456789 OTHER");
  const count = calls.length;
  const unrelated = await resolveOperationPresentation(operation(stakeData, receiver), [], network, { packs: [imported], rpc });
  expect(unrelated.title).toBe("Contract interaction");
  expect(calls).toHaveLength(count);
});

test("ambiguous imported matches do not read token metadata for an arbitrarily chosen pack", async () => {
  const first = pack(), second = { ...first, pack: parseDecoderPack({ ...first.pack, id: "other-vault", name: "Other vault" }) };
  const { rpc, calls } = rpcFixture();
  const shown = await resolveOperationPresentation(operation(), [], network, { packs: [first, second], rpc });
  expect(shown.title).toBe("Contract interaction");
  expect(shown.decoderWarning).toContain("Multiple enabled decoder packs");
  expect(shown.amountAtoms).toBeUndefined();
  expect(calls).toEqual([]);
});

test("an imported integer primary does not acquire native-currency identity or decimals", async () => {
  const imported = pack([{ path: "args.1", label: "Position ID", format: "integer", role: "amount" }]);
  const { rpc, calls } = rpcFixture();
  const shown = await resolveOperationPresentation(operation(), [], network, { packs: [imported], rpc });
  expect(shown.amount).toBe(huge.toString());
  expect(shown.amountAtoms).toBeUndefined();
  expect(shown.tokenAddress).toBeUndefined();
  expect(shown.amountDecimals).toBeUndefined();
  expect(calls).toEqual([]);
});

test("a native primary exposes exact wei and avoids repeating the same transaction payment", async () => {
  const imported = pack([{ path: "transaction.value", label: "You deposit", format: "nativeAmount", role: "amount" }]);
  const op = operation(); op.intent.transaction!.value = "1234567890123456789";
  const { rpc, calls } = rpcFixture();
  const shown = await resolveOperationPresentation(op, [], network, { packs: [imported], rpc });
  expect(shown).toMatchObject({ amount: "1.234567890123456789 ETH", amountAtoms: "1234567890123456789", amountDecimals: 18, tokenAddress: null, nativeValue: null });
  expect(calls).toEqual([]);
});

test("a distinct native payment remains visible when the primary amount comes from calldata", async () => {
  const imported = pack([{ path: "args.1", label: "You withdraw", format: "nativeAmount", role: "amount" }]);
  const op = operation(); op.intent.transaction!.value = "1234567890123456789";
  const { rpc } = rpcFixture();
  const shown = await resolveOperationPresentation(op, [], network, { packs: [imported], rpc });
  expect(shown.amount).toBe("9007199.254740993123456789 ETH");
  expect(shown.amountAtoms).toBe(huge.toString());
  expect(shown.nativeValue).toBe("1.234567890123456789 ETH");
});

test("Aave native borrow and withdrawal expose their received quantity rather than zero transaction value", async () => {
  const abi = parseAbi(["function borrowETH(address,uint256,uint16)", "function withdrawETH(address,uint256,address)"]);
  const { rpc, calls } = rpcFixture();
  for (const data of [
    encodeFunctionData({ abi, functionName: "borrowETH", args: [pool, 1234567890123456789n, 0] }),
    encodeFunctionData({ abi, functionName: "withdrawETH", args: [pool, 1234567890123456789n, owner] }),
  ]) {
    const shown = await resolveOperationPresentation(operation(data, gateway), [], network, { rpc });
    expect(shown).toMatchObject({ amount: "1.234567890123456789 ETH", amountAtoms: "1234567890123456789", amountDecimals: 18, tokenAddress: null });
    expect(shown.decoder?.id).toBe("aave-v3");
  }
  expect(calls).toEqual([]);
});
