/**
 * The SNS's full canister inventory, and its cycles.
 *
 * Two methods with very different costs, so they are two functions and the
 * expensive one is never called for you:
 *
 *   `list_sns_canisters`        query. The whole inventory — the five system
 *                               canisters plus every registered dapp, ledger
 *                               archive, and extension. Free, safe on load.
 *   `get_sns_canisters_summary` UPDATE. The only method anywhere in the SNS
 *                               framework that returns cycles. It fans out
 *                               `5 + dapps + archives` calls to the management
 *                               canister on *every* invocation, with no
 *                               memoisation in root, and root pays. It cannot
 *                               be a query: reading a cycles balance means
 *                               calling the management canister, and queries
 *                               cannot make inter-canister calls.
 *
 * So: inventory on load, cycles only when a person or an agent asks, and the
 * result cached here because root caches nothing.
 */

import { actorFor, type AgentOptions } from "./agent";
import { idlFactory as rootIdl } from "../candid/sns_root.did.js";
import { classifyError } from "./errors";
import { opt } from "./opt";

/** What a canister is to this SNS. */
export type CanisterRole = "root" | "governance" | "ledger" | "swap" | "index" | "dapp" | "archive";

export interface SnsCanister {
  canisterId: string;
  role: CanisterRole;
}

export interface CanisterCycles {
  canisterId: string;
  role: CanisterRole;
  /** Raw cycles. Undefined when root could not reach the canister. */
  cycles?: bigint;
  /** "running" | "stopping" | "stopped", or undefined when unreachable. */
  status?: string;
  memorySize?: bigint;
  idleBurnPerDay?: bigint;
}

interface RootService {
  list_sns_canisters: (arg: Record<string, never>) => Promise<{
    root: [] | [{ toText(): string }];
    governance: [] | [{ toText(): string }];
    ledger: [] | [{ toText(): string }];
    swap: [] | [{ toText(): string }];
    index: [] | [{ toText(): string }];
    dapps: { toText(): string }[];
    archives: { toText(): string }[];
    extensions: [] | [{ extension_canister_ids: { toText(): string }[] }];
  }>;
  get_sns_canisters_summary: (arg: { update_canister_list: [] | [boolean] }) => Promise<{
    root: [] | [RawSummary];
    governance: [] | [RawSummary];
    ledger: [] | [RawSummary];
    swap: [] | [RawSummary];
    index: [] | [RawSummary];
    dapps: RawSummary[];
    archives: RawSummary[];
  }>;
}

interface RawSummary {
  canister_id: [] | [{ toText(): string }];
  status:
    | []
    | [
        {
          status: Record<string, null>;
          cycles: bigint;
          memory_size: bigint;
          idle_cycles_burned_per_day: bigint;
        },
      ];
}

async function root(canisterId: string, options: AgentOptions): Promise<RootService> {
  return actorFor<RootService>(rootIdl, canisterId, options);
}

/**
 * Every canister this SNS owns, system and dapp alike.
 *
 * Extensions are included: they are registered with root and count against the
 * same limit, even though `get_sns_canisters_summary` will never report their
 * cycles.
 */
export async function listSnsCanisters(
  rootCanisterId: string,
  options: AgentOptions = {},
): Promise<SnsCanister[]> {
  try {
    const raw = await (await root(rootCanisterId, options)).list_sns_canisters({});
    const out: SnsCanister[] = [];
    const add = (value: { toText(): string } | undefined, role: CanisterRole) => {
      if (value) out.push({ canisterId: value.toText(), role });
    };
    add(opt(raw.root), "root");
    add(opt(raw.governance), "governance");
    add(opt(raw.ledger), "ledger");
    add(opt(raw.index), "index");
    add(opt(raw.swap), "swap");
    for (const dapp of raw.dapps) out.push({ canisterId: dapp.toText(), role: "dapp" });
    for (const id of opt(raw.extensions)?.extension_canister_ids ?? []) {
      out.push({ canisterId: id.toText(), role: "dapp" });
    }
    for (const archive of raw.archives) out.push({ canisterId: archive.toText(), role: "archive" });
    return out;
  } catch (error) {
    throw classifyError(error, { role: "root" });
  }
}

/**
 * Cycles for every canister root knows about.
 *
 * An update call that costs the DAO real cycles each time, so callers must
 * treat it as a deliberate action. A `status` of `null` is the normal way root
 * reports "I could not reach this one" — a stopped, frozen, or cross-subnet
 * canister — and is surfaced as an unknown balance, not an error.
 */
export async function readCanistersCycles(
  rootCanisterId: string,
  options: AgentOptions = {},
): Promise<CanisterCycles[]> {
  try {
    const raw = await (await root(rootCanisterId, options)).get_sns_canisters_summary({
      // Governance-only; asking for it as anyone else is rejected.
      update_canister_list: [],
    });
    const out: CanisterCycles[] = [];
    const push = (summary: RawSummary | undefined, role: CanisterRole) => {
      if (!summary) return;
      const id = opt(summary.canister_id);
      if (!id) return;
      const entry: CanisterCycles = { canisterId: id.toText(), role };
      const status = opt(summary.status);
      if (status) {
        entry.cycles = status.cycles;
        entry.memorySize = status.memory_size;
        entry.idleBurnPerDay = status.idle_cycles_burned_per_day;
        const name = Object.keys(status.status)[0];
        if (name !== undefined) entry.status = name;
      }
      out.push(entry);
    };
    push(opt(raw.root), "root");
    push(opt(raw.governance), "governance");
    push(opt(raw.ledger), "ledger");
    push(opt(raw.index), "index");
    push(opt(raw.swap), "swap");
    for (const dapp of raw.dapps) push(dapp, "dapp");
    for (const archive of raw.archives) push(archive, "archive");
    return out;
  } catch (error) {
    throw classifyError(error, { role: "root" });
  }
}

const TRILLION = 1_000_000_000_000n;

/**
 * Cycles as TCycles, the unit every IC dashboard uses.
 *
 * Integer maths throughout: a balance routinely exceeds `Number.MAX_SAFE_INTEGER`
 * by three orders of magnitude, so dividing as a float loses real digits.
 */
export function formatTCycles(cycles: bigint, fractionDigits = 3): string {
  const negative = cycles < 0n;
  const magnitude = negative ? -cycles : cycles;
  const whole = magnitude / TRILLION;
  const scale = 10n ** BigInt(fractionDigits);
  const fraction = ((magnitude % TRILLION) * scale) / TRILLION;
  const fractionText = fraction.toString().padStart(fractionDigits, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fractionText.length > 0
    ? `${sign}${whole.toString()}.${fractionText}T`
    : `${sign}${whole.toString()}T`;
}
