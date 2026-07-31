import { expect, test } from "bun:test";
import { commandActorForCaller, requireHistoryId } from "../src/tool_policy.ts";

test("command actors come from attested caller identity rather than arguments", () => {
  expect(commandActorForCaller({ appId: "spreadsheet", role: "tile" })).toBe("human");
  expect(commandActorForCaller({ appId: "agent", role: "background" })).toBe("agent");
  expect(commandActorForCaller({ appId: "files", role: "tile" })).toBe("agent");
  expect(commandActorForCaller({ appId: "spreadsheet", role: "background" })).toBe("system");
  expect(commandActorForCaller()).toBe("system");
});

test("undo and redo require the caller to confirm the current history head", () => {
  expect(() => requireHistoryId("undo", undefined)).toThrow("expectedHistoryId");
  expect(() => requireHistoryId("redo", "")).toThrow("expectedHistoryId");
  expect(requireHistoryId("undo", "history:1:edit")).toBe("history:1:edit");
  expect(requireHistoryId("apply", undefined)).toBeUndefined();
});
