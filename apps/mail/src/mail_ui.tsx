import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { copyToClipboard } from "neutron-tools/app";
import { SafeMailMarkdown } from "./safe_markdown.tsx";
import type { MailDeliveryStatus, MailFolder, MailPrivateAvailability, MailTrust } from "./model.ts";
import { MAIL_MAX_ENVELOPE_BYTES } from "./protocol.ts";

export type MailUiRoute = "list" | "reader" | "compose" | "settings";
export type MailComposerTab = "editor" | "preview";
export type MailComposeMode = "new" | "reply";

type DefaultPreventingEvent = {
  preventDefault(): void;
};

export type MailUiNavigation = {
  folder: MailFolder;
  route: MailUiRoute;
  selectedId: string | null;
  composeMode: MailComposeMode | null;
  composerTab: MailComposerTab;
};

export type MailUiNavigationEvent =
  | { type: "select_folder"; folder: MailFolder }
  | { type: "select_message"; id: string }
  | { type: "compose" }
  | { type: "reply"; id: string }
  | { type: "settings" }
  | { type: "back" }
  | { type: "composer_tab"; tab: MailComposerTab };

export function requestComposerSend(
  event: DefaultPreventingEvent,
  draft: MailComposerDraft,
  sendPending: boolean | undefined,
  onSend: (draft: MailComposerDraft) => void,
): void {
  event.preventDefault();
  if (!sendPending) onSend(draft);
}

export function reduceMailUiNavigation(
  state: MailUiNavigation,
  event: MailUiNavigationEvent,
): MailUiNavigation {
  switch (event.type) {
    case "select_folder":
      return {
        ...state,
        folder: event.folder,
        route: "list",
        selectedId: null,
        composeMode: null,
      };
    case "select_message":
      return {
        ...state,
        route: "reader",
        selectedId: event.id,
        composeMode: null,
      };
    case "compose":
      return {
        ...state,
        route: "compose",
        selectedId: null,
        composeMode: "new",
        composerTab: "editor",
      };
    case "reply":
      return {
        ...state,
        route: "compose",
        selectedId: event.id,
        composeMode: "reply",
        composerTab: "editor",
      };
    case "settings":
      return { ...state, route: "settings", composeMode: null };
    case "back":
      if (state.route === "compose" && state.composeMode === "reply" && state.selectedId) {
        return { ...state, route: "reader", composeMode: null };
      }
      return { ...state, route: "list", selectedId: null, composeMode: null };
    case "composer_tab":
      return { ...state, composerTab: event.tab };
  }
}

export type MailIdentity = {
  principal: string;
  trust: MailTrust;
  contactName?: string | null;
  claimedName?: string | null;
};

export type MailMessageSummary = {
  id: string;
  folder: MailFolder;
  read: boolean;
  sender: MailIdentity;
  recipient: MailIdentity;
  subject: string | null;
  timestampLabel: string;
  timestampIso: string;
  deliveryStatus?: MailDeliveryStatus;
  decryptionState?: "ready" | "corrupt";
};

export type MailMessageDetail = MailMessageSummary & {
  bodyMarkdown: string | null;
  replyContextLabel?: string | null;
  senderTimestampLabel?: string | null;
  senderTimestampIso?: string | null;
};

export type MailRecipientOption = {
  principal: string;
  label: string;
  source: "contact" | "principal";
  contactId?: string;
  contactRevision?: string;
};

export type MailComposerDraft = {
  mode: MailComposeMode;
  recipientInput: string;
  recipient: MailRecipientOption | null;
  subject: string;
  bodyMarkdown: string;
  senderNameSetup?: string;
  replyTo?: { folder: "inbox"; localId: string } | null;
};

export type MailComposerFieldErrors = Partial<
  Record<"recipient" | "subject" | "body" | "senderName", string>
>;

export type MailCleanupScope = "read_inbox" | "unknown_senders" | "all_mail";

export type MailCleanupPreview = {
  scope: MailCleanupScope;
  previewToken: string;
  total: number;
  unread: number;
  inbox: number;
  sent: number;
  outbox: number;
  activeSends: number;
  bytesLabel: string;
};

export type MailCleanupDialog = {
  preview: MailCleanupPreview;
  pending?: boolean;
  error?: string | null;
};

export type MailConfirmationDialog = {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  detailLabel?: string;
  detailValue?: string;
  destructive?: boolean;
};

export type MailStorageSummary = {
  usedLabel: string;
  messageCount: number;
  level?: "normal" | "approaching_limit" | "almost_full";
  cleanupCounts: Record<MailCleanupScope, number | null>;
  cleanupDetails?: Partial<Record<MailCleanupScope, {
    count: number;
    bytesLabel: string;
  } | null>>;
};

export type MailPrivateUiState = MailPrivateAvailability;

export type MailDeliverySetupState =
  | "checking"
  | "ready"
  | "required"
  | "requesting"
  | "unavailable";

export function showMailDeliverySetupNotice(
  state: MailDeliverySetupState | undefined,
): boolean {
  return state === "required" ||
    state === "requesting" ||
    state === "unavailable";
}

export type MailUiProps = {
  navigation: MailUiNavigation;
  privateMailState: MailPrivateUiState;
  counts: Record<MailFolder, number> & { unread: number };
  messages: readonly MailMessageSummary[];
  selectedMessage: MailMessageDetail | null;
  neutronAddress?: string | null;
  lifecycleKeyManager?: string | null;
  unreadOnly: boolean;
  searchQuery?: string;
  composer: MailComposerDraft;
  composerErrors?: MailComposerFieldErrors;
  recipientOptions?: readonly MailRecipientOption[];
  storage: MailStorageSummary;
  cleanupDialog: MailCleanupDialog | null;
  confirmationDialog: MailConfirmationDialog | null;
  loading?: boolean;
  pageLoading?: boolean;
  pageOffset?: number;
  pageTotal?: number;
  hasPreviousPage?: boolean;
  hasNextPage?: boolean;
  error?: string | null;
  statusMessage?: string | null;
  privateMailNotice?: string | null;
  sendPending?: boolean;
  deliverySetupState?: MailDeliverySetupState;
  deliverySetupNotice?: string | null;
  retryPendingId?: string | null;
  newMailCount?: number;
  selectionUnavailableMessage?: string | null;
  senderName?: string | null;
  senderSettingsPending?: boolean;
  senderSettingsError?: string | null;
  keyRotationPanel?: ReactNode;
  onNavigate: (event: MailUiNavigationEvent) => void;
  onUnreadOnlyChange: (enabled: boolean) => void;
  onSearchQueryChange?: (query: string) => void;
  onDraftChange: (draft: MailComposerDraft) => void;
  onChooseRecipient: (recipient: MailRecipientOption) => void;
  onManageContacts?: () => void;
  onAddToContacts?: (identity: MailIdentity) => void;
  onInsertMarkdown: (kind: MailMarkdownInsertion) => void;
  onSend: (draft: MailComposerDraft) => void;
  onToggleRead: (id: string, read: boolean) => void;
  onDeleteMessage: (id: string) => void;
  onRetryMessage?: (id: string) => void;
  onEditMessageCopy?: (id: string) => void;
  onShowNewMail?: () => void;
  onSetSenderName?: (senderName: string) => void;
  onSetUpPrivateMail: () => void;
  onRetryPrivateMail: () => void;
  onSetUpDelivery?: () => void;
  onPreviousPage?: () => void;
  onNextPage?: () => void;
  onRequestCleanup: (scope: MailCleanupScope) => void;
  onCancelCleanup: () => void;
  onConfirmCleanup: (scope: MailCleanupScope, previewToken: string) => void;
  onCancelConfirmation: () => void;
  onConfirmConfirmation: () => void;
};

export type MailMarkdownInsertion =
  | "bold"
  | "italic"
  | "link"
  | "code"
  | "code_block"
  | "list";

type CleanupAction = {
  scope: MailCleanupScope;
  title: string;
  description: string;
  icon: IconName;
};

export const MAIL_CLEANUP_ACTIONS: readonly CleanupAction[] = Object.freeze([
  {
    scope: "read_inbox",
    title: "Delete read Inbox mail",
    description: "Keeps unread mail, Sent mail, and the Outbox.",
    icon: "read",
  },
  {
    scope: "unknown_senders",
    title: "Delete mail from unknown senders",
    description: "Removes mail from principals that are not in Contacts.",
    icon: "unknown",
  },
  {
    scope: "all_mail",
    title: "Delete all mail",
    description: "Removes Inbox, Sent, and Outbox mail from this Neutron.",
    icon: "trash",
  },
]);

const FOLDER_LABEL: Record<MailFolder, string> = {
  inbox: "Inbox",
  sent: "Sent",
  outbox: "Outbox",
};

const utf8 = new TextEncoder();
const BODY_BYTE_COUNT_THRESHOLD = 24 * 1_024;
const MAX_ENVELOPE_BYTES_LABEL = MAIL_MAX_ENVELOPE_BYTES.toLocaleString("en-US");

function visibleFolders(props: Pick<MailUiProps, "counts" | "navigation" | "sendPending">): MailFolder[] {
  return props.counts.outbox > 0 || props.navigation.folder === "outbox" || props.sendPending
    ? ["inbox", "sent", "outbox"]
    : ["inbox", "sent"];
}

export function MailUi(props: MailUiProps) {
  const { navigation } = props;
  const privateReady = props.privateMailState === "ready";
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);

  return (
    <main
      className={`nt-app nt-app--fill mail-ui mail-ui--route-${navigation.route}`}
      aria-label="Private Mail"
      onFocusCapture={(event) => {
        const target = event.target;
        if (target instanceof HTMLElement && !target.closest(".mail-dialog")) {
          dialogReturnFocusRef.current = target;
        }
      }}
    >
      <div className="mail-ui-shell">
        <MailRail {...props} />
        <MessageList {...props} privateReady={privateReady} />
        <section className="mail-content-pane" aria-label={contentLabel(navigation.route)}>
          {navigation.route !== "list" ? (
            <button
              type="button"
              className="nt-button nt-button--ghost nt-button--sm mail-mobile-back"
              aria-label="Back to message list"
              title="Back to message list"
              onClick={() => props.onNavigate({ type: "back" })}
            >
              <Icon name="back" />
              <span>Back</span>
            </button>
          ) : null}
          {navigation.route === "compose" && !privateReady ? (
            <PrivateMailState
              state={props.privateMailState}
              purpose="compose"
              notice={props.privateMailNotice}
              onSetUp={props.onSetUpPrivateMail}
              onRetry={props.onRetryPrivateMail}
            />
          ) : navigation.route === "compose" ? (
            <Composer {...props} />
          ) : navigation.route === "settings" ? (
            <StorageSettings {...props} />
          ) : (
            <Reader {...props} privateReady={privateReady} />
          )}
        </section>
      </div>
      <div className="mail-sr-status" aria-live="polite" aria-atomic="true">
        {props.statusMessage ?? ""}
      </div>
      {props.cleanupDialog ? (
        <CleanupConfirmation
          dialog={props.cleanupDialog}
          returnFocusTarget={dialogReturnFocusRef.current}
          onCancel={props.onCancelCleanup}
          onConfirm={props.onConfirmCleanup}
        />
      ) : null}
      {props.confirmationDialog ? (
        <ActionConfirmation
          dialog={props.confirmationDialog}
          returnFocusTarget={dialogReturnFocusRef.current}
          onCancel={props.onCancelConfirmation}
          onConfirm={props.onConfirmConfirmation}
        />
      ) : null}
    </main>
  );
}

function MailRail(props: MailUiProps) {
  const folders = visibleFolders(props);
  return (
    <nav className="mail-rail" aria-label="Mail navigation">
      <div className="mail-brand" aria-label="Private Mail">
        <span className="mail-brand-mark" aria-hidden="true">
          <Icon name="mail" />
        </span>
        <span>Mail</span>
      </div>

      <label className="mail-folder-select-wrap">
        <span className="mail-visually-hidden">Mailbox</span>
        <select
          className="mail-folder-select"
          value={props.navigation.folder}
          aria-label="Mailbox"
          onChange={(event) =>
            props.onNavigate({
              type: "select_folder",
              folder: event.currentTarget.value as MailFolder,
            })
          }
        >
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {FOLDER_LABEL[folder]} ({props.counts[folder]})
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className="nt-button mail-compose-button"
        aria-label="Compose"
        onClick={() => props.onNavigate({ type: "compose" })}
      >
        <Icon name="compose" />
        <span>Compose</span>
      </button>

      <div className="mail-folder-buttons">
        {folders.map((folder) => (
          <button
            type="button"
            className="mail-folder-button"
            key={folder}
            data-mail-return-focus={`folder-${folder}`}
            aria-current={props.navigation.folder === folder ? "page" : undefined}
            onClick={() => props.onNavigate({ type: "select_folder", folder })}
          >
            <Icon name={folder} />
            <span>{FOLDER_LABEL[folder]}</span>
            {folder === "inbox" && props.counts.unread > 0 ? (
              <span className="mail-count" aria-label={`${props.counts.unread} unread`}>
                {compactCount(props.counts.unread)}
              </span>
            ) : props.counts[folder] > 0 ? (
              <span className="mail-count" aria-label={`${props.counts[folder]} messages`}>
                {compactCount(props.counts[folder])}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {props.storage.level && props.storage.level !== "normal" ? (
        <section
          className={`mail-storage-notice mail-storage-notice--${props.storage.level}`}
          role={props.storage.level === "almost_full" ? "alert" : "status"}
        >
          <strong>
            {props.storage.level === "almost_full"
              ? "Storage almost full"
              : "Storage 80% full"}
          </strong>
          <span>
            {props.storage.level === "almost_full"
              ? "New mail may be rejected."
              : "Clean up mail soon."}
          </span>
          <button
            type="button"
            className="nt-button nt-button--ghost nt-button--sm"
            onClick={() => props.onNavigate({ type: "settings" })}
          >
            Manage storage
          </button>
        </section>
      ) : null}

      <div className="mail-rail-spacer" />
      <button
        type="button"
        className="mail-rail-utility"
        title="Storage settings"
        aria-label="Storage settings"
        aria-current={props.navigation.route === "settings" ? "page" : undefined}
        onClick={() => props.onNavigate({ type: "settings" })}
      >
        <Icon name="settings" />
        <span>Storage</span>
      </button>
    </nav>
  );
}

function MessageList(props: MailUiProps & { privateReady: boolean }) {
  const { folder } = props.navigation;
  const listRef = useRef<HTMLDivElement>(null);
  const previousPageRef = useRef<HTMLButtonElement>(null);
  const nextPageRef = useRef<HTMLButtonElement>(null);
  const pageFocusRef = useRef(false);
  const lastPageOffsetRef = useRef(props.pageOffset ?? 0);
  const deferredSearchQuery = useDeferredValue(props.searchQuery ?? "");
  const query = deferredSearchQuery.trim().normalize("NFKC").toLocaleLowerCase();
  const messages = useMemo(() => {
    const unreadMessages = props.unreadOnly
      ? props.messages.filter((message) => !message.read)
      : props.messages;
    return query === ""
      ? unreadMessages
      : unreadMessages.filter((message) => messageMatchesSearch(message, query));
  }, [props.messages, props.unreadOnly, query]);
  const selectMessage = useCallback((id: string) => {
    props.onNavigate({ type: "select_message", id });
  }, [props.onNavigate]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = 0;
  }, [folder, props.pageOffset, props.unreadOnly, query]);

  useEffect(() => {
    const offset = props.pageOffset ?? 0;
    if (lastPageOffsetRef.current === offset) return;
    lastPageOffsetRef.current = offset;
    const restoreFocus = pageFocusRef.current;
    pageFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      list.scrollTop = 0;
      if (!restoreFocus) return;
      const focusTarget = list.querySelector<HTMLElement>('.mail-message-row') ??
        nextPageRef.current ?? previousPageRef.current;
      focusTarget?.focus({ preventScroll: true });
      list.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, props.pageOffset]);

  const pageOffset = props.pageOffset ?? 0;
  const pageTotal = props.pageTotal ?? props.messages.length;
  const pageStart = pageTotal === 0 ? 0 : pageOffset + 1;
  const pageEnd = Math.min(pageTotal, pageOffset + props.messages.length);

  return (
    <section className="mail-list-pane" aria-labelledby="mail-list-heading">
      <header className="mail-list-header">
        <div className="mail-list-heading-copy">
          <div className="mail-list-title-row">
            <h1 id="mail-list-heading">{FOLDER_LABEL[folder]}</h1>
            {folder === "inbox" && props.neutronAddress ? (
              <div className="mail-inbox-address" role="group" aria-label="Your Neutron address">
                <span>Address</span>
                <bdi dir="ltr" title={props.neutronAddress}>{props.neutronAddress}</bdi>
                <button
                  type="button"
                  className="nt-icon-button mail-inbox-address-copy"
                  aria-label={`Copy full Neutron canister address: ${props.neutronAddress}`}
                  title="Copy Neutron address"
                  onClick={() => void copyToClipboard(props.neutronAddress!)}
                >
                  <Icon name="copy" />
                </button>
              </div>
            ) : null}
          </div>
          <span className="mail-list-count">
            {props.counts[folder]} {props.counts[folder] === 1 ? "message" : "messages"}
          </span>
        </div>
        {folder === "inbox" ? (
          <button
            type="button"
            className="nt-button nt-button--ghost nt-button--sm mail-unread-filter"
            aria-label="Show unread mail only"
            aria-pressed={props.unreadOnly}
            title={props.unreadOnly ? "Show all mail" : "Show unread mail only"}
            onClick={() => props.onUnreadOnlyChange(!props.unreadOnly)}
          >
            <span className="mail-unread-filter-dot" aria-hidden="true" />
            <span>Unread</span>
          </button>
        ) : null}
      </header>

      {props.privateReady && props.onSearchQueryChange ? (
        <label className="mail-list-search">
          <span className="mail-visually-hidden">Search this page's mail headers</span>
          <Icon name="search" />
          <input
            type="search"
            value={props.searchQuery ?? ""}
            maxLength={120}
            placeholder="Search sender or subject"
            onChange={(event) => props.onSearchQueryChange?.(event.currentTarget.value)}
          />
        </label>
      ) : null}

      {props.privateMailState === "not_configured" ? (
        <div className="mail-capability-notice" role="note">
          <Icon name="mail" />
          <span>Set up private Mail once to receive and send encrypted messages.</span>
          <button
            type="button"
            className="nt-button nt-button--ghost nt-button--sm"
            onClick={props.onSetUpPrivateMail}
          >
            Set up private Mail
          </button>
        </div>
      ) : props.privateMailState === "preparing" || props.privateMailState === "unavailable" ? (
        <div
          className={`mail-capability-notice${props.privateMailState === "unavailable" ? " mail-capability-notice--error" : ""}`}
          role={props.privateMailState === "unavailable" ? "alert" : "status"}
        >
          <Icon name={props.privateMailState === "unavailable" ? "warning" : "mail"} />
          <span>
            {props.privateMailNotice ?? (
              props.privateMailState === "unavailable"
                ? "Private Mail is temporarily unavailable."
                : "Preparing private Mail…"
            )}
          </span>
          {props.privateMailState === "unavailable" ? (
            <button
              type="button"
              className="nt-button nt-button--secondary nt-button--sm"
              onClick={props.onRetryPrivateMail}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {props.privateReady &&
      props.navigation.route !== "compose" &&
      showMailDeliverySetupNotice(props.deliverySetupState) ? (
        <DeliverySetupNotice {...props} />
      ) : null}

      {props.error ? (
        <div className="mail-inline-state mail-inline-state--error" role="alert">
          {props.error}
        </div>
      ) : null}
      {folder === "inbox" && (props.newMailCount ?? 0) > 0 ? (
        <button
          type="button"
          className="mail-new-mail-banner"
          onClick={props.onShowNewMail}
        >
          <Icon name="unread" />
          <span>
            {props.newMailCount} new {props.newMailCount === 1 ? "message" : "messages"}
          </span>
          <strong>Show</strong>
        </button>
      ) : null}
      <div
        className="mail-message-list"
        role="list"
        aria-busy={props.loading || props.pageLoading || undefined}
        ref={listRef}
      >
        {props.loading && messages.length === 0 ? (
          <div className="mail-inline-state" role="status">Loading mail…</div>
        ) : messages.length === 0 ? (
          <div className="mail-empty-state">
            <Icon name="mail" />
            <strong>{query ? "No matching mail" : props.unreadOnly ? "No unread mail" : `No ${FOLDER_LABEL[folder].toLowerCase()} mail`}</strong>
            <span>{query ? "Search checks this page's sender and subject headers, not message bodies." : folder === "inbox" ? "New private messages will appear here." : "There is nothing here yet."}</span>
          </div>
        ) : (
          messages.map((message, index) => (
            <MessageRow
              key={message.id}
              message={message}
              rowIndex={pageOffset + index}
              totalRows={pageTotal}
              privateReady={props.privateReady}
              selected={props.navigation.selectedId === message.id}
              onSelect={selectMessage}
            />
          ))
        )}
      </div>
      {props.pageTotal !== undefined ? (
        <nav className="mail-pagination" aria-label="Mail pages">
          <button
            type="button"
            className="nt-button nt-button--ghost nt-button--sm"
            ref={previousPageRef}
            disabled={props.pageLoading || !props.hasPreviousPage}
            onClick={() => {
              pageFocusRef.current = document.activeElement === previousPageRef.current;
              props.onPreviousPage?.();
            }}
          >
            Previous
          </button>
          <span className="mail-page-range" aria-live="polite">
            {pageStart}–{pageEnd} of {pageTotal}
          </span>
          <button
            type="button"
            className="nt-button nt-button--ghost nt-button--sm"
            ref={nextPageRef}
            disabled={props.pageLoading || !props.hasNextPage}
            onClick={() => {
              pageFocusRef.current = document.activeElement === nextPageRef.current;
              props.onNextPage?.();
            }}
          >
            Next
          </button>
        </nav>
      ) : null}
    </section>
  );
}

function DeliverySetupNotice(props: MailUiProps) {
  const state = props.deliverySetupState;
  const unavailable = state === "unavailable";
  const actionable = state === "required" || unavailable;
  const message = props.deliverySetupNotice ?? (
    state === "checking"
      ? "Checking Mail delivery setup…"
      : state === "requesting"
        ? "Finishing Mail setup…"
        : unavailable
          ? "Mail could not verify its delivery setup."
          : "Finish Mail setup once to send encrypted messages."
  );
  return (
    <div
      className={`mail-capability-notice${unavailable ? " mail-capability-notice--error" : ""}`}
      role={unavailable ? "alert" : "status"}
    >
      <Icon name={unavailable ? "warning" : "send"} />
      <span>{message}</span>
      {actionable && props.onSetUpDelivery ? (
        <button
          type="button"
          className="nt-button nt-button--ghost nt-button--sm"
          onClick={props.onSetUpDelivery}
        >
          Finish Mail setup
        </button>
      ) : null}
    </div>
  );
}

type MessageRowProps = {
  message: MailMessageSummary;
  rowIndex: number;
  totalRows: number;
  privateReady: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
};

const MessageRow = memo(function MessageRow({
  message,
  rowIndex,
  totalRows,
  privateReady,
  selected,
  onSelect,
}: MessageRowProps) {
  const peer = message.folder === "inbox" ? message.sender : message.recipient;
  const name = privateReady ? identityLabel(peer) : lockedIdentityLabel(peer);
  const corrupt = message.decryptionState === "corrupt";
  const subject = corrupt
    ? "Could not authenticate or decrypt this message"
    : privateReady
      ? message.subject || "(No subject)"
      : "Private message";
  const peerRole = message.folder === "inbox" ? "From" : "To";
  return (
    <div
      className="mail-message-item"
      role="listitem"
      aria-posinset={rowIndex + 1}
      aria-setsize={totalRows}
    >
      <button
        type="button"
        data-mail-row-index={rowIndex}
        className={`mail-message-row${message.read ? "" : " mail-message-row--unread"}`}
        aria-current={selected ? "true" : undefined}
        aria-label={`${message.read ? "Read" : "Unread"}. ${peerRole} ${name}. ${subject}. ${message.timestampLabel}`}
        onClick={() => onSelect(message.id)}
      >
        <span className="mail-message-unread-dot" aria-hidden="true" />
        <span className="mail-message-copy">
          <span className="mail-message-line">
            <strong dir="auto">{name}</strong>
            <time dateTime={message.timestampIso} title={message.timestampIso || undefined}>
              {message.timestampLabel}
            </time>
          </span>
          <span className="mail-message-line mail-message-subject">
            <span dir="auto">{subject}</span>
            {corrupt ? (
              <span className="mail-trust-chip">Unreadable</span>
            ) : peer.trust !== "in_contacts" ? (
              <span className="mail-trust-chip">
                {peer.trust === "contact_conflict" ? "Contact conflict" : "Not in Contacts"}
              </span>
            ) : null}
          </span>
          {message.folder === "outbox" && message.deliveryStatus ? (
            <span className={`mail-delivery mail-delivery--${message.deliveryStatus}`}>
              {deliveryLabel(message.deliveryStatus)}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  );
}, sameMessageRowProps);

function sameMessageRowProps(previous: MessageRowProps, next: MessageRowProps): boolean {
  const a = previous.message;
  const b = next.message;
  return previous.rowIndex === next.rowIndex &&
    previous.totalRows === next.totalRows &&
    previous.privateReady === next.privateReady &&
    previous.selected === next.selected &&
    previous.onSelect === next.onSelect &&
    a.id === b.id &&
    a.folder === b.folder &&
    a.read === b.read &&
    a.subject === b.subject &&
    a.timestampLabel === b.timestampLabel &&
    a.timestampIso === b.timestampIso &&
    a.deliveryStatus === b.deliveryStatus &&
    a.decryptionState === b.decryptionState &&
    sameMailIdentity(a.sender, b.sender) &&
    sameMailIdentity(a.recipient, b.recipient);
}

function sameMailIdentity(a: MailIdentity, b: MailIdentity): boolean {
  return a.principal === b.principal &&
    a.trust === b.trust &&
    a.contactName === b.contactName &&
    a.claimedName === b.claimedName;
}

function Reader(props: MailUiProps & { privateReady: boolean }) {
  const message = props.selectedMessage;
  if (!message) {
    if (props.navigation.selectedId && props.selectionUnavailableMessage) {
      return (
        <div className="mail-reader-empty mail-reader-empty--deleted" role="status">
          <Icon name="trash" />
          <strong>Message no longer available</strong>
          <span>{props.selectionUnavailableMessage}</span>
          <button
            type="button"
            className="nt-button nt-button--secondary nt-button--sm"
            onClick={() => props.onNavigate({ type: "back" })}
          >
            Back to mail
          </button>
        </div>
      );
    }
    return (
      <div className="mail-reader-empty">
        <Icon name="mail" />
        <strong>Select a message</strong>
        <span>Choose mail from the list to read it.</span>
      </div>
    );
  }

  if (!props.privateReady) {
    return <PrivateReaderPending {...props} message={message} />;
  }

  if (message.decryptionState === "corrupt") {
    return <CorruptReader {...props} message={message} />;
  }

  if (message.bodyMarkdown === null || message.subject === null) {
    return (
      <PrivateMailState
        state={props.privateMailState}
        purpose="read"
        notice={props.privateMailNotice}
        onSetUp={props.onSetUpPrivateMail}
        onRetry={props.onRetryPrivateMail}
      />
    );
  }

  return (
    <article className="mail-reader">
      <header className="mail-reader-header">
        <div className="mail-reader-title-row">
          <div>
            <p className="mail-eyebrow">{message.folder === "inbox" ? "Received" : FOLDER_LABEL[message.folder]}</p>
            <h2 dir="auto">{message.subject || "(No subject)"}</h2>
          </div>
          <div className="nt-button-group mail-reader-actions" aria-label="Message actions">
            {message.folder === "inbox" ? (
              <button
                type="button"
                className="nt-button nt-button--secondary nt-button--sm"
                title="Reply"
                aria-label="Reply"
                onClick={() => props.onNavigate({ type: "reply", id: message.id })}
              >
                <Icon name="reply" />
                <span>Reply</span>
              </button>
            ) : null}
            {message.folder === "inbox" ? (
              <button
                type="button"
                className="nt-icon-button"
                title={message.read ? "Mark unread" : "Mark read"}
                aria-label={message.read ? "Mark unread" : "Mark read"}
                onClick={() => props.onToggleRead(message.id, !message.read)}
              >
                <Icon name={message.read ? "unread" : "read"} />
              </button>
            ) : null}
            {message.folder === "outbox" &&
            (message.deliveryStatus === "not_sent" ||
              message.deliveryStatus === "delivery_uncertain") &&
            props.onRetryMessage ? (
              <button
                type="button"
                className="nt-button nt-button--secondary nt-button--sm"
                title="Retry the exact encrypted message"
                aria-label="Retry the exact encrypted message"
                disabled={props.retryPendingId === message.id}
                onClick={() => props.onRetryMessage?.(message.id)}
              >
                <Icon name="retry" />
                <span>{props.retryPendingId === message.id ? "Retrying…" : "Retry"}</span>
              </button>
            ) : null}
            {message.folder === "outbox" &&
            (message.deliveryStatus === "not_sent" ||
              message.deliveryStatus === "delivery_uncertain") &&
            props.onEditMessageCopy ? (
              <button
                type="button"
                className="nt-button nt-button--secondary nt-button--sm"
                title="Create a new editable copy and leave this Outbox record unchanged"
                onClick={() => props.onEditMessageCopy?.(message.id)}
              >
                <Icon name="compose" />
                <span>Edit copy</span>
              </button>
            ) : null}
            <button
              type="button"
              className="nt-icon-button mail-icon-button--danger"
              title="Delete message"
              aria-label="Delete message"
              onClick={() => props.onDeleteMessage(message.id)}
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
        <div className="mail-reader-meta">
          <IdentityBlock
            identity={message.folder === "inbox" ? message.sender : message.recipient}
            label={message.folder === "inbox" ? "From" : "To"}
            onAddToContacts={
              message.folder === "inbox" && message.sender.trust === "not_in_contacts"
                ? props.onAddToContacts
                : undefined
            }
          />
          <div className="mail-meta-destination">
            <span>{message.folder === "inbox" ? "To" : "From"}</span>
            {message.folder === "inbox" ? (
              <strong>Me</strong>
            ) : (
              <bdi dir="ltr">{shortPrincipal(message.sender.principal)}</bdi>
            )}
          </div>
          <time dateTime={message.timestampIso} title={message.timestampIso || undefined}>
            {message.timestampLabel}
          </time>
        </div>
        {message.replyContextLabel ? (
          <p className="mail-reply-context">{message.replyContextLabel}</p>
        ) : null}
        <details className="mail-message-details">
          <summary>Details</summary>
          <dl>
            <div>
              <dt>{message.folder === "inbox" ? "Received by this Neutron" : "Created in this Neutron"}</dt>
              <dd>
                <time dateTime={message.timestampIso}>{message.timestampLabel}</time>
              </dd>
            </div>
            {message.senderTimestampLabel && message.senderTimestampIso ? (
              <div>
                <dt>Sender-created time</dt>
                <dd>
                  <time dateTime={message.senderTimestampIso}>{message.senderTimestampLabel}</time>
                </dd>
              </div>
            ) : null}
          </dl>
        </details>
      </header>
      <div className="mail-reader-body">
        <SafeMailMarkdown source={message.bodyMarkdown} />
      </div>
    </article>
  );
}

function IdentityBlock({
  identity,
  label,
  onAddToContacts,
}: {
  identity: MailIdentity;
  label: string;
  onAddToContacts?: ((identity: MailIdentity) => void) | undefined;
}) {
  return (
    <div className="mail-identity">
      <span>{label}</span>
      <div>
        <strong dir="auto">{identityLabel(identity)}</strong>
        <IdentityPrincipalAction
          identity={identity}
          onAddToContacts={onAddToContacts}
        />
      </div>
      {identity.trust === "in_contacts" ? (
        <span className="mail-trust mail-trust--contact"><Icon name="contact" /> In Contacts</span>
      ) : identity.trust === "contact_conflict" ? (
        <span className="mail-trust mail-trust--warning" title="Contacts could not produce one exact current match for this address">
          <Icon name="warning" /> Contact conflict
          <span className="mail-trust-explanation">No contact name was trusted</span>
        </span>
      ) : (
        <span
          className="mail-trust mail-trust--warning"
          title="Name supplied by sender and not verified"
        >
          <Icon name="unknown" /> Not in Contacts
          <span className="mail-trust-explanation">Name supplied by sender and not verified</span>
        </span>
      )}
    </div>
  );
}

function IdentityPrincipalAction({
  identity,
  onAddToContacts,
}: {
  identity: MailIdentity;
  onAddToContacts?: ((identity: MailIdentity) => void) | undefined;
}) {
  if (identity.trust === "not_in_contacts" && onAddToContacts) {
    return (
      <span className="mail-principal-address">
        <bdi dir="ltr">{identity.principal}</bdi>
        <button
          type="button"
          className="nt-icon-button mail-principal-add"
          aria-label="Add sender to Contacts"
          title="Add to Contacts"
          onClick={() => onAddToContacts(identity)}
        >
          <Icon name="contact-add" />
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="mail-principal-copy"
      aria-label={`Copy full Neutron canister address: ${identity.principal}`}
      title={`Copy ${identity.principal}`}
      onClick={() => void copyToClipboard(identity.principal)}
    >
      <bdi dir="ltr">{identity.principal}</bdi>
      <span>Copy full address</span>
    </button>
  );
}

function Composer(props: MailUiProps) {
  const draft = props.composer;
  const preview = props.navigation.composerTab === "preview";
  const bodyByteLength = utf8.encode(draft.bodyMarkdown).byteLength;
  const recipientFixed = draft.mode === "reply" && draft.recipient !== null;
  const update = (change: Partial<MailComposerDraft>) =>
    props.onDraftChange({ ...draft, ...change });

  return (
    <section
      className="mail-composer"
      aria-labelledby="mail-compose-title"
    >
      <header className="mail-composer-header">
        <div>
          <p className="mail-eyebrow">Private Mail</p>
          <h2 id="mail-compose-title">{draft.mode === "reply" ? "Reply" : "New message"}</h2>
        </div>
        <button
          type="button"
          className="nt-button"
          disabled={props.sendPending || (
            props.deliverySetupState !== undefined &&
            props.deliverySetupState !== "ready"
          )}
          onClick={(event) => requestComposerSend(event, draft, props.sendPending, props.onSend)}
        >
          <Icon name="send" />
          {props.sendPending ? "Sending…" : "Send"}
        </button>
      </header>

      {showMailDeliverySetupNotice(props.deliverySetupState) ? (
        <DeliverySetupNotice {...props} />
      ) : null}

      <div className="mail-compose-fields">
        {props.senderName ? (
          <div className="mail-sender-setting" aria-label="Encrypted sender name">
            <span>From</span>
            <strong dir="auto">{props.senderName}</strong>
            <small>Encrypted setting</small>
          </div>
        ) : (
          <>
            <label className="mail-field">
              <span>Your sender name</span>
              <input
                type="text"
                value={draft.senderNameSetup ?? ""}
                maxLength={80}
                autoComplete="name"
                disabled={props.sendPending}
                aria-invalid={Boolean(props.composerErrors?.senderName) || undefined}
                aria-describedby={props.composerErrors?.senderName ? "mail-sender-name-error" : "mail-sender-name-help"}
                onChange={(event) => update({ senderNameSetup: event.currentTarget.value })}
              />
            </label>
            <span id="mail-sender-name-help" className="mail-field-help">
              Saved encrypted in this Neutron and included inside each encrypted message.
            </span>
            {props.composerErrors?.senderName ? (
              <span id="mail-sender-name-error" className="mail-field-error" role="alert">
                {props.composerErrors.senderName}
              </span>
            ) : null}
          </>
        )}
        <label className="mail-field">
          <span>To</span>
          <input
            type="text"
            aria-invalid={Boolean(props.composerErrors?.recipient) || undefined}
            aria-describedby={props.composerErrors?.recipient ? "mail-recipient-error" : undefined}
            value={draft.recipientInput}
            readOnly={recipientFixed}
            disabled={props.sendPending}
            placeholder="Contact or Neutron principal"
            autoComplete="off"
            onChange={(event) => update({ recipientInput: event.currentTarget.value, recipient: null })}
          />
        </label>
        {props.composerErrors?.recipient ? (
          <span id="mail-recipient-error" className="mail-field-error" role="alert">
            {props.composerErrors.recipient}
          </span>
        ) : null}
        {!recipientFixed && props.recipientOptions && props.recipientOptions.length > 0 ? (
          <ul id="mail-recipient-options" className="mail-recipient-options" aria-label="Recipient suggestions">
            {props.recipientOptions.map((option) => (
              <li key={`${option.source}:${option.principal}`}>
                <button
                  type="button"
                  disabled={props.sendPending}
                  onClick={() => props.onChooseRecipient(option)}
                >
                  <span dir="auto">{option.label}</span>
                  <bdi dir="ltr">{shortPrincipal(option.principal)}</bdi>
                  <span>{option.source === "contact" ? "Contact" : "Principal"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {draft.recipient ? (
          <div className="mail-recipient-confirmed" aria-label="Selected recipient">
            <Icon name={draft.recipient.source === "contact" ? "contact" : "unknown"} />
            <span dir="auto">{draft.recipient.label}</span>
            <bdi dir="ltr">{draft.recipient.principal}</bdi>
            <span>{draft.recipient.source === "contact" ? "In Contacts" : "Not in Contacts"}</span>
            {props.onManageContacts ? (
              <button
                type="button"
                className="nt-button nt-button--ghost nt-button--sm"
                disabled={props.sendPending}
                onClick={props.onManageContacts}
              >
                Manage Contacts
              </button>
            ) : null}
          </div>
        ) : null}

        <label className="mail-field">
          <span>Subject</span>
          <input
            type="text"
            value={draft.subject}
            maxLength={160}
            disabled={props.sendPending}
            aria-invalid={Boolean(props.composerErrors?.subject) || undefined}
            aria-describedby={props.composerErrors?.subject ? "mail-subject-error" : undefined}
            onChange={(event) => update({ subject: event.currentTarget.value })}
          />
        </label>
        {props.composerErrors?.subject ? (
          <span id="mail-subject-error" className="mail-field-error" role="alert">
            {props.composerErrors.subject}
          </span>
        ) : null}
      </div>

      <div className="mail-editor-tabs" role="tablist" aria-label="Message editor view">
        <button
          id="mail-editor-tab"
          type="button"
          role="tab"
          aria-selected={!preview}
          aria-controls="mail-editor-panel"
          tabIndex={preview ? -1 : 0}
          disabled={props.sendPending}
          onClick={() => props.onNavigate({ type: "composer_tab", tab: "editor" })}
          onKeyDown={(event) => moveComposerTab(event, "editor", props)}
        >
          Editor
        </button>
        <button
          id="mail-preview-tab"
          type="button"
          role="tab"
          aria-selected={preview}
          aria-controls="mail-preview-panel"
          tabIndex={preview ? 0 : -1}
          disabled={props.sendPending}
          onClick={() => props.onNavigate({ type: "composer_tab", tab: "preview" })}
          onKeyDown={(event) => moveComposerTab(event, "preview", props)}
        >
          Preview
        </button>
      </div>

      {preview ? (
        <div id="mail-preview-panel" className="mail-compose-preview" role="tabpanel" aria-labelledby="mail-preview-tab">
          {draft.bodyMarkdown ? (
            <SafeMailMarkdown source={draft.bodyMarkdown} label="Message preview" />
          ) : (
            <p className="mail-preview-empty">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <div id="mail-editor-panel" className="mail-editor-panel" role="tabpanel" aria-labelledby="mail-editor-tab">
          <div className="mail-markdown-toolbar" role="toolbar" aria-label="Markdown formatting">
            {([
              ["bold", "Bold", "B"],
              ["italic", "Italic", "I"],
              ["link", "Insert link", "↗"],
              ["code", "Inline code", "<>"],
              ["code_block", "Code block", "{ }"],
              ["list", "Bulleted list", "•"],
            ] as const).map(([kind, label, mark]) => (
              <button
                key={kind}
                type="button"
                className="nt-icon-button mail-markdown-button"
                title={label}
                aria-label={label}
                disabled={props.sendPending}
                onClick={() => props.onInsertMarkdown(kind)}
              >
                <span aria-hidden="true">{mark}</span>
              </button>
            ))}
          </div>
          <details className="mail-markdown-help-control">
            <summary>Markdown help</summary>
            <div>
              <p>Format text with:</p>
              <ul>
                <li><code>**bold**</code> and <code>*italic*</code></li>
                <li><code>- list item</code> and <code>`inline code`</code></li>
                <li><code>[Plan](https://example.com/plan)</code> for a link</li>
              </ul>
              <p>HTTP(S) links are copy-only. Remote images never load; share links instead of files.</p>
            </div>
          </details>
          <label className="mail-body-field">
            <span className="mail-visually-hidden">Message in Markdown</span>
            <textarea
              value={draft.bodyMarkdown}
              disabled={props.sendPending}
              aria-invalid={Boolean(props.composerErrors?.body) || undefined}
              aria-describedby={props.composerErrors?.body ? "mail-body-error" : "mail-markdown-help"}
              placeholder="Write a message in Markdown…"
              onChange={(event) => update({ bodyMarkdown: event.currentTarget.value })}
            />
          </label>
          <div className="mail-editor-foot">
            <span id="mail-markdown-help">Markdown is supported. Remote images never load.</span>
            {bodyByteLength >= BODY_BYTE_COUNT_THRESHOLD ? (
              <span className="mail-body-byte-count" aria-live="polite">
                {bodyByteLength} / 32 KiB
              </span>
            ) : null}
          </div>
          {props.composerErrors?.body ? (
            <span id="mail-body-error" className="mail-field-error" role="alert">
              {props.composerErrors.body}
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}

function moveComposerTab(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  current: MailComposerTab,
  props: MailUiProps,
): void {
  let next: MailComposerTab | null = null;
  if (event.key === "Home") next = "editor";
  if (event.key === "End") next = "preview";
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    next = current === "editor" ? "preview" : "editor";
  }
  if (next === null) return;
  event.preventDefault();
  props.onNavigate({ type: "composer_tab", tab: next });
  document.getElementById(`mail-${next}-tab`)?.focus();
}

function StorageSettings(props: MailUiProps) {
  const [senderName, setSenderName] = useState(props.senderName ?? "");
  const privateReady = props.privateMailState === "ready";
  const privateConfigured = Boolean(props.lifecycleKeyManager);
  useEffect(() => setSenderName(props.senderName ?? ""), [props.senderName]);
  return (
    <section className="mail-settings" aria-labelledby="mail-storage-title">
      <header className="mail-settings-header">
        <p className="mail-eyebrow">Mail settings</p>
        <h2 id="mail-storage-title">Storage</h2>
        <p>Remove mail from this Neutron to reclaim canister storage.</p>
      </header>
      {privateConfigured ? <PrivacyAndReceivingSettings {...props} /> : null}
      <section className="mail-sender-settings" aria-labelledby="mail-sender-settings-title">
        <div>
          <h3 id="mail-sender-settings-title">Sender name</h3>
          <p>This name is encrypted. Recipients outside Contacts see it as unverified.</p>
        </div>
        <label className="mail-field">
          <span>Display name</span>
          <input
            type="text"
            value={senderName}
            maxLength={80}
            autoComplete="name"
            disabled={!privateReady || props.senderSettingsPending}
            onChange={(event) => setSenderName(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          className="nt-button"
          disabled={
            !privateReady ||
            props.senderSettingsPending ||
            senderName.trim() === "" ||
            senderName === (props.senderName ?? "")
          }
          onClick={() => props.onSetSenderName?.(senderName)}
        >
          {props.senderSettingsPending ? "Saving…" : "Save name"}
        </button>
        {!privateReady ? (
          <p className="mail-settings-note">
            {props.privateMailState === "not_configured"
              ? "Set up private Mail to save an encrypted sender name."
              : "Preparing private Mail…"}
          </p>
        ) : props.senderSettingsError ? (
          <p className="mail-field-error" role="alert">{props.senderSettingsError}</p>
        ) : null}
      </section>
      {props.keyRotationPanel}
      <div className="mail-storage-summary">
        <span>Stored mail</span>
        <strong>{props.storage.usedLabel}</strong>
        <span>{props.storage.messageCount} {props.storage.messageCount === 1 ? "message" : "messages"}</span>
      </div>
      <div className="mail-cleanup-list" aria-label="Storage cleanup actions">
        {MAIL_CLEANUP_ACTIONS.map((action) => {
          const exact = props.storage.cleanupDetails?.[action.scope] ?? null;
          const count = props.storage.cleanupDetails
            ? exact?.count ?? null
            : props.storage.cleanupCounts[action.scope];
          const needsPreview = count === null;
          const empty = count === 0;
          const exactSummary = exact
            ? `${exact.count} ${exact.count === 1 ? "message" : "messages"} · ${exact.bytesLabel}`
            : props.storage.cleanupDetails
              ? "Checking exact count and storage…"
              : count === null
                ? "Exact count and storage available on review"
                : `${count} ${count === 1 ? "message" : "messages"}`;
          const tooltip = needsPreview
            ? `${action.title}: get an authoritative preview`
            : empty
              ? `${action.title}: nothing to delete`
              : `${action.title}: preview ${exactSummary}`;
          return (
            <div className="mail-cleanup-row nt-settings-row" key={action.scope}>
              <span className="mail-cleanup-icon"><Icon name={action.icon} /></span>
              <div>
                <strong>{action.title}</strong>
                <span>{action.description}</span>
                <span className="mail-cleanup-exact">{exactSummary}</span>
              </div>
              <button
                type="button"
                className="nt-button nt-button--secondary nt-button--sm mail-cleanup-button"
                data-cleanup-action={action.scope}
                data-mail-return-focus={`cleanup-${action.scope}`}
                aria-label={tooltip}
                title={tooltip}
                aria-disabled={empty}
                onClick={() => {
                  if (!empty) props.onRequestCleanup(action.scope);
                }}
              >
                {count === null ? "Review" : count === 0 ? "Empty" : `Review ${count}`}
              </button>
            </div>
          );
        })}
      </div>
      <p className="mail-settings-note">
        Cleanup affects stored encrypted mail only. It cannot recall mail already accepted by another Neutron.
      </p>
    </section>
  );
}

function PrivacyAndReceivingSettings(props: MailUiProps) {
  return (
    <section className="mail-privacy-settings" aria-labelledby="mail-privacy-settings-title">
      <div className="mail-privacy-heading">
        <div>
          <h3 id="mail-privacy-settings-title">Receiving and privacy</h3>
          <p><span className="mail-active-dot" aria-hidden="true" /> Private Mail active</p>
        </div>
      </div>
      {props.neutronAddress ? (
        <div className="mail-settings-address">
          <span>Your Neutron address</span>
          <button
            type="button"
            aria-label={`Copy full Neutron canister address: ${props.neutronAddress}`}
            title="Copy full Neutron canister address"
            onClick={() => void copyToClipboard(props.neutronAddress!)}
          >
            <bdi dir="ltr">{props.neutronAddress}</bdi>
            <span>Copy</span>
          </button>
        </div>
      ) : null}
      <div className="mail-privacy-summary">
        <p>Anyone with a Neutron canister can send private Mail to this address.</p>
        <p>Up to 10 messages from people not in Contacts are accepted per rolling hour. A Markdown body can be up to 32 KiB; its encrypted envelope is capped at {MAX_ENVELOPE_BYTES_LABEL} bytes.</p>
        <p>Every principal currently authorized in this Neutron can access existing Mail history.</p>
      </div>
      {props.lifecycleKeyManager ? (
        <div className="mail-key-manager-row">
          <span>Key lifecycle manager</span>
          <button
            type="button"
            aria-label={`Copy key lifecycle manager principal: ${props.lifecycleKeyManager}`}
            title="Copy key lifecycle manager principal"
            onClick={() => void copyToClipboard(props.lifecycleKeyManager!)}
          >
            <bdi dir="ltr">{props.lifecycleKeyManager}</bdi>
            <span>Copy</span>
          </button>
          <small>This principal manages key rotation, retirement, and transfer. It is not the only authorized reader.</small>
        </div>
      ) : null}
      <details className="mail-privacy-details">
        <summary>Privacy details</summary>
        <ul>
          <li>Subject, sender name, Markdown body, links, sender-created time, and reply reference are encrypted in the sender browser and decrypted in an authorized recipient browser.</li>
          <li>Canisters still see routing and quota metadata: sender and recipient principals, arrival time, ciphertext size bucket, counts, and delivery state.</li>
          <li>An active controller can replace Mail or Neutron code and request or steal a key. A compromised browser, extension, operating system, kernel, or authorized identity is outside this privacy boundary.</li>
          <li>Mail V1 has no forward secrecy: a key obtained for one epoch can decrypt ciphertext retained for that epoch.</li>
          <li>Deleting a local copy cannot recall mail from another Neutron or erase plaintext already copied by an authorized browser or app.</li>
          <li>An app given Neutron permission to use a Mail tool receives the requested plaintext and may retain it outside Mail.</li>
        </ul>
      </details>
    </section>
  );
}

type DialogInitialFocusRef = {
  readonly current: HTMLElement | null;
};

/**
 * Moves focus into a dialog once, then returns it to the control that opened
 * the dialog. The opener is captured by MailUi before an async preview can
 * rerender it; the data key finds its replacement if React swaps that node.
 *
 * Keep this effect mount-only. Dialog status/error updates must not steal
 * focus back to Cancel while the user is moving between the dialog actions.
 */
function useDialogFocus(
  initialFocusRef: DialogInitialFocusRef,
  returnFocusTarget: HTMLElement | null,
): void {
  const returnFocusRef = useRef<HTMLElement | null>(returnFocusTarget);
  const returnFocusKeyRef = useRef(
    returnFocusTarget?.getAttribute("data-mail-return-focus") ?? null,
  );

  useEffect(() => {
    if (returnFocusRef.current === null) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        returnFocusRef.current = active;
        returnFocusKeyRef.current = active.getAttribute("data-mail-return-focus");
      }
    }
    initialFocusRef.current?.focus();

    return () => {
      // A replacement modal owns focus when dialogs transition directly.
      if (document.querySelector('.mail-dialog[role="dialog"][aria-modal="true"]')) return;

      let target = returnFocusRef.current?.isConnected
        ? returnFocusRef.current
        : null;
      const focusKey = returnFocusKeyRef.current;
      if (target === null && focusKey !== null) {
        target = Array.from(
          document.querySelectorAll<HTMLElement>("[data-mail-return-focus]"),
        ).find((candidate) =>
          candidate.getAttribute("data-mail-return-focus") === focusKey
        ) ?? null;
      }
      if (target && !target.matches(":disabled")) target.focus();
    };
  }, []);
}

function CleanupConfirmation({
  dialog,
  returnFocusTarget,
  onCancel,
  onConfirm,
}: {
  dialog: MailCleanupDialog;
  returnFocusTarget: HTMLElement | null;
  onCancel: () => void;
  onConfirm: (scope: MailCleanupScope, previewToken: string) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const action = MAIL_CLEANUP_ACTIONS.find((candidate) => candidate.scope === dialog.preview.scope)!;
  useDialogFocus(cancelRef, returnFocusTarget);

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape" && !dialog.pending) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="mail-dialog-backdrop" role="presentation">
      <section
        className="mail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-cleanup-dialog-title"
        aria-describedby="mail-cleanup-dialog-description"
        onKeyDown={handleDialogKeyDown}
      >
        <div className="mail-dialog-mark"><Icon name={action.icon} /></div>
        <h2 id="mail-cleanup-dialog-title">{action.title}?</h2>
        <p id="mail-cleanup-dialog-description">
          Review the current server preview before deleting. Counts can change if new mail arrives.
          Deleting a local copy does not delete the recipient&apos;s copy. A send already dispatched
          may still finish after its local Outbox row is deleted.
        </p>
        <dl className="mail-cleanup-preview">
          <div><dt>Total</dt><dd>{dialog.preview.total}</dd></div>
          <div><dt>Unread</dt><dd>{dialog.preview.unread}</dd></div>
          <div><dt>Inbox</dt><dd>{dialog.preview.inbox}</dd></div>
          <div><dt>Sent</dt><dd>{dialog.preview.sent}</dd></div>
          <div><dt>Outbox</dt><dd>{dialog.preview.outbox}</dd></div>
          <div><dt>Storage</dt><dd>{dialog.preview.bytesLabel}</dd></div>
        </dl>
        {dialog.preview.activeSends > 0 ? (
          <p className="mail-dialog-warning" role="alert">
            {dialog.preview.activeSends} active {dialog.preview.activeSends === 1 ? "send is" : "sends are"} included. The remote call cannot be cancelled; wait before deleting if you may need to retry.
          </p>
        ) : null}
        {dialog.error ? <p className="mail-field-error" role="alert">{dialog.error}</p> : null}
        <div className="nt-dialog-actions mail-dialog-actions">
          <button
            type="button"
            className="nt-button nt-button--secondary"
            ref={cancelRef}
            onClick={onCancel}
            disabled={dialog.pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="nt-button nt-button--danger"
            ref={confirmRef}
            disabled={dialog.pending}
            onClick={() => onConfirm(dialog.preview.scope, dialog.preview.previewToken)}
          >
            {dialog.pending ? "Deleting…" : `Delete ${dialog.preview.total}`}
          </button>
        </div>
      </section>
    </div>
  );
}

function ActionConfirmation({
  dialog,
  returnFocusTarget,
  onCancel,
  onConfirm,
}: {
  dialog: MailConfirmationDialog;
  returnFocusTarget: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(cancelRef, returnFocusTarget);

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="mail-dialog-backdrop" role="presentation">
      <section
        className="mail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-confirmation-dialog-title"
        aria-describedby="mail-confirmation-dialog-description"
        onKeyDown={handleDialogKeyDown}
      >
        <div className="mail-dialog-mark"><Icon name="warning" /></div>
        <h2 id="mail-confirmation-dialog-title">{dialog.title}</h2>
        <p id="mail-confirmation-dialog-description">{dialog.description}</p>
        {dialog.detailLabel && dialog.detailValue ? (
          <div className="mail-confirmation-detail">
            <span>{dialog.detailLabel}</span>
            <bdi dir="ltr">{dialog.detailValue}</bdi>
          </div>
        ) : null}
        <div className="nt-dialog-actions mail-dialog-actions">
          <button
            type="button"
            className="nt-button nt-button--secondary"
            ref={cancelRef}
            onClick={onCancel}
          >
            {dialog.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={dialog.destructive ? "nt-button nt-button--danger" : "nt-button"}
            onClick={onConfirm}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function PrivateMailState({
  state,
  purpose,
  notice,
  onSetUp,
  onRetry,
}: {
  state: MailPrivateUiState;
  purpose: "read" | "compose";
  notice?: string | null | undefined;
  onSetUp: () => void;
  onRetry: () => void;
}) {
  const setupRequired = state === "not_configured";
  const unavailable = state === "unavailable";
  const purposeText = purpose === "read" ? "decrypt the subject and message" : "write and encrypt a message";
  return (
    <article className="mail-reader mail-reader--private-state" aria-label={setupRequired ? "Set up private Mail" : "Preparing private Mail"}>
      <div className="mail-reader-private-mark"><Icon name={unavailable ? "warning" : "mail"} /></div>
      <h2>
        {setupRequired
          ? "Set up private Mail"
          : unavailable
            ? "Private Mail is temporarily unavailable"
            : "Preparing private Mail…"}
      </h2>
      <p>
        {setupRequired
          ? `Create this app’s isolated private key once to ${purposeText}.`
          : unavailable
            ? notice ?? `Mail could not prepare its private key to ${purposeText}.`
            : `Mail is preparing its private key to ${purposeText}.`}
      </p>
      {setupRequired || unavailable ? (
        <button
          type="button"
          className="nt-button"
          onClick={setupRequired ? onSetUp : onRetry}
        >
          <Icon name={setupRequired ? "mail" : "retry"} />
          {setupRequired ? "Set up private Mail" : "Retry"}
        </button>
      ) : null}
    </article>
  );
}

function PrivateReaderPending(
  props: MailUiProps & { privateReady: boolean; message: MailMessageDetail },
) {
  const { message } = props;
  const peer = message.folder === "inbox" ? message.sender : message.recipient;
  const direction = message.folder === "inbox" ? "From" : "To";
  return (
    <article className="mail-reader mail-reader--outer" aria-label="Private message">
      <header className="mail-reader-header">
        <div className="mail-reader-title-row">
          <div>
            <p className="mail-eyebrow">{message.read ? "Read" : "Unread"}</p>
            <h2>Private message</h2>
          </div>
          <div className="nt-button-group mail-reader-actions" aria-label="Message actions">
            <button
              type="button"
              className="nt-icon-button mail-icon-button--danger"
              title="Delete message"
              aria-label="Delete message"
              onClick={() => props.onDeleteMessage(message.id)}
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
        <div className="mail-reader-meta">
          <div className="mail-identity">
            <span>{direction}</span>
            <div>
              <strong dir="auto">{lockedIdentityLabel(peer)}</strong>
              <IdentityPrincipalAction
                identity={{ principal: peer.principal, trust: peer.trust }}
                onAddToContacts={
                  message.folder === "inbox" && peer.trust === "not_in_contacts"
                    ? props.onAddToContacts
                    : undefined
                }
              />
            </div>
            <span className={`mail-trust${peer.trust === "in_contacts" ? " mail-trust--contact" : " mail-trust--warning"}`}>
              <Icon name={peer.trust === "in_contacts" ? "contact" : "warning"} />
              {currentContactLabel(peer)}
            </span>
          </div>
          <time dateTime={message.timestampIso} title={message.timestampIso || undefined}>
            {message.timestampLabel}
          </time>
        </div>
        {message.folder === "outbox" && message.deliveryStatus ? (
          <p className={`mail-delivery mail-delivery--${message.deliveryStatus}`}>
            {deliveryLabel(message.deliveryStatus)}
          </p>
        ) : null}
      </header>
      <div className="mail-reader-outer-body">
        <PrivateMailState
          state={props.privateMailState}
          purpose="read"
          notice={props.privateMailNotice}
          onSetUp={props.onSetUpPrivateMail}
          onRetry={props.onRetryPrivateMail}
        />
      </div>
    </article>
  );
}

function CorruptReader(
  props: MailUiProps & { privateReady: boolean; message: MailMessageDetail },
) {
  const { message } = props;
  const peer = message.folder === "inbox" ? message.sender : message.recipient;
  return (
    <article className="mail-reader mail-reader--corrupt" aria-label="Unreadable private message">
      <header className="mail-reader-header">
        <div className="mail-reader-title-row">
          <div>
            <p className="mail-eyebrow">Private Mail</p>
            <h2>Could not authenticate or decrypt this message</h2>
          </div>
          <div className="nt-button-group mail-reader-actions" aria-label="Message actions">
            {message.folder === "inbox" ? (
              <button
                type="button"
                className="nt-icon-button"
                title={message.read ? "Mark unread" : "Mark read"}
                aria-label={message.read ? "Mark unread" : "Mark read"}
                onClick={() => props.onToggleRead(message.id, !message.read)}
              >
                <Icon name={message.read ? "unread" : "read"} />
              </button>
            ) : null}
            <button
              type="button"
              className="nt-icon-button mail-icon-button--danger"
              title="Delete message"
              aria-label="Delete message"
              onClick={() => props.onDeleteMessage(message.id)}
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
        <div className="mail-reader-meta">
          <IdentityBlock identity={peer} label={message.folder === "inbox" ? "From" : "To"} />
          <time dateTime={message.timestampIso} title={message.timestampIso || undefined}>
            {message.timestampLabel}
          </time>
        </div>
      </header>
      <div className="mail-reader-outer-body" role="alert">
        <div className="mail-reader-locked-mark"><Icon name="warning" /></div>
        <p>No partial subject, sender-supplied name, or body was shown. Other messages remain available.</p>
      </div>
    </article>
  );
}

function identityLabel(identity: MailIdentity): string {
  if (identity.trust === "contact_conflict") return "Unknown sender";
  if (identity.trust === "in_contacts") {
    return identity.contactName?.trim() || shortPrincipal(identity.principal);
  }
  return identity.claimedName?.trim() || shortPrincipal(identity.principal);
}

function lockedIdentityLabel(identity: MailIdentity): string {
  if (identity.trust === "contact_conflict") return "Unknown sender";
  return identity.trust === "in_contacts" && identity.contactName?.trim()
    ? identity.contactName.trim()
    : shortPrincipal(identity.principal);
}

function currentContactLabel(identity: MailIdentity): string {
  if (identity.trust === "in_contacts") return "In Contacts";
  if (identity.trust === "contact_conflict") return "Contact conflict";
  return "Not in Contacts";
}

function shortPrincipal(principal: string): string {
  if (principal.length <= 22) return principal;
  return `${principal.slice(0, 10)}…${principal.slice(-8)}`;
}

function compactCount(value: number): string {
  return value > 999 ? "999+" : String(value);
}

function deliveryLabel(status: MailDeliveryStatus): string {
  switch (status) {
    case "sending": return "Sending";
    case "accepted": return "Accepted";
    case "not_sent": return "Not sent";
    case "delivery_uncertain": return "Check delivery";
  }
}

function messageMatchesSearch(message: MailMessageSummary, query: string): boolean {
  const peer = message.folder === "inbox" ? message.sender : message.recipient;
  return [
    message.subject ?? "",
    peer.principal,
    peer.contactName ?? "",
    peer.claimedName ?? "",
  ].some((value) => value.normalize("NFKC").toLocaleLowerCase().includes(query));
}

function contentLabel(route: MailUiRoute): string {
  switch (route) {
    case "compose": return "Compose message";
    case "settings": return "Mail settings";
    case "reader": return "Message reader";
    case "list": return "Message reader";
  }
}

type IconName =
  | "back" | "compose" | "contact" | "contact-add" | "copy" | "inbox" | "locked" | "mail" | "outbox"
  | "read" | "reply" | "retry" | "search" | "send" | "sent" | "settings" | "trash" | "unknown"
  | "unlocked" | "unread" | "warning";

function Icon({ name }: { name: IconName }) {
  let content: ReactNode;
  switch (name) {
    case "back": content = <><path d="M15 18l-6-6 6-6" /><path d="M9 12h10" /></>; break;
    case "compose": content = <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4z" /></>; break;
    case "contact": content = <><path d="M20 21a8 8 0 00-16 0" /><circle cx="12" cy="7" r="4" /><path d="M17 12l2 2 4-4" /></>; break;
    case "contact-add": content = <><path d="M15 21H3a7 7 0 0112-5" /><circle cx="9" cy="7" r="4" /><path d="M19 13v8M15 17h8" /></>; break;
    case "copy": content = <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></>; break;
    case "inbox": content = <><path d="M4 4h16l2 12H15l-2 3h-2l-2-3H2z" /><path d="M2 16h7" /><path d="M15 16h7" /></>; break;
    case "locked": content = <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 018 0v3" /></>; break;
    case "mail": content = <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>; break;
    case "outbox": content = <><path d="M4 4h16l2 12H15l-2 3h-2l-2-3H2z" /><path d="M12 4v9" /><path d="M8 8l4-4 4 4" /></>; break;
    case "read": content = <><path d="M3 6l9 6 9-6" /><path d="M3 6v12h18V6" /><path d="M3 18l6-7" /><path d="M21 18l-6-7" /></>; break;
    case "reply": content = <><path d="M9 17l-5-5 5-5" /><path d="M4 12h9a7 7 0 017 7" /></>; break;
    case "retry": content = <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M6.1 9a7 7 0 0111.5-2.5L20 11" /><path d="M17.9 15a7 7 0 01-11.5 2.5L4 13" /></>; break;
    case "search": content = <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>; break;
    case "send": content = <><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></>; break;
    case "sent": content = <><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></>; break;
    case "settings": content = <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6V21h-4v-.1A1.7 1.7 0 009 19.3a1.7 1.7 0 00-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 00.3-1.9A1.7 1.7 0 003 14H3v-4h.1a1.7 1.7 0 001.6-1 1.7 1.7 0 00-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 009 4.6 1.7 1.7 0 0010 3V3h4v.1a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 00-.3 1.9 1.7 1.7 0 001.6 1h.1v4H21a1.7 1.7 0 00-1.6 1z" /></>; break;
    case "trash": content = <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 14h10l1-14" /><path d="M10 11v6M14 11v6" /></>; break;
    case "unknown": content = <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0113-6" /><circle cx="19" cy="18" r="3" /><path d="M19 16.8v1.5M19 20h.01" /></>; break;
    case "unlocked": content = <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 017-2" /></>; break;
    case "unread": content = <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>; break;
    case "warning": content = <><path d="M12 3L2 21h20z" /><path d="M12 9v5M12 18h.01" /></>; break;
  }
  return (
    <svg className="mail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {content}
    </svg>
  );
}
