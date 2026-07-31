import { describe, expect, test } from "bun:test";
import { assertMailCryptoTrayCaller } from "../src/mail_crypto_session.ts";
import {
  MailTrayResidentProjection,
  type MailTrayProjectionDependencies,
} from "../src/mail_tray_projection.ts";
import { parseMailTrayProjection } from "../src/mail_tray_client.ts";
import type { MailPrivateListPage, MailPrivateRow } from "../src/mail_private.ts";

describe("seamless Mail tray projection", () => {
  test("admits only the exact same-app tray caller", () => {
    expect(() => assertMailCryptoTrayCaller({
      endpoint: "app:mail:tray:instance:1",
      appId: "mail",
      role: "tray",
    })).not.toThrow();
    for (const caller of [
      undefined,
      { endpoint: "app:mail:tile:mail:instance:1", appId: "mail", role: "tile" },
      { endpoint: "app:other:tray:instance:1", appId: "other", role: "tray" },
      { endpoint: "app:mail:background", appId: "mail", role: "background" },
    ]) expect(() => assertMailCryptoTrayCaller(caller)).toThrow("only to the Mail tray");
  });

  test("prepares and decrypts at most five headers through the resident", async () => {
    let listCalls = 0;
    const projection = new MailTrayResidentProjection(dependencies({
      unlocked: true,
      list: async (request) => {
        listCalls += 1;
        expect(request).toMatchObject({
          folder: "inbox",
          offset: "0",
          limit: 5,
          expectedRevision: "9",
          expectedContactsRevision: "4",
        });
        return page(5);
      },
    }));
    const result = await projection.snapshot({
      expectedRevision: "9",
      expectedContactsRevision: "4",
    });
    expect(result).toMatchObject({ version: 1, state: "ready" });
    expect(result.state === "ready" ? result.page.items : []).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain("bodyMarkdown");
    expect(listCalls).toBe(1);

    const unavailable = new MailTrayResidentProjection(dependencies({
      unlocked: false,
      list: async () => {
        throw new Error("unavailable tray must not request ciphertext");
      },
    }));
    expect(await unavailable.snapshot({
      expectedRevision: "9",
      expectedContactsRevision: "4",
    })).toEqual({ version: 1, state: "unavailable" });
  });

  test("strict client parser rejects bodies and oversized projections", () => {
    const valid = {
      version: 1,
      state: "ready",
      page: page(5),
    };
    expect(parseMailTrayProjection(valid)).toMatchObject({ state: "ready" });
    expect(() => parseMailTrayProjection({
      ...valid,
      page: page(6),
    })).toThrow("Invalid Mail tray projection");
    expect(() => parseMailTrayProjection({
      ...valid,
      bodyMarkdown: "must never cross the tray boundary",
    })).toThrow("Invalid Mail tray projection");
    expect(parseMailTrayProjection({ version: 1, state: "loading" }))
      .toEqual({ version: 1, state: "loading" });
    expect(parseMailTrayProjection({ version: 1, state: "not_configured" }))
      .toEqual({ version: 1, state: "not_configured" });
  });
});

function dependencies(input: {
  unlocked: boolean;
  list: MailTrayProjectionDependencies["privateMail"]["list"];
}): MailTrayProjectionDependencies {
  return {
    session: {
      status: async () => ({
        version: 1,
        lockState: input.unlocked ? "unlocked" : "locked",
        currentEpoch: "8",
        previousEpoch: null,
        currentUnlocked: input.unlocked,
        previousUnlocked: false,
        inactivityExpiresAt: input.unlocked ? "9999999999999" : null,
      }),
    },
    privateMail: { list: input.list },
  };
}

function page(count: number): MailPrivateListPage {
  return {
    revision: "9",
    contactsRevision: "4",
    cleanupEpoch: "0",
    items: Array.from({ length: count }, (_, index) => row(index + 1)),
    total: String(count),
    nextOffset: null,
    ciphertextBytes: String(count * 2_064),
  };
}

function row(id: number): MailPrivateRow {
  return {
    folder: "inbox",
    localId: String(id),
    messageId: String(id).padStart(32, "0"),
    peerPrincipal: "un4fu-tqaaa-aaaab-qadjq-cai",
    currentContact: { status: "not_in_contacts" },
    timestampNs: String(id),
    read: id % 2 === 0,
    deliveryStatus: null,
    replyContextLabel: null,
    decryption: {
      state: "ready",
      header: {
        claimedSenderName: `Sender ${id}`,
        subject: `Subject ${id}`,
        senderCreatedAtNs: String(id),
        inReplyTo: null,
      },
    },
  };
}
