import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  dismissTray,
  loadNeutronCanisterId,
  onTileViewRequest,
  openAppTile,
} from "neutron-tools/app";
import {
  MailUi,
  reduceMailUiNavigation,
  type MailComposerDraft,
  type MailComposerFieldErrors,
  type MailCleanupScope,
  type MailMarkdownInsertion,
  type MailIdentity,
  type MailRecipientOption,
  type MailDeliverySetupState,
  type MailUiNavigation,
  type MailUiNavigationEvent,
} from "./mail_ui.tsx";
import type { MailFolder } from "./model.ts";
import {
  EMPTY_MAIL_DRAFT,
  INITIAL_MAIL_SNAPSHOT_STATE,
  MAIL_OWNER_API,
  cleanupDialog,
  formatBytes,
  formatMailTimestamp,
  loadAuthoritativeMailSnapshot,
  loadRevisionBoundMailPage,
  decryptedMessageDetail,
  decryptedMessageSummary,
  lockedMessageDetail,
  lockedMessageSummary,
  mailErrorMessage,
  mailLockState,
  mailMessageKey,
  mailPulseFromStatus,
  mailSnapshotBindingIsCurrent,
  parseMailMessageKey,
  parseMailTileView,
  probeMailPulseBinding,
  reprojectSelectedMessageOuter,
  replyDraftForMessage,
  reduceMailSnapshot,
  storageSummary,
  type MailOwnerApi,
  type MailSnapshot,
  type MailSnapshotState,
} from "./mail_controller.ts";
import type {
  MailBackendCleanupPreview,
  MailBackendCryptoProgress,
  MailBackendCurrentContact,
  MailBackendPulse,
  MailBackendStatus,
} from "./backend.ts";
import { getMailRecipients, MailBackendMailboxError } from "./backend.ts";
import {
  MailCryptoTileClient,
  activatePrivateMail,
  loadMailCryptoProgress,
  recoverMailCryptoSessionForBinding,
  retireMailPreviousGeneration,
  startMailKeyRotation,
  type MailCryptoTilePort,
} from "./mail_crypto_client.ts";
import type { MailCryptoSessionSnapshot } from "./mail_crypto_session.ts";
import {
  MailPrivateError,
  type MailPrivateRow,
} from "./mail_private.ts";
import {
  MailPrivateTileClient,
  type MailPrivateTilePort,
} from "./mail_private_client.ts";
import {
  MailComposeTileClient,
  type MailComposeTilePort,
} from "./mail_compose_client.ts";
import {
  MailComposeError,
  type MailComposeRecipient,
  type MailPrivateDelivery,
  type MailPrivateSendRequest,
} from "./mail_compose.ts";
import { MailRotationTileClient } from "./mail_rotation_client.ts";
import { MailRotationError } from "./mail_rotation.ts";
import {
  ensureMailDeliveryReservations,
  readMailDeliveryReservationState,
  type MailDeliveryReservationState,
} from "./mail_delivery_access.ts";
import { openPrefilledContact } from "./contacts_handoff.ts";
import {
  MailKeyRotationPanel,
  type MailKeyRotationPhase,
} from "./mail_key_rotation_ui.tsx";
import { MailTrayProjectionClient } from "./mail_tray_client.ts";
import type { MailTrayProjection } from "./mail_tray_projection.ts";
import { validateBodyMarkdown, validateClaimedSenderName, validateSubject } from "./model.ts";
import { composerLeaveConfirmationKind } from "./mail_confirmation.ts";
import { Principal } from "@dfinity/principal";

const INITIAL_NAVIGATION: MailUiNavigation = {
  folder: "inbox",
  route: "list",
  selectedId: null,
  composeMode: null,
  composerTab: "editor",
};

const MAIL_CLEANUP_SCOPES: readonly MailCleanupScope[] = [
  "read_inbox",
  "unknown_senders",
  "all_mail",
];

type MailCleanupRowDetails = Record<MailCleanupScope, {
  count: number;
  bytesLabel: string;
} | null>;

function emptyCleanupRowDetails(): MailCleanupRowDetails {
  return { read_inbox: null, unknown_senders: null, all_mail: null };
}

type MailCryptoPhase =
  | "idle"
  | "activating"
  | "syncing";

type PrivateReadinessFailure = {
  currentEpoch: string | null;
  previousEpoch: string | null;
  error: Error;
};

type PendingMailConfirmation =
  | {
      kind: "leave_composer";
      event: MailUiNavigationEvent;
      sending: boolean;
    }
  | {
      kind: "direct_recipient";
      draft: MailComposerDraft;
      principal: string;
    };

export function MailApp({
  api = MAIL_OWNER_API,
  cryptoApi,
  privateApi,
  composeApi,
  recipientApi = getMailRecipients,
  activate = activatePrivateMail,
  readDeliveryReservations = readMailDeliveryReservationState,
  ensureDeliveryReservations = ensureMailDeliveryReservations,
}: {
  api?: MailOwnerApi;
  cryptoApi?: MailCryptoTilePort;
  privateApi?: MailPrivateTilePort;
  composeApi?: MailComposeTilePort;
  recipientApi?: typeof getMailRecipients;
  activate?: () => Promise<unknown>;
  readDeliveryReservations?: () => Promise<MailDeliveryReservationState>;
  ensureDeliveryReservations?: () => Promise<MailDeliveryReservationState>;
}) {
  const crypto = useMemo(
    () => cryptoApi ?? new MailCryptoTileClient(),
    [cryptoApi],
  );
  const privateMail = useMemo(
    () => privateApi ?? new MailPrivateTileClient(),
    [privateApi],
  );
  const composeMail = useMemo(
    () => composeApi ?? new MailComposeTileClient(),
    [composeApi],
  );
  const rotationMail = useMemo(() => new MailRotationTileClient(), []);
  const [navigation, setNavigation] = useState<MailUiNavigation>(INITIAL_NAVIGATION);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [privateRows, setPrivateRows] = useState<Map<string, MailPrivateRow>>(
    () => new Map(),
  );
  const [snapshotState, dispatchSnapshot] = useReducer(
    reduceMailSnapshot,
    INITIAL_MAIL_SNAPSHOT_STATE,
  );
  const [selectedMessage, setSelectedMessage] = useState<ReturnType<typeof lockedMessageDetail> | null>(null);
  const [draft, setDraft] = useState<MailComposerDraft>(EMPTY_MAIL_DRAFT);
  const [composerErrors, setComposerErrors] = useState<MailComposerFieldErrors>({});
  const [recipientOptions, setRecipientOptions] = useState<MailRecipientOption[]>([]);
  const [senderName, setSenderName] = useState<string | null>(null);
  const [senderSettingsPending, setSenderSettingsPending] = useState(false);
  const [senderSettingsError, setSenderSettingsError] = useState<string | null>(null);
  const [sendPending, setSendPending] = useState(false);
  const [deliverySetupState, setDeliverySetupState] = useState<MailDeliverySetupState>("checking");
  const [deliverySetupNotice, setDeliverySetupNotice] = useState<string | null>(null);
  const [retryPendingId, setRetryPendingId] = useState<string | null>(null);
  const [newMailCount, setNewMailCount] = useState(0);
  const [selectionUnavailableMessage, setSelectionUnavailableMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<MailBackendCleanupPreview | null>(null);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupRowDetails, setCleanupRowDetails] = useState<MailCleanupRowDetails>(
    emptyCleanupRowDetails,
  );
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingMailConfirmation | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [neutronAddress, setNeutronAddress] = useState<string | null>(null);
  const [cryptoSession, setCryptoSession] = useState<MailCryptoSessionSnapshot | null>(null);
  const [cryptoPhase, setCryptoPhase] = useState<MailCryptoPhase>("idle");
  const [cryptoError, setCryptoError] = useState<string | null>(null);
  const [rotationProgress, setRotationProgress] = useState<MailBackendCryptoProgress | null>(null);
  const [rotationPhase, setRotationPhase] = useState<MailKeyRotationPhase>("idle");
  const [rotationNotice, setRotationNotice] = useState<string | null>(null);
  const [rotationError, setRotationError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const rotationGeneration = useRef(0);
  const cleanupDetailsGeneration = useRef(0);
  const deliverySetupGeneration = useRef(0);
  const deliverySetupProbePending = useRef(false);
  const deliverySetupStateRef = useRef<MailDeliverySetupState>("checking");
  const rotationMutationPendingRef = useRef(false);
  const suppressRotationEffectBindingRef = useRef<{
    currentEpoch: string;
    previousEpoch: string | null;
  } | null>(null);
  const detailGeneration = useRef(0);
  const cryptoSessionRef = useRef<MailCryptoSessionSnapshot | null>(null);
  const readinessAttemptRef = useRef<{
    currentEpoch: string | null;
    previousEpoch: string | null;
    promise: Promise<MailCryptoSessionSnapshot>;
  } | null>(null);
  const readinessGenerationRef = useRef(0);
  const privateReadinessFailureRef = useRef<PrivateReadinessFailure | null>(null);
  const markReadFrame = useRef<number | null>(null);
  const recipientGeneration = useRef(0);
  const draftDirtyRef = useRef(false);
  const sendCommandIdRef = useRef<string | null>(null);
  const confirmedDirectPrincipalRef = useRef<string | null>(null);
  const confirmedNavigationRef = useRef(false);
  const privateRowsRef = useRef<Map<string, MailPrivateRow>>(new Map());
  const selectedIdRef = useRef<string | null>(null);
  const snapshotRef = useRef<MailSnapshot | null>(null);
  const pulseBaselineRef = useRef<MailBackendPulse | null>(null);
  const pageHistoryRef = useRef<string[]>([]);
  const suppressAutomaticFolderRefreshRef = useRef<MailFolder | null>(null);
  const mounted = useRef(true);
  const status = snapshotState.snapshot?.status ?? null;

  useEffect(() => () => {
    mounted.current = false;
    deliverySetupGeneration.current += 1;
    if (markReadFrame.current !== null) {
      window.cancelAnimationFrame(markReadFrame.current);
    }
  }, []);

  useEffect(() => {
    selectedIdRef.current = navigation.selectedId;
  }, [navigation.selectedId]);

  useEffect(() => {
    privateRowsRef.current = privateRows;
  }, [privateRows]);

  const rememberCryptoSession = useCallback((next: MailCryptoSessionSnapshot | null) => {
    cryptoSessionRef.current = next;
    setCryptoSession(next);
  }, []);

  const invalidatePrivateReadiness = useCallback(() => {
    readinessGenerationRef.current += 1;
    readinessAttemptRef.current = null;
    setCryptoPhase("idle");
  }, []);

  const beginLifecycleCryptoSync = useCallback(() => {
    invalidatePrivateReadiness();
    privateReadinessFailureRef.current = null;
    setCryptoError(null);
  }, [invalidatePrivateReadiness]);

  const commitLifecycleCryptoSession = useCallback((next: MailCryptoSessionSnapshot) => {
    beginLifecycleCryptoSync();
    rememberCryptoSession(next);
  }, [beginLifecycleCryptoSync, rememberCryptoSession]);

  const markPrivateMailUnavailable = useCallback((message: string) => {
    rememberCryptoSession(null);
    setPrivateRows(new Map());
    privateRowsRef.current = new Map();
    setCryptoError(message);
  }, [rememberCryptoSession]);

  useEffect(() => {
    let live = true;
    void loadNeutronCanisterId()
      .then((address) => {
        if (live) setNeutronAddress(address);
      })
      .catch(() => {
        // Mail remains usable if its hosting address cannot be discovered.
      });
    return () => {
      live = false;
    };
  }, []);

  const applyLoadedSnapshot = useCallback((
    snapshot: MailSnapshot,
    nextPrivateRows: Map<string, MailPrivateRow>,
    selectedDeleted = false,
    selectedOuter: ReturnType<typeof lockedMessageDetail> | null = null,
  ) => {
    const selectedId = selectedIdRef.current;
    snapshotRef.current = snapshot;
    pulseBaselineRef.current = mailPulseFromStatus(snapshot.status);
    setNewMailCount(0);
    privateRowsRef.current = nextPrivateRows;
    setPrivateRows(nextPrivateRows);
    dispatchSnapshot({ type: "refresh_succeeded", snapshot });
    if (selectedId && selectedDeleted) {
      detailGeneration.current += 1;
      setSelectedMessage(null);
      setSelectionUnavailableMessage(
        "It was deleted in another Mail view. The message list has been refreshed.",
      );
    } else if (selectedId && selectedOuter) {
      setSelectionUnavailableMessage(null);
      setSelectedMessage((current) => {
        if (!current || current.id !== selectedId) return current;
        return reprojectSelectedMessageOuter(current, selectedOuter);
      });
    }
  }, []);

  const ensurePrivateMailReady = useCallback((
    expectedStatus: MailBackendStatus,
    options: { force?: boolean } = {},
  ): Promise<MailCryptoSessionSnapshot> => {
    if (!expectedStatus.privateMailActive) {
      return Promise.reject(new Error("Private Mail has not been set up"));
    }
    const current = cryptoSessionRef.current;
    if (mailLockState(expectedStatus, current) === "unlocked" && current) {
      privateReadinessFailureRef.current = null;
      return Promise.resolve(current);
    }
    const blocked = privateReadinessFailureRef.current;
    const sameBlockedBinding =
      blocked?.currentEpoch === expectedStatus.currentEpoch &&
      blocked.previousEpoch === expectedStatus.previousEpoch;
    if (sameBlockedBinding && !options.force) {
      return Promise.reject(blocked.error);
    }
    if (sameBlockedBinding) privateReadinessFailureRef.current = null;
    const existing = readinessAttemptRef.current;
    if (
      existing?.currentEpoch === expectedStatus.currentEpoch &&
      existing.previousEpoch === expectedStatus.previousEpoch
    ) return existing.promise;

    setCryptoPhase("syncing");
    setCryptoError(null);
    const readinessGeneration = readinessGenerationRef.current;
    const attempt = recoverMailCryptoSessionForBinding(expectedStatus, crypto).then((session) => {
      if (mailLockState(expectedStatus, session) !== "unlocked") {
        throw new Error("Private Mail key is not ready");
      }
      if (
        mounted.current &&
        readinessGeneration === readinessGenerationRef.current &&
        readinessAttemptRef.current?.promise === attempt
      ) {
        privateReadinessFailureRef.current = null;
        rememberCryptoSession(session);
        setCryptoPhase("idle");
        setCryptoError(null);
      }
      return session;
    }).catch((error) => {
      if (
        mounted.current &&
        readinessGeneration === readinessGenerationRef.current &&
        readinessAttemptRef.current?.promise === attempt
      ) {
        privateReadinessFailureRef.current = {
          currentEpoch: expectedStatus.currentEpoch,
          previousEpoch: expectedStatus.previousEpoch,
          error: error instanceof Error ? error : new Error(mailErrorMessage(error)),
        };
        setCryptoPhase("idle");
        markPrivateMailUnavailable(privateReadinessErrorMessage(error));
      }
      throw error;
    }).finally(() => {
      if (readinessAttemptRef.current?.promise === attempt) readinessAttemptRef.current = null;
    });
    readinessAttemptRef.current = {
      currentEpoch: expectedStatus.currentEpoch,
      previousEpoch: expectedStatus.previousEpoch,
      promise: attempt,
    };
    return attempt;
  }, [crypto, markPrivateMailUnavailable, rememberCryptoSession]);

  const refresh = useCallback(async (
    folder: MailFolder,
    onlyUnread = unreadOnly,
    options: { deferNewInbox?: boolean; offset?: string } = {},
  ) => {
    const generation = ++refreshGeneration.current;
    if (!options.deferNewInbox) {
      setNewMailCount(0);
      dispatchSnapshot({ type: "refresh_started" });
    }
    try {
      const previous = snapshotRef.current;
      const offset = options.offset ?? (
        previous?.folder === folder && previous.unreadOnly === onlyUnread
          ? previous.offset
          : "0"
      );
      const nextStatus = await api.status();
      if (generation !== refreshGeneration.current) return;

      if (
        options.deferNewInbox &&
        folder === "inbox" &&
        previous?.folder === "inbox" &&
        previous.unreadOnly === onlyUnread
      ) {
        const arrivals = countInboxStatusArrivals(previous.status, nextStatus);
        if (arrivals > 0) {
          pulseBaselineRef.current = mailPulseFromStatus(nextStatus);
          setNewMailCount(arrivals);
          return;
        }
      }

      // Healthy polling is status-only. A stable revision means the current
      // bounded page and its authenticated private projection are unchanged.
      const bindingUnchanged = previous !== null &&
        mailSnapshotBindingIsCurrent(previous, nextStatus, folder, onlyUnread, offset);
      const reusablePrivatePage = bindingUnchanged && (
        !nextStatus.privateMailActive ||
        previous.page.items.every((item) =>
          privateRowsRef.current.has(mailMessageKey(item.kind, item.localId))
        )
      );
      if (bindingUnchanged && reusablePrivatePage) {
        const reused = { ...previous, status: nextStatus, loadedAt: Date.now() };
        snapshotRef.current = reused;
        pulseBaselineRef.current = mailPulseFromStatus(nextStatus);
        dispatchSnapshot({ type: "refresh_succeeded", snapshot: reused });
        return;
      }

      // A recovered resident session may need only the current private header
      // page. Reuse its already revision-validated outer page without another
      // canister list query.
      const snapshot = bindingUnchanged
        ? { ...previous, status: nextStatus, loadedAt: Date.now() }
        : await loadAuthoritativeMailSnapshot(api, folder, 50, {
            unreadOnly: onlyUnread,
            offset,
            status: nextStatus,
          });
      if (generation !== refreshGeneration.current) return;
      if (snapshot.offset !== offset) pageHistoryRef.current = [];
      let nextPrivateRows = new Map<string, MailPrivateRow>();
      if (snapshot.status.privateMailActive) {
        let ready = false;
        try {
          await ensurePrivateMailReady(snapshot.status);
          ready = true;
        } catch {
          // The authoritative outer snapshot is still useful. Keep rendering
          // it while the UI offers a bounded retry for private content.
        }
        if (generation !== refreshGeneration.current) return;
        if (ready) {
          try {
            nextPrivateRows = await loadPrivateRowsWithRecovery(
              () => loadPrivateRowsForSnapshot(
                privateMail,
                snapshot,
                onlyUnread,
              ),
              async () => {
                // The resident worker may erase an inactive key between the
                // authoritative list and header projection. Recovery is an
                // internal Mail concern: refresh the seamless session and
                // retry once without exposing lock/unlock UI or requiring a
                // second user action.
                if (generation !== refreshGeneration.current) {
                  throw new Error("Mail refresh was superseded");
                }
                invalidatePrivateReadiness();
                rememberCryptoSession(null);
                await ensurePrivateMailReady(snapshot.status);
                if (generation !== refreshGeneration.current) {
                  throw new Error("Mail refresh was superseded");
                }
              },
            );
          } catch (error) {
            // A newer refresh owns the UI and resident session now. A late
            // failure from this superseded request must not clear its valid
            // key or decrypted rows.
            if (generation !== refreshGeneration.current) return;
            markPrivateMailUnavailable(privateReadinessErrorMessage(error));
            ready = false;
          }
          if (generation !== refreshGeneration.current) return;
        }
      }
      let selectedDeleted = false;
      let selectedOuter: ReturnType<typeof lockedMessageDetail> | null = null;
      const selectedId = selectedIdRef.current;
      if (selectedId) {
        const target = parseMailMessageKey(selectedId);
        if (target) {
          try {
            const exact = await api.get(target.folder, target.localId);
            selectedOuter = lockedMessageDetail(exact.record, target.folder);
          } catch (error) {
            selectedDeleted = error instanceof MailBackendMailboxError &&
              error.code === "NOT_FOUND";
          }
          if (generation !== refreshGeneration.current) return;
        }
      }
      applyLoadedSnapshot(snapshot, nextPrivateRows, selectedDeleted, selectedOuter);
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      dispatchSnapshot({ type: "refresh_failed", message: mailErrorMessage(error) });
    }
  }, [api, applyLoadedSnapshot, ensurePrivateMailReady, invalidatePrivateReadiness, markPrivateMailUnavailable, privateMail, rememberCryptoSession, unreadOnly]);

  const showNewMail = useCallback(() => {
    pageHistoryRef.current = [];
    void refresh("inbox", unreadOnly, { offset: "0" });
  }, [refresh, unreadOnly]);

  const updateDeliverySetup = useCallback((
    state: MailDeliverySetupState,
    notice: string | null,
  ) => {
    deliverySetupStateRef.current = state;
    setDeliverySetupState(state);
    setDeliverySetupNotice(notice);
  }, []);

  const checkDeliverySetup = useCallback(async (
    options: { announce?: boolean } = {},
  ): Promise<MailDeliveryReservationState | null> => {
    if (!options.announce && deliverySetupProbePending.current) return null;
    const generation = ++deliverySetupGeneration.current;
    deliverySetupProbePending.current = true;
    if (options.announce) updateDeliverySetup("checking", null);
    try {
      const reservationState = await readDeliveryReservations();
      if (
        !mounted.current ||
        generation !== deliverySetupGeneration.current
      ) {
        return reservationState;
      }
      updateDeliverySetup(
        reservationState.complete ? "ready" : "required",
        reservationState.complete
          ? null
          : "Finish Mail setup once to send encrypted messages.",
      );
      return reservationState;
    } catch {
      if (
        mounted.current &&
        generation === deliverySetupGeneration.current
      ) {
        updateDeliverySetup(
          "unavailable",
          "Mail could not verify its delivery setup. Try again.",
        );
      }
      return null;
    } finally {
      if (generation === deliverySetupGeneration.current) {
        deliverySetupProbePending.current = false;
      }
    }
  }, [readDeliveryReservations, updateDeliverySetup]);

  const completeDeliverySetup = useCallback(async (): Promise<boolean> => {
    if (deliverySetupStateRef.current === "requesting") return false;
    const generation = ++deliverySetupGeneration.current;
    deliverySetupProbePending.current = false;
    updateDeliverySetup("requesting", "Finishing Mail setup…");
    try {
      const reservationState = await ensureDeliveryReservations();
      if (!reservationState.complete) {
        throw new Error("Mail delivery methods were not reserved");
      }
      if (
        mounted.current &&
        generation === deliverySetupGeneration.current
      ) {
        updateDeliverySetup("ready", null);
        setStatusMessage("Mail setup complete.");
      }
      return reservationState.complete;
    } catch (error) {
      if (
        mounted.current &&
        generation === deliverySetupGeneration.current
      ) {
        updateDeliverySetup(
          "required",
          "Finish Mail setup once to send encrypted messages.",
        );
        setStatusMessage(`${mailErrorMessage(error)} Your Mail remains private and your draft is unchanged.`);
      }
      return deliverySetupStateRef.current === "ready";
    }
  }, [ensureDeliveryReservations, updateDeliverySetup]);

  useEffect(() => {
    void checkDeliverySetup({ announce: true });
  }, [checkDeliverySetup]);

  useEffect(() => {
    if (
      deliverySetupState === "ready" ||
      deliverySetupState === "requesting"
    ) {
      return;
    }

    // A provisioned install can become visible just before its reviewed
    // reservation batch is committed. Reconcile that short window without
    // asking the owner for access or leaving a stale setup notice behind.
    let stopped = false;
    let timer: number | null = null;
    const delays = [1_500, 5_000, 15_000] as const;
    const reconcile = async () => {
      for (const delay of delays) {
        await new Promise<void>((resolve) => {
          timer = window.setTimeout(resolve, delay);
        });
        if (
          stopped ||
          deliverySetupStateRef.current === "ready" ||
          deliverySetupStateRef.current === "requesting"
        ) {
          return;
        }
        await checkDeliverySetup();
      }
    };
    const reconcileOnFocus = () => {
      if (
        !stopped &&
        deliverySetupStateRef.current !== "ready" &&
        deliverySetupStateRef.current !== "requesting"
      ) {
        void checkDeliverySetup();
      }
    };
    const reconcileOnVisibility = () => {
      if (!document.hidden) reconcileOnFocus();
    };
    window.addEventListener("focus", reconcileOnFocus);
    document.addEventListener("visibilitychange", reconcileOnVisibility);
    void reconcile();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", reconcileOnFocus);
      document.removeEventListener("visibilitychange", reconcileOnVisibility);
    };
  }, [checkDeliverySetup, deliverySetupState]);

  const activateMail = useCallback(() => {
    if (cryptoPhase !== "idle") return;
    setCryptoError(null);
    setCryptoPhase("activating");
    // `activate` starts requestVetKeys immediately from this trusted click.
    const operation = activate();
    void operation.then(
      async () => {
        if (!mounted.current) return;
        const deliveryReady = await completeDeliverySetup();
        if (!mounted.current) return;
        setStatusMessage(
          deliveryReady
            ? "Private Mail is set up."
            : "Private Mail is ready. Finish Mail setup once to send.",
        );
        setCryptoPhase("syncing");
        await refresh(navigation.folder, unreadOnly);
        if (mounted.current) setCryptoPhase("idle");
      },
      (error) => {
        if (!mounted.current) return;
        setCryptoPhase("idle");
        setCryptoError(mailErrorMessage(error));
      },
    ).catch(() => {
      if (!mounted.current) return;
      setCryptoPhase("idle");
      setCryptoError("Private Mail could not finish setup. Try again.");
    });
  }, [activate, completeDeliverySetup, cryptoPhase, navigation.folder, refresh, unreadOnly]);

  const retryPrivateMail = useCallback(() => {
    const currentStatus = snapshotRef.current?.status ?? status;
    if (!currentStatus?.privateMailActive) {
      activateMail();
      return;
    }
    void ensurePrivateMailReady(currentStatus, { force: true }).then(
      () => refresh(navigation.folder, unreadOnly),
      () => undefined,
    );
  }, [activateMail, ensurePrivateMailReady, navigation.folder, refresh, status, unreadOnly]);

  useEffect(() => {
    if (suppressAutomaticFolderRefreshRef.current === navigation.folder) {
      suppressAutomaticFolderRefreshRef.current = null;
      return;
    }
    suppressAutomaticFolderRefreshRef.current = null;
    pageHistoryRef.current = [];
    void refresh(navigation.folder, unreadOnly, { offset: "0" });
  }, [
    navigation.folder,
    unreadOnly,
    refresh,
  ]);

  useEffect(() => {
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (stopped || polling || document.hidden) return;
      polling = true;
      try {
        const generation = refreshGeneration.current;
        const previous = snapshotRef.current;
        const offset = previous?.folder === navigation.folder &&
            previous.unreadOnly === unreadOnly
          ? previous.offset
          : "0";
        if (previous) {
          try {
            const observed = pulseBaselineRef.current ?? mailPulseFromStatus(previous.status);
            const probe = await probeMailPulseBinding(
              api,
              previous,
              observed,
              navigation.folder,
              unreadOnly,
              offset,
            );
            if (stopped || generation !== refreshGeneration.current) return;
            if (!probe.changed) return;
          } catch {
            // Fall through to the ordinary status path. A transient pulse
            // failure must not disable Mail's existing stale-state handling.
          }
        }
        if (stopped || generation !== refreshGeneration.current) return;
        await refresh(navigation.folder, unreadOnly, {
          deferNewInbox: navigation.folder === "inbox",
          offset,
        });
      } finally {
        polling = false;
      }
    };
    const wake = () => { void poll(); };
    const interval = window.setInterval(wake, 30_000);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [api, navigation.folder, refresh, unreadOnly]);

  useEffect(() => {
    if (!status?.privateMailActive) {
      rememberCryptoSession(null);
      return;
    }
    void ensurePrivateMailReady(status).catch(() => undefined);
  }, [
    ensurePrivateMailReady,
    status?.currentEpoch,
    status?.previousEpoch,
    status?.privateMailActive,
  ]);

  useEffect(() => {
    if (mailLockState(status, cryptoSession) !== "unlocked") {
      setSenderName(null);
      setSenderSettingsError(null);
      return;
    }
    let live = true;
    setSenderSettingsError(null);
    void composeMail.getSettings().then(
      (settings) => {
        if (live && mounted.current) setSenderName(settings.senderName);
      },
      (error) => {
        if (live && mounted.current) setSenderSettingsError(mailErrorMessage(error));
      },
    );
    return () => {
      live = false;
    };
  }, [composeMail, cryptoSession, status]);

  useEffect(() => {
    const generation = ++recipientGeneration.current;
    if (
      navigation.route !== "compose" ||
      draft.mode !== "new" ||
      mailLockState(status, cryptoSession) !== "unlocked"
    ) {
      setRecipientOptions([]);
      return;
    }
    const input = draft.recipientInput.trim();
    const timer = window.setTimeout(() => {
      void recipientApi({ searchText: input, offset: "0", limit: 8 }).then(
        (page) => {
          if (generation !== recipientGeneration.current || !mounted.current) return;
          const options: MailRecipientOption[] = page.recipients.map((recipient) => ({
            principal: recipient.principal,
            label: recipient.contactName,
            source: "contact",
            contactId: recipient.contactId,
            contactRevision: recipient.contactRevision,
          }));
          const direct = canonicalCanisterPrincipal(input);
          if (
            direct !== null &&
            direct !== neutronAddress &&
            !options.some((option) => option.principal === direct)
          ) {
            options.push({ principal: direct, label: direct, source: "principal" });
          }
          setRecipientOptions(options);
        },
        () => {
          if (generation === recipientGeneration.current && mounted.current) {
            const direct = canonicalCanisterPrincipal(input);
            setRecipientOptions(
              direct !== null && direct !== neutronAddress
                ? [{ principal: direct, label: direct, source: "principal" }]
                : [],
            );
          }
        },
      );
    }, 180);
    return () => window.clearTimeout(timer);
  }, [cryptoSession, draft.mode, draft.recipientInput, navigation.route, neutronAddress, recipientApi, status]);

  useEffect(() => {
    setPendingConfirmation((current) => {
      if (current === null) return current;
      if (current.kind === "direct_recipient") {
        return navigation.route === "compose" && current.draft === draft && !sendPending
          ? current
          : null;
      }
      const kind = composerLeaveConfirmationKind(
        navigation.route,
        draftDirtyRef.current,
        sendPending,
      );
      if (kind === null) return null;
      const sending = kind === "sending";
      return current.sending === sending ? current : { ...current, sending };
    });
  }, [draft, navigation.route, sendPending]);

  const openExactMessage = useCallback(async (folder: MailFolder, localId: string) => {
    const generation = ++detailGeneration.current;
    const id = mailMessageKey(folder, localId);
    if (navigation.folder !== folder) pageHistoryRef.current = [];
    if (
      navigation.folder !== folder &&
      snapshotRef.current?.folder === folder
    ) {
      // A send/retry has already loaded this exact destination folder. The
      // navigation effect would otherwise issue a redundant private list in
      // parallel with the exact private get below, making the two resident
      // projections supersede one another.
      suppressAutomaticFolderRefreshRef.current = folder;
    }
    setNavigation((current) => reduceMailUiNavigation(current, {
      type: "select_folder",
      folder,
    }));
    setNavigation((current) => reduceMailUiNavigation(current, {
      type: "select_message",
      id,
    }));
    setSelectedMessage(null);
    setDetailError(null);
    setSelectionUnavailableMessage(null);
    setStatusMessage("Preparing private Mail…");
    try {
      const currentStatus = snapshotRef.current?.status ?? await api.status();
      if (currentStatus.privateMailActive) {
        try {
          await ensurePrivateMailReady(currentStatus, { force: true });
        } catch {
          // Keep going so the reader can show the authoritative outer record
          // with a neutral retry state instead of abandoning the route.
        }
      }
      if (
        currentStatus.privateMailActive &&
        mailLockState(currentStatus, cryptoSessionRef.current) === "unlocked"
      ) {
        const message = await privateMail.get(folder, localId);
        if (generation !== detailGeneration.current) return;
        const detail = decryptedMessageDetail(
          message,
          neutronAddress ?? "This Neutron",
        );
        setSelectedMessage(detail);
        setPrivateRows((current) => {
          const next = new Map(current);
          const { bodyMarkdown: _bodyMarkdown, ...row } = message;
          next.set(id, row);
          return next;
        });
        setStatusMessage(
          message.decryption.state === "corrupt"
            ? "This message could not be authenticated or decrypted"
            : null,
        );
        if (folder === "inbox" && !message.read && message.decryption.state === "ready") {
          if (markReadFrame.current !== null) {
            window.cancelAnimationFrame(markReadFrame.current);
          }
          markReadFrame.current = window.requestAnimationFrame(() => {
            markReadFrame.current = null;
            if (!mounted.current || generation !== detailGeneration.current) return;
            void api.mark([localId], true).then(
              () => {
                if (!mounted.current) return;
                setSelectedMessage((current) => current?.id === id
                  ? { ...current, read: true }
                  : current);
                setPrivateRows((current) => {
                  const row = current.get(id);
                  if (!row) return current;
                  const next = new Map(current);
                  next.set(id, { ...row, read: true });
                  return next;
                });
                void refresh("inbox", unreadOnly);
              },
              (error) => {
                if (mounted.current) setStatusMessage(mailErrorMessage(error));
              },
            );
          });
        }
        return;
      }
      const result = await api.get(folder, localId);
      if (generation !== detailGeneration.current) return;
      setSelectedMessage(lockedMessageDetail(result.record, folder));
      setStatusMessage(null);
      // Deliberately no mail_mark call: an outer-only display is not a
      // successful plaintext display and must not consume unread state.
    } catch (error) {
      if (generation !== detailGeneration.current) return;
      if (error instanceof MailPrivateError) {
        markPrivateMailUnavailable(privateReadinessErrorMessage(error));
        try {
          const result = await api.get(folder, localId);
          if (generation !== detailGeneration.current) return;
          setSelectedMessage(lockedMessageDetail(result.record, folder));
          setStatusMessage(null);
          return;
        } catch {
          // Report the original private-content failure below.
        }
      }
      setDetailError(mailErrorMessage(error));
      setStatusMessage(null);
    }
  }, [
    api,
    ensurePrivateMailReady,
    markPrivateMailUnavailable,
    neutronAddress,
    navigation.folder,
    privateMail,
    refresh,
    unreadOnly,
  ]);

  useEffect(() => onTileViewRequest((view) => {
    const request = parseMailTileView(view);
    if (request) void openExactMessage(request.folder, request.localId);
  }), [openExactMessage]);

  const onNavigate = useCallback((event: MailUiNavigationEvent) => {
    const navigationConfirmed = confirmedNavigationRef.current;
    confirmedNavigationRef.current = false;
    if (
      !navigationConfirmed &&
      navigation.route === "compose" &&
      event.type !== "composer_tab" &&
      event.type !== "reply" &&
      event.type !== "compose" &&
      (draftDirtyRef.current || sendPending)
    ) {
      setPendingConfirmation({
        kind: "leave_composer",
        event,
        sending: sendPending,
      });
      return;
    }
    if (navigationConfirmed) {
      draftDirtyRef.current = false;
    }
    if (event.type === "select_message") {
      const target = parseMailMessageKey(event.id);
      if (target) void openExactMessage(target.folder, target.localId);
      return;
    }
    if (event.type === "select_folder") {
      detailGeneration.current += 1;
      setSelectedMessage(null);
      setDetailError(null);
      setSelectionUnavailableMessage(null);
      setSearchQuery("");
    }
    if (event.type === "reply") {
      if (!selectedMessage || selectedMessage.id !== event.id) {
        setStatusMessage("Open the message before replying");
        return;
      }
      const reply = replyDraftForMessage(selectedMessage);
      if (!reply) {
        setStatusMessage("This message cannot be replied to safely");
        return;
      }
      setDraft(reply);
      draftDirtyRef.current = false;
      sendCommandIdRef.current = null;
      confirmedDirectPrincipalRef.current = null;
      setComposerErrors({});
      setRecipientOptions([]);
    }
    if (event.type === "compose") {
      setDraft(EMPTY_MAIL_DRAFT);
      draftDirtyRef.current = false;
      sendCommandIdRef.current = null;
      confirmedDirectPrincipalRef.current = null;
      setComposerErrors({});
      setRecipientOptions([]);
      const currentStatus = snapshotRef.current?.status;
      if (currentStatus?.privateMailActive) {
        void ensurePrivateMailReady(currentStatus, { force: true }).then(
          () => refresh(navigation.folder, unreadOnly),
          () => undefined,
        );
      }
    }
    setNavigation((current) => reduceMailUiNavigation(current, event));
  }, [ensurePrivateMailReady, navigation.folder, navigation.route, openExactMessage, refresh, selectedMessage, sendPending, unreadOnly]);

  const deleteMessage = useCallback(async (id: string) => {
    const target = parseMailMessageKey(id);
    if (!target || mutationPending) return;
    setMutationPending(true);
    setStatusMessage("Deleting message…");
    try {
      const result = await api.delete([target]);
      detailGeneration.current += 1;
      setPrivateRows((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      setSelectedMessage(null);
      setNavigation((current) => reduceMailUiNavigation(current, { type: "back" }));
      setStatusMessage(result.changed === "0" ? "Message was already removed" : "Message deleted");
      await refresh(target.folder, unreadOnly);
    } catch (error) {
      setStatusMessage(mailErrorMessage(error));
    } finally {
      setMutationPending(false);
    }
  }, [api, mutationPending, refresh, unreadOnly]);

  const toggleRead = useCallback(async (id: string, read: boolean) => {
    const target = parseMailMessageKey(id);
    const currentStatus = snapshotState.snapshot?.status ?? null;
    if (!target || target.folder !== "inbox" || !currentStatus?.privateMailActive) return;
    try {
      await ensurePrivateMailReady(currentStatus, { force: true });
      await api.mark([target.localId], read);
      setSelectedMessage((current) => current?.id === id ? { ...current, read } : current);
      setPrivateRows((current) => {
        const row = current.get(id);
        if (!row) return current;
        const next = new Map(current);
        next.set(id, { ...row, read });
        return next;
      });
      await refresh("inbox", unreadOnly);
    } catch (error) {
      setStatusMessage(privateReadinessErrorMessage(error));
    }
  }, [api, ensurePrivateMailReady, refresh, snapshotState.snapshot, unreadOnly]);

  const changeDraft = useCallback((next: MailComposerDraft) => {
    draftDirtyRef.current = true;
    sendCommandIdRef.current = null;
    confirmedDirectPrincipalRef.current = null;
    setDraft(next);
    setComposerErrors({});
  }, []);

  const chooseRecipient = useCallback((recipient: MailRecipientOption) => {
    draftDirtyRef.current = true;
    sendCommandIdRef.current = null;
    confirmedDirectPrincipalRef.current = null;
    setDraft((current) => ({
      ...current,
      recipient,
      recipientInput: recipient.label,
    }));
    setComposerErrors({});
    setRecipientOptions([]);
  }, []);

  const insertMarkdown = useCallback((kind: MailMarkdownInsertion) => {
    const insertion: Record<MailMarkdownInsertion, string> = {
      bold: "**bold text**",
      italic: "_italic text_",
      link: "[link text](https://)",
      code: "`code`",
      code_block: "\n```\ncode block\n```\n",
      list: "\n- list item",
    };
    draftDirtyRef.current = true;
    sendCommandIdRef.current = null;
    confirmedDirectPrincipalRef.current = null;
    setDraft((current) => ({
      ...current,
      bodyMarkdown: `${current.bodyMarkdown}${insertion[kind]}`,
    }));
  }, []);

  const saveSenderName = useCallback(async (nextName: string) => {
    if (senderSettingsPending) return;
    setSenderSettingsPending(true);
    setSenderSettingsError(null);
    try {
      const settings = await composeMail.setSenderName(nextName);
      setSenderName(settings.senderName);
      setStatusMessage("Encrypted sender name saved");
    } catch (error) {
      setSenderSettingsError(mailErrorMessage(error));
    } finally {
      setSenderSettingsPending(false);
    }
  }, [composeMail, senderSettingsPending]);

  const refreshRotation = useCallback(async () => {
    rotationMutationPendingRef.current = false;
    suppressRotationEffectBindingRef.current = null;
    const generation = ++rotationGeneration.current;
    if (!status?.privateMailActive) {
      setRotationProgress(null);
      setRotationPhase("idle");
      return;
    }
    beginLifecycleCryptoSync();
    setRotationPhase("loading");
    setRotationError(null);
    try {
      const progress = await loadMailCryptoProgress();
      if (progress === null) throw new Error("Private Mail has not been set up");
      const session = await recoverMailCryptoSessionForBinding(progress, crypto);
      if (!mounted.current || generation !== rotationGeneration.current) return;
      setRotationProgress(progress);
      commitLifecycleCryptoSession(session);
      setRotationPhase("idle");
    } catch (error) {
      if (!mounted.current || generation !== rotationGeneration.current) return;
      setRotationPhase("idle");
      setRotationError(mailErrorMessage(error));
    }
  }, [beginLifecycleCryptoSync, commitLifecycleCryptoSession, crypto, status?.privateMailActive]);

  useEffect(() => {
    const suppressed = suppressRotationEffectBindingRef.current;
    if (
      suppressed &&
      suppressed.currentEpoch === status?.currentEpoch &&
      suppressed.previousEpoch === status?.previousEpoch
    ) {
      suppressRotationEffectBindingRef.current = null;
      return;
    }
    if (suppressed) suppressRotationEffectBindingRef.current = null;
    if (
      navigation.route === "settings" &&
      status?.privateMailActive &&
      !rotationMutationPendingRef.current
    ) {
      void refreshRotation();
    }
  }, [navigation.route, refreshRotation, status?.currentEpoch, status?.previousEpoch, status?.privateMailActive]);

  useEffect(() => {
    const generation = ++cleanupDetailsGeneration.current;
    if (navigation.route !== "settings" || !status) {
      setCleanupRowDetails(emptyCleanupRowDetails());
      return;
    }
    const expected = {
      revision: status.revision,
      contactsRevision: status.contactsRevision,
      cleanupEpoch: status.cleanupEpoch,
    };
    setCleanupRowDetails(emptyCleanupRowDetails());
    void Promise.all(
      MAIL_CLEANUP_SCOPES.map((scope) => api.cleanupPreview(scope)),
    ).then((previews) => {
      if (!mounted.current || generation !== cleanupDetailsGeneration.current) return;
      if (previews.some((preview) =>
        preview.revision !== expected.revision ||
        preview.contactsRevision !== expected.contactsRevision ||
        preview.cleanupEpoch !== expected.cleanupEpoch
      )) return;
      const details = emptyCleanupRowDetails();
      for (const preview of previews) {
        details[preview.scope] = {
          count: Number(BigInt(preview.counts.total)),
          bytesLabel: formatBytes(BigInt(preview.counts.retainedBytes)),
        };
      }
      setCleanupRowDetails(details);
    }).catch(() => {
      // Each action still requests its own authoritative preview. A failed
      // background summary must not disable cleanup or expose a raw reject.
    });
  }, [
    api,
    navigation.route,
    status?.cleanupEpoch,
    status?.contactsRevision,
    status?.revision,
  ]);

  const rotateKey = useCallback(() => {
    const before = rotationProgress;
    if (!before || rotationPhase !== "idle") return;
    beginLifecycleCryptoSync();
    suppressRotationEffectBindingRef.current = null;
    const generation = ++rotationGeneration.current;
    rotationMutationPendingRef.current = true;
    setRotationPhase("rotating");
    setRotationError(null);
    setRotationNotice(null);
    // Starts the trusted lifecycle request in this activated click stack.
    const operation = startMailKeyRotation(before);
    void operation.then(async (progress) => {
      if (!mounted.current || generation !== rotationGeneration.current) return;
      const session = await recoverMailCryptoSessionForBinding(progress, crypto);
      if (!mounted.current || generation !== rotationGeneration.current) return;
      setRotationProgress(progress);
      commitLifecycleCryptoSession(session);
      suppressRotationEffectBindingRef.current = {
        currentEpoch: progress.currentEpoch,
        previousEpoch: progress.previousEpoch,
      };
      setRotationNotice("New current key created. Continue migration when you are ready.");
      rotationMutationPendingRef.current = false;
      setRotationPhase("idle");
      void refresh(navigation.folder, unreadOnly);
    }).catch((error) => {
      if (!mounted.current || generation !== rotationGeneration.current) return;
      rotationMutationPendingRef.current = false;
      setRotationPhase("idle");
      setRotationError(mailErrorMessage(error));
      void refreshRotation();
    });
  }, [beginLifecycleCryptoSync, commitLifecycleCryptoSession, crypto, navigation.folder, refresh, refreshRotation, rotationPhase, rotationProgress, unreadOnly]);

  const migrateKeyBatch = useCallback(() => {
    if (!rotationProgress?.previousEpoch || rotationPhase !== "idle") return;
    beginLifecycleCryptoSync();
    suppressRotationEffectBindingRef.current = null;
    const generation = ++rotationGeneration.current;
    rotationMutationPendingRef.current = true;
    setRotationPhase("migrating");
    setRotationError(null);
    setRotationNotice(null);
    void rotationMail.migrateStep().then(async (result) => {
      if (!mounted.current || generation !== rotationGeneration.current) return;
      const session = await recoverMailCryptoSessionForBinding(result.progress, crypto);
      if (!mounted.current || generation !== rotationGeneration.current) return;
      setRotationProgress(result.progress);
      commitLifecycleCryptoSession(session);
      suppressRotationEffectBindingRef.current = {
        currentEpoch: result.progress.currentEpoch,
        previousEpoch: result.progress.previousEpoch,
      };
      setRotationNotice(
        result.progress.readyToRetire
          ? "Migration complete. The previous generation has no local references."
          : result.changed === "0"
            ? `Scanned ${result.scanned} records. Continue to scan the next bounded batch.`
            : `Migrated ${result.changed} local ${result.changed === "1" ? "wrap" : "wraps"}.`,
      );
      rotationMutationPendingRef.current = false;
      setRotationPhase("idle");
      void refresh(navigation.folder, unreadOnly);
    }).catch((error) => {
      if (!mounted.current || generation !== rotationGeneration.current) return;
      rotationMutationPendingRef.current = false;
      setRotationPhase("idle");
      const message = error instanceof MailRotationError
        ? error.code === "current_locked" || error.code === "previous_locked"
          ? "Mail is still preparing the required key generations. Try again."
          : error.message
        : mailErrorMessage(error);
      // Refresh authoritative counters, then restore the actionable failure.
      // refreshRotation clears stale errors when it starts, so setting this
      // first would batch it away before the user could ever see it.
      const recovery = refreshRotation();
      const recoveryGeneration = rotationGeneration.current;
      void recovery.finally(() => {
        if (
          mounted.current &&
          recoveryGeneration === rotationGeneration.current
        ) setRotationError(message);
      });
    });
  }, [beginLifecycleCryptoSync, commitLifecycleCryptoSession, crypto, navigation.folder, refresh, refreshRotation, rotationMail, rotationPhase, rotationProgress?.previousEpoch, unreadOnly]);

  const retirePreviousKey = useCallback(() => {
    const before = rotationProgress;
    if (!before?.readyToRetire || rotationPhase !== "idle") return;
    beginLifecycleCryptoSync();
    suppressRotationEffectBindingRef.current = null;
    const generation = ++rotationGeneration.current;
    rotationMutationPendingRef.current = true;
    setRotationPhase("retiring");
    setRotationError(null);
    setRotationNotice(null);
    const operation = retireMailPreviousGeneration(before);
    void operation.then(async (progress) => {
      if (!mounted.current || generation !== rotationGeneration.current) return;
      const session = await recoverMailCryptoSessionForBinding(progress, crypto);
      if (!mounted.current || generation !== rotationGeneration.current) return;
      setRotationProgress(progress);
      commitLifecycleCryptoSession(session);
      suppressRotationEffectBindingRef.current = {
        currentEpoch: progress.currentEpoch,
        previousEpoch: progress.previousEpoch,
      };
      rotationMutationPendingRef.current = false;
      setRotationPhase("idle");
      setRotationNotice("Previous key retired. Current encrypted Mail remains available.");
      void refresh(navigation.folder, unreadOnly);
    }).catch((error) => {
      if (!mounted.current || generation !== rotationGeneration.current) return;
      rotationMutationPendingRef.current = false;
      setRotationPhase("idle");
      setRotationError(mailErrorMessage(error));
      void refreshRotation();
    });
  }, [beginLifecycleCryptoSync, commitLifecycleCryptoSession, crypto, navigation.folder, refresh, refreshRotation, rotationPhase, rotationProgress, unreadOnly]);

  const sendDraft = useCallback(async (candidate: MailComposerDraft) => {
    if (sendPending) return;
    const errors: MailComposerFieldErrors = {};
    try {
      validateSubject(candidate.subject);
    } catch {
      errors.subject = "Add a subject within the Mail limit.";
    }
    try {
      validateBodyMarkdown(candidate.bodyMarkdown);
    } catch {
      errors.body = "Message must be at most 32 KiB without unsupported controls.";
    }
    if (candidate.mode === "new" && candidate.recipient === null) {
      errors.recipient = "Choose a Contact or the exact Neutron principal shown below.";
    }
    let name = senderName;
    if (name === null) {
      try {
        name = validateClaimedSenderName(candidate.senderNameSetup ?? "");
      } catch {
        errors.senderName = "Choose the name recipients will see inside encrypted Mail.";
      }
    }
    if (candidate.mode === "reply" && !candidate.replyTo) {
      errors.recipient = "Reopen the original message before replying.";
    }
    if (Object.keys(errors).length > 0) {
      setComposerErrors(errors);
      setStatusMessage("Review the highlighted Mail fields");
      return;
    }
    if (deliverySetupState !== "ready") {
      setStatusMessage("Finish the one-time Mail setup before sending. Your draft is unchanged.");
      if (deliverySetupState === "checking" || deliverySetupState === "unavailable") {
        void checkDeliverySetup({ announce: true });
      }
      return;
    }
    if (
      candidate.recipient?.source === "principal" &&
      confirmedDirectPrincipalRef.current !== candidate.recipient.principal
    ) {
      setPendingConfirmation({
        kind: "direct_recipient",
        draft: candidate,
        principal: candidate.recipient.principal,
      });
      return;
    }

    setSendPending(true);
    setComposerErrors({});
    setStatusMessage("Encrypting private Mail in this browser…");
    const commandId = sendCommandIdRef.current ?? secureMailCommandId();
    sendCommandIdRef.current = commandId;
    const request: MailPrivateSendRequest = candidate.mode === "reply"
      ? {
          kind: "reply",
          commandId,
          replyTo: candidate.replyTo!,
          subject: candidate.subject,
          bodyMarkdown: candidate.bodyMarkdown,
        }
      : {
          kind: "new",
          commandId,
          recipient: recipientBinding(candidate.recipient!),
          subject: candidate.subject,
          bodyMarkdown: candidate.bodyMarkdown,
        };
    try {
      if (senderName === null) {
        const settings = await composeMail.setSenderName(name!);
        setSenderName(settings.senderName);
      }
      const delivery = await composeMail.send(request);
      setPendingConfirmation(null);
      draftDirtyRef.current = false;
      sendCommandIdRef.current = null;
      confirmedDirectPrincipalRef.current = null;
      setDraft(EMPTY_MAIL_DRAFT);
      const folder: MailFolder = delivery.status === "accepted" ? "sent" : "outbox";
      const completionStatus = deliveryStatusMessage(
        delivery.status,
        delivery.notSentReason,
      );
      await refresh(folder, false);
      if (candidate.mode === "reply" && candidate.replyTo) {
        try {
          // Sending advances the global Mail revision, so the resident has
          // correctly discarded every older cross-folder header. Revalidate
          // the exact Inbox target under the new revision before opening the
          // reply; unresolved/deleted targets simply produce no thread label.
          await privateMail.get("inbox", candidate.replyTo.localId);
        } catch (error) {
          if (error instanceof MailPrivateError && error.code !== "temporarily_unavailable") {
            markPrivateMailUnavailable(privateReadinessErrorMessage(error));
          }
        }
      }
      await openExactMessage(folder, delivery.localId);
      // Opening the new local record uses the same reader path as ordinary
      // navigation, including its transient preparation announcement. Restore
      // the send result after that reader settles so assistive technology gets
      // the authoritative delivery outcome instead of an empty live region.
      if (mounted.current) setStatusMessage(completionStatus);
    } catch (error) {
      if (error instanceof MailComposeError && error.code === "permission_required") {
        const reservationState = await checkDeliverySetup();
        if (mounted.current) {
          setStatusMessage(
            reservationState?.complete
              ? "Mail cannot reach that recipient because its canister or Mail protocol methods are reserved by another app. Review Backend Access in Neutron Settings. Your draft is unchanged."
              : "Finish the one-time Mail setup before sending. Your draft is unchanged.",
          );
        }
      } else {
        setStatusMessage(mailErrorMessage(error));
      }
    } finally {
      setSendPending(false);
    }
  }, [checkDeliverySetup, composeMail, deliverySetupState, markPrivateMailUnavailable, openExactMessage, privateMail, refresh, sendPending, senderName]);

  const cancelConfirmation = useCallback(() => {
    setPendingConfirmation(null);
  }, []);

  const confirmPendingAction = useCallback(() => {
    const pending = pendingConfirmation;
    if (!pending) return;
    setPendingConfirmation(null);
    if (pending.kind === "direct_recipient") {
      if (
        navigation.route !== "compose" ||
        pending.draft !== draft ||
        pending.draft.recipient?.source !== "principal" ||
        pending.draft.recipient.principal !== pending.principal ||
        sendPending
      ) {
        return;
      }
      confirmedDirectPrincipalRef.current = pending.principal;
      void sendDraft(pending.draft);
      return;
    }
    const currentKind = composerLeaveConfirmationKind(
      navigation.route,
      draftDirtyRef.current,
      sendPending,
    );
    if (currentKind === null || (currentKind === "sending") !== pending.sending) return;
    confirmedNavigationRef.current = true;
    onNavigate(pending.event);
  }, [draft, navigation.route, onNavigate, pendingConfirmation, sendDraft, sendPending]);

  const editMessageCopy = useCallback((id: string) => {
    const message = selectedMessage;
    if (
      !message ||
      message.id !== id ||
      message.folder !== "outbox" ||
      (message.deliveryStatus !== "not_sent" &&
        message.deliveryStatus !== "delivery_uncertain") ||
      message.subject === null ||
      message.bodyMarkdown === null
    ) return;
    const recipient = message.recipient;
    const label = recipient.trust === "in_contacts" && recipient.contactName?.trim()
      ? recipient.contactName.trim()
      : recipient.claimedName?.trim() || recipient.principal;
    setDraft({
      mode: "new",
      recipientInput: label,
      recipient: {
        principal: recipient.principal,
        label,
        // The Outbox projection authenticates this principal but does not
        // carry the current Contacts id/revision pair. Keep the copy direct.
        source: "principal",
      },
      subject: message.subject,
      bodyMarkdown: message.bodyMarkdown,
      replyTo: null,
    });
    draftDirtyRef.current = true;
    sendCommandIdRef.current = null;
    confirmedDirectPrincipalRef.current = null;
    selectedIdRef.current = null;
    setSelectionUnavailableMessage(null);
    setComposerErrors({});
    setRecipientOptions([]);
    setNavigation((current) => reduceMailUiNavigation(current, { type: "compose" }));
    setStatusMessage("Editing a new copy. The original Outbox record is unchanged.");
  }, [selectedMessage]);

  const retryMessage = useCallback(async (id: string) => {
    const target = parseMailMessageKey(id);
    if (!target || target.folder !== "outbox" || retryPendingId !== null) return;
    setRetryPendingId(id);
    setStatusMessage("Retrying the exact encrypted message…");
    try {
      const delivery = await composeMail.retry(target.localId);
      const folder: MailFolder = delivery.status === "accepted" ? "sent" : "outbox";
      const completionStatus = deliveryStatusMessage(
        delivery.status,
        delivery.notSentReason,
      );
      await refresh(folder, false);
      await openExactMessage(folder, delivery.localId);
      if (mounted.current) setStatusMessage(completionStatus);
    } catch (error) {
      setStatusMessage(mailErrorMessage(error));
    } finally {
      setRetryPendingId(null);
    }
  }, [composeMail, openExactMessage, refresh, retryPendingId]);

  const requestCleanup = useCallback(async (scope: MailBackendCleanupPreview["scope"]) => {
    setCleanupError(null);
    setStatusMessage("Preparing an authoritative cleanup preview…");
    try {
      const preview = await api.cleanupPreview(scope);
      setCleanupPreview(preview);
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(mailErrorMessage(error));
    }
  }, [api]);

  const confirmCleanup = useCallback(async (
    scope: MailBackendCleanupPreview["scope"],
    previewToken: string,
  ) => {
    if (
      !cleanupPreview ||
      cleanupPending ||
      cleanupPreview.scope !== scope ||
      cleanupPreview.previewToken !== previewToken
    ) {
      setCleanupError("Cleanup preview changed. Close it and review again.");
      return;
    }
    setCleanupPending(true);
    setCleanupError(null);
    try {
      const result = await api.cleanupCommit(cleanupPreview);
      setCleanupPreview(null);
      setStatusMessage(
        result.changed === "0" ? "Nothing needed deletion" : `${result.changed} messages deleted`,
      );
      setSelectedMessage(null);
      // Keep Storage mounted so the dialog can restore focus to the cleanup
      // action whose authoritative count was just refreshed.
      setNavigation((current) => ({ ...current, selectedId: null }));
      await refresh(navigation.folder, unreadOnly);
    } catch (error) {
      setCleanupError(mailErrorMessage(error));
    } finally {
      setCleanupPending(false);
    }
  }, [api, cleanupPending, cleanupPreview, navigation.folder, refresh, unreadOnly]);

  const changePage = useCallback(async (direction: "previous" | "next") => {
    const current = snapshotState.snapshot;
    if (!current || current.folder !== navigation.folder || snapshotState.loading) return;
    const previousOffset = pageHistoryRef.current.at(-1) ?? null;
    const targetOffset = direction === "next"
      ? current.page.nextOffset
      : previousOffset ?? (
          current.offset === "0"
            ? null
            : (BigInt(current.offset) > 50n ? BigInt(current.offset) - 50n : 0n).toString()
        );
    if (targetOffset === null || targetOffset === current.offset) return;
    const generation = ++refreshGeneration.current;
    dispatchSnapshot({ type: "refresh_started" });
    try {
      const snapshot = await loadRevisionBoundMailPage(api, current, targetOffset, 50);
      if (generation !== refreshGeneration.current) return;
      let nextPrivateRows = new Map<string, MailPrivateRow>();
      if (current.status.privateMailActive) {
        try {
          await ensurePrivateMailReady(current.status, { force: true });
          nextPrivateRows = await loadPrivateRowsWithRecovery(
            () => loadPrivateRowsForSnapshot(privateMail, snapshot, current.unreadOnly),
            async () => {
              if (generation !== refreshGeneration.current) {
                throw new Error("Mail page change was superseded");
              }
              invalidatePrivateReadiness();
              rememberCryptoSession(null);
              await ensurePrivateMailReady(current.status, { force: true });
            },
          );
        } catch (error) {
          if (generation !== refreshGeneration.current) return;
          markPrivateMailUnavailable(privateReadinessErrorMessage(error));
        }
      }
      if (generation !== refreshGeneration.current) return;
      if (direction === "next") {
        pageHistoryRef.current = [...pageHistoryRef.current, current.offset];
      } else if (previousOffset === targetOffset) {
        pageHistoryRef.current = pageHistoryRef.current.slice(0, -1);
      }
      applyLoadedSnapshot(snapshot, nextPrivateRows);
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      if (
        (error instanceof MailBackendMailboxError && error.code === "CONFLICT") ||
        (error instanceof Error && /\bchanged\b/iu.test(error.message))
      ) {
        pageHistoryRef.current = [];
        setStatusMessage("Mail changed while changing pages. Returned to the first page.");
        await refresh(navigation.folder, unreadOnly, { offset: "0" });
        return;
      }
      dispatchSnapshot({ type: "refresh_failed", message: mailErrorMessage(error) });
    }
  }, [
    api,
    applyLoadedSnapshot,
    ensurePrivateMailReady,
    invalidatePrivateReadiness,
    markPrivateMailUnavailable,
    navigation.folder,
    privateMail,
    refresh,
    rememberCryptoSession,
    snapshotState,
    unreadOnly,
  ]);

  const page = snapshotState.snapshot?.page ?? null;
  const pageForView = snapshotState.snapshot?.folder === navigation.folder &&
    snapshotState.snapshot.unreadOnly === unreadOnly
    ? page
    : null;
  const lockState = mailLockState(status, cryptoSession);
  const privateMailState = status === null || cryptoPhase !== "idle"
    ? "preparing" as const
    : cryptoError
      ? "unavailable" as const
      : !status.privateMailActive
        ? "not_configured" as const
        : lockState === "unlocked"
          ? "ready" as const
          : "preparing" as const;
  const messages = useMemo(
    () => snapshotState.snapshot?.folder === navigation.folder
      ? page?.items.map((item) => {
          const row = privateRows.get(mailMessageKey(item.kind, item.localId));
          return lockState === "unlocked" && row
            ? decryptedMessageSummary(row, neutronAddress ?? "This Neutron")
            : lockedMessageSummary(item);
        }) ?? []
      : [],
    [
      lockState,
      navigation.folder,
      neutronAddress,
      page,
      privateRows,
      snapshotState.snapshot?.folder,
    ],
  );
  const counts = statusCounts(status);
  const visibleError = detailError ?? snapshotState.error;
  const staleStatus = snapshotState.stale
    ? `Showing the last confirmed snapshot. ${snapshotState.error ?? "Refresh failed."}`
    : statusMessage;
  const cryptoNotice = cryptoError ?? (
    cryptoPhase === "activating"
      ? "Setting up private Mail…"
      : cryptoPhase === "syncing"
        ? "Preparing private Mail…"
        : null
  );
  const confirmationDialog = pendingConfirmation === null
    ? null
    : pendingConfirmation.kind === "direct_recipient"
      ? {
          title: "Send to a direct address?",
          description: "This address is not bound to a current Contacts revision. Check the full principal before sending private Mail.",
          confirmLabel: "Send to this address",
          detailLabel: "Exact Neutron principal",
          detailValue: pendingConfirmation.principal,
        }
      : pendingConfirmation.sending
        ? {
            title: "Leave while sending?",
            description: "The encrypted send is still being reconciled. Leaving this composer cannot cancel the remote call.",
            confirmLabel: "Leave composer",
            destructive: true,
          }
        : {
            title: "Discard this draft?",
            description: "Your unsent draft exists only in this tile. Leaving the composer discards it.",
            cancelLabel: "Continue editing",
            confirmLabel: "Discard message",
            destructive: true,
          };

  return (
    <MailUi
      navigation={navigation}
      privateMailState={privateMailState}
      counts={counts}
      messages={messages}
      selectedMessage={selectedMessage}
      neutronAddress={neutronAddress}
      lifecycleKeyManager={status?.keyHolder ?? null}
      unreadOnly={unreadOnly}
      searchQuery={searchQuery}
      composer={draft}
      composerErrors={composerErrors}
      recipientOptions={recipientOptions}
      senderName={senderName}
      senderSettingsPending={senderSettingsPending}
      senderSettingsError={senderSettingsError}
      keyRotationPanel={status?.privateMailActive ? (
        <MailKeyRotationPanel
          progress={rotationProgress}
          phase={rotationPhase}
          notice={rotationNotice}
          error={rotationError}
          onRefresh={() => void refreshRotation()}
          onRotate={rotateKey}
          onMigrate={migrateKeyBatch}
          onRetire={retirePreviousKey}
        />
      ) : undefined}
      storage={{
        ...storageSummary(status),
        cleanupDetails: cleanupRowDetails,
      }}
      cleanupDialog={
        cleanupPreview
          ? cleanupDialog(cleanupPreview, cleanupPending, cleanupError)
          : null
      }
      confirmationDialog={confirmationDialog}
      loading={snapshotState.loading && snapshotState.snapshot === null}
      pageLoading={snapshotState.loading && snapshotState.snapshot !== null}
      {...(pageForView && snapshotState.snapshot
        ? {
            pageOffset: Number(BigInt(snapshotState.snapshot.offset)),
            pageTotal: boundedCount(pageForView.total),
            hasPreviousPage: snapshotState.snapshot.offset !== "0",
            hasNextPage: pageForView.nextOffset !== null,
          }
        : {})}
      error={visibleError}
      statusMessage={staleStatus}
      privateMailNotice={cryptoNotice}
      sendPending={sendPending}
      deliverySetupState={deliverySetupState}
      deliverySetupNotice={deliverySetupNotice}
      retryPendingId={retryPendingId}
      newMailCount={newMailCount}
      selectionUnavailableMessage={selectionUnavailableMessage}
      onNavigate={onNavigate}
      onUnreadOnlyChange={setUnreadOnly}
      onSearchQueryChange={setSearchQuery}
      onDraftChange={changeDraft}
      onChooseRecipient={chooseRecipient}
      onManageContacts={() => {
        void openAppTile({
          appId: "contacts",
          tileId: "contacts",
          reuseExisting: true,
        });
      }}
      onAddToContacts={(identity) => {
        setDetailError(null);
        setStatusMessage("Opening Contacts…");
        void openPrefilledContact({
          suggestedName: identity.claimedName?.trim() || identity.principal,
          neutronPrincipal: identity.principal,
        })
          .then((result) => {
            setStatusMessage(
              result === "busy"
                ? "Contacts kept its existing unsaved edit"
                : "Contact draft is ready to review",
            );
          })
          .catch((error) => {
            setDetailError(mailErrorMessage(error));
            setStatusMessage(null);
          });
      }}
      onInsertMarkdown={insertMarkdown}
      onSend={(nextDraft) => void sendDraft(nextDraft)}
      onToggleRead={(id, read) => void toggleRead(id, read)}
      onDeleteMessage={(id) => void deleteMessage(id)}
      onRetryMessage={(id) => void retryMessage(id)}
      onEditMessageCopy={editMessageCopy}
      onShowNewMail={showNewMail}
      onSetSenderName={(name) => void saveSenderName(name)}
      onSetUpPrivateMail={activateMail}
      onRetryPrivateMail={retryPrivateMail}
      onSetUpDelivery={() => void completeDeliverySetup()}
      onPreviousPage={() => void changePage("previous")}
      onNextPage={() => void changePage("next")}
      onRequestCleanup={(scope) => void requestCleanup(scope)}
      onCancelCleanup={() => {
        if (!cleanupPending) {
          setCleanupPreview(null);
          setCleanupError(null);
        }
      }}
      onConfirmCleanup={(scope, token) => void confirmCleanup(scope, token)}
      onCancelConfirmation={cancelConfirmation}
      onConfirmConfirmation={confirmPendingAction}
    />
  );
}

export function MailTray({
  api = MAIL_OWNER_API,
  projectionApi,
}: {
  api?: MailOwnerApi;
  projectionApi?: Pick<MailTrayProjectionClient, "snapshot">;
}) {
  const privateProjection = useMemo(
    () => projectionApi ?? new MailTrayProjectionClient(),
    [projectionApi],
  );
  const [state, dispatch] = useReducer(reduceMailSnapshot, INITIAL_MAIL_SNAPSHOT_STATE);
  const [projection, setProjection] = useState<MailTrayProjection | null>(null);
  const [projectionError, setProjectionError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const generation = useRef(0);
  const snapshotRef = useRef<MailSnapshot | null>(null);
  const pulseBaselineRef = useRef<MailBackendPulse | null>(null);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    dispatch({ type: "refresh_started" });
    setProjection((value) => value?.state === "ready"
      ? value
      : { version: 1, state: "loading" });
    try {
      const snapshot = await loadAuthoritativeMailSnapshot(api, "inbox", 5);
      if (generation.current !== current) return;
      snapshotRef.current = snapshot;
      pulseBaselineRef.current = mailPulseFromStatus(snapshot.status);
      dispatch({ type: "refresh_succeeded", snapshot });
      if (!snapshot.status.privateMailActive) {
        setProjection({ version: 1, state: "not_configured" });
        setProjectionError(null);
        return;
      }
      try {
        const next = await privateProjection.snapshot({
          expectedRevision: snapshot.status.revision,
          expectedContactsRevision: snapshot.status.contactsRevision,
        });
        if (generation.current !== current) return;
        setProjection(next);
        setProjectionError(next.state === "unavailable"
          ? "Private headers are temporarily unavailable."
          : null);
      } catch {
        if (generation.current !== current) return;
        setProjection({ version: 1, state: "unavailable" });
        setProjectionError("Private headers are temporarily unavailable.");
      }
    } catch (error) {
      if (generation.current === current) {
        // This tray frame has already received and rendered the bounded header
        // projection. Retain that exact in-memory snapshot during a temporary
        // owner/status outage so the tray does not replace useful rows with
        // generic placeholders. A frame reload still starts empty and must
        // revalidate the resident session before receiving private headers.
        setProjection((value) => value?.state === "ready"
          ? value
          : { version: 1, state: "unavailable" });
        setProjectionError("Private headers are unavailable until Mail can revalidate its key session.");
        dispatch({ type: "refresh_failed", message: mailErrorMessage(error) });
      }
    }
  }, [api, privateProjection]);

  const poll = useCallback(async () => {
    const startedAtGeneration = generation.current;
    const previous = snapshotRef.current;
    if (previous) {
      try {
        const observed = pulseBaselineRef.current ?? mailPulseFromStatus(previous.status);
        const probe = await probeMailPulseBinding(
          api,
          previous,
          observed,
          "inbox",
          false,
          previous.offset,
        );
        if (generation.current !== startedAtGeneration) return;
        if (!probe.changed) return;
      } catch {
        // The full tray refresh below retains its last authenticated frame on
        // a transient pulse or status outage.
      }
    }
    if (generation.current === startedAtGeneration) await refresh();
  }, [api, refresh]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void poll(), 30_000);
    return () => window.clearInterval(interval);
  }, [poll, refresh]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") void dismissTray();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  async function openMail(view?: string): Promise<void> {
    const opening = openAppTile({
      appId: "mail",
      tileId: "mail",
      reuseExisting: true,
      ...(view ? { view } : {}),
    });
    try {
      await opening;
      await dismissTray();
    } catch (error) {
      dispatch({ type: "refresh_failed", message: mailErrorMessage(error) });
    }
  }

  return (
    <MailTrayView
      state={state}
      projection={projection}
      projectionError={projectionError}
      openingId={openingId}
      onRetry={() => void refresh()}
      onOpenMail={() => void openMail()}
      onOpenMessage={(localId) => {
        setOpeningId(localId);
        void openMail(`message/${localId}`).finally(() => setOpeningId(null));
      }}
    />
  );
}

export function MailTrayView({
  state,
  projection = null,
  projectionError = null,
  openingId,
  onRetry,
  onOpenMail,
  onOpenMessage,
}: {
  state: MailSnapshotState;
  projection?: MailTrayProjection | null;
  projectionError?: string | null;
  openingId: string | null;
  onRetry: () => void;
  onOpenMail: () => void;
  onOpenMessage: (localId: string) => void;
}) {
  const snapshot = state.snapshot;
  const unread = snapshot ? boundedCount(snapshot.status.unread) : 0;
  const rows = snapshot?.page.items.filter((item) => item.kind === "inbox").slice(0, 5) ?? [];
  const readyPage = snapshot && trayProjectionMatchesSnapshot(projection, snapshot)
    ? projection.page
    : null;
  const decryptedById = new Map(
    readyPage?.items.map((row) => [row.localId, row]) ?? [],
  );
  return (
    <main className="nt-app mail-tray" aria-label="Recent private mail">
      <header className="mail-tray-header">
        <div>
          <h1>Recent mail{snapshot ? ` · ${unread} unread` : ""}</h1>
          {state.stale ? <span className="mail-tray-stale">Stale snapshot</span> : null}
        </div>
        <button
          type="button"
          className="nt-icon-button"
          title="Retry"
          aria-label="Retry loading mail"
          disabled={state.loading}
          onClick={onRetry}
        >
          ↻
        </button>
      </header>

      {state.error ? (
        <div className="mail-tray-error" role={snapshot ? "status" : "alert"}>
          {snapshot ? `Showing the last confirmed snapshot. ${state.error}` : state.error}
        </div>
      ) : null}
      <div className="mail-tray-list" aria-busy={state.loading || undefined}>
        {!snapshot && state.loading ? (
          <div className="mail-tray-empty" role="status">Loading recent mail…</div>
        ) : !snapshot ? (
          <div className="mail-tray-empty">
            <strong>Mail is unavailable</strong>
            <button
              type="button"
              className="nt-button nt-button--secondary nt-button--sm"
              onClick={onRetry}
            >
              Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="mail-tray-empty">
            <strong>No Inbox mail</strong>
            <span>{snapshot.status.privateMailActive ? "New private messages will appear here." : "Open Mail to activate private receiving."}</span>
          </div>
        ) : (
          rows.map((item) => {
            if (item.kind !== "inbox") return null;
            const time = formatMailTimestamp(item.receivedAtNs);
            const label = currentContactLabel(item.sender, item.currentContact);
            const trust = currentContactTrustLabel(item.currentContact);
            const privateRow = decryptedById.get(item.localId);
            const summary = privateRow
              ? decryptedMessageSummary(privateRow, "This Neutron")
              : null;
            const senderLabel = summary ? trayIdentityLabel(summary.sender) : label;
            const subject = summary?.decryptionState === "ready"
              ? summary.subject || "(No subject)"
              : summary?.decryptionState === "corrupt"
                ? "Private header unavailable"
                : "Private message";
            return (
              <button
                type="button"
                className={`mail-tray-row${item.read ? "" : " mail-tray-row--unread"}`}
                key={item.localId}
                disabled={openingId === item.localId}
                aria-label={`${item.read ? "Read" : "Unread"}. From ${senderLabel}. ${trust}. ${subject}. ${time.label}`}
                onClick={() => {
                  // The controller invokes openAppTile synchronously from this
                  // trusted click, before awaiting or dismissing the tray.
                  onOpenMessage(item.localId);
                }}
              >
                <span className="mail-tray-unread" aria-hidden="true" />
                <span className="mail-tray-row-copy">
                  <strong dir="auto">{senderLabel}</strong>
                  <span dir="auto">{trust} · {subject}</span>
                </span>
                <time dateTime={time.iso}>{time.relative}</time>
              </button>
            );
          })
        )}
      </div>

      {snapshot && !readyPage ? (
        <p
          className={`mail-tray-private-note${projection?.state === "unavailable" ? " mail-tray-private-note--error" : ""}`}
          role={projection?.state === "unavailable" ? "alert" : "status"}
        >
          {projection?.state === "not_configured"
            ? "Set up private Mail once to receive and read encrypted messages."
            : projection?.state === "unavailable"
              ? projectionError ?? "Private headers are temporarily unavailable. Retry or open Mail."
              : "Preparing private Mail…"}
        </p>
      ) : null}
      <footer className="mail-tray-footer">
        <button type="button" className="nt-button" onClick={onOpenMail}>
          Open Mail
        </button>
      </footer>
    </main>
  );
}

function snapshotContainsMessage(snapshot: MailSnapshot, id: string): boolean {
  const target = parseMailMessageKey(id);
  return target !== null &&
    snapshot.folder === target.folder &&
    snapshot.page.items.some((item) =>
      item.kind === target.folder && item.localId === target.localId
    );
}

function trayProjectionMatchesSnapshot(
  projection: MailTrayProjection | null,
  snapshot: MailSnapshot,
): projection is Extract<MailTrayProjection, { state: "ready" }> {
  if (projection?.state !== "ready") return false;
  const page = projection.page;
  return page.revision === snapshot.page.revision &&
    page.contactsRevision === snapshot.page.contactsRevision &&
    page.cleanupEpoch === snapshot.page.cleanupEpoch &&
    page.total === snapshot.page.total &&
    page.nextOffset === snapshot.page.nextOffset &&
    page.ciphertextBytes === snapshot.page.ciphertextBytes &&
    page.items.length === snapshot.page.items.length &&
    page.items.every((row, index) => {
      const outer = snapshot.page.items[index];
      return outer?.kind === "inbox" &&
        row.folder === "inbox" &&
        row.localId === outer.localId;
    });
}

function trayIdentityLabel(identity: MailIdentity): string {
  if (identity.trust === "contact_conflict") return "Unknown sender";
  if (identity.trust === "in_contacts" && identity.contactName?.trim()) {
    return identity.contactName.trim();
  }
  return identity.claimedName?.trim() || shortPrincipal(identity.principal);
}

function statusCounts(status: MailBackendStatus | null): {
  inbox: number;
  sent: number;
  outbox: number;
  unread: number;
} {
  return status
    ? {
        inbox: boundedCount(status.inboxCount),
        sent: boundedCount(status.sentCount),
        outbox: boundedCount(status.outboxCount),
        unread: boundedCount(status.unread),
      }
    : { inbox: 0, sent: 0, outbox: 0, unread: 0 };
}

function privateReadinessErrorMessage(error: unknown): string {
  const message = mailErrorMessage(error);
  return /\b(?:un)?lock(?:ed|ing)?\b/iu.test(message)
    ? "Private Mail is temporarily unavailable. Try again."
    : message;
}

function boundedCount(value: string): number {
  const parsed = BigInt(value);
  return parsed > 9_999n ? 9_999 : Number(parsed);
}

export function countInboxStatusArrivals(
  previous: MailBackendStatus,
  next: MailBackendStatus,
): number {
  const inboxIncrease = BigInt(next.inboxCount) - BigInt(previous.inboxCount);
  return inboxIncrease > 0n ? boundedCount(inboxIncrease.toString()) : 0;
}

function recipientBinding(option: MailRecipientOption): MailComposeRecipient {
  if (
    option.source === "contact" &&
    option.contactId &&
    option.contactRevision
  ) {
    return {
      kind: "contact",
      principal: option.principal,
      contactId: option.contactId,
      expectedContactRevision: option.contactRevision,
    };
  }
  return { kind: "direct", principal: option.principal };
}

function canonicalCanisterPrincipal(value: string): string | null {
  if (!value) return null;
  try {
    const principal = Principal.fromText(value);
    const bytes = principal.toUint8Array();
    return principal.toText() === value &&
      bytes.byteLength >= 1 &&
      bytes.byteLength <= 29 &&
      bytes[bytes.byteLength - 1] === 1
      ? value
      : null;
  } catch {
    return null;
  }
}

function secureMailCommandId(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new MailComposeError(
      "temporarily_unavailable",
      "Secure Mail command reconciliation is unavailable in this browser.",
    );
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    if (bytes.some(Boolean)) {
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }
  throw new MailComposeError(
    "temporarily_unavailable",
    "Secure Mail command reconciliation is unavailable in this browser.",
  );
}

function deliveryStatusMessage(
  status: MailPrivateDelivery["status"],
  reason: MailPrivateDelivery["notSentReason"],
): string {
  if (status === "accepted") return "Sent — accepted by recipient canister";
  if (status === "sending") return "Encrypted Mail is sending";
  if (status === "delivery_uncertain") {
    return "Delivery uncertain. Retry reuses the exact encrypted message.";
  }
  switch (reason) {
    case "rate_limited": return "Not sent. That mailbox is accepting mail slowly; try again later.";
    case "mailbox_full": return "Not sent. That mailbox is full.";
    case "crypto_unavailable": return "Not sent. The recipient's private Mail key is temporarily unavailable.";
    case "permission_required": return "Not sent. Finish Mail setup if offered; otherwise this recipient is reserved in Backend Access.";
    case "stale_key": return "Not sent because the recipient key changed twice. Try again.";
    default: return "Not sent. The encrypted Outbox copy is available to review.";
  }
}

function shortPrincipal(principal: string): string {
  return principal.length <= 22
    ? principal
    : `${principal.slice(0, 10)}…${principal.slice(-8)}`;
}

function currentContactLabel(
  principal: string,
  currentContact: MailBackendCurrentContact,
): string {
  if (currentContact.status === "in_contacts") return currentContact.contactName;
  if (currentContact.status === "contact_conflict") return "Unknown sender";
  return shortPrincipal(principal);
}

function currentContactTrustLabel(currentContact: MailBackendCurrentContact): string {
  if (currentContact.status === "in_contacts") return "In Contacts";
  if (currentContact.status === "contact_conflict") return "Contact conflict";
  return "Not in Contacts";
}

async function loadPrivateRowsForSnapshot(
  privateMail: MailPrivateTilePort,
  snapshot: MailSnapshot,
  unreadOnly: boolean,
): Promise<Map<string, MailPrivateRow>> {
  const rows = new Map<string, MailPrivateRow>();
  const expected = snapshot.page.items;
  let index = 0;
  let offset = snapshot.offset;
  let ciphertextBytes = 0n;
  let finalNextOffset: string | null = null;
  while (index < expected.length) {
    const limit = Math.min(50, expected.length - index);
    const page = await privateMail.list({
      folder: snapshot.folder,
      unreadOnly,
      offset,
      limit,
      expectedRevision: snapshot.status.revision,
      expectedContactsRevision: snapshot.status.contactsRevision,
    });
    const end = BigInt(offset) + BigInt(page.items.length);
    const expectedNext = end < BigInt(page.total) ? end.toString() : null;
    if (
      page.revision !== snapshot.page.revision ||
      page.contactsRevision !== snapshot.page.contactsRevision ||
      page.cleanupEpoch !== snapshot.page.cleanupEpoch ||
      page.total !== snapshot.page.total ||
      page.items.length < 1 ||
      page.items.length > limit ||
      page.nextOffset !== expectedNext ||
      page.items.some((row, pageIndex) => {
        const outer = expected[index + pageIndex];
        return !outer ||
          row.folder !== snapshot.folder ||
          outer.kind !== snapshot.folder ||
          row.localId !== outer.localId;
      })
    ) {
      throw new MailPrivateError(
        "temporarily_unavailable",
        "Mail changed while decrypting. Refresh and try again.",
      );
    }
    for (const row of page.items) {
      const key = mailMessageKey(row.folder, row.localId);
      if (rows.has(key)) {
        throw new MailPrivateError(
          "temporarily_unavailable",
          "Mail repeated a private message while decrypting.",
        );
      }
      rows.set(key, row);
    }
    index += page.items.length;
    ciphertextBytes += BigInt(page.ciphertextBytes);
    finalNextOffset = page.nextOffset;
    if (page.nextOffset === null && index < expected.length) {
      throw new MailPrivateError(
        "temporarily_unavailable",
        "Mail ended while decrypting the loaded window.",
      );
    }
    offset = page.nextOffset ?? offset;
  }
  if (
    ciphertextBytes.toString() !== snapshot.page.ciphertextBytes ||
    finalNextOffset !== snapshot.page.nextOffset
  ) {
    throw new MailPrivateError(
      "temporarily_unavailable",
      "Mail changed while validating decrypted headers.",
    );
  }
  return rows;
}

export async function loadPrivateRowsWithRecovery<T>(
  load: () => Promise<T>,
  recover: () => Promise<void>,
): Promise<T> {
  try {
    return await load();
  } catch {
    await recover();
    return load();
  }
}
