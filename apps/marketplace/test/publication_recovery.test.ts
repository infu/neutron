import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Principal } from "@dfinity/principal";
import type { MsgBusToolContext } from "neutron-tools/app";
import type { PublicationPlan } from "../src/publication.ts";
import type { PublicationQuote } from "../src/view-types.ts";
import type { Info, WireApp } from "../src/protocol.ts";

// Isolate the transport fixture from the other production-client tests.
if (process.env.NEUTRON_MARKETPLACE_PUBLICATION_RECOVERY_CHILD !== "1") {
  test("retained publications survive new listing limits without weakening new publications", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_PUBLICATION_RECOVERY_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const owner = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai"), canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const info: Info = { version: 1n, canister, tokens: [], fees: {}, referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n } };
  const basePlan: PublicationPlan = { requestId: "ab".repeat(16), appId: "legacy_app", title: "Legacy app", summary: "Original excerpt", description: "Original description", priceUsdMicros: "1000000", artifacts: [], version: null, dependencies: [] };
  type Saved = { version: 1; canister: string; owner: string; plan: PublicationPlan; originalRevision: string | null; iconArtifact: string | null; screenshotArtifacts: string[] };
  let retained: Saved | null = null, draftReads = 0;
  let remote: WireApp;
  const protocolCalls: string[] = [], mutations: string[] = [];
  const actualTransport = await import("../src/transport.ts");
  mock.module("../src/transport.ts", () => ({ ...actualTransport, makeAgent: async () => ({}), makeTransport: () => ({
    query: async (method: string) => {
      protocolCalls.push(method);
      if (method === "marketplace_info") return info;
      if (method === "app_detail") return { ok: { app: remote, candidate: [], audit: [], rating: [] } };
      throw new Error(`Unexpected protocol query ${method}`);
    },
    update: async (method: string) => { mutations.push(method); throw new Error("Recovery must not send a new update."); },
  }) }));
  const { clearClient } = await import("../src/client.ts");
  const { beginPublication, quotePublication } = await import("../src/publishing.ts");
  const context = { signal: new AbortController().signal, kernel: {
    querySelf: async (method: string, args: unknown[]) => {
      if (method === "marketplace_state") return { seed: [], canister: [canister.toText()], host: "https://icp-api.io", owner: owner.toText(), revision: 1 };
      if (method === "marketplace_draft") {
        draftReads++;
        return retained && args[0] === `publication:${retained.plan.requestId}` ? [new TextEncoder().encode(JSON.stringify(retained))] : [];
      }
      throw new Error(`Unexpected local query ${method}`);
    },
    updateSelf: async (method: string) => { mutations.push(method); throw new Error("Recovery must preserve its original saved intent."); },
  } } as unknown as MsgBusToolContext;
  const quote = (plan: PublicationPlan): PublicationQuote => ({ opaque: plan, cycles: { total: "1", processing: "1", schedule: "legacy" }, bytes: 0, coverageEndsAt: "2027-09-10T00:00:00.000Z", warnings: [] });
  function restore(plan: PublicationPlan) {
    retained = { version: 1, canister: canister.toText(), owner: owner.toText(), plan, originalRevision: "1", iconArtifact: "8", screenshotArtifacts: ["9"] };
    remote = { appId: plan.appId, publisher: owner, title: plan.title, summary: plan.summary, description: plan.description, priceUsdMicros: BigInt(plan.priceUsdMicros), revision: 2n, version: [7n], iconUrl: [], screenshots: [], iconArtifact: [8n], screenshotArtifacts: [9n], ratingCount: 0n, ratingTotal: 0n, owned: false, visible: true };
  }
  beforeEach(() => { clearClient(); retained = null; draftReads = 0; protocolCalls.length = 0; mutations.length = 0; });

  for (const [field, text, message] of [
    ["summary", "🪐".repeat(256), "Keep the excerpt to 255 characters or fewer."],
    ["description", "🪐".repeat(5001), "Keep the description to 5,000 characters or fewer."],
  ] as const) {
    test(`exact retained overlong ${field} resumes without a replacement intent or listing update`, async () => {
      const plan = { ...basePlan, [field]: text }; restore(plan);
      const original = JSON.stringify(retained);
      expect(await beginPublication(context, quote(structuredClone(plan)))).toEqual({ requestId: plan.requestId });
      expect(JSON.stringify(retained)).toBe(original);
      expect(protocolCalls).toEqual(["marketplace_info", "app_detail"]);
      expect(mutations).toEqual([]);
    });
    test(`new overlong ${field} still fails before any remote call or saved intent`, async () => {
      const plan = { ...basePlan, [field]: text };
      await expect(beginPublication(context, quote(plan))).rejects.toThrow(message);
      await expect(quotePublication(context, plan)).rejects.toThrow(message);
      expect(retained).toBeNull(); expect(protocolCalls).toEqual([]); expect(mutations).toEqual([]);
    });
  }
  test("retained text must still match the exact reviewed plan", async () => {
    restore({ ...basePlan, summary: "🪐".repeat(256) });
    await expect(beginPublication(context, quote({ ...retained!.plan, description: "Changed after review" }))).rejects.toThrow("different files or listing text");
    expect(protocolCalls).toEqual(["marketplace_info"]); expect(mutations).toEqual([]);
  });
  for (const scope of ["owner", "canister"] as const) test(`retained historical text remains bound to its original ${scope}`, async () => {
    restore({ ...basePlan, description: "🪐".repeat(5001) }); retained![scope] = "aaaaa-aa";
    await expect(beginPublication(context, quote(retained!.plan))).rejects.toThrow("original marketplace and Neutron");
    expect(protocolCalls).toEqual(["marketplace_info"]); expect(mutations).toEqual([]);
  });
  test("retained publications still pass the existing structural validation first", async () => {
    restore({ ...basePlan, summary: "🪐".repeat(256), priceUsdMicros: "1" });
    await expect(beginPublication(context, quote(retained!.plan))).rejects.toThrow("Apps must be free or priced from $1 to $50.");
    expect(draftReads).toBe(0); expect(protocolCalls).toEqual([]); expect(mutations).toEqual([]);
  });
}
