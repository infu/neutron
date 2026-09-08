// The shared draft editor.
//
// The draft lives in the backend, not in this component, because an agent edits
// the same document through the same methods. Everything here follows from that:
//
//   * Saves are compare-and-swap on the revision the editor last read. A save
//     that lost the race is rejected with the live draft attached.
//   * An agent write arrives as a same-app state invalidation, not a push of
//     content. The editor re-reads and, if the writer is not mid-sentence,
//     adopts it silently.
//   * If the human has unsaved keystrokes, their text is never yanked away. The
//     external edit is parked behind a non-blocking banner until they choose.

import { useCallback, useEffect, useRef, useState } from "react";
import { onAppStateChange } from "neutron-tools/app";
import {
  DRAFT_TOPIC,
  isConflict,
  isErr,
  type Api,
  type DraftView,
} from "./api";
import { relativeFromNanos, toNumber } from "./format";
import { IconButton, Notice, StateBlock } from "./ui";

// Each autosave is a replicated update: 1.2M cycles of ingress reception plus a
// 5M execution base, paid by the Neutron's owner. The debounce restarts on every
// keystroke, so this is the length of the *pause* that commits a revision --
// short enough that a draft is never far behind the screen, long enough that
// thinking mid-sentence does not bill a round trip. Leaving the editor flushes
// immediately, so a longer window never costs unsaved work.
const AUTOSAVE_MS = 5000;
const MAX_TITLE = 400;
const MAX_SUBTITLE = 400;
const MAX_TAGS = 3;

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

export function EditorView({
  api,
  draftId,
  tags,
  onPublished,
  onStatus,
}: {
  api: Api;
  draftId: string;
  tags: [string, string][];
  onPublished: (url: string, isDraft: boolean) => void;
  onStatus: (message: string) => void;
}) {
  const [base, setBase] = useState<DraftView | null>(null);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [body, setBody] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<DraftView | null>(null);
  const [busy, setBusy] = useState(false);

  // Read by the invalidation handler, which must not close over stale state.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const baseRef = useRef<DraftView | null>(base);
  baseRef.current = base;
  const incomingRef = useRef<DraftView | null>(incoming);
  incomingRef.current = incoming;
  const fieldsRef = useRef({ title, subtitle, body, tagIds });
  fieldsRef.current = { title, subtitle, body, tagIds };
  const editVersion = useRef(0);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const discardedRef = useRef(false);

  const adopt = useCallback((next: DraftView) => {
    baseRef.current = next;
    fieldsRef.current = { title: next.title, subtitle: next.subtitle, body: next.body, tagIds: next.tagIds };
    dirtyRef.current = false;
    incomingRef.current = null;
    setBase(next);
    setTitle(next.title);
    setSubtitle(next.subtitle);
    setBody(next.body);
    setTagIds(next.tagIds);
    setDirty(false);
    setIncoming(null);
    setSaveState("idle");
  }, []);

  const load = useCallback(async () => {
    const result = await api.draftRead(draftId);
    if (isErr(result)) {
      setError(result.err);
      return;
    }
    adopt(result.ok);
    setError(null);
  }, [api, adopt, draftId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Same-app invalidation: the resident background publishes a revision after an
  // agent write. The payload is a hint, never content -- the draft is re-read.
  useEffect(() => {
    const stop = onAppStateChange(DRAFT_TOPIC, () => {
      void (async () => {
        const result = await api.draftRead(draftId);
        if (isErr(result)) return;
        const fresh = result.ok;
        const current = baseRef.current;
        if (!current || BigInt(fresh.revision) <= BigInt(current.revision)) return;
        if (dirtyRef.current) {
          incomingRef.current = fresh;
          setIncoming(fresh);
        } else {
          adopt(fresh);
        }
      })();
    });
    return stop;
  }, [api, adopt, draftId]);

  const save = useCallback((): Promise<boolean> => {
    // All callers share one writer, including an unmount flush while a save is
    // already pending. A successful older response must not mark newer typing
    // clean or make the next write reuse an obsolete revision.
    if (savingRef.current) return savingRef.current;
    const run = async (): Promise<boolean> => {
      while (dirtyRef.current) {
        const current = baseRef.current;
        if (!current || incomingRef.current || discardedRef.current) return false;
        const version = editVersion.current;
        const fields = fieldsRef.current;
        setSaveState("saving");
        const result = await api.draftSet({
          id: current.id,
          expectedRevision: current.revision,
          ...fields,
          editor: "human",
        });
        if (isConflict(result)) {
          incomingRef.current = result.conflict;
          setIncoming(result.conflict);
          setSaveState("idle");
          return false;
        }
        if (isErr(result)) {
          setError(result.err);
          setSaveState("error");
          return false;
        }
        baseRef.current = result.ok;
        setBase(result.ok);
        // An invalidation can have read this very save before its reply arrived.
        // Only a strictly newer revision still needs conflict resolution.
        const incomingAfterSave = incomingRef.current as DraftView | null;
        if (incomingAfterSave && BigInt(incomingAfterSave.revision) <= BigInt(result.ok.revision)) {
          incomingRef.current = null;
          setIncoming(null);
        }
        dirtyRef.current = editVersion.current !== version;
        setDirty(dirtyRef.current);
        setError(null);
      }
      setSaveState("saved");
      return !incomingRef.current && !discardedRef.current;
    };
    const pending = run().finally(() => {
      if (savingRef.current === pending) savingRef.current = null;
    });
    savingRef.current = pending;
    return pending;
  }, [api]);

  // Read by the unmount flush, which runs after `save` has stopped updating.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Debounced autosave. The timer restarts on every keystroke, so it fires once
  // the writer pauses rather than once per burst.
  useEffect(() => {
    if (!dirty || incoming || busy) return;
    setSaveState("pending");
    const timer = setTimeout(() => {
      void save();
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, incoming, busy, title, subtitle, tagIds, body, save]);

  // Leaving the editor with the timer still pending would otherwise drop those
  // keystrokes: the cleanup above clears the timer and nothing else would fire.
  useEffect(() => {
    return () => {
      if (dirtyRef.current) void saveRef.current();
    };
  }, []);

  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    editVersion.current += 1;
    dirtyRef.current = true;
    setter(value);
    setDirty(true);
  };

  const publish = useCallback(
    async (asDraft: boolean) => {
      const current = baseRef.current;
      if (!current) return;
      setBusy(true);
      try {
        // Flush pending keystrokes first: publishing what is on screen but not
        // yet saved would silently publish something else.
        if (!(await save())) return;
        const result = await api.publish(current.id, asDraft);
        if (isErr(result)) {
          setError(result.err);
          return;
        }
        setError(null);
        onPublished(result.ok.url, result.ok.isDraft);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [api, load, onPublished, save],
  );

  const discard = useCallback(async () => {
    const current = baseRef.current;
    if (!current) return;
    setBusy(true);
    try {
      // Finish any already-issued write before deleting the draft, and do not
      // let the unmount cleanup send another autosave after a successful delete.
      if (savingRef.current) await savingRef.current;
      const result = await api.draftDiscard(current.id);
      if (isErr(result)) setError(result.err);
      else {
        discardedRef.current = true;
        dirtyRef.current = false;
        setDirty(false);
        onStatus(result.ok);
      }
    } finally {
      setBusy(false);
    }
  }, [api, onStatus]);

  if (error && !base) {
    return <StateBlock kind="error" onRetry={() => void load()}>{error}</StateBlock>;
  }
  if (!base) return <StateBlock kind="loading">Loading draft…</StateBlock>;

  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const tagNames = new Map(tags);
  const available = tags.filter(([id]) => !tagIds.includes(id));
  const canPublish = title.trim().length > 0 && body.trim().length > 0 && tagIds.length > 0;

  const saveLabel: Record<SaveState, string> = {
    idle: base.modifiedBy === "agent" ? "agent edited" : "saved",
    pending: "unsaved…",
    saving: "saving…",
    saved: "saved",
    error: "not saved",
  };

  return (
    <div className="nuance-editor" data-tid="nuance-editor">
      {incoming ? (
        <Notice
          tone="warning"
          action={
            <>
              <button
                className="nt-button nt-button--sm"
                disabled={busy || saveState === "saving"}
                onClick={() => adopt(incoming)}
                type="button"
              >
                Use theirs
              </button>
              <button
                className="nt-button nt-button--sm"
                disabled={busy || saveState === "saving"}
                onClick={() => {
                  // Rebase onto their revision but keep the local text, so the
                  // next save wins instead of conflicting forever.
                  baseRef.current = incoming;
                  incomingRef.current = null;
                  dirtyRef.current = true;
                  setBase(incoming);
                  setIncoming(null);
                  setDirty(true);
                }}
                type="button"
              >
                Keep mine
              </button>
            </>
          }
        >
          {incoming.modifiedBy === "agent" ? "An agent" : "Another editor"} changed this
          draft (revision {incoming.revision}).
        </Notice>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {base.sourcePostId ? (
        <Notice tone="info">
          Revising a published article. Formatting was flattened to text on
          import, so republishing replaces the original body.
        </Notice>
      ) : null}

      <label className="nt-field nuance-field">
        <span className="nt-label">Title</span>
        <input
          className="nt-input"
          disabled={busy}
          maxLength={MAX_TITLE}
          data-tid="nuance-editor-title"
          onChange={(event) => edit(setTitle)(event.target.value)}
          placeholder="Article title"
          value={title}
        />
      </label>

      <label className="nt-field nuance-field">
        <span className="nt-label">Standfirst</span>
        <input
          className="nt-input"
          disabled={busy}
          maxLength={MAX_SUBTITLE}
          onChange={(event) => edit(setSubtitle)(event.target.value)}
          placeholder="One line of context"
          value={subtitle}
        />
      </label>

      <div className="nt-field nuance-field">
        <span className="nt-label">
          Tags <span className="nt-help">Nuance requires 1–{MAX_TAGS}</span>
        </span>
        <div className="nuance-tag-picker">
          {tagIds.map((id) => (
            <span className="nt-tag nt-tag--selected" key={id}>
              {tagNames.get(id) ?? id}
              <button
                aria-label={`Remove tag ${tagNames.get(id) ?? id}`}
                className="nuance-tag-remove"
                disabled={busy}
                onClick={() => edit(setTagIds)(tagIds.filter((value) => value !== id))}
                title={`Remove tag ${tagNames.get(id) ?? id}`}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
          {tagIds.length < MAX_TAGS && available.length > 0 ? (
            <select
              aria-label="Add a tag"
              className="nt-select nuance-tag-select"
              disabled={busy}
              data-tid="nuance-editor-tag-select"
              onChange={(event) => {
                const chosen = event.target.value;
                if (!chosen) return;
                edit(setTagIds)([...tagIds, chosen]);
              }}
              value=""
            >
              <option value="">Add tag…</option>
              {available.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      <label className="nt-field nuance-field nuance-field--grow">
        <span className="nt-label">Body</span>
        <textarea
          className="nt-textarea nuance-body-input"
          disabled={busy}
          data-tid="nuance-editor-body"
          onChange={(event) => edit(setBody)(event.target.value)}
          placeholder={"Write here.\n\nBlank lines separate paragraphs. Use # and ## for headings and - for lists."}
          spellCheck
          value={body}
        />
      </label>

      <footer className="nuance-editor-footer">
        <span className="nt-meta nuance-editor-status" data-tid="nuance-editor-status">
          {words} {words === 1 ? "word" : "words"} · rev {base.revision} ·{" "}
          {saveLabel[saveState]}
          {base.modifiedBy && saveState === "idle"
            ? ` · ${relativeFromNanos(base.modified)}`
            : ""}
        </span>
        <span className="nuance-editor-actions">
          <IconButton
            disabled={busy || !dirty || !!incoming}
            label="Save now"
            onClick={() => void save()}
          >
            ⌸
          </IconButton>
          <IconButton
            disabled={busy || !!incoming}
            label="Save to Nuance as a private draft"
            onClick={() => void publish(true)}
          >
            ⌥
          </IconButton>
          <IconButton
            disabled={busy || !canPublish || !!incoming}
            label={
              canPublish
                ? "Publish to Nuance"
                : "Add a title, body, and at least one tag to publish"
            }
            onClick={() => void publish(false)}
            tone="accent"
          >
            ↥
          </IconButton>
          <IconButton
            disabled={busy}
            label="Discard this draft"
            onClick={() => void discard()}
            tone="danger"
          >
            ␡
          </IconButton>
        </span>
      </footer>

      {toNumber(base.wordCount) > 0 && !canPublish ? (
        <p className="nt-help nuance-publish-hint">
          Publishing needs a title, a body, and 1–{MAX_TAGS} tags.
        </p>
      ) : null}
    </div>
  );
}
