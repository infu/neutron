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
import { idlFactory as governanceIdl } from "../candid/sns_governance.did.js";
import { fromHex } from "./format";

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

let cachedTypes: { arg: IDL.Type; ret: IDL.Type } | undefined;

function manageNeuronTypes(): { arg: IDL.Type; ret: IDL.Type } {
  if (cachedTypes) return cachedTypes;
  const service = governanceIdl({ IDL }) as unknown as {
    _fields: [string, { argTypes: IDL.Type[]; retTypes: IDL.Type[] }][];
  };
  const found = service._fields.find(([name]) => name === "manage_neuron");
  if (!found) throw new Error("manage_neuron is absent from the generated interface");
  const arg = found[1].argTypes[0];
  const ret = found[1].retTypes[0];
  if (!arg || !ret) throw new Error("manage_neuron has an unexpected shape");
  cachedTypes = { arg, ret };
  return cachedTypes;
}

/** Encode an arbitrary `ManageNeuron` value using the generated interface. */
export function encodeManageNeuron(value: unknown): Uint8Array {
  return new Uint8Array(IDL.encode([manageNeuronTypes().arg], [value]));
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
}

/**
 * Decode a `ManageNeuronResponse`.
 *
 * We decode this ourselves rather than using a library helper, because the
 * reference implementation's error assertion discards `error_type` — and we
 * need it to recognise the double-vote case.
 */
export function decodeManageNeuronResponse(reply: Uint8Array): ManageNeuronOutcome {
  const decoded = IDL.decode([manageNeuronTypes().ret], reply)[0] as {
    command?: [] | [Record<string, unknown>];
  };
  const command = decoded.command?.[0];
  if (!command) return { ok: false, errorMessage: "empty response" };
  const key = Object.keys(command)[0];
  if (key === "Error") {
    const error = command.Error as { error_type?: number; error_message?: string };
    const out: ManageNeuronOutcome = { ok: false };
    if (error.error_type !== undefined) out.errorType = Number(error.error_type);
    if (error.error_message !== undefined) out.errorMessage = error.error_message;
    return out;
  }
  const out: ManageNeuronOutcome = { ok: true, ...(key === undefined ? {} : { command: key }) };
  // A submission's whole point is the id it produced, and it is the only place
  // the caller can learn it.
  if (key === "MakeProposal") {
    const made = command.MakeProposal as { proposal_id?: [] | [{ id: bigint }] };
    const id = made?.proposal_id?.[0]?.id;
    if (id !== undefined) out.proposalId = id;
  }
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
