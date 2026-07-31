import type { ChessGame } from "./chess_api.ts";
import type { PositionOptions } from "./chess_rules.ts";

export function positionOptionsFromGame(game: ChessGame): PositionOptions {
  const repetition: Record<string, number> = {};
  for (const key of game.positionKeys) {
    repetition[key] = (repetition[key] ?? 0) + 1;
  }
  return {
    rows: game.rows,
    turn: game.turn,
    castling: game.castling,
    enPassant: game.enPassant,
    halfmoveClock: game.halfmoveClock,
    fullmoveNumber: game.fullmoveNumber,
    repetition,
  };
}
