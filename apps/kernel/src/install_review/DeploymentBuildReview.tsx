import { useMemo, useState, type ReactNode } from "react";
import type { NeutronPackageRecordV1 } from "neutron-tools/package_record.js";
import {
  buildDeploymentReviewArtifact,
  createDeploymentBuildReviewModel,
  deploymentDiagnosticLocation,
  deploymentMemoryChangeLabel,
  downloadDeploymentReviewArtifact,
  type DeploymentBuildReviewInput,
  type DeploymentBuildReviewPackage,
} from "./deployment_build_review.ts";
import { ConsentNotice, useConsentUiMode } from "../consent/ConsentPresentation.tsx";
import type { KernelUiMode } from "../ui_mode.ts";

export type DeploymentBuildReviewProps = DeploymentBuildReviewInput &
  Readonly<{ uiMode?: KernelUiMode }>;

/**
 * Read-only pre-dispatch evidence. Rendering performs no network requests and
 * exposes no install, approval, acceptance, or clickwrap control.
 */
export function DeploymentBuildReview({
  uiMode: uiModeOverride,
  ...input
}: DeploymentBuildReviewProps) {
  const uiMode = useConsentUiMode(uiModeOverride);
  const model = useMemo(
    () => createDeploymentBuildReviewModel(input),
    [input.record, input.retainedPackageRecords, input.suppliedPackages],
  );
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const download = (
    kind: "build_record" | "package_archive",
    appId?: string,
  ) => {
    try {
      const artifact = buildDeploymentReviewArtifact(
        input,
        kind === "build_record"
          ? { kind: "build_record" }
          : { kind: "package_archive", appId: appId ?? "" },
      );
      downloadDeploymentReviewArtifact(artifact);
      setDownloadError(null);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error));
    }
  };

  if (uiMode === "normal") {
    return <CompactBuildReview model={model} />;
  }

  return (
    <section
      aria-label="Deployment build review"
      className="deployment-build-review"
      data-tid="deployment-build-review"
    >
      <header>
        <h2>Deployment ready</h2>
        <p role="status">
          <strong>Package checks and compilation completed</strong>
          <span>
            {model.packages.length}{" "}
            {model.packages.length === 1 ? "package is" : "packages are"} ready
            for one state-preserving installation.
          </span>
        </p>
      </header>

      <MaterialWarningSummary warnings={model.warnings} />

      {uiMode === "developer" ? (
        <div
          className="deployment-build-review-developer"
          data-tid="deployment-build-review-developer"
        >
          <details>
            <summary>Build and installation details</summary>
            <section aria-labelledby="deployment-review-build-identity">
              <h3 id="deployment-review-build-identity">Build identity</h3>
              <FactList>
                <Fact label="Record state" value={model.record.state} />
                <Fact
                  label="Record format"
                  value={String(model.record.format)}
                />
                <Fact
                  label="Deployment"
                  value={model.record.deploymentId}
                  code
                />
                <Fact
                  label="Previous deployment"
                  value={
                    model.previous.deployment_id ??
                    "None (clean initialization)"
                  }
                  code={model.previous.deployment_id !== null}
                />
                <Fact label="Compiler" value={model.build.compiler_id} code />
                <Fact label="Assembler" value={model.build.assembler_id} code />
                <Fact label="Environment" value={model.build.environment} />
                <Fact
                  label="Deployment nonce"
                  value={model.build.deployment_nonce ?? "Not recorded"}
                  code={model.build.deployment_nonce !== null}
                />
                <Fact
                  label="Canonical record SHA-256"
                  value={model.record.canonicalJsonSha256}
                  code
                />
                <Fact
                  label="Build-record identity (domain-separated SHA-256)"
                  value={model.record.domainSeparatedSha256}
                  code
                />
                <Fact
                  label="Canonical record bytes"
                  value={formatBytes(model.record.canonicalJsonBytes)}
                />
              </FactList>
              <button
                className="btn btn-sec"
                data-tid="deployment-build-review-download-record"
                onClick={() => download("build_record")}
                type="button"
              >
                Download exact build-record JSON
              </button>
              {downloadError ? (
                <p role="alert">Download failed. {downloadError}</p>
              ) : null}
            </section>
            <section aria-labelledby="deployment-review-installation">
              <h3 id="deployment-review-installation">Installation</h3>
              <FactList>
                <Fact
                  label="Target canister"
                  value={model.installation.target_canister}
                  code
                />
                <Fact label="Mode" value={model.installation.mode} />
                <Fact
                  label="Install argument SHA-256"
                  value={model.installation.argument.sha256}
                  code
                />
                <Fact
                  label="Install argument bytes"
                  value={formatBytes(model.installation.argument.bytes)}
                />
                <Fact
                  label="Wasm memory persistence"
                  value={model.installation.wasm_memory_persistence}
                />
              </FactList>
              {model.installation.mode === "reinstall" ||
              model.installation.wasm_memory_persistence === "replace" ? (
                <p role="alert">
                  This installation uses {model.installation.mode} mode with
                  Wasm memory persistence set to{" "}
                  {model.installation.wasm_memory_persistence}.
                </p>
              ) : null}
            </section>
          </details>

          <details>
            <summary>Deployment Wasm and modules</summary>
            <section
              aria-labelledby="deployment-review-wasm"
              data-tid="deployment-build-review-wasm"
            >
              <h3 id="deployment-review-wasm">Deployment Wasm</h3>
              <p>
                These are deployment-level identities. They are not separate
                Wasm modules for each package.
              </p>
              <div data-tid="deployment-build-review-wasm-raw">
                <h4>Raw compiler Wasm</h4>
                <FactList>
                  <Fact label="SHA-256" value={model.wasm.raw.sha256} code />
                  <Fact
                    label="Bytes"
                    value={formatBytes(model.wasm.raw.bytes)}
                  />
                  <Fact
                    label="Representation"
                    value={model.wasm.raw.representation}
                    code
                  />
                  <Fact
                    label="Content encoding"
                    value={model.wasm.raw.content_encoding}
                    code
                  />
                </FactList>
              </div>
              <div data-tid="deployment-build-review-wasm-transport">
                <h4>Transport Wasm</h4>
                <FactList>
                  <Fact
                    label="SHA-256"
                    value={model.wasm.transport.sha256}
                    code
                  />
                  <Fact
                    label="Bytes"
                    value={formatBytes(model.wasm.transport.bytes)}
                  />
                  <Fact
                    label="Representation"
                    value={model.wasm.transport.representation}
                    code
                  />
                  <Fact
                    label="Content encoding"
                    value={model.wasm.transport.content_encoding}
                    code
                  />
                  <Fact
                    label="Encoder"
                    value={model.wasm.transport.encoder}
                    code
                  />
                </FactList>
              </div>
            </section>
            <section>
              <h3>
                Reachable modules ({model.build.reachable_module_sha256.length})
              </h3>
              {model.build.reachable_module_sha256.length === 0 ? (
                <p>None recorded.</p>
              ) : (
                <DigestList values={model.build.reachable_module_sha256} />
              )}
            </section>
          </details>

          <details>
            <summary>Packages, licenses, and source</summary>
            <section aria-labelledby="deployment-review-packages">
              <h3 id="deployment-review-packages">Packages</h3>
              <p>
                {model.packages.length} target packages feed the one deployment
                Wasm.
              </p>
              {model.packages.map((pkg) => (
                <PackageReview
                  download={() => download("package_archive", pkg.appId)}
                  key={pkg.appId}
                  pkg={pkg}
                />
              ))}
            </section>
          </details>

          <InventoryReview previous={model.previous} target={model.target} />

          <details>
            <summary>Diagnostics and exact state changes</summary>
            <WarningDetails warnings={model.warnings} />
          </details>
        </div>
      ) : null}
    </section>
  );
}

function CompactBuildReview({
  model,
}: {
  model: ReturnType<typeof createDeploymentBuildReviewModel>;
}) {
  const { warnings } = model;
  const appNames = (ids: readonly string[]) => [...new Set(ids)].map(
    (id) => model.packages.find((pkg) => pkg.appId === id)?.displayName ?? id,
  ).join(", ");
  const migrations = warnings.memory_changes.filter((change) => change.kind === "migrate");
  const deletedRoots = warnings.destructive_memory_roots.filter((root) =>
    !migrations.some((change) => change.owner === root.owner &&
      change.path.some((edge) => edge.consume.includes(root.memory_id))),
  );
  const diagnostics = [...warnings.diagnostics, ...warnings.compatibility_diagnostics];
  // Classical Motoko upgrades use Wasm "replace" while preserving stable data.
  const replacesData = model.installation.mode === "reinstall";

  return (
    <section
      aria-label="Installation checks"
      className="deployment-build-review deployment-build-review--compact"
      data-tid="deployment-build-review"
    >
      <p role="status">Ready to continue.</p>
      {replacesData ? (
        <ConsentNotice tone="danger">
          <strong>This installation replaces existing storage.</strong>{" "}
          Saved data may be lost.
        </ConsentNotice>
      ) : null}
      {warnings.removed_apps.length > 0 ? (
        <ConsentNotice tone="danger">
          <strong>Removes {appNames(warnings.removed_apps)}.</strong>
        </ConsentNotice>
      ) : null}
      {deletedRoots.length > 0 ? (
        <ConsentNotice tone="danger">
          <strong>Permanently deletes saved data from {appNames(deletedRoots.map(({ owner }) => owner))}.</strong>
        </ConsentNotice>
      ) : null}
      {migrations.length > 0 ? (
        <p>Updates the saved-data format for {appNames(migrations.map(({ owner }) => owner))}.</p>
      ) : null}
      {diagnostics.length > 0 ? (
        <details className="consent-technical-details">
          <summary>{diagnostics.length} build {diagnostics.length === 1 ? "warning" : "warnings"} to review</summary>
          <DiagnosticReview diagnostics={diagnostics} heading="Build warnings" />
        </details>
      ) : null}
    </section>
  );
}

function MaterialWarningSummary({
  warnings,
}: {
  warnings: ReturnType<typeof createDeploymentBuildReviewModel>["warnings"];
}) {
  if (!warnings.hasMaterialWarnings) {
    return <p role="status">No data-loss or compatibility warnings.</p>;
  }
  return (
    <p role="alert">
      <strong>{warnings.materialCount} review items need attention</strong>
      <span>
        {warnings.memory_changes.length} memory changes,{" "}
        {warnings.removed_apps.length} app removals,{" "}
        {warnings.destructive_memory_roots.length} destructive memory roots, and{" "}
        {warnings.diagnostics.length +
          warnings.compatibility_diagnostics.length}{" "}
        diagnostics.
      </span>
    </p>
  );
}

function WarningDetails({
  warnings,
}: {
  warnings: ReturnType<typeof createDeploymentBuildReviewModel>["warnings"];
}) {
  return (
    <section aria-labelledby="deployment-review-warnings">
      <h3 id="deployment-review-warnings">Warnings and state changes</h3>
      <DiagnosticReview
        diagnostics={warnings.diagnostics}
        heading="Compiler diagnostics"
      />
      <DiagnosticReview
        diagnostics={warnings.compatibility_diagnostics}
        heading="Compatibility diagnostics"
      />
      <h4>Managed-memory changes</h4>
      {warnings.memory_changes.length === 0 ? (
        <p>None recorded.</p>
      ) : (
        <ul>
          {warnings.memory_changes.map((change, index) => (
            <li
              key={`${change.owner}:${change.memory_id}:${change.kind}:${index}`}
            >
              <strong>{deploymentMemoryChangeLabel(change)}</strong>
              {change.kind === "migrate" ? (
                <ul>
                  <li>
                    Previous schema entry SHA-256:{" "}
                    <code>{change.old_schema_entry_sha256}</code>
                  </li>
                  {change.path.map((edge, edgeIndex) => (
                    <li key={`${edge.from}:${edge.to}:${edgeIndex}`}>
                      v{edge.from} to v{edge.to}: entry{" "}
                      <code>{edge.entry_sha256}</code>
                      {edge.consume.length > 0
                        ? `; consumes ${edge.consume.join(", ")}`
                        : "; consumes no additional roots"}
                    </li>
                  ))}
                </ul>
              ) : change.kind === "retire" ? (
                <span>
                  {" "}
                  Previous schema entry SHA-256:{" "}
                  <code>{change.old_schema_entry_sha256}</code>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <StringList heading="Removed apps" values={warnings.removed_apps} />
      <StringList
        heading="Destructive memory roots"
        values={warnings.destructive_memory_roots.map(
          ({ owner, memory_id }) => `${owner}/${memory_id}`,
        )}
      />
    </section>
  );
}

function PackageReview({
  download,
  pkg,
}: {
  download: () => void;
  pkg: DeploymentBuildReviewPackage;
}) {
  return (
    <article
      aria-labelledby={`deployment-review-package-title-${pkg.appId}`}
      data-tid={`deployment-build-review-package-${pkg.appId}`}
    >
      <h4 id={`deployment-review-package-title-${pkg.appId}`}>
        {pkg.displayName} ({pkg.appId}) {pkg.versionLabel}
      </h4>
      <p>
        {pkg.input === "newly_supplied"
          ? "Newly supplied package"
          : "Retained target package"}
      </p>
      <DistributionReview distribution={pkg.distribution} />
      <ArchiveReview archive={pkg.archive} />
      {pkg.archive.downloadFilename ? (
        <button
          className="btn btn-sec"
          data-tid={`deployment-build-review-download-archive-${pkg.appId}`}
          onClick={download}
          type="button"
        >
          Download exact {pkg.appId} archive
        </button>
      ) : null}
      <PackageInformationReview information={pkg.packageInformation} />
      <h5>Resolved dependencies</h5>
      {pkg.dependencies.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {pkg.dependencies.map((dependency) => (
            <li key={dependency.alias}>
              <code>{dependency.alias}</code> →{" "}
              <code>{dependency.provider_app_id}</code>; minimum v
              {formatPackedVersion(dependency.minimum_version)}, resolved v
              {formatPackedVersion(dependency.provider_version)}; functions:{" "}
              {dependency.functions.length > 0
                ? dependency.functions.join(", ")
                : "none"}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function DistributionReview({
  distribution,
}: {
  distribution: DeploymentBuildReviewPackage["distribution"];
}) {
  if (distribution.state === "declared_update_source") {
    return (
      <p>
        Declared update source: <code>{distribution.updateSource}</code>
      </p>
    );
  }
  if (distribution.state === "manual_unofficial") {
    return (
      <p>
        <strong>Unofficial / manually supplied</strong>
        <span>No update source is declared by this package.</span>
      </p>
    );
  }
  return (
    <p>Retained package; acquisition source is not part of this review.</p>
  );
}

function ArchiveReview({
  archive,
}: {
  archive: DeploymentBuildReviewPackage["archive"];
}) {
  const status =
    archive.reconciliation === "exact_match"
      ? "Exact supplied archive identity verified"
      : archive.reconciliation === "digest_match"
        ? "Supplied archive digest matched; record has no byte count"
        : archive.reconciliation === "supplied_but_record_unavailable"
          ? "Exact supplied bytes retained; legacy record has no archive identity"
          : archive.reconciliation === "not_retained"
            ? "Archive bytes are not retained for download"
            : "Record-only archive evidence; bytes are not supplied to this review";
  return (
    <div>
      <h5>Package archive</h5>
      <p>
        <strong>{status}</strong>
      </p>
      <FactList>
        <Fact label="Record state" value={archive.recordState} />
        {archive.recordSha256 ? (
          <Fact label="Recorded SHA-256" value={archive.recordSha256} code />
        ) : null}
        {archive.recordedBytes !== null ? (
          <Fact
            label="Recorded bytes"
            value={formatBytes(archive.recordedBytes)}
          />
        ) : null}
        {archive.suppliedIdentity ? (
          <>
            <Fact
              label="Supplied SHA-256"
              value={archive.suppliedIdentity.sha256}
              code
            />
            <Fact
              label="Supplied bytes"
              value={formatBytes(archive.suppliedIdentity.bytes)}
            />
          </>
        ) : null}
      </FactList>
    </div>
  );
}

function PackageInformationReview({
  information,
}: {
  information: DeploymentBuildReviewPackage["packageInformation"];
}) {
  if (information.state === "not_supplied") {
    return (
      <div>
        <h5>Package Information Record</h5>
        <p>
          <strong>Not supplied</strong>
          <span>
            Package did not supply a record; license and source are unknown.
          </span>
        </p>
      </div>
    );
  }
  if (information.state === "legacy_unavailable") {
    return (
      <div>
        <h5>Package Information Record</h5>
        <p>
          <strong>Legacy / unavailable</strong>
          <span>No license or source facts are inferred.</span>
        </p>
      </div>
    );
  }
  if (!information.details) {
    return (
      <div>
        <h5>Package Information Record</h5>
        <p>
          <strong>Verified identity recorded</strong>
          <span>
            SHA-256 <code>{information.sha256}</code>; retained record details
            were not supplied to this review.
          </span>
        </p>
      </div>
    );
  }
  const { origin, record } = information.details;
  return (
    <div>
      <h5>Package Information Record</h5>
      <p>
        <strong>Verified</strong>
        <span>
          {origin === "supplied_verified"
            ? "Exact newly supplied record and referenced package bytes were verified."
            : "Exact retained record identity was verified against the build record."}
        </span>
      </p>
      <FactList>
        <Fact
          label="SHA-256"
          value={information.sha256 ?? "Unavailable"}
          code
        />
        <Fact label="License" value={record.license.id} />
      </FactList>
      <LicenseReview record={record} />
      <SourceReview
        source={record.source}
        verifiedInSuppliedArchive={origin === "supplied_verified"}
      />
      <DeclaredPackageDetails record={record} />
    </div>
  );
}

function LicenseReview({ record }: { record: NeutronPackageRecordV1 }) {
  return (
    <div>
      <h6>Verified license declarations</h6>
      <ul>
        {record.license.texts.map((text, index) => (
          <li key={`${text.id}:${text.path}:${index}`}>
            <strong>
              {text.id}
              {text.id === record.license.id ? " (governing)" : " (companion)"}
            </strong>{" "}
            <code>{text.path}</code> · <code>{text.sha256}</code> ·{" "}
            {formatBytes(text.bytes)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceReview({
  source,
  verifiedInSuppliedArchive,
}: {
  source: NeutronPackageRecordV1["source"];
  verifiedInSuppliedArchive: boolean;
}) {
  if (source.kind === "status") {
    return (
      <div>
        <h6>Source</h6>
        <p>
          Explicit package-declared status: <code>{source.status}</code>. This
          is a status claim, not a source offer.
        </p>
      </div>
    );
  }
  return (
    <div>
      <h6>Source</h6>
      <p>
        <strong>
          {source.kind === "embedded"
            ? "Embedded source offer"
            : "HTTPS source offer"}
        </strong>
        <span>
          {source.kind === "embedded" && verifiedInSuppliedArchive
            ? "Embedded bytes were verified inside the supplied package."
            : "This review does not fetch or open the offered source."}
        </span>
      </p>
      <FactList>
        <Fact label="Revision" value={source.revision} code />
        <Fact
          label={source.kind === "embedded" ? "Path" : "URL"}
          value={source.kind === "embedded" ? source.path : source.url}
          code
        />
        <Fact label="SHA-256" value={source.sha256} code />
        <Fact label="Bytes" value={formatBytes(source.bytes)} />
      </FactList>
    </div>
  );
}

function DeclaredPackageDetails({
  record,
}: {
  record: NeutronPackageRecordV1;
}) {
  return (
    <details>
      <summary>Package-record details</summary>
      <h6>Bound package manifest</h6>
      <p>
        <code>{record.package.manifest.path}</code> ·{" "}
        <code>{record.package.manifest.sha256}</code> ·{" "}
        {formatBytes(record.package.manifest.bytes)}
      </p>
      <h6>Package-declared dependencies</h6>
      {record.dependencies.length === 0 ? (
        <p>None declared.</p>
      ) : (
        <ul>
          {record.dependencies.map((dependency) => (
            <li key={dependency.alias}>
              <code>{dependency.alias}</code> → <code>{dependency.app}</code>;
              minimum v{formatPackedVersion(dependency.min_version)}; functions:{" "}
              {dependency.functions.join(", ")}
            </li>
          ))}
        </ul>
      )}
      <StringList
        heading="Notices"
        values={record.notices.map(
          (notice) =>
            `${notice.path} · ${notice.sha256} · ${formatBytes(notice.bytes)}`,
        )}
      />
      <h6>Managed-memory lock</h6>
      {record.memory ? (
        <p>
          <code>{record.memory.lock.path}</code> ·{" "}
          <code>{record.memory.lock.sha256}</code> ·{" "}
          {formatBytes(record.memory.lock.bytes)}
        </p>
      ) : (
        <p>None declared.</p>
      )}
      <StringList
        heading="Important source inputs"
        values={record.build.inputs.map(
          (input) =>
            `${input.path} · ${input.sha256} · ${formatBytes(input.bytes)}`,
        )}
      />
      <h6>Informational build commands (not executed)</h6>
      {record.build.commands.length === 0 ? (
        <p>None declared.</p>
      ) : (
        <ul>
          {record.build.commands.map((command, index) => (
            <li key={`${command.purpose}:${index}`}>
              <strong>{command.purpose}</strong> in <code>{command.cwd}</code>:{" "}
              <code>{JSON.stringify(command.argv)}</code>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function InventoryReview({
  previous,
  target,
}: {
  previous: ReturnType<typeof createDeploymentBuildReviewModel>["previous"];
  target: ReturnType<typeof createDeploymentBuildReviewModel>["target"];
}) {
  return (
    <details>
      <summary>Previous and target inventories</summary>
      <h3>Previous apps</h3>
      <InventoryApps apps={previous.apps} />
      <h3>Target apps</h3>
      <InventoryApps apps={target.apps} />
      <h3>Previous managed memories</h3>
      <InventoryMemories memories={previous.memories} />
      <h3>Target managed memories</h3>
      <InventoryMemories memories={target.memories} />
      <FactList>
        <Fact
          label="Previous stable signature SHA-256"
          value={previous.stable_signature_sha256 ?? "Unavailable"}
          code={previous.stable_signature_sha256 !== null}
        />
      </FactList>
    </details>
  );
}

function InventoryApps({
  apps,
}: {
  apps: ReturnType<typeof createDeploymentBuildReviewModel>["target"]["apps"];
}) {
  return apps.length === 0 ? (
    <p>None.</p>
  ) : (
    <ul>
      {apps.map((app) => (
        <li key={app.app_id}>
          <code>{app.app_id}</code> v{formatPackedVersion(app.version)} ·{" "}
          <code>{app.capability_plan_fingerprint}</code> ·{" "}
          {app.resident_frame_security}
        </li>
      ))}
    </ul>
  );
}

function InventoryMemories({
  memories,
}: {
  memories: ReturnType<
    typeof createDeploymentBuildReviewModel
  >["target"]["memories"];
}) {
  return memories.length === 0 ? (
    <p>None.</p>
  ) : (
    <ul>
      {memories.map((memory) => (
        <li key={`${memory.owner}:${memory.id}`}>
          <code>
            {memory.owner}/{memory.id}
          </code>{" "}
          v{memory.version} · schema <code>{memory.schema}</code>
        </li>
      ))}
    </ul>
  );
}

function DiagnosticReview({
  diagnostics,
  heading,
}: {
  diagnostics: ReturnType<
    typeof createDeploymentBuildReviewModel
  >["warnings"]["diagnostics"];
  heading: string;
}) {
  return (
    <div>
      <h4>{heading}</h4>
      {diagnostics.length === 0 ? (
        <p>None recorded.</p>
      ) : (
        <ul>
          {diagnostics.map((diagnostic, index) => (
            <li
              key={`${diagnostic.source}:${diagnostic.code}:${diagnostic.range.start.line}:${index}`}
            >
              <strong>
                Severity {diagnostic.severity} · {diagnostic.category} ·{" "}
                {diagnostic.code}
              </strong>
              <code>{deploymentDiagnosticLocation(diagnostic)}</code>
              <span>{diagnostic.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FactList({ children }: { children: ReactNode }) {
  return <dl>{children}</dl>;
}

function Fact({
  code = false,
  label,
  value,
}: {
  code?: boolean;
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  );
}

function DigestList({ values }: { values: readonly string[] }) {
  return (
    <ol>
      {values.map((value, index) => (
        <li key={`${value}:${index}`}>
          <code>{value}</code>
        </li>
      ))}
    </ol>
  );
}

function StringList({
  heading,
  values,
}: {
  heading: string;
  values: readonly string[];
}) {
  return (
    <div>
      <h4>{heading}</h4>
      {values.length === 0 ? (
        <p>None recorded.</p>
      ) : (
        <ul>
          {values.map((value, index) => (
            <li key={`${value}:${index}`}>
              <code>{value}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatPackedVersion(version: number): string {
  const major = Math.floor(version / 10_000);
  const remainder = version % 10_000;
  return `${major}.${Math.floor(remainder / 100)}.${remainder % 100}`;
}

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}
