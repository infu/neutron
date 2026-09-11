import { useRef, useState } from "react";
import type { MarketplaceClient, PublisherProfile, PublisherProfileInput, PublisherProfileQuote } from "../view-types.ts";
import { CycleCost, ErrorNote, activateOnInputEnter, errorMessage } from "./primitives.tsx";

export function PublisherProfileEditor({ client, profile, saved }: {
  client: MarketplaceClient; profile: PublisherProfile | null; saved: (profile: PublisherProfile) => void;
}) {
  const [input, setInput] = useState<PublisherProfileInput>(() => ({ id: profile?.id ?? "", name: profile?.name ?? "", description: profile?.description ?? "" }));
  const [review, setReview] = useState<{ input: PublisherProfileInput; quote: PublisherProfileQuote } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const inFlight = useRef(false);
  function edit(key: keyof PublisherProfileInput, value: string) { setInput(previous => ({ ...previous, [key]: value })); setError(""); }
  async function prepare() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      if (!/^[a-z]{3,20}$/.test(input.id)) throw new Error("Use 3–20 lowercase letters for your publisher ID.");
      if (!input.name.trim()) throw new Error("Enter your publisher name.");
      const exact = { id: input.id, name: profile?.name ?? input.name.trim(), description: input.description.trim() };
      const quote = await client.quotePublisherProfile(exact);
      setReview({ input: exact, quote });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function save() {
    if (!review || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await client.savePublisherProfile(review.input, review.quote);
      saved(result);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <div role="form" aria-label="Publisher profile" className="mp-profile-form" onKeyDown={event => activateOnInputEnter(event, () => { if (!review && !busy) void prepare(); })}>
    {review ? <>
      <div className="mp-profile-review"><strong>{review.input.name}</strong><span className="mp-profile-id">{review.input.id}</span>{review.input.description && <p className="mp-description">{review.input.description}</p>}</div>
      {!profile && <p className="mp-profile-permanent">Your publisher ID and name are permanent. You can change the description later.</p>}
      <CycleCost value={review.quote.cycles} />
      <ErrorNote error={error} />
      <div className="mp-button-row"><button type="button" className="mp-secondary" disabled={busy} onClick={() => { setReview(null); setError(""); }}>Edit details</button><button type="button" className="mp-primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : profile ? "Save description" : "Create profile"}</button></div>
    </> : <>
      {!profile && <div className="mp-stack"><h2>Create your publisher profile</h2><p className="mp-muted">Let people know who makes your apps. Your publisher ID appears below each app’s name.</p></div>}
      <fieldset className="mp-form-group" disabled={busy}>
        <label htmlFor="mp-publisher-id">Publisher ID</label><input id="mp-publisher-id" value={input.id} readOnly={!!profile} onChange={event => edit("id", event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="mp-publisher-id-help" />
        <small className="mp-muted" id="mp-publisher-id-help">{profile ? "Your permanent publisher ID." : "3–20 lowercase letters, a–z. Choose once."}</small>
        <label htmlFor="mp-publisher-name">Publisher name</label><input id="mp-publisher-name" value={input.name} readOnly={!!profile} onChange={event => edit("name", event.target.value)} autoComplete="organization" aria-describedby="mp-publisher-name-help" />
        <small className="mp-muted" id="mp-publisher-name-help">{profile ? "Your permanent publisher name." : "Your public name. This cannot be changed after creating your profile."}</small>
        <label htmlFor="mp-publisher-description">Publisher description</label><textarea id="mp-publisher-description" rows={4} value={input.description} onChange={event => edit("description", event.target.value)} placeholder="Tell people about your work and the apps you make." />
      </fieldset>
      <ErrorNote error={error} />
      <div className="mp-button-row"><button type="button" className="mp-primary" disabled={busy || (!!profile && input.description.trim() === profile.description)} onClick={() => void prepare()}>{busy ? "Calculating cost…" : profile ? "Review changes" : "Review profile"}</button></div>
    </>}
  </div>;
}
