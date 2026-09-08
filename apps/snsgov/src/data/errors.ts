/**
 * A closed error taxonomy for every SNS read and write.
 *
 * Structured codes matter more here than usual: a third of registered SNSes are
 * dead shells, so "this SNS is unavailable" is a routine, expected per-row state
 * rather than an exception. Callers switch on `code`; humans and agents read
 * `message`.
 */

export type SnsErrorCode =
  /** The root canister id is not in SNS-W's registry. */
  | "SNS_NOT_FOUND"
  /** Governance has no Wasm module installed (IC0537). 16 of 54 today. */
  | "SNS_GOVERNANCE_INACTIVE"
  /** The ledger has no Wasm module installed. 9 of 54 today. */
  | "SNS_LEDGER_INACTIVE"
  /** A canister rejected the call because the method does not exist on its version. */
  | "SNS_UNSUPPORTED_METHOD"
  /** Our principal holds no usable permission on any neuron for this SNS. */
  | "NOT_AUTHORIZED"
  /** The owner has not admitted this SNS, or has disabled it. */
  | "SNS_NOT_ALLOWED"
  /** Transient: boundary node, replica, or network. Retry is reasonable. */
  | "UPSTREAM_UNAVAILABLE"
  /** The caller supplied something invalid. Do not retry unchanged. */
  | "INVALID_REQUEST"
  /** An update may or may not have committed. Never auto-retry. */
  | "OUTCOME_UNKNOWN"
  /** Anything we could not classify. */
  | "INTERNAL";

export class SnsError extends Error {
  readonly code: SnsErrorCode;
  /** Root canister id, when the failure is attributable to one SNS. */
  readonly sns?: string;
  /** True when retrying the identical request could plausibly succeed. */
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: SnsErrorCode,
    message: string,
    options: { sns?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "SnsError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    if (options.sns !== undefined) this.sns = options.sns;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

const RETRYABLE = new Set<SnsErrorCode>(["UPSTREAM_UNAVAILABLE"]);

/**
 * `IC0537` is the replica's "canister contains no Wasm module" error. It is how
 * a dead SNS presents: the canister id resolves, but nothing is installed.
 */
const NO_WASM_MODULE = /IC0537|contains no Wasm module/i;

/** A method the deployed version does not implement. */
const NO_SUCH_METHOD = /has no (?:query |update )?method|method .* not found|Canister has no update method/i;

const TRANSIENT =
  /Reject code: 2|SysTransient|timed out|timeout|network|fetch failed|Failed to fetch|ECONNRESET|503|502|504/i;

/**
 * Classify a raw agent/replica failure into our taxonomy.
 *
 * `role` says which canister we were talking to, so a dead governance canister
 * and a dead ledger produce different codes — liveness is per-canister, and 7
 * SNSes have a dead governance canister but a live ledger.
 */
export function classifyError(
  error: unknown,
  context: { sns?: string; role?: "governance" | "ledger" | "root" | "swap" | "index" | "registry" } = {},
): SnsError {
  if (error instanceof SnsError) return error;
  const message = errorText(error);

  if (NO_WASM_MODULE.test(message)) {
    const code: SnsErrorCode =
      context.role === "ledger" ? "SNS_LEDGER_INACTIVE" : "SNS_GOVERNANCE_INACTIVE";
    return new SnsError(code, `${context.role ?? "canister"} has no Wasm module installed`, {
      ...(context.sns === undefined ? {} : { sns: context.sns }),
      retryable: false,
      cause: error,
    });
  }

  if (NO_SUCH_METHOD.test(message)) {
    return new SnsError("SNS_UNSUPPORTED_METHOD", `method unavailable on this SNS version`, {
      ...(context.sns === undefined ? {} : { sns: context.sns }),
      retryable: false,
      cause: error,
    });
  }

  if (TRANSIENT.test(message)) {
    return new SnsError("UPSTREAM_UNAVAILABLE", truncate(message), {
      ...(context.sns === undefined ? {} : { sns: context.sns }),
      retryable: true,
      cause: error,
    });
  }

  return new SnsError("INTERNAL", truncate(message), {
    ...(context.sns === undefined ? {} : { sns: context.sns }),
    cause: error,
  });
}

/** True when the SNS is structurally unavailable rather than momentarily failing. */
export function isInactive(error: unknown): boolean {
  return (
    error instanceof SnsError &&
    (error.code === "SNS_GOVERNANCE_INACTIVE" || error.code === "SNS_LEDGER_INACTIVE")
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function truncate(value: string, max = 300): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
