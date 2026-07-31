import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { copyToClipboard, type JsonValue } from "neutron-tools/app";

export type DemoStatus = "ready" | "setup" | "partial" | "development";

export function formatError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string"
  ) {
    return reason.message;
  }
  return String(reason);
}

export function formatResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "Completed.";
  try {
    return JSON.stringify(
      value,
      (_key, nested) => {
        if (typeof nested === "bigint") return nested.toString();
        if (nested instanceof Uint8Array) return Array.from(nested);
        return nested;
      },
      2,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

export function useOperation() {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = async (
    operation: string,
    action: () => Promise<unknown>,
  ): Promise<unknown | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(operation);
    setError(null);
    try {
      const value = await action();
      setResult(formatResult(value));
      return value;
    } catch (reason) {
      setError(formatError(reason));
      return null;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  return {
    busy,
    error,
    result,
    run,
    clear() {
      setError(null);
      setResult(null);
    },
  };
}

export function CapabilityFrame({
  status,
  statusLabel,
  purpose,
  boundary,
  declaration,
  children,
  evidence,
}: {
  status: DemoStatus;
  statusLabel: string;
  purpose: string;
  boundary: string;
  declaration: string;
  children: ReactNode;
  evidence: ReactNode;
}) {
  return (
    <section className="ks-cap-page">
      <div className="ks-cap-summary">
        <span className={`ks-cap-status is-${status}`}>{statusLabel}</span>
        <p>{purpose}</p>
      </div>
      <section className="ks-cap-action" aria-label="Try this capability">
        <p className="nt-eyebrow">Try it</p>
        {children}
      </section>
      <section className="ks-cap-evidence" aria-labelledby="cap-evidence-title">
        <div>
          <p className="nt-eyebrow">Evidence</p>
          <h2 id="cap-evidence-title">What Neutron scoped</h2>
        </div>
        {evidence}
      </section>
      <details className="ks-boundary">
        <summary>Security boundary and declaration</summary>
        <p>{boundary}</p>
        <pre className="nt-pre nt-pre--wrap"><code>{declaration}</code></pre>
      </details>
    </section>
  );
}

export function OperationResult({
  busy,
  error,
  result,
  idle = "Run the demo to see its exact result.",
  testId,
}: {
  busy: string | null;
  error: string | null;
  result: string | null;
  idle?: string;
  testId?: string;
}) {
  return (
    <div
      aria-busy={busy ? "true" : "false"}
      aria-live={error ? "assertive" : "polite"}
      className={`ks-operation-result${error ? " is-error" : ""}`}
      data-tid={testId}
      role={error ? "alert" : "status"}
    >
      {busy ? (
        <span>Running {busy}…</span>
      ) : error ? (
        <span>{error}</span>
      ) : result ? (
        <pre>{result}</pre>
      ) : (
        <span className="nt-muted">{idle}</span>
      )}
    </div>
  );
}

export function EvidenceList({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="ks-evidence-list">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const id = useId();
  const [status, setStatus] = useState("Copy");
  const resetTimer = useRef<number | null>(null);
  useEffect(() => {
    setStatus("Copy");
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = null;
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, [value]);

  const announce = (next: "Copied" | "Unavailable") => {
    setStatus(next);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      setStatus("Copy");
      resetTimer.current = null;
    }, 1_800);
  };
  return (
    <div className="nt-field ks-copy-value">
      <label className="nt-label" htmlFor={id}>{label}</label>
      <div className="nt-copy-field">
        <input id={id} className="nt-input" readOnly value={value} />
        <button
          className="nt-button nt-button--secondary"
          onClick={() => {
            void copyToClipboard(value)
              .then(() => announce("Copied"))
              .catch(() => announce("Unavailable"));
          }}
          type="button"
        >
          {status}
        </button>
      </div>
      <span aria-live="polite" className="nt-sr-only">
        {status === "Copy" ? "" : `${label}: ${status}`}
      </span>
    </div>
  );
}

export function requiredObject(value: JsonValue, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
