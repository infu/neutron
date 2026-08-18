import { useRef, useState } from "react";
import {
  isNeutronPackageArchiveOnlyPath,
  type NeutronPackageRecordV1,
} from "neutron-tools/package_record.js";
import { CopyButton } from "./CopyButton.tsx";
import {
  downloadAndVerifyHttpsSourceOffer,
  downloadAndVerifyInstalledPackageFile,
  type InstalledPackageEmbeddedFileClaim,
  type InstalledPackageRecordInspection,
} from "./installed_package_record.ts";

export function InstalledPackageLegalDetails({
  appId,
  inspection,
  provenancePackageSha256,
  uiMode,
}: {
  appId: string;
  inspection: InstalledPackageRecordInspection;
  provenancePackageSha256?: string;
  uiMode: "normal" | "developer";
}) {
  if (inspection.status === "loading") {
    return (
      <section
        aria-label="License and source"
        className="settings-app-legal"
        data-tid={`settings-app-legal-${appId}`}
      >
        <h4>License and source</h4>
        <p role="status">Inspecting the installed package record…</p>
      </section>
    );
  }

  if (inspection.status === "legacy") {
    return (
      <section
        aria-label="License and source"
        className="settings-app-legal settings-app-legal--legacy"
        data-tid={`settings-app-legal-${appId}`}
      >
        <h4>License and source</h4>
        <p>
          <strong>Legacy / not declared by package</strong>
          <span>
            This installed package has no package information record. Neutron
            does not infer a license or source offer.
          </span>
        </p>
        {uiMode === "developer" ? (
          <LegalFact label="Expected record" value={inspection.recordPath} />
        ) : null}
      </section>
    );
  }

  if (inspection.status === "invalid") {
    return (
      <section
        aria-label="License and source"
        className="settings-app-legal settings-app-legal--error"
        data-tid={`settings-app-legal-${appId}`}
        role="alert"
      >
        <h4>License and source</h4>
        <p>
          <strong>Installed package record is invalid</strong>
          <span>{inspection.message}</span>
        </p>
        {uiMode === "developer" ? (
          <LegalFact label="Record" value={inspection.recordPath} />
        ) : null}
      </section>
    );
  }

  if (inspection.status === "unavailable") {
    return (
      <section
        aria-label="License and source"
        className="settings-app-legal settings-app-legal--error"
        data-tid={`settings-app-legal-${appId}`}
        role="alert"
      >
        <h4>License and source</h4>
        <p>
          <strong>Installed package record is unavailable</strong>
          <span>{inspection.message}</span>
        </p>
        {uiMode === "developer" ? (
          <LegalFact label="Record" value={inspection.recordPath} />
        ) : null}
      </section>
    );
  }

  const { assetBasePath, record, recordPath, recordSha256 } = inspection;
  const governingText =
    record.license.texts.find(({ id }) => id === record.license.id) ??
    record.license.texts[0];

  return (
    <section
      aria-label="License and source"
      className="settings-app-legal settings-app-legal--declared"
      data-tid={`settings-app-legal-${appId}`}
    >
      <h4>License and source</h4>
      <div className="settings-app-legal-summary">
        <div>
          <span>License</span>
          <strong>{record.license.id}</strong>
          {governingText ? (
            <EmbeddedAssetPath
              assetBasePath={assetBasePath}
              download={uiMode === "normal"}
              file={governingText}
              label="license text"
            />
          ) : null}
        </div>
        <SourceSummary
          showAction={uiMode === "normal"}
          source={record.source}
        />
      </div>

      {uiMode === "developer" ? (
        <details className="settings-app-legal-developer">
          <summary>License, source, and package-record details</summary>
          <div className="settings-app-legal-developer-content">
            <RecordVerificationSummary record={record} />
            <dl className="settings-app-legal-facts">
              <LegalFact label="Package record" value={recordPath} />
              <LegalDigestFact
                label="Package record SHA-256"
                value={recordSha256}
              />
              {provenancePackageSha256 ? (
                <LegalDigestFact
                  label="Installed package archive SHA-256"
                  value={provenancePackageSha256}
                />
              ) : (
                <LegalFact
                  label="Installed package archive SHA-256"
                  value="Legacy / unavailable"
                />
              )}
              <LegalFact
                label="Recorded package"
                value={`${record.package.id} v${record.package.version}`}
              />
            </dl>

            <LegalFiles assetBasePath={assetBasePath} record={record} />
            <SourceDeveloperDetails source={record.source} />
          </div>
        </details>
      ) : null}
    </section>
  );
}

function RecordVerificationSummary({
  record,
}: {
  record: NeutronPackageRecordV1;
}) {
  const hasArchiveOnlyMaterial = [
    ...record.license.texts.map(({ path }) => path),
    ...record.notices.map(({ path }) => path),
    ...(record.source.kind === "embedded" ? [record.source.path] : []),
  ].some(isNeutronPackageArchiveOnlyPath);
  if (hasArchiveOnlyMaterial) {
    return (
      <p>
        The record and neutron.json binding were checked. Referenced
        archive-only license, third-party notice, and source bytes were verified
        from the original package before installation. They are not duplicated
        into public canister assets. Any legal file outside the archive-only
        paths remains installed.
      </p>
    );
  }
  return (
    <p>
      The record and neutron.json binding were checked. Referenced license and
      notice files remain installed and can be downloaded with digest
      verification.
      {record.source.kind === "https"
        ? " The source archive is fetched only when you choose Download source code."
        : " No source bytes are fetched during inspection."}
    </p>
  );
}

function SourceSummary({
  showAction,
  source,
}: {
  showAction: boolean;
  source: NeutronPackageRecordV1["source"];
}) {
  if (source.kind === "embedded") {
    return (
      <div>
        <span>Source</span>
        <strong>Included in original package</strong>
        <small>
          Package-only source snapshot; not installed as a public asset.
        </small>
      </div>
    );
  }
  if (source.kind === "https") {
    return (
      <div>
        <span>Source code</span>
        <strong>Available from the package publisher</strong>
        <small>Verified by size and SHA-256 before download.</small>
        {showAction ? <VerifiedHttpsSourceDownload source={source} /> : null}
      </div>
    );
  }
  return (
    <div>
      <span>Source</span>
      <strong>{sourceStatusLabel(source.status)}</strong>
      <small>Package-declared status</small>
    </div>
  );
}

function LegalFiles({
  assetBasePath,
  record,
}: {
  assetBasePath: string;
  record: NeutronPackageRecordV1;
}) {
  return (
    <div className="settings-app-legal-files">
      <h5>Package-declared license texts</h5>
      {record.license.texts.map((text) => (
        <div key={`${text.id}:${text.path}`}>
          <span>
            <strong>{text.id}</strong>
            <code>{text.path}</code>
          </span>
          <span>
            <code>{text.sha256}</code>
            <small>{text.bytes} bytes</small>
            <EmbeddedAssetPath
              assetBasePath={assetBasePath}
              file={text}
              label={`${text.id} license text`}
            />
          </span>
        </div>
      ))}
      {record.notices.length > 0 ? (
        <>
          <h5>Package-declared notices</h5>
          {record.notices.map((notice, index) => (
            <div key={notice.path}>
              <span>
                <strong>Notice {index + 1}</strong>
                <code>{notice.path}</code>
              </span>
              <span>
                <code>{notice.sha256}</code>
                <small>{notice.bytes} bytes</small>
                <EmbeddedAssetPath
                  assetBasePath={assetBasePath}
                  file={notice}
                  label={`notice ${index + 1}`}
                />
              </span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

function sourceStatusLabel(
  status: "not-provided" | "not-required" | "unknown",
): string {
  if (status === "not-required") return "Not required";
  if (status === "unknown") return "Unknown";
  return "Not provided";
}

function SourceDeveloperDetails({
  source,
}: {
  source: NeutronPackageRecordV1["source"];
}) {
  if (source.kind === "status") {
    return (
      <dl className="settings-app-legal-facts">
        <LegalFact label="Source status" value={source.status} />
      </dl>
    );
  }
  if (source.kind === "embedded") {
    return (
      <dl className="settings-app-legal-facts">
        <LegalFact label="Source kind" value={source.kind} />
        <LegalFact label="Source revision" value={source.revision} />
        <LegalFact label="Package archive path" value={source.path} />
        <LegalDigestFact label="Source SHA-256" value={source.sha256} />
        <LegalFact label="Source bytes" value={String(source.bytes)} />
        <LegalFact
          label="Installed availability"
          value="Package-only; not installed as a static asset"
        />
      </dl>
    );
  }
  return (
    <dl className="settings-app-legal-facts">
      <LegalFact label="Source kind" value={source.kind} />
      <LegalFact label="Source revision" value={source.revision} />
      <LegalFact label="Source URL" value={source.url} />
      <LegalDigestFact label="Source SHA-256" value={source.sha256} />
      <LegalFact label="Source bytes" value={String(source.bytes)} />
      <div className="settings-app-legal-action">
        <a href={source.url} rel="noopener noreferrer" target="_blank">
          Open source URL without verification
        </a>
      </div>
    </dl>
  );
}

function EmbeddedAssetPath({
  assetBasePath,
  download = true,
  file,
  label,
}: {
  assetBasePath: string;
  download?: boolean;
  file: InstalledPackageEmbeddedFileClaim;
  label: string;
}) {
  if (isNeutronPackageArchiveOnlyPath(file.path)) {
    return (
      <span className="settings-app-legal-path">
        <code title={file.path}>{file.path}</code>
        <small>
          Retained in original package; not installed as a public asset.
        </small>
      </span>
    );
  }
  const installedPath = `${assetBasePath}${file.path}`;
  return (
    <span className="settings-app-legal-path">
      <code title={installedPath}>{installedPath}</code>
      <CopyButton label={`Copy ${label} path`} value={installedPath} />
      {download ? (
        <VerifiedEmbeddedDownload
          assetBasePath={assetBasePath}
          file={file}
          key={`${assetBasePath}${file.path}:${file.sha256}:${file.bytes}`}
          label={label}
        />
      ) : null}
    </span>
  );
}

export type EmbeddedDownloadState =
  | Readonly<{ status: "idle" | "working" | "success" }>
  | Readonly<{ status: "error"; message: string }>;

function VerifiedHttpsSourceDownload({
  source,
}: {
  source: Extract<NeutronPackageRecordV1["source"], { kind: "https" }>;
}) {
  const [state, setState] = useState<EmbeddedDownloadState>({ status: "idle" });
  const active = useRef(false);
  const working = state.status === "working";

  const download = async () => {
    if (active.current) return;
    active.current = true;
    setState({ status: "working" });
    try {
      await downloadAndVerifyHttpsSourceOffer({ source });
      setState({ status: "success" });
    } catch (error) {
      setState({ status: "error", message: downloadErrorMessage(error) });
    } finally {
      active.current = false;
    }
  };

  return (
    <span className="settings-app-legal-download">
      <button
        aria-label="Download and verify source code"
        disabled={working}
        onClick={() => void download()}
        type="button"
      >
        {working ? "Verifying…" : "Download source code"}
      </button>
      <InstalledPackageDownloadFeedback state={state} />
    </span>
  );
}

function VerifiedEmbeddedDownload({
  assetBasePath,
  file,
  label,
}: {
  assetBasePath: string;
  file: InstalledPackageEmbeddedFileClaim;
  label: string;
}) {
  const [state, setState] = useState<EmbeddedDownloadState>({ status: "idle" });
  const active = useRef(false);
  const working = state.status === "working";

  const download = async () => {
    if (active.current) return;
    active.current = true;
    setState({ status: "working" });
    try {
      await downloadAndVerifyInstalledPackageFile({ assetBasePath, file });
      setState({ status: "success" });
    } catch (error) {
      setState({ status: "error", message: downloadErrorMessage(error) });
    } finally {
      active.current = false;
    }
  };

  return (
    <span className="settings-app-legal-download">
      <button
        aria-label={`Download and verify ${label}`}
        disabled={working}
        onClick={() => void download()}
        type="button"
      >
        {working ? "Verifying…" : "Download and verify"}
      </button>
      <InstalledPackageDownloadFeedback state={state} />
    </span>
  );
}

export function InstalledPackageDownloadFeedback({
  state,
}: {
  state: EmbeddedDownloadState;
}) {
  if (state.status === "error") {
    return (
      <small className="settings-app-legal-download-error" role="alert">
        Download failed. {state.message}
      </small>
    );
  }
  if (state.status === "success") {
    return <small role="status">Digest verified; download started.</small>;
  }
  return null;
}

function downloadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  return Array.from(normalized).slice(0, 500).join("") || "Unknown error";
}

function LegalFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-app-legal-fact">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function LegalDigestFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-app-legal-fact settings-app-legal-fact--digest">
      <dt>{label}</dt>
      <dd>
        <code title={value}>{value}</code>
        <CopyButton label={`Copy ${label}`} value={value} />
      </dd>
    </div>
  );
}
