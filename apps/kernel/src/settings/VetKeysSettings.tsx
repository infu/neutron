import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Principal } from "@dfinity/principal";
import {
  IoKeyOutline,
  IoRefresh,
  IoShieldCheckmarkOutline,
} from "react-icons/io5";
import { getNeutronCan } from "../reducer/auth.ts";
import { useAppsStore } from "../reducer/apps.ts";
import { formatTrillionCycles } from "./format.ts";
import { CopyButton } from "./CopyButton.tsx";
import { validateAccessSnapshot } from "./model.ts";
import { SettingsDisclosure } from "./SettingsDisclosure.tsx";
import {
  assertVetKeysOperation,
  shortenFingerprint,
  validateVetKeysAdminSnapshot,
  vetKeysSlotControlPolicy,
  type VetKeysAdminSlot,
  type VetKeysAdminSnapshot,
} from "./vetkeys_model.ts";

type Resource = {
  data: VetKeysAdminSnapshot | null;
  authorized: string[];
  loading: boolean;
  error: string | null;
};

export type PendingAction =
  | { kind: "enable" | "disable" | "rotate" | "retireSlot"; slot: VetKeysAdminSlot }
  | { kind: "retireGeneration"; slot: VetKeysAdminSlot; generation: string }
  | { kind: "transfer"; slot: VetKeysAdminSlot; newHolder: string };

const EMPTY: Resource = {
  data: null,
  authorized: [],
  loading: false,
  error: null,
};

export function VetKeysSettings({ currentPrincipal }: { currentPrincipal: string }) {
  const [open, setOpen] = useState(false);
  const [resource, setResource] = useState<Resource>(EMPTY);
  const [operation, setOperation] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [transferInputs, setTransferInputs] = useState<Record<string, string>>({});
  const [fieldError, setFieldError] = useState<string | null>(null);
  const generation = useRef(0);
  const apps = useAppsStore((state) => state.list);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setResource((current) => ({ ...current, loading: true, error: null }));
    try {
      const actor = await getNeutronCan();
      const [vetKeysRaw, accessRaw] = await Promise.all([
        actor.kernel_vetkeys_admin_snapshot(null),
        actor.kernel_access_snapshot(null),
      ]);
      const data = validateVetKeysAdminSnapshot(vetKeysRaw);
      const authorized = validateAccessSnapshot(accessRaw).authorized_principals;
      if (request === generation.current) {
        setResource({ data, authorized, loading: false, error: null });
      }
    } catch (error) {
      if (request === generation.current) {
        setResource((current) => ({
          ...current,
          loading: false,
          error: errorMessage(error),
        }));
      }
    }
  }, []);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const grouped = useMemo(() => {
    const result = new Map<string, VetKeysAdminSlot[]>();
    for (const slot of resource.data?.slots ?? []) {
      const slots = result.get(slot.appId) ?? [];
      slots.push(slot);
      result.set(slot.appId, slots);
    }
    return [...result.entries()];
  }, [resource.data]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !resource.data && !resource.loading) void refresh();
  };

  const beginTransfer = (slot: VetKeysAdminSlot) => {
    setFieldError(null);
    const input = transferInputs[slotKey(slot)]?.trim() ?? "";
    try {
      const parsed = Principal.fromText(input).toText();
      if (parsed === "2vxsx-fae" || parsed === "aaaaa-aa") {
        throw new Error("Enter an ordinary non-anonymous principal");
      }
      if (parsed === slot.keyHolder) {
        throw new Error("This principal already holds the slot");
      }
      if (!resource.authorized.includes(parsed)) {
        throw new Error("Select a currently authorized principal");
      }
      setPending({ kind: "transfer", slot, newHolder: parsed });
    } catch (error) {
      setFieldError(errorMessage(error));
    }
  };

  const apply = async (action: PendingAction) => {
    const key = `${action.kind}:${slotKey(action.slot)}`;
    setPending(null);
    setOperation(key);
    setResource((current) => ({ ...current, error: null }));
    try {
      const actor = await getNeutronCan();
      const common = {
        app_id: action.slot.appId,
        slot_id: action.slot.slot,
      };
      let result: unknown;
      switch (action.kind) {
        case "enable":
          result = await actor.kernel_vetkeys_enable(common);
          break;
        case "disable":
          result = await actor.kernel_vetkeys_disable(common);
          break;
        case "rotate":
          result = await actor.kernel_vetkeys_rotate(common);
          break;
        case "retireGeneration":
          result = await actor.kernel_vetkeys_retire_generation({
            ...common,
            generation: BigInt(action.generation),
          });
          break;
        case "transfer":
          result = await actor.kernel_vetkeys_transfer({
            ...common,
            new_holder: Principal.fromText(action.newHolder),
          });
          break;
        case "retireSlot":
          result = await actor.kernel_vetkeys_retire_slot(common);
          break;
      }
      assertVetKeysOperation(result);
      if (action.kind === "transfer") {
        setTransferInputs((current) => ({
          ...current,
          [slotKey(action.slot)]: "",
        }));
      }
      await refresh();
    } catch (error) {
      setResource((current) => ({ ...current, error: errorMessage(error) }));
    } finally {
      setOperation(null);
    }
  };

  return (
    <>
      <SettingsDisclosure
        contentTestId="settings-vetkeys"
        description="App-isolated threshold keys, recovery cost, and audit"
        icon={<IoKeyOutline aria-hidden="true" />}
        id="settings-vetkeys"
        onToggle={toggle}
        open={open}
        testId="settings-vetkeys-toggle"
        title="Private-key slots"
      >
        <div className="settings-vetkeys-toolbar">
          <span>
            {resource.data?.environment
              ? `${resource.data.environment === "local" ? "Local test key" : "Production key"} · ${resource.data.slots.length} active slot${resource.data.slots.length === 1 ? "" : "s"}`
              : "Threshold-key subsystem status"}
          </span>
          <button
            aria-label="Refresh private-key slots"
            className="icon-button"
            disabled={resource.loading || operation !== null}
            onClick={() => void refresh()}
            title="Refresh private-key slots"
            type="button"
          >
            <IoRefresh aria-hidden="true" />
          </button>
        </div>

        <div className="settings-vetkeys-notice">
          <IoShieldCheckmarkOutline aria-hidden="true" />
          <span>
            Neutron stores namespace, public-key, lifecycle, and bounded audit
            metadata—not private keys. A browser-held key cannot be erased by
            disabling or retiring a slot. Every currently authorized Neutron
            principal may explicitly recover retained keys; the listed key
            manager alone controls lifecycle changes.
          </span>
        </div>

        {resource.error ? (
          <div className="settings-inline-error" role="alert">
            <span>{resource.error}</span>
            <button
              aria-label="Retry"
              className="icon-button"
              onClick={() => void refresh()}
              title="Retry"
              type="button"
            >
              <IoRefresh aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {fieldError ? (
          <div className="settings-inline-error" role="alert">
            {fieldError}
          </div>
        ) : null}
        {resource.loading && !resource.data ? (
          <div aria-label="Loading private-key slots" className="settings-loading" role="status">
            <span className="loader" aria-hidden="true" />
          </div>
        ) : null}
        {!resource.loading && resource.data && grouped.length === 0 ? (
          <div className="settings-empty">No app has activated a private-key slot.</div>
        ) : null}

        <div className="settings-vetkeys-groups">
          {grouped.map(([appId, slots]) => (
            <section className="settings-vetkeys-app" key={appId}>
              <header>
                <strong>{apps[appId]?.name ?? appId}</strong>
                <code>{appId}</code>
              </header>
              {slots.map((slot) => {
                const busy = operation !== null;
                const controls = vetKeysSlotControlPolicy(
                  slot,
                  currentPrincipal,
                  busy,
                );
                const transferValue = transferInputs[slotKey(slot)] ?? "";
                return (
                  <article className="settings-vetkeys-slot" key={slot.slotUid}>
                    <div className="settings-vetkeys-slot-heading">
                      <span>
                        <strong>{slot.slot}</strong>
                        <small>{slot.purpose ?? "Declaration removed"}</small>
                      </span>
                      <span className={`settings-vetkeys-status is-${slot.status}`}>
                        {slot.status.replaceAll("_", " ")}
                      </span>
                    </div>
                    <dl className="settings-vetkeys-facts">
                      <Fact label="Key manager">
                        <code title={slot.keyHolder}>{compact(slot.keyHolder)}</code>
                        <CopyButton label="Copy key manager" value={slot.keyHolder} />
                      </Fact>
                      <Fact label="Generations">
                        <span>
                          Current {slot.currentGeneration}
                          {slot.previousGeneration ? ` · Previous ${slot.previousGeneration}` : ""}
                        </span>
                      </Fact>
                      <Fact label="Last recovery">
                        <span>{slot.lastUsedAt ? formatNanos(slot.lastUsedAt) : "Never"}</span>
                      </Fact>
                      <Fact label="Recovery activity">
                        <span>
                          {slot.totalDerivations} total derivations
                        </span>
                      </Fact>
                      <Fact label="Approximate spend">
                        <span>
                          {formatTrillionCycles(
                            BigInt(slot.approximateCycleSpend),
                          )}
                        </span>
                      </Fact>
                      <Fact label="Updated">
                        <span>{formatNanos(slot.updatedAt)}</span>
                      </Fact>
                      <Fact label="Created">
                        <span>{formatNanos(slot.createdAt)}</span>
                      </Fact>
                    </dl>
                    <div className="settings-vetkeys-generations">
                      {slot.generations.map((item) => (
                        <div key={item.generation}>
                          <span>
                            <strong>Generation {item.generation}</strong>
                            <small>{item.status} · {item.keyName}</small>
                          </span>
                          <code title={item.publicFingerprint ? item.publicFingerprint.map((byte) => byte.toString(16).padStart(2, "0")).join("") : undefined}>
                            {shortenFingerprint(item.publicFingerprint)}
                          </code>
                          {item.status === "previous" ? (
                            <button
                              className="btn btn-danger btn-sm"
                              disabled={!controls.canRetireGeneration}
                              onClick={() =>
                                setPending({
                                  kind: "retireGeneration",
                                  slot,
                                  generation: item.generation,
                                })
                              }
                              title={controls.owns ? "Permanently retire previous generation" : "Only the key manager can retire this generation"}
                              type="button"
                            >
                              Retire previous
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    <div className="settings-vetkeys-actions">
                      {controls.showDisable ? (
                        <button
                          className="btn btn-sec btn-sm"
                          disabled={!controls.canDisable}
                          onClick={() => setPending({ kind: "disable", slot })}
                          type="button"
                        >
                          Disable
                        </button>
                      ) : controls.showEnable ? (
                        <button
                          className="btn btn-warning btn-sm"
                          disabled={!controls.canEnable}
                          onClick={() => setPending({ kind: "enable", slot })}
                          type="button"
                        >
                          Enable
                        </button>
                      ) : null}
                      <button
                        className="btn btn-sec btn-sm"
                        disabled={!controls.canRotate}
                        onClick={() => setPending({ kind: "rotate", slot })}
                        title={slot.previousGeneration ? "Retire the existing previous generation first" : "Create a new generation"}
                        type="button"
                      >
                        Rotate
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={!controls.canRetireSlot}
                        onClick={() => setPending({ kind: "retireSlot", slot })}
                        type="button"
                      >
                        Retire slot
                      </button>
                    </div>
                    <div className="settings-vetkeys-transfer">
                      <label htmlFor={`vetkeys-transfer-${slot.slotUid}`}>
                        Transfer to authorized principal
                      </label>
                      <select
                        disabled={!controls.canTransfer}
                        id={`vetkeys-transfer-${slot.slotUid}`}
                        onChange={(event) =>
                          setTransferInputs((current) => ({
                            ...current,
                            [slotKey(slot)]: event.target.value,
                          }))
                        }
                        value={transferValue}
                      >
                        <option value="">Select principal</option>
                        {resource.authorized
                          .filter((principal) => principal !== slot.keyHolder)
                          .map((principal) => (
                            <option key={principal} title={principal} value={principal}>
                              {compact(principal)}
                            </option>
                          ))}
                      </select>
                      <button
                        className="btn btn-sec btn-sm"
                        disabled={!controls.canTransfer || transferValue.trim().length === 0}
                        onClick={() => beginTransfer(slot)}
                        type="button"
                      >
                        Review transfer
                      </button>
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </div>

        {resource.data ? <VetKeysAudit entries={resource.data.audit} /> : null}
      </SettingsDisclosure>
      {pending ? (
        <VetKeysConfirmation
          action={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => void apply(pending)}
        />
      ) : null}
    </>
  );
}

export function VetKeysConfirmation({
  action,
  onCancel,
  onConfirm,
}: {
  action: PendingAction;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);
  const destructive = action.kind === "retireGeneration" || action.kind === "retireSlot";
  return (
    <>
      <div className="backdrop" onClick={onCancel} />
      <div
        aria-labelledby="vetkeys-settings-confirm-title"
        aria-modal="true"
        className={`dialog ${destructive || action.kind === "transfer" || action.kind === "rotate" ? "dialog-danger" : "dialog-warning"}`}
        data-tid="settings-vetkeys-confirm"
        onKeyDown={(event) => confirmKeyDown(event, dialogRef.current, onCancel)}
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id="vetkeys-settings-confirm-title">
          {actionLabel(action.kind)}
        </div>
        <div className="call">
          <div className="a-infogrid">
            <div className="label">App / slot</div>
            <div className="val">{action.slot.appId} / {action.slot.slot}</div>
            {action.kind === "retireGeneration" ? (
              <><div className="label">Generation</div><div className="val">{action.generation}</div></>
            ) : null}
            {action.kind === "transfer" ? (
              <><div className="label">New key manager</div><div className="val principal">{action.newHolder}</div></>
            ) : null}
          </div>
          <div className="uninstall-warning">{actionWarning(action.kind)}</div>
          <div className="btn-actions">
            <button
              className={`btn ${destructive || action.kind === "transfer" || action.kind === "rotate" ? "btn-danger" : "btn-warning"}`}
              data-tid="settings-vetkeys-confirm-apply"
              onClick={onConfirm}
              type="button"
            >
              {destructive ? "Retire permanently" : "Apply"}
            </button>
            <button
              className="btn btn-sec"
              data-tid="settings-vetkeys-confirm-cancel"
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

export function VetKeysAudit({
  entries,
}: {
  entries: VetKeysAdminSnapshot["audit"];
}) {
  if (entries.length === 0) return null;
  return (
    <details className="settings-vetkeys-audit">
      <summary>Recent private-key audit · {entries.length}</summary>
      <div>
        {entries.slice(-50).reverse().map((entry, index) => (
          <div
            key={`${entry.installationUid}:${entry.at}:${entry.slotUid ?? "none"}:${index}`}
          >
            <span>
              <strong>{entry.action.replaceAll("_", " ")}</strong>
              <small>{entry.appId}/{entry.slot || "retired slot"}</small>
            </span>
            <code>{entry.outcome.replaceAll("_", " ")}</code>
            <span className="settings-vetkeys-audit-meta">
              <code title={entry.principal}>{compact(entry.principal)}</code>
              {entry.generation ? <code>g{entry.generation}</code> : null}
              <time dateTime={nanosIso(entry.at)}>{formatNanos(entry.at)}</time>
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function Fact({ children, label }: { children: React.ReactNode; label: string }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function slotKey(slot: VetKeysAdminSlot): string {
  return `${slot.appId}:${slot.installationUid}:${slot.slotUid}`;
}

function compact(value: string): string {
  return value.length > 26 ? `${value.slice(0, 12)}…${value.slice(-9)}` : value;
}

function nanosDate(value: string): Date {
  const milliseconds = BigInt(value) / 1_000_000n;
  const capped = milliseconds > 8_640_000_000_000_000n ? 8_640_000_000_000_000n : milliseconds;
  return new Date(Number(capped));
}

function nanosIso(value: string): string {
  return nanosDate(value).toISOString();
}

function formatNanos(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(nanosDate(value));
}

function actionLabel(kind: PendingAction["kind"]): string {
  return kind === "retireGeneration" ? "Retire key generation" :
    kind === "retireSlot" ? "Retire private-key slot" :
      kind === "transfer" ? "Transfer key manager" :
        kind === "rotate" ? "Rotate key generation" :
          kind === "disable" ? "Disable key recovery" : "Enable key recovery";
}

function actionWarning(kind: PendingAction["kind"]): string {
  if (kind === "retireGeneration") return "This permanently blocks supported future recovery for the previous generation. Data still wrapped to it may become unreadable. Existing browser copies cannot be erased.";
  if (kind === "retireSlot") return "This permanently retires this installed app instance's slot. A reinstall creates a different namespace and cannot recover it.";
  if (kind === "transfer") return "This moves lifecycle control only. It does not rotate key material or change which currently authorized Neutron principals can recover retained generations.";
  if (kind === "rotate") return "A new current generation will be created and the old current generation retained as the previous generation until explicit retirement.";
  if (kind === "disable") return "Future supported recovery stops immediately. This cannot erase a key already held by a browser.";
  return "Supported browser recovery will be restored for this app slot.";
}

function confirmKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  dialog: HTMLElement | null,
  cancel: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key !== "Tab" || !dialog) return;
  const controls = dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Private-key operation failed";
}
