export type FilesQueuedUpload = Readonly<{
  id: string;
  signal: AbortSignal;
  run(): Promise<void>;
  onCancelledBeforeStart?(): void;
}>;

type PendingUpload = FilesQueuedUpload & {
  removeAbortListener(): void;
};

/**
 * Volatile FIFO for operating-system uploads.
 *
 * V2 deliberately permits one active upload. That keeps one Files public
 * stage and at most one File.slice chunk in flight instead of multiplying the
 * browser heap and backend staging reservations when a picker returns several
 * files.
 */
export class FilesSerialUploadQueue {
  readonly #pending: PendingUpload[] = [];
  #active: FilesQueuedUpload | null = null;
  #closed = false;

  get activeId(): string | null {
    return this.#active?.id ?? null;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  enqueue(upload: FilesQueuedUpload): void {
    if (this.#closed) throw new Error("Files upload queue is closed");
    if (
      !upload.id ||
      this.#active?.id === upload.id ||
      this.#pending.some((candidate) => candidate.id === upload.id)
    ) {
      throw new Error("Files upload queue id is invalid or duplicated");
    }
    if (upload.signal.aborted) {
      upload.onCancelledBeforeStart?.();
      return;
    }
    const onAbort = (): void => {
      const index = this.#pending.findIndex(
        (candidate) => candidate.id === upload.id,
      );
      if (index < 0) return;
      const [cancelled] = this.#pending.splice(index, 1);
      cancelled?.removeAbortListener();
      upload.onCancelledBeforeStart?.();
    };
    upload.signal.addEventListener("abort", onAbort, { once: true });
    this.#pending.push({
      ...upload,
      removeAbortListener: () =>
        upload.signal.removeEventListener("abort", onAbort),
    });
    this.#drain();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const upload of this.#pending.splice(0)) {
      upload.removeAbortListener();
      upload.onCancelledBeforeStart?.();
    }
  }

  #drain(): void {
    if (this.#closed || this.#active !== null) return;
    const next = this.#pending.shift();
    if (!next) return;
    next.removeAbortListener();
    if (next.signal.aborted) {
      next.onCancelledBeforeStart?.();
      this.#drain();
      return;
    }
    this.#active = next;
    void next.run()
      .catch(() => undefined)
      .finally(() => {
        if (this.#active === next) this.#active = null;
        this.#drain();
      });
  }
}
