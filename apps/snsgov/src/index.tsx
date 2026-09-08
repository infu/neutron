import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { onTileViewRequest } from "neutron-tools/app";
import "./style.scss";

import { SnsError } from "./data/errors";
import {
  displayName,
  getProvisionalRegistry,
  getRegistry,
  peekRegistry,
  type RegistryEntry,
} from "./data/registry";
import { DraftsView } from "./ui/Drafts";
import { SetupView } from "./ui/Setup";
import { SnsDetailView } from "./ui/SnsDetail";
import { IconButton } from "./ui/IconButton";
import { NeuronIcon, ProposalIcon, RefreshIcon, SearchIcon, WarnIcon } from "./ui/Icons";
import { BusyOr, Empty, Pending } from "./ui/Status";
import { rowProps } from "./ui/Row";
import { SnsLogo } from "./ui/Logo";
import { listDrafts } from "./data/drafts";
import { parseView, type SnsTab } from "./data/views";

type StatusFilter = "active" | "all";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; entries: RegistryEntry[]; fetchedAt: number; livenessKnown: boolean }
  | { phase: "error"; message: string };

export function App() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [selected, setSelected] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [drafts, setDrafts] = useState<{ count: number; openId: string | null } | null>(null);
  const [showDrafts, setShowDrafts] = useState<{ focus: string | null } | null>(null);
  // Where an agent asked us to land inside an SNS, if it did.
  const [target, setTarget] = useState<{ tab: SnsTab; proposalId?: bigint } | null>(null);
  // A refresh keeps the current rows on screen behind a hairline; only the very
  // first read has nothing to show.
  const [busy, setBusy] = useState(false);

  // The count is the only signal that an agent left something waiting, so it is
  // always in the header rather than behind a menu.
  const countDrafts = useCallback(async () => {
    try {
      const rows = await listDrafts();
      setDrafts({ count: rows.length, openId: null });
    } catch {
      // A Kernel that is not answering yet must not blank the header.
    }
  }, []);

  useEffect(() => {
    void countDrafts();
  }, [countDrafts]);

  // An agent that drafts a proposal asks the Kernel to show it here. The view
  // string is `draft/<id>` for one draft, or `drafts` for the list.
  useEffect(
    () =>
      onTileViewRequest((raw) => {
        const view = parseView(raw);
        if (!view) return;
        // Every branch clears the others: an agent asking for one screen must
        // not leave the tile on two.
        setShowSetup(false);
        setShowDrafts(null);
        setSelected(null);
        setTarget(null);
        switch (view.kind) {
          case "list":
            break;
          case "setup":
            setShowSetup(true);
            break;
          case "drafts":
            setShowDrafts({ focus: null });
            void countDrafts();
            break;
          case "draft":
            setShowDrafts({ focus: view.draftId });
            void countDrafts();
            break;
          case "sns":
            setSelected(view.rootCanisterId);
            setTarget({
              tab: view.tab,
              ...(view.proposalId === undefined ? {} : { proposalId: view.proposalId }),
            });
            break;
        }
      }),
    [countDrafts],
  );

  const load = useCallback(async (force: boolean) => {
    setBusy(true);
    try {
      // Paint the last known list on the first frame. Building it fresh means
      // ~54 liveness probes and takes about twenty seconds; making the owner
      // watch that on every open, with a good copy already in storage, is the
      // whole reason startup felt broken.
      if (!force) {
        const cached = peekRegistry();
        if (cached) {
          setState({
            phase: "ready",
            entries: cached.entries,
            fetchedAt: cached.fetchedAt,
            livenessKnown: true,
          });
        } else {
          // Nothing stored: first run, or a very long absence. The aggregator
          // returns all 54 in under three seconds where the probed build takes
          // twenty, so paint that and let the real one replace it. Its liveness
          // is placeholder, which is why the filter below stands down.
          const provisional = await getProvisionalRegistry();
          if (provisional) {
            setState({
              phase: "ready",
              entries: provisional.entries,
              fetchedAt: provisional.fetchedAt,
              livenessKnown: false,
            });
          }
        }
      }
      const registry = await getRegistry(force ? { force: true } : {});
      setState({
        phase: "ready",
        entries: registry.entries,
        fetchedAt: registry.fetchedAt,
        livenessKnown: registry.livenessKnown !== false,
      });
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof SnsError ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const rows = useMemo(() => {
    if (state.phase !== "ready") return [];
    const needle = search.trim().toLowerCase();
    return state.entries
      // While liveness is still placeholder, filtering on it would hide every
      // row. Show them all and let the real build sort them out.
      .filter((entry) =>
        status === "active" && state.livenessKnown ? entry.liveness.governance : true,
      )
      .filter((entry) => {
        if (!needle) return true;
        return `${displayName(entry)} ${entry.token?.symbol ?? ""} ${entry.canisters.root}`
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [state, search, status]);

  if (showDrafts) {
    return (
      <main className="nt-app nt-app--fill snsgov-app">
        <DraftsView
          focusDraftId={showDrafts.focus}
          onBack={() => {
            setShowDrafts(null);
            void countDrafts();
          }}
          onChanged={countDrafts}
        />
      </main>
    );
  }

  if (showSetup) {
    return (
      <main className="nt-app nt-app--fill snsgov-app">
        <SetupView onBack={() => setShowSetup(false)} />
      </main>
    );
  }

  if (selected) {
    return (
      <main className="nt-app nt-app--fill snsgov-app">
        <SnsDetailView
          key={selected}
          initialProposalId={target?.proposalId}
          initialTab={target?.tab}
          onBack={() => {
            setSelected(null);
            setTarget(null);
          }}
          rootCanisterId={selected}
        />
      </main>
    );
  }

  const inactiveCount =
    state.phase === "ready" && state.livenessKnown
      ? state.entries.filter((entry) => !entry.liveness.governance).length
      : 0;

  return (
    <main className="nt-app nt-app--fill snsgov-app">
      <div className="nt-page">
        <header className="nt-page-header snsgov-toolbar">
          <div className="snsgov-search">
            <SearchIcon className="snsgov-search-icon" />
            <input
              aria-label="Search SNSes by name, symbol, or canister id"
              className="nt-input"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search"
              type="search"
              value={search}
            />
          </div>
          <div className="nt-cluster snsgov-toolbar-actions">
            <IconButton
              label={status === "active" ? "Showing active only — click to show all" : "Showing all — click to show active only"}
              onClick={() => setStatus((value) => (value === "active" ? "all" : "active"))}
              pressed={status === "all"}
            >
              <WarnIcon />
            </IconButton>
            <IconButton disabled={busy} label="Refresh" onClick={() => void load(true)}>
              <BusyOr busy={busy}>
                <RefreshIcon />
              </BusyOr>
            </IconButton>
            <IconButton
              label={
                drafts && drafts.count > 0
                  ? `${drafts.count} proposal${drafts.count === 1 ? "" : "s"} waiting for you to review and send`
                  : "Proposal drafts awaiting review"
              }
              onClick={() => setShowDrafts({ focus: null })}
            >
              <span className="snsgov-count">
                <ProposalIcon />
                {drafts && drafts.count > 0 && (
                  <span className="snsgov-badge-count">{drafts.count}</span>
                )}
              </span>
            </IconButton>
            <IconButton label="Setup: your voting principal and allowlist" onClick={() => setShowSetup(true)}>
              <NeuronIcon />
            </IconButton>
          </div>
        </header>

        <section className="nt-page-main">
          {state.phase === "loading" && <Pending label="Reading the SNS registry" />}

          {state.phase === "error" && (
            <div className="nt-alert nt-alert--danger" role="alert">
              <p className="nt-text">{state.message}</p>
              <button className="nt-button" onClick={() => void load(true)} type="button">
                Retry
              </button>
            </div>
          )}

          {state.phase === "ready" && rows.length === 0 && (
            <Empty label="No SNS matches that search." />
          )}

          {state.phase === "ready" && rows.length > 0 && (
            <>
              <div className="nt-table-wrap">
                <table className="nt-table snsgov-table snsgov-table--snses">
                  <caption className="nt-sr-only">
                    Service Nervous Systems on the Internet Computer
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Symbol</th>
                      <th scope="col">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((entry) => (
                      <SnsRowView entry={entry} key={entry.canisters.root} livenessKnown={state.livenessKnown} onOpen={setSelected} />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="nt-meta snsgov-footnote">
                {rows.length} shown
                {status === "active" && inactiveCount > 0
                  ? ` · ${inactiveCount} inactive hidden (governance canister has no code installed)`
                  : ""}
              </p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function SnsRowView({
  entry,
  livenessKnown,
  onOpen,
}: {
  entry: RegistryEntry;
  livenessKnown: boolean;
  onOpen: (root: string) => void;
}) {
  const token = entry.token;
  const name = displayName(entry);
  const description = entry.metadata?.description?.replace(/\s+/g, " ").trim() ?? "";
  const inactive = livenessKnown && !entry.liveness.governance;

  return (
    <tr {...rowProps(() => onOpen(entry.canisters.root))}>
      <th scope="row">
        <span className="snsgov-name">
          <SnsLogo logo={entry.metadata?.logo} name={name} size={20} />
          <button
            className="snsgov-link"
            onClick={() => onOpen(entry.canisters.root)}
            title={name}
            type="button"
          >
            {name}
          </button>
        </span>
        {inactive && (
          <span className="nt-badge nt-badge--warning snsgov-badge" title="Governance canister has no code installed">
            {entry.liveness.ledger ? "ledger only" : "inactive"}
          </span>
        )}
      </th>
      <td>{token?.symbol ?? "—"}</td>
      {/* One line, cut with an ellipsis. The full text is in the tooltip and on
          the SNS's own page; a description that wrapped would make rows two and
          three lines tall and destroy the scan-ability of the list. */}
      <td className="snsgov-desc" title={description}>
        {description || "—"}
      </td>
    </tr>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
