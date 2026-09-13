import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Principal } from "@dfinity/principal";
import type { MsgBusToolContext } from "neutron-tools/app";
import type { PublicationPlan } from "../src/publication.ts";
import type { Fee, WireApp } from "../src/protocol.ts";

if (process.env.NEUTRON_PUBLICATION_SUBMISSION_CHILD !== "1") {
  test("release notes and legacy publications preserve exact candidate retry contracts", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], { env: { ...process.env, NEUTRON_PUBLICATION_SUBMISSION_CHILD: "1" }, timeout: 30_000 });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const owner = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai"), canister = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const plan: PublicationPlan = { requestId: "af".repeat(16), appId: "notes", title: "Notes", summary: "Personal notes", description: "Keeps existing notes.", priceUsdMicros: "0", version: "7", dependencies: [{ appId: "kernel", minVersion: "12" }], artifacts: [{ requestId: "ab".repeat(16), role: "package", purpose: "package", name: "notes-7.neutron", size: 100, digest: Array(32).fill(5), mediaType: "application/vnd.neutron.package" }] };
  const fee: Fee = { feeVersion: 1n, processingCycles: 100n, storageCycles: 0n, totalCycles: 100n, processingBytes: 100n, newStorageBytes: 0n };
  let remote: WireApp;
  let retained: { version: 1; canister: string; owner: string; plan: PublicationPlan; originalRevision: string; iconArtifact: null; screenshotArtifacts: string[] };
  let failSubmission = false;
  const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
  const client = {
    state: { owner: owner.toText(), canisterId: canister }, info: { fees: { version: 1n } },
    detailWire: async () => ({ app: remote }),
    estimateUpdate: async (_method: string, _request: unknown) => fee,
    update: async (method: string, request: Record<string, unknown>) => {
      calls.push({ method, request: structuredClone(request) });
      if (method === "upload_finish") return { artifactId: [9n] };
      if (method === "candidate_submit" || method === "candidate_submit_v2") {
        if (failSubmission) { failSubmission = false; throw new Error("Submission response lost"); }
        return { id: 7n };
      }
      throw new Error(`Unexpected update ${method}`);
    },
  };
  class ProtocolError extends Error { constructor(public code: string, message: string) { super(message); } }
  mock.module("../src/client.ts", () => ({ protocolClient: async () => client, randomId: () => "af".repeat(16), ProtocolError, cycleView: (value: Fee) => ({ total: String(value.totalCycles), processing: String(value.processingCycles), storage: String(value.storageCycles), schedule: String(value.feeVersion) }) }));
  const { beginPublication, quotePublication, finishPublication } = await import("../src/publishing.ts");
  const context = { kernel: {
    querySelf: async (method: string, args: unknown[]) => {
      if (method === "marketplace_draft" && args[0] === `publication:${retained.plan.requestId}`) return [new TextEncoder().encode(JSON.stringify(retained))];
      throw new Error(`Unexpected local read ${method}`);
    },
    updateSelf: async () => { throw new Error("Exact saved publication must not be replaced"); },
  } } as unknown as MsgBusToolContext;
  beforeEach(() => {
    retained = { version: 1, canister, owner: owner.toText(), plan: structuredClone(plan), originalRevision: "1", iconArtifact: null, screenshotArtifacts: [] };
    remote = { appId: plan.appId, publisher: owner, title: plan.title, summary: plan.summary, description: plan.description, priceUsdMicros: 0n, revision: 1n, version: [6n], iconUrl: [], screenshots: [], iconArtifact: [], screenshotArtifacts: [], ratingCount: 0n, ratingTotal: 0n, owned: false, visible: true };
    calls.length = 0; failSubmission = false;
  });
  test("new release notes are bound to the exact candidate and retained after a lost submit response", async () => {
    retained.plan.releaseNotes = "Search your notes\nExisting notebooks are retained.";
    const before = JSON.stringify(retained);
    failSubmission = true;
    await expect(finishPublication(context, plan.requestId)).rejects.toThrow("Submission response lost");
    const result = await finishPublication(context, plan.requestId);
    expect(result.message).toContain("available as beta");
    const submissions = calls.filter(value => value.method.startsWith("candidate_submit"));
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toEqual(submissions[1]);
    expect(submissions[0]).toMatchObject({ method: "candidate_submit_v2", request: { releaseNotes: retained.plan.releaseNotes, request: { requestId: plan.requestId, appId: "notes", artifactId: 9n, version: 7n, dependencies: [{ appId: "kernel", minVersion: 12n }] } } });
    expect(JSON.stringify(retained)).toBe(before);
  });
  test("legacy saved plans submit through the unchanged endpoint without introducing release notes", async () => {
    const before = JSON.stringify(retained);
    const quote = await quotePublication(context, retained.plan);
    await beginPublication(context, quote);
    await finishPublication(context, plan.requestId);
    expect(calls.filter(value => value.method.startsWith("candidate_submit"))).toEqual([{ method: "candidate_submit", request: { requestId: plan.requestId, appId: "notes", version: 7n, artifactId: 9n, sourceArtifactId: [], dependencies: [{ appId: "kernel", minVersion: 12n }] } }]);
    expect(JSON.stringify(retained)).toBe(before);
  });
  test("listing-only edits save without candidate submission or beta approval claims", async () => {
    retained.plan = { ...retained.plan, artifacts: [], version: null, releaseNotes: "" };
    const quote = await quotePublication(context, retained.plan);
    expect(quote.warnings).toEqual([]);
    await beginPublication(context, quote);
    expect(await finishPublication(context, plan.requestId)).toEqual({ message: "Your listing changes are saved." });
    expect(calls).toEqual([]);
  });
  test("editing retained release notes is rejected before resuming a different candidate submission", async () => {
    retained.plan.releaseNotes = "Reviewed notes";
    const quote = await quotePublication(context, { ...retained.plan, releaseNotes: "Changed notes" });
    await expect(beginPublication(context, quote)).rejects.toThrow("different files or listing text");
    expect(calls).toEqual([]);
  });
}
