import { loadNeutronCanisterId } from "neutron-tools/app";
import {
  getMailEncryptedList,
  getMailEncryptedRecord,
  type MailBackendCurrentContact,
  type MailBackendEncryptedExactRecord,
  type MailBackendEncryptedHeader,
  type MailBackendEncryptedListItem,
  type MailBackendEncryptedListPage,
  type MailListRequest,
} from "./backend.ts";
import { MailCryptoWorkerClientError } from "./crypto_worker_client.ts";
import type { MailCryptoWorkerClient } from "./crypto_worker_client.ts";
import type {
  MailCryptoWorkerResult,
  MailWorkerEncryptedHeader,
  MailWorkerLocalWrap,
} from "./crypto_worker.ts";
import type {
  MailCryptoResidentSession,
  MailCryptoSessionSnapshot,
} from "./mail_crypto_session.ts";
import type { MailDeliveryStatus, MailFolder } from "./model.ts";
import { encodeMailEnvelopeV1 } from "./protocol.ts";

export const MAIL_PRIVATE_LIST_TOOL = "mail_private_list";
export const MAIL_PRIVATE_GET_TOOL = "mail_private_get";
export const MAIL_PRIVATE_SEARCH_TOOL = "mail_private_search";
export const MAIL_PRIVATE_HEADER_CONCURRENCY = 4;
export const MAIL_PRIVATE_SEARCH_LIMIT = 50;

export type MailPrivateHeaderProjection = {
  claimedSenderName: string;
  subject: string;
  senderCreatedAtNs: string;
  inReplyTo: string | null;
};

export type MailPrivateDecryption =
  | { state: "ready"; header: MailPrivateHeaderProjection }
  | { state: "corrupt" };

export type MailPrivateRow = {
  folder: MailFolder;
  localId: string;
  messageId: string;
  peerPrincipal: string;
  currentContact: MailBackendCurrentContact;
  timestampNs: string;
  read: boolean;
  deliveryStatus: MailDeliveryStatus | null;
  replyContextLabel: "Reply to an earlier message" | null;
  decryption: MailPrivateDecryption;
};

export type MailPrivateListPage = {
  revision: string;
  contactsRevision: string;
  cleanupEpoch: string;
  items: MailPrivateRow[];
  total: string;
  nextOffset: string | null;
  ciphertextBytes: string;
};

export type MailPrivateMessage = MailPrivateRow & {
  bodyMarkdown: string | null;
};

export type MailPrivateSearchResult = {
  query: string;
  folder: MailFolder;
  items: MailPrivateRow[];
};

export type MailPrivateErrorCode =
  | "mail_locked"
  | "capability_changed"
  | "temporarily_unavailable";

export class MailPrivateError extends Error {
  constructor(public readonly code: MailPrivateErrorCode, message: string) {
    super(message);
    this.name = "MailPrivateError";
  }
}

type MailPrivateWorkerPort = Pick<
  MailCryptoWorkerClient,
  "decryptHeader" | "decrypt"
>;

export type MailPrivateBackendPort = Pick<
  MailPrivateResidentDependencies,
  "list" | "get"
>;

export type MailPrivateSessionPort = Pick<MailCryptoResidentSession, "status">;

export type MailPrivateResidentDependencies = {
  session: Pick<MailCryptoResidentSession, "status">;
  worker: MailPrivateWorkerPort;
  list: typeof getMailEncryptedList;
  get: typeof getMailEncryptedRecord;
  selfPrincipal: () => Promise<string>;
};

/**
 * Resident-only volatile plaintext projection. It has no storage API: cache
 * entries disappear on capability drift, resident reload, or explicit
 * clear. Backend methods consumed here still return ciphertext exclusively.
 */
export class MailPrivateResidentProjection {
  readonly #dependencies: MailPrivateResidentDependencies;
  readonly #cache = new Map<string, MailPrivateRow>();
  readonly #folderRevision = new Map<MailFolder, string>();
  #pageKeys = new Set<string>();
  #exactKey: string | null = null;
  #mailRevision: string | null = null;
  #projectionGeneration = 0;
  #invalidationGeneration = 0;

  constructor(dependencies: MailPrivateResidentDependencies) {
    this.#dependencies = dependencies;
  }

  clear(): void {
    this.#projectionGeneration += 1;
    this.#invalidationGeneration += 1;
    this.#clearCache();
  }

  #clearCache(): void {
    this.#cache.clear();
    this.#folderRevision.clear();
    this.#pageKeys.clear();
    this.#exactKey = null;
    this.#mailRevision = null;
  }

  async list(
    request: MailListRequest,
    backend: MailPrivateBackendPort = this.#dependencies,
    session: MailPrivateSessionPort = this.#dependencies.session,
  ): Promise<MailPrivateListPage> {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
      throw new MailPrivateError("temporarily_unavailable", "Mail list request is invalid");
    }
    const generation = ++this.#projectionGeneration;
    const invalidationGeneration = this.#invalidationGeneration;
    const before = await this.#requireReady(session);
    const self = await this.#selfPrincipal();
    let page: MailBackendEncryptedListPage;
    try {
      page = await backend.list(request);
    } catch {
      throw new MailPrivateError(
        "temporarily_unavailable",
        "Private mail is temporarily unavailable",
      );
    }

    const folder = request.folder;
    const sameMailRevision = this.#mailRevision === page.revision;
    const reuseCachedHeaders = sameMailRevision &&
      this.#folderRevision.get(folder) === page.revision;
    const items = await mapBounded(
      page.items,
      MAIL_PRIVATE_HEADER_CONCURRENCY,
      (item) => {
        const cached = reuseCachedHeaders
          ? this.#cache.get(rowKey(item.kind, item.localId))
          : undefined;
        // A stable Mail revision freezes ciphertext and local wraps. Contacts
        // and read projections are still rebuilt from this fresh backend row.
        return cached
          ? Promise.resolve(rowFromListItem(item, cached.decryption))
          : this.#decryptRow(item, self);
      },
    );
    await this.#assertSessionStillMatches(before, session);
    this.#assertNotInvalidated(invalidationGeneration);

    // Concurrent UI refreshes already discard their superseded result. Do not
    // turn that harmless overlap into a resident-wide private-mail failure.
    // Only the newest projection commits shared cache state; an older valid
    // projection can still return its locally decrypted result to its caller.
    const isLatest = generation === this.#projectionGeneration;
    if (isLatest) {
      if (!sameMailRevision) {
        this.#clearCache();
        this.#mailRevision = page.revision;
      }
      // Keep only the current requested page. Capturing cached
      // decryptions above still makes an unchanged-page refresh free, while
      // navigating through many pages cannot accumulate hundreds of headers.
      this.#deletePage();
      this.#folderRevision.clear();
      this.#folderRevision.set(folder, page.revision);
      const pageKeys = new Set<string>();
      for (const row of items) {
        const key = rowKey(row.folder, row.localId);
        pageKeys.add(key);
        this.#cache.set(key, row);
      }
      this.#pageKeys = pageKeys;
      this.#resolveReplyContexts();
    }

    return {
      revision: page.revision,
      contactsRevision: page.contactsRevision,
      cleanupEpoch: page.cleanupEpoch,
      items: isLatest
        ? items.map((row) => this.#cache.get(rowKey(row.folder, row.localId)) ?? row)
        : items,
      total: page.total,
      nextOffset: page.nextOffset,
      ciphertextBytes: page.ciphertextBytes,
    };
  }

  async get(
    folder: MailFolder,
    localId: string,
    backend: MailPrivateBackendPort = this.#dependencies,
    session: MailPrivateSessionPort = this.#dependencies.session,
  ): Promise<MailPrivateMessage> {
    const generation = ++this.#projectionGeneration;
    const invalidationGeneration = this.#invalidationGeneration;
    const before = await this.#requireReady(session);
    const self = await this.#selfPrincipal();
    let record: MailBackendEncryptedExactRecord;
    let observedRevision: string;
    try {
      const result = await backend.get(folder, localId);
      observedRevision = result.revision;
      record = result.record;
    } catch {
      throw new MailPrivateError(
        "temporarily_unavailable",
        "Private message is temporarily unavailable",
      );
    }
    const outer = rowFromRecord(record, { state: "corrupt" });
    let message: MailPrivateMessage;
    try {
      const result = expectWorkerResult(
        await this.#dependencies.worker.decrypt({
          ...messagePrincipals(record, self),
          envelope: encodeResidentEnvelope(record.encrypted),
          localWrap: workerLocalWrap(record.encrypted.header),
        }),
        "decrypted",
      );
      if (!sameBytes(result.messageId, record.encrypted.header.messageId)) {
        throw new MailCryptoWorkerClientError("authentication_failed");
      }
      message = {
        ...outer,
        decryption: {
          state: "ready",
          header: projectHeader(result.header),
        },
        bodyMarkdown: result.body.bodyMarkdown,
      };
    } catch (error) {
      if (!isIsolatedRecordFailure(error)) throw this.#operationError(error);
      message = { ...outer, decryption: { state: "corrupt" }, bodyMarkdown: null };
    }
    await this.#assertSessionStillMatches(before, session);
    this.#assertNotInvalidated(invalidationGeneration);
    if (generation !== this.#projectionGeneration) {
      return message;
    }
    if (this.#mailRevision !== null && this.#mailRevision !== observedRevision) {
      this.#clearCache();
    }
    this.#mailRevision = observedRevision;
    const key = rowKey(folder, localId);
    const previousExact = this.#exactKey;
    this.#exactKey = key;
    if (previousExact !== null && previousExact !== key && !this.#isPageKey(previousExact)) {
      this.#cache.delete(previousExact);
    }
    this.#cache.set(key, stripBody(message));
    this.#resolveReplyContexts();
    const resolved = this.#cache.get(rowKey(folder, localId));
    return resolved ? { ...message, ...resolved, bodyMarkdown: message.bodyMarkdown } : message;
  }

  async search(
    folder: MailFolder,
    query: string,
    limit = MAIL_PRIVATE_SEARCH_LIMIT,
    session: MailPrivateSessionPort = this.#dependencies.session,
  ): Promise<MailPrivateSearchResult> {
    await this.#requireReady(session);
    const normalized = normalizeSearch(query);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAIL_PRIVATE_SEARCH_LIMIT) {
      throw new MailPrivateError("temporarily_unavailable", "Mail search limit is invalid");
    }
    const items = [...this.#cache.values()]
      .filter((row) => row.folder === folder && rowMatches(row, normalized))
      .slice(0, limit);
    return { query, folder, items };
  }

  async #decryptRow(
    item: MailBackendEncryptedListItem,
    self: string,
  ): Promise<MailPrivateRow> {
    const corrupt = rowFromListItem(item, { state: "corrupt" });
    try {
      const result = expectWorkerResult(
        await this.#dependencies.worker.decryptHeader({
          ...messagePrincipals(item, self),
          encryptedHeader: workerEncryptedHeader(item.encryptedHeader),
          localWrap: workerLocalWrap(item.encryptedHeader),
        }),
        "header_decrypted",
      );
      if (!sameBytes(result.messageId, item.encryptedHeader.messageId)) {
        throw new MailCryptoWorkerClientError("authentication_failed");
      }
      return rowFromListItem(item, {
        state: "ready",
        header: projectHeader(result.header),
      });
    } catch (error) {
      if (isIsolatedRecordFailure(error)) return corrupt;
      throw this.#operationError(error);
    }
  }

  async #requireReady(
    sessionPort: MailPrivateSessionPort,
  ): Promise<MailCryptoSessionSnapshot> {
    let session: MailCryptoSessionSnapshot;
    try {
      session = await sessionPort.status();
    } catch {
      this.clear();
      throw new MailPrivateError(
        "capability_changed",
        "Mail key access changed. Try again.",
      );
    }
    if (session.lockState !== "unlocked" || session.currentEpoch === null) {
      this.clear();
      throw new MailPrivateError("mail_locked", "Private Mail is still preparing. Try again.");
    }
    return session;
  }

  async #assertSessionStillMatches(
    before: MailCryptoSessionSnapshot,
    session: MailPrivateSessionPort,
  ): Promise<void> {
    const after = await this.#requireReady(session);
    if (
      before.currentEpoch !== after.currentEpoch ||
      before.previousEpoch !== after.previousEpoch
    ) {
      this.clear();
      throw new MailPrivateError(
        "capability_changed",
        "Mail key access changed. Try again.",
      );
    }
  }

  async #selfPrincipal(): Promise<string> {
    try {
      const value = await this.#dependencies.selfPrincipal();
      if (typeof value !== "string" || value.length < 3 || value.length > 80) {
        throw new Error("invalid principal");
      }
      return value;
    } catch {
      throw new MailPrivateError(
        "temporarily_unavailable",
        "This Neutron address is temporarily unavailable",
      );
    }
  }

  #operationError(error: unknown): MailPrivateError {
    if (
      error instanceof MailCryptoWorkerClientError &&
      (error.code === "locked" || error.code === "not_configured" || error.code === "expired")
    ) {
      this.clear();
      return new MailPrivateError("mail_locked", "Private Mail is still preparing. Try again.");
    }
    this.clear();
    return new MailPrivateError(
      "temporarily_unavailable",
      "Private mail could not be decrypted right now",
    );
  }

  #deletePage(): void {
    for (const key of this.#pageKeys) {
      if (key !== this.#exactKey) this.#cache.delete(key);
    }
    this.#pageKeys.clear();
  }

  #isPageKey(key: string): boolean {
    return this.#pageKeys.has(key);
  }

  #resolveReplyContexts(): void {
    const rows = [...this.#cache.values()];
    for (const row of rows) {
      const inReplyTo = row.decryption.state === "ready"
        ? row.decryption.header.inReplyTo
        : null;
      const target = inReplyTo === null
        ? undefined
        : rows.find((candidate) =>
            candidate.messageId === inReplyTo &&
            candidate.peerPrincipal === row.peerPrincipal &&
            candidate.decryption.state === "ready" &&
            candidate.folder !== "outbox" &&
            rowKey(candidate.folder, candidate.localId) !== rowKey(row.folder, row.localId)
          );
      const replyContextLabel = target ? "Reply to an earlier message" : null;
      if (row.replyContextLabel !== replyContextLabel) {
        this.#cache.set(rowKey(row.folder, row.localId), { ...row, replyContextLabel });
      }
    }
  }

  #assertNotInvalidated(generation: number): void {
    if (generation !== this.#invalidationGeneration) {
      throw new MailPrivateError(
        "temporarily_unavailable",
        "Mail changed while decrypting. Refresh and try again.",
      );
    }
  }
}

export function defaultMailPrivateDependencies(input: {
  session: Pick<MailCryptoResidentSession, "status">;
  worker: MailPrivateWorkerPort;
}): MailPrivateResidentDependencies {
  return {
    ...input,
    list: getMailEncryptedList,
    get: getMailEncryptedRecord,
    selfPrincipal: loadNeutronCanisterId,
  };
}

function workerEncryptedHeader(
  value: MailBackendEncryptedHeader,
): MailWorkerEncryptedHeader {
  return {
    deliveryKeyEpoch: value.deliveryKeyEpoch,
    recipientKeyFingerprint: value.deliveryKeyFingerprint.slice(),
    messageId: value.messageId.slice(),
    headerNonce: value.headerNonce.slice(),
    headerCiphertextAndTag: value.headerCiphertextAndTag.slice(),
  };
}

export function workerLocalWrap(value: MailBackendEncryptedHeader): MailWorkerLocalWrap {
  return {
    epoch: value.localWrapEpoch,
    fingerprint: value.localWrapFingerprint.slice(),
    wrappedCek: value.localWrappedCek.slice(),
  };
}

export function encodeResidentEnvelope(
  encrypted: MailBackendEncryptedExactRecord["encrypted"],
): Uint8Array {
  const header = encrypted.header;
  return encodeMailEnvelopeV1({
    version: 1,
    suite: 1,
    deliveryKeyEpoch: BigInt(header.deliveryKeyEpoch),
    recipientKeyFingerprint: header.deliveryKeyFingerprint,
    messageId: header.messageId,
    // The canonical backend projection retains the storage-local wrap. Full
    // decrypt always supplies that wrap separately, so this validated envelope
    // position is not consulted by the worker's IBE unwrap.
    recipientWrappedCek: header.localWrappedCek,
    headerNonce: header.headerNonce,
    headerCiphertextAndTag: header.headerCiphertextAndTag,
    bodyNonce: encrypted.bodyNonce,
    bodyCiphertextAndTag: encrypted.bodyCiphertextAndTag,
  });
}

export function messagePrincipals(
  value: MailBackendEncryptedListItem | MailBackendEncryptedExactRecord,
  self: string,
): { senderPrincipal: string; recipientPrincipal: string } {
  return value.kind === "inbox"
    ? { senderPrincipal: value.sender, recipientPrincipal: self }
    : { senderPrincipal: self, recipientPrincipal: value.recipient };
}

function rowFromListItem(
  item: MailBackendEncryptedListItem,
  decryption: MailPrivateDecryption,
): MailPrivateRow {
  return item.kind === "inbox"
    ? {
        folder: "inbox",
        localId: item.localId,
        messageId: hex(item.encryptedHeader.messageId),
        peerPrincipal: item.sender,
        currentContact: cloneContact(item.currentContact),
        timestampNs: item.receivedAtNs,
        read: item.read,
        deliveryStatus: null,
        replyContextLabel: null,
        decryption,
      }
    : {
        folder: item.kind,
        localId: item.localId,
        messageId: hex(item.encryptedHeader.messageId),
        peerPrincipal: item.recipient,
        currentContact: cloneContact(item.currentContact),
        timestampNs: item.createdAtNs,
        read: true,
        deliveryStatus: item.state.status,
        replyContextLabel: null,
        decryption,
      };
}

function rowFromRecord(
  item: MailBackendEncryptedExactRecord,
  decryption: MailPrivateDecryption,
): MailPrivateRow {
  return item.kind === "inbox"
    ? {
        folder: "inbox",
        localId: item.localId,
        messageId: hex(item.encrypted.header.messageId),
        peerPrincipal: item.sender,
        currentContact: cloneContact(item.currentContact),
        timestampNs: item.receivedAtNs,
        read: item.read,
        deliveryStatus: null,
        replyContextLabel: null,
        decryption,
      }
    : {
        folder: item.kind,
        localId: item.localId,
        messageId: hex(item.encrypted.header.messageId),
        peerPrincipal: item.recipient,
        currentContact: cloneContact(item.currentContact),
        timestampNs: item.createdAtNs,
        read: true,
        deliveryStatus: item.state.status,
        replyContextLabel: null,
        decryption,
      };
}

function projectHeader(value: {
  claimedSenderName: string;
  subject: string;
  senderCreatedAtNs: string;
  inReplyTo: Uint8Array | null;
}): MailPrivateHeaderProjection {
  return {
    claimedSenderName: value.claimedSenderName,
    subject: value.subject,
    senderCreatedAtNs: value.senderCreatedAtNs,
    inReplyTo: value.inReplyTo === null ? null : hex(value.inReplyTo),
  };
}

function cloneContact(value: MailBackendCurrentContact): MailBackendCurrentContact {
  return value.status === "in_contacts" ? { ...value } : { status: value.status };
}

function stripBody(value: MailPrivateMessage): MailPrivateRow {
  const { bodyMarkdown: _bodyMarkdown, ...row } = value;
  return row;
}

function rowMatches(row: MailPrivateRow, query: string): boolean {
  if (query === "") return true;
  const fields = [row.peerPrincipal];
  if (row.currentContact.status === "in_contacts") {
    fields.push(row.currentContact.contactName);
  }
  if (row.decryption.state === "ready") {
    fields.push(row.decryption.header.subject, row.decryption.header.claimedSenderName);
  }
  return fields.some((field) => field.normalize("NFKC").toLocaleLowerCase().includes(query));
}

function normalizeSearch(value: string): string {
  if (typeof value !== "string" || [...value].length > 120) {
    throw new MailPrivateError("temporarily_unavailable", "Mail search is too long");
  }
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}

function rowKey(folder: MailFolder, localId: string): string {
  return `${folder}:${localId}`;
}

function isIsolatedRecordFailure(error: unknown): boolean {
  return error instanceof MailCryptoWorkerClientError &&
    (error.code === "authentication_failed" || error.code === "invalid_request");
}

function expectWorkerResult<T extends MailCryptoWorkerResult["type"]>(
  result: MailCryptoWorkerResult,
  type: T,
): Extract<MailCryptoWorkerResult, { type: T }> {
  if (result.type !== type) {
    throw new MailCryptoWorkerClientError("crypto_unavailable");
  }
  return result as Extract<MailCryptoWorkerResult, { type: T }>;
}

async function mapBounded<Input, Output>(
  input: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(input.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, input.length) },
    async () => {
      while (next < input.length) {
        const index = next++;
        output[index] = await operation(input[index]!);
      }
    },
  );
  await Promise.all(runners);
  return output;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}
