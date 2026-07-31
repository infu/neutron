import { describe, expect, test } from "bun:test";
import type {
  MailBackendEncryptedInboxItem,
  MailBackendEncryptedInboxRecord,
  MailBackendEncryptedListItem,
  MailBackendEncryptedListPage,
  MailBackendEncryptedOutboxItem,
  MailBackendEncryptedOutboxRecord,
} from "../src/backend.ts";
import { MailCryptoWorkerClientError } from "../src/crypto_worker_client.ts";
import type { MailCryptoWorkerResult } from "../src/crypto_worker.ts";
import {
  MAIL_PRIVATE_HEADER_CONCURRENCY,
  MailPrivateError,
  MailPrivateResidentProjection,
} from "../src/mail_private.ts";
import type { MailCryptoSessionSnapshot } from "../src/mail_crypto_session.ts";

const SELF = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const SENDER = "un4fu-tqaaa-aaaab-qadjq-cai";

describe("resident decrypted Mail projections", () => {
  test("decrypts bounded headers, isolates one corrupt record, and searches only the volatile index", async () => {
    const items = Array.from({ length: 9 }, (_, index) => inboxItem(String(index + 1)));
    const worker = new FakeWorker("3");
    const resident = projection({ worker, page: listPage(items) });

    const page = await resident.list({ folder: "inbox", offset: "0", limit: 50 });
    expect(page.items).toHaveLength(9);
    expect(page.items[2]?.decryption).toEqual({ state: "corrupt" });
    expect(page.items[1]?.decryption).toMatchObject({
      state: "ready",
      header: { subject: "Subject 2" },
    });
    expect(worker.fullDecrypts).toBe(0);
    expect(worker.maxActive).toBeLessThanOrEqual(MAIL_PRIVATE_HEADER_CONCURRENCY);
    expect(worker.headerDecrypts).toBe(9);

    await resident.list({ folder: "inbox", offset: "0", limit: 50 });
    expect(worker.headerDecrypts).toBe(9);

    const search = await resident.search("inbox", "subject 2", 10);
    expect(search.items.map((item) => item.localId)).toEqual(["2"]);
    resident.clear();
    expect((await resident.search("inbox", "subject", 10)).items).toEqual([]);
  });

  test("replaces a folder page while retaining only the current exact message", async () => {
    const worker = new FakeWorker(null);
    const resident = new MailPrivateResidentProjection({
      session: stableSession(),
      worker,
      list: async (request) => request.folder === "sent"
        ? listPage([outgoingItem("sent", "accepted", "8")])
        : request.offset === "2"
          ? {
              ...listPage([inboxItem("3"), inboxItem("4")]),
              total: "4",
              nextOffset: null,
            }
          : {
              ...listPage([inboxItem("1"), inboxItem("2")]),
              total: "4",
              nextOffset: "2",
            },
      get: async () => ({
        revision: "1",
        contactsRevision: "1",
        cleanupEpoch: "0",
        record: inboxRecord("1"),
      }),
      selfPrincipal: async () => SELF,
    });

    await resident.list({ folder: "inbox", offset: "0", limit: 50 });
    await resident.get("inbox", "1");
    await resident.list({ folder: "inbox", offset: "2", limit: 50 });

    expect((await resident.search("inbox", "subject 2", 50)).items).toEqual([]);
    expect((await resident.search("inbox", "opened 1", 50)).items.map((row) => row.localId))
      .toEqual(["1"]);
    expect((await resident.search("inbox", "subject 3", 50)).items.map((row) => row.localId))
      .toEqual(["3"]);

    await resident.list({ folder: "sent", offset: "0", limit: 50 });
    expect((await resident.search("inbox", "subject 3", 50)).items).toEqual([]);
    expect((await resident.search("inbox", "opened 1", 50)).items.map((row) => row.localId))
      .toEqual(["1"]);
    expect((await resident.search("sent", "subject 8", 50)).items.map((row) => row.localId))
      .toEqual(["8"]);
    expect(worker.headerDecrypts).toBe(5);
    expect(worker.fullDecrypts).toBe(1);
  });

  test("fetches and decrypts a body only for an exact open request", async () => {
    const worker = new FakeWorker(null);
    let getCalls = 0;
    const record = inboxRecord("7");
    const resident = new MailPrivateResidentProjection({
      session: stableSession(),
      worker,
      list: async () => listPage([inboxItem("7")]),
      get: async (folder, localId) => {
        getCalls += 1;
        expect({ folder, localId }).toEqual({ folder: "inbox", localId: "7" });
        return {
          revision: "1",
          contactsRevision: "1",
          cleanupEpoch: "0",
          record,
        };
      },
      selfPrincipal: async () => SELF,
    });

    await resident.list({ folder: "inbox", limit: 50 });
    expect(getCalls).toBe(0);
    expect(worker.fullDecrypts).toBe(0);
    const opened = await resident.get("inbox", "7");
    expect(getCalls).toBe(1);
    expect(worker.fullDecrypts).toBe(1);
    expect(opened).toMatchObject({
      localId: "7",
      decryption: { state: "ready", header: { subject: "Opened 7" } },
      bodyMarkdown: "**Exact body 7**",
    });
  });

  test("projects Sent and Outbox with the local sender AAD direction", async () => {
    const worker = new FakeWorker(null);
    const pages = {
      sent: listPage([outgoingItem("sent", "accepted", "11")]),
      outbox: listPage([outgoingItem("outbox", "delivery_uncertain", "12")]),
    };
    const resident = new MailPrivateResidentProjection({
      session: stableSession(),
      worker,
      list: async (request) => pages[request.folder as "sent" | "outbox"],
      get: async () => { throw new Error("not expected"); },
      selfPrincipal: async () => SELF,
    });

    const sent = await resident.list({ folder: "sent", limit: 50 });
    const outbox = await resident.list({ folder: "outbox", limit: 50 });
    expect(sent.items[0]).toMatchObject({
      folder: "sent",
      peerPrincipal: SENDER,
      read: true,
      deliveryStatus: "accepted",
    });
    expect(outbox.items[0]).toMatchObject({
      folder: "outbox",
      deliveryStatus: "delivery_uncertain",
    });
    expect(worker.principals).toEqual([
      { senderPrincipal: SELF, recipientPrincipal: SENDER },
      { senderPrincipal: SELF, recipientPrincipal: SENDER },
    ]);
  });

  test("shows reply context only for a loaded authenticated message from the same peer", async () => {
    const other = "aaaaa-aa";
    const worker = new FakeWorker(null, { "2": 1, "3": 1, "4": 9, "5": 5 });
    const crossPeer = { ...inboxItem("3"), sender: other };
    const resident = projection({
      worker,
      page: listPage([
        inboxItem("1"), inboxItem("2"), crossPeer, inboxItem("4"), inboxItem("5"),
      ]),
    });

    const page = await resident.list({ folder: "inbox", offset: "0", limit: 50 });
    expect(page.items.find((row) => row.localId === "2")?.replyContextLabel)
      .toBe("Reply to an earlier message");
    expect(page.items.find((row) => row.localId === "3")?.replyContextLabel).toBeNull();
    expect(page.items.find((row) => row.localId === "4")?.replyContextLabel).toBeNull();
    expect(page.items.find((row) => row.localId === "5")?.replyContextLabel).toBeNull();
  });

  test("accepts an exact Sent target but never an exact Outbox target", async () => {
    const worker = new FakeWorker(null, { "7": 6, "9": 8 });
    let inboxRows = [inboxItem("9")];
    const resident = new MailPrivateResidentProjection({
      session: stableSession(),
      worker,
      list: async () => listPage(inboxRows),
      get: async (folder, localId) => ({
        revision: "1",
        contactsRevision: "1",
        cleanupEpoch: "0",
        record: outgoingRecord(
          folder as "sent" | "outbox",
          folder === "sent" ? "accepted" : "delivery_uncertain",
          localId,
        ),
      }),
      selfPrincipal: async () => SELF,
    });

    await resident.get("sent", "8");
    const sentTarget = await resident.list({ folder: "inbox", limit: 50 });
    expect(sentTarget.items[0]?.replyContextLabel)
      .toBe("Reply to an earlier message");

    await resident.get("outbox", "6");
    inboxRows = [inboxItem("7")];
    const outboxTarget = await resident.list({ folder: "inbox", limit: 50 });
    expect(outboxTarget.items[0]?.replyContextLabel).toBeNull();
  });

  test("does not resolve against a Sent row cached under an older global revision", async () => {
    const worker = new FakeWorker(null, { "2": 1 });
    let revision = "1";
    const resident = new MailPrivateResidentProjection({
      session: stableSession(),
      worker,
      list: async (request) => ({
        ...listPage(
          request.folder === "sent"
            ? [outgoingItem("sent", "accepted", "1")]
            : [inboxItem("2")],
        ),
        revision,
      }),
      get: async () => { throw new Error("not expected"); },
      selfPrincipal: async () => SELF,
    });
    await resident.list({ folder: "sent", limit: 50 });
    revision = "2";
    const inbox = await resident.list({ folder: "inbox", limit: 50 });
    expect(inbox.items[0]?.replyContextLabel).toBeNull();
  });

  test("resolves a sent reply after its exact Inbox target is revalidated under the new revision", async () => {
    const worker = new FakeWorker(null, { "2": 1 });
    let revision = "1";
    const resident = new MailPrivateResidentProjection({
      session: stableSession(),
      worker,
      list: async (request) => ({
        ...listPage(
          request.folder === "inbox"
            ? [inboxItem("1")]
            : [outgoingItem("sent", "accepted", "2")],
        ),
        revision,
      }),
      get: async () => ({
        revision,
        contactsRevision: "1",
        cleanupEpoch: "0",
        record: inboxRecord("1"),
      }),
      selfPrincipal: async () => SELF,
    });
    await resident.list({ folder: "inbox", limit: 50 });
    revision = "2";
    const sent = await resident.list({ folder: "sent", limit: 50 });
    expect(sent.items[0]?.replyContextLabel).toBeNull();
    await resident.get("inbox", "1");
    expect((await resident.search("sent", "subject", 50)).items[0]?.replyContextLabel)
      .toBe("Reply to an earlier message");
  });

  test("a superseded valid get returns without rolling back a newer list revision", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const decryptStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = new FakeWorker(null, {}, barrier, started);
    const resident = new MailPrivateResidentProjection({
      session: stableSession(),
      worker,
      list: async () => ({ ...listPage([inboxItem("2")]), revision: "2" }),
      get: async () => ({
        revision: "1",
        contactsRevision: "1",
        cleanupEpoch: "0",
        record: inboxRecord("1"),
      }),
      selfPrincipal: async () => SELF,
    });

    const stale = resident.get("inbox", "1");
    await decryptStarted;
    expect((await resident.list({ folder: "inbox", limit: 50 })).items[0]?.localId)
      .toBe("2");
    release();
    await expect(stale).resolves.toMatchObject({
      localId: "1",
      bodyMarkdown: "**Exact body 1**",
    });
    expect((await resident.search("inbox", "subject", 50)).items.map((row) => row.localId))
      .toEqual(["2"]);
  });

  test("overlapping valid lists do not turn a superseded refresh into an outage", async () => {
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    let listCalls = 0;
    const resident = new MailPrivateResidentProjection({
      session: stableSession(),
      worker: new FakeWorker(null),
      list: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          signalFirst();
          await firstBarrier;
          return { ...listPage([inboxItem("1")]), revision: "1" };
        }
        return { ...listPage([inboxItem("2")]), revision: "2" };
      },
      get: async () => { throw new Error("not expected"); },
      selfPrincipal: async () => SELF,
    });

    const superseded = resident.list({ folder: "inbox", limit: 50 });
    await firstStarted;
    await expect(resident.list({ folder: "inbox", limit: 50 })).resolves.toMatchObject({
      revision: "2",
      items: [{ localId: "2" }],
    });
    releaseFirst();
    await expect(superseded).resolves.toMatchObject({
      revision: "1",
      items: [{ localId: "1" }],
    });
    expect((await resident.search("inbox", "subject", 50)).items.map((row) => row.localId))
      .toEqual(["2"]);
  });

  test("explicit clear still fails closed for an in-flight decrypted body", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const decryptStarted = new Promise<void>((resolve) => { started = resolve; });
    const resident = new MailPrivateResidentProjection({
      session: stableSession(),
      worker: new FakeWorker(null, {}, barrier, started),
      list: async () => listPage([inboxItem("1")]),
      get: async () => ({
        revision: "1",
        contactsRevision: "1",
        cleanupEpoch: "0",
        record: inboxRecord("1"),
      }),
      selfPrincipal: async () => SELF,
    });

    const inFlight = resident.get("inbox", "1");
    await decryptStarted;
    resident.clear();
    release();
    await expect(inFlight).rejects.toMatchObject({
      code: "temporarily_unavailable",
    } satisfies Partial<MailPrivateError>);
    expect((await resident.search("inbox", "subject", 50)).items).toEqual([]);
  });

  test("a key binding change still fails closed after decryption", async () => {
    const states = [
      unlockedSession(),
      { ...unlockedSession(), currentEpoch: "8" },
    ];
    const resident = new MailPrivateResidentProjection({
      session: { status: async () => states.shift() ?? states[1]! },
      worker: new FakeWorker(null),
      list: async () => listPage([inboxItem("1")]),
      get: async () => ({
        revision: "1",
        contactsRevision: "1",
        cleanupEpoch: "0",
        record: inboxRecord("1"),
      }),
      selfPrincipal: async () => SELF,
    });

    await expect(resident.get("inbox", "1")).rejects.toMatchObject({
      code: "capability_changed",
    } satisfies Partial<MailPrivateError>);
  });

  test("drops every projection when the resident locks during a batch", async () => {
    const states = [unlockedSession(), lockedSession()];
    const resident = projection({
      worker: new FakeWorker(null),
      page: listPage([inboxItem("1")]),
      session: { status: async () => states.shift() ?? lockedSession() },
    });

    await expect(
      resident.list({ folder: "inbox", limit: 50 }),
    ).rejects.toMatchObject({ code: "mail_locked" } satisfies Partial<MailPrivateError>);
    await expect(resident.search("inbox", "subject", 10)).rejects.toMatchObject({
      code: "mail_locked",
    });
  });
});

class FakeWorker {
  active = 0;
  maxActive = 0;
  headerDecrypts = 0;
  fullDecrypts = 0;
  principals: Array<{ senderPrincipal: string; recipientPrincipal: string }> = [];

  constructor(
    private readonly corruptLocalId: string | null,
    private readonly replies: Readonly<Record<string, number>> = {},
    private readonly fullDecryptBarrier: Promise<void> | null = null,
    private readonly onFullDecryptStart: () => void = () => undefined,
  ) {}

  async decryptHeader(input: {
    encryptedHeader: { messageId: Uint8Array };
    senderPrincipal: string;
    recipientPrincipal: string;
  }): Promise<MailCryptoWorkerResult> {
    this.headerDecrypts += 1;
    this.principals.push({
      senderPrincipal: input.senderPrincipal,
      recipientPrincipal: input.recipientPrincipal,
    });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    const id = String(input.encryptedHeader.messageId[0]);
    if (id === this.corruptLocalId) {
      throw new MailCryptoWorkerClientError("authentication_failed");
    }
    return {
      type: "header_decrypted",
      messageId: input.encryptedHeader.messageId.slice(),
      header: {
        contentSchema: 1,
        claimedSenderName: `Sender ${id}`,
        subject: `Subject ${id}`,
        senderCreatedAtNs: id,
        inReplyTo: this.replies[id] === undefined
          ? null
          : encryptedHeader(this.replies[id]!).messageId,
      },
    };
  }

  async decrypt(input: { envelope: Uint8Array }): Promise<MailCryptoWorkerResult> {
    this.fullDecrypts += 1;
    this.onFullDecryptStart();
    if (this.fullDecryptBarrier) await this.fullDecryptBarrier;
    // The message id starts at byte 43 in the frozen envelope.
    const id = String(input.envelope[43]);
    return {
      type: "decrypted",
      messageId: input.envelope.slice(43, 59),
      header: {
        contentSchema: 1,
        claimedSenderName: `Sender ${id}`,
        subject: `Opened ${id}`,
        senderCreatedAtNs: id,
        inReplyTo: null,
      },
      body: { contentSchema: 1, bodyMarkdown: `**Exact body ${id}**` },
    };
  }
}

function projection(input: {
  worker: FakeWorker;
  page: MailBackendEncryptedListPage;
  session?: { status(): Promise<MailCryptoSessionSnapshot> };
}) {
  return new MailPrivateResidentProjection({
    session: input.session ?? stableSession(),
    worker: input.worker,
    list: async () => input.page,
    get: async () => {
      throw new Error("body fetch was not expected");
    },
    selfPrincipal: async () => SELF,
  });
}

function stableSession() {
  return { status: async () => unlockedSession() };
}

function unlockedSession(): MailCryptoSessionSnapshot {
  return {
    version: 1,
    lockState: "unlocked",
    currentEpoch: "7",
    previousEpoch: null,
    currentUnlocked: true,
    previousUnlocked: false,
    inactivityExpiresAt: "9999999999999",
  };
}

function lockedSession(): MailCryptoSessionSnapshot {
  return {
    version: 1,
    lockState: "locked",
    currentEpoch: "7",
    previousEpoch: null,
    currentUnlocked: false,
    previousUnlocked: false,
    inactivityExpiresAt: null,
  };
}

function listPage(items: MailBackendEncryptedListItem[]): MailBackendEncryptedListPage {
  return {
    revision: "1",
    contactsRevision: "1",
    cleanupEpoch: "0",
    items,
    total: String(items.length),
    nextOffset: null,
    ciphertextBytes: String(items.length * 2_064),
  };
}

function outgoingItem(
  kind: "sent" | "outbox",
  status: "accepted" | "delivery_uncertain",
  localId: string,
): MailBackendEncryptedOutboxItem {
  return {
    kind,
    localId,
    recipient: SENDER,
    contactId: null,
    contactRevision: null,
    currentContact: { status: "not_in_contacts" },
    createdAtNs: localId,
    updatedAtNs: localId,
    cleanupEpoch: "0",
    attemptNo: "1",
    state: { status },
    retainedBytes: "4096",
    encryptedHeader: encryptedHeader(Number(localId)),
  };
}

function inboxItem(localId: string): MailBackendEncryptedInboxItem {
  return {
    kind: "inbox",
    localId,
    sender: SENDER,
    receivedAtNs: localId,
    read: false,
    knownAtReceipt: false,
    currentContact: { status: "not_in_contacts" },
    retainedBytes: "4096",
    encryptedHeader: encryptedHeader(Number(localId)),
  };
}

function inboxRecord(localId: string): MailBackendEncryptedInboxRecord {
  const header = encryptedHeader(Number(localId));
  const { encryptedHeader: _encryptedHeader, ...outer } = inboxItem(localId);
  return {
    ...outer,
    encrypted: {
      header,
      bodyNonce: bytes(12, 0xb0),
      bodyCiphertextAndTag: bytes(1_040, 0xc0),
    },
  };
}

function outgoingRecord(
  kind: "sent" | "outbox",
  status: "accepted" | "delivery_uncertain",
  localId: string,
): MailBackendEncryptedOutboxRecord {
  const header = encryptedHeader(Number(localId));
  const { encryptedHeader: _encryptedHeader, ...outer } = outgoingItem(kind, status, localId);
  return {
    ...outer,
    commandId: bytes(16, 0xd0),
    attemptRequestId: null,
    encrypted: {
      header,
      bodyNonce: bytes(12, 0xb0),
      bodyCiphertextAndTag: bytes(1_040, 0xc0),
    },
  };
}

function encryptedHeader(id: number) {
  const messageId = bytes(16, id);
  messageId[0] = id;
  return {
    messageId,
    deliveryKeyEpoch: "7",
    deliveryKeyFingerprint: bytes(32, 0x20),
    localWrapEpoch: "7",
    localWrapFingerprint: bytes(32, 0x20),
    localWrappedCek: bytes(168, 0x40),
    headerNonce: bytes(12, 0x80),
    headerCiphertextAndTag: bytes(2_064, 0xa0),
  };
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed + index * 13) & 0xff);
}
