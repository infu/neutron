import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Principal } from "@dfinity/principal";
import type { MsgBusToolContext } from "neutron-tools/app";
import { checkoutType, decodeOpaque, encodeOpaque, type Checkout, type Info } from "../src/protocol.ts";

// Keep transport substitution isolated from the other client/action tests.
if (process.env.NEUTRON_MARKETPLACE_CLIENT_RECOVERY_CHILD !== "1") {
  test("retained purchase recovery does not require current catalog availability", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_CLIENT_RECOVERY_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const OWNER = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai");
  const PROTOCOL = Principal.fromText("233tv-xiaaa-aaaay-aacta-cai");
  const LEDGER = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
  const info: Info = {
    version: 1n, canister: PROTOCOL,
    tokens: [{ ledger: LEDGER, symbol: "ckUSDC", decimals: 6, fee: 10000n, rateSymbol: "USDC", burnAccount: [] }],
    fees: {}, referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
  };
  const quote: Checkout = {
    request: { requestId: "ab".repeat(16), appIds: ["saved_app"], ledger: LEDGER, referralCode: [] }, buyer: OWNER,
    items: [{ appId: "saved_app", listingRevision: 1n, publisher: PROTOCOL, priceUsdMicros: 9000000n, paidAtoms: 9000000n,
      developerAtoms: 2700000n, affiliateAtoms: 0n, burnAtoms: 6300000n, releaseDigest: new Uint8Array(32).fill(5) }],
    amount: 9000000n, fee: 10000n, affiliate: [], rate: [], spender: { owner: PROTOCOL, subaccount: [] },
    commitment: new Uint8Array(32).fill(7), quotedAtNs: 1n,
    cycles: { feeVersion: 1n, processingCycles: 100n, storageCycles: 0n, totalCycles: 100n, processingBytes: 0n, newStorageBytes: 0n },
  };
  let detail: () => unknown;
  const actualTransport = await import("../src/transport.ts");
  mock.module("../src/transport.ts", () => ({
    ...actualTransport, makeAgent: async () => ({}), makeTransport: () => ({
      query: async (name: string) => {
        if (name === "marketplace_info") return info;
        if (name === "app_detail") return detail();
        throw new Error(`Unexpected query ${name}`);
      },
    }),
  }));
  const { clearClient, protocolClient } = await import("../src/client.ts");
  const context = (signal = new AbortController().signal) => ({ signal, kernel: {
    querySelf: async () => ({ seed: [], canister: [PROTOCOL.toText()], host: "https://icp-api.io", owner: OWNER.toText(), revision: 1 }),
  } }) as unknown as MsgBusToolContext;
  beforeEach(clearClient);

  for (const unavailable of ["revoked", "read_failure"]) test(`saved terms survive ${unavailable} catalog details`, async () => {
    detail = unavailable === "revoked" ? () => ({ err: { code: "app_unavailable", message: "No approved release." } }) : () => { throw new Error("Query temporarily unavailable"); };
    const view = await (await protocolClient(context())).purchaseView(quote);
    expect(view.items[0]).toMatchObject({ id: "saved_app", title: "saved_app", publisher: PROTOCOL.toText(), priceUsdMicros: "9000000", version: "", rating: null });
    expect(view.warnings).toContain("Current listing details for saved_app are unavailable. This review uses the saved purchase; current release availability is not confirmed.");
    expect(view.allocations[0]).toMatchObject({ principal: PROTOCOL.toText(), amount: { atoms: "2700000" } });
    expect(view.opaque).toEqual(encodeOpaque(checkoutType, quote));
    expect(decodeOpaque<Checkout>(checkoutType, view.opaque).items[0]!.releaseDigest).toEqual(quote.items[0]!.releaseDigest);
  });

  test("available display metadata preserves the saved publisher and price", async () => {
    detail = () => ({ ok: { app: {
      appId: "saved_app", title: "Current display title", summary: "Current summary", publisher: OWNER,
      priceUsdMicros: 12000000n, version: [3n], ratingCount: 0n, ratingTotal: 0n, owned: false, iconUrl: [],
    } } });
    const view = await (await protocolClient(context())).purchaseView(quote);
    expect(view.items[0]).toMatchObject({ title: "Current display title", publisher: PROTOCOL.toText(), priceUsdMicros: "9000000", version: "3" });
    expect(view.warnings).toEqual([]);
  });

  test("aborting a metadata request still aborts recovery", async () => {
    const controller = new AbortController();
    detail = () => { controller.abort(new Error("Canceled recovery")); throw controller.signal.reason; };
    await expect((await protocolClient(context(controller.signal))).purchaseView(quote)).rejects.toThrow("Canceled recovery");
  });
}
