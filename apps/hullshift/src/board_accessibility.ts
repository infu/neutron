import { bayProgress } from "./mechanics.ts";
import type { RunView } from "./resident.ts";

type BoardDescriptionRun = Pick<RunView, "level" | "snapshot">;

export function accessibleBoardSummary(run: BoardDescriptionRun): string {
  const player = run.snapshot.state.player;
  const current = player
    ? describeHullshiftCell(run, player.x, player.y)
    : "hazard outside the stable board";
  const adjacent = player
    ? [[0, -1, "north"], [1, 0, "east"], [0, 1, "south"], [-1, 0, "west"]]
      .map(([x, y, label]) => (
        `${label}: ${describeHullshiftCell(run, player.x + Number(x), player.y + Number(y))}`
      ))
      .join("; ")
    : "";
  const channels = run.snapshot.derived.channels
    .map((channel) => `${channel.symbol} ${channel.active ? "powered" : "unpowered"}`)
    .join(", ");
  const removed = new Set(run.snapshot.state.removedObjectIds);
  const movableCount = run.snapshot.state.objects.filter((object) => !removed.has(object.id)).length;
  const { filled, total } = bayProgress(run.level, run.snapshot);
  if (run.level.objective !== undefined) return `Hullshift cargo puzzle, ${run.level.width} columns by ${run.level.height} rows. Fill every mint bay with a cargo pod. ${filled} of ${total} bays filled. Circuits: ${channels || "none"}. Player at column ${(player?.x ?? 0) + 1}, row ${(player?.y ?? 0) + 1}. Adjacent cells: ${adjacent}.`;
  return `Hullshift board, ${run.level.width} columns by ${run.level.height} rows. Player ${player ? `at column ${player.x + 1}, row ${player.y + 1}, on ${current}` : "is lost"}. ${movableCount} movable objects remain. Circuits: ${channels || "none"}. Adjacent cells: ${adjacent}.`;
}

export function describeHullshiftCell(
  run: BoardDescriptionRun,
  x: number,
  y: number,
): string {
  if (x < 0 || y < 0 || x >= run.level.width || y >= run.level.height) {
    return "deck edge";
  }
  const cell = run.level.cells[y * run.level.width + x];
  if (!cell) return "unknown";
  const removed = new Set(run.snapshot.state.removedObjectIds);
  const object = run.snapshot.state.objects.find((candidate) => (
    candidate.position.x === x
    && candidate.position.y === y
    && !removed.has(candidate.id)
  ));
  const installedReactor = cell.fixture?.kind === "socket"
    && run.snapshot.state.installedCells.some((installed) => (
      installed.socketId === cell.fixture?.id
    ));
  const collapsed = run.snapshot.state.collapsedFractures.some((p) => p.x === x && p.y === y);
  const parts: string[] = [collapsed ? "collapsed floor, vacuum" : cell.terrain];
  if (cell.fixture) {
    parts.push(run.level.objective === "cargo" || cell.fixture.kind === "bay" ? "cargo bay" : cell.fixture.kind);
    const consumer = run.snapshot.derived.consumers.find((c) => c.fixtureId === cell.fixture?.id);
    if (consumer) parts.push(consumer.jammed ? "jammed open" : consumer.powered ? "powered" : "unpowered");
    if ("channel" in cell.fixture && run.level.objective !== "cargo") parts.push(`circuit ${run.level.channels.find((c) => c.id === (cell.fixture && "channel" in cell.fixture ? cell.fixture.channel : ""))?.symbol ?? cell.fixture.channel}`);
  }
  if (object) parts.push(object.kind);
  if (installedReactor) parts.push("installed reactor-cell");
  return parts.join(" with ");
}
