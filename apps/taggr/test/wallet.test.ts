import { describe, expect, test } from "bun:test";
import { decodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import { validateToolArguments } from "neutron-tools/src/protocol.ts";
// The contract under test is Wallet's, so assert against Wallet's own schema
// rather than a copy of it that could drift.
import { walletFundingInputSchema } from "../../wallet/src/funding.ts";
import {
  createFundingRequest,
  describeWalletError,
  fundingFailureMessage,
  ICP_LEDGER,
  invoiceAccountText,
  parseFundingResult,
  principalToSubaccount,
  WALLET_FUNDING_TOOL,
  WALLET_TARGET,
  WalletFundingError,
} from "../src/wallet.ts";

const TAGGR = "6qfxa-ryaaa-aaaai-qbhsq-cai";
const IDENTITY = "jjrmb-teli6-dar7d-kr2rx-zm5ax-hh35n-u2ybm-tfjsa-v5rk4-l7gjh-eae";

/** Wallet's own `directRouteSchema` pattern for a funding destination. */
const WALLET_ACCOUNT_PATTERN = /^[a-z0-9.-]{5,160}$/;

describe("the Taggr invoice account", () => {
  test("uses Taggr's own subaccount derivation", () => {
    // `env::invoices::principal_to_subaccount`: length byte, principal, zeros.
    const subaccount = principalToSubaccount(IDENTITY);
    expect(subaccount).toHaveLength(32);
    expect(subaccount[0]).toBe(29);
    expect([...subaccount.slice(30)]).toEqual([0, 0]);
  });

  test("encodes to a destination Wallet's direct route accepts", () => {
    const account = invoiceAccountText({ taggrCanister: TAGGR, principal: IDENTITY });
    expect(account).toMatch(WALLET_ACCOUNT_PATTERN);
    const decoded = decodeIcrcAccount(account);
    expect(decoded.owner.toText()).toBe(TAGGR);
    expect([...(decoded.subaccount ?? [])]).toEqual([...principalToSubaccount(IDENTITY)]);
  });

  test("is different for a different identity, so one account cannot pay another's invoice", () => {
    const other = "2vxsx-fae";
    expect(invoiceAccountText({ taggrCanister: TAGGR, principal: IDENTITY })).not.toBe(
      invoiceAccountText({ taggrCanister: TAGGR, principal: other }),
    );
  });
});

describe("the funding request", () => {
  const fixed = (): ReturnType<typeof createFundingRequest> =>
    createFundingRequest({
      to: invoiceAccountText({ taggrCanister: TAGGR, principal: IDENTITY }),
      amountAtoms: "1234567",
      nowMs: 1_700_000_000_000,
      fillRandomValues: (bytes) => bytes.fill(0xab),
    });

  test("matches the shape Wallet's schema requires", () => {
    const request = fixed();
    expect(request.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(request.ledger).toBe(ICP_LEDGER);
    expect(request.amountAtoms).toBe("1234567");
    expect(request.route.kind).toBe("direct");
    // Nanoseconds, five minutes out.
    expect(request.validUntilNs).toBe(String((1_700_000_000_000n + 300_000n) * 1_000_000n));
    expect(request.validUntilNs).toMatch(/^[1-9][0-9]{0,19}$/);
  });

  test("validates against the schema Wallet actually publishes", () => {
    expect(() =>
      validateToolArguments(
        { name: WALLET_FUNDING_TOOL, inputSchema: walletFundingInputSchema } as never,
        fixed() as never,
      ),
    ).not.toThrow();
  });

  test("targets Wallet's resident funding tool", () => {
    expect(WALLET_TARGET).toBe("app:wallet:background");
    expect(WALLET_FUNDING_TOOL).toBe("wallet_fund_v1");
  });

  test("refuses an amount Wallet would reject", () => {
    const to = invoiceAccountText({ taggrCanister: TAGGR, principal: IDENTITY });
    // Wallet's `positiveNatPattern` excludes zero and anything non-numeric.
    expect(() => createFundingRequest({ to, amountAtoms: "0" })).toThrow(WalletFundingError);
    expect(() => createFundingRequest({ to, amountAtoms: "1.5" })).toThrow(WalletFundingError);
    expect(() => createFundingRequest({ to, amountAtoms: "" })).toThrow(WalletFundingError);
  });

  test("refuses a destination Wallet would reject", () => {
    expect(() => createFundingRequest({ to: "NOT AN ACCOUNT", amountAtoms: "1" })).toThrow(
      WalletFundingError,
    );
  });
});

describe("the funding result", () => {
  const ok = (extra: Record<string, unknown> = {}) => ({
    status: "transferred",
    commandId: "taggr:" + "ab".repeat(16),
    blockIndex: "42",
    duplicate: false,
    message: null,
    ...extra,
  });

  test("reads a completed transfer", () => {
    expect(parseFundingResult(ok(), "ab".repeat(16))).toEqual({
      status: "transferred",
      blockIndex: "42",
      message: null,
    });
  });

  test("requires a canonical ledger block index before accepting a transfer", () => {
    for (const blockIndex of [undefined, null, 42, -1, "", "01", "-1", "1.5", "1e3", " 42", "9".repeat(81)]) {
      expect(() => parseFundingResult(ok({ blockIndex }), "ab".repeat(16))).toThrow(
        /invalid transfer block index/,
      );
    }
    for (const blockIndex of ["0", "42", "900719925474099312345", "9".repeat(80)]) {
      expect(parseFundingResult(ok({ blockIndex }), "ab".repeat(16)).blockIndex).toBe(blockIndex);
    }
  });

  test("pending and rejected replies may lack transfer evidence", () => {
    for (const status of ["pending", "approved", "rejected"] as const) {
      expect(parseFundingResult(ok({ status, blockIndex: null }), "ab".repeat(16))).toEqual({
        status,
        blockIndex: null,
        message: null,
      });
    }
  });

  test("refuses a reply that answers a different request", () => {
    // Wallet stamps its own `"<caller app>:<requestId>"`; a mismatch must not be
    // read as this request's outcome.
    expect(() => parseFundingResult(ok(), "cd".repeat(16))).toThrow(
      /different funding request/,
    );
    expect(() => parseFundingResult(ok({ commandId: "wallet:x" }), "ab".repeat(16))).toThrow(
      WalletFundingError,
    );
  });

  test("refuses a malformed reply", () => {
    expect(() => parseFundingResult(null, "ab".repeat(16))).toThrow(WalletFundingError);
    expect(() => parseFundingResult(ok({ status: "maybe" }), "ab".repeat(16))).toThrow(
      /unknown funding status/,
    );
  });

  test("explains every outcome that is not a completed transfer", () => {
    expect(
      fundingFailureMessage({ status: "rejected", blockIndex: null, message: null }),
    ).toMatch(/declined in Wallet/);
    expect(
      fundingFailureMessage({ status: "pending", blockIndex: null, message: null }),
    ).toMatch(/still settling/);
    expect(
      fundingFailureMessage({ status: "approved", blockIndex: null, message: null }),
    ).toMatch(/approved/);
    // Wallet's own reason wins when it gives one.
    expect(
      fundingFailureMessage({ status: "rejected", blockIndex: null, message: "no funds" }),
    ).toBe("no funds");
  });
});

describe("a missing Wallet", () => {
  test("is explained as a choice, not a routing failure", () => {
    expect(describeWalletError(new Error("Unknown tool 'wallet_fund_v1'"))).toMatch(
      /Wallet is not installed/,
    );
    expect(describeWalletError(new Error("no such endpoint"))).toMatch(
      /register with an invite code/,
    );
  });

  test("passes any other failure through unchanged", () => {
    expect(describeWalletError(new Error("ledger unavailable"))).toBe("ledger unavailable");
  });
});
