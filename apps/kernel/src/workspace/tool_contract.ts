import type {
  ExposedToolOptions,
  JsonObject,
  JsonValue,
} from "neutron-tools/protocol";
import {
  APP_ID_MAX_LENGTH,
  APP_ID_MIN_LENGTH,
  APP_ID_REPEATED_SEPARATOR_PATTERN,
  APP_ID_SAFE_SCHEMA_PATTERN,
} from "neutron-tools/src/app_ids.js";
import { MAX_WORKSPACES, type LayoutNode } from "./types.ts";
import {
  useWorkspaceStore,
  visibleWorkspaceIds,
  workspaceStateById,
} from "./store.ts";

const instanceIdSchema: JsonObject = {
  type: "string",
  minLength: 1,
  pattern: "^[a-zA-Z0-9_-]+$",
};
const splitIdSchema: JsonObject = {
  type: "string",
  pattern: "^split-[a-zA-Z0-9_-]+$",
};
const workspaceIdSchema: JsonObject = {
  type: "integer",
  minimum: 1,
  maximum: MAX_WORKSPACES,
};
const sideSchema: JsonObject = {
  type: "string",
  enum: ["left", "right", "top", "bottom"],
};
const ratioSchema: JsonObject = {
  type: "number",
  minimum: 0.15,
  maximum: 0.85,
};
const placementProperties: JsonObject = {
  relativeTo: instanceIdSchema,
  side: sideSchema,
  size: {
    ...ratioSchema,
    description: "Fraction of the resulting split occupied by the selected tile.",
  },
};

const controlInputSchema: JsonObject = {
  oneOf: [
    {
      type: "object",
      description:
        "Open a tile in the active workspace by default. Reuse an exact app/tile there unless reuseExisting is false; a requested workspace is activated so the tile can be shown.",
      required: ["op", "appId", "tileId"],
      properties: {
        op: { const: "open" },
        appId: {
          type: "string",
          minLength: APP_ID_MIN_LENGTH,
          maxLength: APP_ID_MAX_LENGTH,
          pattern: APP_ID_SAFE_SCHEMA_PATTERN,
          not: { pattern: APP_ID_REPEATED_SEPARATOR_PATTERN },
        },
        tileId: { type: "string", pattern: "^[a-z_0-9]+$" },
        workspace: workspaceIdSchema,
        reuseExisting: { type: "boolean" },
        view: { type: "string", pattern: "^[a-z][a-z0-9_/-]{0,63}$" },
        ...placementProperties,
      },
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Activate the tile's workspace and focus this exact tile instance.",
      required: ["op", "instanceId"],
      properties: { op: { const: "focus" }, instanceId: instanceIdSchema },
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Close this exact tile instance in any workspace.",
      required: ["op", "instanceId"],
      properties: { op: { const: "close" }, instanceId: instanceIdSchema },
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Place one tile beside another tile in the same workspace without changing focus.",
      required: ["op", "instanceId", "relativeTo", "side"],
      properties: {
        op: { const: "place" },
        instanceId: instanceIdSchema,
        ...placementProperties,
      },
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Resize one split returned by workspace.inspect; ratio is the first branch's share.",
      required: ["op", "splitId", "ratio"],
      properties: {
        op: { const: "resize" },
        splitId: splitIdSchema,
        ratio: {
          ...ratioSchema,
          description: "Fraction occupied by the split's first branch.",
        },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Move a tile to another workspace without switching to it. relativeTo and side optionally place it beside a target tile there.",
      required: ["op", "instanceId", "workspace"],
      properties: {
        op: { const: "move" },
        instanceId: instanceIdSchema,
        workspace: workspaceIdSchema,
        ...placementProperties,
      },
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Make this workspace visible.",
      required: ["op", "workspace"],
      properties: { op: { const: "switch" }, workspace: workspaceIdSchema },
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Activate the tile's workspace and expand this exact tile over the workspace area.",
      required: ["op", "instanceId"],
      properties: { op: { const: "expand" }, instanceId: instanceIdSchema },
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Restore the currently expanded tile to its saved layout.",
      required: ["op"],
      properties: { op: { const: "restore" } },
      additionalProperties: false,
    },
  ],
};

const layoutDefinitions: JsonObject = {
  layoutNode: {
    oneOf: [
      {
        type: "object",
        required: ["type", "instanceId"],
        properties: {
          type: { const: "tile" },
          instanceId: instanceIdSchema,
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["type", "splitId", "orientation", "ratio", "first", "second"],
        properties: {
          type: { const: "split" },
          splitId: splitIdSchema,
          orientation: { type: "string", enum: ["vertical", "horizontal"] },
          ratio: ratioSchema,
          first: { $ref: "#/definitions/layoutNode" },
          second: { $ref: "#/definitions/layoutNode" },
        },
        additionalProperties: false,
      },
    ],
  },
};

const snapshotProperties: JsonObject = {
  activeWorkspace: workspaceIdSchema,
  expandedInstanceId: {
    oneOf: [instanceIdSchema, { type: "null" }],
  },
  workspaces: {
    type: "array",
    items: {
      type: "object",
      required: ["id", "focusedInstanceId", "tiles", "layout"],
      properties: {
        id: workspaceIdSchema,
        focusedInstanceId: {
          oneOf: [instanceIdSchema, { type: "null" }],
        },
        tiles: {
          type: "array",
          items: {
            type: "object",
            required: ["instanceId", "appId", "tileId", "title"],
            properties: {
              instanceId: instanceIdSchema,
              appId: { type: "string" },
              tileId: { type: "string" },
              title: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        layout: {
          oneOf: [{ type: "null" }, { $ref: "#/definitions/layoutNode" }],
        },
      },
      additionalProperties: false,
    },
  },
};

const snapshotOutputSchema: JsonObject = {
  type: "object",
  required: ["activeWorkspace", "expandedInstanceId", "workspaces"],
  properties: snapshotProperties,
  definitions: layoutDefinitions,
  additionalProperties: false,
};

const controlOutputSchema: JsonObject = {
  type: "object",
  required: ["result", "snapshot"],
  properties: {
    result: {
      type: "object",
      required: ["op"],
      properties: {
        op: {
          type: "string",
          enum: [
            "open",
            "focus",
            "close",
            "place",
            "resize",
            "move",
            "switch",
            "expand",
            "restore",
          ],
        },
        instanceId: instanceIdSchema,
        workspace: workspaceIdSchema,
        opened: { type: "boolean" },
      },
      additionalProperties: false,
    },
    snapshot: {
      type: "object",
      description: "Canonical workspace state after the operation.",
      required: ["activeWorkspace", "expandedInstanceId", "workspaces"],
      properties: snapshotProperties,
      additionalProperties: false,
    },
  },
  definitions: layoutDefinitions,
  additionalProperties: false,
};

export const WORKSPACE_INSPECT_TOOL_OPTIONS: ExposedToolOptions = {
  title: "Inspect Workspace",
  description:
    "Read the active workspace, exposed workspaces, exact tile instances, focus, expansion, and split layout.",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: snapshotOutputSchema,
  annotations: { "neutron:effects": ["read"] },
};

export const WORKSPACE_CONTROL_TOOL_OPTIONS: ExposedToolOptions = {
  title: "Control Workspace",
  description:
    "Open, focus, close, place, resize, move, switch, expand, or restore app tiles using the Kernel's canonical workspace layout.",
  inputSchema: controlInputSchema,
  outputSchema: controlOutputSchema,
  annotations: { "neutron:effects": ["user_visible_ui", "write"] },
};

export function inspectWorkspace(): JsonObject {
  const state = useWorkspaceStore.getState();
  return {
    activeWorkspace: state.activeWorkspaceId,
    expandedInstanceId: state.expandedTile?.instanceId ?? null,
    workspaces: visibleWorkspaceIds(state).map((workspaceId) => {
      const workspace = workspaceStateById(state.workspaces, workspaceId);
      return {
        id: workspaceId,
        focusedInstanceId: workspace.focusedTileId,
        tiles: workspace.tiles.map((tile) => ({
          instanceId: tile.id,
          appId: tile.appId,
          tileId: tile.tileId,
          title: tile.title,
        })),
        layout: projectLayout(workspace.layout),
      };
    }),
  };
}

function projectLayout(layout: LayoutNode | null): JsonValue {
  if (layout === null) return null;
  if (layout.type === "tile") {
    return { type: "tile", instanceId: layout.tileId };
  }
  return {
    type: "split",
    splitId: layout.id,
    orientation: layout.orientation,
    ratio: layout.ratio,
    first: projectLayout(layout.first),
    second: projectLayout(layout.second),
  };
}
