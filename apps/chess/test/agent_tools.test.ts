import { expect, test } from "bun:test";
import {
  listExposedTools,
  validateToolArguments,
  validateToolResult,
  type JsonObject,
  type JsonValue,
  type MsgBusToolCall,
  type MsgBusToolContext,
  type ScopedKernelClient,
  type SelfCallValue,
} from "neutron-tools/app";
import {
  CHESS_AGENT_TOOL_NAMES,
  chessAgentPosition,
  createChessAgentToolHandlers,
  exposeChessAgentTools,
  type ChessAgentToolError,
} from "../src/agent_tools.ts";
import type {
  ChessGame,
  ChessLegalMove,
  ChessMove,
} from "../src/chess_api.ts";

const GAME_ID = "00112233445566778899aabbccddeeff";
const OTHER_GAME_ID = "ffeeddccbbaa99887766554433221100";

function initialGame(overrides: Partial<ChessGame> = {}): ChessGame {
  return {
    tileId: "tile-a",
    gameId: GAME_ID,
    mode: "local",
    computerLevel: null,
    revision: 0,
    rows: [
      "rnbqkbnr",
      "pppppppp",
      "........",
      "........",
      "........",
      "........",
      "PPPPPPPP",
      "RNBQKBNR",
    ],
    turn: "white",
    castling: {
      whiteKingSide: true,
      whiteQueenSide: true,
      blackKingSide: true,
      blackQueenSide: true,
    },
    enPassant: null,
    halfmoveClock: 0,
    fullmoveNumber: 1,
    status: "active",
    winner: null,
    inCheck: false,
    drawOfferBy: null,
    localColor: null,
    remoteConnected: false,
    positionKeys: ["initial"],
    legalMoves: [
      { from: "e2", to: "e3", promotion: null },
      { from: "e2", to: "e4", promotion: null },
      { from: "g1", to: "f3", promotion: null },
    ],
    history: [],
    ...overrides,
  };
}

function move(
  ply: number,
  from: string,
  to: string,
  notation: string,
  piece: ChessMove["piece"],
  promotion: ChessMove["promotion"] = null,
): ChessMove {
  return {
    ply,
    from,
    to,
    promotion,
    piece,
    placed: promotion
      ? (`${piece[0]}${promotion.toUpperCase()}` as ChessMove["placed"])
      : piece,
    captured: null,
    special: promotion ? "promotion" : "normal",
    notation,
    at: String(ply),
  };
}

const e4 = move(1, "e2", "e4", "e4", "wP");
const e5 = move(2, "e7", "e5", "e5", "bP");

function afterE4(): ChessGame {
  return initialGame({
    revision: 1,
    rows: [
      "rnbqkbnr",
      "pppppppp",
      "........",
      "........",
      "....P...",
      "........",
      "PPPP.PPP",
      "RNBQKBNR",
    ],
    turn: "black",
    enPassant: "e3",
    legalMoves: [
      { from: "e7", to: "e5", promotion: null },
      { from: "g8", to: "f6", promotion: null },
    ],
    history: [e4],
    positionKeys: ["initial", "after-e4"],
  });
}

function afterE5(): ChessGame {
  return initialGame({
    revision: 2,
    rows: [
      "rnbqkbnr",
      "pppp.ppp",
      "........",
      "....p...",
      "....P...",
      "........",
      "PPPP.PPP",
      "RNBQKBNR",
    ],
    turn: "white",
    enPassant: "e6",
    fullmoveNumber: 2,
    legalMoves: [
      { from: "g1", to: "f3", promotion: null },
      { from: "f1", to: "c4", promotion: null },
    ],
    history: [e4, e5],
    positionKeys: ["initial", "after-e4", "after-e5"],
  });
}

function wireGame(game: ChessGame): JsonValue {
  return {
    tile_id: game.tileId,
    game_id: game.gameId,
    mode: game.mode,
    computer_level: game.computerLevel,
    revision: String(game.revision),
    rows: game.rows,
    turn: game.turn,
    castling: {
      white_kingside: game.castling.whiteKingSide,
      white_queenside: game.castling.whiteQueenSide,
      black_kingside: game.castling.blackKingSide,
      black_queenside: game.castling.blackQueenSide,
    },
    en_passant: game.enPassant,
    halfmove_clock: String(game.halfmoveClock),
    fullmove_number: String(game.fullmoveNumber),
    status: game.status,
    winner: game.winner,
    in_check: game.inCheck,
    draw_offer_by: game.drawOfferBy,
    local_color: game.localColor,
    remote_connected: game.remoteConnected,
    position_keys: game.positionKeys,
    legal_moves: game.legalMoves.map(wireMove),
    history: game.history.map((entry) => ({
      ...wireMove(entry),
      ply: String(entry.ply),
      piece: entry.piece,
      placed: entry.placed,
      captured: entry.captured,
      special: entry.special,
      notation: entry.notation,
      at: entry.at,
    })),
  };
}

function wireMove(move: ChessLegalMove): JsonObject {
  return {
    from: move.from,
    to: move.to,
    promotion: move.promotion,
  };
}

function fakeContext({
  games,
  update,
  endpoints,
  selfCalls,
}: {
  games: Record<string, ChessGame | null>;
  update?: (call: MsgBusToolCall) => JsonValue | Promise<JsonValue>;
  endpoints?: JsonValue[];
  selfCalls?: Partial<
    Pick<ScopedKernelClient, "querySelf" | "updateSelf">
  >;
}) {
  const calls: MsgBusToolCall[] = [];
  const endpointList =
    endpoints ??
    Object.keys(games).map((instanceId, workspace) => ({
      endpoint: `app:chess:tile:board:instance:${instanceId}`,
      appId: "chess",
      role: "tile",
      tileId: "board",
      instanceId,
      workspace,
      connected: true,
    }));
  const kernel: ScopedKernelClient = {
    async listApps() {
      return { apps: [] };
    },
    async describeApp() {
      return {};
    },
    async listEndpoints() {
      return { endpoints: endpointList };
    },
    async listTools() {
      return [];
    },
    async callTool<T extends JsonValue = JsonValue>(_call: MsgBusToolCall) {
      throw new Error("Unexpected generic tool call");
    },
    async querySelf<T extends SelfCallValue = JsonValue>(
      method: string,
      args: SelfCallValue[] = [],
    ): Promise<T> {
      const call: MsgBusToolCall = {
        target: "kernel",
        name: "canister.query_self",
        arguments: { method, args: args as JsonValue[] },
      };
      calls.push(call);
      const request = call.arguments as {
        args: Array<{ tile_id: string }>;
      };
      const game = games[String(request.args[0]?.tile_id)] ?? null;
      return (game ? wireGame(game) : null) as T;
    },
    async updateSelf<T extends SelfCallValue = JsonValue>(
      method: string,
      args: SelfCallValue[] = [],
    ): Promise<T> {
      const call: MsgBusToolCall = {
        target: "kernel",
        name: "canister.update_self",
        arguments: { method, args: args as JsonValue[] },
      };
      calls.push(call);
      if (!update) throw new Error("Unexpected scoped self-call");
      return (await update(call)) as T;
    },
    ...(selfCalls ?? {}),
  };
  const context: MsgBusToolContext = {
    kernel,
    reportProgress() {},
  };
  return { calls, context };
}

function toolFailure(error: unknown): ChessAgentToolError {
  return error as ChessAgentToolError;
}

test("Chess registers compact read/write tools with closed model-facing schemas", () => {
  const dispose = exposeChessAgentTools({ publishChange: async () => undefined });
  try {
    const descriptors = listExposedTools().filter((descriptor) =>
      Object.values(CHESS_AGENT_TOOL_NAMES).includes(
        descriptor.name as (typeof CHESS_AGENT_TOOL_NAMES)[keyof typeof CHESS_AGENT_TOOL_NAMES],
      ),
    );
    expect(descriptors.map((descriptor) => descriptor.name).sort()).toEqual(
      Object.values(CHESS_AGENT_TOOL_NAMES).sort(),
    );
    const position = descriptors.find(
      (descriptor) => descriptor.name === CHESS_AGENT_TOOL_NAMES.position,
    )!;
    const play = descriptors.find(
      (descriptor) => descriptor.name === CHESS_AGENT_TOOL_NAMES.move,
    )!;
    expect(position.annotations).toEqual({ "neutron:effects": ["read"] });
    expect(play.annotations).toEqual({ "neutron:effects": ["write"] });
    expect(play.inputSchema).toMatchObject({
      required: ["tileInstanceId", "gameId", "revision", "from", "to"],
      additionalProperties: false,
    });
    expect(JSON.stringify(play.inputSchema)).not.toContain("tile_id");
    validateToolArguments(play, {
      tileInstanceId: "tile-a",
      gameId: GAME_ID,
      revision: "1",
      from: "e7",
      to: "e5",
    });
    expect(() =>
      validateToolArguments(play, {
        tileInstanceId: "tile-a",
        gameId: GAME_ID,
        revision: "1",
        from: "e7",
        to: "e5",
        tile_id: "attacker-chosen",
      }),
    ).toThrow();
  } finally {
    dispose();
  }
  expect(
    listExposedTools().some((descriptor) =>
      Object.values(CHESS_AGENT_TOOL_NAMES).includes(
        descriptor.name as (typeof CHESS_AGENT_TOOL_NAMES)[keyof typeof CHESS_AGENT_TOOL_NAMES],
      ),
    ),
  ).toBe(false);
});

test("Chess lists only live local games and keeps tile instances distinct", async () => {
  const computer = initialGame({
    tileId: "tile-b",
    gameId: OTHER_GAME_ID,
    mode: "computer",
    computerLevel: "medium",
    localColor: "white",
  });
  const { context, calls } = fakeContext({
    games: { "tile-a": afterE4(), "tile-b": computer },
    endpoints: [
      {
        endpoint: "app:chess:tile:board:instance:tile-b",
        appId: "chess",
        role: "tile",
        tileId: "board",
        instanceId: "tile-b",
        workspace: 2,
        connected: true,
      },
      {
        endpoint: "app:chess:tile:board:instance:tile-a",
        appId: "chess",
        role: "tile",
        tileId: "board",
        instanceId: "tile-a",
        workspace: 1,
        connected: true,
      },
      {
        endpoint: "app:chess:tile:board:instance:closed",
        appId: "chess",
        role: "tile",
        tileId: "board",
        instanceId: "closed",
        workspace: 0,
        connected: false,
      },
    ],
  });
  const handlers = createChessAgentToolHandlers();
  const result = await handlers.games({}, context);
  expect(result).toEqual({
    games: [
      {
        tileInstanceId: "tile-a",
        workspace: 1,
        gameId: GAME_ID,
        revision: "1",
        status: "active",
        turn: "black",
        inCheck: false,
        moveCount: 1,
        lastMove: "e4 (e2e4)",
      },
    ],
    liveTileCount: 2,
    inspectedTileCount: 2,
    truncated: false,
  });
  expect(calls.map((call) => call.arguments)).toEqual([
    { method: "chess_get_game", args: [{ tile_id: "tile-a" }] },
    { method: "chess_get_game", args: [{ tile_id: "tile-b" }] },
  ]);
});

test("Chess position gives an agent FEN, diagram, complete SAN/UCI history, and legal moves", async () => {
  const game = afterE5();
  const { context } = fakeContext({ games: { "tile-a": game } });
  const handlers = createChessAgentToolHandlers();
  const result = await handlers.position(
    { tileInstanceId: "tile-a", gameId: GAME_ID },
    context,
  );
  expect(result).toMatchObject({
    tileInstanceId: "tile-a",
    gameId: GAME_ID,
    revision: "2",
    mode: "local",
    turn: "white",
    board: {
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2",
      rows: game.rows,
      castlingRights: "KQkq",
      enPassant: "e6",
    },
    history: {
      pgn: "1. e4 e5 *",
      moves: [
        { ply: 1, side: "white", san: "e4", uci: "e2e4" },
        { ply: 2, side: "black", san: "e5", uci: "e7e5" },
      ],
    },
    lastMove: { ply: 2, side: "black", san: "e5", uci: "e7e5" },
    legalMoves: ["f1c4", "g1f3"],
  });
  expect((result as { board: { diagram: string } }).board.diagram).toContain(
    "8 | r n b q k b n r",
  );
  expect((result as { board: { diagram: string } }).board.diagram).toContain(
    "    a b c d e f g h",
  );

  const dispose = exposeChessAgentTools({ publishChange: async () => undefined });
  try {
    const descriptor = listExposedTools().find(
      (candidate) => candidate.name === CHESS_AGENT_TOOL_NAMES.position,
    )!;
    validateToolResult(descriptor, result);
  } finally {
    dispose();
  }
});

test("Chess move uses the scoped authoritative update and returns the updated position", async () => {
  let notifications = 0;
  const { context, calls } = fakeContext({
    games: { "tile-a": afterE4() },
    update: () => wireGame(afterE5()),
  });
  const handlers = createChessAgentToolHandlers({
    publishChange: async () => {
      notifications += 1;
    },
  });
  const result = await handlers.move(
    {
      tileInstanceId: "tile-a",
      gameId: GAME_ID,
      revision: "1",
      from: "e7",
      to: "e5",
    },
    context,
  );
  expect(result).toMatchObject({ revision: "2", turn: "white" });
  expect(notifications).toBe(1);
  expect(calls.at(-1)).toEqual({
    target: "kernel",
    name: "canister.update_self",
    arguments: {
      method: "chess_move",
      args: [
        {
          tile_id: "tile-a",
          expected_game_id: GAME_ID,
          local_only: true,
          from: "e7",
          to: "e5",
          expected_revision: "1",
        },
      ],
    },
  });
});

test("Chess rejects illegal, stale, replaced, non-local, and terminal games before mutation", async () => {
  const cases: Array<{
    game: ChessGame;
    args: Record<string, JsonValue>;
    code: string;
  }> = [
    {
      game: initialGame(),
      args: {
        tileInstanceId: "tile-a",
        gameId: GAME_ID,
        revision: "0",
        from: "e2",
        to: "e5",
      },
      code: "illegal_move",
    },
    {
      game: initialGame(),
      args: {
        tileInstanceId: "tile-a",
        gameId: GAME_ID,
        revision: "1",
        from: "e2",
        to: "e4",
      },
      code: "conflict",
    },
    {
      game: initialGame(),
      args: {
        tileInstanceId: "tile-a",
        gameId: OTHER_GAME_ID,
        revision: "0",
        from: "e2",
        to: "e4",
      },
      code: "game_changed",
    },
    {
      game: initialGame({
        mode: "computer",
        computerLevel: "medium",
        localColor: "white",
      }),
      args: {
        tileInstanceId: "tile-a",
        gameId: GAME_ID,
        revision: "0",
        from: "e2",
        to: "e4",
      },
      code: "local_mode_required",
    },
    {
      game: initialGame({ status: "stalemate", legalMoves: [] }),
      args: {
        tileInstanceId: "tile-a",
        gameId: GAME_ID,
        revision: "0",
        from: "e2",
        to: "e4",
      },
      code: "game_over",
    },
  ];

  for (const entry of cases) {
    let updates = 0;
    const { context } = fakeContext({
      games: { "tile-a": entry.game },
      update: () => {
        updates += 1;
        return wireGame(entry.game);
      },
    });
    const handlers = createChessAgentToolHandlers();
    try {
      await handlers.move(entry.args, context);
      throw new Error("Expected Chess move rejection");
    } catch (error) {
      expect(toolFailure(error).code).toBe(entry.code);
    }
    expect(updates).toBe(0);
  }
});

test("Chess requires and forwards an advertised promotion", async () => {
  const promotionMoves: ChessLegalMove[] = (["q", "r", "b", "n"] as const).map(
    (promotion) => ({ from: "e7", to: "e8", promotion }),
  );
  const promoted = initialGame({
    revision: 12,
    rows: [
      "....k...",
      "....P...",
      "........",
      "........",
      "........",
      "........",
      "........",
      "....K...",
    ],
    legalMoves: promotionMoves,
  });
  const next = initialGame({
    ...promoted,
    revision: 13,
    rows: [
      "....Q...",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "....K...",
    ],
    turn: "black",
    legalMoves: [],
    history: [move(23, "e7", "e8", "e8=Q+", "wP", "q")],
  });
  const { context, calls } = fakeContext({
    games: { "tile-a": promoted },
    update: () => wireGame(next),
  });
  const handlers = createChessAgentToolHandlers({
    publishChange: async () => undefined,
  });
  try {
    await handlers.move(
      {
        tileInstanceId: "tile-a",
        gameId: GAME_ID,
        revision: "12",
        from: "e7",
        to: "e8",
      },
      context,
    );
    throw new Error("Expected promotion requirement");
  } catch (error) {
    expect(toolFailure(error).code).toBe("promotion_required");
  }
  const result = await handlers.move(
    {
      tileInstanceId: "tile-a",
      gameId: GAME_ID,
      revision: "12",
      from: "e7",
      to: "e8",
      promotion: "q",
    },
    context,
  );
  expect(result).toMatchObject({ revision: "13", turn: "black" });
  expect(calls.at(-1)?.arguments).toMatchObject({
    args: [{ promotion: "q" }],
  });
});

test("Chess maps backend rule rejection to an invalid-move tool error", async () => {
  const backendError = Object.assign(new Error("The move leaves the king in check"), {
    code: "validation",
  });
  const { context } = fakeContext({
    games: { "tile-a": afterE4() },
    update: () => {
      throw backendError;
    },
  });
  const handlers = createChessAgentToolHandlers();
  try {
    await handlers.move(
      {
        tileInstanceId: "tile-a",
        gameId: GAME_ID,
        revision: "1",
        from: "e7",
        to: "e5",
      },
      context,
    );
    throw new Error("Expected backend move rejection");
  } catch (error) {
    expect(toolFailure(error)).toMatchObject({
      code: "illegal_move",
      message: "The move leaves the king in check",
    });
  }
});

test("Chess preserves atomic backend game and local-mode guard failures", async () => {
  for (const [code, message] of [
    ["game_changed", "The selected Chess tile started a different game"],
    ["local_mode_required", "Chess agent moves require a Local players game"],
  ] as const) {
    let notifications = 0;
    const { context } = fakeContext({
      games: { "tile-a": afterE4() },
      update: () => {
        throw Object.assign(new Error(message), { code });
      },
    });
    const handlers = createChessAgentToolHandlers({
      publishChange: async () => {
        notifications += 1;
      },
    });
    try {
      await handlers.move(
        {
          tileInstanceId: "tile-a",
          gameId: GAME_ID,
          revision: "1",
          from: "e7",
          to: "e5",
        },
        context,
      );
      throw new Error("Expected backend binding rejection");
    } catch (error) {
      expect(toolFailure(error)).toMatchObject({ code, message });
    }
    expect(notifications).toBe(0);
  }
});

test("Chess serializes tool moves at one tile revision", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { context } = fakeContext({
    games: { "tile-a": afterE4() },
    update: async () => {
      await blocked;
      return wireGame(afterE5());
    },
  });
  const handlers = createChessAgentToolHandlers({
    publishChange: async () => undefined,
  });
  const args = {
    tileInstanceId: "tile-a",
    gameId: GAME_ID,
    revision: "1",
    from: "e7",
    to: "e5",
  };
  const first = handlers.move(args, context);
  await Promise.resolve();
  try {
    await handlers.move(args, context);
    throw new Error("Expected concurrent move rejection");
  } catch (error) {
    expect(toolFailure(error).code).toBe("busy");
  }
  release();
  await expect(first).resolves.toMatchObject({ revision: "2" });
});

test("complete retained Chess history remains below OpenRouter's result bound", () => {
  const history = Array.from({ length: 1024 }, (_, index) =>
    move(
      index + 1,
      index % 2 === 0 ? "g1" : "g8",
      index % 2 === 0 ? "f3" : "f6",
      index % 2 === 0 ? "Nf3" : "Nf6",
      index % 2 === 0 ? "wN" : "bN",
    ),
  );
  const game = initialGame({ revision: 1024, history });
  const result = chessAgentPosition(game, {
    instanceId: "tile-a",
    workspace: 0,
  });
  expect((result.history as { moves: unknown[] }).moves).toHaveLength(1024);
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(
    128 * 1024,
  );
});
