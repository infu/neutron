/**
 * Review and send agent-written proposals.
 *
 * This is the human gate the whole drafting design rests on: an agent can write
 * a proposal but has no tool that submits one, so nothing reaches an SNS until
 * a person reads it here and presses send. The screen therefore shows the
 * proposal as voters will see it, not as a database row.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteDraft,
  listDrafts,
  sendDraft,
  canPropose,
  type DraftRow,
} from "../data/drafts";
import { readRegistration, type NeuronRegistration } from "../data/registration";
import { readHotkey } from "../data/relay";
import { formatTimestamp, shortenId, toHex } from "../data/format";
import { IconButton } from "./IconButton";
import { rowProps } from "./Row";
import { BusyOr, Empty, Pending } from "./Status";
import { BackIcon, ProposalIcon, RefreshIcon, TrashIcon, WarnIcon } from "./Icons";

type State =
  | { phase: "loading" }
  | { phase: "ready"; drafts: DraftRow[] }
  | { phase: "error"; message: string };

export function DraftsView({
  onBack,
  focusDraftId = null,
  onChanged,
}: {
  onBack: () => void;
  /** Opened straight to this draft — how an agent points at what it just wrote. */
  focusDraftId?: string | null;
  onChanged?: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [open, setOpen] = useState<string | null>(focusDraftId);
  const [sent, setSent] = useState<{ title: string; proposalId?: bigint; cleanupWarning?: string } | null>(null);
  // A confirmed proposal is not another pending draft if removal of the saved
  // row failed. Keep the receipt visible and hide that stale row this session.
  const submitted = useRef(new Set<string>());
  // A refresh keeps the list on screen; only a first read has nothing to show.
  const [busy, setBusy] = useState(false);

  // Held in a ref: a parent that passes an inline arrow gives `onChanged` a new
  // identity every render, and depending on it here makes `load` new every
  // render too, which re-fires the effect below, which calls `onChanged`, which
  // re-renders the parent — an endless load/clear/load flicker.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const drafts = await listDrafts();
      setState({ phase: "ready", drafts: drafts.filter(draft => !submitted.current.has(draft.id)) });
      changed.current?.();
    } catch (error) {
      setState({ phase: "error", message: String(error) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A second agent draft while this screen is already open must retarget it.
  useEffect(() => {
    setOpen(focusDraftId);
    void load();
  }, [focusDraftId, load]);

  const selected =
    state.phase === "ready" ? state.drafts.find((draft) => draft.id === open) : undefined;

  return (
    <div className="nt-page">
      <header className="nt-page-header snsgov-toolbar">
        <div className="nt-cluster">
          <IconButton label="Back to the SNS list" onClick={onBack}>
            <BackIcon />
          </IconButton>
          <h1 className="nt-title snsgov-detail-title">Drafts</h1>
          {state.phase === "ready" && (
            <span className="nt-section-count">{state.drafts.length}</span>
          )}
        </div>
        <div className="nt-cluster snsgov-toolbar-actions">
          <IconButton
            disabled={busy}
            label="Refresh drafts"
            onClick={() => void load()}
          >
            <BusyOr busy={busy}>
              <RefreshIcon />
            </BusyOr>
          </IconButton>
        </div>
      </header>

      <section className="nt-page-main">
        {sent && (
          <div className="nt-alert nt-alert--success" role="status">
            Sent “{sent.title}”
            {sent.proposalId === undefined ? "" : ` — proposal ${sent.proposalId.toString()}`}.
            {sent.cleanupWarning && <p className="nt-text">{sent.cleanupWarning}</p>}
          </div>
        )}
        {state.phase === "loading" && <Pending label="Reading drafts" />}
        {state.phase === "error" && (
          <div className="nt-alert nt-alert--danger" role="alert">
            {state.message}
          </div>
        )}
        {state.phase === "ready" && state.drafts.length === 0 && (
          <Empty label="No drafts. Ask the agent to draft a proposal and it will appear here for review." />
        )}
        {state.phase === "ready" && state.drafts.length > 0 && !selected && (
          <div className="nt-table-wrap">
            <table className="nt-table snsgov-table snsgov-table--drafts">
              <caption className="nt-sr-only">Proposal drafts awaiting review</caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th className="snsgov-nowrap" scope="col">
                    Type
                  </th>
                  <th className="snsgov-nowrap" scope="col">
                    By
                  </th>
                  <th className="snsgov-nowrap" scope="col">
                    Updated
                  </th>
                  <th scope="col">
                    <span className="nt-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.drafts.map((draft) => (
                  <tr key={draft.id} {...rowProps(() => setOpen(draft.id))}>
                    <th scope="row">
                      <button
                        className="snsgov-link"
                        onClick={() => setOpen(draft.id)}
                        title={draft.title}
                        type="button"
                      >
                        {draft.title || "(untitled)"}
                      </button>
                    </th>
                    <td className="snsgov-nowrap" title={draft.actionKind}>
                      {draft.actionKind}
                    </td>
                    <td className="snsgov-nowrap">{draft.createdBy}</td>
                    <td className="snsgov-nowrap">
                      {formatTimestamp(draft.updatedAtSeconds).slice(0, 10)}
                    </td>
                    <td className="snsgov-row-actions">
                      <IconButton label={`Review “${draft.title}”`} onClick={() => setOpen(draft.id)}>
                        <ProposalIcon />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selected && (
          <DraftDetail
            key={JSON.stringify(selected, (_key, value) => typeof value === "bigint" ? value.toString() : value)}
            draft={selected}
            onClose={() => setOpen(null)}
            onSent={(proposalId, cleanupWarning) => {
              submitted.current.add(selected.id);
              setSent({
                title: selected.title,
                ...(proposalId === undefined ? {} : { proposalId }),
                ...(cleanupWarning === undefined ? {} : { cleanupWarning }),
              });
              setOpen(current => current === selected.id ? null : current);
              void load();
            }}
            onDiscarded={() => {
              setOpen(current => current === selected.id ? null : current);
              void load();
            }}
          />
        )}
      </section>
    </div>
  );
}

function DraftDetail({
  draft,
  onClose,
  onSent,
  onDiscarded,
}: {
  draft: DraftRow;
  onClose: () => void;
  onSent: (proposalId?: bigint, cleanupWarning?: string) => void;
  onDiscarded: () => void;
}) {
  const [neurons, setNeurons] = useState<NeuronRegistration[] | null>(null);
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const [neuronId, setNeuronId] = useState<string>(
    draft.proposer ? toHex(draft.proposer) : "",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const hotkey = await readHotkey();
        const status = await readRegistration(draft.governance, hotkey.principal);
        if (cancelled) return;
        const eligible = status.found.filter((entry) => canPropose(entry.missing));
        setNeurons(eligible);
        // One eligible neuron is the common case; do not make them choose.
        if (!draft.proposer && eligible.length === 1) setNeuronId(eligible[0]!.neuronId);
      } catch (error) {
        if (!cancelled) {
          setMessage(String(error));
          setRegistrationFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draft.governance, draft.proposer]);

  const send = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await sendDraft(draft, neuronId);
      onSent(result.proposalId, result.cleanupWarning);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }, [draft, neuronId, onSent]);

  const discard = useCallback(async () => {
    setBusy(true);
    try {
      await deleteDraft(draft.id);
      onDiscarded();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, [draft.id, onDiscarded]);

  const ready = neurons?.some(neuron => neuron.neuronId === neuronId) ?? false;

  return (
    <section className="nt-section snsgov-review">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Review</h2>
        <div className="nt-cluster snsgov-toolbar-actions">
          <IconButton disabled={busy} label="Discard this draft" onClick={() => void discard()}>
            <TrashIcon />
          </IconButton>
          <button className="nt-button nt-button--ghost" disabled={busy} onClick={onClose} type="button">
            Close
          </button>
        </div>
      </header>

      {message && (
        <div className="nt-alert nt-alert--danger" role="alert">
          {message}
        </div>
      )}

      {/* Shown the way voters will see it, so review means something. */}
      <article className="snsgov-proposal">
        <h3 className="nt-title snsgov-proposal-title">{draft.title || "(untitled)"}</h3>
        <dl className="snsgov-facts">
          <dt>Type</dt>
          <dd>{draft.actionKind}</dd>
          <dt>SNS</dt>
          <dd>
            <code className="nt-code">{shortenId(draft.sns, 8, 6)}</code>
          </dd>
          {draft.functionId !== undefined && (
            <>
              <dt>Function</dt>
              <dd>{draft.functionId.toString()}</dd>
            </>
          )}
          {draft.url && (
            <>
              <dt>URL</dt>
              <dd>{draft.url}</dd>
            </>
          )}
          <dt>Drafted by</dt>
          <dd>{draft.createdBy}</dd>
        </dl>

        <h4 className="nt-section-title">Summary</h4>
        <p className="nt-text snsgov-proposal-body">{draft.summary}</p>

        {draft.motionText !== undefined && (
          <>
            <h4 className="nt-section-title">Motion</h4>
            <p className="nt-text snsgov-proposal-body">{draft.motionText}</p>
          </>
        )}
        {draft.rendering !== undefined && (
          <>
            <h4 className="nt-section-title">Payload, as the DAO renders it</h4>
            <pre className="nt-pre">{draft.rendering}</pre>
          </>
        )}
        {draft.motionText === undefined && draft.rendering === undefined && draft.payload && (
          <>
            <h4 className="nt-section-title">Payload</h4>
            <pre className="nt-pre">{toHex(draft.payload)}</pre>
          </>
        )}
      </article>

      <h4 className="nt-section-title">Propose with</h4>
      {neurons === null && !registrationFailed && <Pending label="Finding neurons that may propose" />}
      {neurons !== null && neurons.length === 0 && (
        <div className="nt-alert nt-alert--warning snsgov-alert" role="status">
          <WarnIcon />
          <span>
            No neuron on this SNS grants your voting principal{" "}
            <code className="nt-code">SubmitProposal</code>, so this draft cannot be sent yet. Add
            the hotkey on a neuron, then come back.
          </span>
        </div>
      )}
      {neurons !== null && neurons.length > 0 && (
        <div className="snsgov-filter">
          <label className="nt-sr-only" htmlFor="snsgov-proposer">
            Neuron to propose with
          </label>
          <select
            className="nt-select"
            disabled={busy}
            id="snsgov-proposer"
            onChange={(event) => {
              setNeuronId(event.target.value);
              setConfirming(false);
            }}
            value={neuronId}
          >
            <option value="">Choose a neuron…</option>
            {neurons.map((entry) => (
              <option key={entry.neuronId} value={entry.neuronId}>
                {shortenId(entry.neuronId, 10, 6)}
              </option>
            ))}
          </select>
          {confirming ? (
            <>
              <button
                className="nt-button"
                disabled={busy || !ready}
                onClick={() => void send()}
                type="button"
              >
                {busy ? "Sending…" : "Confirm — put this on-chain"}
              </button>
              <button
                className="nt-button nt-button--ghost"
                disabled={busy}
                onClick={() => setConfirming(false)}
                type="button"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="nt-button"
              disabled={busy || !ready}
              onClick={() => setConfirming(true)}
              type="button"
            >
              Send
            </button>
          )}
        </div>
      )}
      <p className="nt-meta">
        Sending submits the proposal to the SNS immediately and charges the reject fee if it is
        rejected. It cannot be undone.
      </p>
    </section>
  );
}
