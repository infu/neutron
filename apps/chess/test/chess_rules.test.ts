import { describe, expect, test } from "bun:test";
import {
  ChessRulesError,
  INITIAL_ROWS,
  applyMove,
  createInitialPosition,
  createPosition,
  generateLegalMoves,
  getPositionStatus,
  hasInsufficientMaterial,
  isInCheck,
  pieceAt,
  positionKey,
  undoMove,
  type CastlingRights,
  type ChessColor,
  type PieceCode,
  type Position,
  type PositionOptions,
  type Square,
} from "../src/chess_rules.ts";

const noCastling: CastlingRights = {
  whiteKingSide: false,
  whiteQueenSide: false,
  blackKingSide: false,
  blackQueenSide: false,
};

function rows(pieces: Partial<Record<Square, PieceCode>>): string[] {
  const board = Array.from({ length: 8 }, () => Array(8).fill("."));
  for (const [square, piece] of Object.entries(pieces) as Array<
    [Square, PieceCode]
  >) {
    const file = square.charCodeAt(0) - 97;
    const row = 8 - Number(square.charAt(1));
    const symbol = piece.charAt(1);
    board[row]![file] = piece.startsWith("w") ? symbol : symbol.toLowerCase();
  }
  return board.map((rank) => rank.join(""));
}

function setup(
  pieces: Partial<Record<Square, PieceCode>>,
  options: Omit<PositionOptions, "rows"> = {},
): Position {
  return createPosition({ rows: rows(pieces), ...options });
}

function move(
  position: Position,
  from: string,
  to: string,
  promotion?: "q" | "r" | "b" | "n",
): Position {
  return applyMove(position, { from, to, ...(promotion ? { promotion } : {}) })
    .position;
}

function expectCode(operation: () => unknown, code: ChessRulesError["code"]): void {
  try {
    operation();
    throw new Error("Expected chess rules operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ChessRulesError);
    expect((error as ChessRulesError).code).toBe(code);
  }
}

describe("initial position and ordinary movement", () => {
  test("starts in the standard position with exactly twenty legal moves", () => {
    const position = createInitialPosition();
    expect(position.rows).toEqual(INITIAL_ROWS);
    expect(position.turn).toBe("white");
    expect(generateLegalMoves(position)).toHaveLength(20);
    expect(generateLegalMoves(position, "e2").map(({ to }) => to).sort()).toEqual([
      "e3",
      "e4",
    ]);
    expect(generateLegalMoves(position, "g1").map(({ to }) => to).sort()).toEqual([
      "f3",
      "h3",
    ]);
    expect(generateLegalMoves(position, "e7")).toEqual([]);
    expect(getPositionStatus(position)).toMatchObject({
      turn: "white",
      inCheck: false,
      legalMoveCount: 20,
      outcome: null,
    });
  });

  test("applies a move immutably and updates turn, clocks, en passant, and notation", () => {
    const before = createInitialPosition();
    const result = applyMove(before, { from: " E2 ", to: "E4" });

    expect(before.rows).toEqual(INITIAL_ROWS);
    expect(pieceAt(before, "e2")).toBe("wP");
    expect(pieceAt(result.position, "e2")).toBeNull();
    expect(pieceAt(result.position, "e4")).toBe("wP");
    expect(result.position).toMatchObject({
      turn: "black",
      enPassant: "e3",
      halfmoveClock: 0,
      fullmoveNumber: 1,
    });
    expect(result.move).toMatchObject({
      ply: 1,
      san: "e4",
      uci: "e2e4",
      placed: "wP",
      flags: ["double-pawn"],
    });
    const black = applyMove(result.position, { from: "c7", to: "c5" });
    expect(black.position.fullmoveNumber).toBe(2);
    expect(black.move.ply).toBe(2);
  });

  test("rejects malformed, empty, out-of-turn, friendly, and geometrically illegal moves", () => {
    const position = createInitialPosition();
    expectCode(() => applyMove(position, { from: "z9", to: "a1" }), "INVALID_SQUARE");
    expectCode(() => applyMove(position, { from: "e3", to: "e4" }), "NO_PIECE");
    expectCode(() => applyMove(position, { from: "e7", to: "e6" }), "WRONG_TURN");
    expectCode(() => applyMove(position, { from: "e1", to: "e2" }), "ILLEGAL_MOVE");
    expectCode(() => applyMove(position, { from: "e2", to: "e5" }), "ILLEGAL_MOVE");
  });

  test("sliders stop at blockers, knights jump, and kings are never capturable", () => {
    const position = setup({
      a8: "bK",
      d8: "bR",
      d5: "wP",
      d4: "wQ",
      f3: "wN",
      h1: "wK",
    });
    const queenTargets = generateLegalMoves(position, "d4").map(({ to }) => to);
    expect(queenTargets).toContain("d3");
    expect(queenTargets).not.toContain("d5");
    expect(queenTargets).not.toContain("d6");
    expect(generateLegalMoves(position, "f3").map(({ to }) => to)).toContain("d2");

    const checking = setup({ a8: "bK", a7: "wQ", h1: "wK" });
    expect(generateLegalMoves(checking, "a7").some(({ to }) => to === "a8")).toBe(
      false,
    );
  });

  test("matches the standard two-ply move-generation count", () => {
    const initial = createInitialPosition();
    let nodes = 0;
    for (const white of generateLegalMoves(initial)) {
      const afterWhite = applyMove(initial, {
        from: white.from,
        to: white.to,
        ...(white.promotion ? { promotion: white.promotion } : {}),
      }).position;
      nodes += generateLegalMoves(afterWhite).length;
    }
    expect(nodes).toBe(400);
  });
});

describe("king safety and game endings", () => {
  test("filters pinned moves that expose the king", () => {
    const position = setup({
      a8: "bK",
      e8: "bR",
      e2: "wR",
      e1: "wK",
    });
    const targets = generateLegalMoves(position, "e2").map(({ to }) => to);
    expect(targets).toContain("e3");
    expect(targets).toContain("e8");
    expect(targets).not.toContain("d2");
    expect(targets).not.toContain("f2");
  });

  test("a king cannot move into check or next to the other king", () => {
    const position = setup({ a8: "bK", b6: "bR", a1: "wK" });
    expect(generateLegalMoves(position, "a1").map(({ to }) => to)).not.toContain("b1");

    const kings = setup({ c3: "bK", a1: "wK" });
    expect(generateLegalMoves(kings, "a1").map(({ to }) => to)).not.toContain("b2");
  });

  test("detects check and Fool's Mate with checkmate SAN", () => {
    let position = createInitialPosition();
    position = move(position, "f2", "f3");
    position = move(position, "e7", "e5");
    position = move(position, "g2", "g4");
    const mate = applyMove(position, { from: "d8", to: "h4" });

    expect(isInCheck(mate.position)).toBe(true);
    expect(mate.move.san).toBe("Qh4#");
    expect(mate.status).toMatchObject({
      turn: "white",
      inCheck: true,
      legalMoveCount: 0,
      outcome: { result: "0-1", winner: "black", reason: "checkmate" },
    });
    expectCode(() => applyMove(mate.position, { from: "e2", to: "e3" }), "GAME_OVER");
  });

  test("detects stalemate", () => {
    const position = setup(
      { a8: "bK", b6: "wQ", c6: "wK" },
      { turn: "black" },
    );
    expect(isInCheck(position)).toBe(false);
    expect(getPositionStatus(position)).toMatchObject({
      legalMoveCount: 0,
      outcome: { result: "1/2-1/2", winner: null, reason: "stalemate" },
    });
  });

  test("checkmate takes precedence when a move also reaches fifty-move distance", () => {
    const position = setup(
      { h8: "bK", f6: "wK", g6: "wQ" },
      { halfmoveClock: 99 },
    );
    const mate = applyMove(position, { from: "g6", to: "g7" });
    expect(mate.position.halfmoveClock).toBe(100);
    expect(mate.move.san).toBe("Qg7#");
    expect(mate.status.outcome?.reason).toBe("checkmate");
  });
});

describe("castling", () => {
  test("generates and applies both castles, moving the rook and revoking rights", () => {
    const position = setup(
      { e8: "bK", a1: "wR", e1: "wK", h1: "wR" },
      {
        castling: {
          ...noCastling,
          whiteKingSide: true,
          whiteQueenSide: true,
        },
      },
    );
    const castles = generateLegalMoves(position, "e1");
    expect(castles.map(({ to }) => to)).toEqual(expect.arrayContaining(["c1", "g1"]));

    const result = applyMove(position, { from: "e1", to: "g1" });
    expect(pieceAt(result.position, "g1")).toBe("wK");
    expect(pieceAt(result.position, "f1")).toBe("wR");
    expect(pieceAt(result.position, "h1")).toBeNull();
    expect(result.position.castling.whiteKingSide).toBe(false);
    expect(result.position.castling.whiteQueenSide).toBe(false);
    expect(result.move.san).toBe("O-O");
    expect(undoMove(result)).toBe(position);
  });

  test("forbids castling out of, through, or into check and requires the rook", () => {
    const throughCheck = setup(
      { a8: "bK", f8: "bR", e1: "wK", h1: "wR" },
      { castling: { ...noCastling, whiteKingSide: true } },
    );
    expect(generateLegalMoves(throughCheck, "e1").map(({ to }) => to)).not.toContain("g1");

    const inCheck = setup(
      { a8: "bK", e8: "bR", e1: "wK", h1: "wR" },
      { castling: { ...noCastling, whiteKingSide: true } },
    );
    expect(generateLegalMoves(inCheck, "e1").map(({ to }) => to)).not.toContain("g1");

    const missingRook = setup(
      { e8: "bK", e1: "wK" },
      { castling: { ...noCastling, whiteKingSide: true } },
    );
    expect(generateLegalMoves(missingRook, "e1").map(({ to }) => to)).not.toContain("g1");
  });

  test("moving a rook away and back never restores castling rights", () => {
    let position = setup(
      { e8: "bK", e1: "wK", h1: "wR" },
      { castling: { ...noCastling, whiteKingSide: true } },
    );
    position = move(position, "h1", "h2");
    position = move(position, "e8", "e7");
    position = move(position, "h2", "h1");
    position = move(position, "e7", "e8");
    expect(position.castling.whiteKingSide).toBe(false);
    expect(generateLegalMoves(position, "e1").map(({ to }) => to)).not.toContain("g1");
  });

  test("supports black queenside castling and revokes rights when a home rook is captured", () => {
    const black = setup(
      { a8: "bR", e8: "bK", h8: "bR", e1: "wK" },
      {
        turn: "black",
        castling: {
          ...noCastling,
          blackKingSide: true,
          blackQueenSide: true,
        },
      },
    );
    const castle = applyMove(black, { from: "e8", to: "c8" });
    expect(pieceAt(castle.position, "c8")).toBe("bK");
    expect(pieceAt(castle.position, "d8")).toBe("bR");
    expect(castle.move.san).toBe("O-O-O");

    const capture = setup(
      { e8: "bK", h8: "bR", h7: "wQ", e1: "wK" },
      { castling: { ...noCastling, blackKingSide: true } },
    );
    const captured = applyMove(capture, { from: "h7", to: "h8" });
    expect(captured.position.castling.blackKingSide).toBe(false);
  });
});

describe("en passant", () => {
  test("allows only the immediate en-passant capture and removes the passed pawn", () => {
    let position = createInitialPosition();
    position = move(position, "e2", "e4");
    position = move(position, "a7", "a6");
    position = move(position, "e4", "e5");
    position = move(position, "d7", "d5");
    expect(position.enPassant).toBe("d6");

    const candidate = generateLegalMoves(position, "e5").find(({ to }) => to === "d6");
    expect(candidate?.flags).toEqual(["capture", "en-passant"]);
    const result = applyMove(position, { from: "e5", to: "d6" });
    expect(pieceAt(result.position, "d6")).toBe("wP");
    expect(pieceAt(result.position, "d5")).toBeNull();
    expect(result.position.enPassant).toBeNull();
    expect(result.move).toMatchObject({
      captured: "bP",
      capturedSquare: "d5",
      san: "exd6",
    });
    expect(undoMove(result)).toBe(position);
  });

  test("expires en passant after any other move", () => {
    let position = createInitialPosition();
    position = move(position, "e2", "e4");
    position = move(position, "a7", "a6");
    position = move(position, "e4", "e5");
    position = move(position, "d7", "d5");
    position = move(position, "h2", "h3");
    expect(position.enPassant).toBeNull();
    position = move(position, "a6", "a5");
    expect(generateLegalMoves(position, "e5").map(({ to }) => to)).not.toContain("d6");
  });

  test("rejects en passant when removing the pawn would expose its king", () => {
    const position = setup(
      { a8: "bK", e8: "bR", d5: "bP", e5: "wP", e1: "wK" },
      { enPassant: "d6" },
    );
    expect(generateLegalMoves(position, "e5").map(({ to }) => to)).not.toContain("d6");

    const withoutTarget = createPosition({
      rows: position.rows,
      turn: position.turn,
      castling: position.castling,
    });
    expect(positionKey(position)).toBe(positionKey(withoutTarget));
  });

  test("supports black en passant symmetrically", () => {
    let position = createInitialPosition();
    position = move(position, "a2", "a3");
    position = move(position, "e7", "e5");
    position = move(position, "a3", "a4");
    position = move(position, "e5", "e4");
    position = move(position, "d2", "d4");
    expect(position.enPassant).toBe("d3");
    const result = applyMove(position, { from: "e4", to: "d3" });
    expect(pieceAt(result.position, "d3")).toBe("bP");
    expect(pieceAt(result.position, "d4")).toBeNull();
    expect(result.move.san).toBe("exd3");
  });
});

describe("promotion", () => {
  test("requires a promotion choice and generates queen, rook, bishop, and knight", () => {
    const position = setup({ h8: "bK", a7: "wP", h1: "wK" });
    const promotions = generateLegalMoves(position, "a7").filter(({ to }) => to === "a8");
    expect(promotions.map(({ promotion }) => promotion).sort()).toEqual(["b", "n", "q", "r"]);
    expectCode(() => applyMove(position, { from: "a7", to: "a8" }), "PROMOTION_REQUIRED");

    const promoted = applyMove(position, { from: "a7", to: "a8", promotion: "q" });
    expect(pieceAt(promoted.position, "a8")).toBe("wQ");
    expect(promoted.move).toMatchObject({
      placed: "wQ",
      promotion: "q",
      flags: ["promotion"],
      san: "a8=Q+",
      uci: "a7a8q",
    });
    expect(undoMove(promoted)).toBe(position);
  });

  test("supports capture underpromotion and rejects promotion on an ordinary move", () => {
    const position = setup({ h8: "bK", b8: "bR", a7: "wP", h1: "wK" });
    const promoted = applyMove(position, {
      from: "a7",
      to: "b8",
      promotion: "n",
    });
    expect(pieceAt(promoted.position, "b8")).toBe("wN");
    expect(promoted.move).toMatchObject({
      captured: "bR",
      capturedSquare: "b8",
      san: "axb8=N",
    });

    expectCode(
      () => applyMove(createInitialPosition(), { from: "e2", to: "e4", promotion: "q" }),
      "INVALID_PROMOTION",
    );
  });

  test("supports black promotion symmetrically", () => {
    const position = setup(
      { h8: "bK", a2: "bP", h1: "wK" },
      { turn: "black" },
    );
    const result = applyMove(position, { from: "a2", to: "a1", promotion: "n" });
    expect(pieceAt(result.position, "a1")).toBe("bN");
    expect(result.move).toMatchObject({ san: "a1=N", uci: "a2a1n", placed: "bN" });
  });
});

describe("draw rules and repetition keys", () => {
  test("recognizes the standard insufficient-material positions conservatively", () => {
    const kingOnly = setup({ a8: "bK", h1: "wK" });
    const bishop = setup({ a8: "bK", c1: "wB", h1: "wK" });
    const knight = setup({ a8: "bK", c2: "wN", h1: "wK" });
    const sameBishops = setup({ h8: "bK", f4: "bB", c1: "wB", h1: "wK" });
    const oppositeBishops = setup({ h8: "bK", e4: "bB", c1: "wB", h1: "wK" });
    const twoKnights = setup({ a8: "bK", b1: "wN", c1: "wN", h1: "wK" });

    for (const position of [kingOnly, bishop, knight, sameBishops]) {
      expect(hasInsufficientMaterial(position)).toBe(true);
      expect(getPositionStatus(position).outcome?.reason).toBe("insufficient-material");
    }
    expect(hasInsufficientMaterial(oppositeBishops)).toBe(false);
    expect(hasInsufficientMaterial(twoKnights)).toBe(false);
  });

  test("draws automatically after one hundred reversible halfmoves", () => {
    const position = setup(
      { h8: "bK", a2: "wR", h1: "wK" },
      { halfmoveClock: 99 },
    );
    const result = applyMove(position, { from: "a2", to: "a3" });
    expect(result.position.halfmoveClock).toBe(100);
    expect(result.status.outcome?.reason).toBe("fifty-move");

    const pawnPosition = setup(
      { h8: "bK", a2: "wP", h1: "wK" },
      { halfmoveClock: 99 },
    );
    const pawnMove = applyMove(pawnPosition, { from: "a2", to: "a3" });
    expect(pawnMove.position.halfmoveClock).toBe(0);
    expect(pawnMove.status.outcome).toBeNull();
  });

  test("draws automatically on the third occurrence of the same position", () => {
    let position = createInitialPosition();
    for (let cycle = 0; cycle < 2; cycle += 1) {
      position = move(position, "g1", "f3");
      position = move(position, "g8", "f6");
      position = move(position, "f3", "g1");
      const result = applyMove(position, { from: "f6", to: "g8" });
      position = result.position;
      if (cycle === 0) expect(result.status.outcome).toBeNull();
      else expect(result.status.outcome?.reason).toBe("threefold-repetition");
    }
    expect(position.repetition[positionKey(position)]).toBe(3);
  });

  test("position keys include lost castling rights and only effective en passant", () => {
    const castle = setup(
      { e8: "bK", e1: "wK", h1: "wR" },
      { castling: { ...noCastling, whiteKingSide: true } },
    );
    const noCastle = createPosition({ rows: castle.rows, castling: noCastling });
    expect(positionKey(castle)).not.toBe(positionKey(noCastle));

    const unavailableEp = setup(
      { a8: "bK", d5: "bP", h1: "wK" },
      { enPassant: "d6" },
    );
    const unavailableEpOff = createPosition({ rows: unavailableEp.rows });
    expect(positionKey(unavailableEp)).toBe(positionKey(unavailableEpOff));

    const availableEp = setup(
      { a8: "bK", d5: "bP", e5: "wP", h1: "wK" },
      { enPassant: "d6" },
    );
    const availableEpOff = createPosition({ rows: availableEp.rows });
    expect(positionKey(availableEp)).not.toBe(positionKey(availableEpOff));
  });
});

describe("history-facing move details and validation", () => {
  test("SAN disambiguates only other legal movers", () => {
    const twoKnights = setup({ a8: "bK", d2: "wN", h2: "wN", a1: "wK" });
    expect(applyMove(twoKnights, { from: "d2", to: "f3" }).move.san).toBe("Ndf3");

    const sameFileRooks = setup({ h8: "bK", a3: "wR", a1: "wR", h1: "wK" });
    expect(applyMove(sameFileRooks, { from: "a1", to: "a2" }).move.san).toBe("R1a2");

    const pinnedCompetitor = setup({
      a8: "bK",
      e8: "bR",
      e2: "wN",
      g2: "wN",
      e1: "wK",
    });
    expect(applyMove(pinnedCompetitor, { from: "g2", to: "f4" }).move.san).toBe("Nf4");
  });

  test("capture details and immutable before-state make exact undo possible", () => {
    const position = setup({ a8: "bK", d4: "bB", d1: "wR", h1: "wK" });
    const result = applyMove(position, { from: "d1", to: "d4" });
    expect(result.move).toMatchObject({
      captured: "bB",
      capturedSquare: "d4",
      san: "Rxd4",
    });
    expect(result.position.halfmoveClock).toBe(0);
    expect(undoMove(result)).toBe(position);
    expect(Object.isFrozen(result.position)).toBe(true);
    expect(Object.isFrozen(result.position.rows)).toBe(true);
  });

  test("validates serialized positions", () => {
    expectCode(
      () => createPosition({ rows: ["........"] }),
      "INVALID_POSITION",
    );
    expectCode(
      () => createPosition({ rows: rows({ a8: "bK", h1: "wK" }), halfmoveClock: -1 }),
      "INVALID_POSITION",
    );
    expectCode(
      () =>
        createPosition({
          rows: rows({ a8: "bK", h1: "wK" }),
          turn: "white",
          enPassant: "e3",
        }),
      "INVALID_POSITION",
    );
  });
});
