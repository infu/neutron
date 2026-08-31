import { createProviderDefinedToolFactory } from "@ai-sdk/provider-utils";
import { z } from "zod";

export const OPENROUTER_WEB_TOOL_CALL_LIMIT = 4;

export const OPENROUTER_WEB_SEARCH_PARAMETERS = Object.freeze({
  engine: "exa",
  max_results: 3,
  max_uses: 2,
  max_total_results: 6,
  max_characters: 2_000,
} as const);

export const OPENROUTER_WEB_FETCH_PARAMETERS = Object.freeze({
  engine: "openrouter",
  max_uses: 2,
  max_content_tokens: 12_000,
} as const);

const webSearch = createProviderDefinedToolFactory<
  unknown,
  { parameters: typeof OPENROUTER_WEB_SEARCH_PARAMETERS }
>({
  id: "openrouter.web_search",
  inputSchema: z.unknown(),
});

const webFetch = createProviderDefinedToolFactory<
  unknown,
  { parameters: typeof OPENROUTER_WEB_FETCH_PARAMETERS }
>({
  id: "openrouter.web_fetch",
  inputSchema: z.unknown(),
});

export function createOpenRouterWebTools() {
  return {
    web_search: webSearch({
      parameters: OPENROUTER_WEB_SEARCH_PARAMETERS,
    }),
    web_fetch: webFetch({
      parameters: OPENROUTER_WEB_FETCH_PARAMETERS,
    }),
  };
}
