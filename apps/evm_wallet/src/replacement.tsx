import { useState, useRef } from "react";
import { callTool, type JsonObject } from "neutron-tools/app";
import {
  EVM_WALLET_TARGET,
  EVM_WALLET_TOOLS,
  parseEvmReplaceTransactionRequest,
  parseEvmOperationResult,
  parseEvmOperationStatusResult,
  type EvmReplaceTransactionRequest,
} from "neutron-tools/evm_wallet";
import { errorMessage, requestId, type Operation } from "./data.ts";
import { onFormActionKeyDown, runFormAction } from "./form_actions.ts";
export function ReplacementForm({
  operation,
  onResult,
}: {
  operation: Operation;
  onResult: () => void;
}) {
  const old =
      operation.review?.maxFeePerGas ?? operation.review?.gasPrice ?? "0",
    tip = operation.review?.maxPriorityFeePerGas ?? "0";
  const [maxFee, setMaxFee] = useState(
      ((BigInt(old) * 12n) / 10n + 1n).toString(),
    ),
    [priority, setPriority] = useState(
      ((BigInt(tip) * 12n) / 10n + 1n).toString(),
    ),
    [cancel, setCancel] = useState(false),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [saved, setSaved] = useState<EvmReplaceTransactionRequest | null>(null);
  const running = useRef(false);
  async function review() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      let request: EvmReplaceTransactionRequest;
      if (saved) {
        request = parseEvmReplaceTransactionRequest(saved);
        const status = parseEvmOperationStatusResult(
          await callTool({
            target: EVM_WALLET_TARGET,
            name: EVM_WALLET_TOOLS.operationStatus,
            arguments: {
              requestId: request.requestId,
              accountId: request.accountId,
              chainId: request.chainId,
            },
          }),
          request,
        );
        if (status.status !== "not_found" && status.status !== "prepared") {
          setNotice(
            `Replacement operation ${status.operationId}: ${status.status}`,
          );
          onResult();
          return;
        }
      } else {
        request = parseEvmReplaceTransactionRequest({
          requestId: requestId(),
          accountId: operation.accountId,
          chainId: operation.chainId,
          operationId: operation.operationId,
          cancel,
          maxFeePerGasWei: maxFee,
          maxPriorityFeePerGasWei: priority,
        });
        setSaved(request);
      }
      const result = parseEvmOperationResult(
        await callTool({
          target: EVM_WALLET_TARGET,
          name: EVM_WALLET_TOOLS.replaceTransaction,
          arguments: request as unknown as JsonObject,
        }),
        request,
        "transaction",
      );
      setNotice(
        `Replacement operation ${result.operationId}: ${result.status}`,
      );
      onResult();
    } catch (e) {
      setError(
        `${errorMessage(e)}. The same request is checked when you review again. After a reload, reconcile it in Activity.`,
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Speed up or cancel</summary>
      <form
        className="evm-form"
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => onFormActionKeyDown(e, busy, () => void review())}
      >
        <p className="evm-muted">
          The backend saves replacements before approval. After reload, recover
          them in Activity. Replaces the same nonce. The original can still
          confirm before the replacement. Fees below are in wei per gas.
        </p>
        <label className="evm-field">
          Action
          <select
            className="nt-select"
            value={cancel ? "cancel" : "speed"}
            onChange={(e) => setCancel(e.target.value === "cancel")}
          >
            <option value="speed">Speed up the same transaction</option>
            <option value="cancel">
              Cancel with a zero-value self transfer
            </option>
          </select>
        </label>
        <label className="evm-field">
          Maximum fee per gas
          <input
            className="nt-input"
            value={maxFee}
            onChange={(e) => setMaxFee(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="evm-field">
          Priority fee per gas
          <input
            className="nt-input"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            inputMode="numeric"
          />
        </label>
        {error && <p className="evm-error">{error}</p>}
        {notice && <p className="evm-notice">{notice}</p>}
        <button
          type="button"
          className="nt-button nt-button--secondary"
          disabled={busy}
          onClick={(e) => runFormAction(e.currentTarget.form, busy, () => void review())}
        >
          {busy ? "Working…" : "Review replacement"}
        </button>
      </form>
    </details>
  );
}
