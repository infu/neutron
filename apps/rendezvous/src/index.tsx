import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import { capabilities, loadNeutronCanisterId, onTileViewRequest, querySelf, updateSelf } from "neutron-tools/app";
import { parseCalendarScheduleView } from "./calendar_handoff";
import { encodeAddress, resolvePeer } from "./invite";
import "./style.scss";

type Negotiation = { id: Uint8Array; revision: string; direction: string | Record<string, unknown>; peer?: string | string[]; peer_name?: string | string[]; state: string | Record<string, unknown>; title: string; duration_minutes: number; candidate_starts_ns: string[]; selected_start_ns?: string | string[]; expires_at_ns: string; delivery: string | Record<string, unknown> };
type Page = { revision: string; total: string; negotiations: Negotiation[] };
type Availability = { revision: string; available_starts_ns: string[] };
type Contact = { contact_id: string; contact_revision: string; contact_name: string; principal: string };
type ContactPage = { book_revision: string; contacts: Contact[]; total: string; next_offset?: string | string[] };
const DAY_MS = 86_400_000;
const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ns = (date: Date) => String(BigInt(date.getTime()) * 1_000_000n);
const dateFromNs = (value: string) => new Date(Number(BigInt(value) / 1_000_000n));
const stateName = (value: string | Record<string, unknown>) => typeof value === "string" ? value : Object.keys(value)[0] ?? "unknown";
const random16 = () => crypto.getRandomValues(new Uint8Array(16));
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);
const backendProblem = (result: unknown) => {
  if (!result || typeof result !== "object" || !("err" in result)) return null;
  const value = (result as { err: unknown }).err;
  if (value && typeof value === "object" && "message" in value) return String((value as { message: unknown }).message);
  return "Rendezvous could not complete that action.";
};
const dateInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const dateTimeInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const optionFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const negotiationKey = (item: Negotiation) => Array.from(item.id).join("-");
const optionalString = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const statusLabel = (state: string, inbound: boolean) => {
  if (state === "draft") return "Ready to send";
  if (state === "offered") return inbound ? "Needs your response" : "Waiting for them";
  if (state === "countered") return inbound ? "Waiting for organizer" : "They suggested another time";
  if (state === "accept_intent") return "Confirming with peer";
  if (state === "confirmed") return "Scheduled";
  if (state === "declined") return "Declined";
  if (state === "cancelled") return "Cancelled";
  if (state === "expired") return "Expired";
  return "Needs attention";
};

function enumerateCandidates(startText: string, endText: string, earliest: string, latest: string, weekdays: Set<number>, increment: number, duration: number): string[] {
  const start = new Date(`${startText}T00:00:00`); const end = new Date(`${endText}T00:00:00`);
  const [startHour, startMinute] = earliest.split(":").map(Number); const [endHour, endMinute] = latest.split(":").map(Number);
  const firstMinute = startHour * 60 + startMinute; const lastMinute = endHour * 60 + endMinute - duration; const values: string[] = [];
  for (const day = new Date(start); day <= end && values.length < 2_048; day.setDate(day.getDate() + 1)) {
    if (!weekdays.has(day.getDay())) continue;
    for (let minute = firstMinute; minute <= lastMinute; minute += increment) {
      const candidate = new Date(day); candidate.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
      if (candidate.getTime() > Date.now()) values.push(ns(candidate));
    }
  }
  return values;
}

export const App = () => {
  const tomorrow = useMemo(() => new Date(Date.now() + DAY_MS), []); const weekOut = useMemo(() => new Date(Date.now() + 7 * DAY_MS), []);
  const [page, setPage] = useState<Page>({ revision: "0", total: "0", negotiations: [] });
  const [step, setStep] = useState(1); const [peerEntry, setPeerEntry] = useState(""); const [peer, setPeer] = useState(""); const [peerError, setPeerError] = useState(""); const [ownAddress, setOwnAddress] = useState(""); const [title, setTitle] = useState("Coffee and a catch-up"); const [duration, setDuration] = useState(30);
  const [contactQuery, setContactQuery] = useState(""); const [contactResults, setContactResults] = useState<Contact[]>([]); const [contactBookRevision, setContactBookRevision] = useState(""); const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [rangeStart, setRangeStart] = useState(dateInput(tomorrow)); const [rangeEnd, setRangeEnd] = useState(dateInput(weekOut)); const [earliest, setEarliest] = useState("09:00"); const [latest, setLatest] = useState("17:00"); const [increment, setIncrement] = useState(30);
  const [weekdays, setWeekdays] = useState(() => new Set([1, 2, 3, 4, 5])); const [suggestions, setSuggestions] = useState<string[]>([]); const [selected, setSelected] = useState<string[]>([]); const [acceptChoices, setAcceptChoices] = useState<Record<string, string>>({});
  const [manualOption, setManualOption] = useState(() => { const value = new Date(tomorrow); value.setHours(12, 0, 0, 0); return dateTimeInput(value); });
  const [currentAvailability, setCurrentAvailability] = useState<Record<string, string[]>>({});
  const [countering, setCountering] = useState<string | null>(null); const [counterDrafts, setCounterDrafts] = useState<Record<string, string>>({});
  const [calendarHandoff, setCalendarHandoff] = useState(false);
  const [meetingHandoff, setMeetingHandoff] = useState<{ startNs: string; endNs: string } | null>(null); const [focusedMeeting, setFocusedMeeting] = useState<string | null>(null);
  const startMeeting = async (item: Negotiation) => {
    try {
      setMessage("Waiting for Kernel media approval…");
      const selected = await updateSelf("rendezvous_media_select_v1", [{ id: item.id }]);
      const problem = backendProblem(selected);
      if (problem) throw new Error(problem);
      await capabilities.media_sessions.open({
        features: ["camera", "microphone"],
        purpose: `Join “${item.title}” with browser-to-browser audio and video`,
        durationSeconds: 3600,
      });
      setMessage("Media surface opened. Use its controls to preview and end the call.");
    } catch (error) {
      setMessage(describeError(error));
    }
  };
  const [message, setMessage] = useState("Loading negotiations…"); const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const nextPage = await querySelf<Page>("rendezvous_list", [{ offset: "0", limit: "50" }]);
    const checks = await Promise.all(nextPage.negotiations.map(async (item) => {
      const state = stateName(item.state); const inbound = stateName(item.direction) === "inbound"; const key = negotiationKey(item);
      const canChoose = (inbound && state === "offered") || (!inbound && state === "countered");
      if (!canChoose || item.candidate_starts_ns.length === 0) return [key, item.candidate_starts_ns] as const;
      const result = await querySelf<Availability>("rendezvous_suggest_v1", [{ duration_minutes: item.duration_minutes, candidate_starts_ns: item.candidate_starts_ns }]);
      return [key, result.available_starts_ns] as const;
    }));
    setPage(nextPage); setCurrentAvailability(Object.fromEntries(checks)); setMessage("");
  }, []);
  useEffect(() => {
    refresh().catch((error) => setMessage(describeError(error)));
    loadNeutronCanisterId().then((host) => setOwnAddress(encodeAddress({ host }))).catch((error) => setMessage(`Could not create your sharing address. ${describeError(error)}`));
  }, [refresh]);
  useEffect(() => onTileViewRequest((view) => {
    const handoff = parseCalendarScheduleView(view);
    if (!handoff) return;
    if (handoff.kind === "meeting") {
      setMeetingHandoff(handoff); setCalendarHandoff(false);
      return;
    }
    setStep(1); setDuration(handoff.durationMinutes);
    setRangeStart(dateInput(handoff.start)); setRangeEnd(dateInput(handoff.end));
    setEarliest(handoff.start.toTimeString().slice(0, 5)); setLatest(handoff.end.toTimeString().slice(0, 5));
    setWeekdays(new Set([handoff.start.getDay()])); setManualOption(dateTimeInput(handoff.start));
    setSuggestions([]); setSelected([]); setCalendarHandoff(true);
  }), []);
  useEffect(() => {
    if (!meetingHandoff) return;
    const match = page.negotiations.find((item) => {
      const selected = optionalString(item.selected_start_ns);
      if (stateName(item.state) !== "confirmed" || selected !== meetingHandoff.startNs) return false;
      return BigInt(selected) + BigInt(item.duration_minutes) * 60_000_000_000n === BigInt(meetingHandoff.endNs);
    });
    if (!match) { setFocusedMeeting(null); return; }
    const key = negotiationKey(match); setFocusedMeeting(key);
    requestAnimationFrame(() => document.getElementById(`negotiation-${key}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [meetingHandoff, page]);
  const act = async (method: string, args: unknown) => { setBusy(true); try { const result = await updateSelf(method, [args]); const problem = backendProblem(result); if (problem) throw new Error(problem); await refresh(); } catch (error) { setMessage(describeError(error)); } finally { setBusy(false); } };
  const findTimes = async () => {
    const candidates = enumerateCandidates(rangeStart, rangeEnd, earliest, latest, weekdays, increment, duration);
    if (candidates.length === 0) { setMessage("Choose a future date range with at least one meeting window."); return; }
    setBusy(true);
    try {
      const available: string[] = [];
      for (let index = 0; index < candidates.length; index += 32) {
        const result = await querySelf<Availability>("rendezvous_suggest_v1", [{ duration_minutes: duration, candidate_starts_ns: candidates.slice(index, index + 32) }]); available.push(...result.available_starts_ns);
      }
      setSuggestions(available); setSelected([]); setStep(3); setMessage("");
    } catch (error) { setMessage(describeError(error)); } finally { setBusy(false); }
  };
  const propose = async () => {
    if (!peer || !title.trim() || selected.length === 0) return; setBusy(true);
    let created: Negotiation | null = null;
    try {
      const candidates = [...selected].sort((left, right) => left.localeCompare(right));
      const common = { id: random16(), capability: random16(), peer, title: title.trim(), duration_minutes: duration, candidate_starts_ns: candidates, expires_at_ns: ns(new Date(Date.now() + 7 * DAY_MS)) };
      created = selectedContact
        ? await updateSelf<Negotiation>("rendezvous_create_contact_offer", [{ ...common, contact: { contact_id: selectedContact.contact_id, contact_revision: selectedContact.contact_revision, book_revision: contactBookRevision } }])
        : await updateSelf<Negotiation>("rendezvous_create_offer", [common]);
      const delivery = await updateSelf("rendezvous_send_offer", [{ id: created.id, expected_revision: created.revision }]);
      const problem = backendProblem(delivery);
      await refresh(); setStep(1); setSuggestions([]); setSelected([]);
      if (problem) setMessage(`Proposal saved, but delivery did not complete. ${problem} Use Safe retry when the peer is reachable.`);
    } catch (error) {
      if (created) {
        await refresh().catch(() => undefined); setStep(1); setSuggestions([]); setSelected([]);
        setMessage(`Proposal saved, but delivery did not complete. ${describeError(error)} Use Safe retry when the peer is reachable.`);
      } else setMessage(describeError(error));
    } finally { setBusy(false); }
  };
  const toggleWeekday = (day: number) => setWeekdays((current) => { const next = new Set(current); if (next.has(day)) next.delete(day); else next.add(day); return next; });
  const changePeer = (value: string) => {
    setSelectedContact(null);
    setPeerEntry(value);
    if (!value.trim()) { setPeer(""); setPeerError(""); return; }
    try { setPeer(resolvePeer(value)); setPeerError(""); } catch (error) { setPeer(""); setPeerError(describeError(error)); }
  };
  const searchContacts = async () => {
    setBusy(true);
    try {
      const contactPage = await querySelf<ContactPage>("rendezvous_contacts_search_v1", [{ search_text: contactQuery.trim(), offset: "0", limit: "8" }]);
      setContactResults(contactPage.contacts); setContactBookRevision(contactPage.book_revision);
      setMessage(contactPage.contacts.length === 0 ? "No Contacts with a Neutron address matched that search." : "");
    } catch (error) { setContactResults([]); setMessage(describeError(error)); } finally { setBusy(false); }
  };
  const chooseContact = (contact: Contact) => {
    setSelectedContact(contact); setPeer(contact.principal); setPeerEntry(""); setPeerError(""); setContactResults([]); setMessage("");
  };
  const copyAddress = async () => {
    if (!ownAddress) return;
    try { await navigator.clipboard.writeText(ownAddress); setMessage("Rendezvous address copied. Send it to the person who wants to schedule with you."); }
    catch { setMessage("Clipboard access was unavailable. Select your Rendezvous address and copy it manually."); }
  };
  const toggleOption = (value: string) => setSelected((current) => current.includes(value) ? current.filter((item) => item !== value) : current.length < 16 ? [...current, value] : current);
  const addManualOption = async () => {
    const candidate = new Date(manualOption);
    if (Number.isNaN(candidate.getTime()) || candidate.getTime() <= Date.now()) { setMessage("Choose a future date and time."); return; }
    const value = ns(candidate);
    if (selected.includes(value)) { setMessage("That option is already selected."); return; }
    if (selected.length >= 16) { setMessage("A proposal can contain at most 16 options."); return; }
    setBusy(true);
    try {
      const result = await querySelf<Availability>("rendezvous_suggest_v1", [{ duration_minutes: duration, candidate_starts_ns: [value] }]);
      if (!result.available_starts_ns.includes(value)) { setMessage("That time conflicts with a busy event. Choose another time."); return; }
      setSuggestions((current) => [...new Set([...current, value])].sort()); setSelected((current) => [...current, value]); setMessage("");
    } catch (error) { setMessage(describeError(error)); } finally { setBusy(false); }
  };
  const openCounter = (key: string, item: Negotiation) => {
    const initial = new Date(dateFromNs(item.candidate_starts_ns[0]).getTime() + 60 * 60_000);
    setCounterDrafts((current) => ({ ...current, [key]: dateTimeInput(initial) })); setCountering(key);
  };
  const sendCounter = async (key: string, item: Negotiation) => {
    const candidate = new Date(counterDrafts[key] ?? "");
    if (Number.isNaN(candidate.getTime()) || candidate.getTime() <= Date.now()) { setMessage("Choose a future alternative time."); return; }
    const value = ns(candidate); setBusy(true);
    try {
      const available = await querySelf<Availability>("rendezvous_suggest_v1", [{ duration_minutes: item.duration_minutes, candidate_starts_ns: [value] }]);
      if (!available.available_starts_ns.includes(value)) { setMessage("That alternative conflicts with your calendar."); return; }
      setBusy(false); await act("rendezvous_counter", { id: item.id, expected_revision: item.revision, selected_start_ns: value }); setCountering(null);
    } catch (error) { setMessage(describeError(error)); } finally { setBusy(false); }
  };
  const groupedSuggestions = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const value of suggestions) { const label = dayFormat.format(dateFromNs(value)); groups.set(label, [...(groups.get(label) ?? []), value]); }
    return [...groups.entries()];
  }, [suggestions]);

  return <main className={cx(nt.appFill, "rendezvous-app")}><div className="nt-page rendezvous-shell">
    <header className="nt-page-header"><div><p className="nt-eyebrow">Private peer scheduling</p><h1 className="nt-title">Rendezvous</h1><p className="nt-text">Choose the exact options to share. Your calendar stays on your Neutron.</p></div><span className="nt-tag nt-tag--success">{page.total} conversations</span></header>
    <section className="nt-panel share-card" aria-labelledby="share-title"><div><p className="nt-eyebrow">Your sharing address</p><h2 id="share-title">Let someone schedule with you</h2><p className="privacy">This reusable address identifies your Neutron. It contains no calendar data or login secret.</p></div><textarea aria-label="Your Rendezvous address" readOnly rows={2} value={ownAddress || "Loading your address…"} onFocus={(event) => event.currentTarget.select()} /><button className="nt-button nt-button--sm" disabled={!ownAddress} onClick={() => void copyAddress()} type="button">Copy address</button></section>
    <div className="rendezvous-grid nt-page-main"><section className="nt-panel conversations"><div className="section-title"><h2>Negotiations</h2><button className="nt-button nt-button--sm" type="button" onClick={() => void refresh()}>Refresh</button></div>{meetingHandoff && <div className="handoff-notice" role="status"><strong>{focusedMeeting ? "Meeting opened from Calendar" : "Meeting not found"}</strong><span>{focusedMeeting ? "The matching confirmed negotiation is highlighted below." : "Refresh to look for this confirmed meeting, or it may no longer be in the bounded negotiation history."}</span></div>}
      {page.negotiations.length === 0 ? <p className="empty">No invitations yet. Start a private proposal.</p> : page.negotiations.map((item) => { const state = stateName(item.state); const delivery = stateName(item.delivery); const inbound = stateName(item.direction) === "inbound"; const key = negotiationKey(item); const choice = acceptChoices[key] ?? ""; const availableNow = currentAvailability[key] ?? item.candidate_starts_ns; const choiceAvailable = choice !== "" && availableNow.includes(choice); const canChoose = (inbound && state === "offered") || (!inbound && state === "countered"); const selectedTime = optionalString(item.selected_start_ns); const peerPrincipal = optionalString(item.peer); const peerName = optionalString(item.peer_name); const peerLabel = peerName ?? peerPrincipal ?? "Unknown Neutron"; return <article className={cx("negotiation", focusedMeeting === key && "negotiation--focused")} id={`negotiation-${key}`} key={key}>
        <div className="negotiation-head"><div className="peer-heading"><span className="direction">{inbound ? `From ${peerLabel}` : `To ${peerLabel}`}</span>{peerPrincipal && <small className="peer-identity">Neutron {peerPrincipal}</small>}<h3>{item.title}</h3></div><span className={cx("state", `state--${state}`)}>{statusLabel(state, inbound)}</span></div><p>{inbound ? (peerName ?? "They") : "You"} proposed {item.candidate_starts_ns.length} time{item.candidate_starts_ns.length === 1 ? "" : "s"} · {item.duration_minutes} minutes</p>{state === "confirmed" && selectedTime && <p className="scheduled-time"><strong>{optionFormat.format(dateFromNs(selectedTime))}</strong></p>}
        {canChoose && <fieldset className="received-options"><legend>{inbound ? "Choose a time" : "Choose whether to accept their alternative"} · checked against your calendar now</legend>{item.candidate_starts_ns.map((value) => { const available = availableNow.includes(value); return <label className={available ? "option-available" : "option-unavailable"} key={value}><input type="radio" name={`accept-${key}`} checked={choice === value} disabled={!available} onChange={() => setAcceptChoices({ ...acceptChoices, [key]: value })} /><span>{optionFormat.format(dateFromNs(value))}</span><small>{available ? "Available" : "No longer available"}</small></label>; })}</fieldset>}
        {canChoose && availableNow.length === 0 && <div className="availability-empty" role="status"><strong>None of these times is open now</strong><span>Suggest another time to keep scheduling, or decline this invitation.</span></div>}
        {countering === key && <div className="counter-picker"><label>Alternative time<input type="datetime-local" value={counterDrafts[key] ?? ""} onChange={(event) => setCounterDrafts({ ...counterDrafts, [key]: event.target.value })} /></label><div className="actions"><button className="nt-button nt-button--sm" disabled={busy} onClick={() => void sendCounter(key, item)} type="button">Check and send alternative</button><button className="nt-button nt-button--sm" onClick={() => setCountering(null)} type="button">Keep proposal</button></div></div>}
        {inbound && state === "countered" && <p className="waiting-copy">Alternative sent. Waiting for the organizer to choose.</p>}
        <details><summary>Technical delivery</summary><small>Peer: {peerPrincipal ?? "Unavailable"} · Protocol state: {state} · Delivery: {delivery}{delivery === "uncertain" ? " — the peer may have committed" : ""}</small></details><div className="actions">{state === "confirmed" && <button className="nt-button nt-button--sm" disabled={busy} onClick={() => void startMeeting(item)} type="button">Join video meeting</button>}{canChoose && <><button className="nt-button nt-button--sm" disabled={busy || !choiceAvailable} onClick={() => void act("rendezvous_accept", { id: item.id, expected_revision: item.revision, selected_start_ns: choice })}>{inbound ? "Accept selected time" : "Accept their alternative"}</button>{inbound && <button className="nt-button nt-button--sm" disabled={busy} onClick={() => openCounter(key, item)} type="button">Suggest another time</button>}<button className="nt-button nt-button--sm" disabled={busy} onClick={() => void act("rendezvous_decline", { id: item.id, expected_revision: item.revision })}>{inbound ? "Decline invitation" : "Decline alternative"}</button></>}{delivery === "retryable" || delivery === "uncertain" || (!inbound && state === "draft" && delivery === "idle") ? <button className="nt-button nt-button--sm" disabled={busy} onClick={() => void act("rendezvous_retry", { id: item.id, expected_revision: item.revision })}>Safe retry</button> : null}{!inbound && !canChoose && !["confirmed", "cancelled", "declined"].includes(state) && <button className="nt-button nt-button--sm" disabled={busy} onClick={() => void act("rendezvous_cancel", { id: item.id, expected_revision: item.revision })}>Cancel invitation</button>}</div>
      </article>; })}
    </section><section className="nt-panel proposal" aria-labelledby="proposal-title"><p className="nt-eyebrow">New proposal · Step {step} of 4</p><h2 id="proposal-title">{step === 1 ? "Who and what?" : step === 2 ? "When should we look?" : step === 3 ? "Choose exact options" : "Review and send"}</h2>{calendarHandoff && <div className="handoff-notice" role="status"><strong>Calendar range imported</strong><span>The date, time window, and duration are ready. You still choose the recipient and exact options before anything is shared.</span></div>}<nav className="stepper" aria-label="Proposal progress">{[1, 2, 3, 4].map((number) => <span className={number === step ? "active" : number < step ? "done" : ""} key={number}>{number}</span>)}</nav>
      {step === 1 && <><fieldset className="contact-picker"><legend>Choose from Contacts</legend><div className="contact-search"><label><span>Contact name</span><input value={contactQuery} maxLength={120} onChange={(event) => setContactQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchContacts(); } }} /></label><button className="nt-button nt-button--sm" disabled={busy} onClick={() => void searchContacts()} type="button">Search Contacts</button></div>{selectedContact && <div className="selected-contact" role="status"><div><strong>{selectedContact.contact_name}</strong><small>Selected from Contacts · address checked again before send</small></div><button className="nt-button nt-button--sm" onClick={() => { setSelectedContact(null); setPeer(""); }} type="button">Change</button></div>}{contactResults.length > 0 && <div className="contact-results" role="list" aria-label="Contacts with Neutron addresses">{contactResults.map((contact) => <button key={contact.contact_id} onClick={() => chooseContact(contact)} role="listitem" type="button"><strong>{contact.contact_name}</strong><small>{contact.principal}</small></button>)}</div>}</fieldset><div className="address-divider"><span>or use a sharing address</span></div><label>Their Rendezvous address<input required={!selectedContact} disabled={Boolean(selectedContact)} aria-invalid={peerError ? "true" : undefined} aria-describedby={peerError ? "peer-error" : undefined} placeholder="RVC1-…" value={peerEntry} onChange={(event) => changePeer(event.target.value)} /></label>{peerError && <p className="field-error" id="peer-error" role="alert">{peerError}</p>}<details className="advanced-peer"><summary>Advanced · Neutron principal</summary><p>{peer ? <>Resolved peer: <code>{peer}</code></> : "You can also paste a raw Neutron canister principal into the address field."}</p></details><label>Meeting title<input required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Duration in minutes<input type="number" min="15" max="480" step="15" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label><button className="nt-button" disabled={!peer || !title.trim() || !Number.isInteger(duration) || duration < 15 || duration > 480} onClick={() => setStep(2)} type="button">Choose dates</button></>}
      {step === 2 && <><div className="form-row"><label>From<input type="date" min={dateInput(tomorrow)} value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} /></label><label>Through<input type="date" min={rangeStart} value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} /></label></div><fieldset><legend>Days</legend><div className="weekday-picker">{weekdayLabels.map((label, day) => <label key={label}><input type="checkbox" checked={weekdays.has(day)} onChange={() => toggleWeekday(day)} />{label}</label>)}</div></fieldset><div className="form-row"><label>Earliest<input type="time" value={earliest} onChange={(event) => setEarliest(event.target.value)} /></label><label>Latest<input type="time" value={latest} onChange={(event) => setLatest(event.target.value)} /></label></div><label>Time between suggestions<select value={increment} onChange={(event) => setIncrement(Number(event.target.value))}><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option></select></label><div className="actions"><button className="nt-button nt-button--sm" onClick={() => setStep(1)} type="button">Back</button><button className="nt-button" disabled={busy || weekdays.size === 0 || !rangeStart || !rangeEnd || rangeEnd < rangeStart} onClick={() => void findTimes()} type="button">Find available times</button></div></>}
      {step === 3 && <><p className="privacy">These options are available locally. Check exactly what you want to share (up to 16).</p>{suggestions.length === 0 && <div className="availability-empty" role="status"><strong>No available times matched this search</strong><span>Try a wider window, different days, or another time of day.</span></div>}<div className="manual-option"><label>Add a specific time<input type="datetime-local" min={dateTimeInput(new Date())} value={manualOption} onChange={(event) => setManualOption(event.target.value)} /></label><button className="nt-button nt-button--sm" disabled={busy || selected.length >= 16} onClick={() => void addManualOption()} type="button">Check and add</button></div><p className="selection-count" aria-live="polite"><strong>{selected.length}</strong> of 16 selected</p><div className="suggestions">{groupedSuggestions.map(([day, values]) => <section className="suggestion-day" aria-labelledby={`suggestion-${values[0]}`} key={day}><h3 id={`suggestion-${values[0]}`}>{day}</h3>{values.map((value) => <label key={value}><input type="checkbox" checked={selected.includes(value)} disabled={!selected.includes(value) && selected.length >= 16} onChange={() => toggleOption(value)} /><span>{optionFormat.format(dateFromNs(value))}</span></label>)}</section>)}</div><div className="actions"><button className="nt-button nt-button--sm" onClick={() => setStep(2)} type="button">Back</button><button className="nt-button" disabled={selected.length === 0} onClick={() => setStep(4)} type="button">Review {selected.length} option{selected.length === 1 ? "" : "s"}</button></div></>}
      {step === 4 && <><div className="review"><p><strong>{title}</strong></p><p>To {selectedContact?.contact_name ?? "the reviewed Rendezvous address"}</p><p>{duration} minutes · {selected.length} exact option{selected.length === 1 ? "" : "s"}</p><ol>{[...selected].sort().map((value) => <li key={value}>{optionFormat.format(dateFromNs(value))}</li>)}</ol></div><p className="privacy">Only the title, duration, and selected starts go to this peer. No Contact name, event name, or busy interval leaves your Neutron.</p><div className="actions"><button className="nt-button nt-button--sm" onClick={() => setStep(3)} type="button">Back</button><button className="nt-button" disabled={busy} onClick={() => void propose()} type="button">Send proposal</button></div></>}
    </section></div>{message && <output className="nt-result status-message" aria-live="polite">{message}</output>}
  </div></main>;
};
const root = document.getElementById("root"); if (!root) throw new Error("Root element not found"); createRoot(root).render(<App />);
