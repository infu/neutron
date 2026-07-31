export type ChatStage =
  | "idle"
  | "loading"
  | "ready"
  | "generating"
  | "error";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type ChatSnapshot = {
  stage: ChatStage;
  statusText: string;
  modelId: string;
  modelLoaded: boolean;
  loadProgress: number | null;
  webGpuAvailable: boolean;
  messages: ChatMessage[];
};

export type ChatRuntimeMethod =
  | "status"
  | "load"
  | "generate"
  | "stop"
  | "reset";

export type ChatRuntimeRequest = {
  id: number;
  method: ChatRuntimeMethod;
  arguments?: { text?: string };
};

export type ChatRuntimeResponse =
  | { type: "ready"; snapshot: ChatSnapshot }
  | { type: "status"; snapshot: ChatSnapshot }
  | { type: "response"; id: number; ok: ChatSnapshot }
  | { type: "response"; id: number; error: string };

export type ChatWorkerInbound = ChatRuntimeRequest;
export type ChatWorkerOutbound = ChatRuntimeResponse;
