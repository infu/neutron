import { expect, test } from "bun:test";
import { parseGame, parseOptionalGame } from "../src/chess_api.ts";

const game = {
  tile_id: "tile-a",
  game_id: "00112233445566778899aabbccddeeff",
  mode: "computer",
  computer_level: "medium",
  revision: "3",
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
  castling: {
    white_kingside: true,
    white_queenside: true,
    black_kingside: true,
    black_queenside: true,
  },
  en_passant: "e6",
  halfmove_clock: "0",
  fullmove_number: "2",
  status: "active",
  winner: null,
  in_check: false,
  draw_offer_by: null,
  local_color: "white",
  remote_connected: false,
  position_keys: [
    "rnbqkbnr/pppppppp/......../......../......../......../PPPPPPPP/RNBQKBNR w KQkq -",
    "rnbqkbnr/pppp.ppp/......../....p.../....P.../......../PPPP.PPP/RNBQKBNR w KQkq e6",
  ],
  legal_moves: [{ from: "g1", to: "f3", promotion: null }],
  history: [
    {
      ply: "2",
      from: "e7",
      to: "e5",
      piece: "bP",
      placed: "bP",
      captured: null,
      promotion: null,
      special: "double_pawn",
      notation: "e5",
      at: "1000",
    },
  ],
};

test("Chess parses backend games and Candid integer strings", () => {
  expect(parseGame(game)).toMatchObject({
    tileId: "tile-a",
    mode: "computer",
    computerLevel: "medium",
    revision: 3,
    enPassant: "e6",
    fullmoveNumber: 2,
    positionKeys: expect.any(Array),
    legalMoves: [{ from: "g1", to: "f3", promotion: null }],
    history: [{ ply: 2, piece: "bP", notation: "e5", at: "1000" }],
  });
});

test("Chess parses Neutron-unwrapped results and optional game queries", () => {
  expect(parseOptionalGame(null)).toBeNull();
  expect(parseOptionalGame(game)).toEqual(parseGame(game));
});

test("Chess rejects malformed boards and move hints", () => {
  expect(() => parseGame({ ...game, rows: ["........"] })).toThrow("Invalid Chess board");
  expect(() =>
    parseGame({ ...game, legal_moves: [{ from: "z9", to: "e4", promotion: null }] }),
  ).toThrow("Invalid move origin");
});
