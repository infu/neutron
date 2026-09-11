import { useEffect, useRef, useState } from "react";
import type { MarketplaceClient, PublicationInput, PublicationQuote, PublishedApp, PublisherProfile } from "../view-types.ts";
import { AppIcon, CycleCost, EmptyState, ErrorNote, Icon, Loading, Modal, dateLabel, decimalAmount, errorMessage, parseAmount, usd, useRead } from "./primitives.tsx";
import { EXCERPT_MAX_CHARACTERS, DESCRIPTION_MAX_CHARACTERS, listingCharacterCount, validateListingText } from "../listing-text.ts";
import { PublisherIdentity } from "./publisher_profile.tsx";
import { PublisherLink } from "./app_card.tsx";
import { PublisherProfileEditor } from "./publisher_profile_editor.tsx";

type Props = {
  client: MarketplaceClient;
  connected: boolean;
  refresh: number;
  onChanged: () => void;
  publisher?: ((id: string) => void) | undefined;
};
type Draft = Omit<PublicationInput, "priceUsdMicros"> & { paid: boolean; price: string };
type Review = { input: PublicationInput; quote: PublicationQuote };
const newDraft = (): Draft => ({ appId: "", title: "", summary: "", description: "", category: "", paid: false, price: "1", website: "", releaseNotes: "", packageFile: null, sourceFile: null, iconFile: null, screenshotFiles: [] });
const statusLabels: Record<PublishedApp["status"], string> = { draft: "Draft", uploading: "Upload in progress", in_review: "Under review", approved: "Approved", rejected: "Changes requested", revoked: "Release unavailable" };

function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString()} bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}

function FilePreview({ file, remove }: { file: File; remove: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return <div className="mp-file-preview">
    {url && <img src={url} alt={file.name} />}
    <span title={file.name}>{file.name}</span>
    <button type="button" className="mp-icon-button" onClick={remove} aria-label={`Remove ${file.name}`}><Icon name="close" /></button>
  </div>;
}

export function PublisherPanel({ client, connected, refresh, onChanged, publisher }: Props) {
  const [retry, setRetry] = useState(0), [editingProfile, setEditingProfile] = useState(false);
  const [savedProfile, setSavedProfile] = useState<PublisherProfile | null>(null);
  const read = useRead(connected ? "own-publisher-profile" : null, async () => ({ profile: await client.ownPublisherProfile() }), refresh + retry);
  const profile = savedProfile ?? read.data?.profile;
  useEffect(() => { if (read.data?.profile) setSavedProfile(null); }, [read.data]);
  function saved(value: PublisherProfile) {
    setSavedProfile(value); setEditingProfile(false); setRetry(previous => previous + 1);
    onChanged();
  }
  if (!connected) return <EmptyState icon="publish" title="Your publications are unavailable">Retry setup above to load your publications and saved releases.</EmptyState>;
  if (read.loading && !read.data && !profile) return <Loading label="Loading your publisher profile…" />;
  if (read.error && !read.data && !profile) return <ErrorNote error={read.error} retry={() => setRetry(previous => previous + 1)} />;
  if (!profile) return <section className="mp-profile-setup" aria-label="Publisher setup"><ErrorNote error={read.error} retry={() => setRetry(previous => previous + 1)} /><PublisherProfileEditor client={client} profile={null} saved={saved} /></section>;
  return <div className="mp-stack">
    <section className="mp-own-profile" aria-label="Your publisher profile"><PublisherIdentity profile={profile} /><div className="mp-own-profile-actions">{publisher && <button type="button" className="mp-text-button" onClick={() => publisher(profile.id)}>View profile</button>}<button type="button" className="mp-secondary" onClick={() => setEditingProfile(true)}>Edit profile</button></div></section>
    <PublicationsList client={client} connected={connected} refresh={refresh} onChanged={onChanged} publisher={publisher} />
    {editingProfile && <Modal title="Edit publisher profile" close={() => setEditingProfile(false)}><PublisherProfileEditor client={client} profile={profile} saved={saved} /></Modal>}
  </div>;
}

function PublicationsList({ client, connected, refresh, onChanged, publisher }: Props) {
  const [apps, setApps] = useState<PublishedApp[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [readError, setReadError] = useState("");
  const [reload, setReload] = useState(0);
  const pageGeneration = useRef(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftStarted, setDraftStarted] = useState(false);
  const [editing, setEditing] = useState<PublishedApp | null>(null);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const detailGeneration = useRef(0);
  const [review, setReview] = useState<Review | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // React state updates do not synchronously exclude a second click or submit.
  const actionInFlight = useRef(false);

  useEffect(() => {
    const generation = ++pageGeneration.current;
    setApps([]); setCursor(null); setReadError(""); setLoadingMore(false);
    if (!connected) { setLoading(false); return; }
    setLoading(true);
    void client.publisherApps().then((page) => {
      if (generation !== pageGeneration.current) return;
      setApps(page.items); setCursor(page.nextCursor); setLoading(false);
      if (page.warning) setReadError(page.warning);
    }, (reason) => {
      if (generation !== pageGeneration.current) return;
      setReadError(errorMessage(reason)); setLoading(false);
    });
    return () => { pageGeneration.current++; };
  }, [client, connected, refresh, reload]);

  useEffect(() => () => { detailGeneration.current++; }, []);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    const generation = pageGeneration.current;
    setLoadingMore(true); setReadError("");
    try {
      const page = await client.publisherApps(cursor);
      if (generation !== pageGeneration.current) return;
      setApps((previous) => [...new Map([...previous, ...page.items].map((app) => [app.id, app])).values()]);
      setCursor(page.nextCursor);
      if (page.warning) setReadError(page.warning);
    } catch (reason) { if (generation === pageGeneration.current) setReadError(errorMessage(reason)); }
    finally { if (generation === pageGeneration.current) setLoadingMore(false); }
  }

  async function loadDetail(app: PublishedApp) {
    const generation = ++detailGeneration.current;
    setDetailLoading(true); setDetailError("");
    try {
      const detail = await client.detail(app.id);
      if (generation !== detailGeneration.current) return;
      setDraft((previous) => ({ ...previous, title: detail.title, summary: detail.summary, description: detail.description, category: "", paid: detail.priceUsdMicros !== "0", price: detail.priceUsdMicros === "0" ? "1" : decimalAmount({ atoms: detail.priceUsdMicros, decimals: 6, symbol: "USD" }), website: "", releaseNotes: "" }));
    } catch (reason) {
      if (generation === detailGeneration.current) setDetailError(errorMessage(reason));
    } finally { if (generation === detailGeneration.current) setDetailLoading(false); }
  }

  function openEditor(app: PublishedApp | null) {
    detailGeneration.current++;
    setDraftStarted(true);
    setEditing(app); setReview(null); setError(""); setSuccess(""); setAttempted(false); setProgress(0); setDetailError(""); setDetailLoading(false);
    setDraft(app ? { ...newDraft(), appId: app.id, title: app.title, summary: app.summary, paid: app.priceUsdMicros !== "0", price: app.priceUsdMicros === "0" ? "1" : decimalAmount({ atoms: app.priceUsdMicros, decimals: 6, symbol: "USD" }) } : newDraft());
    setEditorOpen(true);
    if (app) void loadDetail(app);
  }

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError("");
  }

  async function prepare() {
    if (actionInFlight.current || detailLoading || detailError) return;
    actionInFlight.current = true;
    setQuoting(true); setError("");
    try {
      validateListingText(draft);
      const priceUsdMicros = draft.paid ? parseAmount(draft.price, 6) : "0";
      if (draft.paid && (BigInt(priceUsdMicros) < 1_000_000n || BigInt(priceUsdMicros) > 50_000_000n)) throw new Error("Choose a price from $1 to $50, or make your app free.");
      if (!editing && !draft.packageFile) throw new Error("Choose the .neutron package for your app.");
      const { paid: _paid, price: _price, ...fields } = draft;
      const input: PublicationInput = { ...fields, appId: fields.appId.trim(), title: fields.title.trim(), summary: fields.summary.trim(), description: fields.description.trim(), category: fields.category.trim(), website: fields.website.trim(), priceUsdMicros, screenshotFiles: [...fields.screenshotFiles] };
      const quote = await client.quotePublication(input);
      // Keep the exact reviewed files and terms for execution and same-ID resume.
      setReview({ input, quote });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { actionInFlight.current = false; setQuoting(false); }
  }

  async function publish() {
    if (!review || actionInFlight.current || success) return;
    actionInFlight.current = true;
    setPublishing(true); setAttempted(true); setError("");
    try {
      const result = await client.publish(review.input, review.quote, (percent) => {
        if (Number.isFinite(percent)) setProgress(Math.max(0, Math.min(100, percent)));
      });
      setSuccess(result.message || "Your publication has been saved."); setProgress(100); setReload((value) => value + 1);
      // A refresh/listener failure cannot turn a successful upload into a retry.
      try { onChanged(); } catch (reason) { setReadError(`Publication saved. Refreshing the surrounding view failed: ${errorMessage(reason)}`); }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { actionInFlight.current = false; setPublishing(false); }
  }

  const retainedDraft = draftStarted && !success;
  const editorBusy = quoting || publishing || detailLoading;
  const excerptCharacters = listingCharacterCount(draft.summary), descriptionCharacters = listingCharacterCount(draft.description);
  const fileLabel = (file: File | null, fallback: string) => file ? `${file.name} · ${bytesLabel(file.size)}` : fallback;

  if (!connected) return <EmptyState icon="publish" title="Your publications are unavailable">Retry setup above to load your publications and saved releases.</EmptyState>;

  return <section className="mp-publisher" aria-label="Publisher apps">
    <div className="mp-section-heading"><div><h2>Your publications</h2><p className="mp-muted">Every release is reviewed before it reaches the store.</p></div>
      <button type="button" className="mp-button mp-button-primary" disabled={!retainedDraft && editorBusy} onClick={() => retainedDraft ? setEditorOpen(true) : openEditor(null)}><Icon name={retainedDraft ? "publish" : "plus"} />{retainedDraft ? review ? "Continue publication" : "Continue draft" : "Publish an app"}</button>
    </div>
    {!editorOpen && draftStarted && <div className="mp-notice" role="status"><span>{publishing ? `Uploading ${review?.input.title ?? "app"} · ${Math.round(progress)}%` : success || `Your ${review ? "publication" : "draft"} is retained here.`}</span><button type="button" className="mp-text-button" onClick={() => setEditorOpen(true)}>{review ? "View upload" : "View draft"}</button></div>}
    <ErrorNote error={readError} retry={() => setReload((value) => value + 1)} />
    {loading ? <Loading label="Loading your publications…" /> : apps.length === 0 && !readError ? <EmptyState icon="publish" title="Your first app starts here">Add your package, screenshots and a description. You can offer it for free or set a price from $1 to $50.</EmptyState> : <div className="mp-publisher-list">
      {apps.map((app) => <article key={app.id} className="mp-publisher-card">
        <div className="mp-publisher-card-main"><AppIcon app={app} /><div className="mp-publisher-card-copy"><h3>{app.title}</h3>{publisher && <PublisherLink app={app} open={publisher} />}<p className="mp-muted">{app.id}{app.version ? ` · v${app.version}` : ""} · {usd(app.priceUsdMicros)}</p></div><span className={`mp-status mp-status-${app.status}`}>{statusLabels[app.status]}</span></div>
        {app.rejectionReason && <div className="mp-review-feedback"><strong>{app.status === "revoked" ? "Why this release is unavailable" : "Reviewer feedback"}</strong><p>{app.rejectionReason}</p></div>}
        <div className="mp-publisher-card-footer"><span className="mp-muted">{app.coverageEndsAt ? `Prepaid storage through ${dateLabel(app.coverageEndsAt)}` : app.summary}</span><button type="button" className="mp-text-button" disabled={editorBusy || retainedDraft} onClick={() => openEditor(app)}>Manage</button></div>
      </article>)}
    </div>}
    {cursor && <button type="button" className="mp-button mp-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Show more apps"}</button>}

    {editorOpen && <Modal wide title={success ? "Publication saved" : review ? "Review publication" : editing ? `Manage ${editing.title}` : "Publish an app"} close={() => setEditorOpen(false)} footer={success ? <button type="button" className="mp-button mp-button-primary" onClick={() => setEditorOpen(false)}>Done</button> : review ? <>
      {!attempted && <button type="button" className="mp-button" disabled={publishing} onClick={() => { setReview(null); setError(""); }}>Edit details</button>}
      <button type="button" className="mp-button mp-button-primary" disabled={publishing} onClick={() => void publish()}>{publishing ? "Uploading…" : attempted ? "Continue this upload" : review.input.packageFile ? "Upload for review" : "Save changes"}</button>
    </> : <><button type="button" className="mp-button" disabled={editorBusy} onClick={() => { setDraftStarted(false); setDraft(newDraft()); setError(""); setEditorOpen(false); }}>Discard draft</button><button type="submit" form="mp-publication-form" className="mp-button mp-button-primary" disabled={editorBusy || !!detailError}>{quoting ? "Calculating cost…" : "Review publication"}</button></>}>
      {success ? <div className="mp-publication-success" role="status"><Icon name="check" /><p>{success}</p><p className="mp-muted">Your publications show the latest review status and any feedback.</p></div> : review ? <div className="mp-publication-review">
        <div className="mp-publication-summary"><div><h3>{review.input.title}</h3><p>{review.input.summary}</p></div><strong>{usd(review.input.priceUsdMicros)}</strong></div>
        <dl className="mp-facts"><div><dt>App ID</dt><dd>{review.input.appId}</dd></div><div><dt>Upload size</dt><dd>{bytesLabel(review.quote.bytes)}</dd></div>{review.input.packageFile && <div><dt>Package</dt><dd>{review.input.packageFile.name}</dd></div>}{review.input.sourceFile && <div><dt>Offered source</dt><dd>{review.input.sourceFile.name}</dd></div>}{review.quote.coverageEndsAt && <div><dt>Prepaid through</dt><dd>{dateLabel(review.quote.coverageEndsAt)}</dd></div>}</dl>
        <CycleCost value={review.quote.cycles} storage={BigInt(review.quote.cycles.storage ?? "0") > 0n} />
        {review.quote.warnings.length > 0 && <ul className="mp-warning-list">{review.quote.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>}
        {review.input.packageFile && <p className="mp-muted">An auditor must approve this package before it can appear in the store.</p>}
        {(publishing || attempted) && <div className="mp-upload-progress" role="status"><label htmlFor="mp-publication-progress">{publishing ? "Uploading your publication" : "Upload progress"}<span>{Math.round(progress)}%</span></label><progress id="mp-publication-progress" max={100} value={progress} /></div>}
        <ErrorNote error={error} />
        {error && attempted && <p className="mp-muted">Your reviewed files and upload are retained here. Continue this upload to resume it.</p>}
      </div> : <form id="mp-publication-form" className="mp-publication-form" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
        {detailLoading && <Loading label="Loading listing details…" />}
        <ErrorNote error={detailError} retry={editing ? () => void loadDetail(editing) : undefined} />
        {editing?.rejectionReason && <div className="mp-review-feedback"><strong>Reviewer feedback</strong><p>{editing.rejectionReason}</p></div>}
        <fieldset disabled={editorBusy || !!detailError} className="mp-form-group"><legend>App details</legend>
          <label className="mp-field"><span>App name</span><input required value={draft.title} onChange={(event) => update("title", event.target.value)} autoComplete="off" /></label>
          <label className="mp-field"><span>App ID</span><input required value={draft.appId} readOnly={!!editing} onChange={(event) => update("appId", event.target.value)} autoCapitalize="none" autoComplete="off" spellCheck={false} /></label>
          <div className="mp-field"><label htmlFor="mp-publication-excerpt">Excerpt</label><textarea id="mp-publication-excerpt" required rows={3} value={draft.summary} aria-describedby="mp-publication-excerpt-help" aria-invalid={excerptCharacters > EXCERPT_MAX_CHARACTERS} onChange={(event) => update("summary", event.target.value)} /><small id="mp-publication-excerpt-help" className={excerptCharacters > EXCERPT_MAX_CHARACTERS ? "mp-field-error" : "mp-muted"}>{excerptCharacters.toLocaleString()} / {EXCERPT_MAX_CHARACTERS} characters · Shown on the app card.</small></div>
          <div className="mp-field"><label htmlFor="mp-publication-description">Description</label><textarea id="mp-publication-description" required rows={8} value={draft.description} aria-describedby="mp-publication-description-help" aria-invalid={descriptionCharacters > DESCRIPTION_MAX_CHARACTERS} onChange={(event) => update("description", event.target.value)} /><small id="mp-publication-description-help" className={descriptionCharacters > DESCRIPTION_MAX_CHARACTERS ? "mp-field-error" : "mp-muted"}>{descriptionCharacters.toLocaleString()} / {DESCRIPTION_MAX_CHARACTERS.toLocaleString()} characters · Shown when someone opens your app.</small></div>
        </fieldset>
        <fieldset disabled={editorBusy || !!detailError} className="mp-form-group"><legend>Price</legend>
          <div className="mp-price-options"><label><input type="radio" name="mp-publication-price" checked={!draft.paid} onChange={() => update("paid", false)} />Free</label><label><input type="radio" name="mp-publication-price" checked={draft.paid} onChange={() => update("paid", true)} />Paid</label></div>
          {draft.paid && <label className="mp-field"><span>Price in USD</span><div className="mp-price-input"><span aria-hidden="true">$</span><input required type="number" inputMode="decimal" min="1" max="50" step="any" value={draft.price} onChange={(event) => update("price", event.target.value)} /></div><small>Set a list price from $1 to $50. Referral discounts apply at checkout.</small></label>}
          <p className="mp-muted">Buyers keep access to future approved updates, including after a price change.</p>
        </fieldset>
        <fieldset disabled={editorBusy || !!detailError} className="mp-form-group"><legend>{editing ? "New release" : "Release files"}</legend>
          <label className="mp-field mp-file-field"><span>Neutron package{editing && <small>Optional for listing-only changes</small>}</span><input type="file" accept=".neutron" onChange={(event) => { const file = event.target.files?.[0]; if (file) update("packageFile", file); event.currentTarget.value = ""; }} /><small>{fileLabel(draft.packageFile, editing ? "Keep the current release, or choose a new .neutron package." : "Choose the .neutron package you want reviewed.")}</small></label>
          {draft.packageFile && <button type="button" className="mp-text-button" onClick={() => update("packageFile", null)}>Remove selected package</button>}
          <label className="mp-field mp-file-field"><span>Offered source archive</span><input type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) update("sourceFile", file); event.currentTarget.value = ""; }} /><small>{fileLabel(draft.sourceFile, "Include the matching source archive required by your package license.")}</small></label>
          {draft.sourceFile && <button type="button" className="mp-text-button" onClick={() => update("sourceFile", null)}>Remove selected source</button>}
        </fieldset>
        <fieldset disabled={editorBusy || !!detailError} className="mp-form-group"><legend>Store images</legend>
          <label className="mp-field mp-file-field"><span>App icon <small>{editing ? "Optional replacement" : "Optional"}</small></span><input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) update("iconFile", file); event.currentTarget.value = ""; }} /></label>
          {draft.iconFile && <FilePreview file={draft.iconFile} remove={() => update("iconFile", null)} />}
          <label className="mp-field mp-file-field"><span>Screenshots <small>{editing ? "Optional replacements" : "Optional"}</small></span><input type="file" accept="image/*" multiple onChange={(event) => { if (event.target.files?.length) update("screenshotFiles", Array.from(event.target.files)); event.currentTarget.value = ""; }} /><small>{draft.screenshotFiles.length ? `${draft.screenshotFiles.length} selected` : editing ? "Leave empty to keep current screenshots." : "Show people what your app looks like."}</small></label>
          {draft.screenshotFiles.length > 0 && <div className="mp-file-previews">{draft.screenshotFiles.map((file, index) => <FilePreview key={`${index}:${file.name}:${file.lastModified}`} file={file} remove={() => update("screenshotFiles", draft.screenshotFiles.filter((_, item) => item !== index))} />)}</div>}
        </fieldset>
        <p className="mp-muted">You’ll review the cycle cost before uploading. It covers processing and the first year of storage. The operator funds storage afterward; no renewal is required.</p>
        <ErrorNote error={error} />
      </form>}
    </Modal>}
  </section>;
}
