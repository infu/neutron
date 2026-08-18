import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  IoAdd,
  IoKeyOutline,
  IoLockClosedOutline,
  IoRefresh,
  IoShieldCheckmarkOutline,
  IoTerminalOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { getNeutronCan } from "../reducer/auth.ts";
import { CopyButton } from "./CopyButton.tsx";
import {
  parsePrincipalInput,
  validateAccessSnapshot,
  type KernelAccessSnapshot,
} from "./model.ts";
import {
  validateVetKeysAdminSnapshot,
  vetKeysSlotsByHolder,
} from "./vetkeys_model.ts";
import { SettingsDisclosure } from "./SettingsDisclosure.tsx";

type AccessResource = {
  data: KernelAccessSnapshot | null;
  heldSlots: Record<string, string[]>;
  error: string | null;
  loading: boolean;
};

type AccessKind = "authorized" | "controller";

type PendingRemoval = {
  kind: AccessKind;
  principal: string;
};

const emptyResource: AccessResource = {
  data: null,
  heldSlots: {},
  error: null,
  loading: false,
};

export function AccessSettings({
  currentPrincipal,
}: {
  currentPrincipal: string;
}) {
  const [open, setOpen] = useState(false);
  const [resource, setResource] = useState<AccessResource>(emptyResource);
  const [authorizedInput, setAuthorizedInput] = useState("");
  const [controllerInput, setControllerInput] = useState("");
  const [authorizedError, setAuthorizedError] = useState<string | null>(null);
  const [controllerError, setControllerError] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [pendingControllerAddition, setPendingControllerAddition] = useState<
    string | null
  >(null);
  const [pendingRemoval, setPendingRemoval] =
    useState<PendingRemoval | null>(null);
  const loadGeneration = useRef(0);
  const removalFocusTarget = useRef<HTMLButtonElement | null>(null);
  const authorizedInputRef = useRef<HTMLInputElement>(null);
  const controllerInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setResource((current) => ({ ...current, error: null, loading: true }));
    try {
      const actor = await getNeutronCan();
      const [accessRaw, vetKeysRaw] = await Promise.all([
        actor.kernel_access_snapshot(null),
        actor.kernel_vetkeys_admin_snapshot(null),
      ]);
      const snapshot = validateAccessSnapshot(accessRaw);
      const heldSlots = vetKeysSlotsByHolder(
        validateVetKeysAdminSnapshot(vetKeysRaw).slots,
      );
      if (generation === loadGeneration.current) {
        setResource({ data: snapshot, heldSlots, error: null, loading: false });
      }
    } catch (error) {
      if (generation === loadGeneration.current) {
        setResource((current) => ({
          ...current,
          error: errorMessage(error),
          loading: false,
        }));
      }
    }
  }, []);

  useEffect(
    () => () => {
      loadGeneration.current += 1;
    },
    [],
  );

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !resource.data && !resource.loading) void refresh();
  };

  const addPrincipal = async (
    kind: AccessKind,
    value: string,
    controllerRiskConfirmed = false,
  ) => {
    const setFieldError =
      kind === "authorized" ? setAuthorizedError : setControllerError;
    setFieldError(null);

    let principal;
    try {
      principal = parsePrincipalInput(value);
    } catch (error) {
      setFieldError(errorMessage(error));
      return;
    }

    const principalText = principal.toText();
    const existing =
      kind === "authorized"
        ? resource.data?.authorized_principals
        : resource.data?.controllers;
    if (existing?.includes(principalText)) {
      setFieldError(
        kind === "authorized"
          ? "This principal is already authorized"
          : "This principal is already a controller",
      );
      return;
    }
    if (
      kind === "controller" &&
      resource.data &&
      BigInt(resource.data.controllers.length) >= resource.data.controller_limit
    ) {
      setFieldError("The controller limit has been reached");
      return;
    }

    if (kind === "controller" && !controllerRiskConfirmed) {
      setPendingControllerAddition(principalText);
      return;
    }

    setOperation(`${kind}-add`);
    setResource((current) => ({ ...current, error: null }));
    try {
      const actor = await getNeutronCan();
      if (kind === "authorized") {
        await actor.kernel_authorized_add(principal);
        setAuthorizedInput("");
        await refresh();
      } else {
        const snapshot = validateAccessSnapshot(
          await actor.kernel_controller_add(principal),
        );
        setResource((current) => ({
          ...current,
          data: snapshot,
          error: null,
          loading: false,
        }));
        setControllerInput("");
      }
    } catch (error) {
      setResource((current) => ({
        ...current,
        error: errorMessage(error),
      }));
    } finally {
      setOperation(null);
      if (kind === "controller") {
        requestAnimationFrame(() => controllerInputRef.current?.focus());
      }
    }
  };

  const cancelControllerAddition = () => {
    setPendingControllerAddition(null);
    requestAnimationFrame(() => controllerInputRef.current?.focus());
  };

  const removePrincipal = async ({ kind, principal }: PendingRemoval) => {
    const trigger = removalFocusTarget.current;
    setPendingRemoval(null);
    setOperation(`${kind}-remove-${principal}`);
    setResource((current) => ({ ...current, error: null }));
    try {
      const actor = await getNeutronCan();
      const parsed = parsePrincipalInput(principal);
      if (kind === "authorized") {
        await actor.kernel_authorized_rem(parsed);
        await refresh();
      } else {
        const snapshot = validateAccessSnapshot(
          await actor.kernel_controller_rem(parsed),
        );
        setResource((current) => ({
          ...current,
          data: snapshot,
          error: null,
          loading: false,
        }));
      }
    } catch (error) {
      setResource((current) => ({
        ...current,
        error: errorMessage(error),
      }));
    } finally {
      setOperation(null);
      requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus();
        else if (kind === "authorized") authorizedInputRef.current?.focus();
        else controllerInputRef.current?.focus();
      });
      removalFocusTarget.current = null;
    }
  };

  const cancelRemoval = () => {
    const trigger = removalFocusTarget.current;
    const kind = pendingRemoval?.kind;
    setPendingRemoval(null);
    removalFocusTarget.current = null;
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      else if (kind === "authorized") authorizedInputRef.current?.focus();
      else if (kind === "controller") controllerInputRef.current?.focus();
    });
  };

  const selfController = resource.data?.controllers.includes(
    resource.data.self_principal,
  );

  return (
    <>
      <SettingsDisclosure
        contentTestId="settings-access"
        description="Recovery keys and trusted tools"
        icon={<IoKeyOutline aria-hidden="true" />}
        id="settings-access"
        onToggle={toggle}
        open={open}
        testId="settings-access-toggle"
        title="Access & recovery"
      >
        <div className="settings-access-toolbar">
          <span>
            One owner can use several principals. Every authorized principal
            has full Neutron access.
          </span>
          <button
            aria-label="Refresh access"
            className="icon-button"
            disabled={resource.loading || operation !== null}
            onClick={() => void refresh()}
            title="Refresh access"
            type="button"
          >
            <IoRefresh aria-hidden="true" />
          </button>
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

        {resource.loading && !resource.data ? (
          <div
            aria-label="Loading access settings"
            className="settings-loading"
            role="status"
          >
            <span aria-hidden="true" className="loader" />
          </div>
        ) : resource.data ? (
          <div className="settings-access-groups">
            <AccessGroup
              blockedRemovals={Object.fromEntries(
                Object.entries(resource.heldSlots).map(([principal, slots]) => [
                  principal,
                  `Transfer its private-key slots first: ${slots.join(", ")}`,
                ]),
              )}
              busy={operation !== null}
              description="Alternative identities and trusted CLI tools."
              error={authorizedError}
              icon={<IoTerminalOutline aria-hidden="true" />}
              input={authorizedInput}
              inputRef={authorizedInputRef}
              kind="authorized"
              onAdd={(event) => {
                event.preventDefault();
                void addPrincipal("authorized", authorizedInput);
              }}
              onInput={(value) => {
                setAuthorizedInput(value);
                setAuthorizedError(null);
              }}
              onRemove={(principal, trigger) => {
                removalFocusTarget.current = trigger;
                setPendingRemoval({ kind: "authorized", principal });
              }}
              principals={resource.data.authorized_principals}
              currentPrincipal={currentPrincipal}
              protectedPrincipal={currentPrincipal}
              protectedTitle="The signed-in principal cannot remove itself"
              title="Authorized principals"
            />

            <AccessGroup
              busy={operation !== null || !selfController}
              description="Equal platform control: replace Wasm, change settings, stop, or delete the canister."
              error={controllerError}
              guidance={
                <>
                  <strong>Self-Controller:</strong> Neutron&apos;s own canister
                  principal performs checked in-product upgrades and cannot be
                  removed here. Add an external principal you control for
                  independent platform management.
                </>
              }
              icon={<IoShieldCheckmarkOutline aria-hidden="true" />}
              input={controllerInput}
              inputRef={controllerInputRef}
              kind="controller"
              limit={resource.data.controller_limit}
              onAdd={(event) => {
                event.preventDefault();
                void addPrincipal("controller", controllerInput);
              }}
              onInput={(value) => {
                setControllerInput(value);
                setControllerError(null);
              }}
              onRemove={(principal, trigger) => {
                removalFocusTarget.current = trigger;
                setPendingRemoval({ kind: "controller", principal });
              }}
              principals={resource.data.controllers}
              protectedLabel="Self-Controller"
              protectedPrincipal={resource.data.self_principal}
              protectedTitle="Neutron must remain a controller of itself"
              title="Controllers"
            />
            {!selfController ? (
              <div className="settings-access-notice" role="alert">
                Neutron is not a controller of itself. Controller changes are
                unavailable until an existing controller restores it.
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsDisclosure>

      {pendingControllerAddition ? (
        <ControllerAdditionDialog
          onCancel={cancelControllerAddition}
          onConfirm={() => {
            const principal = pendingControllerAddition;
            setPendingControllerAddition(null);
            void addPrincipal("controller", principal, true);
          }}
          principal={pendingControllerAddition}
        />
      ) : null}

      {pendingRemoval ? (
        <RemovalDialog
          onCancel={cancelRemoval}
          onConfirm={() => void removePrincipal(pendingRemoval)}
          removal={pendingRemoval}
        />
      ) : null}
    </>
  );
}

export function AccessGroup({
  blockedRemovals,
  busy,
  currentPrincipal,
  description,
  error,
  guidance,
  icon,
  input,
  inputRef,
  kind,
  limit,
  onAdd,
  onInput,
  onRemove,
  principals,
  protectedLabel,
  protectedPrincipal,
  protectedTitle,
  title,
}: {
  blockedRemovals?: Record<string, string>;
  busy: boolean;
  currentPrincipal?: string;
  description: string;
  error: string | null;
  guidance?: ReactNode;
  icon: ReactNode;
  input: string;
  inputRef: RefObject<HTMLInputElement | null>;
  kind: AccessKind;
  limit?: bigint;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
  onInput: (value: string) => void;
  onRemove: (principal: string, trigger: HTMLButtonElement) => void;
  principals: string[];
  protectedLabel?: string;
  protectedPrincipal: string;
  protectedTitle: string;
  title: string;
}) {
  const atLimit = limit !== undefined && BigInt(principals.length) >= limit;
  return (
    <section className="settings-access-group">
      <div className="settings-access-group-heading">
        <span className="settings-access-group-icon">{icon}</span>
        <span>
          <h3>{title}</h3>
          <p>{description}</p>
        </span>
        <code>
          {principals.length}
          {limit === undefined ? "" : `/${limit.toString()}`}
        </code>
      </div>

      {guidance ? (
        <div className="settings-access-guidance">{guidance}</div>
      ) : null}

      <div className="settings-principal-list" role="list">
        {principals.map((principal) => {
          const removalBlock = blockedRemovals?.[principal];
          const isProtected =
            principal === protectedPrincipal ||
            principal === currentPrincipal ||
            Boolean(removalBlock);
          const protectionTitle = removalBlock ?? protectedTitle;
          return (
            <div
              className="settings-principal-row"
              data-principal={principal}
              data-tid={`settings-${kind}-${principal}`}
              key={principal}
              role="listitem"
            >
              <span className="settings-principal-identity">
                <code title={principal}>{principal}</code>
                {principal === currentPrincipal ? (
                  <span className="settings-principal-current">(current)</span>
                ) : null}
                {principal === protectedPrincipal && protectedLabel ? (
                  <span className="settings-principal-role">
                    ({protectedLabel})
                  </span>
                ) : null}
              </span>
              <div className="settings-principal-actions">
                {isProtected ? (
                  <span
                    aria-label={protectionTitle}
                    className="settings-principal-lock"
                    role="img"
                    title={protectionTitle}
                  >
                    <IoLockClosedOutline aria-hidden="true" />
                  </span>
                ) : null}
                <CopyButton label={`Copy ${title.toLowerCase()} principal`} value={principal} />
                {!isProtected ? (
                  <button
                    aria-label={`Remove ${principal}`}
                    className="icon-button settings-principal-remove"
                    disabled={busy}
                    onClick={(event) =>
                      onRemove(principal, event.currentTarget)
                    }
                    title={`Remove ${kind}`}
                    type="button"
                  >
                    <IoTrashOutline aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <form className="settings-principal-form" onSubmit={onAdd}>
        <input
          aria-label={`Add ${kind} principal`}
          autoCapitalize="none"
          autoComplete="off"
          disabled={busy || atLimit}
          onChange={(event) => onInput(event.target.value)}
          placeholder="Principal"
          ref={inputRef}
          spellCheck={false}
          type="text"
          value={input}
        />
        <button
          aria-label={`Add ${kind}`}
          className="icon-button settings-principal-add"
          disabled={busy || atLimit || input.trim().length === 0}
          title={atLimit ? "Controller limit reached" : `Add ${kind}`}
          type="submit"
        >
          <IoAdd aria-hidden="true" />
        </button>
      </form>
      {error ? (
        <div className="settings-field-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

export function ControllerAdditionDialog({
  onCancel,
  onConfirm,
  principal,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  principal: string;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <>
      <div aria-hidden="true" className="backdrop" onClick={onCancel} />
      <div
        aria-describedby="access-controller-add-description"
        aria-labelledby="access-controller-add-title"
        aria-modal="true"
        className="dialog dialog-danger access-controller-dialog"
        data-tid="settings-access-controller-add-dialog"
        onKeyDown={(event) =>
          confirmationKeyDown(event, dialogRef.current, onCancel)
        }
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id="access-controller-add-title">
          Add controller
        </div>
        <div className="call">
          <code className="access-remove-principal">{principal}</code>
          <div
            className="uninstall-warning"
            id="access-controller-add-description"
          >
            This principal will become an equal IC controller. It can replace
            all installed Wasm, change canister settings, stop or delete the
            canister, and remove your authority. Kernel permissions cannot
            restrict an IC controller. Add it only if you control or trust it.
          </div>
          <div className="btn-actions uninstall-actions">
            <button
              className="btn btn-sec"
              data-tid="settings-access-controller-add-cancel"
              onClick={onCancel}
              ref={cancelRef}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-danger"
              data-tid="settings-access-controller-add-confirm"
              onClick={onConfirm}
              type="button"
            >
              <IoAdd aria-hidden="true" />
              Add controller
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function RemovalDialog({
  onCancel,
  onConfirm,
  removal,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  removal: PendingRemoval;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const label = removal.kind === "controller" ? "controller" : "authorized principal";

  useEffect(() => cancelRef.current?.focus(), []);

  return (
    <>
      <div aria-hidden="true" className="backdrop" onClick={onCancel} />
      <div
        aria-describedby="access-remove-description"
        aria-labelledby="access-remove-title"
        aria-modal="true"
        className="dialog dialog-danger access-remove-dialog"
        data-tid="settings-access-remove-dialog"
        onKeyDown={(event) =>
          confirmationKeyDown(event, dialogRef.current, onCancel)
        }
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id="access-remove-title">
          Remove {label}
        </div>
        <div className="call">
          <code className="access-remove-principal">{removal.principal}</code>
          <div className="uninstall-warning" id="access-remove-description">
            {removal.kind === "controller"
              ? "This principal will lose platform control. Its Neutron authorization is unchanged."
              : "This principal will lose Neutron access. Its controller status is unchanged."}
          </div>
          <div className="btn-actions uninstall-actions">
            <button
              className="btn btn-sec"
              onClick={onCancel}
              ref={cancelRef}
              type="button"
            >
              Cancel
            </button>
            <button className="btn btn-danger" onClick={onConfirm} type="button">
              <IoTrashOutline aria-hidden="true" />
              Remove
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function confirmationKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  dialog: HTMLElement | null,
  onCancel: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
    return;
  }
  if (event.key !== "Tab" || !dialog) return;
  const controls = dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (!controls.length) return;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
