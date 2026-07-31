import type { MailBackendCryptoProgress } from "./backend.ts";

export type MailKeyRotationPhase =
  | "idle"
  | "loading"
  | "rotating"
  | "migrating"
  | "retiring";

export function MailKeyRotationPanel({
  progress,
  phase,
  notice,
  error,
  onRefresh,
  onRotate,
  onMigrate,
  onRetire,
}: {
  progress: MailBackendCryptoProgress | null;
  phase: MailKeyRotationPhase;
  notice: string | null;
  error: string | null;
  onRefresh: () => void;
  onRotate: () => void;
  onMigrate: () => void;
  onRetire: () => void;
}) {
  const busy = phase !== "idle";
  if (progress === null) {
    return (
      <section className="mail-key-panel" aria-labelledby="mail-key-title">
        <KeyHeading />
        <p className="mail-settings-note">
          {phase === "loading" ? "Checking key protection…" : "Key rotation status is unavailable."}
        </p>
        <button
          type="button"
          className="nt-button nt-button--secondary"
          disabled={busy}
          onClick={onRefresh}
        >
          Retry
        </button>
      </section>
    );
  }

  const previous = progress.previousEpoch;
  const remaining = boundedCount(progress.previousReferences.total);
  return (
    <section className="mail-key-panel" aria-labelledby="mail-key-title">
      <KeyHeading />
      <div className="mail-key-generations" aria-label="Mail key generations">
        <span>Current <b>{progress.currentEpoch}</b></span>
        {previous ? <span>Previous <b>{previous}</b></span> : null}
      </div>

      {previous === null ? (
        <>
          <p className="mail-settings-note">
            Rotation creates a new key, then migrates only local encrypted-key wraps.
          </p>
          <button
            type="button"
            className="nt-button nt-button--secondary"
            disabled={busy}
            onClick={onRotate}
          >
            {phase === "rotating" ? "Starting rotation…" : "Rotate key"}
          </button>
        </>
      ) : progress.readyToRetire ? (
        <>
          <div className="mail-key-ready" role="status">
            <span aria-hidden="true">✓</span>
            All local key wraps use the current generation.
          </div>
          <p className="mail-settings-note">
            Retirement permanently disables supported future recovery with generation {previous}.
          </p>
          <button
            type="button"
            className="nt-button nt-button--critical"
            disabled={busy}
            onClick={onRetire}
          >
            {phase === "retiring" ? "Retiring previous key…" : "Retire previous key"}
          </button>
        </>
      ) : (
        <>
          <div className="mail-key-progress" role="status">
            <strong>{remaining} {remaining === 1 ? "item" : "items"} left</strong>
            <span>
              {progress.previousReferences.settings} settings · {progress.previousReferences.inbox} Inbox · {progress.previousReferences.outbox} Sent/Outbox
            </span>
          </div>
          <p className="mail-settings-note">
            Mail prepares both key generations automatically while each safe batch runs.
          </p>
          <button
            type="button"
            className="nt-button"
            disabled={busy}
            onClick={onMigrate}
          >
            {phase === "migrating" ? "Migrating a safe batch…" : "Continue migration"}
          </button>
        </>
      )}

      {notice ? <p className="mail-key-notice" role="status">{notice}</p> : null}
      {error ? (
        <p className="mail-field-error" role="alert">
          {error}{" "}
          <button
            type="button"
            className="nt-button nt-button--ghost nt-button--sm"
            onClick={onRefresh}
          >
            Retry status
          </button>
        </p>
      ) : null}
    </section>
  );
}

function KeyHeading() {
  return (
    <div className="mail-key-heading">
      <div>
        <h3 id="mail-key-title">Key protection</h3>
        <p>Resumable rotation for encrypted Mail stored in this Neutron.</p>
      </div>
      <span className="mail-key-shield" aria-hidden="true">◇</span>
    </div>
  );
}

function boundedCount(value: string): number {
  const parsed = BigInt(value);
  return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
}
