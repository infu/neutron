import { expect, test } from "bun:test";
import { materializeRecurrence, type RecurrenceDraft } from "../src/recurrence";

const draft = (overrides: Partial<RecurrenceDraft>): RecurrenceDraft => ({ frequency: "daily", interval: 1, weekdays: [1, 2, 3, 4, 5], endMode: "count", count: 3, until: "2028-12-31", ...overrides });
const starts = (result: ReturnType<typeof materializeRecurrence>) => result.occurrences.map((item) => new Date(Number(BigInt(item.start_ns) / 1_000_000n)));

test("daily recurrence preserves local wall time", () => {
  const values = starts(materializeRecurrence("2026-03-07T09:30", "2026-03-07T10:00", false, draft({})));
  expect(values).toHaveLength(3); expect(values.map((value) => value.getHours())).toEqual([9, 9, 9]);
});

test("daily interval and exact count are honored without a hidden horizon", () => {
  const result = materializeRecurrence("2026-01-01T09:30", "2026-01-01T10:00", false, draft({ interval: 2, count: 730 }));
  const values = starts(result);
  expect(result.error).toBeNull();
  expect(values).toHaveLength(730);
  expect(values[1].getDate()).toBe(3);
  expect(values.at(-1)!.getFullYear()).toBe(2029);
  expect(result.recurrence?.end).toEqual({ count: 730 });
});

test("weekly recurrence uses explicit weekdays", () => {
  const values = starts(materializeRecurrence("2026-08-21T10:00", "2026-08-21T10:30", false, draft({ frequency: "weekly", weekdays: [1, 3, 5], count: 4 })));
  expect(values.map((value) => value.getDay())).toEqual([5, 1, 3, 5]);
});

test("every two weeks uses Monday-anchored calendar weeks", () => {
  const values = starts(materializeRecurrence("2026-08-21T10:00", "2026-08-21T10:30", false, draft({ frequency: "weekly", interval: 2, weekdays: [1, 3, 5], count: 4 })));
  expect(values.map((value) => `${value.getMonth() + 1}/${value.getDate()}`)).toEqual(["8/21", "8/31", "9/2", "9/4"]);
});

test("monthly recurrence skips months without the requested day", () => {
  const values = starts(materializeRecurrence("2027-01-31T10:00", "2027-01-31T10:30", false, draft({ frequency: "monthly", count: 3 })));
  expect(values.map((value) => `${value.getMonth() + 1}/${value.getDate()}`)).toEqual(["1/31", "3/31", "5/31"]);
});

test("yearly recurrence skips non-leap years for February 29", () => {
  const values = starts(materializeRecurrence("2028-02-29T10:00", "2028-02-29T10:30", false, draft({ frequency: "yearly", count: 2 })));
  expect(values.map((value) => value.getFullYear())).toEqual([2028, 2032]);
});

test("all-day end remains exclusive and until is inclusive", () => {
  const result = materializeRecurrence("2026-08-21", "2026-08-22", true, draft({ endMode: "until", until: "2026-08-23" }));
  expect(result.occurrences).toHaveLength(3);
  for (const item of result.occurrences) expect(Number(BigInt(item.end_ns) - BigInt(item.start_ns))).toBe(86_400_000_000_000);
});

test("until is exact and rejects series exceeding the 730 occurrence bound", () => {
  const exact = materializeRecurrence("2026-08-21T09:00", "2026-08-21T09:30", false, draft({ endMode: "until", until: "2026-08-23" }));
  expect(exact.error).toBeNull();
  expect(starts(exact).map((value) => value.getDate())).toEqual([21, 22, 23]);
  const unbounded = materializeRecurrence("2026-01-01T09:00", "2026-01-01T09:30", false, draft({ endMode: "until", until: "2030-01-01" }));
  expect(unbounded.error).toContain("more than 730");
  expect(unbounded.occurrences).toHaveLength(0);
});

test("all-day recurrence keeps exclusive local dates across DST", () => {
  const previous = process.env.TZ; process.env.TZ = "America/Chicago";
  try {
    const result = materializeRecurrence("2026-03-07", "2026-03-08", true, draft({ count: 3 }));
    expect(result.error).toBeNull();
    const ranges = result.occurrences.map((item) => [new Date(Number(BigInt(item.start_ns) / 1_000_000n)), new Date(Number(BigInt(item.end_ns) / 1_000_000n))]);
    expect(ranges.map(([start, end]) => [start.getDate(), end.getDate(), start.getHours(), end.getHours()])).toEqual([[7, 8, 0, 0], [8, 9, 0, 0], [9, 10, 0, 0]]);
    expect(ranges.map(([start, end]) => (end.getTime() - start.getTime()) / 3_600_000)).toEqual([24, 23, 24]);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("invalid editor bounds produce an actionable validation error", () => {
  const result = materializeRecurrence("2026-08-21T10:00", "2026-08-21T09:00", false, draft({}));
  expect(result.error).toContain("end must be after");
  expect(result.occurrences).toHaveLength(0);
});

test("weekly recurrence preserves wall time across a DST offset change", () => {
  const previous = process.env.TZ; process.env.TZ = "America/Chicago";
  try {
    const result = materializeRecurrence("2026-03-01T09:00", "2026-03-01T10:00", false, { frequency: "weekly", interval: 1, weekdays: [0], endMode: "count", count: 3, until: "2026-04-01" });
    const dates = result.occurrences.map((item) => new Date(Number(BigInt(item.start_ns) / 1_000_000n)));
    expect(dates.map((date) => date.getHours())).toEqual([9, 9, 9]);
    expect(dates.map((date) => date.getTimezoneOffset())).toEqual([360, 300, 300]);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("reports DST gap normalization and fold ambiguity", () => {
  const previous = process.env.TZ; process.env.TZ = "America/Chicago";
  try {
    const gap = materializeRecurrence("2026-03-08T02:30", "2026-03-08T04:00", false, { frequency: "none", interval: 1, weekdays: [0], endMode: "count", count: 1, until: "2026-03-08" });
    expect(gap.warnings.join(" ")).toContain("daylight-saving gap");
    expect(new Date(Number(BigInt(gap.occurrences[0].start_ns) / 1_000_000n)).getHours()).toBe(3);
    const fold = materializeRecurrence("2026-11-01T01:30", "2026-11-01T02:30", false, { frequency: "none", interval: 1, weekdays: [0], endMode: "count", count: 1, until: "2026-11-01" });
    expect(fold.warnings.join(" ")).toContain("daylight-saving fold");
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
