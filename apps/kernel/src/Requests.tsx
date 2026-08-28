import icblast from "icblast";
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  callApprove,
  callReject,
  useRequestStore,
  type PendingCallRequest,
} from "./reducer/request.ts";
import {
  approveFrontendToolRequest,
  rejectFrontendToolRequest,
  useMsgBusPermissionStore,
  type PendingFrontendToolRequest,
} from "./reducer/msg_bus.ts";
import { frameRequestLabel } from "./request_label.ts";
import {
  approveBackendCallRequest,
  rejectBackendCallRequest,
  useBackendCallConsentStore,
  type BackendCallReservationAction,
  type BackendCallScope,
  type PendingBackendCallRequest,
} from "./reducer/backend_calls.ts";
import type { JsonValue } from "neutron-tools/protocol";
import type { AppRegistryEntry } from "neutron-compiler/src/install.js";
import { useAppsStore } from "./reducer/apps.ts";
import {
  pauseAppAttention,
  pauseAppAttentionForSession,
} from "./ui_attention/owner.ts";
import { declaredCapability } from "./capabilities/plan.ts";
import {
  ConsentNotice,
  ConsentTechnicalDetails,
  focusConsentControl,
  useConsentUiMode,
} from "./consent/ConsentPresentation.tsx";
import type { KernelUiMode } from "./ui_mode.ts";
import { formatCycles } from "./settings/format.ts";
import { getNeutronId } from "./config.ts";

const { toState } = icblast as unknown as {
  toState(value: unknown): unknown;
};

function ToAddress({ address }: { address: string }) {
  return (
    <>
      <div className="label">Destination</div>
      <div className="val principal">{address}</div>
    </>
  );
}

export function Requests() {
  const uiMode = useConsentUiMode();
  const apps = useAppsStore((state) => state.list);
  const calls = useRequestStore((state) => state.calls);
  const toolRequests = useMsgBusPermissionStore((state) => state.requests);
  const backendRequests = useBackendCallConsentStore((state) => state.requests);
  const callDialogRef = useRef<HTMLDivElement>(null);
  const callRejectRef = useRef<HTMLButtonElement>(null);
  const backendId = Object.keys(backendRequests)[0];
  const toolCid = Object.keys(toolRequests)[0];
  const cid = Object.keys(calls)[0];

  useEffect(() => {
    if (backendId || toolCid || !cid) return;
    focusConsentControl(callRejectRef.current);
  }, [backendId, cid, toolCid]);

  if (backendId) {
    const request = backendRequests[Number(backendId)];
    if (request) return <BackendCallRequest request={request} uiMode={uiMode} />;
  }
  if (toolCid) {
    const request = toolRequests[Number(toolCid)];
    if (request) return <FrontendToolRequest request={request} uiMode={uiMode} />;
  }
  if (!cid) return null;
  const call = calls[Number(cid)] as PendingCallRequest | undefined;
  if (!call) return null;
  const call_args = toState(call.args) as JsonValue;
  const appName = apps[call.frame.appId]?.name ?? call.frame.appId;
  const callTarget =
    call.canister === getNeutronId() ? "this Neutron" : "another canister";
  const action =
    call.mode === "query"
      ? "read data"
      : call.mode === "update"
        ? "make a change"
        : "perform a canister action";

  return (
    <>
      <div
        className="backdrop"
        onClick={() => callReject({ cid })}
      ></div>
      <div
        aria-describedby={`call-summary-${cid}`}
        aria-labelledby={`call-title-${cid}`}
        aria-modal="true"
        className={`dialog ${call.mode === "query" ? "dialog-warning" : "dialog-danger"}`}
        data-tid="call-dialog"
        onKeyDown={(event) => {
          if (dismissOnEscape(event, () => callReject({ cid }))) return;
          trapDialogFocus(event, callDialogRef.current);
        }}
        ref={callDialogRef}
        role="alertdialog"
      >
        <div className="title" id={`call-title-${cid}`}>
          Allow {appName} to {action}?
        </div>

        {
          <div key={cid} className="call">
            <ConsentNotice
              tone={call.mode === "query" ? "warning" : "danger"}
            >
              <span id={`call-summary-${cid}`}>
                <strong>{appName}</strong> wants to use your Neutron identity to{" "}
                {action} on {callTarget}. Neutron verifies the exact method and{" "}
                {call.canonicalArgs === false
                  ? "shows the legacy JSON values before ICBlast conversion"
                  : "values"}
                , but cannot verify what this app-defined operation means.
              </span>
            </ConsentNotice>
            <ConsentTechnicalDetails mode={uiMode}>
              <div className="a-infogrid">
                <div className="label">Requesting app surface</div>
                <div className="val">{frameRequestLabel(call.frame)}</div>

                <ToAddress address={call.canister} />

                <div className="label">Operation</div>
                <div className="val">
                  <CandidMethodName method={call.method} />
                </div>
              </div>
              <div className="a-args">
                <CanonicalJsonReview
                  ariaLabel="Canonical JSON for the complete canister call arguments"
                  heading="Complete canister call arguments"
                  value={call_args}
                />
              </div>
              {call.binaryFields && call.binaryFields.length > 0 ? (
                <BinaryFieldInspectionList fields={call.binaryFields} />
              ) : null}
            </ConsentTechnicalDetails>
            <div className="btn-actions">
              <PauseRequests
                appId={call.frame.appId}
                onPause={() => callReject({ cid })}
              />
              <button
                type="button"
                className={`btn ${call.mode === "query" ? "btn-warning" : "btn-danger"}`}
                data-tid="call-approve"
                onClick={() => callApprove({ cid })}
              >
                {call.mode === "query"
                  ? "Allow read"
                  : call.mode === "update"
                    ? "Allow change"
                    : "Approve call"}
              </button>
              <button
                type="button"
                className="btn btn-sec"
                data-tid="call-reject"
                onClick={() => callReject({ cid })}
                ref={callRejectRef}
              >
                Reject
              </button>
            </div>
          </div>
        }
      </div>
    </>
  );
}

export function BinaryFieldInspectionList({
  fields,
}: {
  fields: readonly {
    path: string;
    byteLength: number;
    sha256: string;
  }[];
}) {
  return (
    <div
      aria-label="Binary field inspection"
      className="a-args binary-field-inspection"
    >
      <strong>Binary fields</strong>
      <p>
        The bytes stay hidden. Verify their exact Candid path, size, and
        SHA-256 digest.
      </p>
      <dl>
        {fields.map((field, index) => (
          <div key={`${field.path}:${index}`}>
            <dt>{field.path}</dt>
            <dd>
              <span>{formatExactByteLength(field.byteLength)}</span>
              <code>{field.sha256}</code>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatExactByteLength(byteLength: number): string {
  return `${byteLength.toLocaleString("en-US")} ${
    byteLength === 1 ? "byte" : "bytes"
  }`;
}

export function BackendCallRequest({
  request,
  uiMode: uiModeOverride,
}: {
  request: PendingBackendCallRequest;
  uiMode?: KernelUiMode;
}) {
  const uiMode = useConsentUiMode(uiModeOverride);
  const appName = useAppsStore(
    (state) => state.list[request.appId]?.name ?? request.appId,
  );
  const rejectRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const additions = request.actions.filter((action) => action.kind === "reserve");
  const broad = additions.some((action) => action.scope.kind !== "exact");
  const titleId = `backend-call-title-${request.id}`;
  const warningId = `backend-call-warning-${request.id}`;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    focusConsentControl(rejectRef.current);
    return () => previousFocus?.focus();
  }, [request.id]);

  return (
    <>
      <div
        className="backdrop"
        onClick={() => rejectBackendCallRequest(request.id)}
      />
      <div
        aria-describedby={warningId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`dialog ${broad ? "dialog-danger" : "dialog-warning"}`}
        data-tid="backend-call-dialog"
        onKeyDown={(event) => {
          if (
            dismissOnEscape(event, () =>
              rejectBackendCallRequest(request.id),
            )
          ) {
            return;
          }
          trapDialogFocus(event, dialogRef.current);
        }}
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id={titleId}>
          Allow {appName} backend access?
        </div>
        <div className="call">
          <BackendAccessDecisionSummary
            appName={appName}
            id={warningId}
            request={request}
          />
          <ConsentTechnicalDetails mode={uiMode}>
          <div className="a-infogrid">
            <div className="label">App id</div>
            <div className="val instance-id">{request.appId}</div>
            <div className="label">Requesting surface</div>
            <div className="val">
              {request.source.role === "tile" ? "Tile" : "Background process"}
            </div>
            {request.source.role === "tile" ? (
              <>
                <div className="label">Tile id</div>
                <div className="val instance-id">{request.source.tileId}</div>
                <div className="label">Tile instance</div>
                <div className="val instance-id">
                  {request.source.instanceId}
                </div>
                <div className="label">Workspace</div>
                <div className="val">{request.source.workspace}</div>
              </>
            ) : null}
            <div className="label">Kernel endpoint</div>
            <div className="val instance-id">{request.endpoint}</div>
            <div className="label">Changes</div>
            <div className="val">{request.actions.length}</div>
            {request.call ? (
              <>
                <div className="label">Then run</div>
                <div className="val">{request.call.method}</div>
              </>
            ) : null}
          </div>
          {request.actions.length > 0 ? (
            <div className="a-args backend-access-actions">
              {request.actions.map((action, index) => (
                <BackendAccessAction
                  action={action}
                  key={`${scopeKey(action.scope)}:${index}`}
                />
              ))}
            </div>
          ) : null}
          {request.call ? (
            <>
              <div className="a-args">
                <CanonicalJsonReview
                  ariaLabel="Canonical JSON for the complete attached-call arguments"
                  heading="Complete attached-call arguments"
                  value={request.call.args}
                />
              </div>
              {request.call.binaryFields &&
              request.call.binaryFields.length > 0 ? (
                <BinaryFieldInspectionList
                  fields={request.call.binaryFields}
                />
              ) : null}
            </>
          ) : null}
          <div className="uninstall-warning">
            {backendAccessWarning(request.actions)} Method names are
            app-selected identifiers; the kernel does not attest their
            behavior.
          </div>
          </ConsentTechnicalDetails>
          <div className="btn-actions">
            <PauseRequests
              appId={request.appId}
              onPause={() => rejectBackendCallRequest(request.id)}
            />
            <button
              className={broad ? "btn btn-danger" : "btn btn-warning"}
              data-tid="backend-call-approve"
              onClick={() => approveBackendCallRequest(request.id)}
              type="button"
            >
              {additions.length > 0
                ? "Grant access"
                : request.actions.length > 0
                  ? "Remove access"
                  : "Run action"}
            </button>
            <button
              className="btn btn-sec"
              data-tid="backend-call-reject"
              onClick={() => rejectBackendCallRequest(request.id)}
              ref={rejectRef}
              type="button"
            >
              Reject
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function BackendAccessDecisionSummary({
  appName,
  id,
  request,
}: {
  appName: string;
  id: string;
  request: PendingBackendCallRequest;
}) {
  const additions = request.actions.filter(({ kind }) => kind === "reserve");
  const removals = request.actions.filter(({ kind }) => kind === "release");
  const broad = additions.some(({ scope }) => scope.kind !== "exact");
  return (
    <div id={id}>
      <ConsentNotice tone={broad ? "danger" : additions.length ? "warning" : "neutral"}>
        <strong>{appName}</strong>{" "}
        {additions.length > 0
          ? `is asking for ${countWithNoun(additions.length, "persistent backend permission")}.`
          : removals.length > 0
            ? `is asking to remove ${countWithNoun(removals.length, "backend permission")}.`
            : "is asking to run one already-disclosed backend action."}
        {additions.length > 0
          ? " Added access remains available for repeated future calls with app-chosen values until it is revoked, becomes incompatible, or the app is removed."
          : ""}
      </ConsentNotice>
      {request.actions.length > 0 ? (
        <ul className="consent-backend-access-list">
          {request.actions.map((action, index) => (
            <li key={`${scopeKey(action.scope)}:${index}`}>
              <strong>{action.kind === "reserve" ? "Allow" : "Remove"}</strong>
              <span>{friendlyScopeDescription(action.scope)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {request.limits ? (
        <div className="consent-backend-limits">
          <span>
            Up to <strong>{request.limits.maxConcurrency}</strong> calls at once
          </span>
          <span>
            {request.limits.maxCyclesPerCall > 0 ? (
              <>
                Up to{" "}
                <strong>{formatCycles(request.limits.maxCyclesPerCall)}</strong>{" "}
                transferred per call and{" "}
                <strong>{formatCycles(request.limits.maxCyclesPerDay)}</strong>{" "}
                per UTC day
              </>
            ) : (
              "Cannot transfer cycles with these calls"
            )}
          </span>
        </div>
      ) : null}
      {request.call ? (
        <ConsentNotice tone="warning">
          After changing access, the app will immediately run one of its own
          backend actions. Neutron verifies the exact action and values but
          cannot attest the app-defined meaning.
        </ConsentNotice>
      ) : null}
      {removals.some(({ scope }) => scope.kind !== "exact") ? (
        <ConsentNotice tone="warning">
          Removing broad access can make a previously approved narrower
          permission active again.
        </ConsentNotice>
      ) : null}
    </div>
  );
}

function friendlyScopeDescription(scope: BackendCallScope): ReactNode {
  if (scope.kind === "principal") {
    return (
      <>
        Every current and future method on canister{" "}
        <code>{scope.principal}</code>
      </>
    );
  }
  if (scope.kind === "method") {
    return (
      <>
        Method <code>{scope.method}</code> on any eligible non-system canister
      </>
    );
  }
  return (
    <>
      Method <code>{scope.method}</code> on canister{" "}
      <code>{scope.principal}</code>
    </>
  );
}

function countWithNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function BackendAccessAction({
  action,
}: {
  action: BackendCallReservationAction;
}) {
  return (
    <div className="backend-access-action">
      <span className={`backend-access-action-kind is-${action.kind}`}>
        {action.kind === "reserve" ? "Add" : "Remove"}
      </span>
      <span className="backend-access-action-detail">
        <strong>{scopeLabel(action.scope)}</strong>
        <code>{scopeTarget(action.scope)}</code>
        {action.reservationPresentAtRequest !== undefined ? (
          <code>{reservationStateLabel(action)}</code>
        ) : null}
      </span>
    </div>
  );
}

function scopeLabel(scope: BackendCallScope): string {
  if (scope.kind === "principal") return "Entire canister";
  if (scope.kind === "method") return "Method except reserved canisters";
  return "One canister method";
}

function scopeTarget(scope: BackendCallScope): string {
  if (scope.kind === "principal") return scope.principal ?? "";
  if (scope.kind === "method") return scope.method ?? "";
  return `${scope.principal ?? ""} / ${scope.method ?? ""}`;
}

function scopeKey(scope: BackendCallScope): string {
  return `${scope.kind}:${scope.principal ?? ""}:${scope.method ?? ""}`;
}

function reservationStateLabel(action: BackendCallReservationAction): string {
  if (action.reservationPresentAtRequest) {
    return action.kind === "reserve"
      ? "Equivalent reservation already stored at request time"
      : "Equivalent reservation stored at request time";
  }
  return action.kind === "reserve"
    ? "Equivalent reservation not stored at request time"
    : "Equivalent reservation already absent at request time";
}

function backendAccessWarning(actions: BackendCallReservationAction[]): string {
  if (actions.length === 0) {
    return "No backend permissions will change. Only the fully disclosed attached operation will run after approval.";
  }
  const additions = actions.filter((action) => action.kind === "reserve");
  if (additions.some((action) => action.scope.kind === "method")) {
    return "Added method ownership applies to eligible non-system canisters unless another app owns the whole target canister. It takes priority over exact grants and persists until removed, incompatible, or uninstalled. Removing higher-priority ownership can reactivate a previously approved lower tier. Repeated matching calls may use future app-chosen arguments.";
  }
  if (additions.some((action) => action.scope.kind === "principal")) {
    return "Added whole-canister ownership takes priority over method-wide and exact grants for every current and future method. It persists until removed, incompatible, or uninstalled. Removing it can reactivate previously approved lower-tier ownership. Repeated calls may use future app-chosen arguments.";
  }
  if (additions.length > 0) {
    return "Added exact ownership applies only when no whole-canister or method-wide owner has priority. It persists until removed, incompatible, or uninstalled and may become effective later when a higher tier is removed. Matching calls may use future app-chosen arguments.";
  }
  return "The listed backend ownership will be removed immediately. Removing a higher tier can reactivate previously approved lower-tier ownership. Each status above reflects the authoritative stored snapshot taken when this request opened.";
}

const AMBIGUOUS_JSON_TEXT_PATTERN =
  /[\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;

/**
 * Render retained JSON without changing the value that will be executed.
 * Strings and object keys are quoted, JSON controls are escaped, and Unicode
 * formatting/default-ignorable characters are emitted as visible escapes so
 * they cannot reorder or disappear inside a trusted consent dialog.
 */
export function canonicalJsonForDisplay(value: JsonValue): string {
  return serializeCanonicalJson(value, 0);
}

export function CandidMethodName({ method }: { method: string }) {
  return <code>{canonicalJsonForDisplay(method)}</code>;
}

export function CanonicalJsonReview({
  ariaLabel,
  heading,
  value,
}: {
  ariaLabel: string;
  heading: string;
  value: JsonValue;
}) {
  return (
    <>
      <strong>{heading}</strong>
      <pre aria-label={ariaLabel} className="backend-call-canonical-json">
        {canonicalJsonForDisplay(value)}
      </pre>
    </>
  );
}

function serializeCanonicalJson(value: JsonValue, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return quoteJsonForDisplay(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    return JSON.stringify(value);
  }

  const currentIndent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value
      .map(
        (entry) =>
          `${childIndent}${serializeCanonicalJson(entry, depth + 1)}`,
      )
      .join(",\n")}\n${currentIndent}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(
      ([key, entry]) =>
        `${childIndent}${quoteJsonForDisplay(key)}: ${serializeCanonicalJson(
          entry,
          depth + 1,
        )}`,
    )
    .join(",\n")}\n${currentIndent}}`;
}

function quoteJsonForDisplay(value: string): string {
  let result = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    switch (character) {
      case '"':
        result += '\\"';
        break;
      case "\\":
        result += "\\\\";
        break;
      case "\b":
        result += "\\b";
        break;
      case "\f":
        result += "\\f";
        break;
      case "\n":
        result += "\\n";
        break;
      case "\r":
        result += "\\r";
        break;
      case "\t":
        result += "\\t";
        break;
      default:
        result +=
          codePoint < 0x20 ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
          AMBIGUOUS_JSON_TEXT_PATTERN.test(character)
            ? jsonUnicodeEscape(codePoint)
            : character;
    }
  }
  return `${result}"`;
}

function jsonUnicodeEscape(codePoint: number): string {
  if (codePoint <= 0xffff) {
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  const scalar = codePoint - 0x10000;
  const high = 0xd800 + (scalar >> 10);
  const low = 0xdc00 + (scalar & 0x3ff);
  return `\\u${high.toString(16).padStart(4, "0")}\\u${low
    .toString(16)
    .padStart(4, "0")}`;
}

function FrontendToolRequest({
  request,
  uiMode,
}: {
  request: PendingFrontendToolRequest;
  uiMode: KernelUiMode;
}) {
  const apps = useAppsStore((state) => state.list);
  const dialogRef = useRef<HTMLDivElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    focusConsentControl(rejectRef.current);
  }, [request.cid]);
  if (request.tool === "workspace.open_tile") {
    return <WorkspaceTileRequest request={request} uiMode={uiMode} />;
  }
  if (
    request.target === "kernel" &&
    request.tool.startsWith("vetkeys.")
  ) {
    return <VetKeysLifecycleRequest request={request} uiMode={uiMode} />;
  }
  const callerName =
    apps[request.caller.appId]?.name ?? request.caller.appId;
  const targetAppId = appIdFromEndpoint(request.target);
  const targetName =
    request.target === "kernel"
      ? "Neutron"
      : targetAppId
        ? apps[targetAppId]?.name ?? targetAppId
        : "another app";
  const toolTitle =
    request.tool === "*"
      ? "all available tools"
      : request.toolTitle ?? request.tool.replaceAll(/[._/-]+/gu, " ");
  const titleId = `frontend-tool-title-${request.cid}`;
  const summaryId = `frontend-tool-summary-${request.cid}`;
  return (
    <>
      <div
        className="backdrop"
        onClick={() => rejectFrontendToolRequest(request.cid)}
      />
      <div
        aria-describedby={summaryId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="dialog dialog-warning"
        data-tid="frontend-tool-dialog"
        onKeyDown={(event) => {
          if (
            dismissOnEscape(event, () =>
              rejectFrontendToolRequest(request.cid),
            )
          ) {
            return;
          }
          trapDialogFocus(event, dialogRef.current);
        }}
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id={titleId}>
          Allow {callerName} to use {targetName}?
        </div>
        <div className="call">
          <ConsentNotice tone="warning">
            <span id={summaryId}>
              <strong>{callerName}</strong> wants to run{" "}
              <strong>{toolTitle}</strong> in {targetName}.
              {request.tool === "*" ? (
                " Allowing this inspection once only lists the available tools; it does not run one."
              ) : request.toolDescription ? (
                <>
                  {" "}
                  The target app describes it as: “{request.toolDescription}”
                  (unverified).
                </>
              ) : (
                " Neutron cannot verify what this app-defined tool means."
              )}
            </span>
          </ConsentNotice>
          {!request.onceOnly ? (
            <ConsentNotice
              tone={request.sessionOnly ? "danger" : "warning"}
            >
              <strong>Session access can be reused.</strong> It lets this exact
              app surface{" "}
              {request.tool === "*"
                ? "use any tool exposed by the target app"
                : "repeat this tool"}{" "}
              until either app reconnects or this browser session ends. “Allow
              once” authorizes only this request.
            </ConsentNotice>
          ) : null}
          <ConsentTechnicalDetails mode={uiMode}>
          <div className="a-infogrid">
            <div className="label">Requesting app</div>
            <div className="val">
              {request.caller.appId}/{request.caller.role}
            </div>
            <div className="label">Target</div>
            <div className="val principal">{request.target}</div>
            <div className="label">Tool</div>
            <div className="val">{request.tool}</div>
            {request.attachmentBytes ? (
              <>
                <div className="label">Binary input</div>
                <div className="val">
                  {formatByteCount(request.attachmentBytes.input)}
                </div>
                <div className="label">Maximum binary output</div>
                <div className="val">
                  {formatByteCount(request.attachmentBytes.maximumOutput)}
                </div>
              </>
            ) : null}
          </div>
          <div className="a-args">
            <Args args={request.arguments} />
          </div>
          </ConsentTechnicalDetails>
          <div className="btn-actions">
            <PauseRequests
              appId={request.caller.appId}
              onPause={() => rejectFrontendToolRequest(request.cid)}
            />
            {!request.sessionOnly ? (
              <button
                type="button"
                className="btn btn-warning"
                data-tid="frontend-tool-approve-once"
                onClick={() => approveFrontendToolRequest(request.cid, "once")}
              >
                Allow once
              </button>
            ) : null}
            {!request.onceOnly ? (
              <button
                type="button"
                className="btn btn-warning"
                data-tid="frontend-tool-approve-session"
                onClick={() => approveFrontendToolRequest(request.cid, "session")}
              >
                Allow session
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sec"
              data-tid="frontend-tool-reject"
              onClick={() => rejectFrontendToolRequest(request.cid)}
              ref={rejectRef}
            >
              Reject
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function VetKeysLifecycleRequest({
  request,
  uiMode,
}: {
  request: PendingFrontendToolRequest;
  uiMode: KernelUiMode;
}) {
  const app = useAppsStore((state) => state.list[request.caller.appId]);
  return (
    <VetKeysLifecycleDialog app={app} request={request} uiMode={uiMode} />
  );
}

export function VetKeysLifecycleDialog({
  app,
  request,
  uiMode: uiModeOverride,
}: {
  app: AppRegistryEntry | undefined;
  request: PendingFrontendToolRequest;
  uiMode?: KernelUiMode;
}) {
  const uiMode = useConsentUiMode(uiModeOverride);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const action = String(request.arguments.action ?? "");
  const slot = String(request.arguments.slot ?? "");
  const declaration = declaredCapability(app, "vetkeys")?.slots.find(
    (candidate) => candidate.id === slot,
  );
  const destructive = action === "retireGeneration" || action === "retireSlot";
  const critical = destructive || action === "transfer" || action === "rotate";
  const title = vetKeysActionTitle(action);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    focusConsentControl(rejectRef.current);
    return () => previousFocus?.focus();
  }, [request.cid]);

  return (
    <>
      <div
        className="backdrop"
        onClick={() => rejectFrontendToolRequest(request.cid)}
      />
      <div
        aria-describedby={`vetkeys-warning-${request.cid}`}
        aria-labelledby={`vetkeys-title-${request.cid}`}
        aria-modal="true"
        className={`dialog ${critical ? "dialog-danger" : "dialog-warning"}`}
        data-tid="vetkeys-lifecycle-dialog"
        onKeyDown={(event) => {
          if (
            dismissOnEscape(event, () =>
              rejectFrontendToolRequest(request.cid),
            )
          ) {
            return;
          }
          trapDialogFocus(event, dialogRef.current);
        }}
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id={`vetkeys-title-${request.cid}`}>
          {title}
        </div>
        <div className="call">
          <ConsentNotice tone={critical ? "danger" : "warning"}>
            <span id={`vetkeys-warning-${request.cid}`}>
              <strong>{app?.name ?? request.caller.appId}</strong>:{" "}
              {vetKeysActionWarning(action)}
              {request.arguments.newHolder !== undefined
                ? ` The new key manager is ${String(request.arguments.newHolder)}.`
                : ""}
            </span>
          </ConsentNotice>
          <ConsentTechnicalDetails mode={uiMode}>
          <div className="a-infogrid">
            <div className="label">App</div>
            <div className="val">
              {app?.name ?? request.caller.appId} ({request.caller.appId})
            </div>
            <div className="label">Private-key slot</div>
            <div className="val instance-id">{slot}</div>
            {declaration ? (
              <>
                <div className="label">App-provided purpose — unverified</div>
                <div className="val">{declaration.purpose}</div>
              </>
            ) : null}
            {request.arguments.generation !== undefined ? (
              <>
                <div className="label">Generation</div>
                <div className="val instance-id">
                  {String(request.arguments.generation)}
                </div>
              </>
            ) : null}
            {request.arguments.newHolder !== undefined ? (
              <>
                <div className="label">New key manager</div>
                <div className="val principal">
                  {String(request.arguments.newHolder)}
                </div>
              </>
            ) : null}
          </div>
          <p className="permission-copy">
            The key is threshold-derived and returned encrypted to the app&apos;s
            originating live browser endpoint; Neutron does not store the
            private key. Recovery spends canister cycles, compatible app
            updates inherit this slot, and every currently authorized Neutron
            principal may recover its retained generations.
          </p>
          </ConsentTechnicalDetails>
          <div className="btn-actions">
            <PauseRequests
              appId={request.caller.appId}
              onPause={() => rejectFrontendToolRequest(request.cid)}
            />
            <button
              className={`btn ${critical ? "btn-danger" : "btn-warning"}`}
              data-tid="vetkeys-lifecycle-approve"
              onClick={() => approveFrontendToolRequest(request.cid, "once")}
              type="button"
            >
              {destructive ? "Retire permanently" : "Approve"}
            </button>
            <button
              className="btn btn-sec"
              data-tid="vetkeys-lifecycle-reject"
              onClick={() => rejectFrontendToolRequest(request.cid)}
              ref={rejectRef}
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

function vetKeysActionTitle(action: string): string {
  switch (action) {
    case "reserve":
      return "Activate private-key slot";
    case "enable":
      return "Enable private-key recovery";
    case "disable":
      return "Disable private-key recovery";
    case "rotate":
      return "Rotate private-key generation";
    case "retireGeneration":
      return "Retire key generation";
    case "transfer":
      return "Transfer key manager";
    case "retireSlot":
      return "Retire private-key slot";
    default:
      return "Private-key request";
  }
}

function vetKeysActionWarning(action: string): string {
  switch (action) {
    case "reserve":
      return "This creates a fresh app-isolated namespace. The app can then recover this slot's private key on demand from its live tile or resident.";
    case "enable":
      return "Enabling restores supported recovery for the current app and retained generations.";
    case "disable":
      return "Disabling blocks future supported recovery. It cannot erase a key already copied into a browser.";
    case "rotate":
      return "Rotation creates a new current generation and retains the old generation temporarily. Finish the app's data migration before retiring the previous generation.";
    case "retireGeneration":
      return "Retirement permanently blocks supported future recovery for this generation. It cannot erase existing browser copies, and data still wrapped to it may become unreadable.";
    case "transfer":
      return "This moves lifecycle control only. It does not rotate key material or change which currently authorized Neutron principals can recover retained generations.";
    case "retireSlot":
      return "This permanently retires the installed app instance's slot. Reinstalling the app creates a different namespace and cannot recover this one.";
    default:
      return "Review this private-key lifecycle change carefully.";
  }
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${Number(mib.toFixed(2))} MiB`;
  return `${Number((bytes / 1024).toFixed(2))} KiB`;
}

function appIdFromEndpoint(endpoint: string): string | null {
  const match = /^app:([^:]+):/u.exec(endpoint);
  return match?.[1] ?? null;
}

function WorkspaceTileRequest({
  request,
  uiMode,
}: {
  request: PendingFrontendToolRequest;
  uiMode: KernelUiMode;
}) {
  const apps = useAppsStore((state) => state.list);
  const dialogRef = useRef<HTMLDivElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const targetAppId = String(request.arguments.appId ?? "");
  const targetTileId = String(request.arguments.tileId ?? "");
  const targetApp = apps[targetAppId];
  const targetTile = targetApp?.tiles.find((tile) => tile.id === targetTileId);
  const callerName = apps[request.caller.appId]?.name ?? request.caller.appId;
  const targetName = targetTile?.title ?? targetApp?.name ?? targetAppId;
  const view =
    typeof request.arguments.view === "string"
      ? request.arguments.view.replaceAll(/[_/-]+/gu, " ")
      : null;
  const titleId = `workspace-tile-title-${request.cid}`;
  const summaryId = `workspace-tile-summary-${request.cid}`;
  useEffect(() => {
    focusConsentControl(rejectRef.current);
  }, [request.cid]);

  return (
    <>
      <div
        className="backdrop"
        onClick={() => rejectFrontendToolRequest(request.cid)}
      />
      <div
        aria-describedby={summaryId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="dialog dialog-warning"
        data-tid="workspace-tile-dialog"
        onKeyDown={(event) => {
          if (
            dismissOnEscape(event, () =>
              rejectFrontendToolRequest(request.cid),
            )
          ) {
            return;
          }
          trapDialogFocus(event, dialogRef.current);
        }}
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id={titleId}>
          Open {targetName}?
        </div>
        <div className="call">
          <ConsentNotice tone="neutral">
            <span id={summaryId}>
              <strong>{callerName}</strong> wants to open one{" "}
              <strong>{targetName}</strong> tile in the current workspace. This
              does not grant backend access or permission to control the opened
              app.
            </span>
          </ConsentNotice>
          <ConsentTechnicalDetails mode={uiMode}>
          <div className="a-infogrid">
            <div className="label">Requested by</div>
            <div className="val">{callerName}</div>
            <div className="label">Application</div>
            <div className="val">
              {targetApp?.name ?? targetAppId} ({targetAppId})
            </div>
            <div className="label">Tile</div>
            <div className="val">{targetName}</div>
            {view ? (
              <>
                <div className="label">View</div>
                <div className="val">{view}</div>
              </>
            ) : null}
          </div>
          <div className="uninstall-warning">
            This opens one installed app tile. It does not grant backend or
            cross-app method access.
          </div>
          </ConsentTechnicalDetails>
          <div className="btn-actions">
            <PauseRequests
              appId={request.caller.appId}
              onPause={() => rejectFrontendToolRequest(request.cid)}
            />
            <button
              className="btn btn-warning"
              data-tid="workspace-tile-approve"
              onClick={() => approveFrontendToolRequest(request.cid, "once")}
              type="button"
            >
              Open
            </button>
            <button
              className="btn btn-sec"
              data-tid="workspace-tile-reject"
              onClick={() => rejectFrontendToolRequest(request.cid)}
              ref={rejectRef}
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

export function PauseRequests({
  appId,
  onPause,
}: {
  appId: string;
  onPause: () => void;
}) {
  return (
    <select
      aria-label="Pause requests from this app"
      className="dialog-pause-select"
      defaultValue=""
      onChange={(event) => {
        const value = event.target.value;
        onPause();
        if (value === "session") pauseAppAttentionForSession(appId);
        else pauseAppAttention(appId, Number(value));
      }}
    >
      <option disabled value="">Pause requests</option>
      <option value="120000">2 minutes</option>
      <option value="600000">10 minutes</option>
      <option value="session">This session</option>
    </select>
  );
}

function dismissOnEscape(
  event: ReactKeyboardEvent,
  dismiss: () => void,
): boolean {
  if (event.key !== "Escape") return false;
  event.preventDefault();
  event.stopPropagation();
  dismiss();
  return true;
}

function trapDialogFocus(
  event: ReactKeyboardEvent,
  dialog: HTMLElement | null,
): void {
  if (event.key !== "Tab" || !dialog) return;
  const controls = dialog.querySelectorAll<HTMLElement>(
    'summary, button:not([disabled]), select:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

function renderValue(value: unknown): ReactNode {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function Args({ label = null, args }: { label?: string | null; args: unknown }) {
  if (args === null) return <div>null</div>;
  if (args === undefined) return <div>undefined</div>;

  let nval: ReactNode = null;
  if (typeof args === "object") {
    if (Array.isArray(args)) {
      nval = (
        <div className="a-arr">
          {args.map((arg, idx) => (
            <Args key={idx} args={arg} />
          ))}
        </div>
      );
    } else {
      nval = (
        <div className="a-obj">
          {Object.keys(args as Record<string, unknown>).map((key, idx) => (
            <Args
              key={idx}
              label={key}
              args={(args as Record<string, unknown>)[key]}
            />
          ))}
        </div>
      );
    }
  }

  return label ? (
    <>
      <div className="a-label">{label}</div>
      <div className="a-val">{nval || renderValue(args)}</div>
    </>
  ) : (
    <div className="a-val">{nval || renderValue(args)}</div>
  );
}
