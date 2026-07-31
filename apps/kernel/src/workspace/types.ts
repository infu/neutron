export const WORKSPACE_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
] as const;

export const MAX_WORKSPACES = WORKSPACE_IDS.length;
export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

export function isWorkspaceId(value: unknown): value is WorkspaceId {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_WORKSPACES
  );
}
export type Orientation = "vertical" | "horizontal";
export type InsertSide = "left" | "right" | "top" | "bottom";

export type TileInstance = {
  id: string;
  appId: string;
  tileId: string;
  title: string;
  path: string;
  icon: string;
};

export type TileNode = {
  id: string;
  type: "tile";
  tileId: string;
};

export type SplitNode = {
  id: string;
  type: "split";
  orientation: Orientation;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
};

export type LayoutNode = TileNode | SplitNode;

export type WorkspaceState = {
  id: WorkspaceId;
  layout: LayoutNode | null;
  tiles: TileInstance[];
  focusedTileId: string | null;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TileRects = Record<string, Rect>;

export type TileLaunchRequest = Omit<TileInstance, "id">;
