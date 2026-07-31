import { chooseComputerMove } from "./computer_engine.ts";
import { createPosition, type PositionOptions } from "./chess_rules.ts";
import { positionOptionsFromGame } from "./computer_position.ts";
import type {
  ChessGame,
  ChessLegalMove,
  ComputerLevel,
} from "./chess_api.ts";
import type {
  ComputerWorkerRequest,
  ComputerWorkerResponse,
} from "./computer_worker.ts";
import computerWorkerSource from "chess-worker-source";

export type BrowserComputerMove = {
  from: string;
  to: string;
  promotion: "q" | "r" | "b" | "n" | null;
};

type Pending = {
  resolve: (move: BrowserComputerMove | null) => void;
  reject: (error: Error) => void;
  timer: number;
};

export class BrowserComputer {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private disposed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor() {
    if (typeof Worker === "undefined") return;
    try {
      const workerBlob = new Blob([computerWorkerSource], {
        type: "application/javascript",
      });
      this.workerUrl = URL.createObjectURL(workerBlob);
      this.worker = new Worker(this.workerUrl);
      this.worker.addEventListener("message", this.handleMessage);
      this.worker.addEventListener("error", this.handleError);
    } catch {
      if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      this.worker = null;
    }
  }

  async choose(game: ChessGame): Promise<BrowserComputerMove | null> {
    if (this.disposed) throw new Error("Computer stopped");
    const position = positionOptionsFromGame(game);
    const level = game.computerLevel ?? "medium";
    if (!this.worker) return chooseLocally(position, level, game.legalMoves);

    const id = this.nextId++;
    const request: ComputerWorkerRequest = {
      id,
      level,
      position,
      legalMoves: game.legalMoves,
    };
    try {
      return await new Promise<BrowserComputerMove | null>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("The computer took too long to move"));
        }, 8_000);
        this.pending.set(id, { resolve, reject, timer });
        this.worker!.postMessage(request);
      });
    } catch (error) {
      if (this.disposed) throw error;
      return chooseLocally(position, level, game.legalMoves);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("Computer stopped"));
    }
    this.pending.clear();
  }

  private readonly handleMessage = (event: MessageEvent<ComputerWorkerResponse>) => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if ("error" in response) pending.reject(new Error(response.error));
    else pending.resolve(response.move);
  };

  private readonly handleError = () => {
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("Computer worker failed"));
    }
    this.pending.clear();
  };
}

function chooseLocally(
  options: PositionOptions,
  level: ComputerLevel,
  legalMoves: ChessLegalMove[],
): BrowserComputerMove | null {
  const choice = chooseComputerMove(createPosition(options), level, {
    rootMoves: legalMoves,
  });
  return choice
    ? { from: choice.from, to: choice.to, promotion: choice.promotion }
    : null;
}
