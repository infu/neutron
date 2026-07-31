import { describe, expect, test } from "bun:test";
import { toError } from "neutron-tools/app";
import {
  canisterResultVariantError,
  mailboxThrownError,
  MailBackendMailboxError,
  MailBackendPrivateError,
  encodeMailEncryptedSettingsMutation,
  encodeMailPrepareRecipientRequest,
  encodeMailRetryRequest,
  encodeMailSendEncryptedRequest,
  parseMailDeliveryView,
  parseMailEncryptedGetResult,
  parseMailEncryptedListPage,
  parseMailEncryptedSettingsResult,
  parseMailEncryptedSettingsSetResult,
  parseMailGetResult,
  parseMailListPage,
  parseMailPreparedRecipient,
} from "../src/backend.ts";
import {
  MAIL_MAX_ENVELOPE_BYTES,
  computeMailKeyFingerprint,
  encodeMailEnvelopeV1,
} from "../src/protocol.ts";

const SENDER = "un4fu-tqaaa-aaaab-qadjq-cai";
const USER_PRINCIPAL = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";
const RECIPIENT = "ryjl3-tyaaa-aaaaa-aaaba-cai";

function bytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function wireHeader() {
  return {
    message_id: bytes(16, 1),
    delivery_key_epoch: "7",
    delivery_key_fingerprint: bytes(32, 2),
    local_wrap_epoch: "8",
    local_wrap_fingerprint: bytes(32, 3),
    local_wrapped_cek: bytes(168, 4),
    header_nonce: bytes(12, 5),
    header_ciphertext_and_tag: bytes(2_064, 6),
  };
}

function wireContent() {
  return {
    header: wireHeader(),
    body_nonce: bytes(12, 7),
    body_ciphertext_and_tag: bytes(1_040, 8),
  };
}

function currentContact() {
  return {
    in_contacts: {
      contact_id: "2",
      contact_revision: "4",
      contact_name: "Remy",
    },
  };
}

function wireInboxList() {
  return {
    mail_revision: "9",
    contacts_revision: "4",
    cleanup_epoch: "2",
    items: [{ inbox: {
      local_id: "1",
      sender: SENDER,
      received_at_ns: "1784040000000000000",
      read: false,
      known_at_receipt: true,
      current_contact: currentContact(),
      retained_bytes: "3500",
      encrypted_header: wireHeader(),
    } }],
    total: "1",
    ciphertext_bytes: "2300",
  };
}

function envelope(): Uint8Array {
  return encodeMailEnvelopeV1({
    version: 1,
    suite: 1,
    deliveryKeyEpoch: 7n,
    recipientKeyFingerprint: bytes(32, 2),
    messageId: bytes(16, 1),
    recipientWrappedCek: bytes(168, 4),
    headerNonce: bytes(12, 5),
    headerCiphertextAndTag: bytes(2_064, 6),
    bodyNonce: bytes(12, 7),
    bodyCiphertextAndTag: bytes(1_040, 8),
  });
}

test("restores the kernel's coded or canonical structured Candid error for closed parsing", () => {
  const error = toError({
    name: "CanisterResultError",
    message: "Canister call returned a domain error",
    code: "permission_required",
  });
  expect(canisterResultVariantError(error)).toEqual({ permission_required: null });

  error.name = "Error";
  expect(canisterResultVariantError(error)).toBeNull();
  error.name = "CanisterResultError";
  Object.defineProperty(error, "code", { value: "Invalid tag" });
  expect(canisterResultVariantError(error)).toBeNull();

  const structured = toError({
    revision_conflict: {
      mail_revision: "8",
      contacts_revision: "1",
      cleanup_epoch: "0",
    },
  });
  expect(structured.message).toBe(
    "revision conflict: mail revision 8, contacts revision 1, cleanup epoch 0",
  );
  expect(canisterResultVariantError(structured)).toEqual({
    revision_conflict: {
      mail_revision: "8",
      contacts_revision: "1",
      cleanup_epoch: "0",
    },
  });
  expect(mailboxThrownError(structured, "Mail cleanup")).toMatchObject({
    code: "CONFLICT",
    message: "Mail cleanup changed; refresh and review it again",
  });
  const candidFieldOrder = toError({
    revision_conflict: {
      cleanup_epoch: "0",
      contacts_revision: "1",
      mail_revision: "8",
    },
  });
  expect(canisterResultVariantError(candidFieldOrder)).toEqual({
    revision_conflict: {
      mail_revision: "8",
      contacts_revision: "1",
      cleanup_epoch: "0",
    },
  });
  expect(canisterResultVariantError(new Error(
    "revision conflict: mail revision 08, contacts revision 1, cleanup epoch 0",
  ))).toBeNull();
  expect(canisterResultVariantError(new Error(
    "revision conflict: mail revision 8, mail revision 9, cleanup epoch 0",
  ))).toBeNull();
  expect(canisterResultVariantError(new Error(
    "prefix revision conflict: mail revision 8, contacts revision 1, cleanup epoch 0",
  ))).toBeNull();
});

function encryptedSettings(revision = "1") {
  return {
    recordId: bytes(16, 1),
    revision,
    localWrapEpoch: "7",
    localWrapFingerprint: bytes(32, 2),
    localWrappedCek: bytes(168, 3),
    nonce: bytes(12, 4),
    ciphertextAndTag: bytes(32, 5),
  };
}

function wireSettings(revision = "1") {
  const value = encryptedSettings(revision);
  return {
    record_id: value.recordId,
    revision: value.revision,
    local_wrap_epoch: value.localWrapEpoch,
    local_wrap_fingerprint: value.localWrapFingerprint,
    local_wrapped_cek: value.localWrappedCek,
    nonce: value.nonce,
    ciphertext_and_tag: value.ciphertextAndTag,
  };
}

describe("resident ciphertext projections", () => {
  test("preserves defensive byte copies only in the encrypted list parser", () => {
    const wire = wireInboxList();
    const encrypted = parseMailEncryptedListPage(wire);
    expect(encrypted.items[0]?.encryptedHeader.messageId).toEqual(bytes(16, 1));
    expect(encrypted.items[0]?.encryptedHeader.headerCiphertextAndTag.byteLength).toBe(2_064);
    expect(encrypted.items[0]).not.toHaveProperty("subject");

    const locked = parseMailListPage(wire);
    expect(locked.items[0]).not.toHaveProperty("encryptedHeader");
    expect(locked.items[0]).not.toHaveProperty("encrypted_header");

    wire.items[0]!.inbox.encrypted_header.message_id.fill(9);
    expect(encrypted.items[0]?.encryptedHeader.messageId).toEqual(bytes(16, 1));

    const invalidPrincipal = wireInboxList();
    invalidPrincipal.items[0]!.inbox.sender = "aaaaa-aa";
    expect(() => parseMailEncryptedListPage(invalidPrincipal)).toThrow(
      MailBackendMailboxError,
    );
    invalidPrincipal.items[0]!.inbox.sender = USER_PRINCIPAL;
    expect(() => parseMailListPage(invalidPrincipal)).toThrow(
      MailBackendMailboxError,
    );
  });

  test("preserves exact content internally while the locked parser discards it", () => {
    const wire = {
      mail_revision: "11",
      contacts_revision: "5",
      cleanup_epoch: "2",
      record: { inbox: {
        local_id: "1",
        sender: SENDER,
        received_at_ns: "1784040000000000000",
        read: false,
        known_at_receipt: false,
        current_contact: { not_in_contacts: null },
        retained_bytes: "3500",
        encrypted: wireContent(),
      } },
    };
    const encrypted = parseMailEncryptedGetResult(wire);
    expect(encrypted.record.encrypted.bodyCiphertextAndTag.byteLength).toBe(1_040);
    expect(encrypted.record).not.toHaveProperty("subject");
    expect(parseMailGetResult(wire).record).not.toHaveProperty("encrypted");

    const sameNonce = structuredClone(wire);
    sameNonce.record.inbox.encrypted.body_nonce =
      sameNonce.record.inbox.encrypted.header.header_nonce;
    expect(() => parseMailEncryptedGetResult(sameNonce)).toThrow(
      MailBackendMailboxError,
    );
    const shortWrap = structuredClone(wire);
    shortWrap.record.inbox.encrypted.header.local_wrapped_cek = bytes(167, 4);
    expect(() => parseMailGetResult(shortWrap)).toThrow(MailBackendMailboxError);
    const zeroId = wireInboxList();
    zeroId.items[0]!.inbox.local_id = "0";
    expect(() => parseMailListPage(zeroId)).toThrow(MailBackendMailboxError);
  });

  test("accepts the maximum list page with 300 nested Blob leaves", () => {
    const items = Array.from({ length: 50 }, (_, index) => {
      const item = wireInboxList().items[0]!;
      item.inbox.local_id = (index + 1).toString();
      return item;
    });
    const parsed = parseMailEncryptedListPage({
      mail_revision: "60",
      contacts_revision: "4",
      cleanup_epoch: "2",
      items,
      total: "50",
      ciphertext_bytes: "115000",
    });
    expect(parsed.items).toHaveLength(50);
    expect(parsed.items.reduce((count, item) => {
      const header = item.encryptedHeader;
      return count + [
        header.messageId,
        header.deliveryKeyFingerprint,
        header.localWrapFingerprint,
        header.localWrappedCek,
        header.headerNonce,
        header.headerCiphertextAndTag,
      ].length;
    }, 0)).toBe(300);

    items[49]!.inbox.encrypted_header.message_id.fill(0xff);
    expect(parsed.items[49]!.encryptedHeader.messageId).toEqual(bytes(16, 1));
  });

  test("validates exact Outbox command and retry metadata", () => {
    const record = {
      local_id: "3",
      command_id: bytes(16, 9),
      recipient: RECIPIENT,
      contact_id: null,
      contact_revision: null,
      current_contact: { contact_conflict: null },
      created_at_ns: "10",
      updated_at_ns: "11",
      cleanup_epoch: "2",
      attempt_no: "2",
      attempt_request_id: bytes(16, 10),
      state: { delivery_uncertain: null },
      retained_bytes: "4400",
      encrypted: wireContent(),
    };
    const parsed = parseMailEncryptedGetResult({
      mail_revision: "12",
      contacts_revision: "5",
      cleanup_epoch: "2",
      record: { outbox: record },
    });
    expect(parsed.record.kind).toBe("outbox");
    expect(parsed.record.kind === "outbox" && parsed.record.commandId).toEqual(bytes(16, 9));
    expect(() => parseMailEncryptedGetResult({
      mail_revision: "12",
      contacts_revision: "5",
      cleanup_epoch: "2",
      record: { outbox: { ...record, attempt_no: "1" } },
    })).toThrow(MailBackendMailboxError);
    expect(() => parseMailGetResult({
      mail_revision: "12",
      contacts_revision: "5",
      cleanup_epoch: "2",
      record: { outbox: { ...record, command_id: bytes(15, 9) } },
    })).toThrow(MailBackendMailboxError);
  });
});

describe("recipient preparation and encrypted delivery boundary", () => {
  test("encodes only the closed recipient preparation request", () => {
    expect(encodeMailPrepareRecipientRequest({
      recipient: {
        kind: "contact",
        principal: RECIPIENT,
        contactId: "2",
        expectedContactRevision: "4",
      },
      permitRequestId: bytes(16, 7),
    })).toEqual({
      recipient: { contact: {
        principal: RECIPIENT,
        contact_id: "2",
        expected_contact_revision: "4",
      } },
      permit_request_id: bytes(16, 7),
    });
    expect(() => encodeMailPrepareRecipientRequest({
      recipient: { kind: "direct", principal: RECIPIENT },
      permitRequestId: bytes(16, 7),
      subject: "must never cross the boundary",
    } as never)).toThrow(MailBackendPrivateError);
    expect(() => encodeMailPrepareRecipientRequest({
      recipient: { kind: "direct", principal: USER_PRINCIPAL },
      permitRequestId: bytes(16, 7),
    })).toThrow(MailBackendPrivateError);
    expect(() => encodeMailPrepareRecipientRequest({
      recipient: { kind: "direct", principal: "aaaaa-aa" },
      permitRequestId: bytes(16, 7),
    })).toThrow(MailBackendPrivateError);
    expect(() => encodeMailPrepareRecipientRequest({
      recipient: { kind: "direct", principal: RECIPIENT },
      permitRequestId: new Uint8Array(0),
    })).toThrow(MailBackendPrivateError);
    expect(() => encodeMailPrepareRecipientRequest({
      recipient: { kind: "direct", principal: RECIPIENT },
      permitRequestId: new Uint8Array(16),
    })).toThrow(MailBackendPrivateError);
    expect(() => parseMailPreparedRecipient({
      permit_id: "01".repeat(32),
      recipient: RECIPIENT,
      contact_id: null,
      contact_revision: null,
      book_revision: "0",
      expires_at_ns: "1",
      public_info_hash: bytes(32, 2),
      key_info: {},
    })).toThrow(MailBackendPrivateError);
  });

  test("independently verifies prepared key-info fingerprint and contact binding", () => {
    const contextPublicKey = bytes(96, 0x31);
    const expectedContextPublicKey = contextPublicKey.slice();
    const effectiveIbeIdentity = bytes(32, 0x32);
    const fingerprint = computeMailKeyFingerprint({
      suite: 1,
      epoch: 7n,
      contextPublicKey,
      effectiveIbeIdentity,
    });
    const wire = {
      permit_id: bytes(32, 1),
      recipient: RECIPIENT,
      contact_id: "2",
      contact_revision: "4",
      book_revision: "8",
      expires_at_ns: "1784040300000000000",
      public_info_hash: bytes(32, 2),
      key_info: {
        protocol_version: 1,
        suite: 1,
        delivery_key_epoch: "7",
        context_public_key: contextPublicKey,
        effective_ibe_identity: effectiveIbeIdentity,
        recipient_key_fingerprint: fingerprint,
        max_envelope_bytes: MAIL_MAX_ENVELOPE_BYTES,
      },
    };
    const expected = {
      recipient: {
        kind: "contact" as const,
        principal: RECIPIENT,
        contactId: "2",
        expectedContactRevision: "4",
      },
      permitRequestId: bytes(16, 7),
    };
    const parsed = parseMailPreparedRecipient(wire, expected);
    expect(parsed.keyInfo.recipientKeyFingerprint).toEqual(fingerprint);
    expect(parsed.contactId).toBe("2");
    wire.key_info.context_public_key.fill(0xff);
    expect(parsed.keyInfo.contextPublicKey).toEqual(expectedContextPublicKey);
    expect(() => parseMailPreparedRecipient({
      ...wire,
      key_info: { ...wire.key_info, recipient_key_fingerprint: bytes(32, 9) },
    })).toThrow(MailBackendPrivateError);
    expect(() => parseMailPreparedRecipient({ ...wire, book_revision: "0" })).toThrow(
      MailBackendPrivateError,
    );
    expect(() => parseMailPreparedRecipient({ ...wire, recipient: "aaaaa-aa" })).toThrow(
      MailBackendPrivateError,
    );
    expect(() => parseMailPreparedRecipient({
      ...wire,
      recipient: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    }, expected)).toThrow(MailBackendPrivateError);
    expect(() => parseMailPreparedRecipient({ ...wire, contact_id: "3" }, expected)).toThrow(
      MailBackendPrivateError,
    );
  });

  test("validates a canonical envelope and refuses accidental plaintext fields", () => {
    const request = {
      commandId: bytes(16, 1),
      permitId: bytes(32, 2),
      recipient: RECIPIENT,
      publicInfoHash: bytes(32, 3),
      envelope: envelope(),
      localWrapEpoch: "8",
      localWrapFingerprint: bytes(32, 4),
      localWrappedCek: bytes(168, 5),
    };
    const expectedEnvelope = request.envelope.slice();
    const expectedCommandId = request.commandId.slice();
    const encoded = encodeMailSendEncryptedRequest(request);
    request.envelope.fill(0);
    request.commandId.fill(0);
    expect(encoded.envelope).toEqual(expectedEnvelope);
    expect(encoded.command_id).toEqual(expectedCommandId);
    expect(JSON.stringify(encoded)).not.toContain("subject");
    expect(() => encodeMailSendEncryptedRequest({
      ...request,
      bodyMarkdown: "private",
    } as never)).toThrow(MailBackendPrivateError);
    expect(() => encodeMailSendEncryptedRequest({
      ...request,
      commandId: expectedCommandId,
      envelope: envelope().slice(0, -1),
    })).toThrow(MailBackendPrivateError);
  });

  test("strictly parses delivery views and rejects raw Result wrappers", () => {
    expect(encodeMailRetryRequest({
      localId: "8",
      retryRequestId: bytes(16, 6),
    })).toEqual({ local_id: "8", retry_request_id: bytes(16, 6) });
    expect(parseMailDeliveryView({
      local_id: "8",
      mail_revision: "12",
      cleanup_epoch: "2",
      attempt_no: "2",
      state: { accepted: { received_at_ns: "44" } },
      updated_at_ns: "45",
    })).toMatchObject({
      localId: "8",
      attemptNo: "2",
      state: { status: "accepted", acceptedAtNs: "44" },
    });
    expect(() => parseMailDeliveryView({
      local_id: "9",
      mail_revision: "12",
      cleanup_epoch: "2",
      attempt_no: "2",
      state: { delivery_uncertain: null },
      updated_at_ns: "45",
    }, "8")).toThrow(MailBackendPrivateError);
    try {
      parseMailDeliveryView({ err: { command_deleted: { local_id: "8" } } });
      throw new Error("expected parser error");
    } catch (error) {
      expect(error).toBeInstanceOf(MailBackendPrivateError);
      expect((error as MailBackendPrivateError).code).toBe("INVALID_RESPONSE");
    }
    expect(() => parseMailDeliveryView({
      local_id: "8",
      mail_revision: "12",
      cleanup_epoch: "2",
      attempt_no: "2",
      state: { sending: null },
      updated_at_ns: "45",
      ciphertext: "not allowed",
    })).toThrow(MailBackendPrivateError);
  });
});

describe("encrypted settings boundary", () => {
  test("round-trips ciphertext without admitting plaintext", () => {
    const parsed = parseMailEncryptedSettingsResult(wireSettings());
    expect(parsed?.ciphertextAndTag).toEqual(bytes(32, 5));
    expect(parsed).not.toHaveProperty("senderName");
    expect(parseMailEncryptedSettingsResult(null)).toBeNull();
    expect(() => parseMailEncryptedSettingsResult({ ok: wireSettings() }))
      .toThrow(MailBackendPrivateError);
    expect(() => parseMailEncryptedSettingsResult([wireSettings()]))
      .toThrow(MailBackendPrivateError);
    expect(parseMailEncryptedSettingsSetResult(wireSettings("2")).revision).toBe("2");
    expect(() => parseMailEncryptedSettingsResult({
      ...wireSettings(),
      sender_name: "must never be stored",
    })).toThrow(MailBackendPrivateError);
  });

  test("encodes closed create/replace/rewrap mutations with strict CAS", () => {
    expect(encodeMailEncryptedSettingsMutation({
      kind: "create",
      settings: encryptedSettings(),
    })).toEqual({ create: wireSettings() });
    expect(encodeMailEncryptedSettingsMutation({
      kind: "replace",
      expectedRevision: "1",
      settings: encryptedSettings("2"),
    })).toEqual({
      replace: { expected_revision: "1", settings: wireSettings("2") },
    });
    expect(encodeMailEncryptedSettingsMutation({
      kind: "rewrap",
      expectedRevision: "2",
      localWrapEpoch: "8",
      localWrapFingerprint: bytes(32, 8),
      localWrappedCek: bytes(168, 9),
    })).toEqual({ rewrap: {
      expected_revision: "2",
      local_wrap_epoch: "8",
      local_wrap_fingerprint: bytes(32, 8),
      local_wrapped_cek: bytes(168, 9),
    } });
    expect(() => encodeMailEncryptedSettingsMutation({
      kind: "replace",
      expectedRevision: "1",
      settings: encryptedSettings("3"),
    })).toThrow(MailBackendPrivateError);
    expect(() => encodeMailEncryptedSettingsMutation({
      kind: "create",
      settings: { ...encryptedSettings(), senderName: "private" },
    } as never)).toThrow(MailBackendPrivateError);
  });

  test("rejects obsolete raw settings Result errors", () => {
    try {
      parseMailEncryptedSettingsResult({
        err: { revision_conflict: { expected: "1", actual: "2" } },
      });
      throw new Error("expected parser error");
    } catch (error) {
      expect(error).toBeInstanceOf(MailBackendPrivateError);
      expect((error as MailBackendPrivateError).code).toBe("INVALID_RESPONSE");
    }
    expect(() => parseMailEncryptedSettingsResult({
      err: { revision_conflict: { expected: "1", actual: "2", leaked: true } },
    })).toThrow(MailBackendPrivateError);
  });
});
