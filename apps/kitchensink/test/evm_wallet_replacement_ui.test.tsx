import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseEvmOperationResult, type EvmOperationResult } from "neutron-tools/evm_wallet";
import {
  createEvmDemoIntent,
  evmDemoRecordTerminal,
  evmDemoStepSucceeded,
  type EvmDemoRecord,
} from "../src/evm_wallet_demo.ts";
import { SavedEvmRequest } from "../src/evm_wallet_page.tsx";

const transactionHash = `0x${"11".repeat(32)}`;
const replacementTransactionHash = `0x${"22".repeat(32)}`;

for (const status of ["unknown", "submitted"] as const) {
  test(`${status} replacement evidence keeps the saved request open for reconciliation`, () => {
    const record = savedRecord(status);
    expect(evmDemoRecordTerminal(record)).toBe(false);
    expect(evmDemoStepSucceeded(record.progress[0]!)).toBe(false);

    const { html, button } = renderSavedRecord(record);
    expect(html).toContain(`</strong>: ${status}`);
    expect(html).toContain("The replacement outcome is pending or unknown.");
    expect(html).toContain("Reconcile this saved request in EVM Wallet to establish what happened.");
    expect(html).not.toContain("this sequence has ended");
    expect(html).not.toContain("save a new intent");
    expect(button).toContain("Reconcile or resume saved request");
    expect(button).not.toMatch(/\bdisabled(?:=|\s|>)/u);
  });
}

test("a canonical replacement ends the old sequence and permits explicit new preparation", () => {
  const record = savedRecord("replaced");
  expect(evmDemoRecordTerminal(record)).toBe(true);
  expect(evmDemoStepSucceeded(record.progress[0]!)).toBe(false);

  const { html, button } = renderSavedRecord(record);
  expect(html).toContain("</strong>: replaced");
  expect(html).toContain("The original transaction was replaced and this sequence has ended.");
  expect(html).toContain("You can explicitly save a new intent above.");
  expect(html).not.toContain("The replacement outcome is pending or unknown.");
  expect(button).toContain("Recorded terminal outcome");
  expect(button).toMatch(/\bdisabled=""/u);
});

function savedRecord(status: EvmOperationResult["status"]): EvmDemoRecord {
  const intent = createEvmDemoIntent({
    kind: "native",
    chainId: "1",
    account: {
      accountId: "main",
      address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
      publicKey: "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      keyFingerprint: `0x${"ab".repeat(32)}`,
      namespaceVersion: "1",
    },
    destination: "0x3333333333333333333333333333333333333333",
    amountAtoms: "1000000",
  }, () => "01".repeat(16));
  const request = intent.steps[0]!.request;
  const operation = parseEvmOperationResult({
    accountId: request.accountId,
    chainId: request.chainId,
    requestId: request.requestId,
    operationId: "42",
    kind: "transaction",
    status,
    address: intent.account.address,
    transactionHash,
    replacementTransactionHash,
    signature: null,
    message: null,
    reviewRevision: "1",
    receipt: null,
  }, request, "transaction");
  return {
    intent,
    revision: 2,
    progress: [{ attempted: true, operation, error: null, signatureVerified: false }],
  };
}

function renderSavedRecord(record: EvmDemoRecord): { html: string; button: string } {
  const original = JSON.stringify(record);
  let advances = 0;
  const html = renderToStaticMarkup(<SavedEvmRequest
    record={record}
    busy={false}
    advance={() => { advances += 1; }}
  />);
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu) ?? [];
  expect(buttons).toHaveLength(1);
  expect(html).toContain(`Request ${record.intent.id}`);
  expect(html).toContain(`Transaction: <code>${transactionHash}</code>`);
  expect(html).toContain(`Replacement: <code>${replacementTransactionHash}</code>`);
  expect(JSON.stringify(record)).toBe(original);
  expect(advances).toBe(0);
  return { html, button: buttons[0]! };
}
