import { clampRatio } from "./layout.ts";
import type { InsertSide, LayoutNode, SplitNode, TileNode } from "./types.ts";

export function tileNode(tileId: string): TileNode {
  return {
    id: nextNodeId("tile"),
    type: "tile",
    tileId,
  };
}

export function replaceNode(
  root: LayoutNode,
  targetNodeId: string,
  next: LayoutNode
): LayoutNode {
  if (root.id === targetNodeId) return next;
  if (root.type === "tile") return root;
  return {
    ...root,
    first: replaceNode(root.first, targetNodeId, next),
    second: replaceNode(root.second, targetNodeId, next),
  };
}

export function findNodeByTileId(
  root: LayoutNode,
  tileId: string
): TileNode | null {
  if (root.type === "tile") return root.tileId === tileId ? root : null;
  return (
    findNodeByTileId(root.first, tileId) ??
    findNodeByTileId(root.second, tileId)
  );
}

export function removeTile(root: LayoutNode, tileId: string): LayoutNode | null {
  if (root.type === "tile") return root.tileId === tileId ? null : root;

  const first = removeTile(root.first, tileId);
  const second = removeTile(root.second, tileId);
  if (!first) return second;
  if (!second) return first;
  return { ...root, first, second };
}

export function insertTile(
  root: LayoutNode,
  targetTileId: string,
  newTileId: string,
  side: InsertSide,
  newTileRatio = 0.5,
): LayoutNode {
  const target = findNodeByTileId(root, targetTileId);
  if (!target) return root;

  const orientation =
    side === "left" || side === "right" ? "vertical" : "horizontal";
  const newTile = tileNode(newTileId);
  const selectedRatio = clampRatio(newTileRatio);
  const newTileFirst = side === "left" || side === "top";
  const split: SplitNode = {
    id: nextNodeId("split"),
    type: "split",
    orientation,
    ratio: newTileFirst ? selectedRatio : 1 - selectedRatio,
    first: newTileFirst ? newTile : target,
    second: newTileFirst ? target : newTile,
  };
  return replaceNode(root, target.id, split);
}

export function updateRatio(
  root: LayoutNode,
  splitId: string,
  ratio: number
): LayoutNode {
  if (root.type === "split" && root.id === splitId) {
    return { ...root, ratio: clampRatio(ratio) };
  }
  if (root.type === "tile") return root;
  return {
    ...root,
    first: updateRatio(root.first, splitId, ratio),
    second: updateRatio(root.second, splitId, ratio),
  };
}

export function nextTileId(appId: string, tileId: string): string {
  return `${appId}-${tileId}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function nextNodeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}
