/**
 * Building custom (generic) proposals.
 *
 * Most real SNS governance runs through DAO-registered custom functions —
 * Neutrinite has 18 — whose payload is an opaque Candid blob. A client that
 * only supports the built-in actions is not really an SNS governance client.
 *
 * The pipeline, all anonymous and free until the moment of submission:
 *
 *   list_nervous_system_functions  -> target + validator
 *   candid:service metadata        -> the target's interface
 *   icblast idlFactoryFromCandid   -> IDL types for its argument
 *   IDL.encode(plain JS value)     -> payload bytes
 *   validator(payloadBytes)        -> Ok("<what voters will see>") | Err(reason)
 *
 * `icblast` already bundles the Rust Candid parser as wasm (864 KB), so it is
 * imported lazily — only a user who opens the builder pays for it.
 */

import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { callRaw, getAgent, type AgentOptions } from "./agent";
import { decodeIcrcAccount, encodeIcrcAccount, toCandidAccount } from "./accounts";
import { SnsError } from "./errors";

/** Result of a validator pre-flight. */
export interface ValidationResult {
  ok: boolean;
  /**
   * On success, the DAO's own rendering of the payload.
   *
   * This is the `## Payload:` section of what voters see, not the whole
   * `payload_text_rendering` field — governance wraps it with a Rust debug dump
   * of the function and a payload digest, which cannot be reconstructed from
   * Candid. Show it as the payload rendering, never as the full field.
   */
  rendering?: string;
  error?: string;
}

/** Fetch a canister's `candid:service` metadata. */
export async function discoverInterface(
  canisterId: string,
  options: AgentOptions = {},
): Promise<string | null> {
  const { CanisterStatus } = await import("@dfinity/agent");
  const agent = await getAgent(options);
  try {
    const status = await CanisterStatus.request({
      canisterId: Principal.fromText(canisterId),
      agent,
      paths: ["candid"],
    });
    const candid = status.get("candid");
    return typeof candid === "string" && candid.trim() ? candid : null;
  } catch {
    return null;
  }
}

/**
 * The argument type of one method on a fetched interface.
 *
 * Derived from the **target** method, not the validator: their signatures match
 * only by convention, and the target is the one that must decode at execution.
 */
export async function methodArgumentType(
  did: string,
  methodName: string,
): Promise<IDL.Type | null> {
  const { idlFactoryFromCandid } = await import("icblast");
  const factory = (await idlFactoryFromCandid(did)) as IDL.InterfaceFactory;
  const service = factory({ IDL }) as unknown as {
    _fields: [string, { argTypes: IDL.Type[] }][];
  };
  const found = service._fields.find(([name]) => name === methodName);
  return found?.[1].argTypes[0] ?? null;
}

/** Encode a payload from a plain JS value against the target's argument type. */
export function encodePayload(argType: IDL.Type, value: unknown): Uint8Array {
  return new Uint8Array(IDL.encode([argType], [value]));
}

/**
 * Run the DAO's own validator over the exact payload bytes.
 *
 * Governance passes the payload through verbatim and decodes the reply as
 * `Result<String, String>`, so this reproduces what it will do at submission.
 * A validator may legally be a query or an update; `callRaw` tries query first.
 *
 * Note this does not save the reject fee — a failed submission costs nothing,
 * because governance validates before it charges. It is worth doing anyway: it
 * produces the string a human reviews, lets an agent self-correct without a
 * round trip, and avoids a pointless signed relay call.
 */
export async function validatePayload(
  params: { validatorCanisterId: string; validatorMethodName: string; payload: Uint8Array },
  options: AgentOptions = {},
): Promise<ValidationResult> {
  let reply: Uint8Array;
  try {
    reply = await callRaw(
      params.validatorCanisterId,
      params.validatorMethodName,
      params.payload,
      options,
    );
  } catch (error) {
    return { ok: false, error: `validator unreachable: ${describe(error)}` };
  }

  try {
    const [decoded] = IDL.decode([IDL.Variant({ Ok: IDL.Text, Err: IDL.Text })], reply) as [
      { Ok?: string; Err?: string },
    ];
    if (decoded.Ok !== undefined) return { ok: true, rendering: decoded.Ok };
    return { ok: false, error: decoded.Err ?? "rejected" };
  } catch (error) {
    return { ok: false, error: `undecodable validator reply: ${describe(error)}` };
  }
}

// --- ICRC account ergonomics ------------------------------------------------

/**
 * Is this Candid type an ICRC-1 account?
 *
 * Matched **structurally**, on the field shape, never on the field's name in
 * its parent record — DAOs call it `to`, `from`, `recipient`, `destination`.
 */
export function isIcrcAccountType(type: IDL.Type): boolean {
  const record = type as unknown as { _fields?: [string, IDL.Type][] };
  if (!Array.isArray(record._fields)) return false;
  const names = record._fields.map(([name]) => name);
  if (names.length !== 2) return false;
  if (!names.includes("owner") || !names.includes("subaccount")) return false;
  const owner = record._fields.find(([name]) => name === "owner")?.[1];
  return owner?.name === "principal";
}

/**
 * Turn one of three user-typed forms into the Candid account value.
 *
 * Accepts a bare principal, an ICRC-1 textual account with checksum, or a
 * principal plus an explicit 64-hex subaccount. A wrong-but-well-formed account
 * is the realistic failure mode, so the checksum is verified and the caller is
 * expected to echo `describeAccount` back to the user for confirmation.
 */
export function parseAccountInput(input: string): ReturnType<typeof toCandidAccount> {
  const account = decodeIcrcAccount(input);
  return toCandidAccount(account);
}

/** Canonical text for an account, for read-back confirmation. */
export function describeAccount(owner: string, subaccount?: Uint8Array): string {
  return encodeIcrcAccount({
    owner: Principal.fromText(owner),
    ...(subaccount === undefined ? {} : { subaccount }),
  });
}

/** The complete builder input for one custom proposal. */
export interface CustomProposalDraft {
  functionId: bigint;
  targetCanisterId: string;
  targetMethodName: string;
  validatorCanisterId?: string;
  validatorMethodName?: string;
  /** Absent means the function is untopicked and cannot be submitted at all. */
  topic?: string;
}

/**
 * Build and validate a payload end to end.
 *
 * Refuses an untopicked function up front: `make_proposal` hard-fails on those
 * regardless of payload quality, and failing at send time after a clean preview
 * is a confusing way to learn that.
 */
export async function buildAndValidate(
  draft: CustomProposalDraft,
  value: unknown,
  options: AgentOptions = {},
): Promise<{ payload: Uint8Array; validation: ValidationResult }> {
  if (draft.topic === undefined) {
    throw new SnsError(
      "INVALID_REQUEST",
      "This proposal type has no topic assigned, so the SNS rejects every submission of it. The DAO must submit SetTopicsForCustomProposals first.",
      { retryable: false },
    );
  }

  const did = await discoverInterface(draft.targetCanisterId, options);
  if (!did) {
    throw new SnsError(
      "SNS_UNSUPPORTED_METHOD",
      `${draft.targetCanisterId} does not publish a Candid interface, so its payload cannot be built automatically. Reuse a previous proposal of this type as a template instead.`,
      { retryable: false },
    );
  }

  const argType = await methodArgumentType(did, draft.targetMethodName);
  if (!argType) {
    throw new SnsError(
      "INVALID_REQUEST",
      `${draft.targetMethodName} is not present on ${draft.targetCanisterId}`,
      { retryable: false },
    );
  }

  const payload = encodePayload(argType, value);

  if (draft.validatorCanisterId && draft.validatorMethodName) {
    const validation = await validatePayload(
      {
        validatorCanisterId: draft.validatorCanisterId,
        validatorMethodName: draft.validatorMethodName,
        payload,
      },
      options,
    );
    return { payload, validation };
  }
  return { payload, validation: { ok: true } };
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);
}
