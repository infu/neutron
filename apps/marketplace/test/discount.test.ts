import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { createDiscountPreferences, matchesSavedDiscount } from "../src/discount.ts";
import { readDiscountCode, saveDiscountCode, type Kernel } from "../src/store.ts";

const owner = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai"), affiliate = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
function fixture(initial: string | null = null) {
  let code = initial, unavailable = false, self = false, current = true, loseReply = false;
  const calls = { reads: 0, validations: [] as string[], saves: [] as Array<string | null> };
  const access = {
    owner: owner.toText(),
    read: async () => { calls.reads++; return code; },
    save: async (value: string | null) => { calls.saves.push(value); code = value; if (loseReply) throw new Error("Save reply interrupted"); return value; },
    validate: async (value: string) => { calls.validations.push(value); if (unavailable) throw new Error("Query unavailable"); if (!["WELCOME", "SECOND"].includes(value.toUpperCase())) throw new Error("This affiliate code is not registered"); return { code: value.toUpperCase(), affiliate: self ? owner : affiliate, discountBps: 1250n, termsVersion: 3n }; },
    checkCurrent: () => { if (!current) throw new Error("Account changed"); },
  };
  return { access, calls, stored: () => code, unavailable: (v: boolean) => unavailable = v, self: (v: boolean) => self = v, current: (v: boolean) => current = v, loseReply: (v: boolean) => loseReply = v };
}

test("a valid code is canonicalized, saved once and validated directly after reload", async () => {
  const f = fixture(), client = createDiscountPreferences();
  expect(await client.set(f.access, "  welcome  ")).toEqual({ code: "WELCOME", active: true, discountBps: 1250, affiliate: affiliate.toText(), error: null });
  expect(f.calls).toEqual({ reads: 0, validations: ["WELCOME"], saves: ["WELCOME"] });
  const restored = createDiscountPreferences();
  expect(await restored.discount(f.access)).toMatchObject({ code: "WELCOME", active: true, discountBps: 1250 });
  expect(await restored.discount(f.access)).toMatchObject({ active: true });
  expect(f.calls.reads).toBe(1);
  expect(f.calls.validations).toEqual(["WELCOME", "WELCOME", "WELCOME"]);
});

test("invalid and self-referral codes never replace the saved preference", async () => {
  const f = fixture("WELCOME"), client = createDiscountPreferences();
  await expect(client.set(f.access, "unknown")).rejects.toThrow("not registered");
  f.self(true);
  await expect(client.set(f.access, "second")).rejects.toThrow("own affiliate code");
  expect(f.calls.saves).toEqual([]);
  expect(f.stored()).toBe("WELCOME");
});

test("failed or unavailable restoration retains code but never shows an active discount", async () => {
  const f = fixture("WELCOME"), client = createDiscountPreferences();
  f.unavailable(true);
  expect(await client.discount(f.access)).toEqual({ code: "WELCOME", active: false, discountBps: 0, affiliate: null, error: "Query unavailable" });
  await expect(client.purchaseCode(f.access, undefined)).rejects.toThrow("saved discount could not be activated");
  expect(f.calls.saves).toEqual([]);
  f.unavailable(false);
  expect(await client.discount(f.access)).toMatchObject({ active: true });
  expect(f.calls.reads).toBe(1);
});

test("clearing stores null without querying and explicit purchase overrides leave the preference unchanged", async () => {
  const f = fixture("WELCOME"), client = createDiscountPreferences();
  expect(await client.purchaseCode(f.access, undefined)).toBe("WELCOME");
  expect(await client.purchaseCode(f.access, "")).toBe("");
  expect(await client.purchaseCode(f.access, " second ")).toBe("SECOND");
  expect(f.calls.validations).toEqual(["WELCOME"]);
  expect(await client.set(f.access, "  ")).toEqual({ code: null, active: false, discountBps: 0, affiliate: null, error: null });
  expect(f.calls.saves).toEqual([null]);
  expect(await client.discount(f.access)).toMatchObject({ code: null, active: false });
  expect(f.calls.validations).toEqual(["WELCOME"]);
});

test("a lost save reply is reconciled from durable storage before using the preference", async () => {
  const f = fixture("WELCOME"), client = createDiscountPreferences();
  await client.discount(f.access);
  f.loseReply(true);
  await expect(client.set(f.access, "SECOND")).rejects.toThrow("interrupted");
  expect(await client.discount(f.access)).toMatchObject({ code: "SECOND", active: true });
  expect(f.calls.reads).toBe(2);
});

test("scope invalidation prevents applying another Neutron's cached preference", async () => {
  const f = fixture("WELCOME"), client = createDiscountPreferences();
  await client.discount(f.access);
  f.current(false);
  await expect(client.discount(f.access)).rejects.toThrow("Account changed");
  await expect(client.set(f.access, "SECOND")).rejects.toThrow("Account changed");
  expect(f.calls.saves).toEqual([]);
});

test("saved purchase matching preserves omission while an explicit replacement or clear is rejected", () => {
  expect(matchesSavedDiscount("WELCOME", undefined)).toBe(true);
  expect(matchesSavedDiscount("WELCOME", " welcome ")).toBe(true);
  expect(matchesSavedDiscount("WELCOME", "SECOND")).toBe(false);
  expect(matchesSavedDiscount("WELCOME", "")).toBe(false);
  expect(matchesSavedDiscount("", undefined)).toBe(true);
});

test("durable discount helpers use the backend's unit and nullable-text arguments", async () => {
  const calls: unknown[] = [];
  const kernel = { querySelf: async (...args: unknown[]) => { calls.push(args); return ["WELCOME"]; }, updateSelf: async (...args: unknown[]) => { calls.push(args); return { ok: [] }; } } as unknown as Kernel;
  expect(await readDiscountCode(kernel)).toBe("WELCOME");
  expect(await saveDiscountCode(kernel, null)).toBeNull();
  expect(calls).toEqual([["marketplace_discount_code", [null]], ["marketplace_set_discount_code", [{ code: null }]]]);
});
