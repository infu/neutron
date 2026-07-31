import { describe, expect, test } from "bun:test";
import {
  MailBackendMailboxError,
  encodeMailListRequest,
  encodeMailRecipientsRequest,
  parseMailCleanupPreview,
  parseMailGetResult,
  parseMailListPage,
  parseMailMutationResult,
  parseMailRecipientsPage,
  validateMailListPageForRequest,
} from "../src/backend.ts";

const SENDER = "un4fu-tqaaa-aaaab-qadjq-cai";
const RECIPIENT = "ryjl3-tyaaa-aaaaa-aaaba-cai";

test("encodes Candid Nat request fields as canonical decimal strings", () => {
  expect(encodeMailListRequest({ folder: "inbox", limit: 50 })).toEqual({
    folder: { inbox: null },
    unread_only: false,
    offset: "0",
    limit: "50",
  });
  expect(encodeMailListRequest({
    folder: "sent",
    unreadOnly: true,
    offset: "4",
    limit: 25,
    expectedRevision: "9",
    expectedContactsRevision: "7",
  })).toEqual({
    folder: { sent: null },
    unread_only: true,
    offset: "4",
    limit: "25",
    expected_mail_revision: "9",
    expected_contacts_revision: "7",
  });
  expect(encodeMailRecipientsRequest({ searchText: "Ada", limit: 25 })).toEqual({
    search_text: "Ada",
    offset: "0",
    limit: "25",
  });
});

function bytes(length: number, byte = 0x11): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

function encryptedHeader() {
  return {
    message_id: bytes(16, 0x01),
    delivery_key_epoch: "7",
    delivery_key_fingerprint: bytes(32, 0x02),
    local_wrap_epoch: "7",
    local_wrap_fingerprint: bytes(32, 0x03),
    local_wrapped_cek: bytes(168, 0x04),
    header_nonce: bytes(12, 0x05),
    header_ciphertext_and_tag: bytes(2_064, 0x06),
  };
}

function encryptedContent() {
  return {
    header: encryptedHeader(),
    body_nonce: bytes(12, 0x07),
    body_ciphertext_and_tag: bytes(1_040, 0x08),
  };
}

function inContacts(name = "Remy") {
  return {
    in_contacts: {
      contact_id: "3",
      contact_revision: "6",
      contact_name: name,
    },
  };
}

function inboxListItem(id = "1") {
  return {
    inbox: {
      local_id: id,
      sender: SENDER,
      received_at_ns: "1784040000000000000",
      read: false,
      known_at_receipt: true,
      current_contact: inContacts(),
      retained_bytes: "3500",
      encrypted_header: encryptedHeader(),
    },
  };
}

describe("locked mailbox list/get parsers", () => {
  test("keeps only authenticated outer Inbox metadata from a bounded list", () => {
    const page = parseMailListPage({
      mail_revision: "9",
      contacts_revision: "4",
      cleanup_epoch: "2",
      items: [inboxListItem()],
      total: "1",
      ciphertext_bytes: "2300",
    });
    expect(page).toEqual({
      revision: "9",
      contactsRevision: "4",
      cleanupEpoch: "2",
      items: [{
        kind: "inbox",
        localId: "1",
        sender: SENDER,
        receivedAtNs: "1784040000000000000",
        read: false,
        knownAtReceipt: true,
        currentContact: {
          status: "in_contacts",
          contactId: "3",
          contactRevision: "6",
          contactName: "Remy",
        },
        retainedBytes: "3500",
      }],
      total: "1",
      nextOffset: null,
      ciphertextBytes: "2300",
    });
    expect(page.items[0]).not.toHaveProperty("encrypted_header");
    expect(page.items[0]).not.toHaveProperty("subject");
  });

  test("parses accepted Sent state without retaining encrypted content", () => {
    const page = parseMailListPage({
      mail_revision: "10",
      contacts_revision: "4",
      cleanup_epoch: "2",
      items: [{ sent: {
        local_id: "8",
        recipient: RECIPIENT,
        contact_id: "3",
        contact_revision: "6",
        current_contact: { not_in_contacts: null },
        created_at_ns: "1784040000000000000",
        updated_at_ns: "1784040001000000000",
        cleanup_epoch: "2",
        attempt_no: "1",
        state: { accepted: { received_at_ns: "1784040002000000000" } },
        retained_bytes: "4000",
        encrypted_header: encryptedHeader(),
      } }],
      total: "1",
      ciphertext_bytes: "2300",
    });
    expect(page.items[0]).toMatchObject({
      kind: "sent",
      recipient: RECIPIENT,
      state: { status: "accepted", acceptedAtNs: "1784040002000000000" },
    });
  });

  test("exact get validates canonical ciphertext but projects only outer fields", () => {
    const result = parseMailGetResult({
      mail_revision: "11",
      contacts_revision: "5",
      cleanup_epoch: "2",
      record: { inbox: {
        local_id: "1",
        sender: SENDER,
        received_at_ns: "1784040000000000000",
        read: false,
        known_at_receipt: false,
        current_contact: { contact_conflict: null },
        retained_bytes: "3500",
        encrypted: encryptedContent(),
      } },
    });
    expect(result.record).toMatchObject({
      kind: "inbox",
      localId: "1",
      sender: SENDER,
      read: false,
    });
    expect(result.record).not.toHaveProperty("encrypted");
  });

  test("rejects malformed headers, wrong variants, oversized pages, and backend errors", () => {
    const badHeader = encryptedHeader();
    badHeader.header_nonce = bytes(1, 0);
    const base = {
      mail_revision: "9",
      contacts_revision: "4",
      cleanup_epoch: "2",
      total: "1",
      ciphertext_bytes: "2",
    };
    expect(() => parseMailListPage({
      ...base,
      items: [{ inbox: { ...inboxListItem().inbox, encrypted_header: badHeader } }],
    })).toThrow(MailBackendMailboxError);
    expect(() => parseMailListPage({ ...base, items: [{ other: {} }] })).toThrow(
      MailBackendMailboxError,
    );
    expect(() => parseMailListPage({
      ...base,
      items: Array.from({ length: 51 }, () => inboxListItem()),
    })).toThrow(MailBackendMailboxError);
    expect(() => parseMailListPage({ err: { revision_conflict: {} } })).toThrow(
      MailBackendMailboxError,
    );
  });

  test("strictly closes and bounds the live Contacts projection", () => {
    const base = {
      mail_revision: "9",
      contacts_revision: "4",
      cleanup_epoch: "2",
      total: "1",
      ciphertext_bytes: "2300",
    };
    const withCurrentContact = (current_contact: unknown) => ({
      ...base,
      items: [{ inbox: { ...inboxListItem().inbox, current_contact } }],
    });
    expect(() => parseMailListPage(withCurrentContact({
      in_contacts: {
        contact_id: "3",
        contact_revision: "6",
        contact_name: "Remy",
        hidden: true,
      },
    }))).toThrow(MailBackendMailboxError);
    expect(() => parseMailListPage(withCurrentContact({
      in_contacts: {
        contact_id: "3",
        contact_revision: "6",
        contact_name: "bad\nname",
      },
    }))).toThrow(MailBackendMailboxError);
    expect(() => parseMailListPage(withCurrentContact({
      not_in_contacts: { contact_name: "pretend" },
    }))).toThrow(MailBackendMailboxError);
  });
});

describe("mutation and cleanup parsing", () => {
  test("creates a revision-bound cleanup token from the complete authoritative preview", () => {
    const preview = parseMailCleanupPreview({
      scope: { unknown_current: null },
      mail_revision: "12",
      contacts_revision: "8",
      cleanup_epoch: "3",
      counts: {
        total: "4",
        unread: "1",
        inbox: "4",
        sent: "0",
        outbox: "0",
        active_sends: "0",
        retained_bytes: "8192",
      },
    });
    expect(preview.scope).toBe("unknown_senders");
    expect(preview.previewToken).toBe(
      "unknown_senders:12:8:3:4:1:4:0:0:0:8192",
    );
  });

  test("strictly parses mutation counters", () => {
    expect(parseMailMutationResult({
      mail_revision: "13",
      cleanup_epoch: "3",
      changed: "1",
      inbox_deleted: "1",
      outbox_deleted: "0",
      unread_deleted: "1",
      retained_bytes_deleted: "3500",
      unread_remaining: "2",
    })).toMatchObject({
      revision: "13",
      changed: "1",
      inboxDeleted: "1",
      unreadRemaining: "2",
    });
  });
});

describe("request-bound list page validation", () => {
  test("accepts a byte-shortened page only with its exact advancing cursor", () => {
    const result = parseMailListPage({
      mail_revision: "9",
      contacts_revision: "4",
      cleanup_epoch: "2",
      items: [inboxListItem()],
      total: "4",
      next_offset: "1",
      ciphertext_bytes: "163840",
    });
    expect(() => validateMailListPageForRequest(result, 3, "0")).not.toThrow();
  });

  test("rejects stalled, skipped, duplicate, oversized, and over-limit pages", () => {
    const makePage = (overrides: Record<string, unknown> = {}) => parseMailListPage({
      mail_revision: "9",
      contacts_revision: "4",
      cleanup_epoch: "2",
      items: [inboxListItem()],
      total: "4",
      next_offset: "1",
      ciphertext_bytes: "2300",
      ...overrides,
    });
    expect(() => validateMailListPageForRequest(
      makePage({ next_offset: "0" }),
      3,
      "0",
    )).toThrow(MailBackendMailboxError);
    expect(() => validateMailListPageForRequest(
      makePage({ next_offset: "2" }),
      3,
      "0",
    )).toThrow(MailBackendMailboxError);
    expect(() => validateMailListPageForRequest(
      makePage({ items: [inboxListItem(), inboxListItem()] }),
      3,
      "0",
    )).toThrow(MailBackendMailboxError);
    expect(() => validateMailListPageForRequest(
      makePage({ ciphertext_bytes: "163841" }),
      3,
      "0",
    )).toThrow(MailBackendMailboxError);
    expect(() => validateMailListPageForRequest(
      makePage({ items: [inboxListItem("1"), inboxListItem("2")] }),
      1,
      "0",
    )).toThrow(MailBackendMailboxError);
  });
});

describe("recipient dependency parsing", () => {
  test("strictly projects a bounded canonical Contacts page", () => {
    expect(parseMailRecipientsPage({
      book_revision: "9",
      contacts: [{
        contact_id: "2",
        contact_revision: "4",
        contact_name: "Remy",
        principal: RECIPIENT,
      }],
      total: "1",
    }, 20, "0")).toEqual({
      bookRevision: "9",
      recipients: [{
        contactId: "2",
        contactRevision: "4",
        contactName: "Remy",
        principal: RECIPIENT,
      }],
      total: "1",
      nextOffset: null,
    });
  });

  test("fails closed on dependency errors, controls, duplicates, and inconsistent pages", () => {
    const contact = {
      contact_id: "2",
      contact_revision: "4",
      contact_name: "Remy",
      principal: RECIPIENT,
    };
    const invalid: unknown[] = [
      { err: { invalid_dependency: null } },
      { book_revision: "1", contacts: [{ ...contact, contact_name: "Bad\nName" }], total: "1" },
      { book_revision: "1", contacts: [contact, contact], total: "2" },
      { book_revision: "1", contacts: [contact], total: "2" },
      { book_revision: "1", contacts: [contact], total: "1", next_offset: "1" },
      { book_revision: "1", contacts: [contact], total: "2001" },
      { book_revision: "1", contacts: [{ ...contact, extra: true }], total: "1" },
    ];
    for (const value of invalid) {
      expect(() => parseMailRecipientsPage(value, 20, "0")).toThrow(
        MailBackendMailboxError,
      );
    }
  });
});
