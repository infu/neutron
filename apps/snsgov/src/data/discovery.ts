/**
 * SNS discovery.
 *
 * SNS-W is the authority for which SNSes exist: one `list_deployed_snses` query
 * returns every registered SNS in about 800 ms. It is *not* an authority for
 * which SNSes work — 16 of 54 registered entries have no governance Wasm
 * installed and reject every call with IC0537. Those are aborted or wound-down
 * launches, and liveness has to be probed separately, per canister.
 */

import { actorFor, type AgentOptions } from "./agent";
import { classifyError, isInactive, SnsError } from "./errors";
import { SNS_WASM_CANISTER_ID } from "./ids";
import { opt } from "./opt";
import { idlFactory as snsWasmIdl } from "../candid/sns_wasm.did.js";
import { idlFactory as governanceIdl } from "../candid/sns_governance.did.js";
import { idlFactory as ledgerIdl } from "../candid/icrc_ledger.did.js";
import type { SnsCanisterIds, SnsLiveness } from "./types";

interface DeployedSns {
  root_canister_id: [] | [{ toText(): string }];
  governance_canister_id: [] | [{ toText(): string }];
  ledger_canister_id: [] | [{ toText(): string }];
  swap_canister_id: [] | [{ toText(): string }];
  index_canister_id: [] | [{ toText(): string }];
}

interface SnsWasmService {
  list_deployed_snses: (arg: Record<string, never>) => Promise<{ instances: DeployedSns[] }>;
}

/**
 * Every SNS registered with SNS-W, live or not.
 *
 * Entries missing a root or governance id are dropped: they cannot be
 * addressed, so they are not SNSes we can show anything about.
 */
export async function listDeployedSnses(options: AgentOptions = {}): Promise<SnsCanisterIds[]> {
  const actor = await actorFor<SnsWasmService>(snsWasmIdl, SNS_WASM_CANISTER_ID, options);
  let response: { instances: DeployedSns[] };
  try {
    response = await actor.list_deployed_snses({});
  } catch (error) {
    throw classifyError(error, { role: "registry" });
  }

  const out: SnsCanisterIds[] = [];
  for (const instance of response.instances) {
    const root = opt(instance.root_canister_id)?.toText();
    const governance = opt(instance.governance_canister_id)?.toText();
    const ledger = opt(instance.ledger_canister_id)?.toText();
    if (!root || !governance || !ledger) continue;
    out.push({
      root,
      governance,
      ledger,
      swap: opt(instance.swap_canister_id)?.toText() ?? null,
      index: opt(instance.index_canister_id)?.toText() ?? null,
    });
  }
  return out;
}

interface GovernanceLivenessService {
  get_mode: (arg: Record<string, never>) => Promise<{ mode: [] | [number] }>;
}
interface LedgerLivenessService {
  icrc1_symbol: () => Promise<string>;
}

/**
 * Probe one SNS's governance and ledger independently.
 *
 * Both probes are the cheapest query each canister offers. A dead canister is a
 * normal, expected state here — never an exception that should abort a page.
 */
export async function probeLiveness(
  canisters: SnsCanisterIds,
  options: AgentOptions = {},
): Promise<SnsLiveness> {
  const [governance, ledger] = await Promise.all([
    probe(async () => {
      const actor = await actorFor<GovernanceLivenessService>(
        governanceIdl,
        canisters.governance,
        options,
      );
      await actor.get_mode({});
    }, canisters.root, "governance"),
    probe(async () => {
      const actor = await actorFor<LedgerLivenessService>(ledgerIdl, canisters.ledger, options);
      await actor.icrc1_symbol();
    }, canisters.root, "ledger"),
  ]);

  const notes = [governance.note, ledger.note].filter(Boolean);
  return {
    governance: governance.alive,
    ledger: ledger.alive,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}

/**
 * How long a canister gets to answer the cheapest query it has.
 *
 * A deployed-but-empty canister does not refuse quickly: the agent retries and
 * backs off, and measured against mainnet the slowest probes took 42-52
 * seconds. That is what made the list take twenty seconds to appear — the
 * whole build waited on a handful of dead SNSes. A live canister answers a
 * query in well under a second, so anything past this budget is treated as
 * unreachable for the purposes of the list. The SNS is not hidden: it moves to
 * the "show all" filter, and its own page still reads it properly.
 */
const PROBE_TIMEOUT_MS = 4_000;

async function probe(
  run: () => Promise<void>,
  sns: string,
  role: "governance" | "ledger",
): Promise<{ alive: boolean; note?: string }> {
  try {
    await withTimeout(run(), PROBE_TIMEOUT_MS, `${role} did not answer in ${PROBE_TIMEOUT_MS}ms`);
    return { alive: true };
  } catch (error) {
    if (error instanceof ProbeTimeout) {
      return { alive: false, note: `${role}: no answer in ${PROBE_TIMEOUT_MS}ms` };
    }
    const classified = classifyError(error, { sns, role });
    if (isInactive(classified)) return { alive: false, note: `${role}: ${classified.message}` };
    // A transient failure is not evidence of death. Report it as unknown-but-
    // failing rather than marking a live SNS dead and hiding it from the user.
    return { alive: false, note: `${role}: ${classified.code}` };
  }
}

/** Probe a batch with bounded concurrency, never failing the batch as a whole. */
export async function probeAll(
  entries: SnsCanisterIds[],
  options: AgentOptions & { concurrency?: number } = {},
): Promise<Map<string, SnsLiveness>> {
  const concurrency = options.concurrency ?? 6;
  const results = new Map<string, SnsLiveness>();
  for (let index = 0; index < entries.length; index += concurrency) {
    const slice = entries.slice(index, index + concurrency);
    const probed = await Promise.all(slice.map((entry) => probeLiveness(entry, options)));
    slice.forEach((entry, offset) => {
      results.set(entry.root, probed[offset] as SnsLiveness);
    });
  }
  return results;
}

/** Look up one SNS's canister set by root id. */
export async function findSns(
  rootCanisterId: string,
  options: AgentOptions = {},
): Promise<SnsCanisterIds> {
  const all = await listDeployedSnses(options);
  const found = all.find((entry) => entry.root === rootCanisterId);
  if (!found) {
    throw new SnsError("SNS_NOT_FOUND", `no SNS registered with root ${rootCanisterId}`, {
      sns: rootCanisterId,
      retryable: false,
    });
  }
  return found;
}


class ProbeTimeout extends Error {}

/**
 * Bound a probe.
 *
 * The underlying call keeps running — the agent owns its own retry schedule and
 * there is no cancellation to hand it — but nothing waits on it, so one dead
 * canister costs this build its own timeout and nothing more.
 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeout(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}
