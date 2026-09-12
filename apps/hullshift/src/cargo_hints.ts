import type { Direction, EngineSnapshot, LevelDefinition } from "./model.ts";
import type { HintResponse, HintTier } from "./hints.ts";
import type { CargoSolution } from "./cargo_puzzles.ts";
import { cargoLevelAtState } from "./cargo_puzzles.ts";
import { canonicalStateHash, createInitialSnapshot, resolveDirectionalAction } from "./simulation.ts";

/** Reuse the known route when possible; otherwise search from the player's board. */
export async function createCargoHint(
  level: LevelDefinition,
  snapshot: EngineSnapshot,
  knownRoute: readonly Direction[],
  tier: HintTier,
  search: (level: LevelDefinition) => Promise<CargoSolution>,
): Promise<HintResponse> {
  const stateHash = canonicalStateHash(snapshot.state);
  if (snapshot.outcome.kind === "victory") return {
    kind: "unavailable", tier: null, stateHash, reason: "victory", message: "Every pod is home. Ready for another puzzle?",
  };
  let route: readonly Direction[] | null = null;
  let cursor = createInitialSnapshot(level);
  for (let i = 0; i < knownRoute.length; i++) {
    if (canonicalStateHash(cursor.state) === stateHash) { route = knownRoute.slice(i); break; }
    cursor = resolveDirectionalAction(level, cursor, knownRoute[i]!).after;
  }
  if (route === null) {
    const result = await search(cargoLevelAtState(level, snapshot.state));
    route = result.actions;
    if (route === null) return result.complete ? {
      kind: "rewind", tier: null, stateHash, recommendedAction: "rewind",
      message: "The pods are stuck in this arrangement. Undo a few pushes to make space again.",
    } : {
      kind: "unavailable", tier: null, stateHash, reason: "analysis-mismatch",
      message: "I haven’t found a route from here yet. Try making more space, or undo your last few pushes.",
    };
  }
  cursor = snapshot;
  for (const direction of route) {
    const transition = resolveDirectionalAction(level, cursor, direction);
    const push = transition.events.find((event) => event.type === "object-pushed");
    if (push?.type === "object-pushed") {
      const pod = cursor.state.objects.find((object) => object.id === push.objectId)!;
      const player = cursor.state.player!;
      const label = (p: typeof player) => `${String.fromCharCode(65 + p.x)}${p.y + 1}`;
      const first = { kind: "object" as const, id: pod.id, label: "Next pod", position: pod.position };
      const second = { kind: "player" as const, id: null, label: "Stand here", position: player };
      const sides = { N: "below", E: "to the left of", S: "above", W: "to the right of" };
      const directionNames = { N: "up", E: "right", S: "down", W: "left" };
      return {
        kind: "hint", tier, stateHash, subgoal: "position-object", channel: null,
        pair: tier === 2 ? { first, second } : null, highlights: tier === 2 ? [first, second] : [],
        message: tier === 1
          ? `Think about the pod at ${label(pod.position)}. Can you get ${sides[direction]} it? A useful push doesn’t always point toward a bay.`
          : `Walk to ${label(player)}, then push the pod at ${label(pod.position)} ${directionNames[direction]}. This move leaves a route to finish the puzzle.`,
      };
    }
    cursor = transition.after;
  }
  return { kind: "unavailable", tier: null, stateHash, reason: "analysis-mismatch", message: "No next push found. Try undoing one move." };
}
