import type {
  AgentProgress,
  AgentSnapshot,
  AgentToolActivity,
} from "./chat_types.ts";

export function applyTranscriptProgress(
  current: AgentSnapshot | null,
  progress: AgentProgress,
): AgentSnapshot | null {
  if (!current || progress.type === "tool" || progress.type === "refresh") return current;
  if (progress.type === "work") return { ...current, work: progress.work };
  if (progress.type === "workers") return { ...current, workers: progress.workers };
  if (progress.type === "message") {
    return { ...current, messages: [...current.messages.filter((entry) => entry.id !== progress.message.id), progress.message] };
  }
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
  if (progress.type === "tool") return progress.activity;
  return progress.type === "turn_start" ? null : _current;
}
