import { describe, expect, test } from "bun:test";
import type { MsgBusToolContext, ScopedKernelClient } from "neutron-tools/app";
import {
  assertReleasePreferences,
  assertReleasePreferencesUnchanged,
  parseReleasePreferences,
  readReleasePreferences,
  releasePreferencesEqual,
} from "../src/release_preferences.ts";

type ToolCall = Parameters<ScopedKernelClient["callTool"]>[0];
function context(
  callTool: (call: ToolCall, timeout?: number) => Promise<unknown>,
  signal?: AbortSignal,
  listTools: (target?: string) => Promise<unknown> = async () => [{ name: "updates.preferences" }],
): Pick<MsgBusToolContext, "kernel" | "signal"> {
  return { kernel: { callTool, listTools } as ScopedKernelClient, ...(signal ? { signal } : {}) };
}

describe("authoritative release preferences", () => {
  test("rereads owner changes without mutating an earlier selection", async () => {
    let current = { betaEnabled: false, revision: "0" };
    const calls: Array<{ call: ToolCall; timeout: number | undefined }> = [];
    const discoveries: Array<string | undefined> = [];
    const ctx = context(async (call, timeout) => { calls.push({ call, timeout }); return current; }, undefined, async target => {
      discoveries.push(target);
      return [{ name: "updates.preferences" }];
    });
    const original = await readReleasePreferences(ctx);
    current = { betaEnabled: true, revision: "1" };
    expect(await readReleasePreferences(ctx)).toEqual(current);
    current = { betaEnabled: false, revision: "2" };
    expect(await readReleasePreferences(ctx)).toEqual(current);
    expect(original).toEqual({ betaEnabled: false, revision: "0" });
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({
      call: { target: "kernel", name: "updates.preferences", arguments: {} }, timeout: 0,
    })));
    expect(discoveries).toEqual(["kernel", "kernel", "kernel"]);
  });

  test("an absent legacy tool defaults off but is checked again after a Kernel upgrade", async () => {
    let available = false;
    let calls = 0;
    const ctx = context(async () => {
      calls += 1;
      return { betaEnabled: true, revision: "4" };
    }, undefined, async () => available ? [{ name: "updates.preferences" }] : [{ name: "apps.install_prepared" }]);
    expect(await readReleasePreferences(ctx)).toEqual({ betaEnabled: false, revision: "0" });
    expect(calls).toBe(0);
    available = true;
    expect(await readReleasePreferences(ctx)).toEqual({ betaEnabled: true, revision: "4" });
    expect(calls).toBe(1);
  });

  test("empty successful discovery establishes legacy support without invoking a tool", async () => {
    const ctx = context(async () => { throw new Error("Unexpected preference read"); }, undefined, async () => []);
    expect(await readReleasePreferences(ctx)).toEqual({ betaEnabled: false, revision: "0" });
  });

  test("failed or malformed discovery is not evidence of legacy support", async () => {
    let calls = 0;
    const read = async () => { calls += 1; return { betaEnabled: true, revision: "1" }; };
    for (const response of [null, undefined, {}, { tools: [] }, [null], ["updates.preferences"], [{}], [{ name: null }], [{ name: "" }], [{ name: "updates.preferences" }, {}]]) {
      await expect(readReleasePreferences(context(read, undefined, async () => response))).rejects.toThrow("discovery is invalid");
    }
    const error = new Error("Kernel discovery unavailable");
    await expect(readReleasePreferences(context(read, undefined, async () => { throw error; }))).rejects.toBe(error);
    expect(calls).toBe(0);
  });

  test("transport, authorization, and unrelated tool failures never become stable selection", async () => {
    for (const error of [
      new Error("Network request failed"),
      new Error("Unauthorized"),
      new Error("Kernel tools are unavailable through the control lane"),
      new Error("Unknown kernel tool 'updates.preferences'"),
      new Error("Unknown kernel tool 'updates.other'"),
      new Error("Request failed: Unknown kernel tool 'updates.preferences'"),
      new Error("Unknown kernel tool 'updates.preferences': backend unavailable"),
      { message: "Unknown kernel tool 'updates.preferences'" },
    ]) {
      await expect(readReleasePreferences(context(async () => { throw error; }))).rejects.toBe(error);
    }
  });

  test("malformed preference responses cannot silently select either channel", async () => {
    for (const value of [
      null, undefined, false, [], "off", {},
      { betaEnabled: "false", revision: "0" },
      { betaEnabled: 1, revision: "1" },
      { betaEnabled: true },
      { betaEnabled: false, revision: 0 },
      { betaEnabled: false, revision: "-1" },
      { betaEnabled: false, revision: "01" },
      { betaEnabled: false, revision: "1.0" },
      { betaEnabled: false, revision: "1e3" },
      { betaEnabled: false, revision: " 1" },
      { betaEnabled: false, revision: "1\n" },
      { betaEnabled: false, revision: "" },
      { betaEnabled: false, revision: "0", error: "unavailable" },
    ]) {
      await expect(readReleasePreferences(context(async () => value))).rejects.toThrow("Kernel release preferences are invalid");
    }
  });

  test("keeps revisions exact beyond JavaScript's safe integer range", () => {
    const revision = "900719925474099312345678901234567890";
    expect(parseReleasePreferences({ betaEnabled: true, revision })).toEqual({ betaEnabled: true, revision });
    expect(releasePreferencesEqual(
      { betaEnabled: true, revision },
      { betaEnabled: true, revision: "900719925474099312345678901234567891" },
    )).toBe(false);
  });

  test("a cancelled selection never accepts a successful read or legacy fallback", async () => {
    for (const unavailable of [false, true]) {
      const controller = new AbortController();
      const cancelled = new Error("Selection cancelled");
      const ctx = context(async () => {
        controller.abort(cancelled);
        return { betaEnabled: true, revision: "1" };
      }, controller.signal, async () => {
        if (unavailable) { controller.abort(cancelled); return []; }
        return [{ name: "updates.preferences" }];
      });
      await expect(readReleasePreferences(ctx)).rejects.toBe(cancelled);
    }
    const controller = new AbortController();
    const cancelled = new Error("Already cancelled");
    controller.abort(cancelled);
    let calls = 0;
    await expect(readReleasePreferences(context(async () => { calls += 1; return null; }, controller.signal, async () => { calls += 1; return []; }))).rejects.toBe(cancelled);
    expect(calls).toBe(0);
  });
});

test("selection approval expires on any preference revision, including off-on-off", () => {
  const selected = { betaEnabled: false, revision: "8" };
  expect(() => assertReleasePreferencesUnchanged(selected, { ...selected })).not.toThrow();
  for (const current of [
    { betaEnabled: true, revision: "9" },
    { betaEnabled: false, revision: "10" },
    { betaEnabled: true, revision: "8" },
  ]) {
    expect(releasePreferencesEqual(selected, current)).toBe(false);
    expect(() => assertReleasePreferencesUnchanged(selected, current)).toThrow("Refresh the release selection");
  }
});

test("dispatch guard reads current authority after a selection has been reviewed", async () => {
  let revision = "4";
  const ctx = context(async () => ({ betaEnabled: false, revision }));
  const selected = await readReleasePreferences(ctx);
  await assertReleasePreferences(ctx, selected);
  revision = "6";
  await expect(assertReleasePreferences(ctx, selected)).rejects.toThrow("Refresh the release selection");
});
