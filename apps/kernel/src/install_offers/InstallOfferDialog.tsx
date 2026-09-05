import { useEffect, useRef } from "react";
import {
  approveInstallOffer,
  rejectInstallOffer,
} from "./service.ts";
import { useInstallOfferStore } from "./store.ts";
import type {
  AttestedInstallOfferRequester,
  PendingInstallOffer,
} from "./types.ts";
import {
  ConsentNotice,
  ConsentTechnicalDetails,
  focusConsentControl,
  useConsentUiMode,
} from "../consent/ConsentPresentation.tsx";
import type { KernelUiMode } from "../ui_mode.ts";

export function InstallOfferDialog() {
  const pending = useInstallOfferStore((state) => state.pending);
  return <InstallOfferDialogView pending={pending} />;
}

export function InstallOfferDialogView({
  pending,
  uiMode: uiModeOverride,
}: {
  pending: PendingInstallOffer | null;
  uiMode?: KernelUiMode;
}) {
  const uiMode = useConsentUiMode(uiModeOverride);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pending) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    focusConsentControl(cancelRef.current);
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [pending?.requestId]);

  if (!pending) return null;
  const titleId = `install-offer-title-${pending.requestId}`;
  const noticeId = `install-offer-notice-${pending.requestId}`;
  const dismiss = () => rejectInstallOffer(pending.requestId);

  return (
    <>
      <div className="backdrop" onClick={dismiss} />
      <div
        aria-describedby={noticeId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`dialog install-offer-dialog${uiMode === "developer" ? " dialog-warning" : ""}`}
        data-tid="install-offer-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
            return;
          }
          trapDialogFocus(event, dialogRef.current);
        }}
        ref={dialogRef}
        role="alertdialog"
      >
        <div className="title" id={titleId}>
          {uiMode === "developer"
            ? "Review third-party software?"
            : pending.offer.kind === "package_url"
              ? "Review suggested app?"
              : "Review suggested apps?"}
        </div>
        <div className="call">
          <p>{offerIntroduction(pending, uiMode)}</p>
          {uiMode === "developer" ? (
            <>
              <ConsentNotice tone="warning">
                <span id={noticeId}>
                  <strong>Review does not install anything.</strong> It contacts{" "}
                  <span className="consent-source-host">
                    {safeInstallOfferUrl(pending.offer.url)}
                  </span>{" "}
                  to load the package or application group. You will get a separate
                  final review before installation.
                </span>
              </ConsentNotice>
              <ConsentNotice tone="neutral">
                {pending.offer.kind === "package_url"
                  ? "The download sends no browser credentials or referrer. The source and network can still observe request metadata."
                  : "Neutron anonymously queries the repository and verifies certified data. Gateways and the repository can still observe request metadata."}
              </ConsentNotice>
              <div className="repository-third-party">
                Third-party software — Neutron has not reviewed, hosted, sold, or
                endorsed it, and has not verified its publisher.
              </div>
            </>
          ) : (
            <>
              <ConsentNotice tone="neutral">
                <span id={noticeId}>
                  Load from{" "}
                  <span className="consent-source-host">
                    {pending.offer.kind === "package_url"
                      ? safeInstallOfferUrl(pending.offer.url)
                      : `repository ${pending.offer.reference.repo}`}
                  </span>
                  . You decide before installing.
                </span>
              </ConsentNotice>
              <p className="repository-third-party">
                The source can see your request. Publisher and app safety have
                not been verified.
              </p>
            </>
          )}
          <ConsentTechnicalDetails>
          <div className="a-infogrid">
            <RequesterFacts requester={pending.requester} />
            <div className="label">Offer</div>
            <div className="val">
              {pending.offer.kind === "package_url"
                ? "Application package"
                : "Application group"}
            </div>
            <div className="label">Source</div>
            <div className="val principal">
              {safeInstallOfferUrl(pending.offer.url)}
            </div>
            {pending.offer.kind === "repository_setup_url" ? (
              <>
                <div className="label">Repository canister</div>
                <div className="val principal">
                  {pending.offer.reference.repo}
                </div>
                <div className="label">Manifest</div>
                <div className="val instance-id">
                  {pending.offer.reference.manifest}
                </div>
                <div className="label">Pinned digest</div>
                <div className="val instance-id">
                  {pending.offer.reference.digest}
                </div>
              </>
            ) : null}
          </div>
          <div className="dialog-section">
            Neutron has not contacted this source yet. Review will contact it
            without installing anything. You will still see the normal package
            or application-group review before installation.
          </div>
          <div className="repository-notice">
            {pending.offer.kind === "package_url"
              ? "Review downloads the exact URL without browser credentials or a referrer. The host and network can still observe request metadata, including any query values, which are intentionally hidden from this dialog and audit."
              : "Review does not fetch the outer page. It anonymously queries the named repository canister and verifies certified data. Gateways and the provider can still observe request metadata and correlate a unique manifest or digest."}
          </div>
          </ConsentTechnicalDetails>
          <div className="btn-actions">
            <button
              className={uiMode === "developer" ? "btn btn-warning" : "btn"}
              data-tid="install-offer-approve"
              onClick={() => approveInstallOffer(pending.requestId)}
              type="button"
            >
              Review source
            </button>
            <button
              className="btn btn-sec"
              data-tid="install-offer-reject"
              onClick={dismiss}
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

function RequesterFacts({
  requester,
}: {
  requester: AttestedInstallOfferRequester;
}) {
  const offeredByName =
    requester.kind === "agent" ? requester.rootAppName : requester.appName;
  const offeredById =
    requester.kind === "agent" ? requester.rootAppId : requester.appId;
  return (
    <>
      <div className="label">Offered by</div>
      <div className="val">{offeredByName}</div>
      <div className="label">App id</div>
      <div className="val instance-id">{offeredById}</div>
      <div className="label">Request source</div>
      <div className="val">
        {requester.kind === "agent"
          ? "Agent tool"
          : surfaceLabel(requester.surface)}
      </div>
      {requester.kind === "agent" ? (
        <>
          <div className="label">Agent entrypoint</div>
          <div className="val instance-id">{requester.entrypoint}</div>
          <div className="label">Executing app</div>
          <div className="val">{requester.appName}</div>
          <div className="label">Executing app id</div>
          <div className="val instance-id">{requester.appId}</div>
          <div className="label">Scoped tool</div>
          <div className="val instance-id">{requester.tool}</div>
          <div className="label">Agent invocation</div>
          <div className="val instance-id">{requester.rootId}</div>
        </>
      ) : null}
    </>
  );
}

function offerIntroduction(
  pending: PendingInstallOffer,
  uiMode: KernelUiMode,
): string {
  const actor =
    pending.requester.kind === "agent"
      ? `An agent from ${pending.requester.rootAppName}`
      : pending.requester.appName;
  if (uiMode === "normal") {
    return `${actor} suggests ${pending.offer.kind === "package_url" ? "an app" : "a group of apps"}.`;
  }
  return pending.offer.kind === "package_url"
    ? `${actor} is offering an application package.`
    : `${actor} is offering a group of applications.`;
}

function surfaceLabel(
  surface: "tile" | "tray" | "background",
): string {
  if (surface === "tile") return "Application tile";
  if (surface === "tray") return "Application tray";
  return "Background process";
}

/**
 * Consent UI never emits credentials, query values, or fragments from an
 * offered URL. Repository identity from the fragment is rendered separately
 * from the already normalized reference.
 */
export function safeInstallOfferUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "Invalid source URL";
  }
}

function trapDialogFocus(
  event: React.KeyboardEvent<HTMLDivElement>,
  dialog: HTMLElement | null,
): void {
  if (event.key !== "Tab" || !dialog) return;
  const controls = dialog.querySelectorAll<HTMLElement>(
    'summary, button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
