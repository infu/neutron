import { useEffect, useRef, useState } from "react";
import { PermissionDisclosure } from "../AppDialogs.tsx";
import { useAppsStore } from "../reducer/apps.ts";
import { useBackendCallConsentStore } from "../reducer/backend_calls.ts";
import { useConnectionsStore } from "../reducer/connections.ts";
import { useMsgBusPermissionStore } from "../reducer/msg_bus.ts";
import { useRequestStore } from "../reducer/request.ts";
import { useAgentModeStore } from "../ui_attention/agent.ts";
import { useInstallOfferStore } from "../install_offers/store.ts";
import {
  backToRepositorySelection,
  dismissRepositorySetup,
  finishRepositorySetup,
  installRepositorySelection,
  loadRepositorySetup,
  retryRepositorySetup,
  reviewRepositorySelection,
  selectAllRepositoryPackages,
  toggleRepositoryPackage,
} from "./service.ts";
import { useRepositorySetupStore } from "./store.ts";
import { formatAppVersionLabel } from "neutron-tools/src/version.js";
import {
  ConsentNotice,
  ConsentTechnicalDetails,
  focusConsentControl,
  useConsentUiMode,
} from "../consent/ConsentPresentation.tsx";
import { PermissionConsequences } from "../consent/PermissionConsequences.tsx";
import type { KernelUiMode } from "../ui_mode.ts";

export function RepositorySetupDialog() {
  const uiMode = useConsentUiMode();
  const state = useRepositorySetupStore();
  const appModalActive = useAppsStore((current) =>
    Boolean(
      current.operation ||
        current.installError ||
        current.request ||
        current.uninstallRequest ||
        current.pendingInstallRecovery,
    ),
  );
  const callModalActive = useRequestStore(
    (current) => Object.keys(current.calls).length > 0,
  );
  const toolModalActive = useMsgBusPermissionStore(
    (current) => Object.keys(current.requests).length > 0,
  );
  const backendModalActive = useBackendCallConsentStore(
    (current) => Object.keys(current.requests).length > 0,
  );
  const connectionModalActive = useConnectionsStore((current) =>
    Boolean(current.dialog),
  );
  const agentModalActive = useAgentModeStore((current) =>
    Boolean(current.pendingGrant),
  );
  const installOfferActive = useInstallOfferStore((current) =>
    Boolean(current.pending),
  );
  const otherDomModalActive = useOtherDomModalActive();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusFrame = useRef<number | null>(null);
  const attemptActive = state.phase !== "idle" && state.reference !== null;
  const visible =
    attemptActive &&
    state.phase !== "installing" &&
    !appModalActive &&
    !callModalActive &&
    !toolModalActive &&
    !backendModalActive &&
    !connectionModalActive &&
    !agentModalActive &&
    !installOfferActive &&
    !otherDomModalActive;

  useEffect(() => {
    if (!attemptActive) return;
    if (restoreFocusFrame.current !== null) {
      cancelAnimationFrame(restoreFocusFrame.current);
      restoreFocusFrame.current = null;
    }
    const target =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      restoreFocusFrame.current = requestAnimationFrame(() => {
        restoreFocusFrame.current = null;
        if (target?.isConnected) target.focus();
      });
    };
  }, [attemptActive]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      focusConsentControl(
        dialogRef.current?.querySelector<HTMLElement>(
          "[data-repository-initial-focus]",
        ),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [state.phase, visible]);

  if (!visible || !state.reference) return null;

  const dismiss = (): void => {
    if (state.phase === "installing") return;
    void dismissRepositorySetup();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    trapTab(event, dialogRef.current);
  };

  return (
    <>
      <div className="backdrop" onClick={dismiss} />
      <div
        aria-labelledby="repository-setup-title"
        aria-modal="true"
        className="dialog repository-setup-dialog"
        data-phase={state.phase}
        data-tid="repository-setup-dialog"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 className="title" id="repository-setup-title">
          {dialogTitle(state.phase)}
        </h2>
        {state.phase === "pending" ? (
          <PendingContact uiMode={uiMode} />
        ) : null}
        {state.phase === "loading" || state.phase === "compiling" ? (
          <RepositoryProgress />
        ) : null}
        {state.phase === "selecting" || state.phase === "review" ? (
          <RepositoryReview
            final={state.phase === "review"}
            uiMode={uiMode}
          />
        ) : null}
        {state.phase === "error" ? <RepositoryError /> : null}
        {state.phase === "success" ? <RepositorySuccess /> : null}
      </div>
    </>
  );
}

function PendingContact({ uiMode }: { uiMode: KernelUiMode }) {
  const reference = useRepositorySetupStore((state) => state.reference)!;
  return (
    <div className="call repository-setup-content">
      <ConsentNotice tone="warning">
        <strong>Loading does not install anything.</strong> Neutron will
        anonymously contact a third-party repository, verify its certified
        response, and then let you choose applications for a separate final
        review.
      </ConsentNotice>
      <ConsentNotice tone="neutral">
        Gateways and the repository can observe request metadata. Neutron has
        not verified the repository provider or software publisher.
      </ConsentNotice>
      <ConsentTechnicalDetails mode={uiMode}>
      <dl className="repository-facts">
        <Fact label="Repository canister" value={reference.repo} mono />
        <Fact label="Manifest" value={reference.manifest} mono />
        <Fact label="Pinned digest" value={reference.digest} mono />
      </dl>
      <div className="repository-notice">
        If you continue, this browser will query that canister as an anonymous
        caller and verify IC-certified data. Gateways and network infrastructure
        can still observe request metadata. A provider can issue a unique
        manifest ID or digest and correlate it with the request. Neutron cannot
        infer whether an identifier was made for tracking; providers must not
        encode personal, affiliate, or hidden tracking identifiers in it.
      </div>
      </ConsentTechnicalDetails>
      <div className="repository-third-party">
        Third-party software — not reviewed, hosted, sold, or endorsed by
        Neutron.
      </div>
      <div className="btn-actions">
        <button
          className="btn"
          data-tid="repository-load"
          onClick={() => void loadRepositorySetup()}
          type="button"
        >
          Load setup
        </button>
        <button
          className="btn btn-sec"
          data-repository-initial-focus
          data-tid="repository-dismiss"
          onClick={() => void dismissRepositorySetup()}
          type="button"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function RepositoryProgress() {
  const progress = useRepositorySetupStore((state) => state.progress);
  return (
    <div className="call repository-progress" aria-live="polite">
      <div className="loader" aria-hidden="true" />
      <div data-tid="repository-progress-label">
        {progress?.label ?? "Working"}
      </div>
      {progress && progress.total > 0 ? (
        <progress max={progress.total} value={progress.current} />
      ) : null}
      <button
        className="btn btn-sec"
        data-repository-initial-focus
        data-tid="repository-cancel"
        onClick={() => void dismissRepositorySetup()}
        type="button"
      >
        Cancel
      </button>
    </div>
  );
}

function RepositoryReview({
  final,
  uiMode,
}: {
  final: boolean;
  uiMode: KernelUiMode;
}) {
  const state = useRepositorySetupStore();
  const loaded = state.loaded!;
  const selection = state.selection!;
  const selectedCount = selection.selected.size;
  const availableCount = loaded.packages.filter(
    ({ id }) => !loaded.reconciliation[id]?.installed,
  ).length;
  const allAvailableSelected =
    availableCount > 0 && state.rootIds.length === availableCount;

  return (
    <div className="call repository-setup-content">
      <RepositoryHeader uiMode={uiMode} />
      <div className="repository-third-party">
        Third-party software — not reviewed, hosted, sold, or endorsed by
        Neutron.
      </div>
      {availableCount > 0 && !final ? (
        <label className="repository-select-all">
          <input
            checked={allAvailableSelected}
            data-tid="repository-select-all"
            onChange={(event) =>
              selectAllRepositoryPackages(event.currentTarget.checked)
            }
            type="checkbox"
          />
          Select all available
        </label>
      ) : null}
      <div className="repository-package-list">
        {loaded.packages.map((pkg) => {
          const installed = loaded.reconciliation[pkg.id];
          const selected = selection.selected.has(pkg.id);
          const automatic = selection.automatic.has(pkg.id);
          const requiredBy = selection.requiredBy[pkg.id] ?? [];
          return (
            <article
              className={`repository-package${selected ? " is-selected" : ""}`}
              data-app-id={pkg.id}
              key={pkg.id}
            >
              <div className="repository-package-heading">
                {!installed?.installed && !final ? (
                  <input
                    aria-label={`Select ${pkg.preparedPackage.manifest.name}`}
                    checked={selected}
                    data-tid={`repository-package-${pkg.id}`}
                    disabled={automatic}
                    onChange={() => toggleRepositoryPackage(pkg.id)}
                    type="checkbox"
                  />
                ) : null}
                <div>
                  <strong>{pkg.preparedPackage.manifest.name}</strong>
                  <span>
                    {uiMode === "developer" ? (
                      <>
                        <code>{pkg.id}</code> ·{" "}
                      </>
                    ) : null}
                    {formatAppVersionLabel(pkg.version)}
                  </span>
                </div>
                <span className="repository-package-status">
                  {installed?.installed
                    ? `Installed${installed.version ? ` ${formatAppVersionLabel(installed.version)}` : ""} — skipped`
                    : automatic
                      ? "Required dependency"
                      : selected
                        ? "Selected"
                        : "Not selected"}
                </span>
              </div>
              {installed?.issues.length ? (
                <div className="settings-warning" role="alert">
                  {installed.issues.join(" ")}
                </div>
              ) : null}
              {requiredBy.length ? (
                <div className="repository-required-by">
                  Required by {requiredBy.join(", ")}
                </div>
              ) : null}
              <PackageDetails
                pkg={pkg}
                showPermissions={selected}
                uiMode={uiMode}
              />
            </article>
          );
        })}
      </div>
      {selection.blockers.length > 0 ? (
        <div className="settings-warning" role="alert">
          <strong>Dependencies cannot be satisfied.</strong>
          <span>{selection.blockers.join(" ")}</span>
        </div>
      ) : null}
      {availableCount === 0 ? (
        <div className="repository-nothing" data-tid="repository-nothing">
          Nothing to install. Every application in this setup is already
          present and was skipped.
        </div>
      ) : null}
      <div className="btn-actions">
        {availableCount === 0 ? (
          <button
            className="btn"
            data-repository-initial-focus
            data-tid="repository-done"
            onClick={() => void finishRepositorySetup()}
            type="button"
          >
            Done
          </button>
        ) : final ? (
          <>
            <button
              className="btn"
              data-tid="repository-install"
              disabled={selectedCount === 0 || selection.blockers.length > 0}
              onClick={() => void installRepositorySelection()}
              type="button"
            >
              Install {applicationCount(selectedCount)}
            </button>
            <button
              className="btn btn-sec"
              data-repository-initial-focus
              data-tid="repository-back"
              onClick={backToRepositorySelection}
              type="button"
            >
              Back
            </button>
          </>
        ) : (
          <>
            <button
              className="btn"
              data-tid="repository-review"
              disabled={selectedCount === 0 || selection.blockers.length > 0}
              onClick={() => void reviewRepositorySelection()}
              type="button"
            >
              Review {applicationCount(selectedCount)}
            </button>
            <button
              className="btn btn-sec"
              data-repository-initial-focus
              data-tid="repository-dismiss"
              onClick={() => void dismissRepositorySetup()}
              type="button"
            >
              Dismiss
            </button>
          </>
        )}
      </div>
      {final && state.compiledSize !== null ? (
        <div className="compile-done" data-tid="repository-compiled">
          {uiMode === "developer"
            ? `Selected batch compiled successfully. Wasm size: ${state.compiledSize} kb`
            : "Selected applications passed package checks and compilation."}
        </div>
      ) : null}
    </div>
  );
}

function RepositoryHeader({ uiMode }: { uiMode: KernelUiMode }) {
  const { loaded, offeredBy, reference } = useRepositorySetupStore();
  if (!loaded || !reference) return null;
  const links = (["website", "terms", "privacy", "support"] as const)
    .map((label) => [label, loaded.info.provider[label]] as const)
    .filter((entry): entry is readonly [typeof entry[0], string] =>
      typeof entry[1] === "string",
    );
  return (
    <>
      <section className="repository-normal-summary" data-source="repository">
        <strong>{loaded.info.name}</strong>
        <span>
          Provider claim: {loaded.info.provider.name} · unverified
        </span>
        <p>
          Neutron verified the repository&apos;s certified response and pinned
          manifest integrity. That does not verify who published or reviewed
          the software.
        </p>
      </section>
      <ConsentTechnicalDetails mode={uiMode} summary="Repository technical details">
      <section className="repository-unverified" data-source="repository">
      <h3>Repository-provided — unverified</h3>
      {offeredBy ? (
        <dl className="repository-facts" data-source="install-offer">
          <Fact
            label="Offered by"
            value={
              offeredBy.kind === "agent"
                ? `${offeredBy.rootAppName} (${offeredBy.rootAppId})`
                : `${offeredBy.appName} (${offeredBy.appId})`
            }
          />
          <Fact
            label="Initiated through"
            value={
              offeredBy.kind === "agent"
                ? "Agent tool"
                : offeredBy.surface === "tile"
                  ? "Application tile"
                  : offeredBy.surface === "tray"
                    ? "Application tray"
                    : "Background process"
            }
          />
          {offeredBy.kind === "agent" ? (
            <>
              <Fact
                label="Agent entrypoint"
                value={offeredBy.entrypoint}
                mono
              />
              <Fact
                label="Executing app"
                value={`${offeredBy.appName} (${offeredBy.appId})`}
              />
              <Fact label="Scoped tool" value={offeredBy.tool} mono />
            </>
          ) : null}
        </dl>
      ) : null}
      <strong>{loaded.info.name}</strong>
      {loaded.info.description ? <p>{loaded.info.description}</p> : null}
      <span>Provider claim: {loaded.info.provider.name}</span>
      {loaded.info.provider.description ? (
        <p>{loaded.info.provider.description}</p>
      ) : null}
      {links.length ? (
        <div className="repository-links">
          {links.map(([label, href]) => (
            <a
              href={href}
              key={label}
              referrerPolicy="no-referrer"
              rel="noopener noreferrer"
              target="_blank"
            >
              {label}
            </a>
          ))}
        </div>
      ) : null}
      <dl className="repository-facts">
        <Fact label="Canister" value={reference.repo} mono />
        <Fact
          label="Manifest"
          value={`${loaded.manifest.name} · revision ${loaded.manifest.revision}`}
        />
        <Fact label="Pinned digest" value={reference.digest} mono />
      </dl>
      {loaded.manifest.description ? <p>{loaded.manifest.description}</p> : null}
      </section>
      </ConsentTechnicalDetails>
    </>
  );
}

function PackageDetails({
  pkg,
  showPermissions,
  uiMode,
}: {
  pkg: NonNullable<ReturnType<typeof useRepositorySetupStore.getState>["loaded"]>["packages"][number];
  showPermissions: boolean;
  uiMode: KernelUiMode;
}) {
  const dependencies = Object.values(pkg.preparedPackage.manifest.dependencies ?? {});
  return (
    <div className="repository-package-review">
      {showPermissions ? (
        <PermissionConsequences permissions={pkg.permissions} />
      ) : null}
      <ConsentTechnicalDetails
        className="repository-package-details"
        mode={uiMode}
        summary="Package technical details"
      >
      <dl className="repository-facts">
        <Fact label="Raw size" value={`${pkg.rawSize.toLocaleString()} bytes`} />
        <Fact label="SHA-256" value={pkg.digest} mono />
        <Fact
          label="Capability plan"
          value={pkg.capabilityPlanFingerprint}
          mono
        />
        {pkg.publisher && !pkg.publisher.website ? (
          <Fact label="Publisher claim" value={pkg.publisher.name} />
        ) : null}
        {pkg.publisher?.website ? (
          <LinkFact
            href={pkg.publisher.website}
            label="Publisher claim"
            value={pkg.publisher.name}
          />
        ) : null}
        {pkg.source ? (
          <LinkFact href={pkg.source} label="Source claim" value={pkg.source} />
        ) : null}
      </dl>
      {pkg.capabilityDisclosures.length > 0 ? (
        <div className="repository-permissions">
          <strong>
            Kernel-verified capability plan ({pkg.capabilityDisclosures.length})
          </strong>
          {pkg.capabilityDisclosures.map((disclosure) => (
            <details key={disclosure.id}>
              <summary>
                {disclosure.title} · {disclosure.provenance}
              </summary>
              <p>{disclosure.summary}</p>
              <p>
                Machine-enforced authority fields only. App-provided prose is
                listed separately as unverified.
              </p>
              <pre>
                {JSON.stringify(
                  repositoryCapabilityAuthorityConfig(disclosure.entry),
                  null,
                  2,
                )}
              </pre>
            </details>
          ))}
        </div>
      ) : null}
      {dependencies.length ? (
        <ul className="repository-dependencies">
          {dependencies.map((dependency) => (
            <li key={dependency.app}>
              <code>{dependency.app}</code> {formatAppVersionLabel(dependency.min_version)}+
            </li>
          ))}
        </ul>
      ) : null}
      {pkg.permissions.length ? (
        <div className="permission-list">
          {pkg.permissions.map((permission, index) => (
            <PermissionDisclosure
              key={`${permission.kind}:${index}`}
              permission={permission}
            />
          ))}
        </div>
      ) : (
        <div className="perm-green">No exceptional kernel permissions.</div>
      )}
      {pkg.appExplanations.length ? (
        <div className="repository-unverified" data-source="app">
          <strong>App-provided explanation — unverified</strong>
          {pkg.appExplanations.map((explanation, index) => (
            <p key={`${explanation.kind}:${index}`}>
              {explanation.kind === "chain_key_signing_slot_purpose" ||
              explanation.kind === "stable_store_purpose" ? (
                <>
                  <strong>App-provided purpose — unverified:</strong>{" "}
                </>
              ) : null}
              {explanation.text}
            </p>
          ))}
        </div>
      ) : null}
      </ConsentTechnicalDetails>
    </div>
  );
}

function repositoryCapabilityAuthorityConfig(
  entry: Parameters<typeof PackageDetails>[0]["pkg"]["capabilityDisclosures"][number]["entry"],
): unknown {
  switch (entry.id) {
    case "backend_calls":
      return {
        api: entry.config.api,
        reservation_scopes: entry.config.reservation_scopes,
        max_concurrency: entry.config.max_concurrency,
      };
    case "randomness":
      return {
        api: entry.config.api,
      };
    case "chain_key_signing":
      return {
        api: entry.config.api,
        slots: entry.config.slots.map((slot) => ({
          id: slot.id,
          algorithm: slot.algorithm,
          max_assertion_bytes: slot.max_assertion_bytes,
        })),
      };
    case "https_outcalls":
      return {
        api: entry.config.api,
        endpoints: entry.config.endpoints.map((endpoint) => ({
          id: endpoint.id,
          url_prefix: endpoint.url_prefix,
          methods: endpoint.methods,
          request_headers: endpoint.request_headers,
          max_request_bytes: endpoint.max_request_bytes,
          max_response_bytes: endpoint.max_response_bytes,
          transform: endpoint.transform,
        })),
      };
    case "stable_store":
      return {
        api: entry.config.api,
        stores: entry.config.stores.map((store) => ({
          id: store.id,
          schema_version: store.schema_version,
          max_entries: store.max_entries,
          max_key_bytes: store.max_key_bytes,
          max_value_bytes: store.max_value_bytes,
          max_bytes: store.max_bytes,
        })),
      };
    case "vetkeys":
      return {
        api: entry.config.api,
        slots: entry.config.slots.map(({ id }) => ({ id })),
      };
    default:
      return entry.config;
  }
}

function RepositoryError() {
  const { error, errorStage } = useRepositorySetupStore();
  return (
    <div className="call">
      <div className="repository-error" data-tid="repository-error" role="alert">
        {error ?? "Repository setup failed"}
      </div>
      <p>
        No further repository request will be made unless you reload this
        setup. Neutron will reconcile any interrupted install journal before
        the next attempt.
      </p>
      <div className="btn-actions">
        <button
          className="btn"
          data-tid="repository-retry"
          onClick={() => void retryRepositorySetup(errorStage)}
          type="button"
        >
          {errorStage === "compile" ? "Retry compilation" : "Reload setup"}
        </button>
        {errorStage === "compile" ? (
          <button
            className="btn btn-sec"
            onClick={backToRepositorySelection}
            type="button"
          >
            Back
          </button>
        ) : null}
        <button
          className="btn btn-sec"
          data-repository-initial-focus
          data-tid="repository-dismiss"
          onClick={() => void dismissRepositorySetup()}
          type="button"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function RepositorySuccess() {
  const count = useRepositorySetupStore(
    (state) => state.selection?.selected.size ?? 0,
  );
  return (
    <div className="call" aria-live="polite">
      <div className="compile-done" data-tid="repository-success">
        Installed {applicationCount(count)} successfully.
      </div>
      <button
        className="btn"
        data-repository-initial-focus
        data-tid="repository-done"
        onClick={() => void finishRepositorySetup()}
        type="button"
      >
        Done
      </button>
    </div>
  );
}

function Fact({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? "instance-id" : undefined}>{value}</dd>
    </div>
  );
}

function LinkFact({
  href,
  label,
  value,
}: {
  href: string;
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <a
          href={href}
          referrerPolicy="no-referrer"
          rel="noopener noreferrer"
          target="_blank"
        >
          {value}
        </a>
      </dd>
    </div>
  );
}

function useOtherDomModalActive(): boolean {
  const [active, setActive] = useState(hasOtherDomModal);

  useEffect(() => {
    const refresh = () => setActive(hasOtherDomModal());
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-modal"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  return active;
}

function hasOtherDomModal(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')]
    .some(
      (element) =>
        element.dataset.tid !== "repository-setup-dialog" &&
        !element.closest('[data-tid="repository-setup-dialog"]'),
    );
}

function dialogTitle(phase: string): string {
  if (phase === "pending") return "Load application setup?";
  if (phase === "loading") return "Verifying application setup";
  if (phase === "compiling") return "Compiling applications";
  if (phase === "review") return "Approve application setup";
  if (phase === "success") return "Applications installed";
  if (phase === "error") return "Application setup failed";
  return "Choose applications";
}

function applicationCount(count: number): string {
  return `${count} application${count === 1 ? "" : "s"}`;
}

function trapTab(
  event: React.KeyboardEvent<HTMLDivElement>,
  dialog: HTMLDivElement | null,
): void {
  const controls = dialog?.querySelectorAll<HTMLElement>(
    'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  );
  if (!controls?.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) return;
  if (!dialog?.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
