import { expect, test } from "bun:test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import {
  createOpenRouterWebTools,
  OPENROUTER_WEB_FETCH_PARAMETERS,
  OPENROUTER_WEB_SEARCH_PARAMETERS,
  OPENROUTER_WEB_TOOL_CALL_LIMIT,
} from "../src/openrouter_web_tools.ts";

test("OpenRouter web tools use the current bounded server-tool wire format", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const provider = createOpenRouter({
    apiKey: "test-key",
    fetch: (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "generation-1",
          object: "chat.completion",
          created: 1,
          model: "provider/model",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  await generateText({
    model: provider.chat("provider/model"),
    prompt: "Find the current documentation",
    tools: createOpenRouterWebTools(),
    toolChoice: "required",
    maxRetries: 0,
    providerOptions: {
      openrouter: { max_tool_calls: OPENROUTER_WEB_TOOL_CALL_LIMIT },
    },
  });

  expect(requestBody).not.toBeNull();
  const body = requestBody as unknown as Record<string, unknown>;
  expect(body.tools).toEqual([
    {
      type: "openrouter:web_search",
      parameters: OPENROUTER_WEB_SEARCH_PARAMETERS,
    },
    {
      type: "openrouter:web_fetch",
      parameters: OPENROUTER_WEB_FETCH_PARAMETERS,
    },
  ]);
  expect(body.tool_choice).toBe("required");
  expect(body.max_tool_calls).toBe(OPENROUTER_WEB_TOOL_CALL_LIMIT);
});
