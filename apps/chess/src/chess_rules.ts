export const CHESS_FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

export const INITIAL_ROWS = [
  "rnbqkbnr",
  "pppppppp",
  "........",
  "........",
  "........",
  "........",
  "PPPPPPPP",
  "RNBQKBNR",
] as const;

export type ChessColor = "white" | "black";
export type PieceCode =
  | "wK"
  | "wQ"
  | "wR"
  | "wB"
  | "wN"
  | "wP"
  | "bK"
  | "bQ"
  | "bR"
  | "bB"
  | "bN"
  | "bP";
export type PromotionPiece = "q" | "r" | "b" | "n";
export type Square = `${(typeof CHESS_FILES)[number]}${
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"}`;

export type CastlingRights = {
  whiteKingSide: boolean;
  whiteQueenSide: boolean;
  blackKingSide: boolean;
  blackQueenSide: boolean;
};

export type Position = {
  /** Ranks 8 through 1. Uppercase pieces are white. */
  readonly rows: readonly string[];
  readonly turn: ChessColor;
  readonly castling: Readonly<CastlingRights>;
  /** The en-passant target square, in the same sense as FEN. */
  readonly enPassant: Square | null;
  readonly halfmoveClock: number;
  readonly fullmoveNumber: number;
  /** Counts canonical positions along the current game line. */
  readonly repetition: Readonly<Record<string, number>>;
};

export type PositionOptions = {
  rows?: readonly string[];
  turn?: ChessColor;
  castling?: Partial<CastlingRights>;
  enPassant?: string | null;
  halfmoveClock?: number;
  fullmoveNumber?: number;
  repetition?: Readonly<Record<string, number>>;
};

export type MoveInput = {
  from: string;
  to: string;
  promotion?: PromotionPiece;
};

export type MoveFlag =
  | "capture"
  | "double-pawn"
  | "en-passant"
  | "castle-kingside"
  | "castle-queenside"
  | "promotion";

export type LegalMove = {
  readonly from: Square;
  readonly to: Square;
  readonly piece: PieceCode;
  readonly captured: PieceCode | null;
  readonly capturedSquare: Square | null;
  readonly promotion: PromotionPiece | null;
  readonly flags: readonly MoveFlag[];
  readonly rookFrom: Square | null;
  readonly rookTo: Square | null;
};

export type AppliedMove = LegalMove & {
  readonly ply: number;
  readonly placed: PieceCode;
  readonly san: string;
  readonly uci: string;
};

export type GameOutcome = {
  readonly result: "1-0" | "0-1" | "1/2-1/2";
  readonly winner: ChessColor | null;
  readonly reason:
    | "checkmate"
    | "stalemate"
    | "fifty-move"
    | "threefold-repetition"
    | "insufficient-material";
};

export type PositionStatus = {
  readonly turn: ChessColor;
  readonly inCheck: boolean;
  readonly legalMoveCount: number;
  readonly outcome: GameOutcome | null;
};

export type MoveResult = {
  /** The unchanged input position. Keeping it makes an undo exact and cheap. */
  readonly before: Position;
  readonly position: Position;
  readonly move: AppliedMove;
  readonly status: PositionStatus;
};

export type ChessRulesErrorCode =
  | "INVALID_POSITION"
  | "INVALID_SQUARE"
  | "GAME_OVER"
  | "NO_PIECE"
  | "WRONG_TURN"
  | "ILLEGAL_MOVE"
  | "PROMOTION_REQUIRED"
  | "INVALID_PROMOTION";

export class ChessRulesError extends Error {
  constructor(
    readonly code: ChessRulesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChessRulesError";
  }
}

type Coordinate = { file: number; row: number };
type MutablePosition = {
  rows: string[];
  turn: ChessColor;
  castling: CastlingRights;
  enPassant: Square | null;
  halfmoveClock: number;
  fullmoveNumber: number;
  repetition: Record<string, number>;
};

const NO_CASTLING: CastlingRights = {
  whiteKingSide: false,
  whiteQueenSide: false,
  blackKingSide: false,
  blackQueenSide: false,
};

const ALL_CASTLING: CastlingRights = {
  whiteKingSide: true,
  whiteQueenSide: true,
  blackKingSide: true,
  blackQueenSide: true,
};

const PROMOTIONS: readonly PromotionPiece[] = ["q", "r", "b", "n"];

export function createInitialPosition(): Position {
  return createPosition();
}

export function createPosition(options: PositionOptions = {}): Position {
  const rows = [...(options.rows ?? INITIAL_ROWS)];
  validateRows(rows);
  const turn = options.turn ?? "white";
  if (turn !== "white" && turn !== "black") invalidPosition("Invalid side to move");

  const defaultCastling = options.rows ? NO_CASTLING : ALL_CASTLING;
  const castling: CastlingRights = {
    ...defaultCastling,
    ...(options.castling ?? {}),
  };
  for (const value of Object.values(castling)) {
    if (typeof value !== "boolean") invalidPosition("Invalid castling rights");
  }

  const enPassant =
    options.enPassant === undefined || options.enPassant === null
      ? null
      : normalizeSquare(options.enPassant);
  if (enPassant) {
    const rank = enPassant[1];
    if (
      (turn === "white" && rank !== "6") ||
      (turn === "black" && rank !== "3")
    ) {
      invalidPosition("Invalid en-passant target for the side to move");
    }
  }

  const halfmoveClock = options.halfmoveClock ?? 0;
  const fullmoveNumber = options.fullmoveNumber ?? 1;
  if (!Number.isSafeInteger(halfmoveClock) || halfmoveClock < 0) {
    invalidPosition("Invalid halfmove clock");
  }
  if (!Number.isSafeInteger(fullmoveNumber) || fullmoveNumber < 1) {
    invalidPosition("Invalid fullmove number");
  }

  const repetition: Record<string, number> = {};
  for (const [key, count] of Object.entries(options.repetition ?? {})) {
    if (!key || !Number.isSafeInteger(count) || count < 1) {
      invalidPosition("Invalid repetition table");
    }
    repetition[key] = count;
  }

  const draft: MutablePosition = {
    rows,
    turn,
    castling,
    enPassant,
    halfmoveClock,
    fullmoveNumber,
    repetition,
  };
  if (Object.keys(repetition).length === 0) repetition[positionKey(draft)] = 1;
  return freezePosition(draft);
}

export function pieceAt(position: Position, square: string): PieceCode | null {
  const coordinate = squareToCoordinate(normalizeSquare(square));
  return symbolToPiece(position.rows[coordinate.row]![coordinate.file]!);
}

export function generateLegalMoves(
  position: Position,
  from?: string,
): LegalMove[] {
  const normalizedFrom = from === undefined ? null : normalizeSquare(from);
  const moves: LegalMove[] = [];

  for (let row = 0; row < 8; row += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = symbolToPiece(position.rows[row]![file]!);
      if (!piece || colorOf(piece) !== position.turn) continue;
      const square = coordinateToSquare(file, row);
      if (normalizedFrom && square !== normalizedFrom) continue;
      for (const move of pseudoMovesFrom(position, square, piece)) {
        const next = applyUnchecked(position, move);
        const king = findKing(next, position.turn);
        if (!isSquareAttacked(next, king, opposite(position.turn))) moves.push(move);
      }
    }
  }
  return moves;
}

export function applyMove(position: Position, input: MoveInput): MoveResult {
  const beforeStatus = getPositionStatus(position);
  if (beforeStatus.outcome) {
    throw new ChessRulesError("GAME_OVER", "The game is already over");
  }

  const from = normalizeSquare(input.from);
  const to = normalizeSquare(input.to);
  if (from === to) {
    throw new ChessRulesError("ILLEGAL_MOVE", "Choose two different squares");
  }
  const piece = pieceAt(position, from);
  if (!piece) throw new ChessRulesError("NO_PIECE", `No piece on ${from}`);
  if (colorOf(piece) !== position.turn) {
    throw new ChessRulesError("WRONG_TURN", `It is ${position.turn}'s turn`);
  }
  if (input.promotion !== undefined && !isPromotion(input.promotion)) {
    throw new ChessRulesError(
      "INVALID_PROMOTION",
      "Promotion must be q, r, b, or n",
    );
  }

  const fromMoves = generateLegalMoves(position, from);
  const candidates = fromMoves.filter((move) => move.to === to);
  const promotionCandidates = candidates.filter((move) => move.promotion !== null);
  if (promotionCandidates.length > 0 && input.promotion === undefined) {
    throw new ChessRulesError(
      "PROMOTION_REQUIRED",
      "Choose q, r, b, or n for the promotion",
    );
  }
  if (promotionCandidates.length === 0 && input.promotion !== undefined) {
    throw new ChessRulesError(
      "INVALID_PROMOTION",
      "This move does not promote a pawn",
    );
  }
  const move = candidates.find(
    (candidate) => candidate.promotion === (input.promotion ?? null),
  );
  if (!move) {
    throw new ChessRulesError(
      "ILLEGAL_MOVE",
      `${pieceName(piece)} cannot move from ${from} to ${to}`,
    );
  }

  const next = applyUnchecked(position, move);
  const key = positionKey(next);
  next.repetition = { ...position.repetition };
  next.repetition[key] = (next.repetition[key] ?? 0) + 1;
  const frozenNext = freezePosition(next);
  const status = getPositionStatus(frozenNext);
  const placed = move.promotion
    ? (`${piece[0]}${move.promotion.toUpperCase()}` as PieceCode)
    : piece;
  const applied: AppliedMove = Object.freeze({
    ...move,
    flags: Object.freeze([...move.flags]),
    ply:
      (position.fullmoveNumber - 1) * 2 +
      (position.turn === "white" ? 1 : 2),
    placed,
    san: formatSan(position, move, status),
    uci: `${move.from}${move.to}${move.promotion ?? ""}`,
  });

  return Object.freeze({
    before: position,
    position: frozenNext,
    move: applied,
    status,
  });
}

export function undoMove(result: MoveResult): Position {
  return result.before;
}

export function getPositionStatus(position: Position): PositionStatus {
  const moves = generateLegalMoves(position);
  const inCheck = isInCheck(position, position.turn);
  let outcome: GameOutcome | null = null;

  if (moves.length === 0) {
    outcome = inCheck
      ? winOutcome(opposite(position.turn), "checkmate")
      : drawOutcome("stalemate");
  } else if (hasInsufficientMaterial(position)) {
    outcome = drawOutcome("insufficient-material");
  } else if (position.halfmoveClock >= 100) {
    outcome = drawOutcome("fifty-move");
  } else if ((position.repetition[positionKey(position)] ?? 0) >= 3) {
    outcome = drawOutcome("threefold-repetition");
  }

  return Object.freeze({
    turn: position.turn,
    inCheck,
    legalMoveCount: moves.length,
    outcome,
  });
}

export function isInCheck(
  position: Position,
  color: ChessColor = position.turn,
): boolean {
  return isSquareAttacked(position, findKing(position, color), opposite(color));
}

/**
 * Canonical repetition key. An en-passant square is included only when the
 * side to move has a legal en-passant capture, because only then does it
 * change the set of legal moves.
 */
export function positionKey(position: Position): string {
  const castling = [
    position.castling.whiteKingSide ? "K" : "",
    position.castling.whiteQueenSide ? "Q" : "",
    position.castling.blackKingSide ? "k" : "",
    position.castling.blackQueenSide ? "q" : "",
  ].join("");
  return [
    position.rows.join("/"),
    position.turn === "white" ? "w" : "b",
    castling || "-",
    effectiveEnPassant(position) ?? "-",
  ].join(" ");
}

export function hasInsufficientMaterial(position: Position): boolean {
  const material: Array<{ piece: PieceCode; file: number; row: number }> = [];
  for (let row = 0; row < 8; row += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = symbolToPiece(position.rows[row]![file]!);
      if (piece && piece[1] !== "K") material.push({ piece, file, row });
    }
  }
  if (material.length === 0) return true;
  if (
    material.length === 1 &&
    (material[0]!.piece[1] === "B" || material[0]!.piece[1] === "N")
  ) {
    return true;
  }
  if (material.every(({ piece }) => piece[1] === "B")) {
    const squareColors = new Set(
      material.map(({ file, row }) => (file + row) % 2),
    );
    return squareColors.size === 1;
  }
  return false;
}

function pseudoMovesFrom(
  position: Position,
  from: Square,
  piece: PieceCode,
): LegalMove[] {
  const kind = piece[1];
  if (kind === "P") return pawnMoves(position, from, piece);
  if (kind === "N") return jumpingMoves(position, from, piece, KNIGHT_STEPS);
  if (kind === "B") return slidingMoves(position, from, piece, BISHOP_DIRECTIONS);
  if (kind === "R") return slidingMoves(position, from, piece, ROOK_DIRECTIONS);
  if (kind === "Q") {
    return slidingMoves(position, from, piece, [
      ...BISHOP_DIRECTIONS,
      ...ROOK_DIRECTIONS,
    ]);
  }
  return kingMoves(position, from, piece);
}

function pawnMoves(position: Position, from: Square, piece: PieceCode): LegalMove[] {
  const { file, row } = squareToCoordinate(from);
  const color = colorOf(piece);
  const direction = color === "white" ? -1 : 1;
  const startRow = color === "white" ? 6 : 1;
  const promotionRow = color === "white" ? 0 : 7;
  const moves: LegalMove[] = [];

  const oneRow = row + direction;
  if (inside(file, oneRow) && !pieceAtCoordinate(position, file, oneRow)) {
    addPawnMove(moves, from, file, oneRow, piece, null, null, promotionRow, []);
    const twoRow = row + direction * 2;
    if (
      row === startRow &&
      inside(file, twoRow) &&
      !pieceAtCoordinate(position, file, twoRow)
    ) {
      moves.push(
        makeMove(from, coordinateToSquare(file, twoRow), piece, {
          flags: ["double-pawn"],
        }),
      );
    }
  }

  for (const deltaFile of [-1, 1]) {
    const targetFile = file + deltaFile;
    const targetRow = row + direction;
    if (!inside(targetFile, targetRow)) continue;
    const to = coordinateToSquare(targetFile, targetRow);
    const target = pieceAtCoordinate(position, targetFile, targetRow);
    if (target && colorOf(target) !== color && target[1] !== "K") {
      addPawnMove(
        moves,
        from,
        targetFile,
        targetRow,
        piece,
        target,
        to,
        promotionRow,
        ["capture"],
      );
      continue;
    }
    if (position.enPassant !== to || target) continue;
    const capturedRow = targetRow - direction;
    const captured = pieceAtCoordinate(position, targetFile, capturedRow);
    if (captured === `${color === "white" ? "b" : "w"}P`) {
      moves.push(
        makeMove(from, to, piece, {
          captured,
          capturedSquare: coordinateToSquare(targetFile, capturedRow),
          flags: ["capture", "en-passant"],
        }),
      );
    }
  }
  return moves;
}

function addPawnMove(
  moves: LegalMove[],
  from: Square,
  targetFile: number,
  targetRow: number,
  piece: PieceCode,
  captured: PieceCode | null,
  capturedSquare: Square | null,
  promotionRow: number,
  flags: MoveFlag[],
): void {
  const to = coordinateToSquare(targetFile, targetRow);
  if (targetRow === promotionRow) {
    for (const promotion of PROMOTIONS) {
      moves.push(
        makeMove(from, to, piece, {
          captured,
          capturedSquare,
          promotion,
          flags: [...flags, "promotion"],
        }),
      );
    }
  } else {
    moves.push(makeMove(from, to, piece, { captured, capturedSquare, flags }));
  }
}

const KNIGHT_STEPS: readonly (readonly [number, number])[] = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
];
const BISHOP_DIRECTIONS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];
const ROOK_DIRECTIONS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function jumpingMoves(
  position: Position,
  from: Square,
  piece: PieceCode,
  steps: readonly (readonly [number, number])[],
): LegalMove[] {
  const { file, row } = squareToCoordinate(from);
  const moves: LegalMove[] = [];
  for (const [deltaFile, deltaRow] of steps) {
    const targetFile = file + deltaFile;
    const targetRow = row + deltaRow;
    if (!inside(targetFile, targetRow)) continue;
    const target = pieceAtCoordinate(position, targetFile, targetRow);
    if (target && (colorOf(target) === colorOf(piece) || target[1] === "K")) continue;
    moves.push(
      makeMove(from, coordinateToSquare(targetFile, targetRow), piece, {
        captured: target,
        capturedSquare: target ? coordinateToSquare(targetFile, targetRow) : null,
        flags: target ? ["capture"] : [],
      }),
    );
  }
  return moves;
}

function slidingMoves(
  position: Position,
  from: Square,
  piece: PieceCode,
  directions: readonly (readonly [number, number])[],
): LegalMove[] {
  const { file, row } = squareToCoordinate(from);
  const moves: LegalMove[] = [];
  for (const [deltaFile, deltaRow] of directions) {
    let targetFile = file + deltaFile;
    let targetRow = row + deltaRow;
    while (inside(targetFile, targetRow)) {
      const target = pieceAtCoordinate(position, targetFile, targetRow);
      const to = coordinateToSquare(targetFile, targetRow);
      if (!target) {
        moves.push(makeMove(from, to, piece));
      } else {
        if (colorOf(target) !== colorOf(piece) && target[1] !== "K") {
          moves.push(
            makeMove(from, to, piece, {
              captured: target,
              capturedSquare: to,
              flags: ["capture"],
            }),
          );
        }
        break;
      }
      targetFile += deltaFile;
      targetRow += deltaRow;
    }
  }
  return moves;
}

function kingMoves(position: Position, from: Square, piece: PieceCode): LegalMove[] {
  const moves = jumpingMoves(position, from, piece, [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 0],
    [1, 1],
  ]);
  const color = colorOf(piece);
  const enemy = opposite(color);
  const homeRow = color === "white" ? 7 : 0;
  const homeKing = coordinateToSquare(4, homeRow);
  if (from !== homeKing || isSquareAttacked(position, homeKing, enemy)) return moves;

  const kingSide = color === "white"
    ? position.castling.whiteKingSide
    : position.castling.blackKingSide;
  if (
    kingSide &&
    pieceAtCoordinate(position, 7, homeRow) === `${piece[0]}R` &&
    !pieceAtCoordinate(position, 5, homeRow) &&
    !pieceAtCoordinate(position, 6, homeRow) &&
    !isSquareAttacked(position, coordinateToSquare(5, homeRow), enemy) &&
    !isSquareAttacked(position, coordinateToSquare(6, homeRow), enemy)
  ) {
    moves.push(
      makeMove(from, coordinateToSquare(6, homeRow), piece, {
        flags: ["castle-kingside"],
        rookFrom: coordinateToSquare(7, homeRow),
        rookTo: coordinateToSquare(5, homeRow),
      }),
    );
  }

  const queenSide = color === "white"
    ? position.castling.whiteQueenSide
    : position.castling.blackQueenSide;
  if (
    queenSide &&
    pieceAtCoordinate(position, 0, homeRow) === `${piece[0]}R` &&
    !pieceAtCoordinate(position, 1, homeRow) &&
    !pieceAtCoordinate(position, 2, homeRow) &&
    !pieceAtCoordinate(position, 3, homeRow) &&
    !isSquareAttacked(position, coordinateToSquare(3, homeRow), enemy) &&
    !isSquareAttacked(position, coordinateToSquare(2, homeRow), enemy)
  ) {
    moves.push(
      makeMove(from, coordinateToSquare(2, homeRow), piece, {
        flags: ["castle-queenside"],
        rookFrom: coordinateToSquare(0, homeRow),
        rookTo: coordinateToSquare(3, homeRow),
      }),
    );
  }
  return moves;
}

function makeMove(
  from: Square,
  to: Square,
  piece: PieceCode,
  options: {
    captured?: PieceCode | null;
    capturedSquare?: Square | null;
    promotion?: PromotionPiece | null;
    flags?: MoveFlag[];
    rookFrom?: Square | null;
    rookTo?: Square | null;
  } = {},
): LegalMove {
  return {
    from,
    to,
    piece,
    captured: options.captured ?? null,
    capturedSquare: options.capturedSquare ?? null,
    promotion: options.promotion ?? null,
    flags: options.flags ?? [],
    rookFrom: options.rookFrom ?? null,
    rookTo: options.rookTo ?? null,
  };
}

function applyUnchecked(position: Position, move: LegalMove): MutablePosition {
  const board = position.rows.map((row) => [...row]);
  const from = squareToCoordinate(move.from);
  const to = squareToCoordinate(move.to);
  board[from.row]![from.file] = ".";
  if (move.capturedSquare) {
    const captured = squareToCoordinate(move.capturedSquare);
    board[captured.row]![captured.file] = ".";
  }
  const symbol = move.promotion
    ? pieceToSymbol(`${move.piece[0]}${move.promotion.toUpperCase()}` as PieceCode)
    : pieceToSymbol(move.piece);
  board[to.row]![to.file] = symbol;

  if (move.rookFrom && move.rookTo) {
    const rookFrom = squareToCoordinate(move.rookFrom);
    const rookTo = squareToCoordinate(move.rookTo);
    board[rookFrom.row]![rookFrom.file] = ".";
    board[rookTo.row]![rookTo.file] = pieceToSymbol(`${move.piece[0]}R` as PieceCode);
  }

  const castling = { ...position.castling };
  updateCastlingRights(castling, move);
  const doublePawn = move.flags.includes("double-pawn");
  const enPassant = doublePawn
    ? coordinateToSquare(from.file, (from.row + to.row) / 2)
    : null;

  return {
    rows: board.map((row) => row.join("")),
    turn: opposite(position.turn),
    castling,
    enPassant,
    halfmoveClock:
      move.piece[1] === "P" || move.captured ? 0 : position.halfmoveClock + 1,
    fullmoveNumber:
      position.fullmoveNumber + (position.turn === "black" ? 1 : 0),
    repetition: { ...position.repetition },
  };
}

function updateCastlingRights(rights: CastlingRights, move: LegalMove): void {
  if (move.piece === "wK") {
    rights.whiteKingSide = false;
    rights.whiteQueenSide = false;
  } else if (move.piece === "bK") {
    rights.blackKingSide = false;
    rights.blackQueenSide = false;
  } else if (move.piece === "wR") {
    if (move.from === "h1") rights.whiteKingSide = false;
    if (move.from === "a1") rights.whiteQueenSide = false;
  } else if (move.piece === "bR") {
    if (move.from === "h8") rights.blackKingSide = false;
    if (move.from === "a8") rights.blackQueenSide = false;
  }

  if (move.captured === "wR") {
    if (move.capturedSquare === "h1") rights.whiteKingSide = false;
    if (move.capturedSquare === "a1") rights.whiteQueenSide = false;
  } else if (move.captured === "bR") {
    if (move.capturedSquare === "h8") rights.blackKingSide = false;
    if (move.capturedSquare === "a8") rights.blackQueenSide = false;
  }
}

function isSquareAttacked(
  position: Position,
  square: Square,
  byColor: ChessColor,
): boolean {
  const target = squareToCoordinate(square);
  for (let row = 0; row < 8; row += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = pieceAtCoordinate(position, file, row);
      if (!piece || colorOf(piece) !== byColor) continue;
      const deltaFile = target.file - file;
      const deltaRow = target.row - row;
      const absoluteFile = Math.abs(deltaFile);
      const absoluteRow = Math.abs(deltaRow);
      if (piece[1] === "P") {
        const direction = byColor === "white" ? -1 : 1;
        if (absoluteFile === 1 && deltaRow === direction) return true;
      } else if (piece[1] === "N") {
        if (
          (absoluteFile === 1 && absoluteRow === 2) ||
          (absoluteFile === 2 && absoluteRow === 1)
        ) {
          return true;
        }
      } else if (piece[1] === "K") {
        if (Math.max(absoluteFile, absoluteRow) === 1) return true;
      } else {
        const diagonal = absoluteFile === absoluteRow && absoluteFile > 0;
        const straight =
          (deltaFile === 0 && deltaRow !== 0) ||
          (deltaRow === 0 && deltaFile !== 0);
        if (
          ((piece[1] === "B" && diagonal) ||
            (piece[1] === "R" && straight) ||
            (piece[1] === "Q" && (diagonal || straight))) &&
          rayIsClear(position, file, row, target.file, target.row)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function rayIsClear(
  position: Position,
  fromFile: number,
  fromRow: number,
  toFile: number,
  toRow: number,
): boolean {
  const stepFile = Math.sign(toFile - fromFile);
  const stepRow = Math.sign(toRow - fromRow);
  let file = fromFile + stepFile;
  let row = fromRow + stepRow;
  while (file !== toFile || row !== toRow) {
    if (pieceAtCoordinate(position, file, row)) return false;
    file += stepFile;
    row += stepRow;
  }
  return true;
}

function effectiveEnPassant(position: Position): Square | null {
  if (!position.enPassant) return null;
  const target = squareToCoordinate(position.enPassant);
  const direction = position.turn === "white" ? -1 : 1;
  const sourceRow = target.row - direction;
  const ownPawn = `${position.turn === "white" ? "w" : "b"}P` as PieceCode;
  const enemyPawn = `${position.turn === "white" ? "b" : "w"}P` as PieceCode;
  const capturedSquare = coordinateToSquare(target.file, sourceRow);
  if (pieceAtCoordinate(position, target.file, sourceRow) !== enemyPawn) return null;

  for (const sourceFile of [target.file - 1, target.file + 1]) {
    if (!inside(sourceFile, sourceRow)) continue;
    if (pieceAtCoordinate(position, sourceFile, sourceRow) !== ownPawn) continue;
    const move = makeMove(
      coordinateToSquare(sourceFile, sourceRow),
      position.enPassant,
      ownPawn,
      {
        captured: enemyPawn,
        capturedSquare,
        flags: ["capture", "en-passant"],
      },
    );
    const next = applyUnchecked(position, move);
    if (!isSquareAttacked(next, findKing(next, position.turn), opposite(position.turn))) {
      return position.enPassant;
    }
  }
  return null;
}

function formatSan(
  before: Position,
  move: LegalMove,
  afterStatus: PositionStatus,
): string {
  let san: string;
  if (move.flags.includes("castle-kingside")) {
    san = "O-O";
  } else if (move.flags.includes("castle-queenside")) {
    san = "O-O-O";
  } else {
    const kind = move.piece[1];
    const capture = move.captured !== null;
    if (kind === "P") {
      san = capture ? `${move.from[0]}x${move.to}` : move.to;
    } else {
      san = `${kind}${sanDisambiguation(before, move)}${capture ? "x" : ""}${move.to}`;
    }
    if (move.promotion) san += `=${move.promotion.toUpperCase()}`;
  }
  if (afterStatus.inCheck) {
    san += afterStatus.outcome?.reason === "checkmate" ? "#" : "+";
  }
  return san;
}

function sanDisambiguation(position: Position, move: LegalMove): string {
  const competitors = generateLegalMoves(position).filter(
    (candidate) =>
      candidate.from !== move.from &&
      candidate.to === move.to &&
      candidate.piece === move.piece,
  );
  if (competitors.length === 0) return "";
  const sameFile = competitors.some((candidate) => candidate.from[0] === move.from[0]);
  const sameRank = competitors.some((candidate) => candidate.from[1] === move.from[1]);
  if (!sameFile) return move.from.charAt(0);
  if (!sameRank) return move.from.charAt(1);
  return move.from;
}

function findKing(position: Position, color: ChessColor): Square {
  const sought = color === "white" ? "K" : "k";
  for (let row = 0; row < 8; row += 1) {
    const file = position.rows[row]!.indexOf(sought);
    if (file >= 0) return coordinateToSquare(file, row);
  }
  invalidPosition(`Missing ${color} king`);
}

function pieceAtCoordinate(
  position: Position,
  file: number,
  row: number,
): PieceCode | null {
  if (!inside(file, row)) return null;
  return symbolToPiece(position.rows[row]![file]!);
}

function symbolToPiece(symbol: string): PieceCode | null {
  if (symbol === ".") return null;
  const upper = symbol.toUpperCase();
  if (!"KQRBNP".includes(upper)) invalidPosition("Invalid chess piece");
  return `${symbol === upper ? "w" : "b"}${upper}` as PieceCode;
}

function pieceToSymbol(piece: PieceCode): string {
  const kind = piece.charAt(1);
  return piece[0] === "w" ? kind : kind.toLowerCase();
}

function colorOf(piece: PieceCode): ChessColor {
  return piece[0] === "w" ? "white" : "black";
}

function opposite(color: ChessColor): ChessColor {
  return color === "white" ? "black" : "white";
}

function normalizeSquare(value: string): Square {
  const square = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-h][1-8]$/.test(square)) {
    throw new ChessRulesError("INVALID_SQUARE", `Invalid square '${String(value)}'`);
  }
  return square as Square;
}

function squareToCoordinate(square: Square): Coordinate {
  return {
    file: square.charCodeAt(0) - 97,
    row: 8 - Number(square[1]),
  };
}

function coordinateToSquare(file: number, row: number): Square {
  return `${CHESS_FILES[file]}${8 - row}` as Square;
}

function inside(file: number, row: number): boolean {
  return file >= 0 && file < 8 && row >= 0 && row < 8;
}

function validateRows(rows: string[]): void {
  if (
    rows.length !== 8 ||
    rows.some((row) => typeof row !== "string" || !/^[rnbqkpRNBQKP.]{8}$/.test(row))
  ) {
    invalidPosition("A chess position must contain eight valid rows");
  }
  const board = rows.join("");
  if ((board.match(/K/g) ?? []).length !== 1 || (board.match(/k/g) ?? []).length !== 1) {
    invalidPosition("A chess position must contain exactly one king of each color");
  }
}

function freezePosition(position: MutablePosition): Position {
  const rows = Object.freeze([...position.rows]);
  const castling = Object.freeze({ ...position.castling });
  const repetition = Object.freeze({ ...position.repetition });
  return Object.freeze({
    rows,
    turn: position.turn,
    castling,
    enPassant: position.enPassant,
    halfmoveClock: position.halfmoveClock,
    fullmoveNumber: position.fullmoveNumber,
    repetition,
  });
}

function isPromotion(value: unknown): value is PromotionPiece {
  return value === "q" || value === "r" || value === "b" || value === "n";
}

function pieceName(piece: PieceCode): string {
  const names: Record<PieceCode[1], string> = {
    K: "King",
    Q: "Queen",
    R: "Rook",
    B: "Bishop",
    N: "Knight",
    P: "Pawn",
  };
  return names[piece.charAt(1) as PieceCode[1]]!;
}

function drawOutcome(reason: GameOutcome["reason"]): GameOutcome {
  return Object.freeze({ result: "1/2-1/2", winner: null, reason });
}

function winOutcome(
  winner: ChessColor,
  reason: "checkmate",
): GameOutcome {
  return Object.freeze({
    result: winner === "white" ? "1-0" : "0-1",
    winner,
    reason,
  });
}

function invalidPosition(message: string): never {
  throw new ChessRulesError("INVALID_POSITION", message);
}
