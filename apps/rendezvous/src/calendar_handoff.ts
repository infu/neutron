export type CalendarScheduleHandoff = {
  kind: "schedule";
  start: Date;
  end: Date;
  durationMinutes: number;
};

export type CalendarMeetingHandoff = {
  kind: "meeting";
  startNs: string;
  endNs: string;
};

const CANONICAL = /^(schedule|meeting)\/([1-9a-z][0-9a-z]*)\/([1-9a-z][0-9a-z]*)$/u;

export function parseCalendarScheduleView(
  view: string,
): CalendarScheduleHandoff | CalendarMeetingHandoff | null {
  const match = CANONICAL.exec(view);
  if (!match) return null;
  const startMs = parseBase36(match[2]!);
  const endMs = parseBase36(match[3]!);
  if (startMs === null || endMs === null) return null;
  if (
    startMs.toString(36) !== match[2] ||
    endMs.toString(36) !== match[3]
  ) {
    return null;
  }
  const durationMinutes = (endMs - startMs) / 60_000;
  const start = new Date(startMs);
  const end = new Date(endMs);
  if (match[1] === "meeting") {
    if (endMs <= startMs) return null;
    return {
      kind: "meeting",
      startNs: String(BigInt(startMs) * 1_000_000n),
      endNs: String(BigInt(endMs) * 1_000_000n),
    };
  }
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 15 ||
    durationMinutes > 480 ||
    Number.isNaN(start.getTime()) ||
    start.toDateString() !== end.toDateString()
  ) {
    return null;
  }
  return { kind: "schedule", start, end, durationMinutes };
}

function parseBase36(value: string): number | null {
  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
