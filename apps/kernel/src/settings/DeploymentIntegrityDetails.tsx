import { IoRefresh } from "react-icons/io5";
import { CopyButton } from "./CopyButton.tsx";

export function DeploymentModuleHashDetail({ hash }: { hash: string }) {
  return (
    <div
      className="settings-detail settings-detail--module-hash"
      data-tid="settings-installed-module-hash"
    >
      <dt>Installed canister Wasm SHA-256</dt>
      <dd className="settings-detail-copy-value">
        <code title={hash}>{hash}</code>
        <CopyButton label="Copy installed canister Wasm SHA-256" value={hash} />
      </dd>
    </div>
  );
}

export function DeploymentModuleHashError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="settings-inline-error"
      data-tid="settings-installed-module-hash-error"
      role="alert"
    >
      <span>Installed module hash is unavailable. {message}</span>
      <button
        aria-label="Retry installed module hash"
        className="icon-button"
        onClick={onRetry}
        title="Retry installed module hash"
        type="button"
      >
        <IoRefresh aria-hidden="true" />
      </button>
    </div>
  );
}
