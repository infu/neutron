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
  /** Governance is absent, stopped, out of cycles, or has no Wasm installed. */
  | "SNS_GOVERNANCE_INACTIVE"
  /** The ledger is absent, stopped, out of cycles, or has no Wasm installed. */
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
 * Replica ErrorCode values, not the broader reject codes. In particular,
 * IC0207 (out of cycles) shares reject code 2 with transient replica failures.
 * IC0536 means a missing method and is deliberately excluded.
 */
const INACTIVE_CANISTER =
  /\bIC(?:0207|0301|0508|0509|0537)\b|\bcontains no Wasm module\b|\bCanister(?: [a-z0-9-]+)? (?:not found|is stopped|is stopping|is not running|(?:is|ran) out of cycles)\b|\bCanister [a-z0-9-]+ is unable to process query calls because it's frozen\b/i;

/** A method the deployed version does not implement. */
const NO_SUCH_METHOD = /has no (?:query |update )?method|method .* not found|Canister has no update method/i;

const TRANSIENT =
  /Reject code:\s*2\b|query rejected \(2\)|\bSysTransient\b|timed out|timeout|network|fetch failed|Failed to fetch|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|\b(?:429|502|503|504)\b/i;

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

  if (INACTIVE_CANISTER.test(message)) {
    const code: SnsErrorCode =
      context.role === "ledger" ? "SNS_LEDGER_INACTIVE" : "SNS_GOVERNANCE_INACTIVE";
    return new SnsError(code, truncate(message), {
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

/** True for confirmed canister unavailability, distinct from a transport failure. */
export function isInactive(error: unknown): boolean {
  return (
    error instanceof SnsError &&
    (error.code === "SNS_GOVERNANCE_INACTIVE" || error.code === "SNS_LEDGER_INACTIVE")
  );
}

function errorText(error: unknown): string {
  const texts: string[] = [];
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  const add = (text: string) => {
    if (text && !texts.some((existing) => existing.includes(text))) texts.push(text);
  };

  // Agent 3.x stores replica fields in cause.code; transport wrappers store
  // their original exception in cause.code.error. Follow only error fields so
  // request IDs, method names, and payloads cannot supply classification codes.
  while (pending.length) {
    const value = pending.shift();
    if (typeof value === "string") { add(value); continue; }
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["message", "rejectMessage", "reject_message", "rejectErrorCode", "error_code", "bodyText"]) {
      if (typeof record[key] === "string") add(record[key]);
    }
    const rejectCode = record.rejectCode ?? record.reject_code;
    if (typeof rejectCode === "number") add(`Reject code: ${rejectCode}`);
    if (typeof record.status === "number") add(`HTTP status: ${record.status}`);
    pending.push(record.cause, record.code, record.error);
  }
  if (texts.length) return texts.join("; ");
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function truncate(value: string, max = 300): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
