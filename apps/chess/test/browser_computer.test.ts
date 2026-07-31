import { expect, test } from "bun:test";
import { positionOptionsFromGame } from "../src/computer_position.ts";
import { createPosition, positionKey } from "../src/chess_rules.ts";
import type { ChessGame } from "../src/chess_api.ts";

test("The browser computer reconstructs backend repetition counts", () => {
  const position = createPosition();
  const key = positionKey(position);
  const options = positionOptionsFromGame({
    rows: [...position.rows],
    turn: position.turn,
    castling: { ...position.castling },
    enPassant: position.enPassant,
    halfmoveClock: position.halfmoveClock,
    fullmoveNumber: position.fullmoveNumber,
    positionKeys: [key, "another position", key],
  } as ChessGame);

  expect(options.repetition).toMatchObject({ [key]: 2, "another position": 1 });
});
