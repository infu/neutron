import { expect, test } from "bun:test";
import { Principal } from "@icp-sdk/core/principal";
import { encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import {
  historyAddressText,
  historyPageRequest,
  parseHistoryPage,
  parseHistoryStatus,
  parseHistorySyncReport,
} from "../src/history.ts";

const ledger = "mxzaz-hqaaa-aaaar-qaada-cai";
const subaccount = Uint8Array.from([
  ...new Array(31).fill(0),
  255,
]);
const accountId = Uint8Array.from(
  { length: 32 },
  (_, index) => index,
);

test("Wallet history preserves exact amounts and structured cursors", () => {
  const page = parseHistoryPage({
    records: [
      {
        transaction: {
          ledger,
          symbol: "ckBTC",
          decimals: "8",
          logo: "data:image/png;base64,AA==",
          value: {
            block_index: "900719925474099312345",
            operation: { transfer: null },
            timestamp_ns: "1783958400123456789",
            amount: "123456789012345678901234",
            fee: "10",
            balance_effect: "-123456789012345678901244",
            from: {
              icrc: {
                owner: ledger,
                subaccount,
              },
            },
            to: {
              icrc: {
                owner: "aaaaa-aa",
                subaccount: null,
              },
            },
            spender: { icp_account_identifier: accountId },
            memo: Uint8Array.of(1, 2),
            intent: null,
            native: null,
            provenance: { index: null },
            verification: { verified: null },
          },
        },
      },
    ],
    next: {
      timestamp_ns: "1783958400123456789",
      ledger,
      kind_order: "1",
      id: "900719925474099312345",
    },
    inspected: "1",
    has_more: true,
    warning: null,
  });

  expect(page.records[0]).toMatchObject({
    kind: "transaction",
    amount: "123456789012345678901234",
    balanceEffect: "-123456789012345678901244",
    blockIndex: "900719925474099312345",
    decimals: 8,
    memo: "0102",
  });
  const transaction = page.records[0]!;
  if (transaction.kind !== "transaction") throw new Error("fixture");
  expect(historyAddressText(transaction.from)).toBe(
    encodeIcrcAccount({
      owner: Principal.fromText(ledger),
      subaccount,
    }),
  );
  expect(historyAddressText(transaction.to)).toBe("aaaaa-aa");
  expect(historyAddressText(transaction.spender)).toBe(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  );
  expect(historyPageRequest(page.next, ledger)).toEqual({
    ledger,
    before: {
      ...page.next,
      kind_order: 1,
    },
    limit: "40",
  });
  expect(historyPageRequest(null, null)).toEqual({ limit: "40" });
});

test("Wallet history rejects legacy and malformed blob projections", () => {
  const transaction = (overrides: Record<string, unknown>) => ({
    records: [
      {
        transaction: {
          ledger,
          symbol: "ckBTC",
          decimals: "8",
          logo: null,
          value: {
            block_index: "1",
            operation: { transfer: null },
            timestamp_ns: "1",
            amount: "1",
            fee: null,
            balance_effect: "1",
            from: null,
            to: null,
            spender: null,
            memo: null,
            intent: null,
            native: null,
            provenance: { ledger: null },
            verification: { verified: null },
            ...overrides,
          },
        },
      },
    ],
    next: null,
    inspected: "1",
    has_more: false,
    warning: null,
  });

  expect(() => parseHistoryPage(transaction({ memo: "0102" }))).toThrow(
    "Invalid history memo",
  );
  expect(() =>
    parseHistoryPage(transaction({
      from: { icrc: ledger },
    }))
  ).toThrow("Invalid ICRC history account");
  expect(() =>
    parseHistoryPage(transaction({
      from: { icp_account_identifier: new Uint8Array(31) },
    }))
  ).toThrow("Invalid ICP account id");
  expect(() =>
    parseHistoryPage(transaction({
      from: { icp_account_identifier: new Array(32).fill(0) },
    }))
  ).toThrow("Invalid ICP account id");
});

test("Wallet history decodes adjustment and sync status variants", () => {
  const page = parseHistoryPage({
    records: [
      {
        adjustment: {
          symbol: "ckBTC",
          decimals: "8",
          logo: null,
          value: {
            id: "2",
            kind: { unexplained_balance: null },
            ledger,
            timestamp_ns: "1783958400000000000",
            balance_effect: "-20",
            previous_balance: "100",
            observed_balance: "80",
            from_tip_exclusive: "10",
            to_tip_exclusive: "14",
            detail: "Visible residual",
          },
        },
      },
    ],
    next: null,
    inspected: "1",
    has_more: false,
    warning: "source warning",
  });
  expect(page.records[0]).toMatchObject({
    kind: "adjustment",
    adjustmentKind: "unexplained_balance",
    balanceEffect: "-20",
  });

  expect(
    parseHistoryStatus({
      running: false,
      ledgers: [
        {
          ledger,
          symbol: "ckBTC",
          enabled: true,
          source: { index: "n5wcd-faaaa-aaaar-qaaea-cai" },
          state: { waiting_for_index: null },
          checkpoint: null,
          last_attempt_at: "1",
          last_success_at: null,
          last_error: null,
          transaction_count: "4",
          adjustment_count: "1",
        },
        {
          ledger: "aaaaa-aa",
          symbol: "CUSTOM",
          enabled: true,
          source: { ledger: null },
          state: { idle: null },
          checkpoint: null,
          last_attempt_at: null,
          last_success_at: "2",
          last_error: null,
          transaction_count: "1",
          adjustment_count: "0",
        },
      ],
    }).ledgers,
  ).toMatchObject([
    { source: "index", state: "waiting_for_index" },
    { source: "ledger", state: "idle" },
  ]);

  expect(
    parseHistorySyncReport({
      started_at: "1",
      finished_at: "2",
      skipped_overlap: false,
      ledgers: [
        {
          ledger,
          status: "synced",
          records_added: "3",
          checkpoint: null,
          error: null,
        },
      ],
    }),
  ).toMatchObject({ results: [{ recordsAdded: "3", status: "synced" }] });
});
