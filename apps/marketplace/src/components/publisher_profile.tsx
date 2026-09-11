import { useEffect, useRef, useState } from "react";
import type { AppListing, DiscountPreference, MarketplaceClient, PublisherProfile } from "../view-types.ts";
import { AppCard } from "./app_card.tsx";
import { ErrorNote, Loading, Modal, Principal, errorMessage, useRead } from "./primitives.tsx";

export function PublisherIdentity({ profile }: { profile: PublisherProfile }) {
  return <div className="mp-profile-identity"><span className="mp-profile-avatar" aria-hidden="true">{profile.name.slice(0, 1).toUpperCase()}</span><div><h2>{profile.name}</h2><span className="mp-profile-id">{profile.id}</span></div></div>;
}

export function PublisherProfileDialog({ client, publisherId, discount, close, select, publisher }: {
  client: MarketplaceClient; publisherId: string; discount: DiscountPreference; close: () => void;
  select: (app: AppListing) => void; publisher: (id: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const read = useRead(publisherId, () => client.publisherProfile(publisherId), revision);
  const catalog = useRead(publisherId, () => client.publisherCatalog(publisherId), revision);
  const [moreApps, setMoreApps] = useState<AppListing[]>([]), [nextCursor, setNextCursor] = useState<string | null | undefined>();
  const [loadingMore, setLoadingMore] = useState(false), [pageError, setPageError] = useState("");
  const requestGeneration = useRef(0), paging = useRef(false);
  useEffect(() => {
    requestGeneration.current++; paging.current = false; setMoreApps([]); setNextCursor(undefined); setLoadingMore(false); setPageError("");
    return () => { requestGeneration.current++; };
  }, [publisherId, revision]);
  const cursor = nextCursor === undefined ? catalog.data?.nextCursor : nextCursor;
  const apps = [...(catalog.data?.items ?? []), ...moreApps].filter((app, index, all) => all.findIndex(other => other.id === app.id) === index);
  async function loadMore() {
    if (!cursor || paging.current) return;
    paging.current = true; setLoadingMore(true); setPageError("");
    const generation = requestGeneration.current;
    try {
      const page = await client.publisherCatalog(publisherId, cursor);
      if (generation !== requestGeneration.current) return;
      setMoreApps(previous => [...previous, ...page.items]); setNextCursor(page.nextCursor);
      if (page.warning) setPageError(page.warning);
    } catch (cause) { if (generation === requestGeneration.current) setPageError(errorMessage(cause)); }
    finally { if (generation === requestGeneration.current) { paging.current = false; setLoadingMore(false); } }
  }
  const profile = read.data;
  return <Modal wide title="Publisher" close={close}>
    <div className="mp-profile-page">
      <ErrorNote error={read.error} retry={() => setRevision(value => value + 1)} />
      {read.loading && !profile && <Loading label="Loading publisher…" />}
      {profile && <>
        <PublisherIdentity profile={profile} />
        <div className="mp-detail-stats mp-profile-stats">
          <div><strong>{profile.statsComplete ? profile.rating === null ? "New" : `${profile.rating.toFixed(1)} ★` : "—"}</strong><span>{profile.statsComplete ? profile.ratingCount ? `${profile.ratingCount.toLocaleString()} app ratings` : "No ratings yet" : "Ratings updating"}</span></div>
          <div><strong>{profile.statsComplete ? BigInt(profile.totalUsers).toLocaleString("en-US") : "—"}</strong><span>Users</span></div>
        </div>
        <p className="mp-muted mp-profile-stats-note">Users are distinct Neutrons that acquired an app from this publisher. Ratings combine reviews across their apps.</p>
        {profile.description && <p className="mp-description">{profile.description}</p>}
        <div className="mp-profile-principal"><span>Publisher principal</span><Principal value={profile.principal} /></div>
      </>}
      <section className="mp-profile-apps"><h3>Apps by {profile?.name ?? publisherId}</h3>
        <ErrorNote error={catalog.error} retry={() => setRevision(value => value + 1)} />
        <ErrorNote error={pageError} retry={() => void loadMore()} />
        {catalog.loading && !catalog.data ? <Loading label="Loading publisher apps…" /> : apps.length > 0 ? <div className="mp-app-grid">{apps.map(app => <AppCard key={app.id} app={app} discount={discount} select={() => select(app)} publisher={publisher} />)}</div> : !catalog.error && <p className="mp-muted">No apps are available from this publisher yet.</p>}
        {cursor && <button type="button" className="mp-secondary mp-load-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show more apps"}</button>}
      </section>
    </div>
  </Modal>;
}
