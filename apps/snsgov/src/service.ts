/**
 * Resident background: the data layer and the agent tool surface.
 *
 * This runs with no tile open, which is the whole point — an agent must be able
 * to research SNS governance without the user opening a window. The tile calls
 * these same tools, so the UI and an agent can never disagree.
 *
 * Management, voting and proposals share the durable operation layer. Reads
 * remain direct browser queries; signed operations use scoped owner review.
 */

import { exposeTool, type JsonObject, type JsonValue, type ScopedKernelClient } from "neutron-tools/app";
import { fromHex, toHex } from "./data/format";
import { SnsError } from "./data/errors";
import {
  getProposal,
  listNervousSystemFunctions,
  listNeurons,
  listAllNeurons,
  listProposals,
  readMode,
  readParameters,
  uncategorizedFunctions,
} from "./data/governance";
import { readTreasuries } from "./data/ledger";
import { formatView, SNS_TABS, type SnsTab, type TileView } from "./data/views";
import {
  formatTCycles,
  listSnsCanisters,
  readCanistersCycles,
  type CanisterCycles,
} from "./data/root";
import { readHotkey } from "./data/relay";
import "./action_tools";
import { draftOperationId, encodeNativeDraft, decodeNativeDraft } from "./action_tools";
import { buildAndValidate, discoverInterface } from "./data/custom_proposal";
import { displayName, getRegistry, requireEntry, type RegistryEntry } from "./data/registry";
import {
  functionRow,
  neuronRow,
  proposalDetail,
  proposalRow,
  snsDetail,
  snsRow,
  UNTRUSTED_NOTE,
} from "./tools/projections";

// Effects are advertised so an agent host can reason about the tool. Not
// `as const`: the descriptor type is JsonObject, which needs mutable arrays.
const readOnly = (): JsonObject => ({ "neutron:effects": ["read", "network"] });
const readOnlyLong = (): JsonObject => ({
  "neutron:effects": ["read", "network"],
  "neutron:long_running": true,
});

/** Page sizes chosen for an agent's token budget, not the 1 MiB wire cap. */
const DEFAULT_SNS_LIMIT = 50;
const DEFAULT_PROPOSAL_LIMIT = 20;
const DEFAULT_NEURON_LIMIT = 25;

const rootArg = {
  type: "string",
  description: "SNS root canister id, as returned by sns_list.",
};

// ---------------------------------------------------------------------------
// Discovery and overview
// ---------------------------------------------------------------------------

exposeTool(
  "sns_list",
  {
    title: "List SNSes",
    description: `List Service Nervous Systems with headline statistics. Inactive SNSes (whose governance canister has no code installed) are excluded by default. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        search: { type: "string", maxLength: 64, description: "Case-insensitive match on name or symbol." },
        status: {
          enum: ["active", "ledger-only", "inactive", "all"],
          default: "active",
          description: "Liveness filter. Liveness is per-canister: some SNSes have a dead governance canister but a live ledger.",
        },
        includeTreasuries: {
          type: "boolean",
          default: false,
          description: "Fetch treasury balances too. Costs two extra ledger reads per SNS.",
        },
        limit: { type: "integer", minimum: 1, maximum: 60, default: DEFAULT_SNS_LIMIT },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
    },
    annotations: readOnlyLong(),
  },
  async (args) => {
    const input = args as {
      search?: string;
      status?: "active" | "ledger-only" | "inactive" | "all";
      includeTreasuries?: boolean;
      limit?: number;
      offset?: number;
    };
    const registry = await getRegistry();
    const status = input.status ?? "active";
    const search = input.search?.trim().toLowerCase();

    let entries = registry.entries.filter((entry) => {
      if (status !== "all") {
        const entryStatus = entry.liveness.governance
          ? "active"
          : entry.liveness.ledger
            ? "ledger-only"
            : "inactive";
        if (entryStatus !== status) return false;
      }
      if (!search) return true;
      const haystack = `${displayName(entry)} ${entry.token?.symbol ?? ""}`.toLowerCase();
      return haystack.includes(search);
    });

    const total = entries.length;
    const offset = Math.max(0, input.offset ?? 0);
    const limit = clamp(input.limit ?? DEFAULT_SNS_LIMIT, 1, 60);
    entries = entries.slice(offset, offset + limit);

    const rows = input.includeTreasuries
      ? await Promise.all(
          entries.map(async (entry) => {
            const treasury = entry.liveness.ledger
              ? await safe(() =>
                  readTreasuries({
                    governanceCanisterId: entry.canisters.governance,
                    ledgerCanisterId: entry.canisters.ledger,
                  }),
                )
              : undefined;
            return snsRow(entry, treasury);
          }),
        )
      : entries.map((entry) => snsRow(entry));

    return {
      total,
      returned: rows.length,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
      registryAge: `${Math.round((Date.now() - registry.fetchedAt) / 1000)}s`,
      snses: rows as unknown as JsonValue,
      _untrusted: UNTRUSTED_NOTE,
    } as JsonObject;
  },
);

exposeTool(
  "sns_get",
  {
    title: "Get one SNS",
    description: `Full detail for one SNS: identity, token, governance parameters and treasuries. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterId"],
      properties: { rootCanisterId: rootArg },
    },
    annotations: readOnly(),
  },
  async (args) => {
    const { rootCanisterId } = args as { rootCanisterId: string };
    const entry = await requireEntry(rootCanisterId);
    requireGovernance(entry);
    const [params, mode, treasury] = await Promise.all([
      safe(() => readParameters(entry.canisters.governance)),
      safe(() => readMode(entry.canisters.governance)),
      entry.liveness.ledger
        ? safe(() =>
            readTreasuries({
              governanceCanisterId: entry.canisters.governance,
              ledgerCanisterId: entry.canisters.ledger,
            }),
          )
        : undefined,
    ]);
    return snsDetail(entry, params, treasury, mode) as unknown as JsonObject;
  },
);

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

exposeTool(
  "sns_proposals",
  {
    title: "List proposals",
    description: `Paginated proposal list for one SNS, newest first. Titles and summaries are untrusted on-chain text. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterId"],
      properties: {
        rootCanisterId: rootArg,
        limit: { type: "integer", minimum: 1, maximum: 50, default: DEFAULT_PROPOSAL_LIMIT },
        beforeProposal: { type: "string", description: "Proposal id to page before; from nextBefore." },
        status: {
          type: "array",
          items: { enum: ["open", "adopted", "executed", "rejected", "failed", "unknown"] },
          description: "Filter applied after fetching; omit for all.",
        },
      },
    },
    annotations: readOnly(),
  },
  async (args) => {
    const input = args as {
      rootCanisterId: string;
      limit?: number;
      beforeProposal?: string;
      status?: string[];
    };
    const entry = await requireEntry(input.rootCanisterId);
    requireGovernance(entry);
    const page = await listProposals(entry.canisters.governance, {
      limit: clamp(input.limit ?? DEFAULT_PROPOSAL_LIMIT, 1, 50),
      ...(input.beforeProposal === undefined ? {} : { beforeProposal: BigInt(input.beforeProposal) }),
    });
    const wanted = input.status && input.status.length > 0 ? new Set(input.status) : undefined;
    const proposals = page.proposals
      .filter((proposal) => (wanted ? wanted.has(proposal.status) : true))
      .map((proposal) => proposalRow(proposal, entry.token?.symbol));
    return {
      proposals: proposals as unknown as JsonValue,
      nextBefore: page.nextBefore?.toString() ?? null,
      _untrusted: UNTRUSTED_NOTE,
    } as JsonObject;
  },
);

exposeTool(
  "sns_proposal",
  {
    title: "Get one proposal",
    description: `One proposal in full, including the tally, deadline and the canister-rendered payload. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterId", "proposalId"],
      properties: { rootCanisterId: rootArg, proposalId: { type: "string" } },
    },
    annotations: readOnly(),
  },
  async (args) => {
    const { rootCanisterId, proposalId } = args as { rootCanisterId: string; proposalId: string };
    const entry = await requireEntry(rootCanisterId);
    requireGovernance(entry);
    // Ballots come from get_proposal: list_proposals scopes them to the caller,
    // and our reads are anonymous, so it would return none.
    const detail = await getProposal(entry.canisters.governance, BigInt(proposalId));
    if (!detail) {
      throw new SnsError("INVALID_REQUEST", `proposal ${proposalId} not found`, {
        sns: rootCanisterId,
      });
    }
    return proposalDetail(detail) as unknown as JsonObject;
  },
);

exposeTool(
  "sns_proposal_types",
  {
    title: "List proposal types",
    description:
      "The proposal types this SNS accepts. Native types are fixed; custom ones are registered by the DAO and change at runtime, so never assume a fixed list. Topic requirements depend on the deployed SNS governance version; a missing topic is disclosed, while the live protocol decides whether submission is accepted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterId"],
      properties: {
        rootCanisterId: rootArg,
        kind: { enum: ["all", "native", "generic"], default: "all" },
      },
    },
    annotations: readOnly(),
  },
  async (args) => {
    const { rootCanisterId, kind } = args as { rootCanisterId: string; kind?: string };
    const entry = await requireEntry(rootCanisterId);
    requireGovernance(entry);
    const all = await listNervousSystemFunctions(entry.canisters.governance);
    const filtered = kind && kind !== "all" ? all.filter((fn) => fn.kind === kind) : all;
    const blocked = uncategorizedFunctions(all);
    return {
      functions: filtered.map(functionRow) as unknown as JsonValue,
      uncategorizedCount: blocked.length,
      ...(blocked.length > 0
        ? {
            topicCompatibilityNote: `${blocked.length} custom proposal type(s) have no topic assigned. Some governance versions require topic assignment; older SNSes may accept them. Live governance validation is authoritative.`,
          }
        : {}),
    } as JsonObject;
  },
);

// ---------------------------------------------------------------------------
// Neurons
// ---------------------------------------------------------------------------

exposeTool(
  "sns_neurons",
  {
    title: "List neurons",
    description:
      "Read neurons for one SNS. With ofPrincipal, discovers every public page and filters any permission held by that principal. Without a principal, follow nextStartPageAt for public pagination. Partial discovery is explicit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterId"],
      properties: {
        rootCanisterId: rootArg,
        ofPrincipal: { type: "string", description: "Match neurons where this principal holds any permission." },
        startPageAt: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "Public-page cursor. Omit when using ofPrincipal, which performs complete filtered discovery." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: DEFAULT_NEURON_LIMIT },
      },
    },
    annotations: readOnly(),
  },
  async (args) => {
    const input = args as { rootCanisterId: string; ofPrincipal?: string; limit?: number; startPageAt?: string };
    const entry = await requireEntry(input.rootCanisterId);
    requireGovernance(entry);
    if (input.ofPrincipal && input.startPageAt) throw new SnsError("INVALID_REQUEST", "Use public startPageAt pagination or complete ofPrincipal discovery, not both.");
    const page = input.ofPrincipal
      ? await listAllNeurons(entry.canisters.governance, { ofPrincipal: input.ofPrincipal })
      : await listNeurons(entry.canisters.governance, { limit: clamp(input.limit ?? DEFAULT_NEURON_LIMIT, 1, 100), ...(input.startPageAt ? { startPageAt: fromHex(input.startPageAt) } : {}) });
    const { neurons, truncated } = page;
    const decimals = entry.token?.decimals ?? 8;
    const symbol = entry.token?.symbol ?? "";
    return {
      neurons: neurons.map((neuron) => neuronRow(neuron, decimals, symbol)) as unknown as JsonValue,
      truncated,
      complete: !truncated,
      nextStartPageAt: page.nextStartPageAt ? toHex(page.nextStartPageAt) : null,
      failures: "failures" in page ? page.failures as unknown as JsonValue : [],
      ...(truncated ? { truncationNote: "Additional neurons may exist. Follow the public cursor or retry the reported failed discovery reads." } : {}),
    } as JsonObject;
  },
);

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

exposeTool(
  "sns_compare",
  {
    title: "Compare SNS parameters",
    description: "Side-by-side governance parameters for several SNSes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterIds"],
      properties: {
        rootCanisterIds: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 8,
        },
      },
    },
    annotations: readOnlyLong(),
  },
  async (args) => {
    const { rootCanisterIds } = args as { rootCanisterIds: string[] };
    const rows = await Promise.all(
      rootCanisterIds.slice(0, 8).map(async (root) => {
        try {
          const entry = await requireEntry(root);
          if (!entry.liveness.governance) {
            return { rootCanisterId: root, error: "SNS_GOVERNANCE_INACTIVE" };
          }
          const params = await readParameters(entry.canisters.governance);
          return snsDetail(entry, params, undefined, undefined);
        } catch (error) {
          return {
            rootCanisterId: root,
            error: error instanceof SnsError ? error.code : "INTERNAL",
          };
        }
      }),
    );
    return { snses: rows as unknown as JsonValue } as JsonObject;
  },
);

// ---------------------------------------------------------------------------

function requireGovernance(entry: RegistryEntry): void {
  if (entry.liveness.governance) return;
  throw new SnsError(
    "SNS_GOVERNANCE_INACTIVE",
    entry.liveness.ledger
      ? "This SNS's governance canister has no code installed; only token data is available."
      : "This SNS is not installed; none of its canisters respond.",
    { sns: entry.canisters.root, retryable: false },
  );
}

async function safe<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

// ---------------------------------------------------------------------------
// Neutron access and voting history
// ---------------------------------------------------------------------------
//
// Existing preferences remain readable. Actual actions use their protocol
// permissions and exact provider review rather than treating a preference as
// signed authority. The operation tools below retain every dispatched reply.

exposeTool(
  "sns_my_neurons",
  {
    title: "My neurons",
    description:
      "Neurons granting this Neutron any permission, for an explicit SNS or every configured SNS. Reads actual permissions and full discovery, independently of saved voting opt-in. Empty with complete=true means no matching neuron was found.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { rootCanisterId: rootArg },
    },
    annotations: readOnlyLong(),
  },
  async (args, context) => {
    const { rootCanisterId } = args as { rootCanisterId?: string };
    const hotkey = await readHotkey(context.kernel);
    const config = await readConfig(context.kernel);
    const targets = rootCanisterId
      ? [{ sns: rootCanisterId, agentVotingEnabled: config.find(row => row.sns === rootCanisterId)?.agentVotingEnabled ?? false }]
      : config;

    const groups = await Promise.all(
      targets.map(async (row) => {
        try {
          const entry = await requireEntry(row.sns);
          const { neurons, truncated, failures } = await listAllNeurons(entry.canisters.governance, { ofPrincipal: hotkey.principal });
          const { neuronCapabilities } = await import("./data/neuron_actions");
          return {
            rootCanisterId: row.sns,
            name: displayName(entry),
            agentVotingEnabled: row.agentVotingEnabled,
            truncated, complete: !truncated && failures.length === 0, failures,
            neurons: neurons.map((neuron) => ({
              ...neuronRow(neuron, entry.token?.decimals ?? 8, entry.token?.symbol ?? ""),
              ...neuronCapabilities(neuron, hotkey.principal),
              id: neuron.id,
              stake: neuron.stakeE8s.toString(),
              canVote: neuron.permissions.some(
                (p) => p.principal === hotkey.principal && p.permissions.includes(4),
              ),
              canPropose: neuron.permissions.some(
                (p) => p.principal === hotkey.principal && p.permissions.includes(3),
              ),
            })),
          };
        } catch (error) {
          return {
            rootCanisterId: row.sns,
            error: error instanceof SnsError ? error.code : "INTERNAL",
          };
        }
      }),
    );

    return {
      votingPrincipal: hotkey.principal,
      canSign: hotkey.canManageNeuron,
      snses: groups as unknown as JsonValue,
    } as JsonObject;
  },
);

exposeTool(
  "sns_vote_history",
  {
    title: "Voting history",
    description: "Legacy signed-relay audit trail, newest first. New reviewed votes, proposals, neuron actions and funding are retained in sns_operation_history_v1 and sns_operation_status_v1.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        before: { type: "integer", minimum: 0 },
      },
    },
    annotations: readOnly(),
  },
  async (args, context) => {
    const input = args as { limit?: number; before?: number };
    // Self-call API 1 is not Candid-shaped JS: an option is the bare value or
    // `null` (or an omitted key), never `[]` / `[value]`, and Nat/Nat64 travel
    // as lossless decimal strings. Passing `[]` here reaches the encoder as an
    // array where a scalar is expected and fails the whole call.
    const page = (await context.kernel.querySelf("snsgov_audit", [
      {
        ...(input.before === undefined ? {} : { before: String(input.before) }),
        limit: String(input.limit ?? 25),
      },
    ])) as unknown as {
      rows: Record<string, unknown>[];
      next_before?: string | number | null;
      total: number | string;
    };
    return {
      total: Number(page.total),
      nextBefore:
        page.next_before === undefined || page.next_before === null
          ? null
          : Number(page.next_before),
      rows: page.rows as unknown as JsonValue,
      countSemantics: "neurons_succeeded counts IC transport replies, not accepted SNS commands. Historical audit rows alone do not prove a vote or proposal succeeded.",
    } as JsonObject;
  },
);

// ---------------------------------------------------------------------------

exposeTool(
  "sns_canisters",
  {
    title: "Canisters and cycles",
    description:
      "Every canister an SNS owns — the five system canisters plus its dapp canisters, ledger archives, and extensions. Set withCycles to also read each balance; that is an update call the DAO pays for, so leave it off unless cycles are the question.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterId"],
      properties: {
        rootCanisterId: rootArg,
        withCycles: {
          type: "boolean",
          default: false,
          description:
            "Read each canister's cycles balance. Makes root fan out one management call per canister and pay for each.",
        },
      },
    },
    annotations: readOnlyLong(),
  },
  async (args) => {
    const input = args as { rootCanisterId: string; withCycles?: boolean };
    const entry = await requireEntry(input.rootCanisterId);
    const inventory = await listSnsCanisters(entry.canisters.root);

    if (input.withCycles !== true) {
      return {
        sns: displayName(entry),
        rootCanisterId: entry.canisters.root,
        total: inventory.length,
        canisters: inventory.map((canister) => ({
          canisterId: canister.canisterId,
          role: canister.role,
        })) as unknown as JsonValue,
        note: "Cycles not read. Call again with withCycles true to include them.",
      } as JsonObject;
    }

    const cycles = await readCanistersCycles(entry.canisters.root);
    const byId = new Map(cycles.map((row) => [row.canisterId, row]));
    // `status: null` from root is how an unreachable canister reports — a
    // stopped, frozen, or cross-subnet one. Say so rather than showing a zero.
    const rows = inventory.map((canister) => {
      const row: CanisterCycles | undefined = byId.get(canister.canisterId);
      return {
        canisterId: canister.canisterId,
        role: canister.role,
        cycles: row?.cycles === undefined ? null : formatTCycles(row.cycles),
        cyclesRaw: row?.cycles === undefined ? null : row.cycles.toString(),
        status: row?.status ?? "unreachable",
        ...(row?.idleBurnPerDay === undefined
          ? {}
          : { idleBurnPerDay: row.idleBurnPerDay.toString() }),
      };
    });
    const total = cycles.reduce((sum, row) => sum + (row.cycles ?? 0n), 0n);
    const unreachable = rows.filter((row) => row.status === "unreachable").length;

    return {
      sns: displayName(entry),
      rootCanisterId: entry.canisters.root,
      total: inventory.length,
      totalCycles: formatTCycles(total),
      unreachable,
      canisters: rows as unknown as JsonValue,
      ...(unreachable > 0
        ? {
            note: `${unreachable} canister(s) could not be reached by root; their balance is unknown, not zero.`,
          }
        : {}),
    } as JsonObject;
  },
);

// ---------------------------------------------------------------------------
// Navigation — putting a screen in front of the owner
// ---------------------------------------------------------------------------

exposeTool(
  "sns_show",
  {
    title: "Show a page in the app",
    description:
      "Open the SNS Governance tile on a specific page: an SNS, one of its tabs, a single proposal, the drafts list, or setup. Use this instead of describing where to click.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        rootCanisterId: {
          ...rootArg,
          description: "Open this SNS. Omit to open one of the screens below.",
        },
        tab: {
          type: "string",
          enum: [...SNS_TABS],
          description: "Which tab of that SNS. Defaults to overview.",
        },
        proposalId: {
          type: "string",
          description: "Open this proposal. Requires rootCanisterId.",
        },
        draftId: { type: "string", description: "Open this draft for review." },
        screen: {
          type: "string",
          enum: ["list", "drafts", "setup"],
          description: "A screen outside any one SNS. Defaults to list.",
        },
      },
    },
    // Moves what the owner is looking at, so it is not a read-only tool.
    annotations: { "neutron:effects": ["read", "network", "user_visible_ui"] },
  },
  async (args, context) => {
    const input = args as {
      rootCanisterId?: string;
      tab?: SnsTab;
      proposalId?: string;
      draftId?: string;
      screen?: "list" | "drafts" | "setup";
    };

    let view: TileView;
    let described: string;

    if (input.rootCanisterId !== undefined) {
      // Resolve against the registry so a wrong id fails here, with a usable
      // message, rather than landing the owner on a broken page.
      const entry = await requireEntry(input.rootCanisterId);
      const name = displayName(entry);
      if (input.proposalId !== undefined) {
        if (!/^\d+$/.test(input.proposalId)) {
          throw new SnsError("INVALID_REQUEST", `not a proposal id: ${input.proposalId}`, {
            retryable: false,
          });
        }
        requireGovernance(entry);
        const proposalId = BigInt(input.proposalId);
        // Confirm it exists before claiming to have opened it.
        const detail = await getProposal(entry.canisters.governance, proposalId);
        if (!detail) {
          throw new SnsError(
            "INVALID_REQUEST",
            `${name} has no proposal ${input.proposalId}`,
            { sns: entry.canisters.root, retryable: false },
          );
        }
        view = {
          kind: "sns",
          rootCanisterId: entry.canisters.root,
          tab: "proposals",
          proposalId,
        };
        described = `${name} proposal ${input.proposalId}`;
      } else {
        const tab = input.tab ?? "overview";
        view = { kind: "sns", rootCanisterId: entry.canisters.root, tab };
        described = tab === "overview" ? name : `${name} · ${tab}`;
      }
    } else if (input.draftId !== undefined) {
      view = { kind: "draft", draftId: input.draftId };
      described = `draft ${input.draftId}`;
    } else {
      const screen = input.screen ?? "list";
      view = { kind: screen };
      described = screen === "list" ? "the SNS list" : screen;
    }

    const target = formatView(view);
    try {
      await context.kernel.callTool({
        target: "kernel",
        name: "workspace.open_tile",
        arguments: {
          appId: "snsgov",
          tileId: "main",
          reuseExisting: true,
          view: target,
        },
      }, 60);
    } catch (error) {
      // The Kernel can refuse: no room in the workspace, or the owner declined.
      // Saying so is far better than reporting a navigation that never happened.
      throw new SnsError(
        "INVALID_REQUEST",
        `could not open the tile: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }

    return { showing: described, view: target } as JsonObject;
  },
);

// ---------------------------------------------------------------------------
// Drafting — off-chain only
// ---------------------------------------------------------------------------
//
// Drafts remain off-chain. Submitting uses sns_submit_draft_v1 and the same
// exact review and durable operation identity as other proposal operations.

exposeTool(
  "sns_draft_proposal",
  {
    title: "Draft a proposal",
    description:
      "Create an off-chain proposal draft. Submit its retained operationId with sns_submit_draft_v1 after exact review. Native actions use the explicit action variant; legacy Motion/custom inputs retain their original meaning.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterId", "title", "summary"],
      properties: {
        rootCanisterId: rootArg,
        title: { type: "string", maxLength: 256 },
        summary: { type: "string", maxLength: 30000 },
        url: { type: "string", maxLength: 2048 },
        actionKind: { type: "string", default: "Motion" },
        action: { type: "object", additionalProperties: true, description: "Explicit native proposal variant, for example {Motion:{motion_text:'...'}}. Inspect sns_proposal_schema_v1. Omit legacy actionKind/motionText/functionId/payloadHex when using this field." },
        motionText: {
          type: "string",
          maxLength: 30000,
          description: "Required for a Motion. This is the motion itself, not the summary.",
        },
        functionId: { type: "string", description: "For ExecuteGenericNervousSystemFunction." },
        // Shared tool schemas support character classes, but not regex groups.
        // The handler below also checks byte alignment and the Candid header.
        payloadHex: { type: "string", minLength: 2, pattern: "^[0-9a-fA-F]+$", description: "Even-length hex encoding of the exact Candid payload returned by sns_validate_payload, or copied from a previous custom proposal. Required for a custom action." },
      },
    },
    annotations: { "neutron:effects": ["read", "network", "write", "user_visible_ui"] },
  },
  async (args, context) => {
    const input = args as {
      rootCanisterId: string;
      title: string;
      summary: string;
      url?: string;
      actionKind?: string;
      action?: JsonObject;
      motionText?: string;
      functionId?: string;
      payloadHex?: string;
    };
    const entry = await requireEntry(input.rootCanisterId);
    requireGovernance(entry);
    if (input.action !== undefined && [input.actionKind, input.motionText, input.functionId, input.payloadHex].some(value => value !== undefined)) throw new SnsError("INVALID_REQUEST", "Use the explicit action variant or legacy draft fields, not both.");
    const actionKind = input.action !== undefined ? "NativeActionV1" : input.actionKind ?? "Motion";
    let payload: Uint8Array | undefined;
    if (input.action !== undefined) payload = await encodeNativeDraft(input.action);
    else if (actionKind !== "Motion") {
      if (input.functionId === undefined || !input.payloadHex || !/^(?:[0-9a-fA-F]{2})+$/.test(input.payloadHex)) {
        throw new SnsError("INVALID_REQUEST", "A custom proposal requires functionId and an exact, even-length payloadHex from sns_validate_payload or an existing proposal.", { retryable: false });
      }
      payload = fromHex(input.payloadHex);
      if (payload.length < 6 || toHex(payload.slice(0, 4)) !== "4449444c") {
        throw new SnsError("INVALID_REQUEST", "payloadHex must contain a Candid message with a DIDL header.", { retryable: false });
      }
    }

    // A Motion is nothing but its text, so a draft without it cannot be sent.
    // It used to be accepted here and dropped on the floor.
    if (actionKind === "Motion" && !input.motionText?.trim()) {
      throw new SnsError(
        "INVALID_REQUEST",
        "motionText is required for a Motion proposal — the summary is not the motion",
        { sns: input.rootCanisterId, retryable: false },
      );
    }

    // A missing topic is version-dependent. Keep the original custom function
    // identity, and let the deployed Governance validate proposal eligibility.
    if (actionKind !== "Motion" && actionKind !== "NativeActionV1" && input.functionId !== undefined) {
      const functions = await listNervousSystemFunctions(entry.canisters.governance);
      const fn = functions.find((candidate) => candidate.id.toString() === input.functionId);
      if (!fn || fn.kind !== "generic") throw new SnsError("INVALID_REQUEST", `unknown custom function id ${input.functionId}`);
    }

    // Absent options are omitted keys, and `function_id` is a Nat64, so it
    // travels as a decimal string. The reply is the unwrapped `#ok` payload —
    // the Kernel projects a two-field ok/err variant by returning `ok` and
    // throwing `err`, so there is no `{ ok, err }` envelope to inspect.
    const draftId = (await context.kernel.updateSelf("snsgov_draft_save", [
      {
        sns: entry.canisters.root,
        governance: entry.canisters.governance,
        title: input.title,
        summary: input.summary,
        url: input.url ?? "",
        action_kind: actionKind,
        // `payload` holds the action's bytes, read according to `action_kind`:
        // UTF-8 motion text for a Motion, raw Candid argument bytes for a
        // custom function. A Uint8Array is lifted into the wire's binary
        // sidecar automatically.
        ...(actionKind === "Motion" && input.motionText
          ? { payload: new TextEncoder().encode(input.motionText) }
          : {}),
        ...(payload === undefined ? {} : { payload }),
        ...(actionKind === "Motion" || input.functionId === undefined ? {} : { function_id: input.functionId }),
        created_by: "agent",
      },
    ])) as unknown as string | number;

    // Put the draft in front of the owner rather than leaving it somewhere they
    // have to know to look. Best effort: the Kernel may refuse (no workspace
    // room, permission declined), and a draft that saved is still a success.
    let shown = false;
    try {
      await context.kernel.callTool({
        target: "kernel",
        name: "workspace.open_tile",
        arguments: {
          appId: "snsgov",
          tileId: "main",
          reuseExisting: true,
          // Same grammar the navigation tool uses, from one place.
          view: formatView({ kind: "draft", draftId: String(draftId) }),
        },
      }, 60);
      shown = true;
    } catch {
      // Left for the owner to open themselves; the Drafts count still shows it.
    }

    return {
      draftId: String(draftId),
      status: "draft",
      shownToOwner: shown,
      note: shown
        ? "Opened for review. sns_submit_draft_v1 submits this exact saved draft with approval."
        : "Saved in Drafts. sns_submit_draft_v1 submits this exact saved draft with approval.",
    } as JsonObject;
  },
);

exposeTool(
  "sns_drafts",
  {
    title: "List drafts",
    description: "Saved off-chain proposal drafts with their stable submission operation IDs.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: readOnly(),
  },
  async (_args, context) => {
    const drafts = (await context.kernel.querySelf("snsgov_drafts", [null])) as unknown as Record<
      string,
      unknown
    >[];
    return {
      drafts: await Promise.all(drafts.map(async draft => ({ ...await withDecodedAction(draft), operationId: await draftOperationId(draft) }))) as unknown as JsonValue,
    } as JsonObject;
  },
);

// ---------------------------------------------------------------------------

interface AllowRow {
  sns: string;
  governance: string;
  votingEnabled: boolean;
  agentVotingEnabled: boolean;
}

async function readConfig(kernel: ScopedKernelClient): Promise<AllowRow[]> {
  const raw = (await kernel.querySelf("snsgov_config", [null])) as unknown as {
    snses: Record<string, unknown>[];
  };
  return raw.snses.map((row) => ({
    sns: principalText(row.sns),
    governance: principalText(row.governance),
    votingEnabled: Boolean(row.voting_enabled),
    agentVotingEnabled: Boolean(row.agent_voting_enabled),
  }));
}

function principalText(value: unknown): string {
  if (typeof value === "string") return value;
  const maybe = value as { toText?: () => string };
  return typeof maybe?.toText === "function" ? maybe.toText() : String(value);
}

// ---------------------------------------------------------------------------
// Custom proposals
// ---------------------------------------------------------------------------

exposeTool(
  "sns_proposal_type_schema",
  {
    title: "Inspect a custom proposal type",
    description:
      "For one custom proposal type: its target, its validator, whether it can be proposed at all, and its target canister's Candid interface when that canister publishes one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterId", "functionId"],
      properties: { rootCanisterId: rootArg, functionId: { type: "string" } },
    },
    annotations: readOnlyLong(),
  },
  async (args) => {
    const { rootCanisterId, functionId } = args as { rootCanisterId: string; functionId: string };
    const entry = await requireEntry(rootCanisterId);
    requireGovernance(entry);
    const functions = await listNervousSystemFunctions(entry.canisters.governance);
    const fn = functions.find((candidate) => candidate.id.toString() === functionId);
    if (!fn) throw new SnsError("INVALID_REQUEST", `unknown function id ${functionId}`);

    const did = fn.targetCanisterId ? await discoverInterface(fn.targetCanisterId) : null;
    return {
      ...functionRow(fn),
      interfaceAvailable: did !== null,
      candidInterface: did ? did.slice(0, 60_000) : null,
      ...(did === null && fn.kind === "generic"
        ? {
            interfaceNote:
              "This target does not publish candid:service. Provide the target Candid interface or original executable payload bytes. Summarized on-chain proposal blobs must not be reused as executable input.",
          }
        : {}),
    } as unknown as JsonObject;
  },
);

exposeTool(
  "sns_validate_payload",
  {
    title: "Validate a custom proposal payload",
    description:
      "Encode exact Candid arguments for a custom proposal and run only a query validator when available. Update-only validators are reported as requiring authoritative SNS submission; this preview makes no updates.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rootCanisterId", "functionId", "value"],
      properties: {
        rootCanisterId: rootArg,
        functionId: { type: "string" },
        value: {
          description: "Natural JSON Candid argument: decimal strings for large integers, principal text, null/omitted optional values, single-key variants and byte arrays or {hex:...} blobs. Use an array for multiple method arguments and [] for a zero-argument method.",
        },
      },
    },
    annotations: readOnlyLong(),
  },
  async (args) => {
    const { rootCanisterId, functionId, value } = args as {
      rootCanisterId: string;
      functionId: string;
      value: unknown;
    };
    const entry = await requireEntry(rootCanisterId);
    requireGovernance(entry);
    const functions = await listNervousSystemFunctions(entry.canisters.governance);
    const fn = functions.find((candidate) => candidate.id.toString() === functionId);
    if (!fn) throw new SnsError("INVALID_REQUEST", `unknown function id ${functionId}`);
    if (!fn.targetCanisterId || !fn.targetMethodName) {
      throw new SnsError("INVALID_REQUEST", "that function has no target method");
    }

    const { payload, validation } = await buildAndValidate(
      {
        functionId: fn.id,
        targetCanisterId: fn.targetCanisterId,
        targetMethodName: fn.targetMethodName,
        ...(fn.validatorCanisterId === undefined ? {} : { validatorCanisterId: fn.validatorCanisterId }),
        ...(fn.validatorMethodName === undefined ? {} : { validatorMethodName: fn.validatorMethodName }),
        ...(fn.topic === undefined ? {} : { topic: fn.topic }),
      },
      value,
    );

    return {
      valid: validation.ok,
      payloadBytes: payload.length,
      payloadHex: toHex(payload),
      // The DAO's own rendering — this is the payload section of what voters
      // see, not the whole payload_text_rendering field.
      rendering: validation.rendering ?? null,
      error: validation.error ?? null,
      validation: validation as unknown as JsonValue,
      targetCanisterId: fn.targetCanisterId,
      targetMethodName: fn.targetMethodName,
    } as JsonObject;
  },
);

/**
 * Surface a draft's action payload in the form a reviewer can actually read.
 *
 * A Motion's payload is its text; a custom function's is opaque Candid, which
 * stays hex so it can be round-tripped exactly.
 */
async function withDecodedAction(draft: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = draft.payload;
  if (payload === undefined || payload === null) return draft;
  const bytes =
    payload instanceof Uint8Array
      ? payload
      : Array.isArray(payload)
        ? Uint8Array.from(payload as number[])
        : undefined;
  if (!bytes) return draft;
  if (draft.action_kind === "NativeActionV1") {
    const { payload: _dropped, ...rest } = draft;
    return { ...rest, action: await decodeNativeDraft(bytes), payloadProvenance: "original_saved_action" };
  }
  if (draft.action_kind === "Motion") {
    const { payload: _dropped, ...rest } = draft;
    return { ...rest, motionText: new TextDecoder().decode(bytes) };
  }
  const { payload: _dropped, ...rest } = draft;
  return { ...rest, payloadHex: toHex(bytes) };
}
