import { isJsonObject, type JsonObject, type JsonValue } from "neutron-tools/app";

export const CHESS_COLORS = ["white", "black"] as const;
export const CHESS_MODES = [
  "local",
  "computer",
  "remote_host",
  "remote_guest",
] as const;
export const CHESS_STATUSES = [
  "waiting",
  "active",
  "checkmate",
  "stalemate",
  "draw_fifty_move",
  "draw_threefold",
  "draw_insufficient_material",
  "draw_agreement",
  "resigned",
] as const;

export type ChessColor = (typeof CHESS_COLORS)[number];
export type ChessMode = (typeof CHESS_MODES)[number];
export type ChessStatus = (typeof CHESS_STATUSES)[number];
export type ComputerLevel = "easy" | "medium" | "hard";
export type PromotionPiece = "q" | "r" | "b" | "n";
export type PieceCode = `${"w" | "b"}${"K" | "Q" | "R" | "B" | "N" | "P"}`;

export type ChessLegalMove = {
  from: string;
  to: string;
  promotion: PromotionPiece | null;
};

export type ChessMove = ChessLegalMove & {
  ply: number;
  piece: PieceCode;
  placed: PieceCode;
  captured: PieceCode | null;
  special: string;
  notation: string;
  at: string;
};

export type ChessCastling = {
  whiteKingSide: boolean;
  whiteQueenSide: boolean;
  blackKingSide: boolean;
  blackQueenSide: boolean;
};

export type ChessGame = {
  tileId: string;
  gameId: string;
  mode: ChessMode;
  computerLevel: ComputerLevel | null;
  revision: number;
  rows: string[];
  turn: ChessColor;
  castling: ChessCastling;
  enPassant: string | null;
  halfmoveClock: number;
  fullmoveNumber: number;
  status: ChessStatus;
  winner: ChessColor | null;
  inCheck: boolean;
  drawOfferBy: ChessColor | null;
  localColor: ChessColor | null;
  remoteConnected: boolean;
  positionKeys: string[];
  legalMoves: ChessLegalMove[];
  history: ChessMove[];
};

export function parseOptionalGame(value: JsonValue): ChessGame | null {
  if (value === null) return null;
  return parseGame(value);
}

export function parseGame(value: JsonValue): ChessGame {
  const game = requiredObject(value, "Chess game");
  const rows = requiredRows(game.rows);
  const mode = requiredEnum(game.mode, CHESS_MODES, "Chess mode");
  const status = requiredEnum(game.status, CHESS_STATUSES, "Chess status");
  const turn = requiredEnum(game.turn, CHESS_COLORS, "side to move");
  const castling = parseCastling(game.castling);
  const enPassant = optionalSquare(game.en_passant);
  const computerLevel = optionalEnum(
    game.computer_level,
    ["easy", "medium", "hard"] as const,
    "computer level",
  );
  return {
    tileId: requiredString(game.tile_id, "tile id"),
    gameId: requiredString(game.game_id, "game id"),
    mode,
    computerLevel,
    revision: requiredNatNumber(game.revision, "game revision"),
    rows,
    turn,
    castling,
    enPassant,
    halfmoveClock: requiredNatNumber(game.halfmove_clock, "halfmove clock"),
    fullmoveNumber: requiredNatNumber(game.fullmove_number, "fullmove number"),
    status,
    winner: optionalEnum(game.winner, CHESS_COLORS, "winner"),
    inCheck: requiredBoolean(game.in_check, "check state"),
    drawOfferBy: optionalEnum(game.draw_offer_by, CHESS_COLORS, "draw offer"),
    localColor: optionalEnum(game.local_color, CHESS_COLORS, "local color"),
    remoteConnected: requiredBoolean(game.remote_connected, "remote connection"),
    positionKeys: requiredPositionKeys(game.position_keys),
    legalMoves: requiredArray(game.legal_moves, "legal moves").map(parseLegalMove),
    history: requiredArray(game.history, "move history").map(parseMove),
  };
}

function requiredPositionKeys(value: JsonValue | undefined): string[] {
  const keys = requiredArray(value, "repetition history");
  if (
    keys.length < 1 ||
    keys.length > 1_025 ||
    keys.some((key) => typeof key !== "string" || key.length < 1 || key.length > 128)
  ) {
    throw new Error("Invalid repetition history");
  }
  return keys as string[];
}

function parseCastling(value: JsonValue | undefined): ChessCastling {
  const castling = requiredObject(value, "castling rights");
  return {
    whiteKingSide: requiredBoolean(castling.white_kingside, "white kingside castling"),
    whiteQueenSide: requiredBoolean(castling.white_queenside, "white queenside castling"),
    blackKingSide: requiredBoolean(castling.black_kingside, "black kingside castling"),
    blackQueenSide: requiredBoolean(castling.black_queenside, "black queenside castling"),
  };
}

function parseLegalMove(value: JsonValue): ChessLegalMove {
  const move = requiredObject(value, "legal move");
  return {
    from: requiredSquare(move.from, "move origin"),
    to: requiredSquare(move.to, "move destination"),
    promotion: optionalPromotion(move.promotion),
  };
}

function parseMove(value: JsonValue): ChessMove {
  const move = requiredObject(value, "move history entry");
  const legal = parseLegalMove(value);
  return {
    ...legal,
    ply: requiredNatNumber(move.ply, "move number"),
    piece: requiredPiece(move.piece, "moved piece"),
    placed: requiredPiece(move.placed, "placed piece"),
    captured: optionalPiece(move.captured),
    special: requiredString(move.special, "special move"),
    notation: requiredString(move.notation, "move notation"),
    at: requiredIntegerText(move.at, "move time"),
  };
}

function requiredRows(value: JsonValue | undefined): string[] {
  if (
    !Array.isArray(value) ||
    value.length !== 8 ||
    value.some((row) => typeof row !== "string" || !/^[rnbqkpRNBQKP.]{8}$/.test(row))
  ) {
    throw new Error("Invalid Chess board");
  }
  return value as string[];
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function requiredArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return value;
}

function requiredBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
  return value;
}

function requiredSquare(value: JsonValue | undefined, label: string): string {
  const square = requiredString(value, label);
  if (!/^[a-h][1-8]$/.test(square)) throw new Error(`Invalid ${label}`);
  return square;
}

function optionalSquare(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  return requiredSquare(value, "en passant square");
}

function requiredPiece(value: JsonValue | undefined, label: string): PieceCode {
  if (typeof value !== "string" || !/^[wb][KQRBNP]$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as PieceCode;
}

function optionalPiece(value: JsonValue | undefined): PieceCode | null {
  if (value === undefined || value === null) return null;
  return requiredPiece(value, "captured piece");
}

function optionalPromotion(value: JsonValue | undefined): PromotionPiece | null {
  if (value === undefined || value === null) return null;
  if (value !== "q" && value !== "r" && value !== "b" && value !== "n") {
    throw new Error("Invalid promotion piece");
  }
  return value;
}

function requiredNatNumber(value: JsonValue | undefined, label: string): number {
  try {
    const parsed = BigInt(value as string | number);
    if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
    return Number(parsed);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function requiredIntegerText(value: JsonValue | undefined, label: string): string {
  try {
    return BigInt(value as string | number).toString();
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function requiredEnum<const T extends readonly string[]>(
  value: JsonValue | undefined,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as T[number];
}

function optionalEnum<const T extends readonly string[]>(
  value: JsonValue | undefined,
  allowed: T,
  label: string,
): T[number] | null {
  if (value === undefined || value === null) return null;
  return requiredEnum(value, allowed, label);
}
