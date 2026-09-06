import { expect, test } from "bun:test";
import {
  BrowserEvmRpcError,
  createBrowserEvmRpc,
  DEFAULT_EVM_RPC_ENDPOINTS,
} from "../src/browser_rpc.ts";

type Call = { url: string; init: RequestInit; body: { id: string; method: string; params: unknown[] } };
function fixture(reply: (call: Call) => unknown | Promise<unknown> = () => "0x20000000000001") {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init, body: JSON.parse(String(init.body)) } as Call;
    calls.push(call);
    const result = call.body.method === "eth_chainId" ? "0x1" : await reply(call);
    if (result instanceof Response) return result;
    return Response.json({ jsonrpc: "2.0", id: call.body.id, result });
  }) as typeof globalThis.fetch;
  return { calls, fetch, rpc: createBrowserEvmRpc({ fetch }) };
}

test("browser RPC uses one direct provider, verifies its chain once and preserves exact hex quantities", async () => {
  const { rpc, calls } = fixture();
  const [first, second] = await Promise.all([
    rpc.request("1", "eth_getBalance", ["0x1234", "0x100"]),
    rpc.request(1n, "eth_getTransactionCount", ["0x1234", "pending"]),
  ]);
  expect(first).toBe("0x20000000000001");
  expect(second).toBe("0x20000000000001");
  expect(await rpc.request<string>(1, "eth_chainId")).toBe("0x1");
  expect(calls.map((call) => call.body.method)).toEqual(["eth_chainId", "eth_getBalance", "eth_getTransactionCount"]);
  expect(calls[1]!.body.params).toEqual(["0x1234", "0x100"]);
  expect(new Set(calls.map((call) => call.body.id)).size).toBe(calls.length);
  for (const call of calls) {
    expect(call.url).toBe(DEFAULT_EVM_RPC_ENDPOINTS["1"]!);
    expect(call.init).toMatchObject({ method: "POST", mode: "cors", credentials: "omit", headers: { "Content-Type": "application/json" } });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(Array.isArray(JSON.parse(String(call.init.body)))).toBe(false);
  }
});

test("browser RPC endpoints can be configured without extensions or API keys", async () => {
  const { fetch, calls } = fixture();
  const rpc = createBrowserEvmRpc({ fetch, endpoints: { "1": "http://127.0.0.1:8545" } });
  await rpc.request("1", "eth_blockNumber");
  expect(calls.every((call) => call.url === "http://127.0.0.1:8545")).toBe(true);
  expect(rpc.endpoint(42161)).toBe("https://arbitrum-one-rpc.publicnode.com");
  expect(rpc.endpoint(11155111)).toBe("https://ethereum-sepolia-rpc.publicnode.com");
  expect(() => rpc.endpoint("999")).toThrow("No browser RPC endpoint");
  expect(() => rpc.endpoint(Number.MAX_SAFE_INTEGER + 1)).toThrow("exact integer");
});

test("a wrong-chain endpoint cannot read or broadcast under the requested chain", async () => {
  const { rpc, calls } = fixture();
  await expect(rpc.request("42161", "eth_sendRawTransaction", ["0x1234"])).rejects.toThrow("does not match requested chain 42161");
  expect(calls.map((call) => call.body.method)).toEqual(["eth_chainId"]);
  await expect(rpc.request("42161", "eth_getBalance", ["0x1234", "latest"])).rejects.toThrow("does not match");
  expect(calls.map((call) => call.body.method)).toEqual(["eth_chainId", "eth_chainId"]);
  await rpc.request("1", "eth_blockNumber");
  expect(calls.at(-1)?.body.method).toBe("eth_blockNumber");
});

test("concurrent chain sessions cannot reuse validation from another endpoint", async () => {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit) => {
    const { id, method } = JSON.parse(String(init.body));
    const isArbitrum = String(input).includes("arbitrum");
    calls.push(`${isArbitrum ? "42161" : "1"}:${method}`);
    return Response.json({ jsonrpc: "2.0", id, result: method === "eth_chainId" ? isArbitrum ? "0xa4b1" : "0x1" : "0x2" });
  }) as typeof globalThis.fetch;
  const rpc = createBrowserEvmRpc({ fetch });
  await Promise.all([rpc.request(1, "eth_blockNumber"), rpc.request(42161, "eth_blockNumber")]);
  expect([...calls].sort()).toEqual(["1:eth_blockNumber", "1:eth_chainId", "42161:eth_blockNumber", "42161:eth_chainId"]);
});

test("JSON-RPC errors preserve the code and revert data", async () => {
  const { rpc } = fixture(({ body }) => Response.json({
    jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted", data: "0x1234" },
  }));
  try {
    await rpc.request("1", "eth_call", [{ to: "0x1234", data: "0xab" }, "0x100"]);
    throw new Error("Expected an RPC error");
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserEvmRpcError);
    expect(error).toMatchObject({ code: 3, data: "0x1234" });
    expect(String(error)).toContain("execution reverted");
  }
});

test("RPC envelopes reject response ID mismatch, wrong versions, batches and ambiguous results", async () => {
  const cases = [
    { jsonrpc: "2.0", id: "different", result: "0x2" },
    { jsonrpc: "1.0", result: "0x2" },
    { jsonrpc: "2.0" },
    { jsonrpc: "2.0", result: "0x2", error: { code: 3, message: "error" } },
    { jsonrpc: "2.0", error: { code: "3", message: "error" } },
    [{ jsonrpc: "2.0", result: "0x2" }],
  ];
  for (const value of cases) {
    const { rpc } = fixture(({ body }) => Response.json(Array.isArray(value) ? value : { id: body.id, ...value }));
    await expect(rpc.request(1, "eth_blockNumber")).rejects.toBeInstanceOf(BrowserEvmRpcError);
  }
});

test("a null receipt remains null, rather than an error or an invented zero", async () => {
  const { rpc } = fixture(() => null);
  expect(await rpc.request(1, "eth_getTransactionReceipt", ["0x1234"])).toBeNull();
});

test("non-JSON, HTTP and network failures produce readable errors and never retry", async () => {
  const variants = [
    { reply: () => new Response("<html>provider error</html>"), expected: "non-JSON response" },
    { reply: () => new Response("unavailable", { status: 503 }), expected: "HTTP 503" },
    { reply: () => { throw new TypeError("Failed to fetch"); }, expected: "could not reach the provider" },
  ];
  for (const variant of variants) {
    const { rpc, calls } = fixture(variant.reply);
    await expect(rpc.request(1, "eth_getBalance", ["0x1234", "latest"])).rejects.toThrow(variant.expected);
    expect(calls.map((call) => call.body.method)).toEqual(["eth_chainId", "eth_getBalance"]);
  }
});

test("a broadcast with a lost reply is attempted exactly once, including through viem", async () => {
  const { rpc, calls } = fixture(() => { throw new TypeError("Connection closed after request was sent"); });
  await expect(rpc.request(1, "eth_sendRawTransaction", ["0x1234"])).rejects.toThrow("Connection closed");
  expect(calls.filter((call) => call.body.method === "eth_sendRawTransaction")).toHaveLength(1);
  const client = rpc.getClient(1);
  expect(rpc.getClient("1")).toBe(client);
  await expect(client.request({ method: "eth_sendRawTransaction", params: ["0x5678"] })).rejects.toThrow("Connection closed");
  expect(calls.filter((call) => call.body.method === "eth_sendRawTransaction")).toHaveLength(2);
  expect(calls.filter((call) => call.body.method === "eth_chainId")).toHaveLength(1);
});

test("already cancelled requests do not contact a provider", async () => {
  const { rpc, calls } = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(rpc.request(1, "eth_blockNumber", [], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toHaveLength(0);
});

test("cancelling a pending read aborts its fetch immediately", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let fetchSignal: AbortSignal | null | undefined;
  const { rpc } = fixture((call) => {
    fetchSignal = call.init.signal;
    started();
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const pending = rpc.request(1, "eth_getBalance", ["0x1234", "latest"], { signal: controller.signal });
  await ready;
  controller.abort(new DOMException("Cancelled by user", "AbortError"));
  await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "Cancelled by user" });
  expect(fetchSignal?.aborted).toBe(true);
});

test("cancelling one reader does not cancel another reader's shared chain validation", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const fetch = (async (_input: RequestInfo | URL, init: RequestInit) => {
    const { id, method } = JSON.parse(String(init.body));
    calls.push(method);
    if (method === "eth_chainId") { started(); await held; }
    return Response.json({ jsonrpc: "2.0", id, result: method === "eth_chainId" ? "0x1" : "0x2" });
  }) as typeof globalThis.fetch;
  const rpc = createBrowserEvmRpc({ fetch });
  const controller = new AbortController();
  const first = rpc.request(1, "eth_getBalance", ["0x1234", "latest"], { signal: controller.signal });
  const second = rpc.request(1, "eth_blockNumber");
  await ready;
  controller.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  release();
  expect(await second).toBe("0x2");
  expect(calls).toEqual(["eth_chainId", "eth_blockNumber"]);
});

test("the configured deadline ends a hanging read without scheduling any retry", async () => {
  const { fetch, calls } = fixture(() => new Promise(() => {}));
  const rpc = createBrowserEvmRpc({ fetch, timeoutMs: 10 });
  await expect(rpc.request(1, "eth_getBalance", ["0x1234", "latest"])).rejects.toMatchObject({ name: "TimeoutError" });
  expect(calls.map((call) => call.body.method)).toEqual(["eth_chainId", "eth_getBalance"]);
  expect(calls.at(-1)?.init.signal?.aborted).toBe(true);
});

test("viem client converts large RPC quantities exactly without browser wallet injection", async () => {
  const { rpc, calls } = fixture();
  expect(await rpc.getClient(1).getBalance({ address: "0x1111111111111111111111111111111111111111", blockNumber: 42n })).toBe(9007199254740993n);
  expect(calls.at(-1)?.body.params).toEqual(["0x1111111111111111111111111111111111111111", "0x2a"]);
});
