import { expect, test } from "bun:test";
import { meetingView, scheduleView } from "../src/rendezvous_handoff";

test("Calendar emits a bounded canonical Rendezvous schedule view", () => {
  const start = new Date(Date.now() + 86_400_000);
  start.setHours(13, 15, 0, 0);
  const end = new Date(start.getTime() + 45 * 60_000);
  expect(scheduleView(start, end)).toBe(
    `schedule/${start.getTime().toString(36)}/${end.getTime().toString(36)}`,
  );
});

test("Calendar emits a canonical local meeting view", () => {
  const start = new Date("2030-05-04T13:15:00");
  const end = new Date("2030-05-04T14:00:00");
  expect(meetingView(start, end)).toBe(
    `meeting/${start.getTime().toString(36)}/${end.getTime().toString(36)}`,
  );
});

test("Calendar refuses unsuitable handoff ranges", () => {
  const start = new Date(Date.now() + 86_400_000);
  start.setHours(23, 30, 0, 0);
  expect(() => scheduleView(start, new Date(start.getTime() + 60 * 60_000))).toThrow(
    "same day",
  );
  expect(() => scheduleView(start, new Date(start.getTime() + 10 * 60_000))).toThrow(
    "15-minute",
  );
});
