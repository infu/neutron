import type { CommandActor } from "./engine.ts";

export function commandActorForCaller(caller?: { appId?: string; role?: string }): CommandActor {
  if (caller?.appId === "spreadsheet" && caller.role === "tile") return "human";
  if (caller && caller.appId !== "spreadsheet") return "agent";
  return "system";
}

export function requireHistoryId(action: string, historyId: string | undefined): string | undefined {
  if ((action === "undo" || action === "redo") && !historyId) {
    const error = new Error("expectedHistoryId is required for undo and redo");
    Object.defineProperty(error, "code", { value: "HISTORY_ID_REQUIRED", enumerable: true });
    throw error;
  }
  return historyId;
}
