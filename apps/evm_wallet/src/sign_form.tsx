import { useRef, useState } from "react";
import { callTool } from "neutron-tools/app";
import {
  createEvmWalletClient,
  evmOperationIsTerminal,
  type EvmOperationStatusResult,
} from "neutron-tools/evm_wallet";
import { hexToString } from "viem";
import { errorMessage } from "./data.ts";
import {
  checkSignatureRequest,
  createSignatureRequest,
  reviewSignatureRequest,
  type SignatureRequest,
  type SignatureKind,
} from "./signature_request.ts";

const wallet = createEvmWalletClient({ callTool });

export function SignForm({
  chainId,
  accountAddress,
  onResult,
}: {
  chainId: string;
  accountAddress: string;
  onResult: () => void;
}) {
  const [kind, setKind] = useState<SignatureKind>("message"),
    [content, setContent] = useState("");
  const [current, setCurrent] = useState<SignatureRequest | null>(null),
    [result, setResult] = useState<EvmOperationStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function run(action: "new" | "review" | "check") {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let intent = current;
      if (action === "new") {
        if (intent) {
          throw new Error(
            "Resolve the current signature request before creating another signature",
          );
        }
        // Keep this exact request in the live form. The public provider saves
        // it in backend memory before displaying approval; Activity provides
        // recovery after this tile reloads.
        intent = createSignatureRequest(kind, content, chainId, accountAddress);
      }
      if (!intent) {
        throw new Error("No current signature request was found");
      }
      setCurrent(intent);
      const next =
        action === "check"
          ? await checkSignatureRequest(wallet, intent, accountAddress)
          : await reviewSignatureRequest(wallet, intent, accountAddress);
      setResult(next);
      onResult();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function startAnother() {
    if (!current || !result || !evmOperationIsTerminal(result) || running.current)
      return;
    setCurrent(null);
    setResult(null);
    setContent("");
    setError(null);
  }

  const complete =
    result &&
    result.status !== "not_found" &&
    (result.status === "signed" || result.status === "confirmed");
  return (
    <section className="evm-card">
      <h2 className="evm-card-title">Sign a message</h2>
      <p className="evm-notice">
        The Wallet saves requests before approval. After a reload or lost
        response, check Activity for prepared requests, signatures and unresolved
        outcomes before starting another signature.
      </p>
      {current && (
        <div className="evm-notice" data-testid="evm-sign-current">
          <strong>
            Current {current.kind === "message" ? "personal message" : "typed data"}{" "}
            request
          </strong>
          <p className="evm-address">
            Request {current.request.requestId} · Chain {current.request.chainId}
          </p>
          <p className="evm-address">
            Signing account: {current.expectedAddress}
          </p>
          {current.kind === "message" ? (
            <>
              <pre className="evm-code">
                {hexToString(current.request.messageHex as `0x${string}`)}
              </pre>
              <details>
                <summary>Exact message bytes</summary>
                <pre className="evm-code">{current.request.messageHex}</pre>
              </details>
            </>
          ) : (
            <pre className="evm-code">{current.request.typedDataJson}</pre>
          )}
          <p>
            Check this request after a lost response. Reviewing it again keeps
            the same request ID. Approval happens in the Wallet review dialog.
          </p>
          <div className="evm-actions">
            <button
              type="button"
              className="nt-button nt-button--secondary"
              disabled={busy}
              onClick={() => void run("check")}
            >
              Check request status
            </button>
            {result && evmOperationIsTerminal(result) ? (
              <button
                type="button"
                className="nt-button"
                disabled={busy}
                onClick={startAnother}
              >
                New signature
              </button>
            ) : (
              <button
                type="button"
                className="nt-button"
                disabled={busy}
                onClick={() => void run("review")}
              >
                Review this request
              </button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="evm-error">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="evm-notice">
          {result.status === "not_found" ? (
            <p>
              The request has not been found. Review this request to
              continue with the same ID.
            </p>
          ) : (
            <>
              <p>
                Operation {result.operationId}: {result.status}
              </p>
              {result.message && <p>{result.message}</p>}
              {complete && result.signature && (
                <>
                  <p>Returned signature</p>
                  <pre className="evm-code" data-testid="evm-sign-result">
                    {result.signature}
                  </pre>
                </>
              )}
              {!evmOperationIsTerminal(result) && (
                <p>
                  No completed signature has been returned. Check status to
                  reconcile this request.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {!current && (
        <form
          className="evm-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run("new");
          }}
        >
          <label className="evm-field">
            <span>Signature type</span>
            <select
              className="nt-select"
              data-testid="evm-sign-mode"
              disabled={busy}
              value={kind}
              onChange={(e) => setKind(e.target.value as SignatureKind)}
            >
              <option value="message">Personal message (EIP-191)</option>
              <option value="typed_data">Typed data (EIP-712)</option>
            </select>
          </label>
          <label className="evm-field">
            <span>
              {kind === "message" ? "Exact message" : "Exact EIP-712 JSON"}
            </span>
            <textarea
              className="nt-input evm-code"
              data-testid="evm-sign-content"
              rows={9}
              value={content}
              disabled={busy}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              required
            />
          </label>
          <p className="evm-muted">
            {kind === "message"
              ? "The message is encoded as UTF-8 for EIP-191 signing."
              : "Original JSON text, including large integer values, is preserved for review and signing."}{" "}
            The Wallet reviews the complete request before releasing a
            signature.
          </p>
          <button
            className="nt-button"
            data-testid="evm-sign-review"
            disabled={busy}
          >
            {busy ? "Working…" : "Review signature"}
          </button>
        </form>
      )}
    </section>
  );
}
