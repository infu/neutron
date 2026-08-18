import type { PieceCode } from "./chess_api.ts";

// Standard Unicode chess symbols (U+2654 through U+265F) keep the board
// artwork code-native and independent of an icon library.
export const CHESS_PIECE_SYMBOLS = {
  wK: "♔",
  wQ: "♕",
  wR: "♖",
  wB: "♗",
  wN: "♘",
  wP: "♙",
  bK: "♚",
  bQ: "♛",
  bR: "♜",
  bB: "♝",
  bN: "♞",
  bP: "♟",
} as const satisfies Readonly<Record<PieceCode, string>>;

export function chessPieceSymbol(piece: PieceCode): string {
  return CHESS_PIECE_SYMBOLS[piece];
}
