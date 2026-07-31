import { expect, test } from "bun:test";
import {
  RUN_COMPLETE_QUOTES,
  runCompleteQuote,
} from "../src/run_quotes.ts";

test("run complete epilogues contain exactly twenty unique one-liners", () => {
  expect(RUN_COMPLETE_QUOTES).toHaveLength(20);
  expect(new Set(RUN_COMPLETE_QUOTES).size).toBe(20);

  for (const quote of RUN_COMPLETE_QUOTES) {
    expect(quote).not.toContain("\n");
    expect(quote.length).toBeGreaterThan(45);
    expect(quote.length).toBeLessThan(106);
    expect(quote).toMatch(/[.!?]$/);
  }
});

test("the epilogues cover the desert bar, motorcycle, AI, and game", () => {
  const corpus = RUN_COMPLETE_QUOTES.join(" ").toLowerCase();
  expect(corpus).toContain("route 66");
  expect(corpus).toContain("motorcycle");
  expect(corpus).toMatch(/bar|bartender/);
  expect(corpus).toMatch(/autopilot|algorithm|computer|artificial intelligence/);
  expect(corpus).toMatch(/sector|cave|jet|missiles/);
});

test("a completed run receives one stable quote while varied runs reach the full set", () => {
  expect(runCompleteQuote(12_340, 57, 900)).toBe(runCompleteQuote(12_340, 57, 900));
  expect(runCompleteQuote(Number.NaN, Number.POSITIVE_INFINITY, -4)).toBe(RUN_COMPLETE_QUOTES[0]);

  const reached = new Set<string>();
  for (let sector = 1; sector <= 200; sector += 1) {
    reached.add(runCompleteQuote(sector * 730, sector, sector * 40));
  }
  expect(reached.size).toBe(RUN_COMPLETE_QUOTES.length);
});
