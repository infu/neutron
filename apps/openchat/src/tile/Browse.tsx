import { useCallback, useEffect, useRef, useState } from "react";
import { cx, nt } from "neutron-design-system";
import {
  IoSearchOutline,
  IoSend,
  IoPeopleOutline,
  IoReloadOutline,
  IoCompassOutline,
  IoCheckmarkCircle,
  IoLockClosedOutline,
  IoAdd,
} from "react-icons/io5";
import type { DirectoryEntryVM, JoinResultVM, UserVM, WhoAmIVM } from "../shared/protocol.ts";
import { oc } from "../shared/rpc.ts";
import { Avatar, EmptyState, IconButton, Nav, TopProgress, submitOnEnter, type TileView } from "./ui.tsx";
import { ClearUnreadButton, ProfileButton, SignOutButton } from "./Chats.tsx";

export function Browse({
  who,
  view,
  onNav,
  onReload,
}: {
  who: WhoAmIVM;
  view: TileView;
  onNav: (v: TileView) => void;
  onReload: () => void;
}): React.ReactNode {
  return (
    <div className="oc-app">
      <header className="oc-topbar">
        <div className="oc-topbar__left">
          <Nav view={view} onNav={onNav} />
          <ClearUnreadButton />
        </div>
        <div className="oc-topbar__actions">
          <ProfileButton who={who} onChanged={onReload} />
          <SignOutButton onSignedOut={onReload} />
        </div>
      </header>
      <div className="oc-browse__scroll">
        <Discover />
        <FindPeople />
      </div>
    </div>
  );
}

function Discover(): React.ReactNode {
  const [kind, setKind] = useState<"community" | "group">("community");
  const [term, setTerm] = useState("");
  const [entries, setEntries] = useState<DirectoryEntryVM[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(
    (k: "community" | "group", t: string) => {
      const id = ++seq.current;
      setBusy(true);
      setError(null);
      const p = k === "community" ? oc.exploreCommunities(t || undefined) : oc.exploreGroups(t || undefined);
      p.then((res) => {
        if (id === seq.current) setEntries(res);
      })
        .catch((e: unknown) => {
          if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (id === seq.current) setBusy(false);
        });
    },
    [],
  );

  // Load the popular list on mount and whenever the kind switches.
  useEffect(() => {
    setEntries([]);
    query(kind, term.trim());
    return () => { seq.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  return (
    <section className="oc-panel">
      <div className="oc-panel__head">
        <h2 className="oc-panel__title">Discover</h2>
        <div className="oc-segmented" role="tablist" aria-label="Directory">
          {(["community", "group"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={cx("oc-seg", { "oc-seg--on": kind === k })}
              onClick={() => setKind(k)}
            >
              {k === "community" ? <IoCompassOutline size={13} aria-hidden /> : <IoPeopleOutline size={13} aria-hidden />}
              {k === "community" ? "Communities" : "Groups"}
            </button>
          ))}
        </div>
      </div>
      <div className="oc-search">
        <input
          className={cx(nt.input, "oc-search__input")}
          placeholder={`Search ${kind === "community" ? "communities" : "groups"} (or leave blank for popular)`}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={submitOnEnter(() => query(kind, term.trim()))}
          data-tid="oc-discover-search"
        />
        <IconButton
          icon={busy ? IoReloadOutline : IoSearchOutline}
          label="Search directory"
          onClick={() => query(kind, term.trim())}
          disabled={busy}
          tid="oc-discover-go"
        />
      </div>
      <div className="oc-directory">
        <TopProgress show={busy} />
        {error ? <div role="alert"><EmptyState title="Couldn't load directory" hint={error} /></div> : null}
        {entries.length === 0 ? (
          busy || error ? null : <EmptyState title="Nothing found" hint="Try a different search." />
        ) : (
          <ul className="oc-dir-list" role="list">
            {entries.map((e) => (
              <DirectoryRow key={e.id} entry={e} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DirectoryRow({ entry }: { entry: DirectoryEntryVM }): React.ReactNode {
  const [result, setResult] = useState<JoinResultVM | null>(null);
  const [busy, setBusy] = useState(false);

  const join = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(entry.kind === "community" ? await oc.joinCommunity(entry.id) : await oc.joinGroup(entry.id));
    } catch (e) {
      setResult({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [entry]);

  const joined = result?.kind === "joined" || result?.kind === "already_member";
  return (
    <li className="oc-dir">
      <Avatar seed={entry.id} label={entry.name} size={30} />
      <div className="oc-dir__main">
        <div className="oc-dir__top">
          <span className="oc-dir__name">
            {entry.name}
            {entry.verified ? <IoCheckmarkCircle size={12} aria-label="verified" className="oc-verified" /> : null}
            {entry.gated ? <IoLockClosedOutline size={11} aria-label="gated" className="oc-gated" /> : null}
          </span>
          <span className="oc-dir__meta">
            {formatCount(entry.members)}
            {entry.channels ? ` · ${entry.channels} ch` : ""}
          </span>
        </div>
        {entry.description ? <span className="oc-dir__desc">{entry.description}</span> : null}
        {result && !joined ? <span className={cx(nt.meta, "oc-dir__status")}>{joinText(result)}</span> : null}
      </div>
      <button
        type="button"
        className={cx("oc-join-btn", { "oc-join-btn--done": joined })}
        onClick={() => void join()}
        disabled={busy || joined}
        title={joined ? "Joined" : `Join ${entry.kind}`}
      >
        {busy ? <IoReloadOutline className="oc-spin" size={14} aria-hidden /> : joined ? <IoCheckmarkCircle size={14} aria-hidden /> : <IoAdd size={14} aria-hidden />}
        <span>{joined ? "Joined" : "Join"}</span>
      </button>
    </li>
  );
}

function FindPeople(): React.ReactNode {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<UserVM[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!term.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await oc.search(term.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [term, busy]);

  return (
    <section className="oc-panel">
      <h2 className="oc-panel__title">Find people</h2>
      <div className="oc-search">
        <input
          className={cx(nt.input, "oc-search__input")}
          placeholder="Search users by username"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={submitOnEnter(() => void run())}
          data-tid="oc-search-input"
        />
        <IconButton icon={busy ? IoReloadOutline : IoSearchOutline} label="Search" onClick={() => void run()} disabled={busy || !term.trim()} tid="oc-search-go" />
      </div>
      {error ? <div role="alert"><EmptyState title="Couldn't search users" hint={error} /></div> : null}
      {results === null || error ? null : results.length === 0 ? (
        <EmptyState title="No users found" />
      ) : (
        <ul className="oc-users" role="list">
          {results.map((u) => (
            <UserRow key={u.userId} user={u} />
          ))}
        </ul>
      )}
    </section>
  );
}

function UserRow({ user }: { user: UserVM }): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setStatus(null);
    try {
      const res = await oc.dmUser(user.userId, text.trim());
      setStatus(res.kind === "error" ? (res.message ?? "Failed") : "Sent");
      if (res.kind !== "error") setText("");
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [text, sending, user.userId]);

  return (
    <li className="oc-user">
      <button type="button" className="oc-user__head" onClick={() => setOpen((o) => !o)}>
        <span className="oc-user__name">{user.displayName || user.username}</span>
        <span className={nt.muted}>@{user.username}</span>
      </button>
      {open ? (
        <div className="oc-dm">
          <input
            className={cx(nt.input, "oc-dm__input")}
            placeholder={`Message @${user.username}`}
            value={text}
            maxLength={10000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={submitOnEnter(() => void send())}
            disabled={sending}
          />
          <IconButton icon={IoSend} label="Send DM" onClick={() => void send()} disabled={sending || !text.trim()} />
          {status ? <span className={cx(nt.meta, "oc-dm__status")}>{status}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k members`;
  return `${n} member${n === 1 ? "" : "s"}`;
}

function joinText(r: JoinResultVM): string {
  switch (r.kind) {
    case "gate_blocked":
      return r.message ?? "Requires membership gate you can't satisfy";
    case "not_found":
      return "Not found";
    case "error":
      return r.message ?? "Couldn't join";
    default:
      return "";
  }
}
