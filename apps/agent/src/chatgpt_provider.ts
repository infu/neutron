import {
  APICallError, UnsupportedFunctionalityError, isJSONObject,
  type JSONObject, type LanguageModelV4, type LanguageModelV4CallOptions,
  type LanguageModelV4Content, type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart, type LanguageModelV4ToolResultOutput,
  type LanguageModelV4Usage, type SharedV4Warning,
} from "@ai-sdk/provider";
import type { OpenRouterModel } from "./chat_types.ts";
import {
  chatGptCredentialsNeedRefresh, refreshChatGptCredentials,
  type ChatGptCredentials,
} from "./chatgpt_auth.ts";

// Wire compatibility follows the installed Codex 0.153.4 client and OpenAI's
// codex-rs/codex-api/{src/common.rs,src/endpoint/models.rs,src/sse/responses.rs}.
// This subscription route is distinct from the separately billed OpenAI API.
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_CODEX_CLIENT_VERSION = "0.153.4";

export type ChatGptProviderOptions = {
  /** Required: the Kernel's extension route. Never falls back to browser fetch. */
  fetch: typeof fetch;
  credentials: () => Promise<ChatGptCredentials>;
  saveCredentials: (credentials: ChatGptCredentials) => Promise<void>;
};

export function createChatGptProvider(options: ChatGptProviderOptions) {
  let refreshing: Promise<ChatGptCredentials> | null = null;
  const lifetime = new AbortController();
  const models = new Map<string, JSONObject>();

  async function refresh(previous: ChatGptCredentials, signal?: AbortSignal) {
    if (!refreshing) {
      const exchange = async () => {
        const latest = await options.credentials();
        lifetime.signal.throwIfAborted();
        if (latest.accessToken !== previous.accessToken || latest.refreshToken !== previous.refreshToken) return latest;
        const next = await refreshChatGptCredentials(latest, {
          fetch: options.fetch, signal: lifetime.signal,
        });
        lifetime.signal.throwIfAborted();
        // Disconnect/reconnect can happen while refresh is in flight. Never
        // restore a disconnected account or overwrite a newly connected one.
        const current = await options.credentials();
        if (current.refreshToken !== latest.refreshToken) return current;
        await options.saveCredentials(next);
        return next;
      };
      // Separate Neutron tabs have separate resident processes but share this
      // origin's IndexedDB. Serialize refresh-token rotation across those tabs.
      const operation = typeof navigator !== "undefined" && navigator.locks
        ? navigator.locks.request("neutron-agent-chatgpt-refresh", { mode: "exclusive", signal: lifetime.signal }, exchange)
        : exchange();
      refreshing = operation.finally(() => { refreshing = null; });
    }
    return abortable(refreshing, signal);
  }

  async function request(path: string, init: RequestInit = {}) {
    const signal = init.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    let credential = await abortable(options.credentials(), signal);
    if (chatGptCredentialsNeedRefresh(credential)) {
      credential = await refresh(credential, signal);
    }
    const send = async (value: ChatGptCredentials) => {
      signal.throwIfAborted();
      const response = await options.fetch(`${CHATGPT_CODEX_BASE_URL}${path}`, {
      ...init, signal,
      credentials: "omit",
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: `Bearer ${value.accessToken}`,
        "chatgpt-account-id": value.accountId,
        originator: "neutron_agent",
      },
      });
      if (signal.aborted) {
        await response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
      }
      return response;
    };
    let response = await send(credential);
    if (response.status === 401) {
      await response.body?.cancel();
      credential = await refresh(credential, signal);
      response = await send(credential);
    }
    if (!response.ok) {
      const message = await responseErrorMessage(response);
      throw new APICallError({
        message, url: `${CHATGPT_CODEX_BASE_URL}${path}`,
        requestBodyValues: undefined, statusCode: response.status,
        // Do not automatically repeat an inference request whose outcome is
        // unknown. A rejected authentication request above is safe to repeat.
        isRetryable: false,
      });
    }
    return response;
  }

  return {
    dispose() { lifetime.abort(new DOMException("ChatGPT disconnected", "AbortError")); },
    async listModels(signal?: AbortSignal): Promise<OpenRouterModel[]> {
      const response = await request(`/models?client_version=${CHATGPT_CODEX_CLIENT_VERSION}`, { signal: signal ?? null });
      const body: unknown = await response.json();
      if (!isJSONObject(body) || !Array.isArray(body.models)) {
        throw new Error("ChatGPT returned an invalid model catalog");
      }
      const result: OpenRouterModel[] = [];
      for (const raw of body.models) {
        if (!isJSONObject(raw) || typeof raw.slug !== "string" || !raw.slug) continue;
        if (raw.visibility !== undefined && raw.visibility !== "list") continue;
        models.set(raw.slug, raw);
        result.push({
          id: `chatgpt/${raw.slug}`,
          name: string(raw.display_name) || raw.slug,
          contextLength: number(raw.context_window) ?? number(raw.max_context_window) ?? 0,
          // Subscription usage has no OpenRouter per-token price. Empty means
          // unavailable, rather than incorrectly labelling the model free.
          promptPrice: "", completionPrice: "", supportsToolChoice: true,
          supportsReasoning: Array.isArray(raw.supported_reasoning_levels) && raw.supported_reasoning_levels.length > 0,
        });
      }
      if (result.length === 0) throw new Error("No ChatGPT subscription models are available for this account");
      return result;
    },
    chat(modelId: string, _options?: unknown): LanguageModelV4 {
      const slug = modelId.replace(/^chatgpt\//, "");
      if (!slug || slug.includes("/")) throw new Error("Invalid ChatGPT model ID");
      const model: LanguageModelV4 = {
        specificationVersion: "v4", provider: "chatgpt", modelId,
        supportedUrls: { "image/*": [/^https?:\/\//] },
        async doStream(call) {
          const { body, warnings } = prepareRequest(slug, call, models.get(slug));
          const controller = new AbortController();
          const abort = () => controller.abort(call.abortSignal?.reason ?? lifetime.signal.reason);
          call.abortSignal?.addEventListener("abort", abort, { once: true });
          lifetime.signal.addEventListener("abort", abort, { once: true });
          const cleanup = () => {
            call.abortSignal?.removeEventListener("abort", abort);
            lifetime.signal.removeEventListener("abort", abort);
          };
          if (call.abortSignal?.aborted || lifetime.signal.aborted) abort();
          let response: Response;
          try {
            response = await request("/responses", {
              method: "POST", signal: controller.signal,
              headers: { "content-type": "application/json", accept: "text/event-stream" },
              body: JSON.stringify(body),
            });
            if (!response.body) throw new Error("ChatGPT returned an empty response stream");
          } catch (error) { cleanup(); throw error; }
          let cancelled = false;
          const stream = new ReadableStream<LanguageModelV4StreamPart>({
            async start(output) {
              output.enqueue({ type: "stream-start", warnings });
              try {
                for await (const part of responseParts(response.body!, controller.signal)) {
                  if (cancelled) break;
                  output.enqueue(part);
                }
                if (!cancelled) output.close();
              } catch (error) {
                if (!cancelled) output.error(error);
              } finally { cleanup(); }
            },
            async cancel(reason) {
              cancelled = true;
              controller.abort(reason);
              cleanup();
            },
          });
          return { stream };
        },
        async doGenerate(call) {
          // The Codex subscription endpoint is streaming-only. Compaction and
          // other generateText callers use that same route and collect output.
          const { stream } = await model.doStream(call);
          const content: LanguageModelV4Content[] = [];
          const texts = new Map<string, Extract<LanguageModelV4Content, { type: "text" | "reasoning" }>>();
          let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
          let warnings: SharedV4Warning[] = [];
          const reader = stream.getReader();
          try {
            for (;;) {
              const { value: part, done } = await reader.read();
              if (done) break;
              if (part.type === "error") throw part.error;
              if (part.type === "stream-start") warnings = part.warnings;
              if (part.type === "text-start" || part.type === "reasoning-start") {
                const item = { type: part.type === "text-start" ? "text" : "reasoning", text: "" } as const;
                texts.set(part.id, item); content.push(item);
              } else if (part.type === "text-delta" || part.type === "reasoning-delta") {
                const item = texts.get(part.id);
                if (item) item.text += part.delta;
              } else if (part.type === "text-end" || part.type === "reasoning-end") {
                const item = texts.get(part.id);
                if (item && part.providerMetadata) item.providerMetadata = part.providerMetadata;
              } else if (part.type === "tool-call" || part.type === "source") content.push(part);
              else if (part.type === "finish") finish = part;
            }
          } finally { reader.releaseLock(); }
          if (!finish) throw new Error("ChatGPT stream ended before completion");
          return { content, finishReason: finish.finishReason, usage: finish.usage, warnings } satisfies LanguageModelV4GenerateResult;
        },
      };
      return model;
    },
  };
}

function prepareRequest(model: string, call: LanguageModelV4CallOptions, metadata?: JSONObject) {
  const instructions: string[] = [];
  const input: JSONObject[] = [];
  const reasoningIds = new Set<string>();
  for (const message of call.prompt) {
    if (message.role === "system") { instructions.push(message.content); continue; }
    const assistantItems = new Map<string, JSONObject>();
    for (const part of message.content) {
      if (part.type === "text") {
        const metadata = part.providerOptions?.chatgpt;
        const itemId = string(metadata?.itemId);
        const phase = string(metadata?.phase);
        const content = {
          type: message.role === "assistant" ? "output_text" : "input_text", text: part.text,
          ...(message.role === "assistant" ? { annotations: [] } : {}),
        };
        const existing = message.role === "assistant" && itemId ? assistantItems.get(itemId) : undefined;
        if (existing && Array.isArray(existing.content)) existing.content.push(content);
        else {
          const item: JSONObject = { role: message.role, type: "message", content: [content],
            ...(message.role === "assistant" && itemId ? { id: itemId } : {}),
            ...(message.role === "assistant" && phase ? { phase } : {}),
          };
          input.push(item);
          if (message.role === "assistant" && itemId) assistantItems.set(itemId, item);
        }
      } else if (part.type === "reasoning") {
        const item = part.providerOptions?.chatgpt?.reasoningItem;
        if (isJSONObject(item) && item.type === "reasoning" && typeof item.id === "string" && !reasoningIds.has(item.id)) {
          reasoningIds.add(item.id); input.push(item);
        }
      } else if (part.type === "tool-call") {
        const itemId = part.providerOptions?.chatgpt?.itemId;
        input.push({ type: "function_call", call_id: part.toolCallId,
          name: part.toolName, arguments: JSON.stringify(part.input),
          ...(typeof itemId === "string" ? { id: itemId } : {}),
        });
      } else if (part.type === "tool-result") {
        input.push({ type: "function_call_output", call_id: part.toolCallId, output: toolOutput(part.output) });
      } else if (part.type === "file" && part.mediaType.startsWith("image/")) {
        let url: string;
        if (part.data.type === "url") url = String(part.data.url);
        else if (part.data.type === "data") {
          const data = part.data.data;
          let encoded: string;
          if (typeof data === "string") encoded = data;
          else {
            let binary = "";
            for (const byte of data) binary += String.fromCharCode(byte);
            encoded = btoa(binary);
          }
          url = `data:${part.mediaType};base64,${encoded}`;
        } else throw unsupported("image references");
        input.push({ role: "user", type: "message", content: [{ type: "input_image", image_url: url }] });
      } else throw unsupported(`prompt content ${part.type}`);
    }
  }
  const warnings: SharedV4Warning[] = [];
  // Codex's request contract intentionally has no sampling/max-output fields.
  for (const setting of ["maxOutputTokens", "temperature", "topP", "topK", "seed", "presencePenalty", "frequencyPenalty", "stopSequences"] as const) {
    if (call[setting] !== undefined) warnings.push({ type: "unsupported", feature: setting, details: "ChatGPT subscription models use provider-controlled generation settings." });
  }
  const selectedTool = call.toolChoice?.type === "tool" ? call.toolChoice.toolName : undefined;
  const tools = (call.tools ?? []).filter((tool) => !selectedTool || tool.name === selectedTool).map((tool) => {
    if (tool.type !== "function") throw unsupported(`provider tool ${tool.name}`);
    return { type: "function", name: tool.name, description: tool.description ?? "", parameters: object(tool.inputSchema), strict: tool.strict ?? false };
  });
  if (selectedTool && tools.length !== 1) throw new Error(`Unknown ChatGPT tool: ${selectedTool}`);
  const body: JSONObject = {
    model, instructions: instructions.join("\n\n"), input, tools,
    tool_choice: selectedTool ? "required" : call.toolChoice?.type ?? "auto",
    parallel_tool_calls: true, store: false, stream: true,
    include: ["reasoning.encrypted_content"],
  };
  if (call.reasoning && call.reasoning !== "provider-default") body.reasoning = { effort: call.reasoning };
  else if (typeof metadata?.default_reasoning_level === "string") body.reasoning = { effort: metadata.default_reasoning_level };
  if (call.responseFormat?.type === "json") {
    if (!call.responseFormat.schema) throw unsupported("JSON output without a schema");
    body.text = { format: { type: "json_schema", name: call.responseFormat.name ?? "response", strict: true, schema: object(call.responseFormat.schema) } };
  }
  return { body, warnings };
}

function toolOutput(output: LanguageModelV4ToolResultOutput): string {
  if (output.type === "text" || output.type === "error-text") return output.value;
  if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value);
  if (output.type === "execution-denied") return output.reason ?? "The user declined this tool action.";
  return output.value.map((part) => {
    if (part.type !== "text") throw unsupported(`tool result content ${part.type}`);
    return part.text;
  }).join("\n");
}

async function* responseParts(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<LanguageModelV4StreamPart> {
  const textParts = new Map<string, { id: string; text: string; closed: boolean }>();
  const reasoning = new Map<string, { text: string; closed: boolean }>();
  const calls = new Map<string, { id: string; name: string; input: string; emitted: boolean }>();
  let toolCalls = false;
  let completed = false;
  for await (const event of sseEvents(body, signal)) {
    const type = string(event.type);
    if (type === "response.created") {
      const response = object(event.response);
      yield { type: "response-metadata", ...(typeof response.id === "string" ? { id: response.id } : {}),
        ...(typeof response.model === "string" ? { modelId: response.model } : {}),
        ...(number(response.created_at) !== undefined ? { timestamp: new Date(number(response.created_at)! * 1_000) } : {}) };
    } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      const key = `${string(event.item_id) ?? event.output_index ?? "message"}:${event.content_index ?? 0}`;
      let part = textParts.get(key);
      if (!part) {
        part = { id: key, text: "", closed: false }; textParts.set(key, part);
        yield { type: "text-start", id: key };
      }
      const delta = string(event.delta) ?? ""; part.text += delta;
      yield { type: "text-delta", id: key, delta };
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      const id = string(event.item_id) ?? `reasoning-${event.output_index ?? 0}`;
      if (!reasoning.has(id)) { reasoning.set(id, { text: "", closed: false }); yield { type: "reasoning-start", id }; }
      const delta = string(event.delta) ?? ""; reasoning.get(id)!.text += delta;
      yield { type: "reasoning-delta", id, delta };
    } else if (type === "response.output_item.added") {
      const item = object(event.item);
      if (item.type === "function_call") {
        const id = requiredString(item.call_id, "tool call ID");
        const name = requiredString(item.name, "tool name");
        calls.set(requiredString(item.id, "tool item ID"), { id, name, input: "", emitted: false });
        yield { type: "tool-input-start", id, toolName: name };
      }
    } else if (type === "response.function_call_arguments.delta") {
      const call = calls.get(string(event.item_id) ?? "");
      if (call) { const delta = string(event.delta) ?? ""; call.input += delta; yield { type: "tool-input-delta", id: call.id, delta }; }
    } else if (type === "response.output_item.done") {
      const item = object(event.item);
      if (item.type === "function_call") {
        const itemId = requiredString(item.id, "tool item ID");
        const previous = calls.get(itemId);
        if (previous?.emitted) continue;
        const id = requiredString(item.call_id, "tool call ID");
        const name = requiredString(item.name, "tool name");
        const input = requiredString(item.arguments, "tool arguments");
        JSON.parse(input); // Incomplete or corrupt arguments must never execute.
        if (!previous) yield { type: "tool-input-start", id, toolName: name };
        yield { type: "tool-input-end", id };
        calls.set(itemId, { id, name, input, emitted: true }); toolCalls = true;
        yield { type: "tool-call", toolCallId: id, toolName: name, input, providerMetadata: { chatgpt: { itemId } } };
      } else if (item.type === "reasoning") {
        const id = requiredString(item.id, "reasoning item ID");
        const previous = reasoning.get(id);
        if (previous?.closed) continue;
        if (!previous) {
          yield { type: "reasoning-start", id };
          const summary = Array.isArray(item.summary) ? item.summary.filter(isJSONObject).map((part) => string(part.text) ?? "").join("\n") : "";
          if (summary) yield { type: "reasoning-delta", id, delta: summary };
        }
        reasoning.set(id, { text: previous?.text ?? "", closed: true });
        yield { type: "reasoning-end", id, providerMetadata: { chatgpt: { reasoningItem: item } } };
      } else if (item.type === "message" && Array.isArray(item.content)) {
        for (let index = 0; index < item.content.length; index++) {
          const content = object(item.content[index]);
          if (content.type !== "output_text" && content.type !== "refusal") continue;
          const key = `${string(item.id) ?? event.output_index ?? "message"}:${index}`;
          if (!textParts.has(key)) {
            yield { type: "text-start", id: key };
            yield { type: "text-delta", id: key, delta: string(content.text) ?? string(content.refusal) ?? "" };
            textParts.set(key, { id: key, text: "", closed: false });
          }
          const part = textParts.get(key)!;
          if (!part.closed) {
            part.closed = true;
            yield { type: "text-end", id: key, providerMetadata: { chatgpt: {
              ...(typeof item.id === "string" ? { itemId: item.id } : {}),
              ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
            } } };
          }
        }
      }
    } else if (type === "response.failed" || type === "error") {
      const error = type === "response.failed" ? object(object(event.response).error) : object(event.error ?? event);
      throw new Error(`ChatGPT: ${string(error.message) ?? string(error.code) ?? "Response failed"}`);
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = object(event.response);
      const reason = string(object(response.incomplete_details).reason);
      if (type === "response.incomplete" && reason !== "max_output_tokens") {
        throw new Error(`ChatGPT response was interrupted (${reason ?? "unknown reason"})`);
      }
      // A tool added without a completed item is not executable. Mark the
      // response incomplete so the existing Agent recovery path can resume it.
      const partialTool = [...calls.values()].some((call) => !call.emitted);
      for (const [id, part] of textParts) if (!part.closed) { part.closed = true; yield { type: "text-end", id }; }
      for (const [id, part] of reasoning) if (!part.closed) { part.closed = true; yield { type: "reasoning-end", id }; }
      yield { type: "finish", usage: parseUsage(response.usage), finishReason: {
        unified: type === "response.incomplete" || partialTool ? "length" : toolCalls ? "tool-calls" : "stop",
        raw: reason ?? (partialTool ? "incomplete_tool_call" : "completed"),
      } };
      completed = true; break;
    }
  }
  signal.throwIfAborted();
  if (!completed) throw new Error("ChatGPT stream disconnected before completion; resume from the saved progress");
}

async function* sseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<JSONObject> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", data: string[] = [];
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer && !buffer.endsWith("\n")) buffer += "\n";
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) {
            const payload = data.join("\n"); data = [];
            if (payload === "[DONE]") return;
            const event: unknown = JSON.parse(payload);
            if (!isJSONObject(event)) throw new Error("ChatGPT returned an invalid stream event");
            yield event;
          }
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) break;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseUsage(value: unknown): LanguageModelV4Usage {
  const usage = object(value), input = number(usage.input_tokens), output = number(usage.output_tokens);
  const details = object(usage.input_tokens_details), cached = number(details.cached_tokens), written = number(details.cache_write_tokens);
  const reasoning = number(object(usage.output_tokens_details).reasoning_tokens);
  return {
    inputTokens: { total: input, noCache: input === undefined ? undefined : Math.max(0, input - (cached ?? 0) - (written ?? 0)), cacheRead: cached, cacheWrite: written },
    outputTokens: { total: output, text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)), reasoning },
  };
}
async function responseErrorMessage(response: Response) {
  try {
    const body: unknown = await response.json();
    const error = object(object(body).error);
    const message = string(error.message) ?? string(object(body).message);
    if (message) return `ChatGPT: ${message}`;
  } catch { /* Do not display gateway HTML or credentials in error text. */ }
  if (response.status === 401) return "ChatGPT sign-in expired; reconnect your subscription";
  if (response.status === 403) return "ChatGPT did not allow this request for the connected account";
  if (response.status === 429) return "The ChatGPT subscription usage limit was reached; try again when your allowance resets";
  return `ChatGPT request failed (HTTP ${response.status})`;
}
function object(value: unknown): JSONObject { return isJSONObject(value) ? value : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value) throw new Error(`ChatGPT returned an invalid ${name}`);
  return value;
}
function unsupported(feature: string) { return new UnsupportedFunctionalityError({ functionality: `ChatGPT subscription: ${feature}` }); }
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
