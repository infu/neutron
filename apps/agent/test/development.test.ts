import { expect, test } from "bun:test";
import type { AgentProgress, AgentSnapshot } from "../src/chat_types.ts";
import {
  AgentDevelopmentBridge,
  isLocalAgentDevelopmentUrl,
} from "../src/development.ts";

const localTileUrl =
  "http://aagent--y5ctc-gh777-77774-aaaba-cai.localhost:8000/app/agent/index.html?app=agent&tile=chat&instance=tile_1&workspace=1";

test("Agent development API accepts only the exact local PocketIC tile URL", () => {
  expect(isLocalAgentDevelopmentUrl(localTileUrl)).toBe(true);
  for (const rejected of [
    localTileUrl.replace("http:", "https:"),
    localTileUrl.replace(":8000", ":8080"),
    localTileUrl.replace(".localhost", ".icp0.io"),
    localTileUrl.replace("/app/agent/index.html", "/app/agent/service.html"),
    localTileUrl.replace("app=agent", "app=wallet"),
    localTileUrl.replace("tile=chat", "tile=settings"),
    localTileUrl.replace("&instance=tile_1", ""),
    localTileUrl.replace("workspace=1", "workspace=0"),
    "not a URL",
  ]) {
    expect(isLocalAgentDevelopmentUrl(rejected)).toBe(false);
  }
});

test("Agent development trace is bounded, cloned, and cannot send a chat", () => {
  const bridge = new AgentDevelopmentBridge(3);
  let draft = "";
  const snapshot = agentSnapshot();
  const detach = bridge.attach({
    prepare(text) {
      draft = text;
    },
    inspect() {
      return {
        snapshot,
        draft,
        activeTool: null,
        chatPending: false,
      };
    },
  });

  expect(Object.keys(bridge.api).sort()).toEqual([
    "clearTrace",
    "inspect",
    "prepare",
    "readTrace",
    "version",
  ]);
  expect("chat" in bridge.api).toBe(false);
  expect("stop" in bridge.api).toBe(false);
  expect(bridge.api.prepare("  Inspect contacts  ")).toEqual({
    prepared: true,
    characters: 16,
  });
  expect(draft).toBe("Inspect contacts");

  const runId = bridge.beginRun(draft);
  const progress: AgentProgress = {
    type: "tool",
    activity: {
      id: "tool-1",
      name: "list_apps",
      text: "List installed apps",
      status: "running",
    },
  };
  bridge.progress(runId, progress);
  bridge.complete(runId, {
    ...snapshot,
    messages: [
      { id: "user-1", role: "user", text: draft },
      { id: "assistant-1", role: "assistant", text: "Contacts inspected." },
    ],
  });

  const page = bridge.api.readTrace();
  expect(page.events).toHaveLength(3);
  expect(page.events.map((event) => event.type)).toEqual([
    "submitted",
    "progress",
    "final",
  ]);
  expect(page.truncated).toBe(true);
  expect(page.events[1]?.data).toEqual(progress);

  const inspection = bridge.api.inspect();
  inspection.draft = "mutated outside";
  expect(bridge.api.inspect().draft).toBe("Inspect contacts");

  detach();
  expect(() => bridge.api.prepare("another prompt")).toThrow(
    "Agent development tile is no longer active",
  );
});

test("Agent development trace rejects invalid prompts and cursors", () => {
  const bridge = new AgentDevelopmentBridge();
  bridge.attach({
    prepare() {},
    inspect() {
      return {
        snapshot: null,
        draft: "",
        activeTool: null,
        chatPending: false,
      };
    },
  });
  expect(() => bridge.api.prepare(" ")).toThrow();
  expect(() => bridge.api.prepare("x".repeat(16_001))).toThrow();
  expect(() => bridge.api.readTrace(-1)).toThrow();
  expect(() => bridge.api.readTrace(1.5)).toThrow();
});

function agentSnapshot(): AgentSnapshot {
  return {
    ready: true,
    connected: true,
    webToolsAvailable: true,
    selectedModelId: "provider/model",
    models: [],
    modelsLoading: false,
    generating: false,
    generatingHere: false,
    conversationRevision: "0:0:-",
    hiddenMessageCount: 0,
    messages: [],
    error: null,
  };
}
