/**
 * Building custom (generic) proposals.
 *
 * Most real SNS governance runs through DAO-registered custom functions —
 * Neutrinite has 18 — whose payload is an opaque Candid blob. A client that
 * only supports the built-in actions is not really an SNS governance client.
 *
 * Interface discovery and validator previews use anonymous queries:
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
import { callRawQuery, getAgent, QueryMethodUnavailableError, type AgentOptions } from "./agent";
import { decodeIcrcAccount, encodeIcrcAccount, toCandidAccount } from "./accounts";
import { SnsError } from "./errors";
import { candidArgsFromJson, candidArgsToJson, candidTypeSchema, candidValueFromJson } from "./candid_codec";
import { toHex } from "./format";

/** Result of a validator pre-flight. */
export interface ValidationResult {
  ok: boolean;
  status?: "accepted" | "rejected" | "update_required" | "unavailable" | "invalid_reply" | "not_configured";
  updateRequired?: boolean;
  /** Exact response evidence; validator acceptance is advisory preflight. */
  rawReplyHex?: string;
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
  return (await methodArgumentTypes(did, methodName))?.[0] ?? null;
}

export interface CustomMethodSignature {
  argTypes: IDL.Type[];
  retTypes: IDL.Type[];
  annotations: string[];
}

async function methodSignature(did: string, methodName: string): Promise<CustomMethodSignature | null> {
  const { idlFactoryFromCandid } = await import("icblast");
  const factory = (await idlFactoryFromCandid(did)) as IDL.InterfaceFactory;
  const service = factory({ IDL }) as unknown as {
    _fields: [string, CustomMethodSignature][];
  };
  const found = service._fields.find(([name]) => name === methodName);
  return found?.[1] ?? null;
}

/** null means no such method; [] is a valid zero-argument method. */
export async function methodArgumentTypes(did: string, methodName: string): Promise<IDL.Type[] | null> {
  return (await methodSignature(did, methodName))?.argTypes ?? null;
}

export async function inspectCustomMethod(did: string, methodName: string): Promise<{
  argumentSchemas: Record<string, unknown>[];
  resultSchemas: Record<string, unknown>[];
  mode: "query" | "composite_query" | "update";
} | null> {
  const method = await methodSignature(did, methodName);
  if (!method) return null;
  return {
    argumentSchemas: method.argTypes.map(candidTypeSchema),
    resultSchemas: method.retTypes.map(candidTypeSchema),
    mode: method.annotations.includes("composite_query") ? "composite_query" : method.annotations.includes("query") ? "query" : "update",
  };
}

/** Encode a payload from a plain JS value against the target's argument type. */
export function encodePayload(argType: IDL.Type, value: unknown): Uint8Array {
  return new Uint8Array(IDL.encode([argType], [value]));
}

/** Encode the complete Candid argument tuple using lossless natural JSON. */
export function encodePayloadArguments(argTypes: IDL.Type[], values: unknown[]): Uint8Array {
  return new Uint8Array(IDL.encode(argTypes, candidArgsFromJson(argTypes, values)));
}

export function decodePayloadArguments(argTypes: IDL.Type[], payload: Uint8Array): unknown[] {
  return candidArgsToJson(argTypes, IDL.decode(argTypes, payload));
}

/**
 * Run the DAO's own validator over the exact payload bytes.
 *
 * Governance passes the payload through verbatim and decodes the reply as
 * `Result<String, String>`. This uses the same byte convention; caller identity
 * and changing remote state make the preview advisory.
 * A validator may be query or update. Preview stays query-only; update-only
 * methods require a separately routed write. The caller here is anonymous,
 * whereas authoritative submission calls the validator as SNS Governance.
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
    reply = await callRawQuery(
      params.validatorCanisterId,
      params.validatorMethodName,
      params.payload,
      options,
    );
  } catch (error) {
    if (error instanceof QueryMethodUnavailableError) {
      return { ok: false, status: "update_required", updateRequired: true, error: "The validator has no query method. An explicit update validation is required; no update was sent." };
    }
    return { ok: false, status: "unavailable", error: `validator query unavailable: ${describe(error)}` };
  }

  try {
    const [decoded] = IDL.decode([IDL.Variant({ Ok: IDL.Text, Err: IDL.Text })], reply) as [
      { Ok?: string; Err?: string },
    ];
    if (decoded.Ok !== undefined) return { ok: true, status: "accepted", rendering: decoded.Ok, rawReplyHex: toHex(reply) };
    return { ok: false, status: "rejected", error: decoded.Err ?? "rejected", rawReplyHex: toHex(reply) };
  } catch (error) {
    return { ok: false, status: "invalid_reply", error: `undecodable validator reply: ${describe(error)}`, rawReplyHex: toHex(reply) };
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
  const subaccount = record._fields.find(([name]) => name === "subaccount")?.[1];
  return owner?.name === "principal"
    && subaccount instanceof IDL.OptClass
    && subaccount._type instanceof IDL.VecClass
    && subaccount._type._type.name === "nat8";
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
  /** Older governance versions permit custom functions without a topic. */
  topic?: string;
  /** Explicit interface supplied with provenance when metadata is unavailable. */
  candidInterface?: string;
}

/**
 * Build and validate a payload end to end.
 *
 * Topic requirements depend on the deployed governance version. An absent
 * topic does not prevent a read-only validator preview; Governance decides
 * whether the proposal is eligible when it receives the submission.
 */
export async function buildAndValidate(
  draft: CustomProposalDraft,
  value: unknown,
  options: AgentOptions = {},
): Promise<{ payload: Uint8Array; validation: ValidationResult }> {
  const did = draft.candidInterface ?? await discoverInterface(draft.targetCanisterId, options);
  if (!did) {
    throw new SnsError(
      "SNS_UNSUPPORTED_METHOD",
      `${draft.targetCanisterId} does not publish a Candid interface. Supply an interface or original payload bytes. Historical proposal payloads over 64 bytes are summaries and cannot be reused as original bytes.`,
      { retryable: false },
    );
  }

  const argTypes = await methodArgumentTypes(did, draft.targetMethodName);
  if (argTypes === null) {
    throw new SnsError(
      "INVALID_REQUEST",
      `${draft.targetMethodName} is not present on ${draft.targetCanisterId}`,
      { retryable: false },
    );
  }

  let values: unknown[];
  if (argTypes.length === 0) {
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length !== 0)) {
      throw new SnsError("INVALID_REQUEST", "This method takes no arguments; provide an empty argument list.");
    }
    values = [];
  } else if (argTypes.length === 1) {
    // Keep the existing single-argument API, including vector-valued arguments.
    values = [value];
  } else {
    if (!Array.isArray(value)) throw new SnsError("INVALID_REQUEST", `This method takes ${argTypes.length} arguments; provide their array in declaration order.`);
    values = value;
  }
  if (values.length !== argTypes.length) throw new SnsError("INVALID_REQUEST", `Expected ${argTypes.length} method arguments, got ${values.length}.`);
  const payload = new Uint8Array(IDL.encode(argTypes, values.map((argument, index) => {
    const type = argTypes[index];
    if (!type) throw new SnsError("INVALID_REQUEST", `Missing argument type at position ${index}.`);
    return candidValueFromJson(type, accountInput(type, argument));
  })));

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
  return { payload, validation: { ok: false, status: "not_configured", error: "The function's validator metadata is incomplete; no validation was performed." } };
}

/** Account strings are a convenience for exact ICRC account-shaped records. */
function accountInput(type: IDL.Type, value: unknown): unknown {
  if (isIcrcAccountType(type) && typeof value === "string") {
    const account = decodeIcrcAccount(value);
    return { owner: account.owner.toText(), subaccount: account.subaccount ? { hex: toHex(account.subaccount) } : null };
  }
  // Walk the target schema so nested destination/recipient accounts work too.
  const fields = (type as unknown as { _fields?: [string, IDL.Type][] })._fields;
  if (type instanceof IDL.RecordClass && fields && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => {
      const childType = fields.find(([field]) => field === name)?.[1];
      return [name, childType ? accountInput(childType, child) : child];
    }));
  }
  if (type instanceof IDL.OptClass && value !== null && value !== undefined) {
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && "$some" in value) {
      return { $some: accountInput(type._type, (value as { $some: unknown }).$some) };
    }
    return accountInput(type._type, value);
  }
  if (type instanceof IDL.VecClass && Array.isArray(value)) return value.map(item => accountInput(type._type, item));
  if (type instanceof IDL.VariantClass && fields && typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => {
      const childType = fields.find(([field]) => field === name)?.[1];
      return [name, childType ? accountInput(childType, child) : child];
    }));
  }
  return value;
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);
}
