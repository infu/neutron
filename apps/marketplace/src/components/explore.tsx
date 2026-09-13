import { useEffect, useRef, useState } from "react";
import type { AppListing, AppTier, DiscountPreference, MarketplaceClient, RankingWindow } from "../view-types.ts";
import { AppCard } from "./app_card.tsx";
import { ErrorNote, Icon, dateLabel, errorMessage, useRead } from "./primitives.tsx";

type Props = { client: MarketplaceClient; refresh: number; discount: DiscountPreference; select: (app: AppListing) => void; publisher: (id: string) => void };

export function Explore({ client, refresh, discount, select, publisher }: Props) {
  const [window, setWindow] = useState<RankingWindow>("week"), [search, setSearch] = useState(""), [tag, setTag] = useState<string>();
  const [retry, setRetry] = useState(0);
  const selection = { search: search.trim(), ...(tag ? { tag } : {}) };
  const home = useRead(JSON.stringify(selection), () => client.storefront ? client.storefront(selection) : Promise.resolve({ tags: [], featured: [] }), refresh + retry, search ? 200 : 0);
  // Keep category navigation available while the next filtered read is pending.
  const [tags, setTags] = useState<NonNullable<typeof home.data>["tags"]>([]);
  useEffect(() => {
    if (!home.data) return;
    setTags(home.data.tags);
    if (tag && !home.data.tags.some(value => value.id === tag)) setTag(undefined);
  }, [home.data]);
  const featured = home.data?.featured.slice(0, 2) ?? [];
  const exclude = featured.map(app => app.id);
  const category = tags.find(value => value.id === tag)?.name;
  return <div className="mp-explore">
    <div className="mp-discover-header"><div><h2>{search.trim() ? "Search results" : category ? `Discover ${category.toLowerCase()}` : "Discover apps"}</h2><p>Independent apps. New possibilities. Built for your Neutron.</p></div>
      <label className="mp-search"><Icon name="search" /><span className="mp-sr-only">Search apps</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search apps, tags, or creators…" autoComplete="off" /></label>
    </div>
    <nav className="mp-categories" aria-label="App categories"><span className="mp-category-heading">Discover</span>
      <button type="button" className={!tag ? "is-active" : ""} aria-pressed={!tag} onClick={() => setTag(undefined)}><CategoryIcon id="all" />For you</button>
      {tags.map(value => <button type="button" key={value.id} className={tag === value.id ? "is-active" : ""} aria-pressed={tag === value.id} onClick={() => setTag(value.id)}><CategoryIcon id={value.id} />{value.name}</button>)}
    </nav>
    <div className="mp-discover-content">
      <ErrorNote error={home.error} retry={() => setRetry(value => value + 1)} />
      {featured.length > 0 && <section className="mp-featured-section" aria-label="Featured apps"><div className="mp-section-heading"><h3>Featured apps</h3><span className="mp-curated-label">Selected for you</span></div><div className="mp-featured-grid">{featured.map(app => <AppCard key={app.id} size="large" app={app} discount={discount} select={() => select(app)} publisher={publisher} />)}</div></section>}
      {(!home.loading || home.data || home.error) && (["paid", "free"] as const).map(tier => <CatalogSection key={JSON.stringify([tier, window, selection, exclude])} client={client} tier={tier} window={window} changeWindow={setWindow} search={selection.search} tag={tag} exclude={exclude} refresh={refresh} discount={discount} select={select} publisher={publisher} />)}
    </div>
  </div>;
}

function CategoryIcon({ id }: { id: string }) {
  const paths: Record<string, React.ReactNode> = {
    all: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /><path d="m20 2 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z" /></>,
    games: <><path d="M7 7h10c3 0 5 10 3 11-2 1-4-3-5-3H9c-1 0-3 4-5 3C2 17 4 7 7 7Z" /><path d="M6 11h5M8.5 8.5v5M16 11h.01M18 13h.01" /></>,
    arcade: <><path d="M6 3h12l2 17H4Z" /><path d="M8 6h8v6H8zM8 16h2m5 0h1" /></>,
    crypto: <><path d="m12 3 8 9-8 9-8-9Z" /><path d="m4 12 8 3 8-3M12 3v18" /></>,
    defi: <><path d="M3 20h18M5 16v-5m7 5V7m7 9V3" /><path d="m3 7 7-4" /></>,
    preppers: <><path d="m3 20 9-17 9 17H3Zm5 0 4-8 4 8" /></>,
    social: <><circle cx="9" cy="7" r="3" /><path d="M3 20v-3a6 6 0 0 1 12 0v3ZM16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v1" /></>,
  };
  return <svg className="mp-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[id] ?? <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>}</svg>;
}

function CatalogSection({ client, tier, window, changeWindow, search, tag, exclude, refresh, discount, select, publisher }: Props & { tier: AppTier; window: RankingWindow; changeWindow: (window: RankingWindow) => void; search: string; tag: string | undefined; exclude: string[] }) {
  const [pages, setPages] = useState<AppListing[]>([]), [nextCursor, setNextCursor] = useState<string | null | undefined>(), [paging, setPaging] = useState(false), [pageError, setPageError] = useState(""), [retry, setRetry] = useState(0);
  const input = { tier, window, search, ...(tag ? { tag } : {}), ...(client.storefront ? { exclude } : {}) };
  const read = useRead(JSON.stringify(input), () => client.catalog(input), retry + refresh, search ? 200 : 0);
  const pagingActive = useRef(false), requestGeneration = useRef(0);
  useEffect(() => {
    requestGeneration.current++; pagingActive.current = false;
    setPages([]); setNextCursor(undefined); setPaging(false); setPageError("");
    return () => { requestGeneration.current++; };
  }, [refresh, retry]);
  const cursor = nextCursor === undefined ? read.data?.nextCursor : nextCursor;
  async function more() {
    if (!cursor || pagingActive.current) return;
    pagingActive.current = true; setPaging(true); setPageError("");
    const generation = requestGeneration.current;
    try {
      const page = await client.catalog({ ...input, cursor });
      if (generation === requestGeneration.current) { setPages(old => [...old, ...page.items]); setNextCursor(page.nextCursor); }
    } catch (cause) { if (generation === requestGeneration.current) setPageError(errorMessage(cause)); }
    finally { if (generation === requestGeneration.current) { pagingActive.current = false; setPaging(false); } }
  }
  const rows = [...(read.data?.items ?? []), ...pages].filter((app, index, all) => all.findIndex(other => other.id === app.id) === index);
  const title = search ? `${tier === "paid" ? "Paid" : "Free"} apps` : `Top ${tier}`;
  const card = (app: AppListing, size: "medium" | "small") => <AppCard key={app.id} size={size} app={app} discount={discount} select={() => select(app)} publisher={publisher} />;
  return <section className="mp-catalog-section" aria-label={title}>
    <div className="mp-section-heading"><h3>{title}</h3><div className="mp-section-actions">{tier === "paid" && <label className="mp-ranking-control"><span className="mp-sr-only">Ranking period</span><select value={window} onChange={event => changeWindow(event.target.value as RankingWindow)}><option value="week">7 days</option><option value="month">30 days</option><option value="all">All time</option></select></label>}{rows.length > 4 && <a className="mp-see-all" href={`#mp-more-${tier}`} onClick={event => { event.preventDefault(); document.getElementById(`mp-more-${tier}`)?.scrollIntoView({ block: "nearest" }); }}>See all <Icon name="arrow" /></a>}</div></div>
    <ErrorNote error={read.error} retry={() => setRetry(value => value + 1)} /><ErrorNote error={pageError} retry={() => void more()} />
    {read.loading && !read.data ? <div className="mp-medium-grid" aria-label={`Loading ${tier} apps`} aria-busy="true">{Array.from({ length: 4 }, (_, i) => <div className="mp-card-skeleton" key={i}><span /><div><i /><i /><i /></div></div>)}</div> : rows.length === 0 && !read.error ? <p className="mp-catalog-empty">{search || tag ? `No matching ${tier} apps.` : `New ${tier} apps are on their way.`}</p> : <>
      <div className="mp-medium-grid">{rows.slice(0, 4).map(app => card(app, "medium"))}</div>
      {rows.length > 4 && <div className="mp-quick-picks" id={`mp-more-${tier}`}><h4>{tier === "paid" ? "Quick picks" : "More free apps"}</h4><div className="mp-small-grid">{rows.slice(4).map(app => card(app, "small"))}</div></div>}
    </>}
    {cursor && <button type="button" className="mp-secondary mp-load-more" disabled={paging} onClick={() => void more()}>{paging ? "Loading…" : `Show more ${tier} apps`}</button>}
    {read.data?.asOf && <p className="mp-chart-footnote">Ranked by acquisitions · {dateLabel(read.data.asOf)}</p>}
  </section>;
}
