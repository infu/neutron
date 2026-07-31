import {
  applyMove,
  generateLegalMoves,
  getPositionStatus,
  type ChessColor,
  type LegalMove,
  type Position,
} from "./chess_rules.ts";
import type { ComputerLevel } from "./chess_api.ts";

const MATE_SCORE = 100_000;
const PIECE_VALUE: Record<string, number> = {
  P: 100,
  N: 320,
  B: 335,
  R: 500,
  Q: 900,
  K: 0,
};

export type ComputerSearchOptions = {
  now?: () => number;
  random?: () => number;
  timeLimitMs?: number;
  maxDepth?: number;
  rootMoves?: readonly {
    from: string;
    to: string;
    promotion?: "q" | "r" | "b" | "n" | null;
  }[];
};

export type ComputerChoice = {
  from: string;
  to: string;
  promotion: "q" | "r" | "b" | "n" | null;
  depth: number;
  score: number;
};

type SearchContext = {
  rootColor: ChessColor;
  now: () => number;
  deadline: number;
  nodes: number;
};

class SearchExpired extends Error {}

export function chooseComputerMove(
  position: Position,
  level: ComputerLevel,
  options: ComputerSearchOptions = {},
): ComputerChoice | null {
  const now = options.now ?? performance.now.bind(performance);
  const random = options.random ?? Math.random;
  const defaults = searchDefaults(level);
  const deadline = now() + (options.timeLimitMs ?? defaults.timeLimitMs);
  const maxDepth = options.maxDepth ?? defaults.maxDepth;
  const rootStatus = getPositionStatus(position);
  if (rootStatus.outcome) return null;
  const legal = filterRootMoves(
    generateLegalMoves(position),
    options.rootMoves,
  );
  if (legal.length === 0) return null;

  let completed: Array<{ move: LegalMove; score: number }> = [];
  let completedDepth = 0;
  const tolerance = level === "easy" ? 90 : level === "medium" ? 18 : 0;
  const context: SearchContext = {
    rootColor: position.turn,
    now,
    deadline,
    nodes: 0,
  };

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    try {
      const scored = scoreRoot(
        position,
        orderMoves(legal),
        depth,
        tolerance,
        context,
      );
      completed = scored;
      completedDepth = depth;
      if (scored[0] && scored[0].score >= MATE_SCORE - 16) break;
    } catch (error) {
      if (!(error instanceof SearchExpired)) throw error;
      break;
    }
  }

  if (completed.length === 0) {
    completed = legal.map((move) => ({ move, score: moveOrderingScore(move) }));
  }
  completed.sort((left, right) => right.score - left.score);

  const bestScore = completed[0]!.score;
  const candidates = completed.filter((candidate) => candidate.score >= bestScore - tolerance);
  const chosen = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
  return {
    from: chosen.move.from,
    to: chosen.move.to,
    promotion: chosen.move.promotion,
    depth: completedDepth,
    score: chosen.score,
  };
}

function scoreRoot(
  position: Position,
  moves: LegalMove[],
  depth: number,
  tolerance: number,
  context: SearchContext,
): Array<{ move: LegalMove; score: number }> {
  const scored: Array<{ move: LegalMove; score: number }> = [];
  let alpha = -Infinity;
  for (const move of moves) {
    checkDeadline(context);
    const result = applyMove(position, moveInput(move));
    let score = search(
      result.position,
      depth - 1,
      alpha,
      Infinity,
      context,
      1,
    );
    // At the opponent's minimizing node, a score at or below alpha may be an
    // upper bound from a cutoff. Re-search only bounds close enough to enter
    // this level's randomized candidate window; distant fail-lows cannot win.
    if (score <= alpha && score >= alpha - tolerance) {
      score = search(
        result.position,
        depth - 1,
        -Infinity,
        Infinity,
        context,
        1,
      );
    }
    scored.push({ move, score });
    alpha = Math.max(alpha, score);
  }
  scored.sort((left, right) => right.score - left.score);
  return scored;
}

function search(
  position: Position,
  depth: number,
  alpha: number,
  beta: number,
  context: SearchContext,
  ply: number,
): number {
  checkDeadline(context);
  const status = getPositionStatus(position);
  if (status.outcome) {
    if (status.outcome.winner === null) return 0;
    return status.outcome.winner === context.rootColor
      ? MATE_SCORE - ply
      : -MATE_SCORE + ply;
  }
  if (depth <= 0) return evaluate(position, context.rootColor, status.legalMoveCount);

  const maximizing = position.turn === context.rootColor;
  let best = maximizing ? -Infinity : Infinity;
  for (const move of orderMoves(generateLegalMoves(position))) {
    const result = applyMove(position, moveInput(move));
    const score = search(result.position, depth - 1, alpha, beta, context, ply + 1);
    if (maximizing) {
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }
  return best;
}

function evaluate(position: Position, rootColor: ChessColor, mobility: number): number {
  let score = 0;
  position.rows.forEach((row, rowIndex) => {
    [...row].forEach((symbol, fileIndex) => {
      if (symbol === ".") return;
      const white = symbol === symbol.toUpperCase();
      const color: ChessColor = white ? "white" : "black";
      const kind = symbol.toUpperCase();
      let value = PIECE_VALUE[kind] ?? 0;
      const centerDistance = Math.abs(fileIndex - 3.5) + Math.abs(rowIndex - 3.5);
      if (kind === "N" || kind === "B") value += Math.round((7 - centerDistance) * 4);
      if (kind === "P") {
        const advancement = white ? 6 - rowIndex : rowIndex - 1;
        value += Math.max(0, advancement) * 7;
      }
      score += color === rootColor ? value : -value;
    });
  });
  const mobilityValue = Math.min(40, mobility) * 2;
  score += position.turn === rootColor ? mobilityValue : -mobilityValue;
  return score;
}

function orderMoves(moves: readonly LegalMove[]): LegalMove[] {
  return [...moves].sort(
    (left, right) => moveOrderingScore(right) - moveOrderingScore(left),
  );
}

function moveOrderingScore(move: LegalMove): number {
  const captured = move.captured ? (PIECE_VALUE[move.captured.charAt(1)] ?? 0) : 0;
  const moving = PIECE_VALUE[move.piece.charAt(1)] ?? 0;
  const promotion = move.promotion ? (PIECE_VALUE[move.promotion.toUpperCase()] ?? 0) : 0;
  const castle = move.flags.some((flag) => flag.startsWith("castle")) ? 40 : 0;
  return captured * 10 - moving + promotion + castle;
}

function moveInput(move: Pick<LegalMove, "from" | "to" | "promotion">) {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion ? { promotion: move.promotion } : {}),
  };
}

function filterRootMoves(
  generated: LegalMove[],
  allowed: ComputerSearchOptions["rootMoves"],
): LegalMove[] {
  if (!allowed) return generated;
  return generated.filter((move) =>
    allowed.some(
      (candidate) =>
        candidate.from === move.from &&
        candidate.to === move.to &&
        (candidate.promotion ?? null) === move.promotion,
    ),
  );
}

function checkDeadline(context: SearchContext): void {
  context.nodes += 1;
  if ((context.nodes & 127) === 0 && context.now() >= context.deadline) {
    throw new SearchExpired();
  }
}

function searchDefaults(level: ComputerLevel): {
  maxDepth: number;
  timeLimitMs: number;
} {
  if (level === "easy") return { maxDepth: 1, timeLimitMs: 120 };
  if (level === "medium") return { maxDepth: 2, timeLimitMs: 650 };
  return { maxDepth: 4, timeLimitMs: 3_000 };
}
