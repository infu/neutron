import { useEffect, useId, useRef, useState } from "react";
import type { AppDetail, AppListing, MarketplaceClient, Page, ReleaseIdentity, VersionComment } from "../view-types.ts";
import { ErrorNote, Loading, Principal, dateLabel, errorMessage } from "./primitives.tsx";
import "./ratings.css";

const buckets = [[5, "five"], [4, "four"], [3, "three"], [2, "two"], [1, "one"]] as const;

export function exactRatingCount(app: AppListing): bigint {
  return app.ratingHistogramComplete === true && app.ratingBuckets
    ? buckets.reduce((total, [, field]) => total + BigInt(app.ratingBuckets![field]), 0n)
    : BigInt(app.ratingCount);
}

export function RatingSummary({ app }: { app: AppListing }) {
  const complete = app.ratingHistogramComplete === true && !!app.ratingBuckets;
  const empty = app.ratingCount === 0;
  const counts = buckets.map(([stars, field]) => ({ stars, count: complete ? BigInt(app.ratingBuckets![field]) : empty ? 0n : null }));
  const count = exactRatingCount(app);
  const max = counts.reduce((largest, bucket) => bucket.count !== null && bucket.count > largest ? bucket.count : largest, 0n);
  const rated = count > 0n && app.rating !== null;
  return <>
    <div className="mp-rating-distribution">
      <div className="mp-rating-summary">
        <strong className={`mp-rating-summary-average${rated ? "" : " mp-rating-unrated"}`} aria-label={rated ? `Average rating: ${app.rating!.toFixed(1)} out of 5` : "Unrated"}>{rated ? app.rating!.toFixed(1) : "Unrated"}</strong>
        {rated && <span>out of 5</span>}
        <span className="mp-rating-summary-count">{count.toLocaleString("en-US")} {count === 1n ? "rating" : "ratings"}</span>
      </div>
      <ol className="mp-rating-histogram" aria-label="Rating distribution, from 5 stars to 1 star">
        {counts.map(({ stars, count: bucketCount }) => <li className="mp-rating-bucket" data-stars={stars} data-count={bucketCount?.toString()} key={stars} aria-label={`${stars} ${stars === 1 ? "star" : "stars"}: ${bucketCount === null ? "count updating" : `${bucketCount.toLocaleString("en-US")} ratings`}`}>
          <span className="mp-rating-bucket-stars" aria-hidden="true">{stars} <span>★</span></span>
          <span className="mp-rating-bar" aria-hidden="true"><span style={{ width: `${bucketCount === null || max === 0n ? 0 : Number(bucketCount * 10_000n / max) / 100}%` }} /></span>
          <span className="mp-rating-bucket-count" aria-hidden="true">{bucketCount === null ? "…" : bucketCount.toLocaleString("en-US")}</span>
        </li>)}
      </ol>
    </div>
    {!complete && !empty && <p className="mp-muted">The rating breakdown is updating.</p>}
  </>;
}

function OwnershipNote({ connected, installed, connect, refresh, kind }: { connected: boolean; installed: boolean; connect: () => Promise<unknown>; refresh: () => void; kind: "rating" | "comment" }) {
  return <p className="mp-muted">{connected ? installed ? `${kind === "rating" ? "Ratings" : "Comments"} are available for Marketplace acquisitions.` : `Get this app to leave a ${kind}. Free apps are eligible too.` : <button type="button" className="mp-text-button" onClick={() => { void connect().then(refresh, () => {}); }}>Retry ownership check</button>}</p>;
}

export function PermanentRating({ client, detail, connected, installed, connect, refresh }: {
  client: MarketplaceClient; detail: AppDetail; connected: boolean; installed: boolean; connect: () => Promise<unknown>; refresh: () => void;
}) {
  const [open, setOpen] = useState(false), [stars, setStars] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save() {
    if (!stars || busy) return;
    setBusy(true); setError("");
    try { await client.rate(detail.id, stars, ""); setOpen(false); refresh(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <section className="mp-ratings mp-stack" aria-label="Ratings">
    <div className="mp-section-title"><h3>Ratings</h3><span className="mp-muted">All versions</span></div>
    <RatingSummary app={detail} />
    <p className="mp-muted">App ratings stay across releases. Each owner has one editable rating.</p>
    {detail.owned ? <>
      <div className="mp-section-title"><h3>Your rating</h3>{!open && <button type="button" className="mp-secondary" onClick={() => { setStars(detail.ownRating?.stars ?? 0); setError(""); setOpen(true); }}>{detail.ownRating ? "Edit rating" : "Rate app"}</button>}</div>
      {open ? <div className="mp-stack">
        <div className="mp-star-picker" role="radiogroup" aria-label="Your rating">{[1, 2, 3, 4, 5].map((value) => <button type="button" role="radio" aria-checked={stars === value} aria-label={`${value} ${value === 1 ? "star" : "stars"}`} tabIndex={value === (stars || 1) ? 0 : -1} className={value <= stars ? "mp-star-active" : ""} data-stars={value} key={value} disabled={busy} onClick={() => setStars(value)} onKeyDown={(event) => {
          const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? value % 5 + 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (value + 3) % 5 + 1 : event.key === "Home" ? 1 : event.key === "End" ? 5 : null;
          if (next === null) return;
          event.preventDefault(); setStars(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-stars="${next}"]`)?.focus();
        }}>★</button>)}</div>
        <ErrorNote error={error} />
        <div className="mp-button-row"><button type="button" className="mp-secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button type="button" className="mp-primary" disabled={busy || !stars} onClick={() => void save()}>{busy ? "Saving…" : "Save rating"}</button></div>
      </div> : detail.ownRating && <div className="mp-own-review"><span aria-label={`Your rating: ${detail.ownRating.stars} stars`}>{"★".repeat(detail.ownRating.stars)}{"☆".repeat(5 - detail.ownRating.stars)}</span></div>}
    </> : <OwnershipNote connected={connected} installed={installed} connect={connect} refresh={refresh} kind="rating" />}
  </section>;
}

export function releaseCommentKey(appId: string, release: ReleaseIdentity): string {
  return JSON.stringify([appId, release.candidateId, release.version, release.digest]);
}

function CommentCard({ comment, own = false }: { comment: VersionComment; own?: boolean }) {
  const updated = comment.updatedAt !== comment.createdAt;
  return <article className={`mp-version-comment${own ? " mp-version-comment-own" : ""}`} data-comment-id={comment.id}>
    <header>{own ? <strong>Your comment</strong> : <Principal value={comment.owner} />}<span className="mp-muted">{updated ? "Edited " : ""}{dateLabel(updated ? comment.updatedAt : comment.createdAt)}</span></header>
    <p className="mp-description">{comment.text}</p>
  </article>;
}

export function VersionComments({ client, detail, release, connected, installed, connect, refresh }: {
  client: MarketplaceClient; detail: AppDetail; release: ReleaseIdentity; connected: boolean; installed: boolean; connect: () => Promise<unknown>; refresh: () => void;
}) {
  const inputId = useId();
  const [page, setPage] = useState<Page<VersionComment> | null>(detail.comments ?? null);
  const [own, setOwn] = useState<VersionComment | null>(detail.ownComment ?? null);
  const [open, setOpen] = useState(false), [text, setText] = useState("");
  const [saving, setSaving] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(""), [readError, setReadError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setPage(detail.comments ?? null); setOwn(detail.ownComment ?? null); setLoading(false); setReadError("");
    if (!detail.comments) void readComments();
    return () => { generation.current += 1; };
  }, [detail.comments, detail.ownComment]);
  async function readComments(cursor?: string) {
    const request = generation.current;
    setLoading(true); setReadError("");
    try {
      const result = await client.comments(detail.id, release, cursor);
      if (request !== generation.current) return;
      setPage((previous) => ({ ...result, items: cursor ? [...new Map([...(previous?.items ?? []), ...result.items].map((comment) => [comment.id, comment])).values()] : result.items }));
    } catch (cause) { if (request === generation.current) setReadError(errorMessage(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }
  async function save() {
    if (saving) return;
    setSaving(true); setError("");
    try { await client.comment(detail.id, release, text); setOpen(false); refresh(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  const peers = page?.items.filter((comment) => comment.id !== own?.id) ?? [];
  return <section className="mp-version-comments mp-stack" aria-label={`Comments for v${release.version}`}>
    <div className="mp-section-title"><h3>Comments for v{release.version}</h3>{detail.owned && !open && <button type="button" className="mp-secondary" onClick={() => { setText(own?.text ?? ""); setError(""); setOpen(true); }}>{own ? "Edit comment" : "Write comment"}</button>}</div>
    {open && <div className="mp-stack"><label htmlFor={inputId}>Your comment for v{release.version}</label><textarea id={inputId} value={text} onChange={(event) => setText(event.target.value)} rows={3} disabled={saving} placeholder="What works well for you?" /><ErrorNote error={error} /><div className="mp-button-row"><button type="button" className="mp-secondary" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button type="button" className="mp-primary" disabled={saving || text === (own?.text ?? "")} onClick={() => void save()}>{saving ? "Saving…" : "Save comment"}</button></div></div>}
    <ErrorNote error={readError} retry={() => void readComments(page?.nextCursor ?? undefined)} />
    {loading && !page && <Loading label="Loading comments…" />}
    {own && <CommentCard comment={own} own />}
    {peers.map((comment) => <CommentCard key={comment.id} comment={comment} />)}
    {page && !page.nextCursor && !own && peers.length === 0 && <p className="mp-muted">No comments yet for v{release.version}.</p>}
    {page?.nextCursor && <div><button type="button" className="mp-secondary" disabled={loading} onClick={() => void readComments(page.nextCursor!)}>{loading ? "Loading…" : "Show more comments"}</button></div>}
    <p className="mp-muted">Comments belong to this version. They are removed when this version is no longer offered.</p>
    {!detail.owned && <OwnershipNote connected={connected} installed={installed} connect={connect} refresh={refresh} kind="comment" />}
  </section>;
}
