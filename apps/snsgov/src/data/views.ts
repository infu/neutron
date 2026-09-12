/**
 * The tile's view grammar.
 *
 * An agent can put a screen in front of the owner by asking the Kernel to open
 * this tile with a view string. The string is the contract between the service
 * (which builds it) and the tile (which reads it), so both use this module —
 * a grammar defined in one place cannot drift into a silent no-op where the
 * agent thinks it navigated and nothing moved.
 *
 *   list                            the SNS list
 *   sns/<root>                      one SNS, overview
 *   sns/<root>/<tab>                one SNS, a named tab
 *   sns/<root>/proposals/<id>       one proposal, open
 *   drafts                          proposals awaiting review
 *   draft/<id>                      one draft, open for review
 *   setup                           the voting principal and allowlist
 */

export const SNS_TABS = ["overview", "proposals", "neurons", "types", "canisters"] as const;

export type SnsTab = (typeof SNS_TABS)[number];

export type TileView =
  | { kind: "feed" }
  | { kind: "neurons"; rootCanisterId?: string; neuronId?: string }
  | { kind: "activity"; operationId?: string }
  | { kind: "list" }
  | { kind: "sns"; rootCanisterId: string; tab: SnsTab; proposalId?: bigint }
  | { kind: "drafts" }
  | { kind: "draft"; draftId: string }
  | { kind: "setup" };

/** Canister ids are lower-case base32 in five-character groups. */
const PRINCIPAL = /^[a-z0-9]{5}(-[a-z0-9]{3,5})+$/;

/**
 * Build the view string for a target.
 *
 * Throws rather than emitting something the tile will ignore: an agent that
 * silently fails to navigate is worse than one that reports it could not.
 */
export function formatView(view: TileView): string {
  switch (view.kind) {
    case "feed":
      return "feed";
    case "activity":
      if (view.operationId !== undefined && !/^[a-zA-Z0-9_-]+$/.test(view.operationId)) throw new Error("not an operation id");
      return view.operationId === undefined ? "activity" : `activity/${view.operationId}`;
    case "neurons": {
      if (view.rootCanisterId !== undefined && !PRINCIPAL.test(view.rootCanisterId)) throw new Error(`not a canister id: ${view.rootCanisterId}`);
      if (view.neuronId !== undefined && (!view.rootCanisterId || !/^[a-f0-9]{64}$/i.test(view.neuronId))) throw new Error("not a neuron id");
      return view.rootCanisterId === undefined ? "neurons" : `neurons/${view.rootCanisterId}${view.neuronId === undefined ? "" : `/${view.neuronId}`}`;
    }
    case "list":
      return "list";
    case "drafts":
      return "drafts";
    case "setup":
      return "setup";
    case "draft":
      if (!/^\d+$/.test(view.draftId)) throw new Error(`not a draft id: ${view.draftId}`);
      return `draft/${view.draftId}`;
    case "sns": {
      if (!PRINCIPAL.test(view.rootCanisterId)) {
        throw new Error(`not a canister id: ${view.rootCanisterId}`);
      }
      if (view.proposalId !== undefined) {
        return `sns/${view.rootCanisterId}/proposals/${view.proposalId.toString()}`;
      }
      return view.tab === "overview"
        ? `sns/${view.rootCanisterId}`
        : `sns/${view.rootCanisterId}/${view.tab}`;
    }
  }
}

/** Read a view string. Returns undefined for anything unrecognised. */
export function parseView(value: string): TileView | undefined {
  if (value === "feed") return { kind: "feed" };
  if (value === "neurons") return { kind: "neurons" };
  if (value === "activity") return { kind: "activity" };
  if (value === "explore") return { kind: "list" };
  if (value === "settings" || value === "connections") return { kind: "setup" };
  const activity = /^activity\/([a-zA-Z0-9_-]+)$/.exec(value);
  if (activity) return { kind: "activity", operationId: activity[1]! };
  const neuron = /^neurons\/([^/]+)(?:\/([a-f0-9]{64}))?$/i.exec(value);
  if (neuron && PRINCIPAL.test(neuron[1]!)) return { kind: "neurons", rootCanisterId: neuron[1]!, ...(neuron[2] ? { neuronId: neuron[2].toLowerCase() } : {}) };
  if (value === "list") return { kind: "list" };
  if (value === "drafts") return { kind: "drafts" };
  if (value === "setup") return { kind: "setup" };

  const draft = /^draft\/(\d+)$/.exec(value);
  if (draft) return { kind: "draft", draftId: draft[1]! };

  const parts = value.split("/");
  if (parts[0] !== "sns" || parts.length < 2 || parts.length > 4) return undefined;
  const root = parts[1]!;
  if (!PRINCIPAL.test(root)) return undefined;

  if (parts.length === 2) return { kind: "sns", rootCanisterId: root, tab: "overview" };

  if (parts.length === 4) {
    // The only two-segment form is a proposal inside the proposals tab.
    if (parts[2] !== "proposals" || !/^\d+$/.test(parts[3]!)) return undefined;
    return {
      kind: "sns",
      rootCanisterId: root,
      tab: "proposals",
      proposalId: BigInt(parts[3]!),
    };
  }

  const tab = parts[2]!;
  if (!(SNS_TABS as readonly string[]).includes(tab)) return undefined;
  return { kind: "sns", rootCanisterId: root, tab: tab as SnsTab };
}
