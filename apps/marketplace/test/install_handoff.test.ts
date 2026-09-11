import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { InstallationQuote, OperationResult } from "../src/view-types.ts";

if (process.env.NEUTRON_MARKETPLACE_INSTALL_HANDOFF_CHILD !== "1") {
  test("installation prepares once and hands private access to the generic installer", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_INSTALL_HANDOFF_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  type Data = Record<string, any>;
  type Call = { target: string; name: string; args: Data };
  const OPERATION = "12".repeat(16), OWNER = "3rurp-vyaaa-aaaay-aacua-cai", CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const URL = `https://${OWNER}.icp0.io/#repo=${CANISTER}&manifest=${"ab".repeat(32)}&digest=${"cd".repeat(32)}`;
  const TOKEN = "private-download-access-token";
  const quoted: InstallationQuote = {
    operationId: OPERATION, appIds: ["editor"], canisterId: CANISTER, owner: OWNER,
    cycles: { total: "251200000", processing: "251200000", storage: "0", schedule: "1" },
    fee: { feeVersion: "1", processingCycles: "1200000", storageCycles: "0", totalCycles: "1200000", processingBytes: "100", newStorageBytes: "0" },
    sourceAccess: { source: CANISTER, feeVersion: "1", cycles: "250000000" },
  };
  const ready: InstallationQuote = {
    ...quoted, setupUrl: URL,
    cycles: { ...quoted.cycles, total: "0", processing: "0" },
    fee: { ...quoted.fee, processingCycles: "0", totalCycles: "0", processingBytes: "0" },
    sourceAccess: { ...quoted.sourceAccess!, cycles: "0" },
  };
  const prepared: OperationResult = { operationId: OPERATION, appIds: ["editor"], state: "pending", nextAction: "resume", message: "Ready for the installer.", installation: ready };
  const complete: OperationResult = { ...prepared, state: "complete", nextAction: "none", message: "Installer opened." };
  const handoff = { url: URL, appIds: ["editor"], access: { source: CANISTER, token: TOKEN, paths: ["/private/editor.neutron"] } };
  const calls: Call[] = [];
  let preparationFailure: Error | null = null, openedFailure: Error | null = null, kernelFailure: Error | null = null;
  let delayPreparation = false, releasePreparation: (() => void) | null = null;
  let privateReply: Data, freshQuote: InstallationQuote, presented = true;

  mock.module("neutron-tools/app", () => ({
    connectEthereumProvider: async () => { throw new Error("Unexpected browser wallet access"); },
    callTool: async (call: Data): Promise<Data> => {
      if (call.target === "kernel") {
        calls.push({ target: "kernel", name: call.name, args: call.arguments });
        if (call.name !== "apps.install_prepared") throw new Error("Expected the manifest-authorized prepared installer capability");
        if (kernelFailure) throw kernelFailure;
        return { presented, requestId: "kernel-installer" };
      }
      const args = JSON.parse(call.arguments.paramsJson), method = call.arguments.method;
      calls.push({ target: call.target, name: method, args });
      if (call.target !== "app:marketplace:background") throw new Error("Unexpected app endpoint");
      if (method === "quoteInstallation") return { resultJson: JSON.stringify(freshQuote) };
      if (method === "install") {
        if (delayPreparation) await new Promise<void>(resolve => { releasePreparation = resolve; });
        if (preparationFailure) throw preparationFailure;
        return { resultJson: JSON.stringify(privateReply) };
      }
      if (method === "installationOpened") {
        if (openedFailure) throw openedFailure;
        return { resultJson: JSON.stringify(complete) };
      }
      throw new Error(`Unexpected call during installation: ${method}`);
    },
  }));
  mock.module("../src/publication.ts", () => ({
    base64: () => { throw new Error("Unexpected publication"); },
    preparePublication: async () => { throw new Error("Unexpected publication"); },
    publicationFiles: () => [], UPLOAD_CHUNK_BYTES: 49152,
  }));
  const { createMarketplaceClient } = await import("../src/tile_client.ts");
  const client = createMarketplaceClient();
  beforeEach(() => {
    calls.length = 0; preparationFailure = null; openedFailure = null; kernelFailure = null;
    delayPreparation = false; releasePreparation = null; presented = true;
    privateReply = { result: structuredClone(prepared), handoff: structuredClone(handoff) };
    freshQuote = structuredClone(quoted);
  });

  test("one Install invocation awaits charged preparation then opens the generic installer automatically", async () => {
    delayPreparation = true;
    const pending = client.install(["editor"], quoted);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ target: "app:marketplace:background", name: "install", args: { appIds: ["editor"], quote: quoted } });
    expect(releasePreparation).not.toBeNull();
    // The async preparation has no transient browser gesture to preserve.
    await new Promise(resolve => setTimeout(resolve, 0));
    releasePreparation!();
    const result = await pending;
    expect(calls.map(call => call.name)).toEqual(["install", "apps.install_prepared", "installationOpened"]);
    expect(calls[1]?.args).toEqual(handoff);
    expect(calls[2]?.args).toEqual({ quote: ready });
    expect(result).toEqual(complete);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(calls.filter(call => call.target !== "kernel"))).not.toContain(TOKEN);
  });

  test("resuming a prepared selection obtains its private handoff using the original request", async () => {
    await client.openInstallation(ready);
    expect(calls.map(call => call.name)).toEqual(["install", "apps.install_prepared", "installationOpened"]);
    expect(calls[0]?.args).toEqual({ appIds: ["editor"], quote: ready });
    expect(calls[1]?.args.url).toBe(URL);
  });

  test("a changed selection rejects before preparing or presenting anything", async () => {
    await expect(client.install(["wallet"], ready)).rejects.toThrow("selected apps changed");
    expect(calls).toEqual([]);
  });

  test("a private preparation failure cannot open or acknowledge an installer", async () => {
    preparationFailure = new Error("Preparation response interrupted");
    await expect(client.install(["editor"], quoted)).rejects.toThrow("interrupted");
    expect(calls.map(call => call.name)).toEqual(["install"]);
  });

  test("a non-ready response returns its public state without handoff", async () => {
    privateReply = { result: { ...prepared, state: "review_required", installation: quoted } };
    const result = await client.install(["editor"], quoted);
    expect(result).toEqual(privateReply.result);
    expect(calls.map(call => call.name)).toEqual(["install"]);
  });

  test("an unsuccessful handoff preserves the same saved request for retry", async () => {
    kernelFailure = new Error("The installer is unavailable");
    const original = structuredClone(ready);
    await expect(client.openInstallation(ready)).rejects.toThrow("unavailable");
    expect(calls.some(call => call.name === "installationOpened")).toBe(false);
    kernelFailure = null;
    await client.openInstallation(ready);
    expect(calls.filter(call => call.name === "install").map(call => call.args.quote.operationId)).toEqual([OPERATION, OPERATION]);
    expect(calls.filter(call => call.name === "apps.install_prepared").map(call => call.args.url)).toEqual([URL, URL]);
    expect(ready).toEqual(original);
  });

  test("a lost opened acknowledgement resumes the original handoff without a new intent", async () => {
    openedFailure = new Error("Saved acknowledgement was interrupted");
    await expect(client.openInstallation(ready)).rejects.toThrow("interrupted");
    openedFailure = null;
    await client.openInstallation(ready);
    expect(calls.filter(call => call.name === "install").map(call => call.args.quote.operationId)).toEqual([OPERATION, OPERATION]);
    expect(calls.filter(call => call.name === "apps.install_prepared").map(call => call.args.url)).toEqual([URL, URL]);
  });

  test("an unpresented installer is not marked opened", async () => {
    presented = false;
    await expect(client.openInstallation(ready)).rejects.toThrow("did not open");
    expect(calls.map(call => call.name)).toEqual(["install", "apps.install_prepared"]);
  });

  test("legacy saved quotes display newly required access cost before any charged resume", async () => {
    const { sourceAccess: _, ...legacy } = ready;
    freshQuote = { ...ready, sourceAccess: quoted.sourceAccess, cycles: { ...ready.cycles, total: "250000000", processing: "250000000" } };
    const result = await client.openInstallation(legacy);
    expect(calls.map(call => call.name)).toEqual(["quoteInstallation"]);
    expect(calls[0]?.args).toEqual({ appIds: ["editor"], operationId: OPERATION });
    expect(result.state).toBe("review_required");
    expect(result.installation).toEqual(freshQuote);
  });

  test("legacy saved quotes with already-paid access resume using the refreshed zero-cost quote", async () => {
    const { sourceAccess: _, ...legacy } = ready;
    freshQuote = ready;
    await client.openInstallation(legacy);
    expect(calls.map(call => call.name)).toEqual(["quoteInstallation", "install", "apps.install_prepared", "installationOpened"]);
    expect(calls[1]?.args.quote).toEqual(ready);
  });

  test("mismatched private handoff cannot open a different selection", async () => {
    privateReply.handoff.appIds = ["wallet"];
    await expect(client.install(["editor"], quoted)).rejects.toThrow("does not match");
    expect(calls.map(call => call.name)).toEqual(["install"]);
  });
}
