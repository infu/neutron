import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { IoRefresh } from "react-icons/io5";
import type { NeutronCertifiedAssetsCapabilityConfig } from "neutron-tools/src/capabilities/catalog.js";
import type { CapabilitySummary } from "./capability_registry.ts";
import {
  certifiedAssetsWriteState,
  loadCertifiedAssetsSettings,
  parseAdmissionCeilings,
  runCertifiedAssetsMaintenancePage,
  setCertifiedAssetsAdmissionCeilings,
  setCertifiedAssetsWritesFrozen,
  type CertifiedAssetsAdmissionCeilings,
  type CertifiedAssetsSettingsActor,
  type CertifiedAssetsSettingsSnapshot,
} from "./certified_assets_settings.ts";
import { formatBytes, formatExactNat } from "./format.ts";

type Resource = {
  data: CertifiedAssetsSettingsSnapshot | null;
  loading: boolean;
  error: string | null;
  result: string | null;
};

type PendingAction =
  | { kind: "ceilings"; ceilings: CertifiedAssetsAdmissionCeilings }
  | { kind: "freeze" | "unfreeze" | "maintenance" };

type CeilingInputs = Record<keyof CertifiedAssetsAdmissionCeilings, string>;

const EMPTY_RESOURCE: Resource = {
  data: null,
  loading: false,
  error: null,
  result: null,
};

export function CertifiedAssetsSettingsControls({
  actionsDisabled,
  appId,
  appName,
  capabilitySummary,
  manifest,
  open,
  routeSummaries,
}: {
  actionsDisabled: boolean;
  appId: string;
  appName: string;
  capabilitySummary: CapabilitySummary;
  manifest: NeutronCertifiedAssetsCapabilityConfig;
  open: boolean;
  routeSummaries: readonly CapabilitySummary[];
}) {
  const [resource, setResource] = useState<Resource>(EMPTY_RESOURCE);
  const [operation, setOperation] = useState<PendingAction["kind"] | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [ceilingInputs, setCeilingInputs] = useState<CeilingInputs | null>(null);
  const generation = useRef(0);
  const automaticLoadScope = useRef<string | null>(null);
  const active = capabilitySummary.enabled;
  const loadScope = [
    appId,
    capabilitySummary.installationUid,
    capabilitySummary.declarationFingerprint,
  ].join(":");
  const scope = {
    app_id: appId,
    installation_uid: BigInt(capabilitySummary.installationUid),
  };

  const refresh = useCallback(async () => {
    if (!active) return;
    const request = ++generation.current;
    setResource((current) => ({
      ...current,
      loading: true,
      error: null,
      result: null,
    }));
    try {
      const actor = await getSettingsActor();
      const data = await loadCertifiedAssetsSettings(
        actor as unknown as CertifiedAssetsSettingsActor,
        scope,
        manifest,
      );
      if (request !== generation.current) return;
      setResource({ data, loading: false, error: null, result: null });
      setCeilingInputs(ceilingStrings(data));
    } catch (error) {
      if (request !== generation.current) return;
      setResource((current) => ({
        ...current,
        loading: false,
        error: errorMessage(error),
      }));
    }
  }, [
    active,
    appId,
    manifest,
    scope.app_id,
    scope.installation_uid,
  ]);

  useEffect(() => {
    if (!open || !active) {
      automaticLoadScope.current = null;
      return;
    }
    if (automaticLoadScope.current === loadScope) return;
    automaticLoadScope.current = loadScope;
    setResource(EMPTY_RESOURCE);
    setCeilingInputs(null);
    void refresh();
  }, [active, loadScope, open, refresh]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!active) {
      generation.current += 1;
      setPending(null);
    }
  }, [active]);

  const beginCeilings = (event: FormEvent) => {
    event.preventDefault();
    if (!ceilingInputs) return;
    try {
      const ceilings = parseAdmissionCeilings(ceilingInputs, manifest);
      setResource((current) => ({ ...current, error: null }));
      setPending({ kind: "ceilings", ceilings });
    } catch (error) {
      setResource((current) => ({
        ...current,
        error: errorMessage(error),
      }));
    }
  };

  const apply = async (action: PendingAction) => {
    if (!active || actionsDisabled || operation !== null) {
      setPending(null);
      return;
    }
    setPending(null);
    setOperation(action.kind);
    setResource((current) => ({ ...current, error: null, result: null }));
    try {
      const actor = await getSettingsActor();
      const settingsActor = actor as unknown as CertifiedAssetsSettingsActor;
      let result: string;
      switch (action.kind) {
        case "ceilings":
          await setCertifiedAssetsAdmissionCeilings(
            settingsActor,
            scope,
            manifest,
            action.ceilings,
          );
          result = "Runtime admission ceilings updated.";
          break;
        case "freeze":
        case "unfreeze":
          await setCertifiedAssetsWritesFrozen(
            settingsActor,
            scope,
            action.kind === "freeze",
          );
          result =
            action.kind === "freeze"
              ? "Positive publication growth is frozen."
              : "Publication growth is enabled within the runtime ceilings.";
          break;
        case "maintenance": {
          const page = await runCertifiedAssetsMaintenancePage(
            settingsActor,
            scope,
          );
          result = `Certified-assets cleanup reclaimed ${formatExactNat(
            page.page.chargedBytes,
          )} charged bytes; ${formatExactNat(
            page.remainingJobs,
          )} jobs remain.`;
          break;
        }
      }
      await refresh();
      setResource((current) => ({ ...current, result }));
    } catch (error) {
      setResource((current) => ({
        ...current,
        error: errorMessage(error),
      }));
    } finally {
      setOperation(null);
    }
  };

  const busy =
    !active || actionsDisabled || resource.loading || operation !== null;
  const writeState = resource.data
    ? certifiedAssetsWriteState(resource.data.scopeInfo)
    : null;

  return (
    <section
      aria-label={`Certified public storage controls for ${appName}`}
      className="settings-certified-assets"
      data-tid={`settings-certified-assets-${appId}`}
    >
      <header className="settings-certified-assets-heading">
        <span>
          <strong>Certified public storage</strong>
          <small>
            Mutation-attributed storage/cycle usage. Public HTTP query delivery
            is excluded; unavailable usage is never treated as zero.
          </small>
        </span>
        <button
          aria-label={`Refresh certified public storage for ${appName}`}
          className="icon-button"
          disabled={busy || !active}
          onClick={() => void refresh()}
          title="Refresh certified public storage"
          type="button"
        >
          <IoRefresh aria-hidden="true" />
        </button>
      </header>

      {!active ? (
        <div className="settings-certified-assets-notice" role="status">
          The scoped publishing capability is disabled. Its existing public
          route state is controlled independently by the public-read mount
          switches.
        </div>
      ) : null}

      {resource.error ? (
        <div className="settings-inline-error" role="alert">
          {resource.error}
        </div>
      ) : null}
      {resource.result ? (
        <div className="settings-certified-assets-result" role="status">
          {resource.result}
        </div>
      ) : null}
      {resource.loading && !resource.data ? (
        <div
          aria-label="Loading certified public storage"
          className="settings-loading"
          role="status"
        >
          <span aria-hidden="true" className="loader" />
        </div>
      ) : null}

      {active && resource.data ? (
        <>
          <CertifiedAssetsUsageFacts snapshot={resource.data} />
          <div className="settings-certified-assets-routes">
            <strong>Public-read mounts are independent</strong>
            <span>
              A route switch hides its bodies behind the fixed certified 404
              without deleting storage. Write freeze below does not hide
              existing responses.
            </span>
            <div>
              {routeSummaries.map((route) => (
                <code key={route.resourceId}>
                  {route.resourceId}: {route.enabled ? "serving" : "disabled"}
                </code>
              ))}
            </div>
          </div>

          <form
            className="settings-certified-assets-ceilings"
            onSubmit={beginCeilings}
          >
            <div>
              <strong>Runtime admission ceilings</strong>
              <span>
                Owner-reviewed ceilings may be lowered or raised only within
                the immutable manifest maxima. Lowering never deletes data.
              </span>
            </div>
            {ceilingInputs ? (
              <div className="settings-certified-assets-ceiling-grid">
                <CeilingField
                  disabled={busy}
                  label="Entries"
                  manifestMaximum={manifest.max_entries}
                  onChange={(value) =>
                    setCeilingInputs((current) =>
                      current ? { ...current, entries: value } : current,
                    )
                  }
                  value={ceilingInputs.entries}
                />
                <CeilingField
                  bytes
                  disabled={busy}
                  label="Committed bytes"
                  manifestMaximum={manifest.max_committed_bytes}
                  onChange={(value) =>
                    setCeilingInputs((current) =>
                      current ? { ...current, committedBytes: value } : current,
                    )
                  }
                  value={ceilingInputs.committedBytes}
                />
                <CeilingField
                  bytes
                  disabled={busy}
                  label="Staged bytes"
                  manifestMaximum={manifest.max_staged_bytes}
                  onChange={(value) =>
                    setCeilingInputs((current) =>
                      current ? { ...current, stagedBytes: value } : current,
                    )
                  }
                  value={ceilingInputs.stagedBytes}
                />
                <CeilingField
                  disabled={busy}
                  label="General receipt lanes"
                  manifestMaximum={manifest.max_idempotency_receipts}
                  onChange={(value) =>
                    setCeilingInputs((current) =>
                      current ? { ...current, generalReceipts: value } : current,
                    )
                  }
                  value={ceilingInputs.generalReceipts}
                />
              </div>
            ) : null}
            <button className="btn btn-sec btn-sm" disabled={busy} type="submit">
              Review ceiling changes
            </button>
          </form>

          <div className="settings-certified-assets-actions">
            <span>
              <strong>Write admission</strong>
              <small>
                {writeState === "frozen"
                  ? "Frozen: positive entry, byte, stage, and receipt growth is blocked."
                  : writeState === "enabled"
                    ? "Enabled within the owner-reviewed runtime ceilings."
                    : "Collection write states differ; freezing applies to the complete store."}
              </small>
            </span>
            <button
              className={`btn ${
                writeState === "frozen" ? "btn-warning" : "btn-sec"
              } btn-sm`}
              disabled={busy}
              onClick={() =>
                setPending({
                  kind: writeState === "frozen" ? "unfreeze" : "freeze",
                })
              }
              type="button"
            >
              {writeState === "frozen" ? "Review unfreeze" : "Review freeze"}
            </button>
          </div>

          <div className="settings-certified-assets-actions">
            <span>
              <strong>Kernel certified-assets cleanup</strong>
              <small>
                Advances exactly one bounded page of an already-persisted
                current or retired-scope job; no target or cursor is selectable.
              </small>
            </span>
            <button
              className="btn btn-sec btn-sm"
              disabled={busy}
              onClick={() => setPending({ kind: "maintenance" })}
              type="button"
            >
              Review one cleanup page
            </button>
          </div>

          <div className="settings-certified-assets-lifecycle">
            Scope retirement is not a standalone Settings action. It runs only
            inside the existing authorized uninstall/reinstall lifecycle.
          </div>
        </>
      ) : null}

      {pending ? (
        <CertifiedAssetsConfirmation
          action={pending}
          appName={appName}
          onCancel={() => setPending(null)}
          onConfirm={() => void apply(pending)}
        />
      ) : null}
    </section>
  );
}

function CertifiedAssetsUsageFacts({
  snapshot,
}: {
  snapshot: CertifiedAssetsSettingsSnapshot;
}) {
  const { current } = snapshot.usage;
  return (
    <>
      <dl className="settings-certified-assets-facts">
        <UsageFact
          label="Live / occupied entries"
          value={`${formatExactNat(current.liveEntries)} / ${formatExactNat(
            current.occupiedEntrySlots,
          )}`}
        />
        <UsageFact
          label="Committed / allocated bodies"
          value={`${formatBytes(current.committedBodyBytes)} / ${formatBytes(
            current.allocatedBodyBytes,
          )}`}
        />
        <UsageFact
          label="Metadata charge"
          value={formatBytes(current.chargedMetadataBytes)}
        />
        <UsageFact
          label="Staged accepted / reserved"
          value={`${formatBytes(current.acceptedStagedBytes)} / ${formatBytes(
            current.reservedStagedBytes,
          )}`}
        />
        <UsageFact
          label="Detached cleanup charge"
          value={formatBytes(current.detachedChargedBytes)}
        />
        <UsageFact
          label="Receipt lanes"
          value={formatExactNat(current.receiptLanes)}
        />
        <UsageFact
          label="Cleanup jobs"
          value={formatExactNat(current.cleanupJobs)}
        />
        <UsageFact
          label="Installation generation"
          value={formatExactNat(snapshot.scopeInfo.installationGeneration)}
        />
        <UsageFact
          label="Store authority epoch"
          value={formatExactNat(snapshot.scopeInfo.storeAuthorityEpoch)}
        />
      </dl>
      <div className="settings-certified-assets-collections">
        {snapshot.scopeInfo.collections.map((collection) => (
          <div key={collection.id}>
            <span>
              <strong>{collection.id}</strong>
              <small>{collectionKindLabel(collection.kind)}</small>
            </span>
            <code>
              {collection.serving} · writes {collection.writes} · generation{" "}
              {formatExactNat(collection.generation)}
            </code>
          </div>
        ))}
      </div>
    </>
  );
}

function UsageFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CeilingField({
  bytes = false,
  disabled,
  label,
  manifestMaximum,
  onChange,
  value,
}: {
  bytes?: boolean;
  disabled: boolean;
  label: string;
  manifestMaximum: number;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        autoComplete="off"
        disabled={disabled}
        inputMode="numeric"
        max={manifestMaximum.toString()}
        min="0"
        onChange={(event) => onChange(event.target.value)}
        pattern="(?:0|[1-9][0-9]*)"
        required
        type="text"
        value={value}
      />
      <small>
        Manifest max{" "}
        {bytes
          ? `${formatBytes(manifestMaximum)} (${formatExactNat(
              manifestMaximum,
            )})`
          : formatExactNat(manifestMaximum)}
      </small>
    </label>
  );
}

function CertifiedAssetsConfirmation({
  action,
  appName,
  onCancel,
  onConfirm,
}: {
  action: PendingAction;
  appName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);
  const title = confirmationTitle(action);
  return (
    <>
      <div className="backdrop" onClick={onCancel} />
      <div
        aria-labelledby="certified-assets-confirm-title"
        aria-modal="true"
        className="dialog dialog-warning"
        data-tid="settings-certified-assets-confirm"
        role="alertdialog"
      >
        <div className="title" id="certified-assets-confirm-title">
          {title}
        </div>
        <div className="call">
          <div className="a-infogrid">
            <div className="label">App</div>
            <div className="val">{appName}</div>
            {action.kind === "ceilings" ? (
              <>
                <div className="label">Entries</div>
                <div className="val">
                  {formatExactNat(action.ceilings.entries)}
                </div>
                <div className="label">Committed bytes</div>
                <div className="val">
                  {formatExactNat(action.ceilings.committedBytes)}
                </div>
                <div className="label">Staged bytes</div>
                <div className="val">
                  {formatExactNat(action.ceilings.stagedBytes)}
                </div>
                <div className="label">General receipts</div>
                <div className="val">
                  {formatExactNat(action.ceilings.generalReceipts)}
                </div>
              </>
            ) : null}
          </div>
          <div className="uninstall-warning">{confirmationWarning(action)}</div>
          <div className="btn-actions">
            <button
              className="btn btn-warning"
              data-tid="settings-certified-assets-confirm-apply"
              onClick={onConfirm}
              type="button"
            >
              Apply one action
            </button>
            <button
              className="btn btn-sec"
              data-tid="settings-certified-assets-confirm-cancel"
              onClick={onCancel}
              ref={cancelRef}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function confirmationWarning(action: PendingAction): string {
  switch (action.kind) {
    case "ceilings":
      return "Lowering a ceiling never deletes or hides data. It can immediately block positive growth until usage falls below the selected ceiling.";
    case "freeze":
      return "This blocks positive storage and receipt growth. It does not hide or revoke already-published HTTP responses.";
    case "unfreeze":
      return "This permits positive growth only within the selected runtime ceilings and immutable manifest maxima.";
    case "maintenance":
      return "This advances one bounded kernel-owned cleanup page selected from already-persisted jobs. It cannot select a target or publish content.";
  }
}

function confirmationTitle(action: PendingAction): string {
  switch (action.kind) {
    case "ceilings":
      return "Change runtime admission ceilings";
    case "freeze":
      return "Freeze publication growth";
    case "unfreeze":
      return "Enable publication growth";
    case "maintenance":
      return "Run one certified-assets cleanup page";
  }
}

function collectionKindLabel(
  kind: CertifiedAssetsSettingsSnapshot["scopeInfo"]["collections"][number]["kind"],
): string {
  switch (kind) {
    case "publication":
      return "Publication";
    case "immutable_blob":
      return "Immutable blob";
    case "mutable_blob":
      return "Mutable blob";
  }
}

function ceilingStrings(
  snapshot: CertifiedAssetsSettingsSnapshot,
): CeilingInputs {
  const limits = snapshot.usage.effectiveLimits;
  return {
    entries: limits.entries.toString(),
    committedBytes: limits.committedBytes.toString(),
    stagedBytes: limits.stagedBytes.toString(),
    generalReceipts: limits.generalReceipts.toString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getSettingsActor() {
  // Keep AppSettingsEntry server-renderable in tests. The authenticated actor
  // and its runtime-DID fallback are needed only after the owner opens these
  // live controls in a browser.
  const { getNeutronCan } = await import("../reducer/auth.ts");
  return getNeutronCan();
}
