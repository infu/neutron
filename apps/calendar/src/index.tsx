import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin, { type DateClickArg, type DateSelectArg, type EventDropArg } from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import timeGridPlugin from "@fullcalendar/timegrid";
import type { EventClickArg, EventInput, EventResizeDoneArg } from "@fullcalendar/core";
import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import { openAppTile, querySelf, updateSelf, type JsonValue } from "neutron-tools/app";
import { materializeRecurrence, repeatSummary, type RecurrenceDraft, type RepeatFrequency } from "./recurrence";
import { meetingView, scheduleView } from "./rendezvous_handoff";
import "./style.scss";

type OccurrenceView = { id: string; revision: string; series_id: string; series_revision: string; recurrence_key: string; start_ns: string; end_ns: string; title: string; notes: string; location: string; color: string; availability: string | Record<string, unknown>; kind: string | Record<string, unknown>; source: string; status: string };
type RangePage = { revision: string; total: string; occurrences: OccurrenceView[] };
type SeriesView = { id: string; revision: string; title: string; notes: string; location: string; color: string; availability: string | Record<string, unknown>; kind: string | Record<string, unknown>; source: string; time_zone: string; recurrence?: Record<string, unknown> | Record<string, unknown>[] | null };
type Preferences = { revision: string; day_start_minute: number; day_end_minute: number; allowed_weekdays_mask: number; slot_increment_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number; display_time_zone: string };
type EditorDraft = { occurrenceId: string | null; occurrenceRevision: string | null; seriesId: string | null; seriesRevision: string | null; source: string; title: string; start: string; end: string; notes: string; location: string; color: string; availability: "busy" | "free"; allDay: boolean; recurrence: RecurrenceDraft; editScope: "occurrence" | "series"; anchorStart: string; anchorEnd: string };

const emptyPage: RangePage = { revision: "0", total: "0", occurrences: [] };
const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const initialCalendarView = window.matchMedia("(max-width: 700px)").matches ? "listWeek" : "timeGridWeek";
const calendarHeight: number | "auto" = initialCalendarView === "listWeek" ? "auto" : Math.max(520, Math.min(760, window.innerHeight - 210));
const dayMs = 86_400_000;
const bufferedWindow = (visibleStart: Date, visibleEnd: Date) => {
  const start = new Date(visibleStart.getTime() - 30 * dayMs);
  const maximumEnd = new Date(start.getTime() + 366 * dayMs);
  return { start, end: visibleEnd < maximumEnd ? maximumEnd : visibleEnd };
};
const asNs = (value: string, allDay = false) => String(BigInt(new Date(allDay ? `${value}T00:00:00` : value).getTime()) * 1_000_000n);
const fromNs = (value: string) => new Date(Number(BigInt(value) / 1_000_000n));
const localInput = (date: Date, allDay = false) => { const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString(); return allDay ? local.slice(0, 10) : local.slice(0, 16); };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const variantName = (value: unknown) => typeof value === "string" ? value : typeof value === "object" && value ? Object.keys(value)[0] ?? "unknown" : "unknown";
const variantValue = (value: unknown) => typeof value === "object" && value ? Object.values(value)[0] : undefined;
const optionalRecord = (value: SeriesView["recurrence"]): Record<string, unknown> | null => Array.isArray(value) ? value[0] ?? null : value ?? null;
const minutesToTime = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const timeToMinutes = (value: string) => { const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; };

const defaultRecurrence = (start = new Date()): RecurrenceDraft => ({ frequency: "none", interval: 1, weekdays: [start.getDay()], endMode: "count", count: 10, until: localInput(new Date(start.getTime() + 90 * 86_400_000), true) });
function freshDraft(start = new Date(Date.now() + 3_600_000), end = new Date(start.getTime() + 3_600_000), allDay = false): EditorDraft {
  const duration = Math.max(15 * 60_000, end.getTime() - start.getTime()); if (!allDay) start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0); end = new Date(start.getTime() + duration);
  const startText = localInput(start, allDay); const endText = localInput(end, allDay);
  return { occurrenceId: null, occurrenceRevision: null, seriesId: null, seriesRevision: null, source: "owner", title: "", start: startText, end: endText, notes: "", location: "", color: "sage", availability: "busy", allDay, recurrence: defaultRecurrence(start), editScope: "series", anchorStart: startText, anchorEnd: endText };
}
function resultError(result: JsonValue): string | null { if (typeof result !== "object" || result === null || !("err" in result)) return null; const error = result.err; if (typeof error === "object" && error !== null && "message" in error) return String(error.message); return JSON.stringify(error); }
function recurrenceFromSeries(series: SeriesView, start: Date): RecurrenceDraft {
  const rule = optionalRecord(series.recurrence); if (!rule) return defaultRecurrence(start);
  const frequency = variantName(rule.frequency) as RepeatFrequency; const endMode = variantName(rule.end) === "until" ? "until" : "count"; const rawEnd = variantValue(rule.end);
  const mask = Number(rule.weekdays_mask ?? 0); const weekdays = weekdayLabels.map((_, day) => day).filter((day) => (mask & 2 ** day) !== 0);
  return { frequency, interval: Number(rule.interval ?? 1), weekdays: weekdays.length ? weekdays : [start.getDay()], endMode, count: endMode === "count" ? Number(rawEnd ?? 10) : 10, until: endMode === "until" ? localInput(fromNs(String(rawEnd)), true) : localInput(new Date(start.getTime() + 90 * 86_400_000), true) };
}

export const App = () => {
  const [page, setPage] = useState<RangePage>(emptyPage); const [preferences, setPreferences] = useState<Preferences | null>(null); const [draft, setDraft] = useState<EditorDraft>(() => freshDraft());
  const [message, setMessage] = useState("Loading your calendar…"); const [busy, setBusy] = useState(false); const [deleteArmed, setDeleteArmed] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const initialNow = useRef(new Date());
  const rangeRef = useRef(bufferedWindow(new Date(initialNow.current.getTime() - 7 * dayMs), new Date(initialNow.current.getTime() + 7 * dayMs)));
  const rangeRequestRef = useRef(0);
  const revealEditor = () => requestAnimationFrame(() => { titleInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); titleInputRef.current?.focus({ preventScroll: true }); });
  const beginDraft = (next: EditorDraft) => { setDeleteArmed(false); setDraft(next); revealEditor(); };
  const refresh = useCallback(async (visible?: { start: Date; end: Date }) => {
    if (visible) rangeRef.current = bufferedWindow(visible.start, visible.end);
    const requestId = ++rangeRequestRef.current;
    const { start, end } = rangeRef.current;
    const [nextPage, nextPreferences] = await Promise.all([querySelf<RangePage>("calendar_range_v2", [{ start_ns: String(BigInt(start.getTime()) * 1_000_000n), end_ns: String(BigInt(end.getTime()) * 1_000_000n), offset: "0", limit: "2000" }]), querySelf<Preferences>("calendar_preferences_get", [null])]);
    if (requestId !== rangeRequestRef.current) return;
    setPage(nextPage); setPreferences(nextPreferences); setMessage("");
  }, []);
  const showRange = (visible: { start: Date; end: Date }) => void refresh(visible).catch((error) => setMessage(errorText(error)));

  const calendarEvents = useMemo<EventInput[]>(() => page.occurrences.map((item) => { const hold = item.status === "hold"; const owner = item.source === "owner"; const allDay = variantName(item.kind) === "all_day"; return { id: item.id, title: item.title, start: fromNs(item.start_ns), end: fromNs(item.end_ns), allDay, editable: owner && !hold, durationEditable: owner && !hold, startEditable: owner && !hold, classNames: [hold ? "fc-event--hold" : item.source === "rendezvous" ? "fc-event--rendezvous" : `fc-event--personal fc-color--${item.color}`, variantName(item.availability) === "free" ? "fc-event--free" : ""], extendedProps: { item } }; }), [page.occurrences]);
  const upcomingEvents = useMemo(() => page.occurrences.filter((item) => fromNs(item.end_ns).getTime() >= Date.now()).sort((left, right) => fromNs(left.start_ns).getTime() - fromNs(right.start_ns).getTime()).slice(0, 6), [page.occurrences]);
  const dateTime = useMemo(() => new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), []);

  const openEvent = async (item: OccurrenceView) => {
    try {
      const [series, occurrences] = await Promise.all([querySelf<SeriesView | null>("calendar_series_get_v2", [{ series_id: item.series_id }]), querySelf<RangePage>("calendar_series_occurrences_v2", [{ series_id: item.series_id, offset: "0", limit: "730" }])]);
      if (!series) throw new Error("Series not found"); const allDay = variantName(series.kind) === "all_day"; const first = occurrences.occurrences.filter((value) => value.status !== "cancelled").sort((a, b) => a.start_ns.localeCompare(b.start_ns))[0] ?? item;
      const hasRecurrence = optionalRecord(series.recurrence) !== null;
      beginDraft({ occurrenceId: item.id, occurrenceRevision: item.revision, seriesId: item.series_id, seriesRevision: series.revision, source: series.source, title: item.title, start: localInput(fromNs(item.start_ns), allDay), end: localInput(fromNs(item.end_ns), allDay), notes: item.notes, location: item.location, color: item.color, availability: variantName(item.availability) === "free" ? "free" : "busy", allDay, recurrence: recurrenceFromSeries(series, fromNs(first.start_ns)), editScope: hasRecurrence ? "occurrence" : "series", anchorStart: localInput(fromNs(first.start_ns), allDay), anchorEnd: localInput(fromNs(first.end_ns), allDay) });
    } catch (error) { setMessage(errorText(error)); }
  };
  const seriesValue = (current: EditorDraft) => { const materialized = materializeRecurrence(current.start, current.end, current.allDay, current.recurrence); if (materialized.error) throw new Error(materialized.error); return { title: current.title.trim(), notes: current.notes, location: current.location, color: current.color, availability: { [current.availability]: null }, kind: { [current.allDay ? "all_day" : "timed"]: null }, time_zone: detectedZone, recurrence: materialized.recurrence, occurrences: materialized.occurrences }; };
  const saveEvent = async () => {
    if (!draft.title.trim() || !draft.start || !draft.end) return; setBusy(true);
    try {
      let result: JsonValue;
      if (draft.seriesId === null) result = await updateSelf<JsonValue>("calendar_series_create_v2", [{ expected_revision: page.revision, value: seriesValue(draft) }]);
      else if (draft.editScope === "occurrence" && draft.occurrenceId && draft.occurrenceRevision) result = await updateSelf<JsonValue>("calendar_occurrence_update_v2", [{ occurrence_id: draft.occurrenceId, expected_occurrence_revision: draft.occurrenceRevision, start_ns: asNs(draft.start, draft.allDay), end_ns: asNs(draft.end, draft.allDay), title_override: draft.title, notes_override: draft.notes, location_override: draft.location }]);
      else result = await updateSelf<JsonValue>("calendar_series_update_v2", [{ series_id: draft.seriesId, expected_series_revision: draft.seriesRevision, value: seriesValue(draft) }]);
      const problem = resultError(result); if (problem) throw new Error(problem); setDraft(freshDraft()); await refresh();
    } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
  };
  const removeEvent = async () => {
    if (!deleteArmed) { setDeleteArmed(true); return; }
    if (!draft.seriesId) return; setBusy(true);
    try { const result = draft.editScope === "occurrence" && draft.occurrenceId ? await updateSelf<JsonValue>("calendar_occurrence_remove_v2", [{ occurrence_id: draft.occurrenceId, expected_occurrence_revision: draft.occurrenceRevision }]) : await updateSelf<JsonValue>("calendar_series_remove_v2", [{ series_id: draft.seriesId, expected_series_revision: draft.seriesRevision }]); const problem = resultError(result); if (problem) throw new Error(problem); setDeleteArmed(false); setDraft(freshDraft()); await refresh(); } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
  };
  const moveEvent = async (item: OccurrenceView, start: Date | null, end: Date | null, revert: () => void) => { if (!start || !end) { revert(); return; } setBusy(true); try { const result = await updateSelf<JsonValue>("calendar_occurrence_update_v2", [{ occurrence_id: item.id, expected_occurrence_revision: item.revision, start_ns: String(BigInt(start.getTime()) * 1_000_000n), end_ns: String(BigInt(end.getTime()) * 1_000_000n), title_override: null, notes_override: null, location_override: null }]); const problem = resultError(result); if (problem) throw new Error(problem); await refresh(); } catch (error) { revert(); setMessage(`Could not change event time. ${errorText(error)}`); } finally { setBusy(false); } };
  const savePreferences = async () => { if (!preferences) return; setBusy(true); try { const result = await updateSelf<JsonValue>("calendar_preferences_set", [{ expected_revision: page.revision, day_start_minute: preferences.day_start_minute, day_end_minute: preferences.day_end_minute, allowed_weekdays_mask: preferences.allowed_weekdays_mask, slot_increment_minutes: preferences.slot_increment_minutes, buffer_before_minutes: preferences.buffer_before_minutes, buffer_after_minutes: preferences.buffer_after_minutes, display_time_zone: preferences.display_time_zone }]); const problem = resultError(result); if (problem) throw new Error(problem); await refresh(); } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); } };
  const scheduleWithSomeone = async () => {
    try {
      const start = new Date(draft.start); const end = new Date(draft.end);
      const view = scheduleView(start, end);
      await openAppTile({ appId: "rendezvous", tileId: "main", reuseExisting: true, view });
      setMessage("Opened Rendezvous with this date, time, and duration. You still choose who receives the proposal and which options to send.");
    } catch (error) { setMessage(errorText(error)); }
  };
  const openMeetingDetails = async () => {
    try {
      const view = meetingView(new Date(draft.start), new Date(draft.end));
      await openAppTile({ appId: "rendezvous", tileId: "main", reuseExisting: true, view });
      setMessage("Opened this scheduled meeting in Rendezvous.");
    } catch (error) { setMessage(errorText(error)); }
  };
  const selectRange = (selection: DateSelectArg) => beginDraft(freshDraft(new Date(selection.start), new Date(selection.end), selection.allDay));
  const clickDate = (selection: DateClickArg) => beginDraft(freshDraft(new Date(selection.date), new Date(selection.date.getTime() + (selection.allDay ? 86_400_000 : 3_600_000)), selection.allDay));
  const clickEvent = (event: EventClickArg) => { const item = event.event.extendedProps.item as OccurrenceView | undefined; if (item) void openEvent(item); };
  const dropEvent = (event: EventDropArg) => void moveEvent(event.event.extendedProps.item as OccurrenceView, event.event.start, event.event.end, event.revert);
  const resizeEvent = (event: EventResizeDoneArg) => void moveEvent(event.event.extendedProps.item as OccurrenceView, event.event.start, event.event.end, event.revert);
  const togglePreferenceDay = (day: number) => preferences && setPreferences({ ...preferences, allowed_weekdays_mask: preferences.allowed_weekdays_mask ^ 2 ** day });
  const toggleRepeatDay = (day: number) => setDraft({ ...draft, recurrence: { ...draft.recurrence, weekdays: draft.recurrence.weekdays.includes(day) ? draft.recurrence.weekdays.filter((value) => value !== day) : [...draft.recurrence.weekdays, day].sort() } });
  const businessHours = preferences ? [{ daysOfWeek: weekdayLabels.map((_, day) => day).filter((day) => (preferences.allowed_weekdays_mask & 2 ** day) !== 0), startTime: minutesToTime(preferences.day_start_minute), endTime: minutesToTime(preferences.day_end_minute) }] : undefined;
  const recurring = draft.recurrence.frequency !== "none";
  const rendezvousMeeting = draft.source === "rendezvous";
  const recurrencePreview = useMemo(() => materializeRecurrence(draft.start, draft.end, draft.allDay, draft.recurrence), [draft.start, draft.end, draft.allDay, draft.recurrence]);

  return <main className={cx(nt.appFill, "calendar-app")}><div className="nt-page calendar-shell">
    <header className="nt-page-header calendar-header"><div><p className="nt-eyebrow">Private by default</p><h1 className="nt-title">Calendar</h1><p className="nt-text">A real local calendar. Rendezvous sees only options you explicitly share.</p></div><div className="header-actions"><span className="nt-tag nt-tag--success">{page.total} in this window</span><button className="nt-button nt-button--sm" onClick={() => beginDraft({ ...freshDraft(), title: "Busy" })} type="button">Block time</button></div></header>
    <div className="calendar-layout nt-page-main"><section className="nt-panel calendar-board" aria-label="Calendar views"><FullCalendar plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]} initialView={initialCalendarView} datesSet={showRange} headerToolbar={{ left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek" }} buttonText={{ today: "Today", month: "Month", week: "Week", day: "Day", list: "Agenda" }} events={calendarEvents} selectable selectMirror select={selectRange} dateClick={clickDate} eventClick={clickEvent} eventDrop={dropEvent} eventResize={resizeEvent} editable={!busy} eventInteractive nowIndicator navLinks dayMaxEvents allDaySlot businessHours={businessHours} scrollTime={preferences ? `${minutesToTime(preferences.day_start_minute)}:00` : "08:00:00"} slotDuration="00:15:00" snapDuration="00:15:00" height={calendarHeight} /></section>
      <aside className="calendar-sidebar"><section className="nt-panel editor" aria-labelledby="event-editor-title"><div className="section-title"><div><p className="nt-eyebrow">{draft.seriesId ? "Edit event" : "New event"}</p><h2 id="event-editor-title">{draft.seriesId ? draft.title || "Untitled event" : "Block or schedule time"}</h2></div>{draft.seriesId && <button className="nt-button nt-button--sm" onClick={() => setDraft(freshDraft())} type="button">New</button>}</div>
        {rendezvousMeeting && <div className="meeting-notice" role="status"><strong>Scheduled through Rendezvous</strong><span>This confirmed meeting is read-only here. Open Rendezvous to see the negotiation or manage its state.</span></div>}
        {draft.seriesId && recurring && !rendezvousMeeting && <fieldset><legend>Change</legend><div className="scope-picker"><label><input type="radio" checked={draft.editScope === "occurrence"} onChange={() => setDraft({ ...draft, editScope: "occurrence" })} />This event</label><label><input type="radio" checked={draft.editScope === "series"} onChange={() => setDraft({ ...draft, editScope: "series", start: draft.anchorStart, end: draft.anchorEnd })} />Entire series</label></div></fieldset>}
        <label>Title<input ref={titleInputRef} required disabled={rendezvousMeeting} maxLength={160} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label className="inline-check"><input type="checkbox" checked={draft.allDay} disabled={rendezvousMeeting || (draft.editScope === "occurrence" && recurring)} onChange={(event) => { const allDay = event.target.checked; const currentStart = new Date(draft.allDay ? `${draft.start}T00:00:00` : draft.start); const currentEnd = new Date(draft.allDay ? `${draft.end}T00:00:00` : draft.end); setDraft({ ...draft, allDay, start: localInput(currentStart, allDay), end: localInput(currentEnd, allDay) }); }} />All-day event</label>
        <div className="form-row"><label>Starts<input required disabled={rendezvousMeeting} type={draft.allDay ? "date" : "datetime-local"} value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.target.value })} /></label><label>Ends{draft.allDay ? " (exclusive)" : ""}<input required disabled={rendezvousMeeting} type={draft.allDay ? "date" : "datetime-local"} value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.target.value })} /></label></div>
        <div className="form-row"><label>Show as<select value={draft.availability} disabled={rendezvousMeeting || (draft.editScope === "occurrence" && recurring)} onChange={(event) => setDraft({ ...draft, availability: event.target.value as "busy" | "free" })}><option value="busy">Busy</option><option value="free">Free</option></select></label><label>Color<select value={draft.color} disabled={rendezvousMeeting || (draft.editScope === "occurrence" && recurring)} onChange={(event) => setDraft({ ...draft, color: event.target.value })}><option value="sage">Sage</option><option value="ocean">Ocean</option><option value="violet">Violet</option><option value="sunset">Sunset</option></select></label></div>
        <label>Location<input disabled={rendezvousMeeting} maxLength={512} value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label><label>Notes<textarea disabled={rendezvousMeeting} maxLength={4096} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
        {draft.editScope === "series" && !rendezvousMeeting && <div className="recurrence-editor"><label>Repeat<select value={draft.recurrence.frequency} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence, frequency: event.target.value as RepeatFrequency } })}><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>{recurring && <><div className="form-row"><label>Every<input type="number" min="1" max="99" value={draft.recurrence.interval} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence, interval: Number(event.target.value) } })} /></label><label>Ends<select value={draft.recurrence.endMode} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence, endMode: event.target.value as "count" | "until" } })}><option value="count">After a number</option><option value="until">On a date</option></select></label></div>{draft.recurrence.frequency === "weekly" && <fieldset><legend>Repeat on</legend><div className="weekday-picker">{weekdayLabels.map((label, day) => <label key={label}><input type="checkbox" checked={draft.recurrence.weekdays.includes(day)} onChange={() => toggleRepeatDay(day)} />{label}</label>)}</div></fieldset>}{draft.recurrence.endMode === "count" ? <label>Occurrences<input type="number" min="1" max="730" value={draft.recurrence.count} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence, count: Number(event.target.value) } })} /></label> : <label>Repeat through<input type="date" min={draft.start.slice(0, 10)} value={draft.recurrence.until} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence, until: event.target.value } })} /></label>}<p className="repeat-summary">{repeatSummary(draft.recurrence)}</p></>}</div>}
        {recurrencePreview.error && !rendezvousMeeting && <p className="field-error" role="alert">{recurrencePreview.error}</p>}
        {!draft.allDay && recurrencePreview.occurrences[0] && <div className={recurrencePreview.warnings.length ? "time-resolution time-resolution--warning" : "time-resolution"}><p>Resolved in <strong>{detectedZone}</strong> as {fromNs(recurrencePreview.occurrences[0].start_ns).toLocaleString()}.</p>{recurrencePreview.warnings.map((warning) => <p role="alert" key={warning}>{warning}</p>)}</div>}
        <div className="editor-actions">{!rendezvousMeeting && <button className="nt-button" disabled={busy || !draft.title.trim() || !draft.start || !draft.end || Boolean(recurrencePreview.error) || (draft.recurrence.frequency === "weekly" && draft.recurrence.weekdays.length === 0)} onClick={() => void saveEvent()} type="button">{draft.seriesId ? "Save changes" : "Add to calendar"}</button>}{draft.seriesId && !rendezvousMeeting && <button className="nt-button nt-button--danger" disabled={busy} onClick={() => void removeEvent()} type="button">{deleteArmed ? `Confirm delete ${draft.editScope === "occurrence" ? "event" : "series"}` : `Delete ${draft.editScope === "occurrence" ? "event" : "series"}`}</button>}{!draft.allDay && !rendezvousMeeting && <button className="nt-button nt-button--sm" disabled={busy || !draft.start || !draft.end} onClick={() => void scheduleWithSomeone()} type="button">{draft.seriesId ? "Find another time" : "Find a time with someone"}</button>}{rendezvousMeeting && <button className="nt-button" disabled={busy} onClick={() => void openMeetingDetails()} type="button">Open meeting in Rendezvous</button>}</div>{deleteArmed && <p className="editor-hint" role="alert">This cannot be undone. Select confirm delete to continue.</p>}<p className="editor-hint">{rendezvousMeeting ? "Calendar keeps the confirmed time busy; negotiation actions stay in Rendezvous." : "Drag across the calendar to choose time. Owner events can be moved or resized directly."}</p>
      </section>
      {preferences && <section className="nt-panel editor availability-editor"><div><p className="nt-eyebrow">Scheduling defaults</p><h2>Working hours</h2></div><fieldset><legend>Days you usually meet</legend><div className="weekday-picker">{weekdayLabels.map((label, day) => <label key={label}><input type="checkbox" checked={(preferences.allowed_weekdays_mask & 2 ** day) !== 0} onChange={() => togglePreferenceDay(day)} />{label}</label>)}</div></fieldset><div className="form-row"><label>Start<input type="time" value={minutesToTime(preferences.day_start_minute)} onChange={(event) => setPreferences({ ...preferences, day_start_minute: timeToMinutes(event.target.value) })} /></label><label>End<input type="time" value={minutesToTime(preferences.day_end_minute)} onChange={(event) => setPreferences({ ...preferences, day_end_minute: timeToMinutes(event.target.value) })} /></label></div><label>Time zone<input maxLength={64} value={preferences.display_time_zone} placeholder={detectedZone} onChange={(event) => setPreferences({ ...preferences, display_time_zone: event.target.value })} /></label><button className="nt-button nt-button--sm" disabled={busy} onClick={() => void savePreferences()} type="button">Save working hours</button><p className="editor-hint">Working hours guide suggestions; they never prevent creating an event.</p></section>}
      <section className="nt-panel upcoming" aria-labelledby="upcoming-title"><div><p className="nt-eyebrow">Next on your calendar</p><h2 id="upcoming-title">Upcoming</h2></div>{upcomingEvents.length === 0 ? <p className="editor-hint">Nothing upcoming yet. Drag across the calendar to reserve time.</p> : <ol>{upcomingEvents.map((item) => <li key={item.id}><button type="button" onClick={() => void openEvent(item)}><span>{item.title}</span><time dateTime={fromNs(item.start_ns).toISOString()}>{dateTime.format(fromNs(item.start_ns))}</time></button></li>)}</ol>}</section></aside>
    </div>{message && <output className="nt-result calendar-message" aria-live="polite">{message}</output>}
  </div></main>;
};
const container = document.getElementById("root"); if (!container) throw new Error("Root element not found"); createRoot(container).render(<App />);
