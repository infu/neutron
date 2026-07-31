export type FilesReconciliationState<T> =
  | Readonly<{ kind: "committed"; value: T }>
  | Readonly<{ kind: "active" }>
  | Readonly<{ kind: "terminal"; message: string }>
  | Readonly<{ kind: "unknown" }>;

export type FilesAmbiguousUpdateOptions<T> = Readonly<{
  dispatch(): Promise<T>;
  reconcile(): Promise<FilesReconciliationState<T>>;
  isAmbiguous(error: unknown): boolean;
  onCheckingOutcome?(): void;
  onRetry?(attempt: number): void;
  signal?: AbortSignal;
  maximumRetries?: number;
  initialBackoffMs?: number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}>;

export class FilesUpdateUncertainError extends Error {
  constructor(
    public readonly code:
      | "operation_unknown"
      | "operation_terminal"
      | "operation_cancelled",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "FilesUpdateUncertainError";
  }
}

/**
 * Reconciles a lost update response before retrying the exact idempotent
 * operation. Known application rejections are never retried.
 */
export async function runFilesAmbiguousUpdate<T>(
  options: FilesAmbiguousUpdateOptions<T>,
): Promise<T> {
  const maximumRetries = bounded(
    options.maximumRetries ?? 2,
    0,
    4,
    "Files ambiguous-update retry limit",
  );
  const initialBackoffMs = bounded(
    options.initialBackoffMs ?? 250,
    10,
    10_000,
    "Files ambiguous-update backoff",
  );
  const wait = options.wait ?? waitFor;
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await options.dispatch();
    } catch (error) {
      if (!options.isAmbiguous(error)) throw error;
      options.onCheckingOutcome?.();
      const state = await options.reconcile();
      switch (state.kind) {
        case "committed":
          return state.value;
        case "terminal":
          throw new FilesUpdateUncertainError(
            "operation_terminal",
            state.message,
            { cause: error },
          );
        case "unknown":
          throw new FilesUpdateUncertainError(
            "operation_unknown",
            "Files could not prove whether the update committed",
            { cause: error },
          );
        case "active":
          if (attempt >= maximumRetries) {
            throw new FilesUpdateUncertainError(
              "operation_unknown",
              "Files update is still active; retry it from the transfer panel",
              { cause: error },
            );
          }
          options.onRetry?.(attempt + 1);
          await wait(initialBackoffMs * 2 ** attempt, options.signal);
      }
    }
  }
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new FilesUpdateUncertainError(
    "operation_cancelled",
    "Files operation was cancelled",
    { cause: signal.reason },
  );
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new FilesUpdateUncertainError(
          "operation_cancelled",
          "Files operation was cancelled",
          { cause: signal.reason },
        ),
      );
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        new FilesUpdateUncertainError(
          "operation_cancelled",
          "Files operation was cancelled",
          { cause: signal?.reason },
        ),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
