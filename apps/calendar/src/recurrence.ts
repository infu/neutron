export type RepeatFrequency = "none" | "daily" | "weekly" | "monthly" | "yearly";
export type RecurrenceDraft = {
  frequency: RepeatFrequency;
  interval: number;
  weekdays: number[];
  endMode: "count" | "until";
  count: number;
  until: string;
};
export type MaterializedOccurrence = { recurrence_key: string; start_ns: string; end_ns: string };
export type WireRecurrence = {
  frequency: Record<string, null>;
  interval: number;
  weekdays_mask: number;
  month_day: number | null;
  end: Record<string, number | string>;
};
export type MaterializationResult = { occurrences: MaterializedOccurrence[]; recurrence: WireRecurrence | null; warnings: string[]; error: string | null };

const DAY_MS = 86_400_000;
const MAX_OCCURRENCES = 730;
const toNs = (date: Date) => String(BigInt(date.getTime()) * 1_000_000n);
const pad = (value: number) => String(value).padStart(2, "0");
const keyFor = (date: Date, allDay: boolean) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${allDay ? "" : `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`}`;
const validDate = (date: Date) => !Number.isNaN(date.getTime());

export function parseEditorDate(value: string, allDay: boolean): Date {
  return new Date(allDay ? `${value}T00:00:00` : value);
}

const localMinuteKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
function wallTimeWarnings(label: string, input: string, resolved: Date, allDay: boolean): string[] {
  if (allDay || !validDate(resolved)) return [];
  const warnings: string[] = [];
  if (localMinuteKey(resolved) !== input.slice(0, 16)) warnings.push(`${label} falls in a daylight-saving gap and resolves to ${localMinuteKey(resolved)}.`);
  const oneHourLater = new Date(resolved.getTime() + 60 * 60_000);
  if (localMinuteKey(oneHourLater) === localMinuteKey(resolved) && oneHourLater.getTimezoneOffset() !== resolved.getTimezoneOffset()) warnings.push(`${label} is ambiguous at the daylight-saving fold; the earlier occurrence is used.`);
  return warnings;
}

export function materializeRecurrence(startValue: string, endValue: string, allDay: boolean, draft: RecurrenceDraft): MaterializationResult {
  const start = parseEditorDate(startValue, allDay); const end = parseEditorDate(endValue, allDay);
  const warnings = [...wallTimeWarnings("Start", startValue, start, allDay), ...wallTimeWarnings("End", endValue, end, allDay)];
  if (!validDate(start) || !validDate(end) || end <= start) return { occurrences: [], recurrence: null, warnings, error: "The event end must be after its start." };
  const duration = end.getTime() - start.getTime();
  const allDaySpan = Math.round((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / DAY_MS);
  if (draft.frequency === "none") return { occurrences: [{ recurrence_key: keyFor(start, allDay), start_ns: toNs(start), end_ns: toNs(end) }], recurrence: null, warnings, error: null };

  if (!Number.isInteger(draft.interval) || draft.interval < 1 || draft.interval > 99) return { occurrences: [], recurrence: null, warnings, error: "Repeat interval must be from 1 to 99." };
  if (draft.endMode === "count" && (!Number.isInteger(draft.count) || draft.count < 1 || draft.count > MAX_OCCURRENCES)) return { occurrences: [], recurrence: null, warnings, error: `A series must contain 1–${MAX_OCCURRENCES} occurrences.` };
  const interval = draft.interval;
  const countLimit = draft.endMode === "count" ? draft.count : MAX_OCCURRENCES + 1;
  const until = draft.endMode === "until" ? new Date(`${draft.until}T23:59:59.999`) : null;
  if (until && (!validDate(until) || until < start)) return { occurrences: [], recurrence: null, warnings, error: "Repeat-through date must be on or after the first event." };
  const values: Date[] = [];
  const accept = (candidate: Date) => {
    if (!validDate(candidate) || candidate < start || (until && candidate > until) || values.length >= countLimit) return false;
    values.push(candidate); return true;
  };
  const finished = (candidate: Date) => !validDate(candidate) || Boolean(until && candidate > until) || values.length >= countLimit;

  if (draft.frequency === "daily") {
    for (let index = 0; values.length < countLimit; index += 1) { const candidate = new Date(start); candidate.setDate(start.getDate() + index * interval); if (finished(candidate)) break; accept(candidate); }
  } else if (draft.frequency === "weekly") {
    const selected = new Set(draft.weekdays.length ? draft.weekdays : [start.getDay()]);
    const mondayOffset = (start.getDay() + 6) % 7;
    for (let recurrenceWeek = 0; values.length < countLimit; recurrenceWeek += interval) {
      let pastUntil = false;
      for (const day of [...selected].sort((left, right) => ((left + 6) % 7) - ((right + 6) % 7))) {
        const candidate = new Date(start);
        candidate.setDate(start.getDate() - mondayOffset + recurrenceWeek * 7 + ((day + 6) % 7));
        if (!validDate(candidate)) { pastUntil = true; break; }
        if (until && candidate > until) { pastUntil = true; break; }
        accept(candidate);
        if (values.length >= countLimit) break;
      }
      if (pastUntil) break;
    }
  } else if (draft.frequency === "monthly") {
    const day = start.getDate();
    for (let index = 0; values.length < countLimit; index += 1) { const targetMonth = start.getMonth() + index * interval; const candidate = new Date(start); candidate.setDate(1); candidate.setMonth(targetMonth); candidate.setDate(day); if (finished(candidate)) break; if (candidate.getMonth() === ((targetMonth % 12) + 12) % 12) accept(candidate); }
  } else {
    const month = start.getMonth(); const day = start.getDate();
    for (let index = 0; values.length < countLimit; index += 1) { const year = start.getFullYear() + index * interval; const candidate = new Date(start); candidate.setDate(1); candidate.setFullYear(year); candidate.setMonth(month); candidate.setDate(day); if (finished(candidate)) break; if (candidate.getFullYear() === year && candidate.getMonth() === month) accept(candidate); }
  }

  if (values.length > MAX_OCCURRENCES) return { occurrences: [], recurrence: null, warnings, error: `That end date creates more than ${MAX_OCCURRENCES} occurrences. Choose an earlier date or a larger interval.` };
  if (draft.endMode === "count" && values.length !== draft.count) return { occurrences: [], recurrence: null, warnings, error: "Calendar could not materialize the requested number of occurrences." };

  const occurrences = values.map((candidate) => {
    const occurrenceEnd = new Date(candidate);
    if (allDay) occurrenceEnd.setDate(candidate.getDate() + allDaySpan);
    else occurrenceEnd.setTime(candidate.getTime() + duration);
    return { recurrence_key: keyFor(candidate, allDay), start_ns: toNs(candidate), end_ns: toNs(occurrenceEnd) };
  });
  const weekdaysMask = draft.weekdays.reduce((mask, day) => mask | (2 ** day), 0);
  const recurrence: WireRecurrence = {
    frequency: { [draft.frequency]: null }, interval,
    weekdays_mask: draft.frequency === "weekly" ? weekdaysMask || 2 ** start.getDay() : 0,
    month_day: draft.frequency === "monthly" ? start.getDate() : null,
    end: draft.endMode === "count" ? { count: occurrences.length } : { until: toNs(until!) },
  };
  return { occurrences, recurrence, warnings, error: null };
}

export function repeatSummary(draft: RecurrenceDraft): string {
  if (draft.frequency === "none") return "Does not repeat";
  const unit = draft.frequency.replace("ly", "");
  const cadence = draft.interval === 1 ? `Every ${unit}` : `Every ${draft.interval} ${unit}s`;
  const ending = draft.endMode === "count" ? `${draft.count} times` : `until ${draft.until}`;
  return `${cadence}, ${ending}`;
}
