import type { InsertSide, LayoutNode, Rect, SplitNode, TileRects } from "./types.ts";

export type SplitInfo = {
  node: SplitNode;
  rect: Rect;
  isFirst: boolean;
};

export function clampRatio(value: number): number {
  return Math.max(0.15, Math.min(0.85, value));
}

export function layoutTiles(
  node: LayoutNode,
  rect: Rect,
  out: TileRects,
  gap: number
): void {
  if (node.type === "tile") {
    out[node.tileId] = rect;
    return;
  }

  const ratio = clampRatio(node.ratio);
  if (node.orientation === "vertical") {
    const firstWidth = Math.max(0, Math.round((rect.width - gap) * ratio));
    const secondWidth = Math.max(0, rect.width - firstWidth - gap);
    layoutTiles(node.first, { ...rect, width: firstWidth }, out, gap);
    layoutTiles(
      node.second,
      {
        x: rect.x + firstWidth + gap,
        y: rect.y,
        width: secondWidth,
        height: rect.height,
      },
      out,
      gap
    );
    return;
  }

  const firstHeight = Math.max(0, Math.round((rect.height - gap) * ratio));
  const secondHeight = Math.max(0, rect.height - firstHeight - gap);
  layoutTiles(node.first, { ...rect, height: firstHeight }, out, gap);
  layoutTiles(
    node.second,
    {
      x: rect.x,
      y: rect.y + firstHeight + gap,
      width: rect.width,
      height: secondHeight,
    },
    out,
    gap
  );
}

export function findResizeTarget(
  node: LayoutNode,
  rect: Rect,
  x: number,
  y: number,
  gap: number
): { split: SplitNode; rect: Rect } | null {
  if (node.type === "tile") return null;

  const ratio = clampRatio(node.ratio);
  const [firstRect, secondRect] = childRects(node, rect, gap);
  if (node.orientation === "vertical") {
    const dividerX = rect.x + Math.max(0, Math.round((rect.width - gap) * ratio));
    if (x >= dividerX && x <= dividerX + gap && y >= rect.y && y <= rect.y + rect.height) {
      return { split: node, rect };
    }
  } else {
    const dividerY = rect.y + Math.max(0, Math.round((rect.height - gap) * ratio));
    if (y >= dividerY && y <= dividerY + gap && x >= rect.x && x <= rect.x + rect.width) {
      return { split: node, rect };
    }
  }

  return (
    findResizeTarget(node.first, firstRect, x, y, gap) ??
    findResizeTarget(node.second, secondRect, x, y, gap)
  );
}

export function findTileAt(
  tileRects: TileRects,
  x: number,
  y: number,
  excludeTileId?: string
): [string, Rect] | null {
  return (
    Object.entries(tileRects).find(
      ([tileId, rect]) =>
        tileId !== excludeTileId &&
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
    ) ?? null
  );
}

export function dropSide(rect: Rect, x: number, y: number): InsertSide {
  const relX = clampUnit((x - rect.x) / Math.max(1, rect.width));
  const relY = clampUnit((y - rect.y) / Math.max(1, rect.height));
  const edgeBand = 0.22;

  if (relY <= edgeBand && relX > edgeBand && relX < 1 - edgeBand) return "top";
  if (relY >= 1 - edgeBand && relX > edgeBand && relX < 1 - edgeBand) return "bottom";
  if (relX <= edgeBand && relY > edgeBand && relY < 1 - edgeBand) return "left";
  if (relX >= 1 - edgeBand && relY > edgeBand && relY < 1 - edgeBand) return "right";

  if (rect.width > rect.height) return relX < 0.5 ? "left" : "right";
  return relY < 0.5 ? "top" : "bottom";
}

export function tileIdsInLayout(node: LayoutNode | null, acc: string[] = []): string[] {
  if (!node) return acc;
  if (node.type === "tile") {
    acc.push(node.tileId);
    return acc;
  }
  tileIdsInLayout(node.first, acc);
  tileIdsInLayout(node.second, acc);
  return acc;
}

export function findControllingSplits(
  node: LayoutNode,
  containerRect: Rect,
  targetTileId: string,
  gap: number
): { left?: SplitInfo; right?: SplitInfo; top?: SplitInfo; bottom?: SplitInfo } {
  const path = pathToTile(node, containerRect, targetTileId, gap, []);
  if (!path) return {};

  let left: SplitInfo | undefined;
  let right: SplitInfo | undefined;
  let top: SplitInfo | undefined;
  let bottom: SplitInfo | undefined;

  for (let index = path.length - 1; index >= 0; index -= 1) {
    const info = path[index];
    if (!info) continue;
    if (info.node.orientation === "vertical") {
      if (info.isFirst && !right) right = info;
      if (!info.isFirst && !left) left = info;
    } else {
      if (info.isFirst && !bottom) bottom = info;
      if (!info.isFirst && !top) top = info;
    }
  }

  return {
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
    ...(top ? { top } : {}),
    ...(bottom ? { bottom } : {}),
  };
}

function pathToTile(
  node: LayoutNode,
  rect: Rect,
  targetTileId: string,
  gap: number,
  path: SplitInfo[]
): SplitInfo[] | null {
  if (node.type === "tile") return node.tileId === targetTileId ? path : null;

  const [firstRect, secondRect] = childRects(node, rect, gap);
  return (
    pathToTile(node.first, firstRect, targetTileId, gap, [
      ...path,
      { node, rect, isFirst: true },
    ]) ??
    pathToTile(node.second, secondRect, targetTileId, gap, [
      ...path,
      { node, rect, isFirst: false },
    ])
  );
}

function childRects(node: SplitNode, rect: Rect, gap: number): [Rect, Rect] {
  const ratio = clampRatio(node.ratio);
  if (node.orientation === "vertical") {
    const firstWidth = Math.max(0, Math.round((rect.width - gap) * ratio));
    return [
      { ...rect, width: firstWidth },
      {
        x: rect.x + firstWidth + gap,
        y: rect.y,
        width: rect.width - firstWidth - gap,
        height: rect.height,
      },
    ];
  }

  const firstHeight = Math.max(0, Math.round((rect.height - gap) * ratio));
  return [
    { ...rect, height: firstHeight },
    {
      x: rect.x,
      y: rect.y + firstHeight + gap,
      width: rect.width,
      height: rect.height - firstHeight - gap,
    },
  ];
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}
