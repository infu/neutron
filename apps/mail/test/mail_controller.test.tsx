import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MailTrayView,
  countInboxStatusArrivals,
  loadPrivateRowsWithRecovery,
} from "../src/mail_app.tsx";
import {
  INITIAL_MAIL_SNAPSHOT_STATE,
  formatMailTimestamp,
  loadAuthoritativeMailSnapshot,
  loadRevisionBoundMailPage,
  lockedMessageDetail,
  lockedMessageSummary,
  mailLockState,
  mailPulseBindingIsCurrent,
  mailPulseFromStatus,
  mailSnapshotBindingIsCurrent,
  parseMailTileView,
  probeMailPulseBinding,
  reduceMailSnapshot,
  reprojectSelectedMessageOuter,
  shouldMarkReadAfterDisplay,
  type MailSnapshot,
} from "../src/mail_controller.ts";
import type {
  MailBackendCurrentContact,
  MailBackendInboxItem,
  MailBackendListPage,
  MailBackendStatus,
} from "../src/backend.ts";
import type { MailPrivateRow } from "../src/mail_private.ts";

const SENDER = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";

function status(revision = "4"): MailBackendStatus {
  return {
    revision,
    contactsRevision: "2",
    cleanupEpoch: "1",
    privateMailActive: true,
    keyHolder: SENDER,
    currentEpoch: "7",
    previousEpoch: null,
    encryptedSettingsRevision: null,
    unread: "3",
    inboxCount: "6",
    inboxBytes: "12000",
    unknownInboxCount: "1",
    unknownInboxBytes: "2000",
    sentCount: "0",
    outboxCount: "0",
    activeSends: "0",
    sentAndOutboxBytes: "0",
    storageLevel: "normal",
  };
}

function inbox(
  localId: string,
  knownAtReceipt = true,
  currentContact: MailBackendCurrentContact = { status: "not_in_contacts" },
): MailBackendInboxItem {
  return {
    kind: "inbox",
    localId,
    sender: SENDER,
    receivedAtNs: "1784040000000000000",
    read: localId === "2",
    knownAtReceipt,
    currentContact,
    retainedBytes: "2000",
  };
}

function page(revision = "4", count = 1): MailBackendListPage {
  return {
    revision,
    contactsRevision: "2",
    cleanupEpoch: "1",
    items: Array.from({ length: count }, (_, index) => inbox(String(index + 1))),
    total: String(count),
    nextOffset: null,
    ciphertextBytes: String(count * 2300),
  };
}

function snapshot(count = 1): MailSnapshot {
  return {
    folder: "inbox",
    unreadOnly: false,
    offset: "0",
    status: status(),
    page: page("4", count),
    loadedAt: 123,
  };
}

describe("authoritative snapshot controller", () => {
  test("recovers an erased resident key once without another user action", async () => {
    let loads = 0;
    let recoveries = 0;
    const result = await loadPrivateRowsWithRecovery(
      async () => {
        loads += 1;
        if (loads === 1) throw new Error("resident key expired");
        return "decrypted rows";
      },
      async () => {
        recoveries += 1;
      },
    );
    expect(result).toBe("decrypted rows");
    expect({ loads, recoveries }).toEqual({ loads: 2, recoveries: 1 });
  });

  test("does not loop when seamless private-row recovery also fails", async () => {
    let loads = 0;
    let recoveries = 0;
    await expect(loadPrivateRowsWithRecovery(
      async () => {
        loads += 1;
        throw new Error(`failure ${loads}`);
      },
      async () => {
        recoveries += 1;
      },
    )).rejects.toThrow("failure 2");
    expect({ loads, recoveries }).toEqual({ loads: 2, recoveries: 1 });
  });

  test("retries one status/list revision race and returns a coherent snapshot", async () => {
    let statusCalls = 0;
    let listCalls = 0;
    const loaded = await loadAuthoritativeMailSnapshot(
      {
        async status() {
          statusCalls += 1;
          return status(statusCalls === 1 ? "4" : "5");
        },
        async list(request) {
          listCalls += 1;
          expect(request.expectedRevision).toBe(listCalls === 1 ? "4" : "5");
          if (listCalls === 1) throw new Error("revision conflict");
          return page("5");
        },
      },
      "inbox",
      5,
      { now: 999 },
    );
    expect(statusCalls).toBe(2);
    expect(listCalls).toBe(2);
    expect(loaded).toMatchObject({ folder: "inbox", loadedAt: 999 });
    expect(loaded.status.revision).toBe("5");
    expect(loaded.page.revision).toBe("5");
  });

  test("refresh failure retains the last confirmed snapshot and labels it stale", () => {
    const confirmed = snapshot();
    let state = reduceMailSnapshot(INITIAL_MAIL_SNAPSHOT_STATE, {
      type: "refresh_succeeded",
      snapshot: confirmed,
    });
    state = reduceMailSnapshot(state, { type: "refresh_started" });
    state = reduceMailSnapshot(state, {
      type: "refresh_failed",
      message: "Temporary failure",
    });
    expect(state.snapshot).toBe(confirmed);
    expect(state).toMatchObject({ loading: false, stale: true, error: "Temporary failure" });
  });

  test("keeps the final page of a 600-message mailbox bounded to 50 rows", async () => {
    const current = snapshot(50);
    current.page.total = "600";
    current.page.nextOffset = "50";
    const requests: unknown[] = [];
    const loaded = await loadRevisionBoundMailPage({
      list: async (request) => {
        requests.push(request);
        return {
          revision: "4",
          contactsRevision: "2",
          cleanupEpoch: "1",
          items: Array.from({ length: 50 }, (_, index) => inbox(String(index + 551))),
          total: "600",
          nextOffset: null,
          ciphertextBytes: String(50 * 2300),
        };
      },
    }, current, "550", 50, { now: 456 });

    expect(requests).toEqual([{
      folder: "inbox",
      unreadOnly: false,
      offset: "550",
      limit: 50,
      expectedRevision: "4",
      expectedContactsRevision: "2",
    }]);
    expect(loaded.offset).toBe("550");
    expect(loaded.page.items).toHaveLength(50);
    expect(loaded.page.items[0]?.localId).toBe("551");
    expect(loaded.page.items.at(-1)?.localId).toBe("600");
    expect(loaded.page.items.some((item) => item.localId === "1")).toBe(false);
    expect(loaded.loadedAt).toBe(456);
  });

  test("rejects a revision-drifting or invalid page cursor", async () => {
    const current = snapshot(1);
    current.page.total = "2";
    current.page.nextOffset = "1";
    await expect(loadRevisionBoundMailPage({
      list: async () => ({
        ...page("5", 1),
        items: [inbox("2")],
        total: "2",
        nextOffset: null,
      }),
    }, current, "1", 50)).rejects.toThrow("Mail changed while loading this page");
  });

  test("clamps a deleted out-of-range page to the final bounded page", async () => {
    const requests: string[] = [];
    const loaded = await loadAuthoritativeMailSnapshot({
      status: async () => status("5"),
      list: async (request) => {
        requests.push(request.offset ?? "0");
        if (request.offset === "100") {
          return {
            ...page("5", 0),
            total: "52",
          };
        }
        return {
          ...page("5", 2),
          items: [inbox("51"), inbox("52")],
          total: "52",
        };
      },
    }, "inbox", 50, { offset: "100", now: 3 });

    expect(requests).toEqual(["100", "50"]);
    expect(loaded.offset).toBe("50");
    expect(loaded.page.items.map((item) => item.localId)).toEqual(["51", "52"]);
  });

  test("recognizes an unchanged exact folder/filter/page binding for status-only polling", () => {
    const current = snapshot(2);
    expect(mailSnapshotBindingIsCurrent(current, status(), "inbox", false, "0")).toBe(true);
    expect(mailSnapshotBindingIsCurrent(current, status(), "inbox", true, "0")).toBe(false);
    expect(mailSnapshotBindingIsCurrent(current, status(), "inbox", false, "50")).toBe(false);
    expect(mailSnapshotBindingIsCurrent(current, status("5"), "inbox", false, "0")).toBe(false);
  });

  test("skips full polling work for an unchanged pulse and exact page binding", () => {
    const current = snapshot(2);
    const baseline = mailPulseFromStatus(current.status);
    expect(mailPulseBindingIsCurrent(
      current,
      baseline,
      { ...baseline },
      "inbox",
      false,
      "0",
    )).toBe(true);
    expect(mailPulseBindingIsCurrent(
      current,
      baseline,
      { ...baseline, unread: "4" },
      "inbox",
      false,
      "0",
    )).toBe(false);
    expect(mailPulseBindingIsCurrent(
      current,
      baseline,
      baseline,
      "inbox",
      true,
      "0",
    )).toBe(false);
  });

  test("an unchanged idle probe calls pulse but no status or list endpoint", async () => {
    const current = snapshot(2);
    const baseline = mailPulseFromStatus(current.status);
    const calls = { pulse: 0, status: 0, list: 0 };
    const api = {
      pulse: async () => {
        calls.pulse += 1;
        return { ...baseline };
      },
      status: async () => {
        calls.status += 1;
        return current.status;
      },
      list: async () => {
        calls.list += 1;
        return current.page;
      },
    };
    await expect(probeMailPulseBinding(
      api,
      current,
      baseline,
      "inbox",
      false,
      "0",
    )).resolves.toMatchObject({ changed: false });
    expect(calls).toEqual({ pulse: 1, status: 0, list: 0 });
  });

  test("an observed new-mail pulse remains idle while its banner defers the old page", () => {
    const current = snapshot(2);
    const observed = {
      ...mailPulseFromStatus(current.status),
      revision: "5",
      inboxCount: "8",
      unread: "5",
    };
    expect(current.status.revision).toBe("4");
    expect(mailPulseBindingIsCurrent(
      current,
      observed,
      { ...observed },
      "inbox",
      false,
      "0",
    )).toBe(true);
    expect(mailPulseBindingIsCurrent(
      current,
      observed,
      { ...observed, inboxCount: "9" },
      "inbox",
      false,
      "0",
    )).toBe(false);
  });

  test("announces only a positive Inbox count delta as new mail", () => {
    const previous = status("4");
    expect(countInboxStatusArrivals(previous, {
      ...previous,
      revision: "5",
      unread: "4",
    })).toBe(0);
    expect(countInboxStatusArrivals(previous, {
      ...previous,
      revision: "5",
      inboxCount: "8",
      unread: "2",
    })).toBe(2);
  });
});

describe("locked-safe projections", () => {
  test("projects unlocked only for the resident's exact current generation", () => {
    expect(mailLockState(status(), null)).toBe("locked");
    expect(mailLockState(status(), {
      version: 1,
      lockState: "unlocked",
      currentEpoch: "6",
      previousEpoch: null,
      currentUnlocked: true,
      previousUnlocked: false,
      inactivityExpiresAt: "1785000000000",
    })).toBe("locked");
    expect(mailLockState(status(), {
      version: 1,
      lockState: "unlocked",
      currentEpoch: "7",
      previousEpoch: null,
      currentUnlocked: true,
      previousUnlocked: false,
      inactivityExpiresAt: "1785000000000",
    })).toBe("unlocked");
    expect(mailLockState({ ...status(), previousEpoch: "6" }, {
      version: 1,
      lockState: "unlocked",
      currentEpoch: "7",
      previousEpoch: null,
      currentUnlocked: true,
      previousUnlocked: false,
      inactivityExpiresAt: "1785000000000",
    })).toBe("locked");
    expect(mailLockState({ ...status(), previousEpoch: "6" }, {
      version: 1,
      lockState: "unlocked",
      currentEpoch: "7",
      previousEpoch: "6",
      currentUnlocked: true,
      previousUnlocked: false,
      inactivityExpiresAt: "1785000000000",
    })).toBe("locked");
    expect(mailLockState({ ...status(), previousEpoch: "6" }, {
      version: 1,
      lockState: "unlocked",
      currentEpoch: "7",
      previousEpoch: "6",
      currentUnlocked: true,
      previousUnlocked: true,
      inactivityExpiresAt: "1785000000000",
    })).toBe("unlocked");
  });

  test("known-at-receipt never becomes current Contacts trust or plaintext", () => {
    const summary = lockedMessageSummary(inbox("1", true), 1784040000000);
    const detail = lockedMessageDetail(inbox("1", true), "inbox", 1784040000000);
    expect(summary.sender.trust).toBe("not_in_contacts");
    expect(summary.subject).toBeNull();
    expect(detail.sender.trust).toBe("not_in_contacts");
    expect(detail.subject).toBeNull();
    expect(detail.bodyMarkdown).toBeNull();
  });

  test("uses the live Contacts projection while locked, independent of receipt history", () => {
    const current = {
      status: "in_contacts" as const,
      contactId: "7",
      contactRevision: "9",
      contactName: "Current Ada",
    };
    const summary = lockedMessageSummary(inbox("1", false, current), 1784040000000);
    expect(summary.sender).toMatchObject({
      principal: SENDER,
      trust: "in_contacts",
      contactName: "Current Ada",
    });

    const removed = lockedMessageSummary(
      inbox("1", true, { status: "not_in_contacts" }),
      1784040000000,
    );
    expect(removed.sender).toEqual({ principal: SENDER, trust: "not_in_contacts" });
  });

  test("reprojects selected current Contacts trust without replacing decrypted content", () => {
    const current = {
      ...lockedMessageDetail(inbox("1"), "inbox", 1784040000000),
      sender: {
        principal: SENDER,
        trust: "not_in_contacts" as const,
        claimedName: "Sender supplied",
      },
      subject: "Private subject",
      bodyMarkdown: "Private body",
      decryptionState: "ready" as const,
    };
    const outer = lockedMessageDetail(inbox("1", false, {
      status: "in_contacts",
      contactId: "7",
      contactRevision: "10",
      contactName: "Current Contact",
    }), "inbox", 1784040000000);
    expect(reprojectSelectedMessageOuter(current, outer)).toMatchObject({
      sender: {
        trust: "in_contacts",
        contactName: "Current Contact",
        claimedName: "Sender supplied",
      },
      subject: "Private subject",
      bodyMarkdown: "Private body",
    });
  });

  test("read is consumed only by a decrypted Inbox display in the tile", () => {
    expect(shouldMarkReadAfterDisplay({
      surface: "tile",
      folder: "inbox",
      lockState: "locked",
      decrypted: false,
      read: false,
    })).toBe(false);
    expect(shouldMarkReadAfterDisplay({
      surface: "tray",
      folder: "inbox",
      lockState: "unlocked",
      decrypted: true,
      read: false,
    })).toBe(false);
    expect(shouldMarkReadAfterDisplay({
      surface: "tile",
      folder: "inbox",
      lockState: "unlocked",
      decrypted: true,
      read: false,
    })).toBe(true);
  });

  test("malformed or out-of-range timestamps cannot crash rendering", () => {
    expect(formatMailTimestamp("not-a-number")).toEqual({
      iso: "",
      label: "Time unavailable",
      relative: "",
    });
    expect(formatMailTimestamp("999999999999999999999999999999999999")).toEqual({
      iso: "",
      label: "Time unavailable",
      relative: "",
    });
  });

  test("accepts only exact Inbox message tile handoffs", () => {
    expect(parseMailTileView("message/42")).toEqual({ folder: "inbox", localId: "42" });
    expect(parseMailTileView("message/04")).toBeNull();
    expect(parseMailTileView("message/42/extra")).toBeNull();
    expect(parseMailTileView("compose")).toBeNull();
  });
});

test("tray renders at most five authoritative generic rows and retains stale context", () => {
  const markup = renderToStaticMarkup(
    <MailTrayView
      state={{
        snapshot: snapshot(6),
        loading: false,
        stale: true,
        error: "Refresh failed",
      }}
      openingId={null}
      onRetry={() => undefined}
      onOpenMail={() => undefined}
      onOpenMessage={() => undefined}
    />,
  );
  expect(markup).toContain('class="nt-app mail-tray"');
  expect(markup).toContain("Recent mail · 3 unread");
  expect(markup).toContain("Stale snapshot");
  expect(markup).toContain("Showing the last confirmed snapshot. Refresh failed");
  expect(markup.match(/class="mail-tray-row(?: mail-tray-row--unread)?"/g)).toHaveLength(5);
  expect(markup.match(/Private message/g)?.length).toBeGreaterThanOrEqual(5);
  expect(markup).not.toContain("subject");
  expect(markup).toContain("Preparing private Mail…");
  expect(markup).toContain("Open Mail");
  expect(markup).not.toMatch(/Unlock|Lock/u);
});

test("ready tray renders at most five authenticated decrypted headers without bodies", () => {
  const current = snapshot(5);
  const rows: MailPrivateRow[] = current.page.items.map((item, index) => ({
    folder: "inbox",
    localId: item.localId,
    messageId: String(index + 1).padStart(32, "0"),
    peerPrincipal: SENDER,
    currentContact: item.kind === "inbox"
      ? item.currentContact
      : { status: "not_in_contacts" },
    timestampNs: item.kind === "inbox" ? item.receivedAtNs : "0",
    read: item.kind === "inbox" ? item.read : true,
    deliveryStatus: null,
    replyContextLabel: null,
    decryption: {
      state: "ready",
      header: {
        claimedSenderName: `Private sender ${index + 1}`,
        subject: `Private subject ${index + 1}`,
        senderCreatedAtNs: "1784040000000000000",
        inReplyTo: null,
      },
    },
  }));
  const markup = renderToStaticMarkup(
    <MailTrayView
      state={{ snapshot: current, loading: false, stale: false, error: null }}
      projection={{
        version: 1,
        state: "ready",
        page: { ...current.page, items: rows },
      }}
      openingId={null}
      onRetry={() => undefined}
      onOpenMail={() => undefined}
      onOpenMessage={() => undefined}
    />,
  );
  expect(markup.match(/class="mail-tray-row(?: mail-tray-row--unread)?"/g)).toHaveLength(5);
  expect(markup).toContain("Private sender 1");
  expect(markup).toContain("Private subject 1");
  expect(markup).not.toContain("Preparing private Mail…");
  expect(markup).not.toContain("bodyMarkdown");
  expect(markup).toContain("Open Mail");
});

test("tray fails contact conflicts closed to Unknown sender and always keeps an Open Mail footer", () => {
  const current = snapshot(1);
  const item = current.page.items[0];
  if (!item || item.kind !== "inbox") throw new Error("Missing Inbox fixture");
  const conflictedItem = {
    ...item,
    currentContact: { status: "contact_conflict" as const },
  };
  const conflicted = {
    ...current,
    page: { ...current.page, items: [conflictedItem] },
  };
  const row: MailPrivateRow = {
    folder: "inbox",
    localId: item.localId,
    messageId: "00000000000000000000000000000001",
    peerPrincipal: SENDER,
    currentContact: { status: "contact_conflict" },
    timestampNs: item.receivedAtNs,
    read: false,
    deliveryStatus: null,
    replyContextLabel: null,
    decryption: {
      state: "ready",
      header: {
        claimedSenderName: "Must not be trusted",
        subject: "Conflict subject",
        senderCreatedAtNs: item.receivedAtNs,
        inReplyTo: null,
      },
    },
  };
  const markup = renderToStaticMarkup(<MailTrayView
    state={{ snapshot: conflicted, loading: false, stale: false, error: null }}
    projection={{
      version: 1,
      state: "ready",
      page: { ...conflicted.page, items: [row] },
    }}
    openingId={null}
    onRetry={() => undefined}
    onOpenMail={() => undefined}
    onOpenMessage={() => undefined}
  />);
  expect(markup).toContain("Unknown sender");
  expect(markup).toContain("Contact conflict");
  expect(markup).not.toContain("Must not be trusted");
  const footer = markup.slice(markup.indexOf('<footer class="mail-tray-footer"'));
  expect(footer).toContain('class="nt-button"');
  expect(footer).toContain(">Open Mail</button>");
});

test("stale tray retains an already validated private header projection", () => {
  const current = snapshot(1);
  const item = current.page.items[0];
  if (!item || item.kind !== "inbox") throw new Error("Missing Inbox fixture");
  const row: MailPrivateRow = {
    folder: "inbox",
    localId: item.localId,
    messageId: "00000000000000000000000000000001",
    peerPrincipal: SENDER,
    currentContact: item.currentContact,
    timestampNs: item.receivedAtNs,
    read: item.read,
    deliveryStatus: null,
    replyContextLabel: null,
    decryption: {
      state: "ready",
      header: {
        claimedSenderName: "Validated sender",
        subject: "Validated subject",
        senderCreatedAtNs: "1784040000000000000",
        inReplyTo: null,
      },
    },
  };
  const markup = renderToStaticMarkup(
    <MailTrayView
      state={{
        snapshot: current,
        loading: false,
        stale: true,
        error: "Mail status is temporarily unavailable",
      }}
      projection={{
        version: 1,
        state: "ready",
        page: { ...current.page, items: [row] },
      }}
      projectionError="Private headers are unavailable until Mail can revalidate its key session."
      openingId={null}
      onRetry={() => undefined}
      onOpenMail={() => undefined}
      onOpenMessage={() => undefined}
    />,
  );
  expect(markup).toContain("Stale snapshot");
  expect(markup).toContain("Validated sender");
  expect(markup).toContain("Validated subject");
  expect(markup).not.toContain("Private message");
  expect(markup).not.toContain("revalidate its key session");
});
