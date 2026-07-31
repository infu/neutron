import type { MailFolder, MailLockState } from "./model.ts";
import type {
  MailCleanupDialog,
  MailComposerDraft,
  MailIdentity,
  MailMessageDetail,
  MailMessageSummary,
  MailStorageSummary,
} from "./mail_ui.tsx";
import {
  deleteMailRecords,
  getMailBackendPulse,
  getMailBackendStatus,
  getMailList,
  getMailRecord,
  markMailRead,
  previewMailCleanup,
  commitMailCleanup,
  type MailBackendCleanupPreview,
  type MailBackendCleanupScope,
  type MailBackendCurrentContact,
  type MailBackendExactRecord,
  type MailBackendListItem,
  type MailBackendListPage,
  type MailBackendPulse,
  type MailBackendStatus,
} from "./backend.ts";
import type { MailCryptoSessionSnapshot } from "./mail_crypto_session.ts";
import type {
  MailPrivateMessage,
  MailPrivateRow,
} from "./mail_private.ts";

export const EMPTY_MAIL_DRAFT: MailComposerDraft = Object.freeze({
  mode: "new",
  recipientInput: "",
  recipient: null,
  subject: "",
  bodyMarkdown: "",
  replyTo: null,
});

export type MailSnapshot = {
  folder: MailFolder;
  unreadOnly: boolean;
  offset: string;
  status: MailBackendStatus;
  page: MailBackendListPage;
  loadedAt: number;
};

export type MailSnapshotState = {
  snapshot: MailSnapshot | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
};

export type MailSnapshotEvent =
  | { type: "refresh_started" }
  | { type: "refresh_succeeded"; snapshot: MailSnapshot }
  | { type: "refresh_failed"; message: string };

export const INITIAL_MAIL_SNAPSHOT_STATE: MailSnapshotState = Object.freeze({
  snapshot: null,
  loading: false,
  stale: false,
  error: null,
});

export type MailOwnerApi = {
  pulse: typeof getMailBackendPulse;
  status: typeof getMailBackendStatus;
  list: typeof getMailList;
  get: typeof getMailRecord;
  mark: typeof markMailRead;
  delete: typeof deleteMailRecords;
  cleanupPreview: typeof previewMailCleanup;
  cleanupCommit: typeof commitMailCleanup;
};

export const MAIL_OWNER_API: MailOwnerApi = Object.freeze({
  pulse: getMailBackendPulse,
  status: getMailBackendStatus,
  list: getMailList,
  get: getMailRecord,
  mark: markMailRead,
  delete: deleteMailRecords,
  cleanupPreview: previewMailCleanup,
  cleanupCommit: commitMailCleanup,
});

export function reduceMailSnapshot(
  state: MailSnapshotState,
  event: MailSnapshotEvent,
): MailSnapshotState {
  switch (event.type) {
    case "refresh_started":
      return { ...state, loading: true, error: null };
    case "refresh_succeeded":
      return {
        snapshot: event.snapshot,
        loading: false,
        stale: false,
        error: null,
      };
    case "refresh_failed":
      return {
        ...state,
        loading: false,
        stale: state.snapshot !== null,
        error: event.message,
      };
  }
}

/** Status then revision-bound list. A racing receive gets one clean retry. */
export async function loadAuthoritativeMailSnapshot(
  api: Pick<MailOwnerApi, "status" | "list">,
  folder: MailFolder,
  limit: number,
  options: {
    unreadOnly?: boolean;
    offset?: string;
    status?: MailBackendStatus;
    now?: number;
  } = {},
): Promise<MailSnapshot> {
  const unreadOnly = options.unreadOnly ?? false;
  const requestedOffset = mailPageOffset(options.offset ?? "0");
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const status = attempt === 0 && options.status
      ? options.status
      : await api.status();
    try {
      let offset = requestedOffset;
      let page = await api.list({
        folder,
        unreadOnly,
        offset,
        limit,
        expectedRevision: status.revision,
        expectedContactsRevision: status.contactsRevision,
      });
      assertMailPageMatchesSnapshotBinding(page, status, folder, offset, limit, true);

      // A deletion can leave the selected page beyond the new end. Keep the
      // window bounded and move to the final valid page instead of retaining
      // older pages or presenting an empty range with mail still available.
      if (offset !== "0" && page.items.length === 0 && BigInt(page.total) <= BigInt(offset)) {
        const total = BigInt(page.total);
        offset = total === 0n
          ? "0"
          : (((total - 1n) / BigInt(limit)) * BigInt(limit)).toString();
        page = await api.list({
          folder,
          unreadOnly,
          offset,
          limit,
          expectedRevision: status.revision,
          expectedContactsRevision: status.contactsRevision,
        });
        assertMailPageMatchesSnapshotBinding(page, status, folder, offset, limit);
      }
      return {
        folder,
        unreadOnly,
        offset,
        status,
        page,
        loadedAt: options.now ?? Date.now(),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Mail is temporarily unavailable");
}

/** Fetches exactly one page against the revision already displayed to the user. */
export async function loadRevisionBoundMailPage(
  api: Pick<MailOwnerApi, "list">,
  current: MailSnapshot,
  offset: string,
  limit: number,
  options: { now?: number } = {},
): Promise<MailSnapshot> {
  const normalizedOffset = mailPageOffset(offset);
  const page = await api.list({
    folder: current.folder,
    unreadOnly: current.unreadOnly,
    offset: normalizedOffset,
    limit,
    expectedRevision: current.status.revision,
    expectedContactsRevision: current.status.contactsRevision,
  });
  assertMailPageMatchesSnapshotBinding(
    page,
    current.status,
    current.folder,
    normalizedOffset,
    limit,
  );
  if (page.total !== current.page.total) {
    throw new Error("Mail changed while changing pages; return to the first page");
  }
  return {
    ...current,
    offset: normalizedOffset,
    page,
    loadedAt: options.now ?? Date.now(),
  };
}

export function mailSnapshotBindingIsCurrent(
  snapshot: MailSnapshot,
  status: MailBackendStatus,
  folder: MailFolder,
  unreadOnly: boolean,
  offset: string,
): boolean {
  return snapshot.folder === folder &&
    snapshot.unreadOnly === unreadOnly &&
    snapshot.offset === mailPageOffset(offset) &&
    snapshot.status.revision === status.revision &&
    snapshot.status.contactsRevision === status.contactsRevision &&
    snapshot.status.cleanupEpoch === status.cleanupEpoch &&
    snapshot.page.revision === status.revision &&
    snapshot.page.contactsRevision === status.contactsRevision &&
    snapshot.page.cleanupEpoch === status.cleanupEpoch;
}

export function mailPulseFromStatus(status: MailBackendStatus): MailBackendPulse {
  return {
    revision: status.revision,
    contactsRevision: status.contactsRevision,
    cleanupEpoch: status.cleanupEpoch,
    inboxCount: status.inboxCount,
    unread: status.unread,
  };
}

/**
 * A pulse baseline can advance ahead of the rendered page while the Inbox new
 * mail banner intentionally defers that page. This keeps subsequent idle polls
 * constant-cost until another counter or revision changes.
 */
export function mailPulseBindingIsCurrent(
  snapshot: MailSnapshot,
  observed: MailBackendPulse,
  pulse: MailBackendPulse,
  folder: MailFolder,
  unreadOnly: boolean,
  offset: string,
): boolean {
  return snapshot.folder === folder &&
    snapshot.unreadOnly === unreadOnly &&
    snapshot.offset === mailPageOffset(offset) &&
    snapshot.page.revision === snapshot.status.revision &&
    snapshot.page.contactsRevision === snapshot.status.contactsRevision &&
    snapshot.page.cleanupEpoch === snapshot.status.cleanupEpoch &&
    observed.revision === pulse.revision &&
    observed.contactsRevision === pulse.contactsRevision &&
    observed.cleanupEpoch === pulse.cleanupEpoch &&
    observed.inboxCount === pulse.inboxCount &&
    observed.unread === pulse.unread;
}

export async function probeMailPulseBinding(
  api: Pick<MailOwnerApi, "pulse">,
  snapshot: MailSnapshot,
  observed: MailBackendPulse,
  folder: MailFolder,
  unreadOnly: boolean,
  offset: string,
): Promise<{ pulse: MailBackendPulse; changed: boolean }> {
  const pulse = await api.pulse();
  return {
    pulse,
    changed: !mailPulseBindingIsCurrent(
      snapshot,
      observed,
      pulse,
      folder,
      unreadOnly,
      offset,
    ),
  };
}

function assertMailPageMatchesSnapshotBinding(
  page: MailBackendListPage,
  status: MailBackendStatus,
  folder: MailFolder,
  offset: string,
  limit: number,
  allowEmptyPastEnd = false,
): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Mail page size is invalid");
  }
  const start = BigInt(offset);
  const total = BigInt(page.total);
  const end = start + BigInt(page.items.length);
  const expectedNext = end < total ? end.toString() : null;
  const emptyPastEnd = allowEmptyPastEnd &&
    page.items.length === 0 &&
    start >= total &&
    page.nextOffset === null;
  if (
    page.revision !== status.revision ||
    page.contactsRevision !== status.contactsRevision ||
    page.cleanupEpoch !== status.cleanupEpoch ||
    page.items.length > limit ||
    page.items.some((item) => item.kind !== folder) ||
    (!emptyPastEnd && start > total) ||
    (!emptyPastEnd && end > total) ||
    (!emptyPastEnd && page.nextOffset !== expectedNext)
  ) {
    throw new Error("Mail changed while loading this page");
  }
}

function mailPageOffset(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Mail page offset is invalid");
  }
  return value;
}

export function mailLockState(
  status: MailBackendStatus | null,
  cryptoSession: MailCryptoSessionSnapshot | null = null,
): MailLockState {
  if (!status?.privateMailActive) return "not_configured";
  return cryptoSession?.lockState === "unlocked" &&
    cryptoSession.currentUnlocked &&
    cryptoSession.currentEpoch === status.currentEpoch &&
    cryptoSession.previousEpoch === status.previousEpoch &&
    (status.previousEpoch === null || cryptoSession.previousUnlocked)
    ? "unlocked"
    : "locked";
}

export function mailMessageKey(folder: MailFolder, localId: string): string {
  return `${folder}:${localId}`;
}

export function parseMailMessageKey(
  value: string,
): { folder: MailFolder; localId: string } | null {
  const match = /^(inbox|sent|outbox):(0|[1-9][0-9]*)$/u.exec(value);
  return match
    ? { folder: match[1] as MailFolder, localId: match[2]! }
    : null;
}

export function parseMailTileView(view: string): { folder: "inbox"; localId: string } | null {
  const match = /^message\/(0|[1-9][0-9]*)$/u.exec(view);
  return match ? { folder: "inbox", localId: match[1]! } : null;
}

export function lockedMessageSummary(
  item: MailBackendListItem,
  now = Date.now(),
): MailMessageSummary {
  if (item.kind === "inbox") {
    const timestamp = formatMailTimestamp(item.receivedAtNs, now);
    return {
      id: mailMessageKey("inbox", item.localId),
      folder: "inbox",
      read: item.read,
      sender: lockedIdentity(item.sender, item.currentContact),
      recipient: localIdentity(),
      subject: null,
      timestampLabel: timestamp.label,
      timestampIso: timestamp.iso,
    };
  }
  const timestamp = formatMailTimestamp(item.createdAtNs, now);
  return {
    id: mailMessageKey(item.kind, item.localId),
    folder: item.kind,
    read: true,
    sender: localIdentity(),
    recipient: lockedIdentity(item.recipient, item.currentContact),
    subject: null,
    timestampLabel: timestamp.label,
    timestampIso: timestamp.iso,
    deliveryStatus: item.state.status,
  };
}

export function lockedMessageDetail(
  record: MailBackendExactRecord,
  requestedFolder: MailFolder,
  now = Date.now(),
): MailMessageDetail {
  if (record.kind === "inbox") {
    const timestamp = formatMailTimestamp(record.receivedAtNs, now);
    return {
      id: mailMessageKey("inbox", record.localId),
      folder: "inbox",
      read: record.read,
      sender: lockedIdentity(record.sender, record.currentContact),
      recipient: localIdentity(),
      subject: null,
      bodyMarkdown: null,
      timestampLabel: timestamp.label,
      timestampIso: timestamp.iso,
    };
  }
  const folder = requestedFolder === "sent" && record.kind === "sent" ? "sent" : "outbox";
  const timestamp = formatMailTimestamp(record.createdAtNs, now);
  return {
    id: mailMessageKey(folder, record.localId),
    folder,
    read: true,
    sender: localIdentity(),
    recipient: lockedIdentity(record.recipient, record.currentContact),
    subject: null,
    bodyMarkdown: null,
    timestampLabel: timestamp.label,
    timestampIso: timestamp.iso,
    deliveryStatus: record.state.status,
  };
}

export function decryptedMessageSummary(
  row: MailPrivateRow,
  selfPrincipal: string,
  now = Date.now(),
): MailMessageSummary {
  const timestamp = formatMailTimestamp(row.timestampNs, now);
  const decryptedHeader = row.decryption.state === "ready"
    ? row.decryption.header
    : null;
  const claimedName = decryptedHeader?.claimedSenderName ?? null;
  const peer = projectedIdentity(
    row.peerPrincipal,
    row.currentContact,
    row.folder === "inbox" ? claimedName : null,
  );
  const local = localIdentity(
    selfPrincipal,
    row.folder === "inbox" ? null : claimedName,
  );
  return {
    id: mailMessageKey(row.folder, row.localId),
    folder: row.folder,
    read: row.read,
    sender: row.folder === "inbox" ? peer : local,
    recipient: row.folder === "inbox" ? localIdentity(selfPrincipal) : peer,
    subject: decryptedHeader?.subject ?? null,
    timestampLabel: timestamp.label,
    timestampIso: timestamp.iso,
    ...(row.deliveryStatus === null ? {} : { deliveryStatus: row.deliveryStatus }),
    decryptionState: decryptedHeader ? "ready" : "corrupt",
  };
}

export function decryptedMessageDetail(
  message: MailPrivateMessage,
  selfPrincipal: string,
  now = Date.now(),
): MailMessageDetail {
  const summary = decryptedMessageSummary(message, selfPrincipal, now);
  const senderTimestamp = message.decryption.state === "ready"
    ? formatMailTimestamp(message.decryption.header.senderCreatedAtNs, now)
    : null;
  return {
    ...summary,
    bodyMarkdown: message.decryption.state === "ready" ? message.bodyMarkdown : null,
    replyContextLabel: message.decryption.state === "ready"
      ? message.replyContextLabel
      : null,
    ...(senderTimestamp
      ? {
          senderTimestampLabel: senderTimestamp.label,
          senderTimestampIso: senderTimestamp.iso,
        }
      : {}),
  };
}

/** Refreshes mutable outer trust/read/delivery facts without replacing plaintext. */
export function reprojectSelectedMessageOuter(
  current: MailMessageDetail,
  outer: MailMessageDetail,
): MailMessageDetail {
  if (current.id !== outer.id || current.folder !== outer.folder) return current;
  if (current.folder === "inbox") {
    const sender = { ...outer.sender };
    if (current.sender.claimedName) sender.claimedName = current.sender.claimedName;
    return {
      ...current,
      read: outer.read,
      sender,
      timestampLabel: outer.timestampLabel,
      timestampIso: outer.timestampIso,
    };
  }
  return {
    ...current,
    recipient: outer.recipient,
    timestampLabel: outer.timestampLabel,
    timestampIso: outer.timestampIso,
    ...(outer.deliveryStatus ? { deliveryStatus: outer.deliveryStatus } : {}),
  };
}

export function replyDraftForMessage(
  message: MailMessageDetail,
): MailComposerDraft | null {
  if (
    message.folder !== "inbox" ||
    message.decryptionState !== "ready" ||
    message.subject === null ||
    message.sender.principal === "This Neutron"
  ) return null;
  const sender = message.sender;
  const label = sender.trust === "in_contacts" && sender.contactName?.trim()
    ? sender.contactName.trim()
    : sender.principal;
  const subject = /^\s*re\s*:/iu.test(message.subject)
    ? message.subject
    : [...`Re: ${message.subject}`].slice(0, 160).join("");
  return {
    mode: "reply",
    recipientInput: label,
    recipient: {
      principal: sender.principal,
      label,
      source: sender.trust === "in_contacts" ? "contact" : "principal",
    },
    subject,
    bodyMarkdown: "",
    replyTo: { folder: "inbox", localId: message.id.slice("inbox:".length) },
  };
}

export function storageSummary(status: MailBackendStatus | null): MailStorageSummary {
  if (!status) {
    return {
      usedLabel: "Unavailable",
      messageCount: 0,
      cleanupCounts: {
        read_inbox: null,
        unknown_senders: null,
        all_mail: null,
      },
    };
  }
  const inbox = boundedNumber(status.inboxCount);
  const unread = boundedNumber(status.unread);
  const sent = boundedNumber(status.sentCount);
  const outbox = boundedNumber(status.outboxCount);
  return {
    usedLabel: formatBytes(BigInt(status.inboxBytes) + BigInt(status.sentAndOutboxBytes)),
    messageCount: inbox + sent + outbox,
    level: status.storageLevel,
    cleanupCounts: {
      read_inbox: Math.max(0, inbox - unread),
      // The backend action uses current Contacts, not known-at-receipt, so only
      // its preview can state an honest count.
      unknown_senders: null,
      all_mail: inbox + sent + outbox,
    },
  };
}

export function cleanupDialog(
  preview: MailBackendCleanupPreview,
  pending = false,
  error: string | null = null,
): MailCleanupDialog {
  return {
    preview: {
      scope: preview.scope,
      previewToken: preview.previewToken,
      total: boundedNumber(preview.counts.total),
      unread: boundedNumber(preview.counts.unread),
      inbox: boundedNumber(preview.counts.inbox),
      sent: boundedNumber(preview.counts.sent),
      outbox: boundedNumber(preview.counts.outbox),
      activeSends: boundedNumber(preview.counts.activeSends),
      bytesLabel: formatBytes(BigInt(preview.counts.retainedBytes)),
    },
    ...(pending ? { pending: true } : {}),
    ...(error !== null ? { error } : {}),
  };
}

export function shouldMarkReadAfterDisplay(input: {
  surface: "tile" | "tray";
  lockState: MailLockState;
  decrypted: boolean;
  read: boolean;
  folder: MailFolder;
}): boolean {
  return (
    input.surface === "tile" &&
    input.folder === "inbox" &&
    input.lockState === "unlocked" &&
    input.decrypted &&
    !input.read
  );
}

export function mailErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Mail is temporarily unavailable";
}

export function formatMailTimestamp(
  timestampNs: string,
  now = Date.now(),
): { iso: string; label: string; relative: string } {
  try {
    const millisecondsBig = BigInt(timestampNs) / 1_000_000n;
    if (
      millisecondsBig < -8_640_000_000_000_000n ||
      millisecondsBig > 8_640_000_000_000_000n
    ) throw new RangeError("Timestamp is outside the ECMAScript Date range");
    const milliseconds = Number(millisecondsBig);
    const date = new Date(milliseconds);
    if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
      throw new RangeError("Invalid Mail timestamp");
    }
    const iso = date.toISOString();
    const label = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    const deltaSeconds = Math.max(0, Math.floor((now - milliseconds) / 1_000));
    const relative = deltaSeconds < 60
      ? "Now"
      : deltaSeconds < 3_600
        ? `${Math.floor(deltaSeconds / 60)}m`
        : deltaSeconds < 86_400
          ? `${Math.floor(deltaSeconds / 3_600)}h`
          : deltaSeconds < 604_800
            ? `${Math.floor(deltaSeconds / 86_400)}d`
            : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
    return { iso, label, relative };
  } catch {
    return { iso: "", label: "Time unavailable", relative: "" };
  }
}

export function formatBytes(bytes: bigint): string {
  if (bytes < 1_024n) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let value = Number(bytes);
  let unit = -1;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function lockedIdentity(
  principal: string,
  currentContact: MailBackendCurrentContact,
): MailIdentity {
  if (currentContact.status === "in_contacts") {
    return {
      principal,
      trust: "in_contacts",
      contactName: currentContact.contactName,
    };
  }
  return { principal, trust: currentContact.status };
}

function localIdentity(
  principal = "This Neutron",
  claimedName: string | null = null,
): MailIdentity {
  return {
    principal,
    trust: "in_contacts",
    contactName: "This Neutron",
    ...(claimedName ? { claimedName } : {}),
  };
}

function projectedIdentity(
  principal: string,
  currentContact: MailBackendCurrentContact,
  claimedName: string | null,
): MailIdentity {
  const identity = lockedIdentity(principal, currentContact);
  return claimedName ? { ...identity, claimedName } : identity;
}

function boundedNumber(value: string): number {
  const parsed = BigInt(value);
  return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
}
