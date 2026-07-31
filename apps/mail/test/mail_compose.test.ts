import { describe, expect, test } from "bun:test";
import {
  MailBackendPrivateError,
  type MailBackendDeliveryView,
  type MailBackendEncryptedSettings,
  type MailBackendPreparedRecipient,
} from "../src/backend.ts";
import {
  MailComposeResidentWorkflow,
  type MailComposeResidentDependencies,
} from "../src/mail_compose.ts";
import type { MailCryptoWorkerResult } from "../src/crypto_worker.ts";
import { MAIL_MAX_ENVELOPE_BYTES } from "../src/protocol.ts";

const SELF = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const RECIPIENT = "un4fu-tqaaa-aaaab-qadjq-cai";

describe("resident encrypted compose workflow", () => {
  test("keeps plaintext at the worker boundary and sends only an exact ciphertext command", async () => {
    const fixture = workflowFixture();
    const result = await fixture.workflow.send({
      kind: "new",
      commandId: "01010101010101010101010101010101",
      recipient: {
        kind: "contact",
        principal: RECIPIENT,
        contactId: "2",
        expectedContactRevision: "4",
      },
      subject: "Secret subject marker",
      bodyMarkdown: "Secret body marker",
    });

    expect(result.status).toBe("accepted");
    expect(fixture.workerEncrypts).toHaveLength(1);
    expect(fixture.workerEncrypts[0]).toMatchObject({
      senderPrincipal: SELF,
      recipientPrincipal: RECIPIENT,
      header: { claimedSenderName: "Encrypted Ada", subject: "Secret subject marker" },
      body: { bodyMarkdown: "Secret body marker" },
    });
    expect(fixture.sent).toHaveLength(1);
    expect(JSON.stringify(fixture.sent[0])).not.toContain("Secret subject marker");
    expect(JSON.stringify(fixture.sent[0])).not.toContain("Secret body marker");
    expect(fixture.prepared[0]?.recipient).toEqual({
      kind: "contact",
      principal: RECIPIENT,
      contactId: "2",
      expectedContactRevision: "4",
    });
  });

  test("replays a lost command exactly, but stale recipient keys get one fresh envelope and command", async () => {
    const replay = workflowFixture();
    let calls = 0;
    replay.dependencies.send = async (request) => {
      replay.sent.push(request);
      calls += 1;
      if (calls === 1) {
        throw new MailBackendPrivateError("BACKEND_UNAVAILABLE", "lost response");
      }
      return delivery("9", "accepted");
    };
    replay.workflow = new MailComposeResidentWorkflow(replay.dependencies);
    await replay.workflow.send(newDraft());
    expect(replay.sent).toHaveLength(2);
    expect(replay.sent[0]).toBe(replay.sent[1]);

    const stale = workflowFixture();
    let attempt = 0;
    stale.dependencies.send = async (request) => {
      stale.sent.push(request);
      attempt += 1;
      return attempt === 1
        ? delivery("10", "not_sent", "stale_key")
        : delivery("11", "accepted");
    };
    stale.workflow = new MailComposeResidentWorkflow(stale.dependencies);
    const replaced = await stale.workflow.send(newDraft());
    expect(replaced).toMatchObject({ localId: "11", staleReplacementFor: "10" });
    expect(stale.prepared).toHaveLength(2);
    expect(stale.workerEncrypts).toHaveLength(2);
    expect(stale.sent).toHaveLength(2);
    expect(stale.sent[0]?.commandId).not.toEqual(stale.sent[1]?.commandId);
    expect(stale.sent[0]?.envelope).not.toEqual(stale.sent[1]?.envelope);
  });

  test("retains one exact encrypted command across repeated lost responses", async () => {
    const fixture = workflowFixture();
    let calls = 0;
    fixture.dependencies.send = async (request) => {
      fixture.sent.push(request);
      calls += 1;
      if (calls <= 2) {
        throw new MailBackendPrivateError("BACKEND_UNAVAILABLE", "lost response");
      }
      return delivery("12", "accepted");
    };
    fixture.workflow = new MailComposeResidentWorkflow(fixture.dependencies);
    const draft = newDraft();

    await expect(fixture.workflow.send(draft)).rejects.toMatchObject({
      code: "delivery_uncertain",
    });
    expect(fixture.workerEncrypts).toHaveLength(1);
    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[0]).toBe(fixture.sent[1]);

    await expect(fixture.workflow.send(draft)).resolves.toMatchObject({
      localId: "12",
      status: "accepted",
    });
    expect(fixture.workerEncrypts).toHaveLength(1);
    expect(fixture.sent).toHaveLength(3);
    expect(fixture.sent[2]).toBe(fixture.sent[0]);
  });

  test("reports a superseded in-flight send without implying that a replacement is safe", async () => {
    const fixture = workflowFixture();
    fixture.dependencies.send = async (request) => {
      fixture.sent.push(request);
      throw new MailBackendPrivateError("ATTEMPT_SUPERSEDED", "raw backend detail");
    };
    fixture.workflow = new MailComposeResidentWorkflow(fixture.dependencies);

    await expect(fixture.workflow.send(newDraft())).rejects.toMatchObject({
      code: "delivery_state_changed",
      message: "Mail could not confirm this send because its Outbox state changed. The recipient may have received it; your draft is unchanged.",
    });
    expect(fixture.sent).toHaveLength(1);

    fixture.dependencies.retry = async () => {
      throw new MailBackendPrivateError("ATTEMPT_SUPERSEDED", "raw backend detail");
    };
    await expect(fixture.workflow.retry("9")).rejects.toMatchObject({
      code: "not_retryable",
      message: "That Outbox item is not retryable now.",
    });
  });

  test("returns an irreversible accepted result even if Mail locks during dispatch", async () => {
    const fixture = workflowFixture();
    let unlocked = true;
    fixture.dependencies.session = {
      status: async () => unlocked ? session() : { ...session(), lockState: "locked", currentUnlocked: false },
    };
    fixture.dependencies.send = async (request) => {
      fixture.sent.push(request);
      unlocked = false;
      return delivery("13", "accepted");
    };
    fixture.workflow = new MailComposeResidentWorkflow(fixture.dependencies);

    await expect(fixture.workflow.send(newDraft())).resolves.toMatchObject({
      localId: "13",
      status: "accepted",
    });
  });

  test("replays a completed caller command and rejects command reuse with changed content", async () => {
    const fixture = workflowFixture();
    const draft = newDraft();
    const first = await fixture.workflow.send(draft);
    const replayed = await fixture.workflow.send(draft);
    expect(replayed).toEqual(first);
    expect(replayed).not.toBe(first);
    expect(fixture.workerEncrypts).toHaveLength(1);
    expect(fixture.sent).toHaveLength(1);

    await expect(fixture.workflow.send({ ...draft, bodyMarkdown: "Changed" })).rejects.toMatchObject({
      code: "invalid_draft",
    });
    expect(fixture.workerEncrypts).toHaveLength(1);
    expect(fixture.sent).toHaveLength(1);
  });

  test("reply derives the exact authenticated Inbox counterparty and message id", async () => {
    const fixture = workflowFixture();
    fixture.dependencies.getRecord = async () => ({
      revision: "3",
      contactsRevision: "4",
      cleanupEpoch: "0",
      record: inboxRecord(),
    });
    fixture.workflow = new MailComposeResidentWorkflow(fixture.dependencies);

    await fixture.workflow.send({
      kind: "reply",
      commandId: "02020202020202020202020202020202",
      replyTo: { folder: "inbox", localId: "7" },
      subject: "Re: exact",
      bodyMarkdown: "No quote",
    });
    expect(fixture.prepared[0]?.recipient).toEqual({
      kind: "contact",
      principal: RECIPIENT,
      contactId: "2",
      expectedContactRevision: "4",
    });
    expect(fixture.workerEncrypts[0]?.header.inReplyTo).toEqual(bytes(16, 0x21));
    expect(fixture.workerEncrypts[0]?.body.bodyMarkdown).toBe("No quote");
  });

  test("coalesces repeated retry clicks and persists only encrypted sender settings", async () => {
    const fixture = workflowFixture();
    let resolveRetry!: (value: MailBackendDeliveryView) => void;
    const pending = new Promise<MailBackendDeliveryView>((resolve) => {
      resolveRetry = resolve;
    });
    let retryCalls = 0;
    fixture.dependencies.retry = async () => {
      retryCalls += 1;
      return pending;
    };
    fixture.dependencies.getSettings = async () => null;
    fixture.dependencies.setSettings = async (mutation) => {
      expect(mutation.kind).toBe("create");
      if (mutation.kind !== "create") throw new Error("wrong mutation");
      expect(JSON.stringify(mutation.settings)).not.toContain("New private name");
      return mutation.settings;
    };
    fixture.workflow = new MailComposeResidentWorkflow(fixture.dependencies);

    const first = fixture.workflow.retry("8");
    const second = fixture.workflow.retry("8");
    expect(first).toBe(second);
    expect(retryCalls).toBe(1);
    resolveRetry(delivery("8", "accepted"));
    await expect(first).resolves.toMatchObject({ localId: "8", status: "accepted" });

    await expect(fixture.workflow.setSenderName("New private name")).resolves.toEqual({
      configured: true,
      senderName: "New private name",
      revision: "1",
    });
  });
});

function workflowFixture() {
  let random = 1;
  let envelope = 1;
  const workerEncrypts: Array<Extract<Parameters<MailComposeResidentDependencies["worker"]["encrypt"]>[0], object>> = [];
  const prepared: Parameters<MailComposeResidentDependencies["prepareRecipient"]>[0][] = [];
  const sent: Parameters<MailComposeResidentDependencies["send"]>[0][] = [];
  const dependencies: MailComposeResidentDependencies = {
    session: { status: async () => session() },
    worker: {
      encrypt: async (request) => {
        workerEncrypts.push(request);
        return {
          type: "encrypted",
          messageId: bytes(16, envelope),
          envelope: bytes(2_000, envelope++),
          senderLocalWrap: {
            epoch: "7",
            fingerprint: bytes(32, 0x41),
            wrappedCek: bytes(168, 0x42),
          },
        };
      },
      decryptHeader: async (request) => ({
        type: "header_decrypted",
        messageId: request.encryptedHeader.messageId.slice(),
        header: {
          contentSchema: 1,
          claimedSenderName: "Original",
          subject: "Exact",
          senderCreatedAtNs: "1",
          inReplyTo: null,
        },
      }),
      encryptSettings: async (request) => ({
        type: "settings_encrypted",
        encrypted: {
          recordId: request.recordId.slice(),
          revision: request.revision,
          localWrap: {
            epoch: "7",
            fingerprint: bytes(32, 0x61),
            wrappedCek: bytes(168, 0x62),
          },
          nonce: bytes(12, 0x63),
          ciphertextAndTag: bytes(32, 0x64),
        },
      }),
      decryptSettings: async () => ({
        type: "settings_decrypted",
        senderName: "Encrypted Ada",
      }),
    },
    prepareRecipient: async (request) => {
      prepared.push(request);
      return preparedRecipient(request.recipient.principal, random++);
    },
    send: async (request) => {
      sent.push(request);
      return delivery("9", "accepted");
    },
    retry: async (request) => delivery(request.localId, "accepted"),
    getRecord: async () => { throw new Error("not used"); },
    getSettings: async () => encryptedSettings(),
    setSettings: async (mutation) => mutation.kind === "rewrap"
      ? encryptedSettings(mutation.expectedRevision)
      : mutation.settings,
    selfPrincipal: async () => SELF,
    nowNs: () => "1784040000000000000",
    randomBytes: (length) => bytes(length, random++),
  };
  return {
    dependencies,
    workflow: new MailComposeResidentWorkflow(dependencies),
    workerEncrypts,
    prepared,
    sent,
  };
}

function newDraft() {
  return {
    kind: "new" as const,
    commandId: "03030303030303030303030303030303",
    recipient: { kind: "direct" as const, principal: RECIPIENT },
    subject: "Fresh",
    bodyMarkdown: "Body",
  };
}

function preparedRecipient(recipient: string, seed: number): MailBackendPreparedRecipient {
  return {
    permitId: bytes(32, seed),
    recipient,
    contactId: null,
    contactRevision: null,
    bookRevision: "0",
    expiresAtNs: "1784040300000000000",
    publicInfoHash: bytes(32, seed + 1),
    keyInfo: {
      protocolVersion: 1,
      suite: 1,
      deliveryKeyEpoch: "5",
      contextPublicKey: bytes(96, 0x31),
      effectiveIbeIdentity: bytes(32, 0x32),
      recipientKeyFingerprint: bytes(32, 0x33),
      maxEnvelopeBytes: MAIL_MAX_ENVELOPE_BYTES,
    },
  };
}

function encryptedSettings(revision = "2"): MailBackendEncryptedSettings {
  return {
    recordId: bytes(16, 0x51),
    revision,
    localWrapEpoch: "7",
    localWrapFingerprint: bytes(32, 0x52),
    localWrappedCek: bytes(168, 0x53),
    nonce: bytes(12, 0x54),
    ciphertextAndTag: bytes(32, 0x55),
  };
}

function delivery(
  localId: string,
  status: "accepted" | "not_sent",
  reason?: "stale_key",
): MailBackendDeliveryView {
  return {
    localId,
    revision: "4",
    cleanupEpoch: "0",
    attemptNo: "1",
    state: status === "accepted"
      ? { status, acceptedAtNs: "5" }
      : { status, notSentReason: reason ?? "invalid" },
    updatedAtNs: "5",
  };
}

function session() {
  return {
    version: 1 as const,
    lockState: "unlocked" as const,
    currentEpoch: "7",
    previousEpoch: null,
    currentUnlocked: true,
    previousUnlocked: false,
    inactivityExpiresAt: "9999999999999",
  };
}

function inboxRecord() {
  return {
    kind: "inbox" as const,
    localId: "7",
    sender: RECIPIENT,
    receivedAtNs: "5",
    read: false,
    knownAtReceipt: true,
    currentContact: {
      status: "in_contacts" as const,
      contactId: "2",
      contactRevision: "4",
      contactName: "Remy",
    },
    retainedBytes: "3500",
    encrypted: {
      header: {
        messageId: bytes(16, 0x21),
        deliveryKeyEpoch: "7",
        deliveryKeyFingerprint: bytes(32, 0x22),
        localWrapEpoch: "7",
        localWrapFingerprint: bytes(32, 0x23),
        localWrappedCek: bytes(168, 0x24),
        headerNonce: bytes(12, 0x25),
        headerCiphertextAndTag: bytes(2_064, 0x26),
      },
      bodyNonce: bytes(12, 0x27),
      bodyCiphertextAndTag: bytes(1_040, 0x28),
    },
  };
}

function bytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value & 0xff);
}
