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
 * `ManagePrincipals` or `ManageVotingPermission` but not the voting permissions
 * themselves. Either permits repair when the requested permissions are in the
 * SNS's current grantable permission list.
 */

import { listAllNeurons, readParameters } from "./governance";
import { classifyError } from "./errors";
import type { NeuronSummary, PartialResult } from "./types";
import {
  PERMISSION_MANAGE_VOTING,
  PERMISSION_SUBMIT_PROPOSAL,
  PERMISSION_VOTE,
} from "./manage_neuron";
import type { AgentOptions } from "./agent";

export type NeuronReadiness =
  /** Holds `Vote` and `SubmitProposal`. Nothing to do. */
  | "ready"
  /** Can grant the missing voting permissions under the SNS's current rules. */
  | "repairable"
  /** Holds something, but not enough, and not enough to fix. Owner must act. */
  | "partial";

export interface NeuronRegistration {
  neuronId: string;
  readiness: NeuronReadiness;
  /** Which of the two required permissions are missing. */
  missing: number[];
  held?: number[];
  grantableMissing?: number[];
}

export interface RegistrationStatus {
  /** Neurons on this SNS that name our principal at all. */
  found: NeuronRegistration[];
  ready: number;
  /** Neurons we can finish ourselves, in one signed call each. */
  repairable: NeuronRegistration[];
  /** Neurons only the owner can fix, in a wallet that controls them. */
  blocked: NeuronRegistration[];
  /** True when exhaustive discovery failed before all neurons could be read. */
  truncated: boolean;
  failures?: PartialResult<never>["failures"];
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
export function classify(neuron: NeuronSummary, principal: string, grantablePermissions?: readonly number[]): NeuronRegistration {
  const held = new Set(permissionsFor(neuron, principal));
  const missing = [PERMISSION_SUBMIT_PROPOSAL, PERMISSION_VOTE].filter(
    (value) => !held.has(value),
  );
  const grantableMissing = missing.filter((permission) => grantablePermissions === undefined || grantablePermissions.includes(permission));
  const canManage = held.has(2) || held.has(PERMISSION_MANAGE_VOTING);
  const readiness: NeuronReadiness = missing.length === 0 ? "ready"
    : canManage && grantableMissing.length === missing.length ? "repairable" : "partial";
  return { neuronId: neuron.id, readiness, missing, held: [...held], grantableMissing };
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
  const [discovery, parameters] = await Promise.all([
    listAllNeurons(governanceCanisterId, { ofPrincipal: hotkeyPrincipal }, options),
    readParameters(governanceCanisterId, options).then((value) => ({ value, failure: null }), (error: unknown) => ({ value: null, failure: classifyError(error) })),
  ]);
  const failures = [...discovery.failures];
  if (parameters.failure) failures.push({ scope: governanceCanisterId, code: parameters.failure.code, message: `Permission parameters: ${parameters.failure.message}` });
  else if (parameters.value?.neuronGrantablePermissions === undefined) failures.push({ scope: governanceCanisterId, code: "INTERNAL", message: "SNS did not return its grantable permissions; permission repair cannot be confirmed." });
  const found = discovery.neurons.map((neuron) => classify(neuron, hotkeyPrincipal, parameters.value?.neuronGrantablePermissions ?? []));
  return {
    found,
    ready: found.filter((entry) => entry.readiness === "ready").length,
    repairable: found.filter((entry) => entry.readiness === "repairable"),
    blocked: found.filter((entry) => entry.readiness === "partial"),
    truncated: discovery.truncated,
    failures,
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
    return status.truncated || status.failures?.length
      ? "Neuron discovery is incomplete. Retry the failed reads before concluding there are no neurons."
      : "No neurons here name your voting principal yet — add it as a hotkey to get started.";
  }
  const noun = found === 1 ? "neuron" : "neurons";
  const head = `${found} ${noun} found${status.truncated ? " (incomplete scan)" : ""} · ${status.ready} ready`;
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
 * Partial source failures are returned alongside discoveries so unavailable
 * communities are not mistaken for communities without any matching neurons.
 */
export type NeuronScan = DiscoveredSns[] & { failures: PartialResult<never>["failures"] };

/** Legacy array shape with visible partial failure evidence. Prefer the detailed envelope for tools. */
export async function scanForNeurons(
  snses: { rootCanisterId: string; governanceCanisterId: string; label: string }[],
  hotkeyPrincipal: string,
  options: AgentOptions = {},
): Promise<NeuronScan> {
  const result = await scanForNeuronsDetailed(snses, hotkeyPrincipal, options);
  return Object.assign(result.value, { failures: result.failures });
}

export async function scanForNeuronsDetailed(
  snses: { rootCanisterId: string; governanceCanisterId: string; label: string }[],
  hotkeyPrincipal: string,
  options: AgentOptions = {},
): Promise<PartialResult<DiscoveredSns[]>> {
  const found: DiscoveredSns[] = [];
  const failures: PartialResult<never>["failures"] = [];
  const concurrency = 8;
  for (let index = 0; index < snses.length; index += concurrency) {
    const slice = snses.slice(index, index + concurrency);
    const settled = await Promise.allSettled(slice.map(async (sns) => ({
      ...sns, status: await readRegistration(sns.governanceCanisterId, hotkeyPrincipal, options),
    })));
    settled.forEach((result, index) => {
      const sns = slice[index]!;
      if (result.status === "rejected") {
        const error = classifyError(result.reason);
        failures.push({ scope: sns.rootCanisterId, code: error.code, message: error.message });
        return;
      }
      for (const failure of result.value.status.failures ?? []) failures.push({ ...failure, scope: sns.rootCanisterId });
      if (result.value.status.found.length > 0) found.push(result.value);
    });
  }
  return { value: found, failures };
}
