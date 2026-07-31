import type {
  JsonObject,
  ScopedKernelClient,
  SelfCallValue,
} from "neutron-tools/app";
import {
  MailBackendMailboxError,
  MailBackendPrivateError,
  MailBackendStatusError,
  encodeMailEncryptedSettingsMutation,
  encodeMailListRequest,
  encodeMailPrepareRecipientRequest,
  encodeMailRecipientsRequest,
  encodeMailRetryRequest,
  encodeMailSendEncryptedRequest,
  isMailCryptoNotConfiguredError,
  parseMailBackendStatus,
  parseMailCleanupPreview,
  parseMailCryptoStatus,
  parseMailDeliveryView,
  parseMailEncryptedGetResult,
  parseMailEncryptedListPage,
  parseMailEncryptedSettingsResult,
  parseMailEncryptedSettingsSetResult,
  parseMailMutationResult,
  parseMailPreparedRecipient,
  parseMailRecipientsPage,
  validateMailListPageForRequest,
  type MailBackendCleanupPreview,
  type MailBackendCleanupScope,
  type MailBackendCryptoProgress,
  type MailBackendDeliveryView,
  type MailBackendEncryptedGetResult,
  type MailBackendEncryptedListPage,
  type MailBackendEncryptedSettings,
  type MailBackendMutationResult,
  type MailBackendPreparedRecipient,
  type MailBackendRecipientsPage,
  type MailBackendStatus,
  type MailEncryptedSettingsMutation,
  type MailListRequest,
  type MailPrepareRecipientRequest,
  type MailRecipientsRequest,
  type MailRetryRequest,
  type MailSendEncryptedRequest,
} from "./backend.ts";
import type { MailFolder } from "./model.ts";
import type { MailComposeBackendPort } from "./mail_compose.ts";
import type { MailPrivateBackendPort } from "./mail_private.ts";

const QUERY_TIMEOUT_SECONDS = 30;
const UPDATE_TIMEOUT_SECONDS = 75;

export type MailScopedBackend = ReturnType<typeof createMailScopedBackend>;

/**
 * Backend adapter for a called Mail tool. It deliberately owns no global bus
 * fallback: every nested owner call preserves the invocation carried by the
 * exact context.kernel supplied to the handler.
 */
export function createMailScopedBackend(kernel: ScopedKernelClient) {
  const query = (method: string, args: SelfCallValue[]) =>
    kernel.querySelf<SelfCallValue>(method, args, QUERY_TIMEOUT_SECONDS);
  const update = (method: string, args: SelfCallValue[]) =>
    kernel.updateSelf<SelfCallValue>(method, args, UPDATE_TIMEOUT_SECONDS);

  return {
    async status(): Promise<MailBackendStatus> {
      try {
        return parseMailBackendStatus(await query("mail_status", [null]));
      } catch (error) {
        if (error instanceof MailBackendStatusError) throw error;
        throw new MailBackendStatusError(
          "BACKEND_UNAVAILABLE",
          "Mail status is temporarily unavailable",
        );
      }
    },

    async cryptoStatus(): Promise<MailBackendCryptoProgress | null> {
      try {
        return parseMailCryptoStatus(await query("mail_crypto_status", [null]));
      } catch (error) {
        if (isMailCryptoNotConfiguredError(error)) return null;
        throw new MailBackendPrivateError(
          "BACKEND_UNAVAILABLE",
          "Private Mail key status is temporarily unavailable",
        );
      }
    },

    async recipients(request: MailRecipientsRequest): Promise<MailBackendRecipientsPage> {
      const encoded = encodeMailRecipientsRequest(request);
      try {
        return parseMailRecipientsPage(
          await query("mail_recipients", [encoded]),
          request.limit,
          encoded.offset as string,
        );
      } catch (error) {
        if (error instanceof MailBackendMailboxError) throw error;
        throw mailboxTransportError(error, "Mail recipients are temporarily unavailable");
      }
    },

    async encryptedList(request: MailListRequest): Promise<MailBackendEncryptedListPage> {
      const encoded = encodeMailListRequest(request);
      try {
        const page = parseMailEncryptedListPage(
          await query("mail_list_encrypted", [encoded]),
        );
        if (page.items.some((item) => item.kind !== request.folder)) {
          throw new MailBackendMailboxError("INVALID_RESPONSE", "Mail list folder is invalid");
        }
        validateMailListPageForRequest(page, request.limit, encoded.offset as string);
        return page;
      } catch (error) {
        if (error instanceof MailBackendMailboxError) throw error;
        throw mailboxTransportError(error, "Mail list is temporarily unavailable");
      }
    },

    async encryptedGet(
      folder: MailFolder,
      localId: string,
    ): Promise<MailBackendEncryptedGetResult> {
      const encoded = encodeGet(folder, localId);
      try {
        const result = parseMailEncryptedGetResult(
          await query("mail_get_encrypted", [encoded]),
        );
        if (
          result.record.kind !== folder ||
          result.record.localId !== encoded.local_id
        ) {
          throw new MailBackendMailboxError("INVALID_RESPONSE", "Mail record store is invalid");
        }
        return result;
      } catch (error) {
        if (error instanceof MailBackendMailboxError) throw error;
        throw mailboxTransportError(error, "Mail message is temporarily unavailable");
      }
    },

    async prepare(
      request: MailPrepareRecipientRequest,
    ): Promise<MailBackendPreparedRecipient> {
      const encoded = encodeMailPrepareRecipientRequest(request);
      try {
        return parseMailPreparedRecipient(
          await update("mail_prepare_recipient", [encoded]),
          request,
        );
      } catch (error) {
        throw privateTransportError(error, "Mail recipient preparation");
      }
    },

    async send(request: MailSendEncryptedRequest): Promise<MailBackendDeliveryView> {
      const encoded = encodeMailSendEncryptedRequest(request);
      try {
        return parseMailDeliveryView(await update("mail_send_encrypted", [encoded]));
      } catch (error) {
        throw privateTransportError(error, "Mail send");
      }
    },

    async retry(request: MailRetryRequest): Promise<MailBackendDeliveryView> {
      const encoded = encodeMailRetryRequest(request);
      try {
        return parseMailDeliveryView(
          await update("mail_retry", [encoded]),
          request.localId,
        );
      } catch (error) {
        throw privateTransportError(error, "Mail retry");
      }
    },

    async encryptedSettings(): Promise<MailBackendEncryptedSettings | null> {
      try {
        return parseMailEncryptedSettingsResult(
          await query("mail_settings_encrypted", [null]),
        );
      } catch (error) {
        throw privateTransportError(error, "Encrypted Mail settings");
      }
    },

    async setEncryptedSettings(
      mutation: MailEncryptedSettingsMutation,
    ): Promise<MailBackendEncryptedSettings> {
      const encoded = encodeMailEncryptedSettingsMutation(mutation);
      try {
        return parseMailEncryptedSettingsSetResult(
          await update("mail_settings_set_encrypted", [encoded]),
        );
      } catch (error) {
        throw privateTransportError(error, "Encrypted Mail settings update");
      }
    },

    async mark(localIds: readonly string[], read: boolean): Promise<MailBackendMutationResult> {
      const ids = uniquePositiveDecimals(localIds, "Mail mark ids", 100);
      try {
        return parseMailMutationResult(
          await update("mail_mark", [{ local_ids: ids, read }]),
        );
      } catch (error) {
        if (error instanceof MailBackendMailboxError) throw error;
        throw mailboxTransportError(error, "Mail could not update the read state");
      }
    },

    async delete(
      targets: readonly { folder: MailFolder; localId: string }[],
    ): Promise<MailBackendMutationResult> {
      if (targets.length < 1 || targets.length > 100) {
        throw new MailBackendMailboxError(
          "INVALID_REQUEST",
          "Mail delete batch is invalid",
        );
      }
      const seen = new Set<string>();
      const encoded = targets.map((target) => {
        const store = target.folder === "inbox" ? "inbox" : "outbox";
        const id = positiveDecimal(target.localId, "Mail local id");
        const key = `${store}:${id}`;
        if (seen.has(key)) {
          throw new MailBackendMailboxError(
            "INVALID_REQUEST",
            "Mail delete targets must be unique",
          );
        }
        seen.add(key);
        return { [store]: id };
      });
      try {
        return parseMailMutationResult(
          await update("mail_delete", [{ targets: encoded }]),
        );
      } catch (error) {
        if (error instanceof MailBackendMailboxError) throw error;
        throw mailboxTransportError(error, "Mail could not delete the message");
      }
    },

    async cleanupPreview(
      scope: MailBackendCleanupScope,
    ): Promise<MailBackendCleanupPreview> {
      try {
        return parseMailCleanupPreview(await query("mail_cleanup_preview", [
          { [cleanupScope(scope)]: null },
        ]));
      } catch (error) {
        if (error instanceof MailBackendMailboxError) throw error;
        throw mailboxTransportError(error, "Mail cleanup preview is unavailable");
      }
    },

    async cleanupCommit(
      preview: MailBackendCleanupPreview,
    ): Promise<MailBackendMutationResult> {
      try {
        return parseMailMutationResult(await update("mail_cleanup", [
          encodeCleanupPreview(preview),
        ]));
      } catch (error) {
        if (error instanceof MailBackendMailboxError) throw error;
        throw mailboxTransportError(error, "Mail cleanup could not be completed");
      }
    },
  };
}

export function mailComposeBackendPort(
  backend: MailScopedBackend,
): MailComposeBackendPort {
  return {
    prepareRecipient: (request) => backend.prepare(request),
    send: (request) => backend.send(request),
    retry: (request) => backend.retry(request),
    getRecord: (folder, localId) => backend.encryptedGet(folder, localId),
    getSettings: () => backend.encryptedSettings(),
    setSettings: (mutation) => backend.setEncryptedSettings(mutation),
  };
}

export function mailPrivateBackendPort(
  backend: MailScopedBackend,
): MailPrivateBackendPort {
  return {
    list: (request) => backend.encryptedList(request),
    get: (folder, localId) => backend.encryptedGet(folder, localId),
  };
}

function mailboxTransportError(_error: unknown, message: string): MailBackendMailboxError {
  return new MailBackendMailboxError("BACKEND_UNAVAILABLE", message);
}

function privateTransportError(error: unknown, label: string): MailBackendPrivateError {
  if (error instanceof MailBackendPrivateError) return error;
  return new MailBackendPrivateError(
    isPermissionFailure(error) ? "PERMISSION_REQUIRED" : "BACKEND_UNAVAILABLE",
    isPermissionFailure(error)
      ? `${label} needs approval in the focused Mail tile`
      : `${label} is temporarily unavailable`,
  );
}

function isPermissionFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "OWNER_REQUIRED" ||
    code === "USER_INTERACTION_REQUIRED" ||
    code === "AGENT_CONSENT_DENIED" ||
    code === "AGENT_CONSENT_TIMEOUT" ||
    code === "AGENT_CONSENT_LIMIT" ||
    code === "AGENT_MODE_REVOKED" ||
    code === "AGENT_MODE_LIMIT";
}

function encodeGet(folder: MailFolder, localId: string): JsonObject & { local_id: string } {
  if (folder !== "inbox" && folder !== "sent" && folder !== "outbox") {
    throw new MailBackendMailboxError("INVALID_REQUEST", "Mail folder is invalid");
  }
  return {
    store: { [folder === "inbox" ? "inbox" : "outbox"]: null },
    local_id: positiveDecimal(localId, "Mail local id"),
  };
}

function uniquePositiveDecimals(
  values: readonly string[],
  label: string,
  maximum: number,
): string[] {
  if (values.length < 1 || values.length > maximum) {
    throw new MailBackendMailboxError("INVALID_REQUEST", `${label} batch is invalid`);
  }
  const result = values.map((value) => positiveDecimal(value, label));
  if (new Set(result).size !== result.length) {
    throw new MailBackendMailboxError("INVALID_REQUEST", `${label} must be unique`);
  }
  return result;
}

function positiveDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value) || value.length > 20) {
    throw new MailBackendMailboxError("INVALID_REQUEST", `${label} is invalid`);
  }
  return value;
}

function cleanupScope(
  scope: MailBackendCleanupScope,
): "read_inbox" | "unknown_current" | "all_mail" {
  switch (scope) {
    case "read_inbox": return "read_inbox";
    case "unknown_senders": return "unknown_current";
    case "all_mail": return "all_mail";
  }
}

function encodeCleanupPreview(preview: MailBackendCleanupPreview): JsonObject {
  return {
    scope: { [cleanupScope(preview.scope)]: null },
    mail_revision: preview.revision,
    contacts_revision: preview.contactsRevision,
    cleanup_epoch: preview.cleanupEpoch,
    counts: {
      total: preview.counts.total,
      unread: preview.counts.unread,
      inbox: preview.counts.inbox,
      sent: preview.counts.sent,
      outbox: preview.counts.outbox,
      active_sends: preview.counts.activeSends,
      retained_bytes: preview.counts.retainedBytes,
    },
  };
}
