import { KernelPolicyError } from "neutron-tools/protocol";
import {
  admitOwnerAttention,
  finishOwnerAttention,
} from "../ui_attention/owner.ts";
import { useInstallOfferStore } from "./store.ts";
import type {
  AttestedInstallOfferRequester,
  InstallOfferApproval,
  InstallOfferRequestHandle,
  InstallOfferRequestInput,
  NormalizedInstallOffer,
} from "./types.ts";

export const INSTALL_OFFER_TIMEOUT_MS = 60_000;

type PendingRuntime = {
  requestId: string;
  appId: string;
  attentionToken: string;
  assertCurrent: () => void | boolean;
  onApprove: (
    approval: InstallOfferApproval,
  ) => void | Promise<void>;
  resolve: (approval: InstallOfferApproval) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let runtime: PendingRuntime | null = null;

/**
 * Presents one Kernel-owned, pre-contact install offer. This function performs
 * no fetch and starts no install. A second request is rejected instead of
 * queued so a requester cannot stack surprise prompts.
 */
export function requestInstallOffer({
  offer,
  requester,
  assertCurrent,
  onApprove,
  timeoutMs = INSTALL_OFFER_TIMEOUT_MS,
}: InstallOfferRequestInput): InstallOfferRequestHandle {
  if (runtime || useInstallOfferStore.getState().pending) {
    throw new KernelPolicyError(
      "UI_BUSY",
      "Another install offer is already active",
    );
  }
  validateTrustedInput(offer, requester, timeoutMs);

  const requestId = randomId();
  const attentionToken = admitOwnerAttention(
    requester.appId,
    "install_offer",
  );
  const approval = freezeApproval(requestId, offer, requester);
  const expiresAt = Date.now() + timeoutMs;
  let resolve!: (value: InstallOfferApproval) => void;
  let reject!: (reason: Error) => void;
  const completion = new Promise<InstallOfferApproval>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  // A fire-and-forget app API may intentionally use only requestId. Mark the
  // rejection observed while preserving it for callers that await completion.
  void completion.catch(() => undefined);

  runtime = {
    requestId,
    appId: requester.appId,
    attentionToken,
    assertCurrent,
    onApprove,
    resolve,
    reject,
    timeout: setTimeout(() => {
      rejectActive(
        new KernelPolicyError(
          "REQUEST_EXPIRED",
          "The install offer expired",
        ),
      );
    }, timeoutMs),
  };
  useInstallOfferStore.setState({
    pending: Object.freeze({
      ...approval,
      expiresAt,
    }),
  });
  return { requestId, completion };
}

/**
 * Accepts the pre-contact prompt and hands ownership to the existing install
 * flow. The dialog and attention reservation are cleared before the callback,
 * so any network activity belongs to that next flow rather than this module.
 */
export function approveInstallOffer(requestId: string): void {
  const active = runtime;
  const pending = useInstallOfferStore.getState().pending;
  if (
    !active ||
    active.requestId !== requestId ||
    !pending ||
    pending.requestId !== requestId
  ) {
    return;
  }
  try {
    if (active.assertCurrent() === false) {
      throw staleRequesterError();
    }
  } catch (error) {
    rejectActive(
      error instanceof KernelPolicyError ? error : staleRequesterError(),
    );
    return;
  }

  const approval: InstallOfferApproval = Object.freeze({
    requestId: pending.requestId,
    offer: pending.offer,
    requester: pending.requester,
  });
  detachActive(active);
  void Promise.resolve()
    .then(() => active.onApprove(approval))
    .then(
      () => active.resolve(approval),
      (error: unknown) => active.reject(asError(error)),
    );
}

export function rejectInstallOffer(
  requestId: string,
  error: Error = new KernelPolicyError(
    "REQUEST_CANCELLED",
    "The install offer was dismissed",
  ),
): void {
  if (runtime?.requestId !== requestId) return;
  rejectActive(error);
}

/**
 * Re-checks the attested endpoint after registry, endpoint, or agent-root
 * changes. Returns true when no request exists or the active request is still
 * valid.
 */
export function reconcileInstallOffer(): boolean {
  const active = runtime;
  if (!active) return true;
  try {
    if (active.assertCurrent() !== false) return true;
  } catch {
    // Reconciliation deliberately converts all attestation failures to the
    // same non-disclosing cancellation result.
  }
  rejectActive(staleRequesterError());
  return false;
}

export function clearInstallOffer(
  reason = "The install offer was cancelled",
): void {
  if (!runtime) {
    useInstallOfferStore.setState({ pending: null });
    return;
  }
  rejectActive(
    new KernelPolicyError("REQUEST_CANCELLED", reason),
  );
}

export function clearInstallOfferForApp(
  appId: string,
  reason = `The install offer from '${appId}' was cancelled`,
): void {
  if (runtime?.appId !== appId) return;
  clearInstallOffer(reason);
}

function rejectActive(error: Error): void {
  const active = runtime;
  if (!active) {
    useInstallOfferStore.setState({ pending: null });
    return;
  }
  detachActive(active);
  active.reject(error);
}

function detachActive(active: PendingRuntime): void {
  if (runtime !== active) return;
  runtime = null;
  clearTimeout(active.timeout);
  useInstallOfferStore.setState({ pending: null });
  finishOwnerAttention(active.attentionToken);
}

function freezeApproval(
  requestId: string,
  offer: NormalizedInstallOffer,
  requester: AttestedInstallOfferRequester,
): InstallOfferApproval {
  const frozenOffer: Readonly<NormalizedInstallOffer> =
    offer.kind === "repository_setup_url"
      ? Object.freeze({
          kind: offer.kind,
          url: offer.url,
          reference: Object.freeze({ ...offer.reference }),
        })
      : Object.freeze({ kind: offer.kind, url: offer.url });
  const frozenRequester = Object.freeze({ ...requester });
  return Object.freeze({
    requestId,
    offer: frozenOffer,
    requester: frozenRequester,
  });
}

function validateTrustedInput(
  offer: NormalizedInstallOffer,
  requester: AttestedInstallOfferRequester,
  timeoutMs: number,
): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    invalidRequest("Install offer timeout is invalid");
  }
  if (
    requester.appId.trim() === "" ||
    requester.appName.trim() === ""
  ) {
    invalidRequest("Install offer requester is invalid");
  }
  if (requester.kind === "agent") {
    if (
      requester.rootAppId.trim() === "" ||
      requester.rootAppName.trim() === "" ||
      requester.entrypoint.trim() === "" ||
      requester.tool.trim() === "" ||
      requester.rootId.trim() === ""
    ) {
      invalidRequest("Install offer agent attribution is invalid");
    }
  }
  let url: URL;
  try {
    url = new URL(offer.url);
  } catch {
    invalidRequest("Install offer URL is invalid");
  }
  if (
    (url!.protocol !== "https:" && url!.protocol !== "http:") ||
    url!.username !== "" ||
    url!.password !== ""
  ) {
    invalidRequest("Install offer URL is invalid");
  }
  if (offer.kind === "repository_setup_url") {
    if (
      offer.reference.repo.trim() === "" ||
      offer.reference.manifest.trim() === "" ||
      offer.reference.digest.trim() === ""
    ) {
      invalidRequest("Repository setup attribution is invalid");
    }
  }
}

function invalidRequest(message: string): never {
  throw new KernelPolicyError("INVALID_REQUEST", message);
}

function staleRequesterError(): KernelPolicyError {
  return new KernelPolicyError(
    "REQUEST_CANCELLED",
    "The requesting app or agent is no longer active",
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
