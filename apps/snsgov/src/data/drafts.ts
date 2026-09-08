/**
 * Proposal drafts: read, send, discard.
 *
 * An agent can write a draft but has no way to submit one — there is no submit
 * tool on the bus, by design. Sending is a person's act, and this module is the
 * only path to it. It lives outside the UI so the encoding, which is the part
 * that can be wrong in ways nobody notices until a proposal is live, is
 * testable on its own.
 *
 * Self-call API 1 conventions apply throughout: Nat/Nat64 arrive as decimal
 * strings, blobs as bytes, and an absent option as `null` or a missing key —
 * never `[]`.
 */

import { querySelf, updateSelf } from "neutron-tools/app";
import { SnsError } from "./errors";
import {
  decodeManageNeuronResponse,
  encodeMakeProposal,
  executeGenericAction,
  motionAction,
  PERMISSION_SUBMIT_PROPOSAL,
} from "./manage_neuron";
import { relayManageNeuron } from "./relay";

export interface DraftRow {
  id: string;
  sns: string;
  governance: string;
  title: string;
  summary: string;
  url: string;
  actionKind: string;
  /** The action's bytes, read according to `actionKind`. */
  payload?: Uint8Array;
  functionId?: bigint;
  /** The DAO validator's rendering, when one was captured. */
  rendering?: string;
  proposer?: Uint8Array;
  createdBy: string;
  updatedAtSeconds: bigint;
  /** Decoded from `payload` for a Motion — the motion itself. */
  motionText?: string;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toText?: () => string }).toText === "function") {
    return (value as { toText: () => string }).toText();
  }
  return String(value);
}

function bytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return undefined;
}

function toDraft(row: Record<string, unknown>): DraftRow {
  const payload = bytes(row.payload);
  const actionKind = String(row.action_kind ?? "Motion");
  const draft: DraftRow = {
    id: String(row.id),
    sns: text(row.sns),
    governance: text(row.governance),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    url: String(row.url ?? ""),
    actionKind,
    createdBy: String(row.created_by ?? ""),
    updatedAtSeconds: BigInt(String(row.updated_at_seconds ?? "0")),
  };
  if (payload) draft.payload = payload;
  if (row.function_id !== undefined && row.function_id !== null) {
    draft.functionId = BigInt(String(row.function_id));
  }
  if (typeof row.rendering === "string") draft.rendering = row.rendering;
  const proposer = bytes(row.proposer);
  if (proposer) draft.proposer = proposer;
  if (actionKind === "Motion" && payload) {
    draft.motionText = new TextDecoder().decode(payload);
  }
  return draft;
}

/** Every draft awaiting review, newest first. */
export async function listDrafts(): Promise<DraftRow[]> {
  const rows = (await querySelf("snsgov_drafts", [null])) as unknown as Record<
    string,
    unknown
  >[];
  return rows
    .map(toDraft)
    .sort((a, b) => (b.updatedAtSeconds > a.updatedAtSeconds ? 1 : -1));
}

export async function deleteDraft(id: string): Promise<void> {
  // Nat travels as a decimal string.
  await updateSelf("snsgov_draft_delete", [id]);
}

/**
 * The exact `manage_neuron` argument this draft will be submitted as.
 *
 * Separated from sending so it can be asserted against the SNS's own decoder
 * without putting anything on-chain.
 */
export function buildProposalArgs(draft: DraftRow, neuronId: string | Uint8Array): Uint8Array {
  if (!draft.title.trim()) {
    throw new SnsError("INVALID_REQUEST", "a proposal needs a title", { retryable: false });
  }

  let action: unknown;
  if (draft.actionKind === "Motion") {
    const motion = draft.motionText ?? "";
    if (!motion.trim()) {
      throw new SnsError(
        "INVALID_REQUEST",
        "this Motion draft has no motion text, so there is nothing to propose",
        { sns: draft.sns, retryable: false },
      );
    }
    action = motionAction(motion);
  } else {
    if (draft.functionId === undefined || !draft.payload) {
      throw new SnsError(
        "INVALID_REQUEST",
        `a ${draft.actionKind} draft needs both a function id and a payload`,
        { sns: draft.sns, retryable: false },
      );
    }
    action = executeGenericAction(draft.functionId, draft.payload);
  }

  return encodeMakeProposal({
    neuronId,
    title: draft.title,
    summary: draft.summary,
    url: draft.url,
    action,
  });
}

export interface SendResult {
  proposalId?: bigint;
  /** The command the canister reported executing, e.g. "MakeProposal". */
  command?: string;
  /** Submission succeeded, but the saved draft could not be removed. */
  cleanupWarning?: string;
}

/**
 * Submit a draft, then discard it.
 *
 * The draft is deleted only after the canister confirms, and a failure to
 * delete is swallowed: the proposal is already live, and reporting a cleanup
 * problem as a submission failure would invite a duplicate submission.
 */
export async function sendDraft(
  draft: DraftRow,
  neuronId: string | Uint8Array,
): Promise<SendResult> {
  const args = buildProposalArgs(draft, neuronId);
  const outcome = await relayManageNeuron({
    snsRootCanisterId: draft.sns,
    args,
    kind: "proposal",
  });
  if (!outcome.ok) {
    throw new SnsError("INVALID_REQUEST", outcome.errorMessage ?? "the SNS rejected the proposal", {
      sns: draft.sns,
      retryable: false,
    });
  }

  let cleanupWarning: string | undefined;
  try {
    await deleteDraft(draft.id);
  } catch {
    cleanupWarning = "The proposal was submitted, but its saved draft could not be removed. Do not send this draft again; remove it from Drafts after checking the proposal.";
  }

  return {
    ...(outcome.proposalId === undefined ? {} : { proposalId: outcome.proposalId }),
    ...(outcome.command === undefined ? {} : { command: outcome.command }),
    ...(cleanupWarning === undefined ? {} : { cleanupWarning }),
  };
}

/** Neurons on this SNS whose permissions let our principal propose. */
export function canPropose(missing: number[]): boolean {
  return !missing.includes(PERMISSION_SUBMIT_PROPOSAL);
}

export { decodeManageNeuronResponse };
