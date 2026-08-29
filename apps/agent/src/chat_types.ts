import type { JsonObject } from "neutron-tools/app";
import type { ModelMessage } from "ai";

export type OpenRouterModel = JsonObject & {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: string;
  completionPrice: string;
  supportsToolChoice: boolean;
  supportsReasoning: boolean;
};

export type TranscriptMessage = JsonObject & {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type AgentToolActivity = JsonObject & {
  id: string;
  name: string;
  text: string;
  status: "running" | "ok" | "error";
};

export type AgentSnapshot = JsonObject & {
  ready: boolean;
  connected: boolean;
  selectedModelId: string | null;
  models: OpenRouterModel[];
  modelsLoading: boolean;
  generating: boolean;
  messages: TranscriptMessage[];
  error: string | null;
};

export type AgentProgress =
  | (JsonObject & {
      type: "turn_start";
      user: TranscriptMessage;
    })
  | (JsonObject & {
      type: "tool";
      activity: AgentToolActivity;
    });

export type PendingStateChangeAttempt = {
  target: string;
  name: string;
};

export type PendingStateChangeJournal = {
  attempts: PendingStateChangeAttempt[];
  overflow: boolean;
};

export type PersistedAgentState = {
  selectedModelId: string | null;
  models: OpenRouterModel[];
  modelsFetchedAt: number;
  messages: TranscriptMessage[];
  modelTurns: ModelMessage[][];
  pendingStateChangeJournal: PendingStateChangeJournal | null;
};
