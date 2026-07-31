import { createInterface } from "node:readline";
import { validateLevel } from "../src/mechanics.ts";
import type { Direction, LevelDefinition, PuzzleState } from "../src/model.ts";
import {
  canonicalLevelHash,
  canonicalStateKey,
  createInitialSnapshot,
  createSnapshot,
  resolveDirectionalAction,
} from "../src/simulation.ts";

type OracleRequest =
  | { readonly protocol: 1; readonly id?: string; readonly type: "initial"; readonly level: LevelDefinition }
  | {
      readonly protocol: 1;
      readonly id?: string;
      readonly type: "transition";
      readonly level: LevelDefinition;
      readonly state: PuzzleState;
      readonly action: Direction;
    }
  | { readonly protocol: 1; readonly id?: string; readonly type: "level-hash"; readonly level: LevelDefinition };

const ORACLE_PROTOCOL_VERSION = 1 as const;
const MAX_ORACLE_LINE_BYTES = 512 * 1024;

/**
 * Persistent JSON-lines oracle used by the Python parity suite. stdout is
 * protocol-only: one compact JSON response for every non-empty input line.
 */
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.trim().length === 0) continue;
  let request: OracleRequest;
  try {
    if (new TextEncoder().encode(line).byteLength > MAX_ORACLE_LINE_BYTES) {
      throw new Error("oracle request exceeds the 512 KiB limit");
    }
    request = JSON.parse(line) as OracleRequest;
    if (request.protocol !== ORACLE_PROTOCOL_VERSION) throw new Error("unsupported oracle protocol");
    const issues = validateLevel(request.level);
    if (issues.length > 0) throw new Error(`invalid level: ${issues.map((issue) => issue.code).join(",")}`);
    if (request.type === "initial") {
      const snapshot = createInitialSnapshot(request.level);
      respond(request.id, {
        state: snapshot.state,
        stateKey: canonicalStateKey(snapshot.state),
        derived: snapshot.derived,
        outcome: snapshot.outcome,
        levelHash: canonicalLevelHash(request.level),
      });
      continue;
    }
    if (request.type === "level-hash") {
      respond(request.id, { levelHash: canonicalLevelHash(request.level) });
      continue;
    }
    if (request.type === "transition") {
      if (!isDirection(request.action)) throw new Error("invalid direction");
      const result = resolveDirectionalAction(
        request.level,
        createSnapshot(request.level, request.state),
        request.action,
      );
      respond(request.id, {
        accepted: result.accepted,
        pushed: result.pushed,
        action: result.action,
        beforeStateKey: canonicalStateKey(result.before.state),
        after: result.after,
        afterStateKey: canonicalStateKey(result.after.state),
        events: result.events,
        internalPasses: result.internalPasses,
        ...(result.accepted ? {} : { blockedReason: result.blockedReason }),
      });
      continue;
    }
    throw new Error("unknown oracle request");
  } catch (reason) {
    let id: string | undefined;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === "string") id = parsed.id;
    } catch {
      // The error response below deliberately omits an unparseable id.
    }
    respond(id, { error: reason instanceof Error ? reason.message : "oracle failure" }, false);
  }
}

function respond(id: string | undefined, result: unknown, ok = true): void {
  process.stdout.write(`${JSON.stringify({
    protocol: ORACLE_PROTOCOL_VERSION,
    ...(id === undefined ? {} : { id }),
    ok,
    result,
  })}\n`);
}

function isDirection(value: unknown): value is Direction {
  return value === "N" || value === "E" || value === "S" || value === "W";
}
