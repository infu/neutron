import { useEffect, useState } from "react";
import type { AppListing, DiscountPreference } from "../view-types.ts";
import { AppPrice } from "./discount.tsx";
import { AppIcon, acquisitionStats } from "./primitives.tsx";

export function PublisherLink({ app, open }: { app: Pick<AppListing, "publisherId">; open: (id: string) => void }) {
  return app.publisherId ? <button type="button" className="mp-publisher-link" onClick={() => open(app.publisherId!)} aria-label={`View publisher ${app.publisherId}`} aria-haspopup="dialog">{app.publisherId}</button> : null;
}

/** The title button covers the card; publisher details are available in the app dialog. */
export function AppCard({ app, discount, select, size = "small" }: {
  app: AppListing; discount: DiscountPreference; select: () => void;
  size?: "large" | "medium" | "small";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [app.coverUrl]);
  const acquisitions = acquisitionStats(app), art = size !== "small" && app.coverUrl && !failed;
  const category = app.tags?.length ? app.tags.map(tag => tag.name).join(" · ") : app.category;
  const owned = app.owned || app.installed || app.installedVersion;
  return <article className={`mp-app-card mp-card-${size}`}>
    {art && <img className="mp-card-art" src={app.coverUrl} alt="" loading={size === "large" ? "eager" : "lazy"} decoding="async" onError={() => setFailed(true)} />}
    {size !== "small" && <div className="mp-card-glass" aria-hidden="true" />}
    <div className="mp-card-content">
      {size === "large" && <div className="mp-card-editorial"><h4>{app.headline || app.title}</h4><p>{app.subtitle || app.summary}</p></div>}
      <div className="mp-card-main"><AppIcon app={app} /><div className="mp-card-copy">
        <button className="mp-card-open" type="button" onClick={select} aria-label={app.title} aria-haspopup="dialog"><strong>{app.title}</strong></button>
        <span className="mp-card-category" title={category}>{category}{app.channel === "beta" && <> · Beta v{app.version}</>}</span>
      </div><span className="mp-card-price">{size === "large" ? "View" : owned ? "Owned" : app.priceUsdMicros === "0" ? "Get" : <AppPrice micros={app.priceUsdMicros} discount={discount} />}</span></div>
    </div>
    <div className="mp-sr-only">{app.summary}{acquisitions && <span className="mp-acquisitions">{acquisitions.count} {acquisitions.label}</span>}</div>
  </article>;
}
