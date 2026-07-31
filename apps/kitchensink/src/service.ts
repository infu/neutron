import {
  acquireConnectionCredential,
  disconnectConnection,
  exposeTool,
  isJsonObject,
  listConnections,
  publishAppStateChange,
  requestConnection,
  setTrayState,
  type ConnectionSummary,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
  type MsgBusToolContext,
} from "neutron-tools/app";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import {
  TRAY_DEMO_NOTIFICATION_LIMIT,
  TRAY_DEMO_TOOLS,
  TRAY_DEMO_TOPIC,
  trayDemoSnapshotSchema,
  type TrayDemoNotification,
} from "./tray_demo.ts";

const emptyInputSchema: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const markReadInputSchema: JsonObject = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", pattern: "^[1-9][0-9]{0,8}$" },
  },
  additionalProperties: false,
};
const shortGoalInputSchema: JsonObject = {
  type: "object",
  required: ["goal"],
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 160 },
  },
  additionalProperties: false,
};
const backgroundUiInputSchema: JsonObject = {
  type: "object",
  required: ["target", "tool"],
  properties: {
    target: { type: "string", minLength: 1, maxLength: 512 },
    tool: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]{0,63}$",
    },
  },
  additionalProperties: false,
};
const storageWriteInputSchema: JsonObject = {
  type: "object",
  required: ["value"],
  properties: {
    value: { type: "string", minLength: 1, maxLength: 240 },
  },
  additionalProperties: false,
};
const tileSnapshotSchema: JsonObject = {
  type: "object",
  required: ["appId", "tileId", "instanceId", "workspace", "counter"],
  properties: {
    appId: { type: "string", minLength: 1, maxLength: 64 },
    tileId: { type: "string", minLength: 1, maxLength: 64 },
    instanceId: { type: "string", minLength: 1, maxLength: 192 },
    workspace: { type: "string", minLength: 1, maxLength: 80 },
    counter: { type: "string", pattern: "^[0-9]{1,80}$" },
  },
  additionalProperties: false,
};
const agentDemoOutputSchema: JsonObject = {
  type: "object",
  required: [
    "goal",
    "callerEndpoint",
    "nestedTool",
    "nestedCalls",
    "completed",
    "tile",
  ],
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 160 },
    callerEndpoint: { type: "string", minLength: 1, maxLength: 512 },
    nestedTool: { type: "string", enum: ["tile_snapshot"] },
    nestedCalls: { type: "integer", minimum: 1, maximum: 1 },
    completed: { type: "boolean" },
    tile: tileSnapshotSchema,
  },
  additionalProperties: false,
};
const backgroundUiOutputSchema: JsonObject = {
  type: "object",
  required: [
    "requesterEndpoint",
    "targetEndpoint",
    "nestedTool",
    "nestedCalls",
    "kernelRouted",
    "result",
  ],
  properties: {
    requesterEndpoint: { type: "string", minLength: 1, maxLength: 512 },
    targetEndpoint: { type: "string", minLength: 1, maxLength: 512 },
    nestedTool: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]{0,63}$",
    },
    nestedCalls: { type: "integer", minimum: 1, maximum: 1 },
    kernelRouted: { type: "boolean" },
    result: {},
  },
  additionalProperties: false,
};
const storageOutputSchema: JsonObject = {
  type: "object",
  required: ["available", "present", "value", "characters"],
  properties: {
    available: { type: "boolean" },
    present: { type: "boolean" },
    value: { type: ["string", "null"], maxLength: 240 },
    characters: { type: "integer", minimum: 0, maximum: 240 },
  },
  additionalProperties: false,
};
const connectionOutputSchema: JsonObject = {
  type: "object",
  required: [
    "provider",
    "connected",
    "createdAt",
    "credentialDelivered",
  ],
  properties: {
    provider: { type: "string", enum: ["openrouter"] },
    connected: { type: "boolean" },
    createdAt: { type: ["string", "null"], maxLength: 64 },
    credentialDelivered: { type: "boolean" },
  },
  additionalProperties: false,
};

const STORAGE_KEY = "neutron.kitchensink.capabilities.storage.v1";
const OPENROUTER_PROVIDER = "openrouter";

let revision = 1;
let nextId = 1;
let traySyncTail: Promise<void> = Promise.resolve();
let notifications: TrayDemoNotification[] = [];

exposeTool(
  TRAY_DEMO_TOOLS.snapshot,
  {
    title: "Read Tray Demo",
    description: "Read the resident Kitchen Sink tray-popout snapshot.",
    inputSchema: emptyInputSchema,
    outputSchema: trayDemoSnapshotSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async () => snapshot(),
);

exposeTool(
  TRAY_DEMO_TOOLS.add,
  {
    title: "Add Tray Demo Item",
    description: "Add one bounded demo item and update the tray badge.",
    inputSchema: emptyInputSchema,
    outputSchema: trayDemoSnapshotSchema,
    annotations: { "neutron:effects": ["write", "network"] },
  },
  async () => {
    const id = String(nextId++);
    notifications = [
      {
        id,
        title: `Demo item ${id}`,
        detail: "The resident service updated this popout and its tray badge.",
        time: "now",
        read: false,
      },
      ...notifications,
    ].slice(0, TRAY_DEMO_NOTIFICATION_LIMIT);
    return commit();
  },
);

exposeTool(
  TRAY_DEMO_TOOLS.markRead,
  {
    title: "Clear Tray Demo Item",
    description: "Clear one resident demo item from the tray badge.",
    inputSchema: markReadInputSchema,
    outputSchema: trayDemoSnapshotSchema,
    annotations: { "neutron:effects": ["write", "network"] },
  },
  async (args) => {
    const id = requiredId(args.id);
    const notification = notifications.find((candidate) => candidate.id === id);
    if (!notification) throw new Error(`Unknown tray notification ${id}`);
    if (notification.read) return snapshot();
    notifications = notifications.map((candidate) =>
      candidate.id === id ? { ...candidate, read: true } : candidate,
    );
    return commit();
  },
);

exposeTool(
  TRAY_DEMO_TOOLS.markAllRead,
  {
    title: "Clear Kitchen Sink Tray Badge",
    description: "Clear every active demo item from the tray badge.",
    inputSchema: emptyInputSchema,
    outputSchema: trayDemoSnapshotSchema,
    annotations: { "neutron:effects": ["write", "network"] },
  },
  async () => {
    if (unreadCount() === 0) return snapshot();
    notifications = notifications.map((notification) => ({
      ...notification,
      read: true,
    }));
    return commit();
  },
);

exposeTool(
  "capability_agent_demo",
  {
    title: "Run Capability Agent Demo",
    description:
      "Run one bounded, inspect-only agent turn that calls the invoking Kitchen Sink tile through the scoped kernel client.",
    inputSchema: shortGoalInputSchema,
    outputSchema: agentDemoOutputSchema,
    annotations: {
      "neutron:effects": ["read", "network"],
      "neutron:longRunning": true,
    },
  },
  async (args, context) => {
    if (!context.signal) {
      throw new Error(
        "Enable Agent Mode for capability_agent_demo before running this turn",
      );
    }
    const target = requireOwnTile(context);
    const goal = requiredShortText(args.goal, "goal", 160);
    throwIfCancelled(context);
    context.reportProgress({
      phase: "inspect",
      completed: 0,
      total: 1,
      detail: "Reading the source-bound Kitchen Sink tile snapshot",
    });
    const tile = await callSourceTileSnapshot(context, target);
    throwIfCancelled(context);
    context.reportProgress({
      phase: "complete",
      completed: 1,
      total: 1,
      detail: "One scoped nested call completed",
    });
    return {
      goal,
      callerEndpoint: target,
      nestedTool: "tile_snapshot",
      nestedCalls: 1,
      completed: true,
      tile,
    };
  },
);

exposeTool(
  "capability_background_ui",
  {
    title: "Request Foreign Read Tool From Background",
    description:
      "Have the resident background request one owner-reviewed, zero-input read tool from a connected foreign app endpoint.",
    inputSchema: backgroundUiInputSchema,
    outputSchema: backgroundUiOutputSchema,
    annotations: {
      "neutron:effects": ["read", "network", "user_visible_ui"],
    },
  },
  async (args, context) => {
    const requester = requireOwnTile(context);
    const target = requiredCrossAppEndpoint(args.target);
    const tool = requiredToolName(args.tool);
    const result = await context.kernel.callTool<JsonValue>({
      target,
      name: tool,
      arguments: {},
    }, 60);
    return {
      requesterEndpoint: requester,
      targetEndpoint: target,
      nestedTool: tool,
      nestedCalls: 1,
      kernelRouted: true,
      result,
    };
  },
);

exposeTool(
  "capability_storage_status",
  {
    title: "Read Persistent Storage Demo",
    description:
      "Read the bounded Kitchen Sink demo value from this app's isolated resident origin. Do not store secrets in the demo value.",
    inputSchema: emptyInputSchema,
    outputSchema: storageOutputSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async (_args, context) => {
    requireOwnTile(context);
    return storageSnapshot();
  },
);

exposeTool(
  "capability_storage_write",
  {
    title: "Write Persistent Storage Demo",
    description:
      "Write one non-secret value of at most 240 characters to the isolated Kitchen Sink resident origin.",
    inputSchema: storageWriteInputSchema,
    outputSchema: storageOutputSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async (args, context) => {
    requireOwnTile(context);
    const value = requiredShortText(args.value, "value", 240);
    const storage = requireBrowserStorage();
    storage.setItem(STORAGE_KEY, value);
    return storageSnapshot();
  },
);

exposeTool(
  "capability_storage_clear",
  {
    title: "Clear Persistent Storage Demo",
    description:
      "Remove the Kitchen Sink demo value from this app's isolated resident origin.",
    inputSchema: emptyInputSchema,
    outputSchema: storageOutputSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async (_args, context) => {
    requireOwnTile(context);
    const storage = requireBrowserStorage();
    storage.removeItem(STORAGE_KEY);
    return storageSnapshot();
  },
);

exposeTool(
  "capability_connection_status",
  {
    title: "Read OpenRouter Connection Status",
    description:
      "Read this Kitchen Sink installation's isolated OpenRouter connection metadata. No credential is returned.",
    inputSchema: emptyInputSchema,
    outputSchema: connectionOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (_args, context) => {
    requireOwnTile(context);
    const connections = await listConnections(OPENROUTER_PROVIDER);
    return connectionSnapshot(preferredConnection(connections), false);
  },
);

exposeTool(
  "capability_connection_connect",
  {
    title: "Connect Kitchen Sink To OpenRouter",
    description:
      "Request the declared resident OpenRouter connection and prove credential delivery without returning, logging, or retaining the credential.",
    inputSchema: emptyInputSchema,
    outputSchema: connectionOutputSchema,
    annotations: {
      "neutron:effects": ["network", "write", "user_visible_ui"],
    },
  },
  async (_args, context) => {
    requireOwnTile(context);
    const existing = preferredConnection(
      await listConnections(OPENROUTER_PROVIDER),
    );
    const connection =
      existing ??
      (await requestConnection({
        provider: OPENROUTER_PROVIDER,
      }));
    assertDeclaredConnection(connection);
    const sensitive =
      await acquireConnectionCredential(OPENROUTER_PROVIDER);
    let delivered = false;
    try {
      if (sensitive.provider !== OPENROUTER_PROVIDER) {
        throw new Error("OpenRouter returned a mismatched resident credential");
      }
      delivered = sensitive.credential.length > 0;
      if (!delivered) throw new Error("OpenRouter returned an empty credential");
    } finally {
      sensitive.credential = "";
    }
    return connectionSnapshot(connection, delivered);
  },
);

exposeTool(
  "capability_connection_disconnect",
  {
    title: "Disconnect Kitchen Sink From OpenRouter",
    description:
      "Revoke this Kitchen Sink installation's current OpenRouter connection. No credential crosses the tool result.",
    inputSchema: emptyInputSchema,
    outputSchema: connectionOutputSchema,
    annotations: {
      "neutron:effects": ["network", "write", "user_visible_ui"],
    },
  },
  async (_args, context) => {
    requireOwnTile(context);
    const connections = await listConnections(OPENROUTER_PROVIDER);
    const active = preferredConnection(connections);
    if (!active) return connectionSnapshot(null, false);
    const disconnected = await disconnectConnection(OPENROUTER_PROVIDER);
    assertDeclaredConnection(disconnected);
    return connectionSnapshot(null, false);
  },
);

void queueTraySync(null);

async function commit(): Promise<JsonObject> {
  const committedRevision = ++revision;
  await queueTraySync(committedRevision);
  return snapshot();
}

function queueTraySync(publishRevision: number | null): Promise<void> {
  const task = traySyncTail
    .catch(() => undefined)
    .then(async () => {
      try {
        await syncTrayState();
      } catch (error) {
        console.error("[Kitchen Sink] Unable to synchronize tray badge", error);
      }
      if (publishRevision !== null) {
        try {
          await publishAppStateChange(TRAY_DEMO_TOPIC, publishRevision);
        } catch {
          // Snapshot consumers also refresh on mount and focus.
        }
      }
    });
  traySyncTail = task;
  return task;
}

function syncTrayState(): Promise<void> {
  const unread = unreadCount();
  return setTrayState({ badge: unread > 0 ? unread : null });
}

function unreadCount(): number {
  return notifications.filter((notification) => !notification.read).length;
}

function snapshot(): JsonObject {
  return {
    revision: String(revision),
    unread: unreadCount(),
    notifications: notifications.map((notification) => ({ ...notification })),
  };
}

function requiredId(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new Error("Notification id is invalid");
  }
  return value;
}

function requireOwnTile(context: MsgBusToolContext): MsgBusEndpointId {
  const caller = context.caller;
  if (
    caller?.appId !== "kitchensink" ||
    caller.role !== "tile" ||
    typeof caller.endpoint !== "string" ||
    caller.endpoint.length > 512 ||
    !/^app:kitchensink:tile:[^:]{1,64}:instance:[^:]{1,192}$/.test(
      caller.endpoint,
    )
  ) {
    throw new Error(
      "Kitchen Sink capability controls are available only to the invoking Kitchen Sink tile",
    );
  }
  return caller.endpoint as MsgBusEndpointId;
}

function requiredCrossAppEndpoint(value: JsonValue | undefined): MsgBusEndpointId {
  const match = typeof value === "string"
    ? /^app:([^:]+):(?:background|tile:[^:]{1,64}:instance:[^:]{1,192})$/.exec(
      value,
    )
    : null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    match === null ||
    !isValidAppId(match[1]) ||
    value.startsWith("app:kitchensink:")
  ) {
    throw new Error("Choose a live tool endpoint owned by another app");
  }
  return value as MsgBusEndpointId;
}

function requiredToolName(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    throw new Error("Cross-app tool name is invalid");
  }
  return value;
}

async function callSourceTileSnapshot(
  context: MsgBusToolContext,
  target: MsgBusEndpointId,
): Promise<JsonObject> {
  const result = await context.kernel.callTool<JsonValue>(
    {
      target,
      name: "tile_snapshot",
      arguments: {},
    },
    20,
  );
  return normalizeTileSnapshot(result);
}

function normalizeTileSnapshot(value: JsonValue): JsonObject {
  if (!isJsonObject(value)) throw new Error("Tile returned an invalid snapshot");
  const appId = boundedString(value.appId, "tile app id", 64);
  const tileId = boundedString(value.tileId, "tile id", 64);
  const instanceId = boundedString(value.instanceId, "tile instance id", 192);
  const workspace = boundedString(value.workspace, "tile workspace", 80);
  const counter = boundedString(value.counter, "tile counter", 80);
  if (!/^[0-9]+$/.test(counter)) {
    throw new Error("Tile returned an invalid counter");
  }
  return { appId, tileId, instanceId, workspace, counter };
}

function throwIfCancelled(context: MsgBusToolContext): void {
  if (context.signal?.aborted) throw new Error("Capability agent demo was cancelled");
}

function storageSnapshot(): JsonObject {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value !== null && value.length > 240) {
      throw new Error("Persistent demo value exceeds its declared bound");
    }
    return {
      available: true,
      present: value !== null,
      value,
      characters: value?.length ?? 0,
    };
  } catch {
    return {
      available: false,
      present: false,
      value: null,
      characters: 0,
    };
  }
}

function requireBrowserStorage(): Storage {
  try {
    return window.localStorage;
  } catch {
    throw new Error("Persistent browser storage is unavailable for this resident");
  }
}

function preferredConnection(
  connections: ConnectionSummary[],
): ConnectionSummary | null {
  const declared = connections.filter(
    (connection) => connection.provider === OPENROUTER_PROVIDER,
  );
  return declared.at(0) ?? null;
}

function connectionSnapshot(
  connection: ConnectionSummary | null,
  credentialDelivered: boolean,
): JsonObject {
  if (!connection) {
    return {
      provider: OPENROUTER_PROVIDER,
      connected: false,
      createdAt: null,
      credentialDelivered: false,
    };
  }
  assertDeclaredConnection(connection);
  if (connection.createdAt.length > 64) {
    throw new Error("Kernel returned out-of-bounds connection metadata");
  }
  return {
    provider: OPENROUTER_PROVIDER,
    connected: true,
    createdAt: connection.createdAt,
    credentialDelivered,
  };
}

function assertDeclaredConnection(connection: ConnectionSummary): void {
  if (connection.provider !== OPENROUTER_PROVIDER) {
    throw new Error("Kernel returned a connection outside the declared provider");
  }
}

function requiredShortText(
  value: JsonValue | undefined,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") throw new Error(`Expected ${label}`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximumLength) {
    throw new Error(`${label} must be 1-${maximumLength} characters`);
  }
  return normalized;
}

function boundedString(
  value: JsonValue | undefined,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
