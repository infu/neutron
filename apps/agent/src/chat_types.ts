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
  generatingHere: boolean;
  conversationRevision: string | null;
  hiddenMessageCount: number;
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

export type AgentChatTileEndpointId =
  `app:agent:tile:chat:instance:${string}`;

export type PersistedAgentSharedState = {
  selectedModelId: string | null;
  models: OpenRouterModel[];
  modelsFetchedAt: number;
};

export type PersistedConversationState = {
  selectedModelId: string | null;
  messages: TranscriptMessage[];
  modelTurns: ModelMessage[][];
  pendingStateChangeJournal: PendingStateChangeJournal | null;
};

// Released Agent versions stored shared and conversation state together under
// one IndexedDB key. Keep this type as the exact legacy shape so that browser
// state can be normalized and claimed by one authenticated tile.
export type PersistedAgentState = PersistedAgentSharedState &
  PersistedConversationState;
