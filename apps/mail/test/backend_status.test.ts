import { describe, expect, test } from "bun:test";
import {
  MailBackendStatusError,
  parseMailBackendPulse,
  parseMailBackendStatus,
  type MailBackendStatus,
} from "../src/backend.ts";
import {
  MAIL_STATUS_OUTPUT_FIELDS,
  MAIL_STATUS_OUTPUT_SCHEMA,
  projectMailStatusTool,
} from "../src/status_tool.ts";

function wireStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mail_revision: "12",
    contacts_revision: "7",
    cleanup_epoch: "3",
    setup: { not_configured: null },
    inbox_count: "8",
    inbox_bytes: "1024",
    unknown_at_receipt_count: "2",
    unknown_at_receipt_bytes: "256",
    unread_count: "4",
    sent_count: "5",
    outbox_count: "1",
    active_sends: "1",
    sent_and_outbox_bytes: "2048",
    storage_level: { normal: null },
    ...overrides,
  };
}

function wirePulse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mail_revision: "12",
    contacts_revision: "7",
    cleanup_epoch: "3",
    inbox_count: "8",
    unread_count: "4",
    ...overrides,
  };
}

describe("Mail pulse decoding", () => {
  test("strictly decodes the current bare constant-size pulse", () => {
    expect(parseMailBackendPulse(wirePulse())).toEqual({
      revision: "12",
      contactsRevision: "7",
      cleanupEpoch: "3",
      inboxCount: "8",
      unread: "4",
    });
  });

  test("rejects partial, expanded, noncanonical, and failed pulses", () => {
    const missing = wirePulse();
    delete missing.cleanup_epoch;
    for (const value of [
      missing,
      { ...wirePulse(), inbox_count: "08" },
      { ...wirePulse(), sent_count: "1" },
      { ok: wirePulse(), err: { corrupt_state: null } },
      { err: { corrupt_state: null } },
    ]) {
      expect(() => parseMailBackendPulse(value)).toThrow(MailBackendStatusError);
    }
  });
});

describe("Store.Status decoding", () => {
  test("decodes the bare status projected by the Kernel self-call boundary", () => {
    expect(parseMailBackendStatus(wireStatus())).toEqual({
      revision: "12",
      contactsRevision: "7",
      cleanupEpoch: "3",
      privateMailActive: false,
      keyHolder: null,
      currentEpoch: null,
      previousEpoch: null,
      encryptedSettingsRevision: null,
      unread: "4",
      inboxCount: "8",
      inboxBytes: "1024",
      unknownInboxCount: "2",
      unknownInboxBytes: "256",
      sentCount: "5",
      outboxCount: "1",
      activeSends: "1",
      sentAndOutboxBytes: "2048",
      storageLevel: "normal",
    });
  });

  test("decodes configured key metadata in the current bare status", () => {
    const status = parseMailBackendStatus(wireStatus({
      setup: {
        configured: {
          key_holder: "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe",
          current_epoch: 9,
          previous_epoch: 8n,
        },
      },
      encrypted_settings_revision: 6,
      storage_level: { approaching_limit: null },
    }));
    expect(status).toMatchObject({
      privateMailActive: true,
      currentEpoch: "9",
      previousEpoch: "8",
      encryptedSettingsRevision: "6",
      storageLevel: "approaching_limit",
    });
    expect(status.keyHolder).toStartWith("pcofx-");
  });

  test("rejects an obsolete raw backend Result instead of treating it as state", () => {
    let caught: unknown;
    try {
      parseMailBackendStatus({ err: { corrupt_state: null } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MailBackendStatusError);
    expect(caught).toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Invalid Mail status",
    });
    expect(String(caught)).not.toContain("corrupt_state");
  });

  test("rejects legacy, partial, ambiguous, and noncanonical status values", () => {
    const missingRevision = wireStatus();
    delete missingRevision.mail_revision;
    const cases: unknown[] = [
      missingRevision,
      { ...wireStatus(), unread_count: "01" },
      { ...wireStatus(), outbox_bytes: "2" },
      { ...wireStatus(), storage_level: "normal" },
      { ...wireStatus(), storage_level: { normal: "not null" } },
      { ...wireStatus(), setup: { not_configured: null, configured: {} } },
      { ...wireStatus(), setup: { configured: { current_epoch: "1" } } },
      { ...wireStatus(), setup: { configured: { key_holder: " ", current_epoch: "1" } } },
      { ok: wireStatus(), err: { invalid_request: null } },
      {
        revision: "12",
        cleanup_epoch: "3",
        private_mail_active: false,
        unread: "0",
      },
    ];
    for (const value of cases) {
      expect(() => parseMailBackendStatus(value)).toThrow(MailBackendStatusError);
    }
  });
});

describe("mail_status agent projection", () => {
  const decoded: MailBackendStatus = parseMailBackendStatus(wireStatus({
    setup: {
      configured: {
        key_holder: "aaaaa-aa",
        current_epoch: "2",
      },
    },
    storage_level: { almost_full: null },
  }));

  test("projects configured status as preparing without dropping current Store fields", () => {
    const projected = projectMailStatusTool(decoded);
    expect(projected.privateMailState).toBe("preparing");
    expect(projected).toMatchObject({
      sentCount: "5",
      activeSends: "1",
      sentAndOutboxBytes: "2048",
      storageLevel: "almost_full",
    });
    expect(projected).not.toHaveProperty("outboxBytes");
  });

  test("accepts only an active resident's ready projection", () => {
    expect(projectMailStatusTool(decoded, "ready").privateMailState).toBe("ready");
    expect(projectMailStatusTool(
      parseMailBackendStatus(wireStatus()),
      "ready",
    ).privateMailState).toBe("not_configured");
    expect(projectMailStatusTool(decoded, "unavailable").privateMailState)
      .toBe("unavailable");
  });

  test("schema and projection share one exact field list", () => {
    const required = MAIL_STATUS_OUTPUT_SCHEMA.required as string[];
    const properties = MAIL_STATUS_OUTPUT_SCHEMA.properties as Record<string, unknown>;
    expect(required).toEqual([...MAIL_STATUS_OUTPUT_FIELDS]);
    expect(Object.keys(properties).sort()).toEqual([...MAIL_STATUS_OUTPUT_FIELDS].sort());
    expect(Object.keys(projectMailStatusTool(decoded)).sort()).toEqual(
      [...MAIL_STATUS_OUTPUT_FIELDS].sort(),
    );
    expect(MAIL_STATUS_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  });
});
