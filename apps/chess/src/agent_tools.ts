import {
  exposeTool,
  isJsonObject,
  publishAppStateChange,
  removeExposedTool,
  toError,
  type ExposedToolOptions,
  type JsonObject,
  type JsonValue,
  type MsgBusToolContext,
  type MsgBusToolHandler,
} from "neutron-tools/app";
import {
  parseGame,
  parseOptionalGame,
  type ChessGame,
  type ChessLegalMove,
  type ChessMove,
  type PromotionPiece,
} from "./chess_api.ts";

export const CHESS_STATE_TOPIC = "games";
export const CHESS_AGENT_TOOL_NAMES = {
  games: "chess_local_games",
  position: "chess_position",
  move: "chess_move",
} as const;

const MAX_INSPECTED_TILES = 16;
const QUERY_TIMEOUT_SECONDS = 30;
const MOVE_TIMEOUT_SECONDS = 60;
const REVISION_PATTERN = "^[0-9]{1,8}$";
const GAME_ID_PATTERN = "^[A-Za-z0-9_-]{24,128}$";
const SQUARE_PATTERN = "^[a-h][1-8]$";

type LiveChessTile = {
  instanceId: string;
  workspace: number;
};

type ChessAgentToolOptions = {
  publishChange?: () => Promise<void>;
};

export class ChessAgentToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChessAgentToolError";
    this.code = code;
  }
}

const LAST_MOVE_SCHEMA: JsonObject = {
  type: ["object", "null"],
  required: ["ply", "side", "san", "uci"],
  properties: {
    ply: { type: "integer", minimum: 1 },
    side: { type: "string", enum: ["white", "black"] },
    san: { type: "string" },
    uci: { type: "string", pattern: "^[a-h][1-8][a-h][1-8][qrbn]?$" },
  },
  additionalProperties: false,
};

const POSITION_SCHEMA: JsonObject = {
  type: "object",
  required: [
    "tileInstanceId",
    "workspace",
    "gameId",
    "revision",
    "mode",
    "status",
    "turn",
    "inCheck",
    "winner",
    "result",
    "board",
    "history",
    "lastMove",
    "legalMoves",
  ],
  properties: {
    tileInstanceId: {
      type: "string",
      description: "Kernel-bound instance id of the exact live Chess tile.",
    },
    workspace: { type: "integer", minimum: 0 },
    gameId: { type: "string", pattern: GAME_ID_PATTERN },
    revision: {
      type: "string",
      pattern: REVISION_PATTERN,
      description: "Echo this exact decimal revision when making a move.",
    },
    mode: { type: "string", enum: ["local"] },
    status: { type: "string" },
    turn: {
      type: "string",
      enum: ["white", "black"],
      description: "The side whose move must be played next.",
    },
    inCheck: { type: "boolean" },
    winner: { type: ["string", "null"], enum: ["white", "black", null] },
    result: { type: "string", enum: ["*", "1-0", "0-1", "1/2-1/2"] },
    board: {
      type: "object",
      required: [
        "fen",
        "diagram",
        "rows",
        "castlingRights",
        "enPassant",
        "halfmoveClock",
        "fullmoveNumber",
      ],
      properties: {
        fen: {
          type: "string",
          description: "Standard FEN for the exact current position.",
        },
        diagram: {
          type: "string",
          description:
            "Board from rank 8 to rank 1. Uppercase pieces are White; lowercase pieces are Black.",
        },
        rows: {
          type: "array",
          minItems: 8,
          maxItems: 8,
          items: { type: "string", pattern: "^[rnbqkpRNBQKP.]{8}$" },
          description:
            "Eight board rows from rank 8 through rank 1; dots are empty squares.",
        },
        castlingRights: { type: "string" },
        enPassant: { type: ["string", "null"] },
        halfmoveClock: { type: "integer", minimum: 0 },
        fullmoveNumber: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    history: {
      type: "object",
      required: ["pgn", "moves"],
      properties: {
        pgn: {
          type: "string",
          description: "Complete SAN movetext ending in the current PGN result token.",
        },
        moves: {
          type: "array",
          maxItems: 1024,
          items: LAST_MOVE_SCHEMA,
          description: "Complete retained move history in both SAN and UCI notation.",
        },
      },
      additionalProperties: false,
    },
    lastMove: LAST_MOVE_SCHEMA,
    legalMoves: {
      type: "array",
      maxItems: 256,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-h][1-8][a-h][1-8][qrbn]?$" },
      description:
        "Exact legal moves for turn in UCI notation. Promotion moves end in q, r, b, or n.",
    },
  },
  additionalProperties: false,
};

const GAME_SELECTOR_PROPERTIES = {
  tileInstanceId: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    description: "Exact live tile instance returned by chess_local_games.",
  },
  gameId: {
    type: "string",
    pattern: GAME_ID_PATTERN,
    description: "Exact game id returned by chess_local_games.",
  },
} satisfies JsonObject;

const GAME_SELECTOR_SCHEMA: JsonObject = {
  type: "object",
  required: ["tileInstanceId", "gameId"],
  properties: GAME_SELECTOR_PROPERTIES,
  additionalProperties: false,
};

export const CHESS_AGENT_TOOL_DESCRIPTORS: Record<
  keyof typeof CHESS_AGENT_TOOL_NAMES,
  ExposedToolOptions
> = {
  games: {
    title: "List Local Chess Games",
    description:
      "List live Chess tiles that are running Local players games. Use the exact tile and game ids to inspect one position.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      required: ["games", "liveTileCount", "inspectedTileCount", "truncated"],
      properties: {
        games: {
          type: "array",
          maxItems: MAX_INSPECTED_TILES,
          items: {
            type: "object",
            required: [
              "tileInstanceId",
              "workspace",
              "gameId",
              "revision",
              "status",
              "turn",
              "inCheck",
              "moveCount",
              "lastMove",
            ],
            properties: {
              tileInstanceId: { type: "string" },
              workspace: { type: "integer", minimum: 0 },
              gameId: { type: "string", pattern: GAME_ID_PATTERN },
              revision: { type: "string", pattern: REVISION_PATTERN },
              status: { type: "string" },
              turn: { type: "string", enum: ["white", "black"] },
              inCheck: { type: "boolean" },
              moveCount: { type: "integer", minimum: 0, maximum: 1024 },
              lastMove: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
        },
        liveTileCount: { type: "integer", minimum: 0 },
        inspectedTileCount: { type: "integer", minimum: 0 },
        truncated: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: { "neutron:effects": ["read"] },
  },
  position: {
    title: "Inspect Local Chess Position",
    description:
      "Return the current board, complete SAN/UCI move history, and exact legal moves for one live Local players game.",
    inputSchema: GAME_SELECTOR_SCHEMA,
    outputSchema: POSITION_SCHEMA,
    annotations: { "neutron:effects": ["read"] },
  },
  move: {
    title: "Play Local Chess Move",
    description:
      "Play one move for the side to move in a live Local players game. Inspect chess_position immediately first and echo its gameId and revision. Illegal or stale moves fail without mutation.",
    inputSchema: {
      type: "object",
      required: ["tileInstanceId", "gameId", "revision", "from", "to"],
      properties: {
        ...GAME_SELECTOR_PROPERTIES,
        revision: {
          type: "string",
          pattern: REVISION_PATTERN,
          description: "Exact revision returned by the latest chess_position call.",
        },
        from: {
          type: "string",
          pattern: SQUARE_PATTERN,
          description: "Source square in algebraic coordinates, for example e2.",
        },
        to: {
          type: "string",
          pattern: SQUARE_PATTERN,
          description: "Destination square in algebraic coordinates, for example e4.",
        },
        promotion: {
          type: "string",
          enum: ["q", "r", "b", "n"],
          description: "Required only for promotion: q, r, b, or n.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: POSITION_SCHEMA,
    annotations: { "neutron:effects": ["write"] },
  },
};

export function createChessAgentToolHandlers(
  options: ChessAgentToolOptions = {},
): {
  games: MsgBusToolHandler;
  position: MsgBusToolHandler;
  move: MsgBusToolHandler;
} {
  const publishChange = options.publishChange ?? publishChessStateChange;
  let moveInFlight = false;

  return {
    games: async (_args, context) => {
      const liveTiles = await listLiveChessTiles(context);
      const inspected = liveTiles.slice(0, MAX_INSPECTED_TILES);
      const games: JsonValue[] = [];
      for (const tile of inspected) {
        const game = await readGame(context, tile.instanceId);
        if (!game || game.mode !== "local") continue;
        games.push(gameSummary(game, tile));
      }
      return {
        games,
        liveTileCount: liveTiles.length,
        inspectedTileCount: inspected.length,
        truncated: liveTiles.length > inspected.length,
      };
    },
    position: async (args, context) => {
      const tileInstanceId = requiredText(
        args,
        "tileInstanceId",
        /^.{1,128}$/u,
      );
      const gameId = requiredText(args, "gameId", /^[A-Za-z0-9_-]{24,128}$/u);
      const { game, tile } = await resolveLocalGame(
        context,
        tileInstanceId,
        gameId,
      );
      return chessAgentPosition(game, tile);
    },
    move: async (args, context) => {
      if (moveInFlight) {
        throw toolError("busy", "Another Chess tool move is still in progress");
      }
      moveInFlight = true;
      try {
        const tileInstanceId = requiredText(
          args,
          "tileInstanceId",
          /^.{1,128}$/u,
        );
        const gameId = requiredText(
          args,
          "gameId",
          /^[A-Za-z0-9_-]{24,128}$/u,
        );
        const revision = requiredText(args, "revision", /^(0|[1-9][0-9]{0,7})$/u);
        const from = requiredText(args, "from", /^[a-h][1-8]$/u);
        const to = requiredText(args, "to", /^[a-h][1-8]$/u);
        const promotion = optionalPromotion(args.promotion);
        const { game, tile } = await resolveLocalGame(
          context,
          tileInstanceId,
          gameId,
        );

        if (String(game.revision) !== revision) {
          throw toolError(
            "conflict",
            `Chess position changed from revision ${revision} to ${game.revision}. Inspect chess_position again.`,
          );
        }
        if (game.status !== "active") {
          throw toolError(
            "game_over",
            `This Chess game is ${game.status} and cannot accept another move`,
          );
        }
        assertAdvertisedMove(game, { from, to, promotion });

        let raw: JsonValue;
        try {
          raw = await context.kernel.updateSelf<JsonValue>(
            "chess_move",
            [
              {
                tile_id: tileInstanceId,
                expected_game_id: gameId,
                local_only: true,
                from,
                to,
                ...(promotion ? { promotion } : {}),
                expected_revision: revision,
              },
            ],
            MOVE_TIMEOUT_SECONDS,
          );
        } catch (error) {
          throw translateBackendMoveError(error);
        }

        const next = parseGame(raw);
        if (
          next.tileId !== tileInstanceId ||
          next.gameId !== gameId ||
          next.mode !== "local"
        ) {
          throw toolError(
            "invalid_response",
            "Chess returned a game that does not match the selected local tile",
          );
        }
        try {
          await publishChange();
        } catch (error) {
          console.warn("[Chess] move committed but tile notification failed", error);
        }
        return chessAgentPosition(next, tile);
      } finally {
        moveInFlight = false;
      }
    },
  };
}

export function exposeChessAgentTools(
  options: ChessAgentToolOptions = {},
): () => void {
  const handlers = createChessAgentToolHandlers(options);
  exposeTool(
    CHESS_AGENT_TOOL_NAMES.games,
    CHESS_AGENT_TOOL_DESCRIPTORS.games,
    handlers.games,
  );
  exposeTool(
    CHESS_AGENT_TOOL_NAMES.position,
    CHESS_AGENT_TOOL_DESCRIPTORS.position,
    handlers.position,
  );
  exposeTool(
    CHESS_AGENT_TOOL_NAMES.move,
    CHESS_AGENT_TOOL_DESCRIPTORS.move,
    handlers.move,
  );
  return () => {
    removeExposedTool(CHESS_AGENT_TOOL_NAMES.games);
    removeExposedTool(CHESS_AGENT_TOOL_NAMES.position);
    removeExposedTool(CHESS_AGENT_TOOL_NAMES.move);
  };
}

export function chessAgentPosition(
  game: ChessGame,
  tile: LiveChessTile,
): JsonObject {
  const moves = game.history.map(agentHistoryMove);
  const lastMove = moves.at(-1) ?? null;
  const result = gameResult(game);
  return {
    tileInstanceId: tile.instanceId,
    workspace: tile.workspace,
    gameId: game.gameId,
    revision: String(game.revision),
    mode: "local",
    status: game.status,
    turn: game.turn,
    inCheck: game.inCheck,
    winner: game.winner,
    result,
    board: {
      fen: fen(game),
      diagram: boardDiagram(game.rows),
      rows: game.rows,
      castlingRights: castlingRights(game),
      enPassant: game.enPassant,
      halfmoveClock: game.halfmoveClock,
      fullmoveNumber: game.fullmoveNumber,
    },
    history: {
      pgn: pgn(game, result),
      moves,
    },
    lastMove,
    legalMoves: game.legalMoves.map(moveToUci).sort(),
  };
}

async function listLiveChessTiles(
  context: MsgBusToolContext,
): Promise<LiveChessTile[]> {
  const value = await context.kernel.listEndpoints(QUERY_TIMEOUT_SECONDS);
  if (!isJsonObject(value) || !Array.isArray(value.endpoints)) {
    throw toolError("invalid_response", "Kernel returned an invalid endpoint list");
  }
  const tiles = new Map<string, LiveChessTile>();
  for (const candidate of value.endpoints) {
    if (
      !isJsonObject(candidate) ||
      candidate.appId !== "chess" ||
      candidate.role !== "tile" ||
      candidate.tileId !== "board" ||
      candidate.connected !== true ||
      typeof candidate.instanceId !== "string" ||
      candidate.instanceId.length < 1 ||
      candidate.instanceId.length > 128 ||
      typeof candidate.workspace !== "number" ||
      !Number.isSafeInteger(candidate.workspace) ||
      candidate.workspace < 0
    ) {
      continue;
    }
    tiles.set(candidate.instanceId, {
      instanceId: candidate.instanceId,
      workspace: candidate.workspace,
    });
  }
  return [...tiles.values()].sort(
    (left, right) =>
      left.workspace - right.workspace ||
      left.instanceId.localeCompare(right.instanceId),
  );
}

async function resolveLocalGame(
  context: MsgBusToolContext,
  tileInstanceId: string,
  gameId: string,
): Promise<{ game: ChessGame; tile: LiveChessTile }> {
  const tile = (await listLiveChessTiles(context)).find(
    (candidate) => candidate.instanceId === tileInstanceId,
  );
  if (!tile) {
    throw toolError(
      "tile_not_live",
      "The selected Chess tile is no longer live. List local games again.",
    );
  }
  const game = await readGame(context, tileInstanceId);
  if (!game) {
    throw toolError("no_game", "The selected Chess tile has no active game");
  }
  if (game.gameId !== gameId) {
    throw toolError(
      "game_changed",
      "The selected Chess tile started a different game. List local games again.",
    );
  }
  if (game.mode !== "local") {
    throw toolError(
      "local_mode_required",
      `Chess agent play is available only in Local players mode; this game is ${game.mode}`,
    );
  }
  return { game, tile };
}

async function readGame(
  context: MsgBusToolContext,
  tileInstanceId: string,
): Promise<ChessGame | null> {
  const raw = await context.kernel.querySelf<JsonValue>(
    "chess_get_game",
    [{ tile_id: tileInstanceId }],
    QUERY_TIMEOUT_SECONDS,
  );
  const game = parseOptionalGame(raw);
  if (game && game.tileId !== tileInstanceId) {
    throw toolError(
      "invalid_response",
      "Chess returned a game belonging to another tile",
    );
  }
  return game;
}

function gameSummary(game: ChessGame, tile: LiveChessTile): JsonObject {
  const lastMove = game.history.at(-1);
  return {
    tileInstanceId: tile.instanceId,
    workspace: tile.workspace,
    gameId: game.gameId,
    revision: String(game.revision),
    status: game.status,
    turn: game.turn,
    inCheck: game.inCheck,
    moveCount: game.history.length,
    lastMove: lastMove ? `${lastMove.notation} (${moveToUci(lastMove)})` : null,
  };
}

function assertAdvertisedMove(
  game: ChessGame,
  attempted: ChessLegalMove,
): void {
  const sameSquares = game.legalMoves.filter(
    (move) => move.from === attempted.from && move.to === attempted.to,
  );
  if (sameSquares.length === 0) {
    throw toolError(
      "illegal_move",
      `Move ${moveToUci(attempted)} is not legal at revision ${game.revision}`,
    );
  }
  const promotions = sameSquares
    .map((move) => move.promotion)
    .filter((promotion): promotion is PromotionPiece => promotion !== null);
  if (promotions.length > 0 && attempted.promotion === null) {
    throw toolError(
      "promotion_required",
      `Move ${attempted.from}${attempted.to} requires promotion to ${promotions.join(
        ", ",
      )}`,
    );
  }
  if (
    !sameSquares.some((move) => move.promotion === attempted.promotion)
  ) {
    throw toolError(
      "illegal_move",
      `Move ${moveToUci(attempted)} is not legal at revision ${game.revision}`,
    );
  }
}

function agentHistoryMove(move: ChessMove): JsonObject {
  return {
    ply: move.ply,
    side: move.piece.startsWith("w") ? "white" : "black",
    san: move.notation,
    uci: moveToUci(move),
  };
}

function moveToUci(move: ChessLegalMove): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

function castlingRights(game: ChessGame): string {
  const rights = [
    game.castling.whiteKingSide ? "K" : "",
    game.castling.whiteQueenSide ? "Q" : "",
    game.castling.blackKingSide ? "k" : "",
    game.castling.blackQueenSide ? "q" : "",
  ].join("");
  return rights || "-";
}

function fen(game: ChessGame): string {
  const placement = game.rows
    .map((row) => row.replace(/\.+/gu, (empty) => String(empty.length)))
    .join("/");
  return [
    placement,
    game.turn === "white" ? "w" : "b",
    castlingRights(game),
    game.enPassant ?? "-",
    String(game.halfmoveClock),
    String(game.fullmoveNumber),
  ].join(" ");
}

function boardDiagram(rows: string[]): string {
  const ranks = rows.map(
    (row, index) => `${8 - index} | ${[...row].join(" ")}`,
  );
  return [...ranks, "    a b c d e f g h"].join("\n");
}

function gameResult(game: ChessGame): "*" | "1-0" | "0-1" | "1/2-1/2" {
  if (game.status === "active" || game.status === "waiting") return "*";
  if (game.winner === "white") return "1-0";
  if (game.winner === "black") return "0-1";
  return "1/2-1/2";
}

function pgn(
  game: ChessGame,
  result: "*" | "1-0" | "0-1" | "1/2-1/2",
): string {
  const tokens: string[] = [];
  let previousPly: number | null = null;
  for (const move of game.history) {
    const moveNumber = Math.ceil(move.ply / 2);
    if (move.ply % 2 === 1) {
      tokens.push(`${moveNumber}.`, move.notation);
    } else {
      if (previousPly !== move.ply - 1) tokens.push(`${moveNumber}...`);
      tokens.push(move.notation);
    }
    previousPly = move.ply;
  }
  tokens.push(result);
  return tokens.join(" ");
}

function requiredText(
  args: JsonObject,
  key: string,
  pattern: RegExp,
): string {
  const value = args[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw toolError("invalid_request", `Invalid ${key}`);
  }
  return value;
}

function optionalPromotion(value: JsonValue | undefined): PromotionPiece | null {
  if (value === undefined) return null;
  if (value === "q" || value === "r" || value === "b" || value === "n") {
    return value;
  }
  throw toolError("invalid_request", "Invalid promotion");
}

function translateBackendMoveError(reason: unknown): Error {
  const error = toError(reason) as Error & { code?: string };
  if (error.code === "conflict") {
    return toolError(
      "conflict",
      `${error.message}. Inspect chess_position again before choosing a move.`,
    );
  }
  if (error.code === "validation") {
    return toolError("illegal_move", error.message);
  }
  return error;
}

function toolError(code: string, message: string): ChessAgentToolError {
  return new ChessAgentToolError(code, message);
}

let publishedStateRevision = 0;

async function publishChessStateChange(): Promise<void> {
  publishedStateRevision += 1;
  await publishAppStateChange(CHESS_STATE_TOPIC, publishedStateRevision);
}
