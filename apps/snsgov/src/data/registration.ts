/**
 * How ready one SNS is for this app to act on the owner's behalf.
 *
 * Registering a hotkey has two halves, and only one of them is ours:
 *
 *   on-chain  the owner grants our principal `Vote` and `SubmitProposal` on a
 *             neuron. We cannot do this for a neuron that has given us nothing
 *             — the SNS requires the caller to already hold `ManagePrincipals`
 *             or `ManageVotingPermission` there.
 *   in-app    the SNS goes on the owner-approved allowlist so the backend will
 *             sign for it. That half is entirely ours, and used to be buried in
 *             a separate Setup screen.
 *
 * There is also a middle case worth catching: a neuron that granted us
 * `ManageVotingPermission` but not the voting permissions themselves. That one
 * we *can* finish, because a grant consisting only of voting permissions is
 * authorised by `ManageVotingPermission` alone.
 */

import { listNeurons } from "./governance";
import type { NeuronSummary } from "./types";
import {
  PERMISSION_MANAGE_VOTING,
  PERMISSION_SUBMIT_PROPOSAL,
  PERMISSION_VOTE,
} from "./manage_neuron";
import type { AgentOptions } from "./agent";

export type NeuronReadiness =
  /** Holds `Vote` and `SubmitProposal`. Nothing to do. */
  | "ready"
  /** Holds `ManageVotingPermission`, so we can grant ourselves the rest. */
  | "repairable"
  /** Holds something, but not enough, and not enough to fix. Owner must act. */
  | "partial";

export interface NeuronRegistration {
  neuronId: string;
  readiness: NeuronReadiness;
  /** Which of the two required permissions are missing. */
  missing: number[];
}

export interface RegistrationStatus {
  /** Neurons on this SNS that name our principal at all. */
  found: NeuronRegistration[];
  ready: number;
  /** Neurons we can finish ourselves, in one signed call each. */
  repairable: NeuronRegistration[];
  /** Neurons only the owner can fix, in a wallet that controls them. */
  blocked: NeuronRegistration[];
  /** True when 100 neurons were returned and more may exist. */
  truncated: boolean;
}

function permissionsFor(neuron: NeuronSummary, principal: string): number[] {
  const held = new Set<number>();
  for (const entry of neuron.permissions) {
    if (entry.principal !== principal) continue;
    for (const value of entry.permissions) held.add(value);
  }
  return [...held];
}

/** Classify one neuron from the permissions it grants our principal. */
export function classify(neuron: NeuronSummary, principal: string): NeuronRegistration {
  const held = new Set(permissionsFor(neuron, principal));
  const missing = [PERMISSION_SUBMIT_PROPOSAL, PERMISSION_VOTE].filter(
    (value) => !held.has(value),
  );
  const readiness: NeuronReadiness =
    missing.length === 0 ? "ready" : held.has(PERMISSION_MANAGE_VOTING) ? "repairable" : "partial";
  return { neuronId: neuron.id, readiness, missing };
}

/**
 * What our principal can do on one SNS right now.
 *
 * `of_principal` matches any permission holder, so this returns exactly the
 * neurons the owner has pointed at us — no guessing, and no need to know which
 * principal controls them.
 */
export async function readRegistration(
  governanceCanisterId: string,
  hotkeyPrincipal: string,
  options: AgentOptions = {},
): Promise<RegistrationStatus> {
  const { neurons, truncated } = await listNeurons(
    governanceCanisterId,
    { ofPrincipal: hotkeyPrincipal, limit: 100 },
    options,
  );
  const found = neurons.map((neuron) => classify(neuron, hotkeyPrincipal));
  return {
    found,
    ready: found.filter((entry) => entry.readiness === "ready").length,
    repairable: found.filter((entry) => entry.readiness === "repairable"),
    blocked: found.filter((entry) => entry.readiness === "partial"),
    truncated,
  };
}

/** One-line summary for the button label and its tooltip. */
export function describeRegistration(
  status: RegistrationStatus | null,
  allowlisted: boolean,
): string {
  if (!status) return "Checking your neurons…";
  const found = status.found.length;
  if (found === 0) {
    return "No neurons here name your voting principal yet — add it as a hotkey to get started.";
  }
  const noun = found === 1 ? "neuron" : "neurons";
  const head = `${found} ${noun} found · ${status.ready} ready`;
  if (!allowlisted) return `${head} · click to allow voting for this SNS`;
  if (status.repairable.length > 0) {
    return `${head} · click to finish ${status.repairable.length} partial grant${
      status.repairable.length === 1 ? "" : "s"
    }`;
  }
  if (status.blocked.length > 0) {
    return `${head} · ${status.blocked.length} need a hotkey grant you must make yourself`;
  }
  return `${head} · voting enabled`;
}


/** One SNS that has neurons naming our principal. */
export interface DiscoveredSns {
  rootCanisterId: string;
  governanceCanisterId: string;
  label: string;
  status: RegistrationStatus;
}

/**
 * Find every SNS where the owner has already pointed a neuron at us.
 *
 * This is the fast path onto the allowlist. Picking SNSes one at a time out of
 * a dropdown asks the owner to remember which DAOs they hold neurons in; the
 * governance canisters already know, and asking all of them costs one anonymous
 * query each.
 *
 * A dead or unreachable governance canister is skipped rather than failing the
 * scan — one bad SNS must not hide the other fifty.
 */
export async function scanForNeurons(
  snses: { rootCanisterId: string; governanceCanisterId: string; label: string }[],
  hotkeyPrincipal: string,
  options: AgentOptions = {},
): Promise<DiscoveredSns[]> {
  const found: DiscoveredSns[] = [];
  const concurrency = 8;
  for (let index = 0; index < snses.length; index += concurrency) {
    const slice = snses.slice(index, index + concurrency);
    const settled = await Promise.all(
      slice.map(async (sns) => {
        try {
          const status = await readRegistration(sns.governanceCanisterId, hotkeyPrincipal, options);
          return status.found.length > 0 ? { ...sns, status } : null;
        } catch {
          return null;
        }
      }),
    );
    for (const entry of settled) if (entry) found.push(entry);
  }
  return found;
}
