import { expect, test } from "bun:test";
import { parseCalendarScheduleView } from "../src/calendar_handoff";

test("Rendezvous decodes the canonical Calendar range handoff", () => {
  const start = new Date("2030-05-04T13:15:00");
  const end = new Date("2030-05-04T14:00:00");
  expect(
    parseCalendarScheduleView(
      `schedule/${start.getTime().toString(36)}/${end.getTime().toString(36)}`,
    ),
  ).toEqual({ kind: "schedule", start, end, durationMinutes: 45 });
});

test("Rendezvous decodes a canonical confirmed-meeting lookup", () => {
  const start = new Date("2030-05-04T13:15:00");
  const end = new Date("2030-05-04T14:00:00");
  expect(
    parseCalendarScheduleView(
      `meeting/${start.getTime().toString(36)}/${end.getTime().toString(36)}`,
    ),
  ).toEqual({
    kind: "meeting",
    startNs: String(BigInt(start.getTime()) * 1_000_000n),
    endNs: String(BigInt(end.getTime()) * 1_000_000n),
  });
});

test("Rendezvous ignores malformed, noncanonical, and unbounded handoffs", () => {
  expect(parseCalendarScheduleView("negotiations")).toBeNull();
  expect(parseCalendarScheduleView("schedule/01/02")).toBeNull();
  expect(parseCalendarScheduleView("schedule/zzzzzzzzzzzzzzzz/zzzzzzzzzzzzzzzy")).toBeNull();
  const start = new Date("2030-05-04T13:00:00").getTime();
  const end = start + 10 * 60_000;
  expect(
    parseCalendarScheduleView(
      `schedule/${start.toString(36)}/${end.toString(36)}`,
    ),
  ).toBeNull();
});
