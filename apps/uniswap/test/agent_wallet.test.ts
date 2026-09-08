import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { JsonValue, MsgBusCallOptions, MsgBusToolCall, MsgBusToolContext } from "neutron-tools/app";
import { EVM_WALLET_TOOLS, type EvmSendTransactionRequest } from "neutron-tools/evm_wallet";
import { createServiceWallet } from "../src/agent_wallet.ts";

const address = "0x1111111111111111111111111111111111111111";
const account = { accountId: "main", address, publicKey: `0x02${"dd".repeat(32)}`, keyFingerprint: `0x${"ee".repeat(32)}`, namespaceVersion: "1" };
const request = (digit: string): EvmSendTransactionRequest => ({ requestId: digit.repeat(32), accountId: "main", chainId: "1", to: address, valueWei: "1", data: "0x" });
const result = (call: MsgBusToolCall): JsonValue => ({ requestId: call.arguments!.requestId!, accountId: "main", chainId: "1", operationId: "1", kind: "transaction", status: "prepared", address, transactionHash: null, signature: null, message: null, reviewRevision: "1", receipt: null });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function context(call: (call: MsgBusToolCall, options?: number | MsgBusCallOptions) => Promise<JsonValue>, signal?: AbortSignal): MsgBusToolContext {
  const kernel = { async callTool(input: MsgBusToolCall, options?: number | MsgBusCallOptions) {
    expect(this).toBe(kernel);
    return call(input, options);
  } };
  return { kernel: kernel as MsgBusToolContext["kernel"], agentMode: true, ...(signal ? { signal } : {}), reportProgress() {} };
}

test("Agent account and position contract reads dispatch together using their install grants", async () => {
  const held = barrier(), calls: MsgBusToolCall[] = [];
  const wallet = createServiceWallet(context(async (call) => {
    calls.push(call);
    await held.promise;
    if (call.name === EVM_WALLET_TOOLS.accounts) return { accounts: [account] };
    return { ...call.arguments, address, result: "0x", blockNumber: "200", observedAtNs: "1000" };
  }));
  const accounts = wallet.accounts();
  const position = wallet.callContract({ accountId: "main", chainId: "1", to: address, data: "0x" });
  expect(calls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.callContract]);
  const manifest = JSON.parse(readFileSync(new URL("../neutron.json", import.meta.url), "utf8"));
  const grant = manifest.capabilities.frontend_tools.targets.find((target: { app: string }) => target.app === "evm_wallet");
  for (const call of calls) expect(grant.tools).toContain(call.name);
  held.release();
  await Promise.all([accounts, position]);
});

test("Agent auto-route read fanout waits for available nested-call slots", async () => {
  // Auto compares four V3 tiers and four V4 pool candidates. The Kernel already
  // accepts four active child calls, including installation-approved reads.
  const held = barrier(), entered = barrier();
  let active = 0, maximum = 0, calls = 0;
  const wallet = createServiceWallet(context(async (call) => {
    active += 1; calls += 1; maximum = Math.max(maximum, active);
    if (active === 4) entered.release();
    try {
      if (active > 4) throw new Error("Too many parallel agent calls");
      await held.promise;
      return { ...call.arguments, address, result: "0x", blockNumber: "200", observedAtNs: "1000" };
    } finally { active -= 1; }
  }));
  const results = Promise.all(Array.from({ length: 8 }, () => wallet.callContract({ accountId: "main", chainId: "1", to: address, data: "0x" }))).catch((error: Error) => error);
  await entered.promise;
  expect(calls).toBe(4);
  held.release();
  expect(await results).toHaveLength(8);
  expect(maximum).toBe(4);
  expect(calls).toBe(8);
});

test("Agent provider effects serialize while installed reads continue, and a rejected effect releases the queue", async () => {
  const held = barrier(), entered = barrier(), calls: MsgBusToolCall[] = [];
  const wallet = createServiceWallet(context(async (call) => {
    calls.push(call);
    if (call.name === EVM_WALLET_TOOLS.accounts) return { accounts: [account] };
    if (call.arguments!.requestId === request("a").requestId) {
      entered.release();
      await held.promise;
      throw new Error("Provider review rejected");
    }
    return result(call);
  }));
  const first = wallet.sendTransaction(request("a")).catch((error: Error) => error);
  await entered.promise;
  const second = wallet.sendTransaction(request("b"));
  await wallet.accounts();
  expect(calls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.sendTransaction, EVM_WALLET_TOOLS.accounts]);
  held.release();
  expect(await first).toMatchObject({ message: "Provider review rejected" });
  expect(await second).toMatchObject({ requestId: request("b").requestId, status: "prepared" });
  expect(calls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.sendTransaction, EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.sendTransaction]);
});

test.each(["context", "request"])("queued Agent effects never dispatch after %s cancellation", async (source) => {
  const controller = new AbortController(), held = barrier(), entered = barrier();
  const calls: MsgBusToolCall[] = [], transports: (number | MsgBusCallOptions | undefined)[] = [];
  const wallet = createServiceWallet(context(async (call, options) => {
    calls.push(call); transports.push(options); entered.release();
    await held.promise;
    return result(call);
  }, source === "context" ? controller.signal : undefined));
  const onProgress = () => {};
  const first = wallet.sendTransaction(request("a"), { timeout: 4321, onProgress });
  await entered.promise;
  const queued = wallet.sendTransaction(request("b"), source === "request" ? { signal: controller.signal } : undefined).catch((error: Error) => error);
  controller.abort(new Error("Stop before the next wallet effect"));
  held.release();
  await first;
  expect(await queued).toMatchObject({ message: "Stop before the next wallet effect" });
  expect(calls).toHaveLength(1);
  expect(transports).toEqual([{ timeout: 4321, onProgress, ...(source === "context" ? { signal: controller.signal } : {}) }]);
});
