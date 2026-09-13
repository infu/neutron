import type { HintHighlight, HintResponse, HintSubgoal, HintTier } from "./hints.ts";
import type { Direction, EngineSnapshot, LevelDefinition } from "./model.ts";
import type { FreightSolution } from "./freight_puzzles.ts";
import { canonicalStateHash, createInitialSnapshot, resolveDirectionalAction } from "./simulation.ts";

export async function createFreightHint(level: LevelDefinition, snapshot: EngineSnapshot, knownRoute: readonly Direction[], tier: HintTier, search: () => Promise<FreightSolution>): Promise<HintResponse> {
  const stateHash = canonicalStateHash(snapshot.state);
  if (snapshot.outcome.kind === "victory") return { kind: "unavailable", tier: null, stateHash, reason: "victory", message: "Every bay is filled. Ready for another puzzle?" };
  if (snapshot.outcome.kind !== "playing") return { kind: "rewind", tier: null, stateHash, recommendedAction: "rewind", message: "Undo the last move to return to the deck." };
  let route: readonly Direction[] | null = null, cursor = createInitialSnapshot(level);
  for (let i = 0; i < knownRoute.length; i++) {
    if (canonicalStateHash(cursor.state) === stateHash) { route = knownRoute.slice(i); break; }
    cursor = resolveDirectionalAction(level, cursor, knownRoute[i]!).after;
  }
  if (!route) {
    const result = await search(); route = result.actions;
    if (!route) return result.complete
      ? { kind: "rewind", tier: null, stateHash, recommendedAction: "rewind", message: "This arrangement cannot fill every bay. Undo a few moves to restore your options." }
      : { kind: "unavailable", tier: null, stateHash, reason: "analysis-mismatch", message: "I haven’t found a route from here yet. Try another approach, or undo a few moves." };
  }
  cursor = snapshot;
  for (const direction of route) {
    const step = resolveDirectionalAction(level, cursor, direction);
    if (!step.accepted || !step.after.state.player || !cursor.state.player) break;
    const pushed = step.events.find((e) => e.type === "object-pushed");
    const player = cursor.state.player, target = step.after.state.player;
    const fixture = level.cells[target.y * level.width + target.x]?.fixture;
    const collapsed = step.events.some((e) => e.type === "fracture-collapsed");
    const changedSource = step.after.derived.sources.find((s) => s.active !== cursor.derived.sources.find((p) => p.fixtureId === s.fixtureId)?.active);
    if (!pushed && !collapsed && !changedSource && fixture?.kind !== "bridge" && fixture?.kind !== "door") { cursor = step.after; continue; }
    const names = { N: "up", E: "right", S: "down", W: "left" };
    const label = (p: typeof player) => `${String.fromCharCode(65 + p.x)}${p.y + 1}`;
    const object = pushed?.type === "object-pushed" ? cursor.state.objects.find((o) => o.id === pushed.objectId) : undefined;
    const destination = pushed?.type === "object-pushed" ? level.cells[pushed.to.y * level.width + pushed.to.x]?.fixture : undefined;
    let subgoal: HintSubgoal = "position-object";
    let clue = "A pod may need to move away from its bay to make room. Think about which side you need to stand on.";
    let detail = object ? `push the ${object.kind === "reactor-cell" ? "reactor cell" : "pod"} ${names[direction]}` : `move ${names[direction]}`;
    if (destination?.kind === "socket" && object?.kind === "reactor-cell") { subgoal = "dock-cell"; clue = "Docking a reactor cell provides permanent power, but the filled socket will block that square."; detail += " into the socket"; }
    else if (destination?.kind === "disposal") { subgoal = "clear-obstruction"; clue = "The chute can remove an obstruction. Keep enough cargo to fill every mint bay."; detail += " into the chute"; }
    else if (fixture?.kind === "relay") { subgoal = "toggle-relay"; clue = "Stepping onto a relay flips its circuit. Think about which doors or bridges you need next."; detail += ` to turn the relay ${step.after.state.activeRelayIds.includes(fixture.id) ? "on" : "off"}`; }
    else if (changedSource?.kind === "plate") { subgoal = "energize-channel"; clue = "A pressure plate only supplies power while something stays on it. A pod can hold it for you."; }
    else if (collapsed || level.cells[target.y * level.width + target.x]?.terrain === "fracture") { subgoal = "cross-commitment"; clue = "Cracked floors disappear when the last occupant leaves. Plan your return route before crossing."; }
    else if (fixture?.kind === "bridge" || fixture?.kind === "door") { subgoal = "use-powered-window"; clue = "This passage depends on its matching circuit. Keep the route powered while you move through."; }
    const first: HintHighlight = object ? { kind: "object", id: object.id, position: object.position, label: object.kind === "reactor-cell" ? "Reactor cell" : "Next pod" }
      : { kind: "fixture", id: fixture?.id ?? null, position: target, label: "Next step" };
    const second: HintHighlight = { kind: "player", id: null, position: player, label: "Stand here" };
    const channelId = changedSource?.channel ?? (fixture && "channel" in fixture ? fixture.channel : destination && "channel" in destination ? destination.channel : null);
    const channel = level.channels.find((c) => c.id === channelId) ?? null;
    return { kind: "hint", tier, stateHash, subgoal, channel, pair: tier === 2 ? { first, second } : null,
      highlights: tier === 2 ? [first, second] : [], message: tier === 1 ? clue : `Walk to ${label(player)}, then ${detail}. A complete route remains after this move.` };
  }
  return { kind: "unavailable", tier: null, stateHash, reason: "analysis-mismatch", message: "No next step found. Try undoing one move." };
}
