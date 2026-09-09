import { expect, test } from "bun:test";
import { parseAccountAbstraction, resolveAccountMode } from "../src/account_mode.ts";

const user = "0x1111111111111111111111111111111111111111", other = "0x2222222222222222222222222222222222222222";
const state = { user, serverTime: 12345 };
const never = async () => { throw new Error("No secondary read should be made"); };

test.each(["unifiedAccount", "portfolioMargin", "disabled", "dexAbstraction"] as const)("explicit %s mode needs no extra account query", async mode => {
  const result = await resolveAccountMode(mode, user, never, { now: () => 12346 });
  expect(result).toEqual({ balanceSource: mode === "unifiedAccount" || mode === "portfolioMargin" ? "unified" : "perps", source: "userAbstraction", basis: "explicit_mode", effectiveAbstraction: mode, observedAt: 12346, serverTime: null, error: null });
});
test("only an actual default account snapshot with an absent mode resolves separate perps", async () => {
  const calls: unknown[] = [];
  const result = await resolveAccountMode("default", user, async body => { calls.push(body); return { userState: state, unrelatedData: ["not exposed"] }; }, { now: () => 12346 });
  expect(calls).toEqual([{ type: "webData3", user }]);
  expect(result).toEqual({ balanceSource: "perps", source: "webData3", basis: "default_account_state", effectiveAbstraction: "default", observedAt: 12346, serverTime: 12345, error: null });
  expect(JSON.stringify(result)).not.toContain("unrelatedData");
});
test.each(["unifiedAccount", "portfolioMargin", "disabled", "dexAbstraction"] as const)("secondary state can resolve effective %s while raw mode was default", async mode => {
  const result = await resolveAccountMode("default", user, async () => ({ userState: { ...state, abstraction: mode } }));
  expect(result.effectiveAbstraction).toBe(mode);
  expect(result.balanceSource).toBe(mode === "unifiedAccount" || mode === "portfolioMargin" ? "unified" : "perps");
  expect(result.basis).toBe("explicit_mode");
});
test.each([
  ["missing snapshot", null], ["missing userState", {}], ["wrong owner", { userState: { ...state, user: other } }],
  ["missing owner", { userState: { serverTime: 12345 } }], ["null mode", { userState: { ...state, abstraction: null } }],
  ["explicit unresolved default", { userState: { ...state, abstraction: "default" } }],
  ["unknown enum", { userState: { ...state, abstraction: "futureMode" } }], ["zero server time", { userState: { ...state, serverTime: 0 } }],
  ["text server time", { userState: { ...state, serverTime: "12345" } }], ["fractional server time", { userState: { ...state, serverTime: 1.5 } }],
] as const)("rejects %s instead of defaulting it to perps", async (_name, raw) => {
  await expect(resolveAccountMode("default", user, async () => raw)).rejects.toThrow();
});
test("unavailable primary mode makes no secondary assumption", async () => {
  expect((await resolveAccountMode(null, user, never)).balanceSource).toBe("unknown");
  for (const malformed of [null, [], ["default"], {}, "futureMode"]) expect(() => parseAccountAbstraction(malformed)).toThrow("userAbstraction");
});
test("secondary RPC errors and aborts remain available to callers as errors", async () => {
  await expect(resolveAccountMode("default", user, async () => { throw new Error("Provider HTTP 429"); })).rejects.toThrow("HTTP 429");
  const controller = new AbortController();
  await expect(resolveAccountMode("default", user, async (_body, signal) => { expect(signal).toBe(controller.signal); controller.abort(new Error("Caller canceled")); return { userState: state }; }, { signal: controller.signal })).rejects.toThrow("Caller canceled");
});
