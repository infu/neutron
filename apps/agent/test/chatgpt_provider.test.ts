import { expect, test } from "bun:test";
import { generateText, jsonSchema, streamText, tool, type ModelMessage } from "ai";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createChatGptProvider, CHATGPT_CODEX_BASE_URL } from "../src/chatgpt_provider.ts";
import type { ChatGptCredentials } from "../src/chatgpt_auth.ts";

const credentials: ChatGptCredentials = { accessToken: "test-access", refreshToken: "test-refresh", accountId: "test-account", expiresAt: null };
const completed = (extra = {}) => ({ type: "response.completed", response: {
  id: "response-1", status: "completed", usage: { input_tokens: 20, output_tokens: 9,
    input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } }, ...extra,
} });
const textEvents = (text = "Hello") => [
  { type: "response.created", response: { id: "response-1", model: "gpt-test", created_at: 1_700_000_000 } },
  { type: "response.output_text.delta", item_id: "msg-1", content_index: 0, delta: text },
  { type: "response.output_item.done", item: { type: "message", id: "msg-1", content: [{ type: "output_text", text, annotations: [] }] } },
  completed(),
];
function sse(events: object[], chunkSize = 13) {
  const bytes = new TextEncoder().encode(events.map((event) => `event: ${(event as { type: string }).type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let start = 0; start < bytes.length; start += chunkSize) controller.enqueue(bytes.slice(start, start + chunkSize));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
  let current = { ...credentials };
  const saved: ChatGptCredentials[] = [];
  const provider = createChatGptProvider({
    fetch: (async (url, init = {}) => {
      requests.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : null });
      return handler(String(url), init);
    }) as typeof fetch,
    credentials: async () => current,
    saveCredentials: async (next) => { current = next; saved.push(next); },
  });
  return { provider, requests, saved, setCredentials: (next: ChatGptCredentials) => { current = next; } };
}
const callOptions: LanguageModelV4CallOptions = { prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] };
async function parts(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const result: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  try { for (;;) { const next = await reader.read(); if (next.done) return result; result.push(next.value); } }
  finally { reader.releaseLock(); }
}

test("streaming subscription output uses only the injected route and preserves UTF-8 across chunks", async () => {
  const { provider, requests } = setup(() => sse(textEvents("Ethereum 📈"), 1));
  const result = streamText({ model: provider.chat("chatgpt/gpt-test"), system: "Use Neutron tools", prompt: "Show prices", maxRetries: 0 });
  expect(await result.text).toBe("Ethereum 📈");
  expect((await result.totalUsage).inputTokens).toBe(20);
  expect((await result.totalUsage).outputTokens).toBe(9);
  const request = requests[0]!;
  expect(request.url).toBe(`${CHATGPT_CODEX_BASE_URL}/responses`);
  expect(request.init.credentials).toBe("omit");
  expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer test-access");
  expect(new Headers(request.init.headers).get("chatgpt-account-id")).toBe("test-account");
  expect(request.body).toMatchObject({ model: "gpt-test", instructions: "Use Neutron tools", store: false, stream: true, tool_choice: "auto", include: ["reasoning.encrypted_content"] });
  expect(requests).toHaveLength(1);
});

test("SDK tool roundtrip preserves encrypted reasoning and original function call IDs", async () => {
  let step = 0, executed = 0;
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-reasoning" };
  const { provider, requests } = setup(() => step++ === 0 ? sse([
    { type: "response.output_item.done", item: reasoning },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "price", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"asset":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"ETH"}' },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "price", arguments: '{"asset":"ETH"}' } },
    completed(),
  ]) : sse(textEvents("ETH is $3,000")));
  const tools = { price: tool({ inputSchema: jsonSchema<{ asset: string }>({ type: "object", properties: { asset: { type: "string" } }, required: ["asset"] }),
    execute: async ({ asset }) => { executed++; return { asset, usd: 3000 }; } }) };
  const first = streamText({ model: provider.chat("chatgpt/gpt-test"), prompt: "ETH price", tools, maxRetries: 0 });
  await first.consumeStream();
  expect(await first.finishReason).toBe("tool-calls");
  expect(executed).toBe(1);
  const messages: ModelMessage[] = [{ role: "user", content: "ETH price" }, ...await first.responseMessages];
  const second = streamText({ model: provider.chat("chatgpt/gpt-test"), messages, tools, maxRetries: 0 });
  expect(await second.text).toBe("ETH is $3,000");
  expect(requests[1]!.body.input).toContainEqual(reasoning);
  expect(requests[1]!.body.input).toContainEqual({ type: "function_call", id: "fc_1", call_id: "call_1", name: "price", arguments: '{"asset":"ETH"}' });
  expect(requests[1]!.body.input).toContainEqual({ type: "function_call_output", call_id: "call_1", output: '{"asset":"ETH","usd":3000}' });
});

test("generateText uses the same streaming-only subscription route for summaries", async () => {
  const { provider, requests } = setup(() => sse(textEvents("A compact summary")));
  const result = await generateText({ model: provider.chat("chatgpt/gpt-test"), prompt: "Summarize", maxRetries: 0 });
  expect(result.text).toBe("A compact summary");
  expect(result.usage.inputTokenDetails).toMatchObject({ noCacheTokens: 13, cacheReadTokens: 5, cacheWriteTokens: 2 });
  expect(result.usage.outputTokenDetails).toMatchObject({ textTokens: 6, reasoningTokens: 3 });
  expect(requests[0]!.body.stream).toBe(true);
});

test("catalog is discovered for the authenticated account and retains subscription identity", async () => {
  const { provider, requests } = setup(() => Response.json({ models: [
    { slug: "gpt-test", display_name: "GPT Test", visibility: "list", context_window: 272000, supported_reasoning_levels: [{ effort: "medium" }], default_reasoning_level: "medium" },
    { slug: "hidden-model", visibility: "hide" },
    { slug: "gpt-small", display_name: "GPT Small", visibility: "list", max_context_window: 128000, supported_reasoning_levels: [] },
  ] }));
  const models = await provider.listModels();
  expect(requests[0]!.url).toContain("/models?client_version=0.153.4");
  expect(models.map((model) => model.id)).toEqual(["chatgpt/gpt-test", "chatgpt/gpt-small"]);
  expect(models[0]).toMatchObject({ supportsReasoning: true, supportsToolChoice: true, promptPrice: "", completionPrice: "", contextLength: 272000 });
  expect(models[1]!.contextLength).toBe(128000);
});

test("catalog fails clearly rather than inventing models when account discovery is unavailable", async () => {
  for (const body of [{ data: [] }, { models: [] }, { models: [{ slug: "internal", visibility: "hide" }] }]) {
    const { provider } = setup(() => Response.json(body));
    await expect(provider.listModels()).rejects.toThrow(/catalog|No ChatGPT/);
  }
});

test("401 refresh rotates credentials once and retries only the rejected request", async () => {
  let rejected = false;
  const { provider, requests, saved } = setup((url) => {
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "next-access", refresh_token: "next-refresh", expires_in: 3600 });
    if (!rejected) { rejected = true; return Response.json({ error: { message: "Expired" } }, { status: 401 }); }
    return sse(textEvents());
  });
  expect((await provider.chat("chatgpt/gpt-test").doGenerate(callOptions)).content[0]).toMatchObject({ type: "text", text: "Hello" });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ accessToken: "next-access", refreshToken: "next-refresh" });
  expect(requests.map((request) => new Headers(request.init.headers).get("authorization"))).toEqual(["Bearer test-access", null, "Bearer next-access"]);
  expect(requests[1]!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "test-refresh" });
});

test("concurrent subagent requests share one proactive refresh", async () => {
  let finishRefresh!: (response: Response) => void;
  let sawRefresh!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { sawRefresh = resolve; });
  const { provider, requests, saved, setCredentials } = setup((url) => {
    if (url.endsWith("/oauth/token")) { sawRefresh(); return new Promise((resolve) => { finishRefresh = resolve; }); }
    return sse(textEvents());
  });
  setCredentials({ ...credentials, expiresAt: Date.now() - 1 });
  const first = provider.chat("chatgpt/gpt-test").doGenerate(callOptions);
  const second = provider.chat("chatgpt/gpt-test").doGenerate(callOptions);
  await refreshStarted;
  finishRefresh(Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
  await Promise.all([first, second]);
  expect(requests.filter((request) => request.url.endsWith("/oauth/token"))).toHaveLength(1);
  expect(saved).toHaveLength(1);
});

test("refresh completion cannot overwrite a different newly connected account", async () => {
  let finishRefresh!: (response: Response) => void;
  let sawRefresh!: () => void;
  const started = new Promise<void>((resolve) => { sawRefresh = resolve; });
  const { provider, saved, setCredentials } = setup((url) => {
    if (url.endsWith("/oauth/token")) { sawRefresh(); return new Promise((resolve) => { finishRefresh = resolve; }); }
    return sse(textEvents());
  });
  setCredentials({ ...credentials, expiresAt: Date.now() - 1 });
  const pending = provider.chat("chatgpt/gpt-test").doGenerate(callOptions);
  await started;
  setCredentials({ ...credentials, accessToken: "other-access", refreshToken: "other-refresh", accountId: "other-account" });
  finishRefresh(Response.json({ access_token: "old-next", refresh_token: "old-next-refresh" }));
  await pending;
  expect(saved).toHaveLength(0);
});

test("non-auth HTTP errors do not retry inference or expose gateway HTML", async () => {
  for (const status of [403, 429, 502]) {
    const { provider, requests } = setup(() => new Response("<html>gateway detail</html>", { status }));
    await expect(generateText({ model: provider.chat("chatgpt/gpt-test"), prompt: "Hello", maxRetries: 2 })).rejects.toThrow(/ChatGPT/);
    expect(requests).toHaveLength(1);
  }
});

test("a disconnected stream never reports a successful finish", async () => {
  const { provider } = setup(() => sse([{ type: "response.output_text.delta", item_id: "m", delta: "Partial" }]));
  const stream = await provider.chat("chatgpt/gpt-test").doStream(callOptions);
  await expect(parts(stream.stream)).rejects.toThrow("disconnected before completion");
});

test("failed and incomplete responses carry the provider failure into Agent recovery", async () => {
  for (const event of [
    { type: "response.failed", response: { error: { code: "context_length_exceeded", message: "Input exceeds context window" } } },
    { type: "error", message: "Not available" },
    { type: "response.incomplete", response: { incomplete_details: { reason: "server_interrupted" } } },
  ]) {
    const { provider } = setup(() => sse([event]));
    const stream = await provider.chat("chatgpt/gpt-test").doStream(callOptions);
    await expect(parts(stream.stream)).rejects.toThrow(/ChatGPT/);
  }
});

test("output limit preserves a length finish and never executes partial tool arguments", async () => {
  const { provider } = setup(() => sse([
    { type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "call", name: "trade" } },
    { type: "response.function_call_arguments.delta", item_id: "fc", delta: '{"amount":' },
    { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
  ]));
  const result = await parts((await provider.chat("chatgpt/gpt-test").doStream(callOptions)).stream);
  expect(result.some((part) => part.type === "tool-call")).toBe(false);
  expect(result.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "length" } });
});

test("malformed completed arguments and malformed SSE are errors", async () => {
  for (const response of [
    sse([{ type: "response.output_item.done", item: { type: "function_call", id: "fc", call_id: "call", name: "trade", arguments: '{"amount":' } }, completed()]),
    new Response("data: broken JSON\n\n"),
  ]) {
    const { provider } = setup(() => response);
    await expect(parts((await provider.chat("chatgpt/gpt-test").doStream(callOptions)).stream)).rejects.toThrow();
  }
});

test("cancellation aborts the extension request and cancels its stream reader", async () => {
  let cancelled = false;
  const { provider, requests } = setup(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const abort = new AbortController();
  const { stream } = await provider.chat("chatgpt/gpt-test").doStream({ ...callOptions, abortSignal: abort.signal });
  const reader = stream.getReader();
  expect((await reader.read()).value?.type).toBe("stream-start");
  const next = reader.read();
  abort.abort(new DOMException("Stopped", "AbortError"));
  await expect(next).rejects.toThrow("Stopped");
  expect(requests[0]!.init.signal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
  reader.releaseLock();
});

test("consumer cancellation and disconnect also close ongoing streams", async () => {
  for (const disconnect of [false, true]) {
    let cancelled = false;
    const { provider } = setup(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    const { stream } = await provider.chat("chatgpt/gpt-test").doStream(callOptions);
    const reader = stream.getReader();
    await reader.read();
    if (disconnect) {
      const pending = reader.read(); provider.dispose();
      await expect(pending).rejects.toThrow("ChatGPT disconnected");
    } else await reader.cancel();
    expect(cancelled).toBe(true);
    reader.releaseLock();
  }
});

test("terminal event completes immediately even when upstream keeps its HTTP stream open", async () => {
  let cancelled = false;
  const { provider } = setup(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(completed())}\n\n`)); },
    cancel() { cancelled = true; },
  })));
  const result = await parts((await provider.chat("chatgpt/gpt-test").doStream(callOptions)).stream);
  expect(result.at(-1)?.type).toBe("finish");
  expect(cancelled).toBe(true);
});

test("tool selection uses Codex's string tool_choice and preserves denial results", async () => {
  const { provider, requests } = setup(() => sse(textEvents()));
  await provider.chat("chatgpt/gpt-test").doGenerate({
    prompt: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "denied-1", toolName: "trade", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "denied-1", toolName: "trade", output: { type: "execution-denied", reason: "Owner declined" } }] }],
    tools: [{ type: "function", name: "trade", inputSchema: { type: "object" } }, { type: "function", name: "price", inputSchema: { type: "object" } }],
    toolChoice: { type: "tool", toolName: "price" },
  });
  expect(requests[0]!.body.tool_choice).toBe("required");
  expect(requests[0]!.body.tools.map((tool: { name: string }) => tool.name)).toEqual(["price"]);
  expect(requests[0]!.body.input[1]).toEqual({ type: "function_call_output", call_id: "denied-1", output: "Owner declined" });
});

test("unsupported provider tools fail before a network request", async () => {
  const { provider, requests } = setup(() => sse(textEvents()));
  await expect(provider.chat("chatgpt/gpt-test").doStream({ ...callOptions,
    tools: [{ type: "provider", id: "openrouter.web_search", name: "web_search", args: {} }],
  })).rejects.toThrow("provider tool web_search");
  expect(requests).toHaveLength(0);
});

test("assistant commentary phase survives SDK persistence and the next tool round", async () => {
  const { provider, requests } = setup(() => sse([
    { type: "response.output_text.delta", item_id: "msg_phase", content_index: 0, delta: "Checking prices" },
    { type: "response.output_item.done", item: { type: "message", id: "msg_phase", phase: "commentary", content: [{ type: "output_text", text: "Checking prices", annotations: [] }] } },
    completed(),
  ]));
  const first = streamText({ model: provider.chat("chatgpt/gpt-test"), prompt: "Find a price", maxRetries: 0 });
  await first.consumeStream();
  const messages = await first.responseMessages;
  const second = streamText({ model: provider.chat("chatgpt/gpt-test"), messages, maxRetries: 0 });
  await second.consumeStream();
  expect(requests[1]!.body.input[0]).toMatchObject({ type: "message", role: "assistant", id: "msg_phase", phase: "commentary" });
});

test("multiple output content parts reuse the original message ID on replay", async () => {
  const { provider, requests } = setup(() => sse([
    { type: "response.output_item.done", item: { type: "message", id: "msg_many", phase: "final_answer", content: [
      { type: "output_text", text: "First", annotations: [] }, { type: "output_text", text: "Second", annotations: [] },
    ] } }, completed(),
  ]));
  const first = streamText({ model: provider.chat("chatgpt/gpt-test"), prompt: "Hello", maxRetries: 0 });
  await first.consumeStream();
  const second = streamText({ model: provider.chat("chatgpt/gpt-test"), messages: await first.responseMessages, maxRetries: 0 });
  await second.consumeStream();
  expect(requests[1]!.body.input).toHaveLength(1);
  expect(requests[1]!.body.input[0].content).toHaveLength(2);
  expect(requests[1]!.body.input[0].phase).toBe("final_answer");
});

test("dispose while credentials are pending cannot start a request later", async () => {
  let resolveCredentials!: (value: ChatGptCredentials) => void;
  let requested = false;
  const provider = createChatGptProvider({
    fetch: (async () => { requested = true; return Response.json({ models: [] }); }) as unknown as typeof fetch,
    credentials: () => new Promise((resolve) => { resolveCredentials = resolve; }), saveCredentials: async () => {},
  });
  const pending = provider.listModels();
  provider.dispose(); resolveCredentials(credentials);
  await expect(pending).rejects.toThrow("ChatGPT disconnected");
  expect(requested).toBe(false);
});

test("dispose aborts an ongoing catalog request", async () => {
  let received!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => { received = resolve; });
  const { provider } = setup((_url, init) => new Promise((_resolve, reject) => {
    received(init.signal!);
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const pending = provider.listModels();
  const signal = await started;
  provider.dispose();
  await expect(pending).rejects.toThrow("ChatGPT disconnected");
  expect(signal.aborted).toBe(true);
});

test("two resident providers coordinate refresh through the origin's browser lock", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let lockTail = Promise.resolve();
  let lockRequests = 0, refreshes = 0;
  const locks = { request: (_name: string, _options: unknown, operation: () => Promise<ChatGptCredentials>) => {
    lockRequests++;
    const next = lockTail.then(operation);
    lockTail = next.then(() => {}, () => {});
    return next;
  } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } });
  try {
    let current = { ...credentials, expiresAt: Date.now() - 1 } as ChatGptCredentials;
    const shared = {
      fetch: (async (url) => {
        if (String(url).endsWith("/oauth/token")) { refreshes++; return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }); }
        return sse(textEvents());
      }) as typeof fetch,
      credentials: async () => current,
      saveCredentials: async (next: ChatGptCredentials) => { current = next; },
    };
    const first = createChatGptProvider(shared), second = createChatGptProvider(shared);
    const answers = await Promise.all([
      first.chat("chatgpt/gpt-test").doGenerate(callOptions),
      second.chat("chatgpt/gpt-test").doGenerate(callOptions),
    ]);
    expect(answers).toHaveLength(2);
    expect(lockRequests).toBe(2);
    expect(refreshes).toBe(1);
    expect(current.refreshToken).toBe("rotated-refresh");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
