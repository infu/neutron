import type { AppListing, DiscountPreference } from "../view-types.ts";
import { AppPrice } from "./discount.tsx";
import { AppIcon, acquisitionStats } from "./primitives.tsx";

export function PublisherLink({ app, open }: { app: Pick<AppListing, "publisherId">; open: (id: string) => void }) {
  return app.publisherId ? <button type="button" className="mp-publisher-link" onClick={() => open(app.publisherId!)} aria-label={`View publisher ${app.publisherId}`} aria-haspopup="dialog">{app.publisherId}</button> : null;
}

/** The title button covers the card; the publisher is a separate native button. */
export function AppCard({ app, discount, select, publisher }: {
  app: AppListing; discount: DiscountPreference; select: () => void; publisher: (id: string) => void;
}) {
  const acquisitions = acquisitionStats(app);
  return <article className="mp-app-card">
    <div className="mp-card-main"><AppIcon app={app} /><div className="mp-card-copy">
      <button className="mp-card-open" type="button" onClick={select} aria-label={app.title} aria-haspopup="dialog"><strong>{app.title}</strong></button>
      <PublisherLink app={app} open={publisher} />
      <span className="mp-card-category">{app.category}</span><span className="mp-card-summary">{app.summary}</span>
    </div></div>
    <div className="mp-card-bottom"><span className="mp-card-metrics"><span className="mp-rating">{app.rating === null ? "New" : <>{app.rating.toFixed(1)} <span aria-hidden="true">★</span> <small>({app.ratingCount.toLocaleString()})</small></>}</span>{acquisitions && <span className="mp-acquisitions" title="All time">{acquisitions.count} {acquisitions.label}</span>}</span><span className="mp-card-price">{app.owned || app.installed || app.installedVersion ? "Owned" : <AppPrice micros={app.priceUsdMicros} discount={discount} />}</span></div>
  </article>;
}
