import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { InstallationQuote, OperationResult } from "../src/view-types.ts";

if (process.env.NEUTRON_MARKETPLACE_INSTALL_HANDOFF_CHILD !== "1") {
  test("installation hands a retained offer directly from the active tile to the Kernel", async () => {
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
  type Call = { endpoint: "tile" | "background"; target: string; name: string; args: Data };
  const OPERATION = "12".repeat(16), OWNER = "3rurp-vyaaa-aaaay-aacua-cai", CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const URL = `https://${OWNER}.icp0.io/#repo=${CANISTER}&manifest=${"ab".repeat(32)}&digest=${"cd".repeat(32)}`;
  const quoted: InstallationQuote = {
    operationId: OPERATION, appIds: ["editor"], canisterId: CANISTER, owner: OWNER,
    cycles: { total: "1200000", processing: "1200000", storage: "0", schedule: "1" },
    fee: { feeVersion: "1", processingCycles: "1200000", storageCycles: "0", totalCycles: "1200000", processingBytes: "100", newStorageBytes: "0" },
  };
  const ready: InstallationQuote = {
    ...quoted, setupUrl: URL,
    cycles: { ...quoted.cycles, total: "0", processing: "0" },
    fee: { ...quoted.fee, processingCycles: "0", totalCycles: "0", processingBytes: "0" },
  };
  const prepared: OperationResult = { operationId: OPERATION, appIds: ["editor"], state: "pending", nextAction: "resume", message: "Ready for the installer.", installation: ready };
  const calls: Call[] = [];
  let activation = false, focused = true, preparationCount = 0, openedFailure: Error | null = null;
  let approve: (() => void) | null = null, decline: ((reason: Error) => void) | null = null;

  // This boundary mirrors the physical endpoint/focus/activation rule exercised
  // by Kernel's real msg_bus.isolated.ts install-offer routing tests. A nested
  // background request does not inherit the originating tile's endpoint role.
  function kernelOffer(endpoint: Call["endpoint"], args: Data): Promise<Data> {
    calls.push({ endpoint, target: "kernel", name: "apps.install_offer", args });
    if (endpoint !== "tile" || !focused || !activation) return Promise.reject(Object.assign(new Error("An install offer must come from a focused app button or an active agent invocation"), { code: "USER_INTERACTION_REQUIRED" }));
    return new Promise((resolve, reject) => {
      approve = () => resolve({ presented: true, requestId: "kernel-offer" });
      decline = reject;
    });
  }
  mock.module("neutron-tools/app", () => ({
    connectEthereumProvider: async () => { throw new Error("Unexpected browser wallet access"); },
    callTool: (call: Data): Promise<Data> => {
      if (call.target === "kernel") return kernelOffer("tile", call.arguments);
      const args = JSON.parse(call.arguments.paramsJson), method = call.arguments.method;
      calls.push({ endpoint: "tile", target: call.target, name: method, args });
      if (call.target !== "app:marketplace:background") throw new Error("Unexpected app endpoint");
      if (method === "install") { preparationCount++; return Promise.resolve({ resultJson: JSON.stringify(prepared) }); }
      if (method === "installationOpened") {
        if (openedFailure) return Promise.reject(openedFailure);
        return Promise.resolve({ resultJson: JSON.stringify({ operationId: OPERATION, state: "complete", nextAction: "none", message: "Installer opened." }) });
      }
      throw new Error(`Unexpected call before installation handoff: ${method}`);
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
    calls.length = 0; activation = false; focused = true; preparationCount = 0; openedFailure = null; approve = null; decline = null;
  });

  test("the same Kernel boundary rejects a non-agent background offer even during a tile gesture", async () => {
    activation = true;
    await expect(kernelOffer("background", { kind: "repository_setup_url", url: URL })).rejects.toMatchObject({ code: "USER_INTERACTION_REQUIRED" });
    expect(approve).toBeNull();
  });

  test("charged preparation returns ready without trying an invalid background offer", async () => {
    const result = await client.install(["editor"], quoted);
    expect(result).toEqual(prepared);
    expect(calls).toEqual([{ endpoint: "tile", target: "app:marketplace:background", name: "install", args: { appIds: ["editor"], quote: quoted } }]);
    expect(preparationCount).toBe(1);
    expect(approve).toBeNull();
  });

  test("Open installer dispatches the exact retained URL before its first await", async () => {
    activation = true;
    const pending = client.openInstallation(ready);
    activation = false;
    expect(calls).toEqual([{ endpoint: "tile", target: "kernel", name: "apps.install_offer", args: { kind: "repository_setup_url", url: URL } }]);
    expect(approve).not.toBeNull();
    expect(preparationCount).toBe(0);
    approve!();
    await pending;
    expect(calls[1]?.name).toBe("installationOpened");
    expect(preparationCount).toBe(0);
  });

  test("a ready Install control also dispatches directly instead of quoting or preparing again", async () => {
    activation = true;
    const pending = client.install(["editor"], ready);
    activation = false;
    expect(calls[0]).toEqual({ endpoint: "tile", target: "kernel", name: "apps.install_offer", args: { kind: "repository_setup_url", url: URL } });
    expect(calls).toHaveLength(1);
    approve!();
    await pending;
    expect(preparationCount).toBe(0);
  });

  test("the ready shortcut still rejects a changed selection before opening the original offer", async () => {
    activation = true;
    await expect(client.install(["wallet"], ready)).rejects.toThrow("selected apps changed");
    expect(calls).toEqual([]);
    expect(preparationCount).toBe(0);
  });

  test("declining Kernel review retains the original offer for another explicit tile click", async () => {
    const original = structuredClone(ready);
    activation = true;
    const first = client.openInstallation(ready);
    decline!(new Error("The install offer was dismissed"));
    await expect(first).rejects.toThrow("dismissed");
    expect(calls.some(call => call.name === "installationOpened")).toBe(false);
    expect(ready).toEqual(original);
    activation = true;
    const retry = client.openInstallation(ready);
    expect(calls.filter(call => call.name === "apps.install_offer").map(call => call.args.url)).toEqual([URL, URL]);
    approve!(); await retry;
    expect(preparationCount).toBe(0);
  });

  test("an interrupted local opened acknowledgement cannot create another preparation", async () => {
    openedFailure = new Error("Saved acknowledgement was interrupted");
    activation = true;
    const first = client.openInstallation(ready);
    approve!();
    await expect(first).rejects.toThrow("interrupted");
    openedFailure = null;
    activation = true;
    const retry = client.openInstallation(ready);
    approve!(); await retry;
    expect(calls.filter(call => call.name === "apps.install_offer").map(call => call.args.url)).toEqual([URL, URL]);
    expect(preparationCount).toBe(0);
  });

  test("missing activation still rejects before marking the saved offer opened", async () => {
    await expect(client.openInstallation(ready)).rejects.toMatchObject({ code: "USER_INTERACTION_REQUIRED" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("apps.install_offer");
    expect(preparationCount).toBe(0);
  });
}
