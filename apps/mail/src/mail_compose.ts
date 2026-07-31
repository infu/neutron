import { loadNeutronCanisterId } from "neutron-tools/app";
import {
  MailBackendPrivateError,
  getMailEncryptedRecord,
  getMailEncryptedSettings,
  prepareMailRecipient,
  retryEncryptedMail,
  sendEncryptedMail,
  setMailEncryptedSettings,
  type MailBackendDeliveryView,
  type MailBackendEncryptedSettings,
  type MailBackendPreparedRecipient,
  type MailPrepareRecipientRequest,
} from "./backend.ts";
import type { MailCryptoWorkerClient } from "./crypto_worker_client.ts";
import type {
  MailCryptoWorkerResult,
  MailWorkerEncryptedSettings,
  MailWorkerKeyInfo,
} from "./crypto_worker.ts";
import type {
  MailCryptoResidentSession,
  MailCryptoSessionSnapshot,
} from "./mail_crypto_session.ts";
import {
  encodeResidentEnvelope,
  messagePrincipals,
  workerLocalWrap,
} from "./mail_private.ts";
import {
  validateBodyMarkdown,
  validateClaimedSenderName,
  validateSubject,
} from "./model.ts";
import {
  parseMailDeliveryAccessPreparation,
  projectMailDeliveryAccessRequest,
  type MailDeliveryAccessPreparation,
  type MailDeliveryAccessRequest,
} from "./mail_delivery_access.ts";

export const MAIL_PRIVATE_SEND_TOOL = "mail_private_send";
export const MAIL_PRIVATE_ACCESS_PREPARE_TOOL = "mail_private_access_prepare";
export const MAIL_PRIVATE_RETRY_TOOL = "mail_private_retry";
export const MAIL_PRIVATE_SETTINGS_GET_TOOL = "mail_private_settings_get";
export const MAIL_PRIVATE_SETTINGS_SET_TOOL = "mail_private_settings_set";

export type MailComposeRecipient =
  | { kind: "direct"; principal: string }
  | {
      kind: "contact";
      principal: string;
      contactId: string;
      expectedContactRevision: string;
    };

export type MailPrivateSendRequest =
  | {
      kind: "new";
      commandId: string;
      recipient: MailComposeRecipient;
      subject: string;
      bodyMarkdown: string;
      approvedPreparation?: MailDeliveryAccessPreparation;
    }
  | {
      kind: "reply";
      commandId: string;
      replyTo: { folder: "inbox"; localId: string };
      subject: string;
      bodyMarkdown: string;
      approvedPreparation?: MailDeliveryAccessPreparation;
    };

export type MailPrivateDelivery = {
  localId: string;
  revision: string;
  cleanupEpoch: string;
  attemptNo: string;
  status: "sending" | "accepted" | "not_sent" | "delivery_uncertain";
  notSentReason: MailBackendDeliveryView["state"]["notSentReason"] | null;
  updatedAtNs: string;
  staleReplacementFor: string | null;
};

export type MailPrivateSettings = {
  configured: boolean;
  senderName: string | null;
  revision: string | null;
};

export type MailComposeErrorCode =
  | "mail_locked"
  | "delivery_uncertain"
  | "delivery_state_changed"
  | "sender_name_required"
  | "invalid_draft"
  | "recipient_changed"
  | "recipient_unavailable"
  | "permission_required"
  | "mailbox_full"
  | "settings_changed"
  | "message_unavailable"
  | "capability_changed"
  | "not_retryable"
  | "temporarily_unavailable";

export class MailComposeError extends Error {
  constructor(public readonly code: MailComposeErrorCode, message: string) {
    super(message);
    this.name = "MailComposeError";
  }
}

type MailComposeWorkerPort = Pick<
  MailCryptoWorkerClient,
  "encrypt" | "decryptHeader" | "encryptSettings" | "decryptSettings"
>;

export type MailComposeBackendPort = Pick<
  MailComposeResidentDependencies,
  | "prepareRecipient"
  | "send"
  | "retry"
  | "getRecord"
  | "getSettings"
  | "setSettings"
>;

export type MailComposeSessionPort = Pick<MailCryptoResidentSession, "status">;

type NormalizedSendRequest =
  | {
      kind: "new";
      commandId: string;
      recipient: MailComposeRecipient;
      subject: string;
      bodyMarkdown: string;
      approvedPreparation: ReturnType<typeof parseMailDeliveryAccessPreparation> | null;
    }
  | {
      kind: "reply";
      commandId: string;
      replyTo: { folder: "inbox"; localId: string };
      subject: string;
      bodyMarkdown: string;
      approvedPreparation: ReturnType<typeof parseMailDeliveryAccessPreparation> | null;
    };

type RetainedSendOperation = {
  digest: string;
  exactRequest: Parameters<typeof sendEncryptedMail>[0] | null;
  result: MailPrivateDelivery | null;
  running: Promise<MailPrivateDelivery> | null;
  staleAttempt: 0 | 1;
  staleReplacementFor: string | null;
  senderCreatedAtNs: string | null;
};

const MAIL_RETAINED_SEND_OPERATIONS = 64;

export type MailComposeResidentDependencies = {
  session: Pick<MailCryptoResidentSession, "status">;
  worker: MailComposeWorkerPort;
  prepareRecipient: typeof prepareMailRecipient;
  send: typeof sendEncryptedMail;
  retry: typeof retryEncryptedMail;
  getRecord: typeof getMailEncryptedRecord;
  getSettings: typeof getMailEncryptedSettings;
  setSettings: typeof setMailEncryptedSettings;
  selfPrincipal: () => Promise<string>;
  nowNs: () => string;
  randomBytes: (length: number) => Uint8Array;
};

/**
 * Resident-only plaintext workflow. Every backend dependency accepts or
 * returns recipient metadata and ciphertext only; plaintext is consumed by
 * the worker and discarded when the same-app call settles.
 */
export class MailComposeResidentWorkflow {
  readonly #dependencies: MailComposeResidentDependencies;
  readonly #retrying = new Map<string, Promise<MailPrivateDelivery>>();
  readonly #sendOperations = new Map<string, RetainedSendOperation>();

  constructor(dependencies: MailComposeResidentDependencies) {
    this.#dependencies = dependencies;
  }

  async send(
    request: MailPrivateSendRequest,
    backend: MailComposeBackendPort = this.#dependencies,
    session: MailComposeSessionPort = this.#dependencies.session,
  ): Promise<MailPrivateDelivery> {
    const normalized = normalizeSendRequest(request);
    const digest = await sendRequestDigest(normalized);
    let retained = this.#sendOperations.get(normalized.commandId);
    if (retained) {
      if (retained.digest !== digest) {
        throw new MailComposeError(
          "invalid_draft",
          "This Mail command id was already used for different content.",
        );
      }
      if (retained.result) return cloneDelivery(retained.result);
      if (retained.running) return retained.running;
    } else {
      retained = {
        digest,
        exactRequest: null,
        result: null,
        running: null,
        staleAttempt: 0,
        staleReplacementFor: null,
        senderCreatedAtNs: null,
      };
      this.#retainSendOperation(normalized.commandId, retained);
    }

    const operation = this.#runSend(normalized, retained, backend, session)
      .catch((error) => {
        if (
          retained!.exactRequest === null &&
          retained!.staleAttempt === 0 &&
          retained!.result === null &&
          this.#sendOperations.get(normalized.commandId) === retained
        ) {
          this.#sendOperations.delete(normalized.commandId);
        }
        throw error;
      })
      .finally(() => {
        if (retained!.running === operation) retained!.running = null;
      });
    retained.running = operation;
    return operation;
  }

  async prepareDeliveryAccess(
    request: MailPrivateSendRequest,
    backend: MailComposeBackendPort = this.#dependencies,
    session: MailComposeSessionPort = this.#dependencies.session,
  ): Promise<MailDeliveryAccessRequest> {
    const normalized = normalizeSendRequest(request);
    const before = await this.#requireReady(session);
    const self = await this.#selfPrincipal();
    const recipient = normalized.kind === "new"
      ? normalized.recipient
      : (await this.#resolveReply(normalized.replyTo, self, backend)).recipient;
    await this.#assertSessionStillMatches(before, session);
    return projectMailDeliveryAccessRequest({
      recipient,
      permitRequestId: this.#randomId(16),
    });
  }

  async #runSend(
    request: NormalizedSendRequest,
    retained: RetainedSendOperation,
    backend: MailComposeBackendPort,
    session: MailComposeSessionPort,
  ): Promise<MailPrivateDelivery> {
    const before = await this.#requireReady(session);

    if (retained.exactRequest) {
      const replayed = await this.#sendExact(retained.exactRequest, backend);
      const replayProjection = this.#acceptSendResult(replayed, retained);
      if (replayProjection) return replayProjection;
    }

    const self = await this.#selfPrincipal();
    const senderName = (await this.#readSettings(self, backend)).senderName;
    if (senderName === null) {
      throw new MailComposeError(
        "sender_name_required",
        "Choose the sender name shown inside encrypted Mail before sending.",
      );
    }
    const reply = request.kind === "reply"
      ? await this.#resolveReply(request.replyTo, self, backend)
      : null;
    const recipient = request.kind === "new" ? request.recipient : reply!.recipient;
    const inReplyTo = reply?.messageId ?? null;
    const senderCreatedAtNs = retained.senderCreatedAtNs ?? this.#dependencies.nowNs();
    retained.senderCreatedAtNs = senderCreatedAtNs;

    let approved = request.approvedPreparation;
    if (approved && !sameRecipientBinding(approved.request.recipient, recipient)) {
      throw new MailComposeError(
        "recipient_changed",
        "The approved Mail recipient changed. Review it and try again.",
      );
    }
    while (true) {
      const prepared = approved?.prepared ?? await this.#prepare(recipient, backend);
      approved = null;
      await this.#assertSessionStillMatches(before, session);
      const encrypted = expectWorkerResult(
        await this.#dependencies.worker.encrypt({
          senderPrincipal: self,
          recipientPrincipal: prepared.recipient,
          recipientKey: workerKeyInfo(prepared),
          header: {
            contentSchema: 1,
            claimedSenderName: senderName,
            subject: request.subject,
            senderCreatedAtNs,
            inReplyTo,
          },
          body: { contentSchema: 1, bodyMarkdown: request.bodyMarkdown },
        }),
        "encrypted",
      );
      await this.#assertSessionStillMatches(before, session);

      const exactRequest = {
        commandId: retained.staleAttempt === 0
          ? commandIdBytes(request.commandId)
          : this.#randomId(16),
        permitId: prepared.permitId,
        recipient: prepared.recipient,
        publicInfoHash: prepared.publicInfoHash,
        envelope: encrypted.envelope,
        localWrapEpoch: encrypted.senderLocalWrap.epoch,
        localWrapFingerprint: encrypted.senderLocalWrap.fingerprint,
        localWrappedCek: encrypted.senderLocalWrap.wrappedCek,
      };
      retained.exactRequest = exactRequest;
      const delivery = await this.#sendExact(exactRequest, backend);
      const projection = this.#acceptSendResult(delivery, retained);
      if (projection) return projection;
    }
  }

  retry(
    localId: string,
    backend: MailComposeBackendPort = this.#dependencies,
  ): Promise<MailPrivateDelivery> {
    const id = positiveDecimal(localId, "Mail local id");
    const running = this.#retrying.get(id);
    if (running) return running;
    const operation = this.#retryExact(id, backend).finally(() => {
      if (this.#retrying.get(id) === operation) this.#retrying.delete(id);
    });
    this.#retrying.set(id, operation);
    return operation;
  }

  async getSettings(
    backend: MailComposeBackendPort = this.#dependencies,
    session: MailComposeSessionPort = this.#dependencies.session,
  ): Promise<MailPrivateSettings> {
    const before = await this.#requireReady(session);
    const self = await this.#selfPrincipal();
    const result = await this.#readSettings(self, backend);
    await this.#assertSessionStillMatches(before, session);
    return result;
  }

  async setSenderName(
    senderName: string,
    backend: MailComposeBackendPort = this.#dependencies,
    session: MailComposeSessionPort = this.#dependencies.session,
  ): Promise<MailPrivateSettings> {
    const name = privateSenderName(senderName);
    const before = await this.#requireReady(session);
    const self = await this.#selfPrincipal();
    let current: MailBackendEncryptedSettings | null;
    try {
      current = await backend.getSettings();
    } catch (error) {
      throw mapComposeError(error);
    }
    const revision = current === null ? "1" : incrementU64(current.revision);
    const recordId = current?.recordId ?? this.#randomId(16);
    const encrypted = expectWorkerResult(
      await this.#dependencies.worker.encryptSettings({
        selfPrincipal: self,
        senderName: name,
        recordId,
        revision,
      }),
      "settings_encrypted",
    ).encrypted;
    await this.#assertSessionStillMatches(before, session);
    const backendSettings = backendSettingsFromWorker(encrypted);
    let saved: MailBackendEncryptedSettings;
    try {
      saved = await backend.setSettings(
        current === null
          ? { kind: "create", settings: backendSettings }
          : {
              kind: "replace",
              expectedRevision: current.revision,
              settings: backendSettings,
            },
      );
    } catch (error) {
      throw mapComposeError(error);
    }
    if (!sameBackendSettings(saved, backendSettings)) {
      throw new MailComposeError(
        "temporarily_unavailable",
        "Encrypted Mail settings returned an invalid confirmation.",
      );
    }
    await this.#assertSessionStillMatches(before, session);
    return { configured: true, senderName: name, revision: saved.revision };
  }

  async #retryExact(
    localId: string,
    backend: MailComposeBackendPort,
  ): Promise<MailPrivateDelivery> {
    try {
      return projectDelivery(await backend.retry({
        localId,
        retryRequestId: this.#randomId(16),
      }), null);
    } catch (error) {
      throw mapComposeError(error);
    }
  }

  async #sendExact(
    request: Parameters<typeof sendEncryptedMail>[0],
    backend: MailComposeBackendPort,
  ): Promise<MailBackendDeliveryView> {
    try {
      return await backend.send(request);
    } catch (firstError) {
      // A lost owner-call response can hide a committed command. Replay the
      // byte-identical command once; the backend ledger returns its live state.
      if (!isBackendUnavailable(firstError)) throw mapSendError(firstError);
      try {
        return await backend.send(request);
      } catch (secondError) {
        if (isBackendUnavailable(secondError)) {
          throw new MailComposeError(
            "delivery_uncertain",
            "The delivery response was lost. The exact encrypted send is retained; choose Send again to reconcile it.",
          );
        }
        throw mapSendError(secondError);
      }
    }
  }

  #acceptSendResult(
    delivery: MailBackendDeliveryView,
    retained: RetainedSendOperation,
  ): MailPrivateDelivery | null {
    if (
      delivery.state.status === "not_sent" &&
      delivery.state.notSentReason === "stale_key" &&
      retained.staleAttempt === 0
    ) {
      retained.staleAttempt = 1;
      retained.staleReplacementFor = delivery.localId;
      retained.exactRequest = null;
      return null;
    }
    const result = projectDelivery(delivery, retained.staleReplacementFor);
    retained.result = result;
    retained.exactRequest = null;
    return cloneDelivery(result);
  }

  #retainSendOperation(key: string, operation: RetainedSendOperation): void {
    if (this.#sendOperations.size >= MAIL_RETAINED_SEND_OPERATIONS) {
      for (const [candidate, retained] of this.#sendOperations) {
        if (retained.result !== null && retained.running === null) {
          this.#sendOperations.delete(candidate);
          break;
        }
      }
    }
    if (this.#sendOperations.size >= MAIL_RETAINED_SEND_OPERATIONS) {
      throw new MailComposeError(
        "temporarily_unavailable",
        "Too many private Mail sends are awaiting reconciliation. Review Outbox and try again.",
      );
    }
    this.#sendOperations.set(key, operation);
  }

  async #prepare(
    recipient: MailComposeRecipient,
    backend: MailComposeBackendPort,
  ): Promise<MailBackendPreparedRecipient> {
    const request: MailPrepareRecipientRequest = {
      recipient,
      permitRequestId: this.#randomId(16),
    };
    try {
      return await backend.prepareRecipient(request);
    } catch (error) {
      throw mapComposeError(error);
    }
  }

  async #resolveReply(
    replyTo: { folder: "inbox"; localId: string },
    self: string,
    backend: MailComposeBackendPort,
  ): Promise<{ recipient: MailComposeRecipient; messageId: Uint8Array }> {
    if (!replyTo || replyTo.folder !== "inbox") {
      throw new MailComposeError("invalid_draft", "Reply source is invalid.");
    }
    const localId = positiveDecimal(replyTo.localId, "Reply local id");
    let record: Awaited<ReturnType<typeof getMailEncryptedRecord>>["record"];
    try {
      record = (await backend.getRecord("inbox", localId)).record;
    } catch {
      throw new MailComposeError(
        "message_unavailable",
        "The original message is unavailable. Reopen it before replying.",
      );
    }
    if (record.kind !== "inbox") {
      throw new MailComposeError("message_unavailable", "The original message is unavailable.");
    }
    const authenticated = expectWorkerResult(
      await this.#dependencies.worker.decryptHeader({
        ...messagePrincipals(record, self),
        encryptedHeader: {
          deliveryKeyEpoch: record.encrypted.header.deliveryKeyEpoch,
          recipientKeyFingerprint: record.encrypted.header.deliveryKeyFingerprint,
          messageId: record.encrypted.header.messageId,
          headerNonce: record.encrypted.header.headerNonce,
          headerCiphertextAndTag: record.encrypted.header.headerCiphertextAndTag,
        },
        localWrap: workerLocalWrap(record.encrypted.header),
      }),
      "header_decrypted",
    );
    if (!sameBytes(authenticated.messageId, record.encrypted.header.messageId)) {
      throw new MailComposeError("message_unavailable", "The original message is invalid.");
    }
    const recipient: MailComposeRecipient = record.currentContact.status === "in_contacts"
      ? {
          kind: "contact",
          principal: record.sender,
          contactId: record.currentContact.contactId,
          expectedContactRevision: record.currentContact.contactRevision,
        }
      : { kind: "direct", principal: record.sender };
    return { recipient, messageId: authenticated.messageId.slice() };
  }

  async #readSettings(
    self: string,
    backend: MailComposeBackendPort,
  ): Promise<MailPrivateSettings> {
    let settings: MailBackendEncryptedSettings | null;
    try {
      settings = await backend.getSettings();
    } catch (error) {
      throw mapComposeError(error);
    }
    if (settings === null) {
      return { configured: false, senderName: null, revision: null };
    }
    try {
      const result = expectWorkerResult(
        await this.#dependencies.worker.decryptSettings({
          selfPrincipal: self,
          encrypted: workerSettingsFromBackend(settings),
        }),
        "settings_decrypted",
      );
      return { configured: true, senderName: result.senderName, revision: settings.revision };
    } catch {
      throw new MailComposeError(
        "temporarily_unavailable",
        "Encrypted sender settings could not be authenticated or decrypted.",
      );
    }
  }

  async #requireReady(
    sessionPort: MailComposeSessionPort,
  ): Promise<MailCryptoSessionSnapshot> {
    let session: MailCryptoSessionSnapshot;
    try {
      session = await sessionPort.status();
    } catch {
      throw new MailComposeError(
        "capability_changed",
        "Mail key access changed. Try again.",
      );
    }
    if (session.lockState !== "unlocked" || session.currentEpoch === null) {
      throw new MailComposeError("mail_locked", "Private Mail is still preparing. Try again.");
    }
    return session;
  }

  async #assertSessionStillMatches(
    before: MailCryptoSessionSnapshot,
    session: MailComposeSessionPort,
  ): Promise<void> {
    const after = await this.#requireReady(session);
    if (
      before.currentEpoch !== after.currentEpoch ||
      before.previousEpoch !== after.previousEpoch
    ) {
      throw new MailComposeError(
        "capability_changed",
        "Mail key access changed. Try again.",
      );
    }
  }

  async #selfPrincipal(): Promise<string> {
    try {
      const value = await this.#dependencies.selfPrincipal();
      if (typeof value !== "string" || value.length < 3 || value.length > 80) throw new Error();
      return value;
    } catch {
      throw new MailComposeError(
        "temporarily_unavailable",
        "This Neutron address is temporarily unavailable.",
      );
    }
  }

  #randomId(length: number): Uint8Array {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = this.#dependencies.randomBytes(length);
      if (value instanceof Uint8Array && value.byteLength === length && value.some(Boolean)) {
        return value.slice();
      }
    }
    throw new MailComposeError(
      "temporarily_unavailable",
      "Secure Mail randomness is temporarily unavailable.",
    );
  }
}

export function defaultMailComposeDependencies(input: {
  session: Pick<MailCryptoResidentSession, "status">;
  worker: MailComposeWorkerPort;
}): MailComposeResidentDependencies {
  return {
    ...input,
    prepareRecipient: prepareMailRecipient,
    send: sendEncryptedMail,
    retry: retryEncryptedMail,
    getRecord: getMailEncryptedRecord,
    getSettings: getMailEncryptedSettings,
    setSettings: setMailEncryptedSettings,
    selfPrincipal: loadNeutronCanisterId,
    nowNs: () => (BigInt(Date.now()) * 1_000_000n).toString(),
    randomBytes: secureRandomBytes,
  };
}

function normalizeRecipient(value: MailComposeRecipient): MailComposeRecipient {
  if (!value || typeof value.principal !== "string") invalidDraft();
  if (value.kind === "direct") {
    if (Object.keys(value).length !== 2) invalidDraft();
    return { kind: "direct", principal: value.principal };
  }
  if (
    value.kind !== "contact" ||
    Object.keys(value).length !== 4
  ) invalidDraft();
  return {
    kind: "contact",
    principal: value.principal,
    contactId: positiveDecimal(value.contactId, "Mail contact id"),
    expectedContactRevision: positiveDecimal(
      value.expectedContactRevision,
      "Mail contact revision",
    ),
  };
}

function normalizeSendRequest(value: MailPrivateSendRequest): NormalizedSendRequest {
  const commandId = privateCommandId(value.commandId);
  const subject = privateSubject(value.subject);
  const bodyMarkdown = privateBody(value.bodyMarkdown);
  if (value.kind === "new") {
    return {
      kind: "new",
      commandId,
      recipient: normalizeRecipient(value.recipient),
      subject,
      bodyMarkdown,
      approvedPreparation: value.approvedPreparation === undefined
        ? null
        : parseMailDeliveryAccessPreparation(value.approvedPreparation),
    };
  }
  if (value.kind !== "reply" || value.replyTo?.folder !== "inbox") invalidDraft();
  return {
    kind: "reply",
    commandId,
    replyTo: {
      folder: "inbox",
      localId: positiveDecimal(value.replyTo.localId, "Reply local id"),
    },
    subject,
    bodyMarkdown,
    approvedPreparation: value.approvedPreparation === undefined
      ? null
      : parseMailDeliveryAccessPreparation(value.approvedPreparation),
  };
}

function sameRecipientBinding(
  left: MailPrepareRecipientRequest["recipient"],
  right: MailComposeRecipient,
): boolean {
  return left.kind === right.kind &&
    left.principal === right.principal &&
    (left.kind === "direct" || (right.kind === "contact" &&
      left.contactId === right.contactId &&
      left.expectedContactRevision === right.expectedContactRevision));
}

async function sendRequestDigest(value: NormalizedSendRequest): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new MailComposeError(
      "temporarily_unavailable",
      "Secure Mail command reconciliation is unavailable in this browser.",
    );
  }
  const canonical = value.kind === "new"
    ? JSON.stringify({
        kind: value.kind,
        commandId: value.commandId,
        recipient: value.recipient,
        subject: value.subject,
        bodyMarkdown: value.bodyMarkdown,
      })
    : JSON.stringify({
        kind: value.kind,
        commandId: value.commandId,
        replyTo: value.replyTo,
        subject: value.subject,
        bodyMarkdown: value.bodyMarkdown,
      });
  const digest = await cryptoApi.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return hexBytes(new Uint8Array(digest));
}

function privateCommandId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value) || /^0+$/u.test(value)) {
    throw new MailComposeError("invalid_draft", "Mail command id is invalid.");
  }
  return value;
}

function commandIdBytes(value: string): Uint8Array {
  const id = privateCommandId(value);
  const output = new Uint8Array(16);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(id.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function workerKeyInfo(prepared: MailBackendPreparedRecipient): MailWorkerKeyInfo {
  return {
    suite: 1,
    epoch: prepared.keyInfo.deliveryKeyEpoch,
    fingerprint: prepared.keyInfo.recipientKeyFingerprint.slice(),
    contextPublicKey: prepared.keyInfo.contextPublicKey.slice(),
    effectiveIbeIdentity: prepared.keyInfo.effectiveIbeIdentity.slice(),
  };
}

function workerSettingsFromBackend(
  settings: MailBackendEncryptedSettings,
): MailWorkerEncryptedSettings {
  return {
    recordId: settings.recordId.slice(),
    revision: settings.revision,
    localWrap: {
      epoch: settings.localWrapEpoch,
      fingerprint: settings.localWrapFingerprint.slice(),
      wrappedCek: settings.localWrappedCek.slice(),
    },
    nonce: settings.nonce.slice(),
    ciphertextAndTag: settings.ciphertextAndTag.slice(),
  };
}

function backendSettingsFromWorker(
  settings: MailWorkerEncryptedSettings,
): MailBackendEncryptedSettings {
  return {
    recordId: settings.recordId.slice(),
    revision: positiveDecimal(settings.revision, "Mail settings revision"),
    localWrapEpoch: positiveDecimal(settings.localWrap.epoch, "Mail settings key epoch"),
    localWrapFingerprint: settings.localWrap.fingerprint.slice(),
    localWrappedCek: settings.localWrap.wrappedCek.slice(),
    nonce: settings.nonce.slice(),
    ciphertextAndTag: settings.ciphertextAndTag.slice(),
  };
}

function projectDelivery(
  value: MailBackendDeliveryView,
  staleReplacementFor: string | null,
): MailPrivateDelivery {
  return {
    localId: value.localId,
    revision: value.revision,
    cleanupEpoch: value.cleanupEpoch,
    attemptNo: value.attemptNo,
    status: value.state.status,
    notSentReason: value.state.notSentReason ?? null,
    updatedAtNs: value.updatedAtNs,
    staleReplacementFor,
  };
}

function cloneDelivery(value: MailPrivateDelivery): MailPrivateDelivery {
  return { ...value };
}

function mapComposeError(error: unknown): MailComposeError {
  if (error instanceof MailComposeError) return error;
  if (error instanceof MailBackendPrivateError) {
    switch (error.code) {
      case "RECIPIENT_CHANGED":
        return new MailComposeError("recipient_changed", "That contact changed. Review the recipient and try again.");
      case "RECIPIENT_UNAVAILABLE":
      case "NOT_CONFIGURED":
        return new MailComposeError("recipient_unavailable", "That canister does not support private Neutron Mail V1.");
      case "PERMISSION_REQUIRED":
        return new MailComposeError(
          "permission_required",
          "Mail delivery setup is incomplete, or another app owns access to that recipient canister.",
        );
      case "MAILBOX_FULL":
        return new MailComposeError("mailbox_full", "That mailbox is full.");
      case "REVISION_CONFLICT":
        return new MailComposeError("settings_changed", "Sender settings changed. Reload them before saving.");
      case "NOT_RETRYABLE":
      case "ATTEMPT_SUPERSEDED":
        return new MailComposeError("not_retryable", "That Outbox item is not retryable now.");
      case "NOT_FOUND":
      case "RETRY_DELETED":
      case "COMMAND_DELETED":
        return new MailComposeError("message_unavailable", "That Outbox item is no longer available.");
      default:
        break;
    }
  }
  return new MailComposeError(
    "temporarily_unavailable",
    "Private Mail is temporarily unavailable. Your unsent text remains in this tile.",
  );
}

function mapSendError(error: unknown): MailComposeError {
  if (error instanceof MailBackendPrivateError && error.code === "ATTEMPT_SUPERSEDED") {
    return new MailComposeError(
      "delivery_state_changed",
      "Mail could not confirm this send because its Outbox state changed. The recipient may have received it; your draft is unchanged.",
    );
  }
  return mapComposeError(error);
}

function isBackendUnavailable(error: unknown): boolean {
  return error instanceof MailBackendPrivateError && error.code === "BACKEND_UNAVAILABLE";
}

function expectWorkerResult<T extends MailCryptoWorkerResult["type"]>(
  result: MailCryptoWorkerResult,
  type: T,
): Extract<MailCryptoWorkerResult, { type: T }> {
  if (result.type !== type) {
    throw new MailComposeError(
      "temporarily_unavailable",
      "Private Mail crypto returned an unexpected response.",
    );
  }
  return result as Extract<MailCryptoWorkerResult, { type: T }>;
}

function privateSubject(value: unknown): string {
  try {
    return validateSubject(value);
  } catch {
    throw new MailComposeError("invalid_draft", "Add a subject within the Mail limit.");
  }
}

function privateBody(value: unknown): string {
  try {
    return validateBodyMarkdown(value);
  } catch {
    throw new MailComposeError("invalid_draft", "The Markdown message is larger than 32 KiB or contains unsupported controls.");
  }
}

function privateSenderName(value: unknown): string {
  try {
    return validateClaimedSenderName(value);
  } catch {
    throw new MailComposeError("invalid_draft", "Choose a sender name within the Mail limit.");
  }
}

function positiveDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value) || value.length > 20) {
    throw new MailComposeError("invalid_draft", `${label} is invalid.`);
  }
  return value;
}

function incrementU64(value: string): string {
  const current = BigInt(positiveDecimal(value, "Mail settings revision"));
  if (current >= (1n << 64n) - 1n) {
    throw new MailComposeError("settings_changed", "Mail settings revision is exhausted.");
  }
  return (current + 1n).toString();
}

function sameBackendSettings(
  left: MailBackendEncryptedSettings,
  right: MailBackendEncryptedSettings,
): boolean {
  return left.revision === right.revision &&
    left.localWrapEpoch === right.localWrapEpoch &&
    sameBytes(left.recordId, right.recordId) &&
    sameBytes(left.localWrapFingerprint, right.localWrapFingerprint) &&
    sameBytes(left.localWrappedCek, right.localWrappedCek) &&
    sameBytes(left.nonce, right.nonce) &&
    sameBytes(left.ciphertextAndTag, right.ciphertextAndTag);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function hexBytes(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function secureRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues || !Number.isSafeInteger(length) || length < 1) {
    throw new MailComposeError("temporarily_unavailable", "Secure Mail randomness is unavailable.");
  }
  const output = new Uint8Array(length);
  globalThis.crypto.getRandomValues(output);
  return output;
}

function invalidDraft(): never {
  throw new MailComposeError("invalid_draft", "The Mail recipient is invalid.");
}
