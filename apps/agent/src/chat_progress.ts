import type {
  AgentProgress,
  AgentSnapshot,
  AgentToolActivity,
} from "./chat_types.ts";

export function applyTranscriptProgress(
  current: AgentSnapshot | null,
  progress: AgentProgress,
): AgentSnapshot | null {
  if (!current || progress.type === "tool") return current;
  if (current.messages.some((message) => message.id === progress.user.id)) {
    return {
      ...current,
      generating: true,
      generatingHere: true,
      error: null,
    };
  }
  return {
    ...current,
    generating: true,
    generatingHere: true,
    error: null,
    messages: [...current.messages, progress.user],
  };
}

export function applyToolProgress(
  _current: AgentToolActivity | null,
  progress: AgentProgress,
): AgentToolActivity | null {
  if (progress.type === "turn_start") return null;
  return progress.activity;
}
