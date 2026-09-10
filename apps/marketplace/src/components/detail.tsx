import { useState } from "react";
import type { AppListing, InstallationQuote, MarketplaceClient } from "../view-types.ts";
import { InstallControl } from "./install.tsx";
import { AppIcon, ErrorNote, Icon, Loading, Modal, Principal, dateLabel, errorMessage, usd, useRead } from "./primitives.tsx";

export function AppDetailDialog({ client, app, close, acquire, install, connected, connect, installing = false }: {
  client: MarketplaceClient; app: AppListing; close: () => void; acquire: (app: AppListing) => void;
  install: (ids: string[], quote: InstallationQuote) => Promise<void> | void; connected: boolean; connect: () => Promise<unknown>; installing?: boolean;
}) {
  const [revision, setRevision] = useState(0), [ratingOpen, setRatingOpen] = useState(false), [rating, setRating] = useState(0), [review, setReview] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const read = useRead(app.id, () => client.detail(app.id), revision);
  const detail = read.data, shown = detail ?? app;
  const installed = "installedVersion" in app && typeof app.installedVersion === "string";
  async function saveRating() {
    if (!rating) return;
    setBusy(true); setError("");
    try { await client.rate(app.id, rating, review.trim()); setRevision((v) => v + 1); setRatingOpen(false); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Modal title={shown.title} close={close} wide footer={<><span className="mp-muted mp-footer-note">{installed ? "Installed. Manage app updates in Settings." : shown.owned ? "Owned by this Neutron · Future updates included" : "One acquisition. All future approved updates."}</span>{shown.owned || installed ? <InstallControl client={client} appIds={[shown.id]} disabled={installed} busy={installing} label={installed ? "Installed" : "Install app"} onInstall={install} className="mp-primary" /> : <button className="mp-primary" type="button" onClick={() => acquire(shown)}>{BigInt(shown.priceUsdMicros) === 0n ? "Get app" : `Get · ${usd(shown.priceUsdMicros)}`}</button>}</>}>
    <div className="mp-detail-hero"><AppIcon app={shown} large /><div><span className="mp-eyebrow">{shown.category}</span><h2>{shown.title}</h2><p>{shown.summary}</p></div></div>
    <div className="mp-detail-stats"><div><strong>{shown.rating === null ? "New" : `${shown.rating.toFixed(1)} ★`}</strong><span>{shown.ratingCount ? `${shown.ratingCount.toLocaleString()} ratings` : "No ratings yet"}</span></div><div><strong>{usd(shown.priceUsdMicros)}</strong><span>Future updates included</span></div><div><strong>{shown.version}</strong><span>Latest approved version</span></div></div>
    <ErrorNote error={read.error} retry={() => setRevision((v) => v + 1)} />
    {read.loading && !detail && <Loading label="Loading app details…" />}
    {detail && <div className="mp-stack">
      {detail.screenshots.length > 0 && <div className="mp-screenshots" aria-label="App screenshots">{detail.screenshots.map((shot, index) => <figure key={`${shot.url}-${index}`}><img src={shot.url} alt={shot.caption || `${detail.title} screenshot ${index + 1}`} loading="lazy" />{shot.caption && <figcaption>{shot.caption}</figcaption>}</figure>)}</div>}
      <section><h3>About this app</h3><p className="mp-description">{detail.description}</p></section>
      {detail.releaseNotes && <section><h3>What’s new</h3><p className="mp-description">{detail.releaseNotes}</p></section>}
      {detail.audit && <details className={`mp-audit ${detail.audit.verdict === "approved" ? "" : "mp-audit-warning"}`}><summary><span><Icon name="shield" />{detail.audit.verdict === "approved" ? "Approved release" : detail.audit.verdict === "revoked" ? "Release approval revoked" : "Release rejected"}</span><span className="mp-muted">View review</span></summary><div className="mp-stack"><p className="mp-description">{detail.audit.analysis}</p><dl className="mp-facts"><div><dt>Auditor</dt><dd><Principal value={detail.audit.auditor} /></dd></div><div><dt>Reviewed</dt><dd>{dateLabel(detail.audit.date)}</dd></div></dl><details><summary>Reviewed package hash</summary><code className="mp-hash">{detail.audit.packageHash}</code></details><p className="mp-muted">This review applies to these package bytes. It is not a guarantee of every app behavior.</p></div></details>}
      <section className="mp-publisher-info"><h3>Publisher</h3><Principal value={detail.publisher} />{detail.website && <a href={detail.website} target="_blank" rel="noreferrer">Publisher website ↗</a>}{detail.sourceUrl && <a href={detail.sourceUrl} target="_blank" rel="noreferrer">Offered source ↗</a>}</section>
      <section><div className="mp-section-title"><div><h3>Your rating</h3><p>One editable review per owner.</p></div>{detail.owned && !ratingOpen && <button type="button" className="mp-secondary" onClick={() => { setRating(detail.ownRating?.stars ?? 0); setReview(detail.ownRating?.text ?? ""); setRatingOpen(true); }}>{detail.ownRating ? "Edit rating" : "Rate app"}</button>}</div>{detail.owned ? ratingOpen ? <div className="mp-stack"><div className="mp-star-picker" role="radiogroup" aria-label="Rating">{[1, 2, 3, 4, 5].map((stars) => <button type="button" role="radio" aria-checked={rating === stars} aria-label={`${stars} ${stars === 1 ? "star" : "stars"}`} className={stars <= rating ? "mp-star-active" : ""} key={stars} onClick={() => setRating(stars)}>★</button>)}</div><label className="mp-sr-only" htmlFor="mp-review">Your review</label><textarea id="mp-review" value={review} onChange={(event) => setReview(event.target.value)} placeholder="What works well for you?" rows={3} /><ErrorNote error={error} /><div className="mp-button-row"><button type="button" className="mp-secondary" disabled={busy} onClick={() => setRatingOpen(false)}>Cancel</button><button type="button" className="mp-primary" disabled={busy || !rating} onClick={() => void saveRating()}>{busy ? "Saving…" : "Save rating"}</button></div></div> : detail.ownRating ? <div className="mp-own-review"><span aria-label={`${detail.ownRating.stars} stars`}>{"★".repeat(detail.ownRating.stars)}{"☆".repeat(5 - detail.ownRating.stars)}</span><p>{detail.ownRating.text}</p></div> : <p className="mp-muted">Share what you think of this app.</p> : <p className="mp-muted">{connected ? "Get this app to leave a rating. Free apps are eligible too." : <button type="button" className="mp-text-button" onClick={() => { void connect().then(() => setRevision((v) => v + 1), () => {}); }}>Connect to see your ownership and rating</button>}</p>}</section>
    </div>}
  </Modal>;
}
