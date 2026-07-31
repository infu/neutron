import {
  IoCloudUploadOutline,
  IoWarningOutline,
} from "react-icons/io5";

export function PeerDeliveryGate({
  busy,
  error,
  onEnable,
}: {
  busy: boolean;
  error: string | null;
  onEnable: () => void;
}) {
  return (
    <section
      aria-labelledby="peer-delivery-title"
      className="wg-peer-delivery-gate"
      role="region"
    >
      <div className="wg-peer-delivery-gate__icon" aria-hidden="true">
        <IoCloudUploadOutline />
      </div>
      <div className="wg-peer-delivery-gate__copy">
        <p className="nt-eyebrow">Permission needed</p>
        <h2 id="peer-delivery-title">Enable peer delivery</h2>
        <p>
          Allow Wagyu to send posts, replies, likes, follows, and shares to
          other Neutrons.
        </p>
        {error ? (
          <div className="nt-alert nt-alert--danger" role="alert">
            <IoWarningOutline aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
      <div className="wg-peer-delivery-gate__actions">
        <button
          className="nt-button wg-primary-button"
          disabled={busy}
          onClick={onEnable}
          type="button"
        >
          {busy ? "Waiting for approval…" : "Enable peer delivery"}
        </button>
      </div>
    </section>
  );
}
