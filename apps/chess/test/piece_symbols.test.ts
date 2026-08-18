import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  CHESS_PIECE_SYMBOLS,
  chessPieceSymbol,
} from "../src/piece_symbols.ts";

test("Chess uses the standard Unicode symbols for every piece", () => {
  expect(CHESS_PIECE_SYMBOLS).toEqual({
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
  });
  expect(chessPieceSymbol("wK")).toBe("♔");
  expect(chessPieceSymbol("bP")).toBe("♟");
  expect(new Set(Object.values(CHESS_PIECE_SYMBOLS)).size).toBe(12);
});

test("Chess does not import Font Awesome artwork", async () => {
  const source = await readFile(new URL("../src/index.tsx", import.meta.url), "utf8");
  expect(source).not.toContain("react-icons/fa6");
  expect(source).not.toContain("FaChess");
  expect(source).toContain('from "./piece_symbols.ts"');
});
