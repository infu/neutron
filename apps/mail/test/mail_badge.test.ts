import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MAIL_BADGE_POLL_BASE_MS,
  MAIL_BADGE_POLL_MAX_MS,
  mailBadgePollDelay,
} from "../src/mail_badge.ts";

describe("Mail resident badge polling", () => {
  test("polls normally after success and backs off repeated failures boundedly", () => {
    expect(mailBadgePollDelay(0)).toBe(MAIL_BADGE_POLL_BASE_MS);
    expect(mailBadgePollDelay(1)).toBe(60_000);
    expect(mailBadgePollDelay(2)).toBe(120_000);
    expect(mailBadgePollDelay(3)).toBe(240_000);
    expect(mailBadgePollDelay(4)).toBe(MAIL_BADGE_POLL_MAX_MS);
    expect(mailBadgePollDelay(100)).toBe(MAIL_BADGE_POLL_MAX_MS);
  });

  test("treats invalid counters as the healthy polling interval", () => {
    expect(mailBadgePollDelay(-1)).toBe(MAIL_BADGE_POLL_BASE_MS);
    expect(mailBadgePollDelay(Number.NaN)).toBe(MAIL_BADGE_POLL_BASE_MS);
    expect(mailBadgePollDelay(1.5)).toBe(MAIL_BADGE_POLL_BASE_MS);
  });

  test("the always-running resident badge reads only the constant-size pulse", () => {
    const service = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");
    const start = service.indexOf("async function refreshTrayBadge");
    const end = service.indexOf("function scheduleTrayBadgePoll", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const refresh = service.slice(start, end);
    expect(refresh).toContain("getMailBackendPulse()");
    expect(refresh).not.toContain("getMailBackendStatus()");
    expect(refresh).toContain("pulse.unread");
  });
});
