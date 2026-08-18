import { useState, type ReactNode } from "react";
import { IoDownloadOutline } from "react-icons/io5";
import { DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES } from "neutron-compiler/src/deployment_record.js";
import { CopyButton } from "./CopyButton.tsx";
import {
  downloadDeploymentBuildRecordJson,
  type InstalledDeploymentBuildRecordInspection,
} from "./deployment_build_record.ts";
import type { InstalledModuleHashComparison } from "./deployment_integrity.ts";

export type DeploymentBuildRecordViewState =
  | Readonly<{ status: "loading" }>
  | InstalledDeploymentBuildRecordInspection;

export function DeploymentBuildRecordDetails({
  comparison,
  comparisonUnavailableMessage = null,
  inspection,
  refreshRace = null,
  runtimeInconsistency = null,
}: {
  comparison: InstalledModuleHashComparison | null;
  comparisonUnavailableMessage?: string | null;
  inspection: DeploymentBuildRecordViewState;
  refreshRace?: Readonly<{
    beforeDeploymentId: string;
    afterDeploymentId: string;
  }> | null;
  runtimeInconsistency?: string | null;
}) {
  if (inspection.status === "loading") {
    return (
      <DeploymentRecordShell className="is-loading">
        <p role="status">Inspecting the deployment build record…</p>
      </DeploymentRecordShell>
    );
  }

  if (inspection.status === "legacy") {
    return (
      <DeploymentRecordShell className="is-legacy">
        <StatusMessage
          label="Legacy / build record unavailable"
          message="No build record is installed at the fixed path. This may be a legacy deployment; Neutron does not infer source, build, or expected-hash facts from the missing record."
          status="legacy"
        />
        <RecordPath path={inspection.recordPath} />
      </DeploymentRecordShell>
    );
  }

  if (inspection.status === "unavailable") {
    return (
      <DeploymentRecordShell className="is-unavailable">
        <StatusMessage
          label="Record unavailable"
          message={inspection.message}
          status="unavailable"
        />
        <RecordPath path={inspection.recordPath} />
      </DeploymentRecordShell>
    );
  }

  if (inspection.status === "invalid") {
    return (
      <DeploymentRecordShell className="is-invalid">
        <StatusMessage
          label="Invalid installed record"
          message={inspection.message}
          status="invalid"
        />
        <RecordPath path={inspection.recordPath} />
      </DeploymentRecordShell>
    );
  }

  const record = inspection.record;
  const recordDeploymentId = inspection.expectedModuleHash.deployment_id;
  const expectedHash = inspection.expectedModuleHash.sha256;
  return (
    <DeploymentRecordShell className={`is-${comparison?.status ?? "pending"}`}>
      <StatusMessageForComparison
        comparison={comparison}
        comparisonUnavailableMessage={comparisonUnavailableMessage}
        legacyObserved={record.state === "legacy_observed"}
        refreshRace={refreshRace}
        runtimeInconsistency={runtimeInconsistency}
      />
      <dl className="settings-deployment-record-facts">
        <RecordFact
          label="Record kind"
          value={
            record.state === "complete"
              ? "Complete pre-dispatch record"
              : "Legacy observed record"
          }
        />
        <RecordFact label="Deployment" value={recordDeploymentId} copy />
        <RecordFact
          label="Target canister"
          value={inspection.targetCanister}
          copy
        />
        <RecordFact
          label="Recorded raw compiler Wasm SHA-256"
          value={
            record.state === "complete"
              ? record.wasm.raw.sha256
              : "Legacy / unavailable"
          }
          copy={record.state === "complete"}
        />
        <RecordFact
          label={
            record.state === "complete"
              ? "Recorded install transport SHA-256"
              : "Recorded installed module SHA-256"
          }
          value={expectedHash}
          copy
        />
        <RecordFact
          label="Build-record identity (domain-separated SHA-256)"
          value={inspection.recordSha256}
          copy
        />
        <RecordFact
          label="Recorded packages"
          value={String(record.packages.length)}
        />
      </dl>
      <div className="settings-deployment-record-actions">
        <span>
          <code title={inspection.recordPath}>{inspection.recordPath}</code>
          <CopyButton
            label="Copy deployment build record path"
            value={inspection.recordPath}
          />
        </span>
        <CopyButton
          className="settings-deployment-record-copy-json"
          label="Copy canonical deployment build record JSON"
          maximumBytes={DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES}
          value={inspection.canonicalJson}
        />
        <DeploymentRecordDownload canonicalJson={inspection.canonicalJson} />
      </div>
    </DeploymentRecordShell>
  );
}

function DeploymentRecordShell({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <section
      aria-label="Deployment build record"
      className={`settings-deployment-record ${className}`}
      data-tid="settings-deployment-build-record"
    >
      <header>
        <h3>Deployment build record</h3>
        <small>
          One whole-canister record for the Kernel and all installed apps
        </small>
      </header>
      {children}
    </section>
  );
}

function StatusMessageForComparison({
  comparison,
  comparisonUnavailableMessage,
  legacyObserved,
  refreshRace,
  runtimeInconsistency,
}: {
  comparison: InstalledModuleHashComparison | null;
  comparisonUnavailableMessage: string | null;
  legacyObserved: boolean;
  refreshRace: Readonly<{
    beforeDeploymentId: string;
    afterDeploymentId: string;
  }> | null;
  runtimeInconsistency: string | null;
}) {
  if (refreshRace) {
    return (
      <StatusMessage
        label="Deployment changed during inspection"
        message={`The runtime changed from ${refreshRace.beforeDeploymentId} to ${refreshRace.afterDeploymentId}. Refresh again; no hash comparison is claimed.`}
        status="refresh-raced"
      />
    );
  }
  if (runtimeInconsistency !== null) {
    return (
      <StatusMessage
        label="Record and runtime are inconsistent"
        message={`${runtimeInconsistency}. No hash match is claimed.`}
        status="invalid"
      />
    );
  }
  if (comparisonUnavailableMessage !== null) {
    return (
      <StatusMessage
        label="Hash comparison unavailable"
        message={`${comparisonUnavailableMessage} The recorded expected value remains available below.`}
        status="unavailable"
      />
    );
  }
  if (comparison === null) {
    return (
      <StatusMessage
        label="Comparison pending"
        message="The runtime deployment identity and certified live module hash are both required."
        status="pending"
      />
    );
  }
  if (comparison.status === "deployment_mismatch") {
    return (
      <StatusMessage
        label="Stale build record"
        message={`The record describes deployment ${comparison.expected_deployment_id}, while the running deployment is ${comparison.runtime_deployment_id}. No hash match is claimed.`}
        status="stale"
      />
    );
  }
  if (comparison.status === "mismatch") {
    return (
      <StatusMessage
        label="Module hash mismatch"
        message={`Certified live hash ${comparison.actual_sha256} does not match recorded hash ${comparison.expected_sha256}.`}
        status="mismatch"
      />
    );
  }
  if (comparison.status === "match") {
    return (
      <StatusMessage
        label={legacyObserved ? "Observed hash match" : "Verified hash match"}
        message={
          legacyObserved
            ? "The certified live whole-canister module hash matches the legacy observation. This is not a complete pre-dispatch build record."
            : "The certified live whole-canister module hash matches the deterministic install transport recorded before dispatch."
        }
        status="match"
      />
    );
  }
  return (
    <StatusMessage
      label="Build record unavailable"
      message="No recorded expected hash is available, so no hash match is claimed."
      status="legacy"
    />
  );
}

function StatusMessage({
  label,
  message,
  status,
}: {
  label: string;
  message: string;
  status:
    | "invalid"
    | "legacy"
    | "match"
    | "mismatch"
    | "pending"
    | "refresh-raced"
    | "stale"
    | "unavailable";
}) {
  const alert =
    status === "invalid" ||
    status === "mismatch" ||
    status === "refresh-raced" ||
    status === "stale" ||
    status === "unavailable";
  return (
    <p
      className={`settings-deployment-record-status is-${status}`}
      data-status={status}
      role={alert ? "alert" : "status"}
    >
      <strong>{label}</strong>
      <span>{message}</span>
    </p>
  );
}

function RecordPath({ path }: { path: string }) {
  return (
    <div className="settings-deployment-record-path">
      <code title={path}>{path}</code>
      <CopyButton label="Copy deployment build record path" value={path} />
    </div>
  );
}

function RecordFact({
  copy = false,
  label,
  value,
}: {
  copy?: boolean;
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>
        <code>{value}</code>
        {copy ? <CopyButton label={`Copy ${label}`} value={value} /> : null}
      </dd>
    </div>
  );
}

function DeploymentRecordDownload({ canonicalJson }: { canonicalJson: string }) {
  const [error, setError] = useState<string | null>(null);
  const download = () => {
    try {
      downloadDeploymentBuildRecordJson(canonicalJson);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <>
      <button
        aria-label="Download canonical deployment build record JSON"
        className="icon-button settings-deployment-record-download"
        onClick={download}
        title="Download canonical deployment build record JSON"
        type="button"
      >
        <IoDownloadOutline aria-hidden="true" />
      </button>
      {error ? <span role="alert">Download failed. {error}</span> : null}
    </>
  );
}
