import { expect, test } from "bun:test";
import { chooseComputerMove } from "../src/computer_engine.ts";
import {
  applyMove,
  createInitialPosition,
  createPosition,
  positionKey,
} from "../src/chess_rules.ts";

test("The browser computer always chooses a legal move without mutating its position", () => {
  const position = createInitialPosition();
  const before = structuredClone(position);
  const choice = chooseComputerMove(position, "medium", {
    maxDepth: 2,
    timeLimitMs: 10_000,
    random: () => 0,
  });

  expect(choice).not.toBeNull();
  expect(() => applyMove(position, asMoveInput(choice!))).not.toThrow();
  expect(position).toEqual(before);
});

test("The browser computer takes a forced checkmate", () => {
  const position = createPosition({
    rows: [
      ".......k",
      "........",
      ".....KQ.",
      "........",
      "........",
      "........",
      "........",
      "........",
    ],
    turn: "white",
  });
  const choice = chooseComputerMove(position, "hard", {
    maxDepth: 2,
    timeLimitMs: 10_000,
    random: () => 0,
  });

  expect(choice).toMatchObject({ from: "g6", to: "g7", score: 99_999 });
  expect(applyMove(position, asMoveInput(choice!)).status.outcome).toMatchObject({
    reason: "checkmate",
    winner: "white",
  });
});

test("The browser computer honors the authoritative root move list", () => {
  const position = createInitialPosition();
  const choice = chooseComputerMove(position, "easy", {
    maxDepth: 1,
    timeLimitMs: 10_000,
    random: () => 0,
    rootMoves: [{ from: "a2", to: "a3", promotion: null }],
  });

  expect(choice).toMatchObject({ from: "a2", to: "a3", promotion: null });
});

test("The hard computer ranks root moves by exact scores", () => {
  const position = createPosition({
    rows: [
      ".....k..",
      ".....p.p",
      "...b....",
      "p......p",
      "..p.....",
      "........",
      "...Kr...",
      "........",
    ],
    turn: "white",
    halfmoveClock: 5,
    fullmoveNumber: 47,
  });
  const choice = chooseComputerMove(position, "hard", {
    maxDepth: 3,
    timeLimitMs: 10_000,
    random: () => 0.999,
  });

  expect(choice).toMatchObject({ from: "d2", to: "e2" });
});

test("The browser computer returns no move from a terminal draw", () => {
  const position = createPosition({
    rows: [
      ".......k",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "K.......",
    ],
    turn: "white",
  });

  expect(chooseComputerMove(position, "hard")).toBeNull();
});

test("The hard computer can choose an immediate repetition draw", () => {
  const base = createPosition({
    rows: [
      ".....k..",
      ".....p.p",
      "...b....",
      "p......p",
      "..p.....",
      "........",
      "...Kr...",
      "........",
    ],
    turn: "white",
    halfmoveClock: 5,
    fullmoveNumber: 47,
  });
  const repeatedKey = positionKey(
    applyMove(base, { from: "d2", to: "d1" }).position,
  );
  const position = createPosition({
    ...base,
    repetition: {
      ...base.repetition,
      [repeatedKey]: 2,
    },
  });
  const choice = chooseComputerMove(position, "hard", {
    maxDepth: 3,
    timeLimitMs: 10_000,
    random: () => 0.999,
  });

  expect(choice).toMatchObject({ from: "d2", to: "d1", score: 0 });
});

function asMoveInput(move: {
  from: string;
  to: string;
  promotion: "q" | "r" | "b" | "n" | null;
}) {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion ? { promotion: move.promotion } : {}),
  };
}
