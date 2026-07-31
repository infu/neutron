import { chooseComputerMove } from "./computer_engine.ts";
import { createPosition, type PositionOptions } from "./chess_rules.ts";
import type { ChessLegalMove, ComputerLevel } from "./chess_api.ts";

export type ComputerWorkerRequest = {
  id: number;
  level: ComputerLevel;
  position: PositionOptions;
  legalMoves: ChessLegalMove[];
};

export type ComputerWorkerResponse =
  | {
      id: number;
      move: { from: string; to: string; promotion: "q" | "r" | "b" | "n" | null } | null;
    }
  | { id: number; error: string };

const workerScope = globalThis as unknown as {
  postMessage(message: ComputerWorkerResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ComputerWorkerRequest>) => void,
  ): void;
};

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  try {
    const choice = chooseComputerMove(
      createPosition(request.position),
      request.level,
      { rootMoves: request.legalMoves },
    );
    workerScope.postMessage({
      id: request.id,
      move: choice
        ? {
            from: choice.from,
            to: choice.to,
            promotion: choice.promotion,
          }
        : null,
    });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
