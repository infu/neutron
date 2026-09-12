/**
 * Candid encoding for `manage_neuron`.
 *
 * All encoding happens here, in TypeScript, against the authoritative
 * interface. The backend relays opaque bytes and models no SNS types, so an SNS
 * interface change cannot trap the actor and cannot force a state-migrating
 * release.
 *
 * Two encoders, deliberately:
 *
 *  - `encodeRegisterVote` uses a hand-written **minimal** `ManageNeuron` type
 *    containing only the command it sends. Candid puts the whole type graph in
 *    every message's type table, so the full generated type costs 1481 bytes for
 *    a vote while the minimal one costs 103 — a 14x difference that matters when
 *    voting with a hundred neurons. Candid variant subtyping means the
 *    receiver's full decoder accepts the narrow encoding; this is verified by
 *    test.
 *  - Everything else uses the generated types, where correctness matters more
 *    than size.
 */

import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { Action, Command, ManageNeuron, ManageNeuronResponse } from "../candid/sns_governance.did";
import { fromHex, toHex } from "./format";
import { candidTypeSchema, candidValueFromJson, candidValueToJson } from "./candid_codec";
import { candidFieldType, candidVariantFields, governanceCommandType, governanceMethodTypes } from "./governance_codec";
import { validateProposalAction, validateProposalText } from "./proposal_actions";

/** SNS `Vote`: 0 unspecified, 1 yes, 2 no. */
export const VOTE_YES = 1;
export const VOTE_NO = 2;

/** SNS `NeuronPermissionType` values. */
export const PERMISSION_SUBMIT_PROPOSAL = 3;
export const PERMISSION_VOTE = 4;
/** The complete grant this app asks for, and nothing more. */
export const REQUIRED_PERMISSIONS = [PERMISSION_SUBMIT_PROPOSAL, PERMISSION_VOTE];

// --- Minimal hot-path types -------------------------------------------------

const ProposalIdT = IDL.Record({ id: IDL.Nat64 });
const RegisterVoteT = IDL.Record({ vote: IDL.Int32, proposal: IDL.Opt(ProposalIdT) });
const MinimalCommandT = IDL.Variant({ RegisterVote: RegisterVoteT });
const MinimalManageNeuronT = IDL.Record({
  subaccount: IDL.Vec(IDL.Nat8),
  command: IDL.Opt(MinimalCommandT),
});

/**
 * Encode one vote. 103 bytes rather than the 1481 a full `ManageNeuron` costs.
 *
 * `neuronId` is the 32-byte neuron subaccount, hex or raw.
 */
export function encodeRegisterVote(
  neuronId: string | Uint8Array,
  proposalId: bigint,
  adopt: boolean,
): Uint8Array {
  const subaccount = normalizeNeuronId(neuronId);
  return new Uint8Array(
    IDL.encode(
      [MinimalManageNeuronT],
      [
        {
          subaccount,
          command: [{ RegisterVote: { vote: adopt ? VOTE_YES : VOTE_NO, proposal: [{ id: proposalId }] } }],
        },
      ],
    ),
  );
}

// --- Full generated types ---------------------------------------------------

function manageNeuronTypes(): { arg: IDL.Type; ret: IDL.Type } {
  const method = governanceMethodTypes("manage_neuron");
  const arg = method.argTypes[0];
  const ret = method.retTypes[0];
  if (!arg || !ret) throw new Error("manage_neuron has an unexpected shape");
  return { arg, ret };
}

/** Encode an arbitrary `ManageNeuron` value using the generated interface. */
export function encodeManageNeuron(value: unknown): Uint8Array {
  return new Uint8Array(IDL.encode([manageNeuronTypes().arg], [value]));
}

/** Decode preserved request bytes without discarding any command fields. */
export function decodeManageNeuronRequest(args: Uint8Array): ManageNeuron {
  return IDL.decode([manageNeuronTypes().arg], args)[0] as unknown as ManageNeuron;
}

export function manageNeuronCommandSchema(kind: string): Record<string, unknown> {
  return candidTypeSchema(candidFieldType(governanceCommandType(), kind));
}

export function manageNeuronCommandCatalog(): {
  kind: string;
  commandKind: string;
  name: string;
  schema: Record<string, unknown>;
  availabilityNote?: string;
}[] {
  return candidVariantFields(governanceCommandType()).map(([commandKind, type]) => ({
    kind: commandKind,
    commandKind,
    name: commandKind.replace(/([a-z])([A-Z])/g, "$1 $2"),
    schema: candidTypeSchema(type),
    ...(commandKind === "MergeMaturity"
      ? { availabilityNote: "Legacy interface command rejected by current SNS Governance; use StakeMaturity or DisburseMaturity." }
      : {}),
  }));
}

/** Natural JSON conversion is separate from the generated-value encoder. */
export function buildManageNeuronCommand(commandKind: string, input: unknown): Command {
  const command = candidValueFromJson(governanceCommandType(), { [commandKind]: input }) as Command;
  if ("MakeProposal" in command) {
    validateProposalText(command.MakeProposal);
    const action = command.MakeProposal.action[0];
    if (!action) throw new TypeError("A proposal action is required.");
    validateProposalAction(action);
  }
  return command;
}

export function encodeManageNeuronCommand(
  neuronId: string | Uint8Array,
  commandKind: string,
  input: unknown,
): Uint8Array {
  return encodeManageNeuron({
    subaccount: normalizeNeuronId(neuronId),
    command: [buildManageNeuronCommand(commandKind, input)],
  });
}

export function manageNeuronRequestToJson(request: ManageNeuron): unknown {
  return candidValueToJson(manageNeuronTypes().arg, request);
}

/**
 * Submit a proposal.
 *
 * The reference SNS library ships no `makeProposal` helper at all, so this is
 * ours. Validation of title/summary/url length happens before this is called.
 */
export function encodeMakeProposal(params: {
  neuronId: string | Uint8Array;
  title: string;
  summary: string;
  url: string;
  action: unknown;
}): Uint8Array {
  validateProposalText(params);
  validateProposalAction(params.action as Action);
  return encodeManageNeuron({
    subaccount: normalizeNeuronId(params.neuronId),
    command: [
      {
        MakeProposal: {
          title: params.title,
          summary: params.summary,
          url: params.url,
          action: [params.action],
        },
      },
    ],
  });
}

/**
 * `ManageVotingPermission`: lets its holder grant and revoke *voting*
 * permissions only. It is the one permission that lets this app finish its own
 * setup — see `encodeAddVotingPermissions`.
 */
export const PERMISSION_MANAGE_VOTING = 10;

/**
 * Grant `SubmitProposal` and `Vote` to a principal on one neuron.
 *
 * This app cannot bootstrap itself onto a neuron it has no permission on: the
 * SNS requires the caller to already hold `ManagePrincipals (2)` or
 * `ManageVotingPermission (10)` there, so the first grant is always the
 * owner's, made in a wallet that controls the neuron.
 *
 * What it *can* do is finish a partial grant. A neuron that gave us
 * `ManageVotingPermission` but not `Vote` is one call away from working, and
 * that call is legal for us: when every permission being granted is a voting
 * permission, `ManageVotingPermission` alone authorises it.
 */
export function encodeAddVotingPermissions(params: {
  neuronId: string | Uint8Array;
  principal: string;
}): Uint8Array {
  return encodeManageNeuron({
    subaccount: normalizeNeuronId(params.neuronId),
    command: [
      {
        AddNeuronPermissions: {
          // Both fields are `opt` in Candid but mandatory in practice: the
          // canister rejects either being absent.
          principal_id: [Principal.fromText(params.principal)],
          permissions_to_add: [{ permissions: Int32Array.from(REQUIRED_PERMISSIONS) }],
        },
      },
    ],
  });
}

/** An `ExecuteGenericNervousSystemFunction` action for a custom proposal. */
export function executeGenericAction(functionId: bigint, payload: Uint8Array): unknown {
  return { ExecuteGenericNervousSystemFunction: { function_id: functionId, payload } };
}

/** A `Motion` action. */
export function motionAction(motionText: string): unknown {
  return { Motion: { motion_text: motionText } };
}

export interface ManageNeuronOutcome {
  ok: boolean;
  /** Present on failure. */
  errorType?: number;
  errorMessage?: string;
  /** The decoded command variant name on success, e.g. "RegisterVote". */
  command?: string;
  /** The new proposal's id, when the command was `MakeProposal`. */
  proposalId?: bigint;
  /** Exact typed reply, including command-specific accounting and receipts. */
  response?: ManageNeuronResponse;
  /** Lossless natural JSON; all integers are decimal strings. */
  responseJson?: unknown;
  commandData?: unknown;
  rawReplyHex?: string;
  /** Split child or ClaimOrRefresh neuron identifier, as 64 hex characters. */
  neuronId?: string;
  transferBlockHeight?: bigint;
  maturityE8s?: bigint;
  stakedMaturityE8s?: bigint;
  amountDisbursedE8s?: bigint;
  amountDeductedE8s?: bigint;
  mergedMaturityE8s?: bigint;
  newStakeE8s?: bigint;
}

/**
 * Decode a `ManageNeuronResponse`.
 *
 * We decode this ourselves rather than using a library helper, because the
 * reference implementation's error assertion discards `error_type` — and we
 * need it to recognise the double-vote case.
 */
export function decodeManageNeuronResponse(reply: Uint8Array): ManageNeuronOutcome {
  const decoded = IDL.decode([manageNeuronTypes().ret], reply)[0] as unknown as ManageNeuronResponse;
  const evidence = {
    response: decoded,
    responseJson: candidValueToJson(manageNeuronTypes().ret, decoded),
    rawReplyHex: toHex(reply),
  };
  const command = decoded.command?.[0] as Record<string, unknown> | undefined;
  if (!command) return { ok: false, errorMessage: "empty response", ...evidence };
  const key = Object.keys(command)[0];
  if (key === "Error") {
    const error = command.Error as { error_type?: number; error_message?: string };
    const out: ManageNeuronOutcome = { ok: false, ...evidence, commandData: command.Error };
    if (error.error_type !== undefined) out.errorType = Number(error.error_type);
    if (error.error_message !== undefined) out.errorMessage = error.error_message;
    return out;
  }
  if (key === undefined) return { ok: false, errorMessage: "empty command", ...evidence };
  const data = command[key] as Record<string, unknown>;
  const out: ManageNeuronOutcome = { ok: true, command: key, commandData: data, ...evidence };
  // A submission's whole point is the id it produced, and it is the only place
  // the caller can learn it.
  if (key === "MakeProposal") {
    const made = command.MakeProposal as { proposal_id?: [] | [{ id: bigint }] };
    const id = made?.proposal_id?.[0]?.id;
    if (id !== undefined) out.proposalId = id;
  }
  if (key === "Split" || key === "ClaimOrRefresh") {
    const id = data[key === "Split" ? "created_neuron_id" : "refreshed_neuron_id"] as [] | [{ id: Uint8Array | number[] }] | undefined;
    if (id?.[0]) out.neuronId = toHex(id[0].id);
  }
  const accountFields = {
    transfer_block_height: "transferBlockHeight",
    maturity_e8s: "maturityE8s",
    staked_maturity_e8s: "stakedMaturityE8s",
    amount_disbursed_e8s: "amountDisbursedE8s",
    merged_maturity_e8s: "mergedMaturityE8s",
    new_stake_e8s: "newStakeE8s",
  } as const;
  for (const [field, property] of Object.entries(accountFields)) {
    if (typeof data[field] === "bigint") out[property] = data[field];
  }
  const deducted = data.amount_deducted_e8s as [] | [bigint] | undefined;
  if (deducted?.[0] !== undefined) out.amountDeductedE8s = deducted[0];
  return out;
}

/** `ErrorType::PreconditionFailed`. */
export const ERROR_PRECONDITION_FAILED = 10;

/**
 * A repeat vote is success, not failure.
 *
 * There is no dedicated "already voted" error type — the enum stops at 18, and
 * governance returns `PreconditionFailed` with a message. String matching is
 * the only option. Treating it as failure would make bulk voting look broken
 * every time following is configured, because follow cascades routinely fill a
 * ballot before our call lands.
 */
export function isAlreadyVoted(outcome: ManageNeuronOutcome): boolean {
  if (outcome.ok) return false;
  if (outcome.errorType !== undefined && outcome.errorType !== ERROR_PRECONDITION_FAILED) return false;
  return /already voted/i.test(outcome.errorMessage ?? "");
}

function normalizeNeuronId(neuronId: string | Uint8Array): Uint8Array {
  const bytes = typeof neuronId === "string" ? fromHex(neuronId) : neuronId;
  if (bytes.length !== 32) {
    throw new RangeError(`neuron id must be 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}
