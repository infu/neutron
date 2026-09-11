import { expect, test } from "bun:test";
import {
  HttpErrorCode,
  HttpFetchErrorCode,
  ProtocolError,
  RejectError,
  ReplicaRejectCode,
  TransportError,
  UncertifiedRejectErrorCode,
  requestIdOf,
} from "@dfinity/agent";
import { classifyError, isInactive, SnsError } from "../src/data/errors";

const governance = { sns: "sns-root", role: "governance" } as const;

// IC error codes/messages from pinned upstream commit
// 605a5396f12536e4e7b30479397e196c71b18961: packages/ic-error-types/src/lib.rs,
// rs/replicated_state/src/replicated_state.rs, and
// rs/execution_environment/src/query_handler/query_context.rs.
test.each([
  "IC0537: Attempted to execute a message, but the canister contains no Wasm module.",
  "Attempted to execute a message, but the canister contains no Wasm module.",
  "IC0301: Canister aaaaa-aa not found",
  "Canister aaaaa-aa not found",
  "Canister aaaaa-aa is stopped and therefore does not have a CallContextManager",
  "Canister aaaaa-aa is stopping",
  "Canister aaaaa-aa is not running",
  "Canister aaaaa-aa is out of cycles: please top up the canister with at least 123 additional cycles",
  "Canister aaaaa-aa is unable to process query calls because it's frozen. Please top up the canister with cycles and try again.",
])("confirmed governance failure is inactive: %s", (message) => {
  const original = new Error(message);
  const error = classifyError(original, governance);
  expect(error.code).toBe("SNS_GOVERNANCE_INACTIVE");
  expect(error.message).toBe(message);
  expect(error.sns).toBe(governance.sns);
  expect(error.retryable).toBe(false);
  expect(error.cause).toBe(original);
  expect(isInactive(error)).toBe(true);
});

test.each(["IC0207", "IC0301", "IC0508", "IC0509", "IC0537"])(
  "recognizes structured replica code %s without relying on message wording", (code) => {
    const original = { status: "rejected", reject_code: code === "IC0207" ? 2 : 5, error_code: code, reject_message: "replica rejection" };
    const error = classifyError(original, governance);
    expect(error.code).toBe("SNS_GOVERNANCE_INACTIVE");
    expect(error.message).toContain(code);
    expect(error.message).toContain("replica rejection");
    expect(error.cause).toBe(original);
  },
);

test("agent rejection and wrapped cause retain specific out-of-cycles evidence over reject code 2", () => {
  const rejected = RejectError.fromCode(new UncertifiedRejectErrorCode(
    requestIdOf({}), ReplicaRejectCode.SysTransient,
    "Canister aaaaa-aa is out of cycles", "IC0207", undefined,
  ));
  const wrapped = new Error("Proposal read failed", { cause: rejected });
  for (const original of [rejected, wrapped, { cause: rejected.cause }]) {
    const error = classifyError(original, governance);
    expect(error.code).toBe("SNS_GOVERNANCE_INACTIVE");
    expect(error.message).toContain("out of cycles");
    expect(error.message).not.toContain("no Wasm");
    expect(error.cause).toBe(original);
  }
});

test.each([
  new Error("Reject code: 2; Certified state unavailable"),
  new Error("query rejected (2): replica busy"),
  { reject_code: 2, reject_message: "replica busy" },
  { cause: { code: { rejectCode: 2, rejectMessage: "replica busy", rejectErrorCode: "IC0208" } } },
  new Error("request timed out"),
  new Error("network connection lost"),
  new TypeError("Failed to fetch"),
  Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" }),
  new Error("HTTP 429 Too Many Requests"),
  { status: 429, statusText: "Too Many Requests" },
  ProtocolError.fromCode(new HttpErrorCode(429, "Too Many Requests", [])),
  TransportError.fromCode(new HttpFetchErrorCode(new TypeError("Failed to fetch"))),
])("transient failures remain visible and retryable: %s", (original) => {
  const error = classifyError(original, governance);
  expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
  expect(error.retryable).toBe(true);
  expect(error.cause).toBe(original);
  expect(isInactive(error)).toBe(false);
});

test.each([
  "HTTP 404 Not Found",
  "Proposal not found",
  "IC05370: unrelated error",
  "IC0510: Canister aaaaa-aa is not stopped",
  "Not enough cycles attached to the request",
])("unrelated failures do not establish inactive governance: %s", (message) => {
  expect(isInactive(classifyError(new Error(message), governance))).toBe(false);
});

test("missing methods retain their separate classification", () => {
  const error = classifyError(new Error("IC0536: Canister aaaaa-aa has no query method list_proposals"), governance);
  expect(error.code).toBe("SNS_UNSUPPORTED_METHOD");
  expect(isInactive(error)).toBe(false);
});

test("ledger failures retain ledger-specific semantics and original messages", () => {
  for (const message of ["Canister aaaaa-aa contains no Wasm module", "IC0207: Canister aaaaa-aa is out of cycles"]) {
    const error = classifyError(new Error(message), { role: "ledger" });
    expect(error.code).toBe("SNS_LEDGER_INACTIVE");
    expect(error.message).toBe(message);
    expect(isInactive(error)).toBe(true);
  }
  expect(classifyError(new Error("IC0537")).code).toBe("SNS_GOVERNANCE_INACTIVE");
});

test("existing application errors are preserved and cyclic wrapper causes terminate", () => {
  const prior = new SnsError("OUTCOME_UNKNOWN", "Do not retry this update", { retryable: false });
  expect(classifyError(prior, governance)).toBe(prior);
  const wrapped: { message: string; cause?: unknown } = { message: "Canister aaaaa-aa is stopped" };
  wrapped.cause = wrapped;
  expect(classifyError(wrapped, governance).code).toBe("SNS_GOVERNANCE_INACTIVE");
  expect(classifyError(undefined, governance).message).toBe("undefined");
});
