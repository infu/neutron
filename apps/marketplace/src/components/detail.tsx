import { useState } from "react";
import type { AppListing, InstallationQuote, MarketplaceClient, DiscountPreference } from "../view-types.ts";
import { AppPrice, discountedPrice, noDiscount } from "./discount.tsx";
import { PublisherLink } from "./app_card.tsx";
import { InstallControl } from "./install.tsx";
import { AppIcon, ErrorNote, Icon, Loading, Modal, Principal, acquisitionStats, dateLabel, usd, useRead } from "./primitives.tsx";
import { PermanentRating, VersionComments, exactRatingCount, releaseCommentKey } from "./ratings.tsx";

export function AppDetailDialog({ client, app, close, acquire, install, connected, connect, installing = false, discount = noDiscount, publisher, refreshRevision = 0 }: {
  client: MarketplaceClient; app: AppListing; close: () => void; acquire: (app: AppListing) => void;
  install: (ids: string[], quote: InstallationQuote) => Promise<void> | void; connected: boolean; connect: () => Promise<unknown>; installing?: boolean; discount?: DiscountPreference; publisher: (id: string) => void; refreshRevision?: number;
}) {
  const [revision, setRevision] = useState(0);
  const read = useRead(JSON.stringify([app.id, app.releasePreferences, app.releaseSelection, app.channel ?? "stable", app.version]), () => client.detail(app.id), revision + refreshRevision);
  const detail = read.data, shown = detail ?? app;
  const acquisitions = acquisitionStats(shown);
  const ratingCount = exactRatingCount(shown);
  const installed = detail?.installed ?? (app.installed || !!(detail?.installedVersion ?? app.installedVersion));
  const installedVersion = detail?.installedVersion ?? app.installedVersion;
  const aheadOfStable = installed && shown.channel !== "beta" && !!installedVersion && /^\d+$/.test(installedVersion) && /^\d+$/.test(shown.version) && BigInt(installedVersion) > BigInt(shown.version);
  const isFree = BigInt(shown.priceUsdMicros) === 0n;
  const footerNote = installed && !shown.owned
    ? isFree ? "Installed. Get this app to add it to My Apps." : "Installed. Buy this app to get future updates."
    : aheadOfStable ? "Ahead of stable — waiting for a stable release"
    : installed ? "Installed. Manage app updates in Settings."
    : shown.owned ? "Owned by this Neutron · Future updates included" : "One acquisition. All future approved updates.";
  const refresh = () => setRevision((v) => v + 1);
  const selectionIdentity = JSON.stringify([shown.id, shown.releasePreferences, shown.releaseSelection, shown.channel ?? "stable", shown.version, detail?.selectedRelease?.candidateId, detail?.selectedRelease?.digest]);
  return <Modal title={shown.title} close={close} wide footer={<><span className="mp-muted mp-footer-note">{footerNote}</span>{shown.channel === "beta" && <span className="mp-badge mp-release-beta">Beta v{shown.version}</span>}{shown.owned ? <InstallControl client={client} appIds={[shown.id]} selectionIdentity={selectionIdentity} disabled={installed} busy={installing} label={installed ? "Installed" : "Install app"} onInstall={install} className="mp-primary" /> : <button className="mp-primary" type="button" onClick={() => acquire(shown)}>{isFree ? "Get app" : `${installed ? "Buy" : "Get"} · ${usd(discountedPrice(shown.priceUsdMicros, discount))}`}</button>}</>}>
    <div className="mp-detail-hero"><AppIcon app={shown} large /><div><span className="mp-eyebrow">{shown.category}</span><h2>{shown.title}</h2><PublisherLink app={shown} open={publisher} /><p>{shown.summary}</p></div></div>
    <div className="mp-detail-stats"><div><strong>{ratingCount === 0n || shown.rating === null ? "Unrated" : `${shown.rating.toFixed(1)} ★`}</strong><span>{ratingCount.toLocaleString("en-US")} {ratingCount === 1n ? "rating" : "ratings"}</span></div><div><strong>{shown.owned ? "Owned" : <AppPrice micros={shown.priceUsdMicros} discount={discount} />}</strong><span>{installed && !shown.owned ? "Installed on this Neutron" : "Future updates included"}</span></div><div><strong className="mp-detail-version">v{shown.version}{shown.channel === "beta" && <span className="mp-badge">Beta</span>}</strong><span>{shown.channel === "beta" ? "Latest beta version" : "Latest stable version"}</span></div>{acquisitions && <div><strong>{acquisitions.count}</strong><span>{acquisitions.label === "added" ? "Added · All time" : "Purchases · All time"}</span></div>}</div>
    <ErrorNote error={read.error} retry={() => setRevision((v) => v + 1)} />
    {read.loading && !detail && <Loading label="Loading app details…" />}
    {detail && <div className="mp-stack">
      {detail.screenshots.length > 0 && <div className="mp-screenshots" aria-label="App screenshots">{detail.screenshots.map((shot, index) => <figure key={`${shot.url}-${index}`}><img src={shot.url} alt={shot.caption || `${detail.title} screenshot ${index + 1}`} loading="lazy" />{shot.caption && <figcaption>{shot.caption}</figcaption>}</figure>)}</div>}
      <section><h3>About this app</h3><p className="mp-description">{detail.description}</p></section>
      {detail.releaseNotes && <section><h3>What’s new</h3><p className="mp-description">{detail.releaseNotes}</p></section>}
      {detail.audit && <details className={`mp-audit ${detail.audit.verdict === "approved" ? "" : "mp-audit-warning"}`}><summary><span><Icon name="shield" />{detail.audit.verdict === "approved" ? "Audited by AI" : detail.audit.verdict === "revoked" ? "Release approval revoked" : "Release rejected"}</span><span className="mp-muted">View review</span></summary><div className="mp-stack"><p className="mp-description">{detail.audit.analysis}</p><dl className="mp-facts"><div><dt>Auditor</dt><dd><Principal value={detail.audit.auditor} /></dd></div><div><dt>Reviewed</dt><dd>{dateLabel(detail.audit.date)}</dd></div></dl><details><summary>Reviewed package hash</summary><code className="mp-hash">{detail.audit.packageHash}</code></details><p className="mp-muted">This review applies to these package bytes. It is not a guarantee of every app behavior.</p></div></details>}
      <section className="mp-publisher-info"><h3>Publisher</h3><PublisherLink app={detail} open={publisher} />{detail.publisherName && <span>{detail.publisherName}</span>}<Principal value={detail.publisher} />{detail.website && <a href={detail.website} target="_blank" rel="noreferrer">Publisher website ↗</a>}{detail.sourceUrl && <a href={detail.sourceUrl} target="_blank" rel="noreferrer">Offered source ↗</a>}</section>
      <PermanentRating key={detail.id} client={client} detail={detail} connected={connected} installed={installed} connect={connect} refresh={refresh} />
      {detail.selectedRelease && <VersionComments key={releaseCommentKey(detail.id, detail.selectedRelease)} client={client} detail={detail} release={detail.selectedRelease} connected={connected} installed={installed} connect={connect} refresh={refresh} />}
    </div>}
  </Modal>;
}
