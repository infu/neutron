import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  decryptedMessageDetail,
  decryptedMessageSummary,
  replyDraftForMessage,
} from "../src/mail_controller.ts";
import type { MailPrivateMessage, MailPrivateRow } from "../src/mail_private.ts";
import {
  MailUi,
  type MailComposerDraft,
  type MailMessageSummary,
  type MailUiProps,
} from "../src/mail_ui.tsx";

const SELF = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const SENDER = "un4fu-tqaaa-aaaab-qadjq-cai";

describe("decrypted Mail list and reader UX", () => {
  test("projects live trust, authenticated peer, and a safe no-quote reply entry", () => {
    const detail = decryptedMessageDetail({
      ...readyRow("1", "Quarterly plan", "Name supplied by sender"),
      bodyMarkdown: "Private body",
    }, SELF, 0);

    expect(detail.sender).toEqual({
      principal: SENDER,
      trust: "not_in_contacts",
      claimedName: "Name supplied by sender",
    });
    expect(detail.senderTimestampIso).toBe("1970-01-01T00:00:00.000Z");
    expect(detail.senderTimestampLabel).toBeTruthy();
    expect(detail.recipient.principal).toBe(SELF);
    const reply = replyDraftForMessage(detail);
    expect(reply).toEqual({
      mode: "reply",
      recipientInput: SENDER,
      recipient: { principal: SENDER, label: SENDER, source: "principal" },
      subject: "Re: Quarterly plan",
      bodyMarkdown: "",
      replyTo: { folder: "inbox", localId: "1" },
    });
  });

  test("one corrupt record renders an isolated state with no partial plaintext", () => {
    const corrupt: MailPrivateMessage = {
      ...readyRow("9", "MUST NOT APPEAR", "MUST NOT APPEAR"),
      decryption: { state: "corrupt" },
      bodyMarkdown: null,
    };
    const detail = decryptedMessageDetail(corrupt, SELF, 0);
    const markup = renderToStaticMarkup(<MailUi {...uiProps({
      navigation: {
        folder: "inbox",
        route: "reader",
        selectedId: "inbox:9",
        composeMode: null,
        composerTab: "editor",
      },
      messages: [decryptedMessageSummary(corrupt, SELF, 0)],
      selectedMessage: detail,
    })} />);

    expect(markup).toContain("Could not authenticate or decrypt this message");
    expect(markup).toContain(SENDER);
    expect(markup).not.toContain("MUST NOT APPEAR");
    expect(markup).toContain("Other messages remain available");
  });

  test("search filters loaded authenticated header projections and never bodies", () => {
    const first = decryptedMessageSummary(readyRow("1", "Roadmap", "Ada"), SELF, 0);
    const second = decryptedMessageSummary(readyRow("2", "Budget", "Grace"), SELF, 0);
    const markup = renderToStaticMarkup(<MailUi {...uiProps({
      messages: [first, second],
      searchQuery: "budget",
      onSearchQueryChange() {},
    })} />);

    expect(markup).toContain("Budget");
    expect(markup).not.toContain("Roadmap");
    expect(markup).toContain("Search sender or subject");
  });

  test("keeps the local sender name off the outgoing recipient identity", () => {
    const outgoing: MailPrivateRow = {
      ...readyRow("8", "Sent subject", "My sender name"),
      folder: "sent",
      read: true,
      deliveryStatus: "accepted",
    };
    const summary = decryptedMessageSummary(outgoing, SELF, 0);
    expect(summary.sender).toMatchObject({
      principal: SELF,
      claimedName: "My sender name",
    });
    expect(summary.recipient).toEqual({
      principal: SENDER,
      trust: "not_in_contacts",
    });
  });
});

function readyRow(
  localId: string,
  subject: string,
  claimedSenderName: string,
): MailPrivateRow {
  return {
    folder: "inbox",
    localId,
    messageId: localId.padStart(32, "0"),
    peerPrincipal: SENDER,
    currentContact: { status: "not_in_contacts" },
    timestampNs: "0",
    read: false,
    deliveryStatus: null,
    replyContextLabel: null,
    decryption: {
      state: "ready",
      header: {
        claimedSenderName,
        subject,
        senderCreatedAtNs: "0",
        inReplyTo: null,
      },
    },
  };
}

const EMPTY_DRAFT: MailComposerDraft = {
  mode: "new",
  recipientInput: "",
  recipient: null,
  subject: "",
  bodyMarkdown: "",
};

function uiProps(overrides: Partial<MailUiProps>): MailUiProps {
  const messages = overrides.messages ?? [];
  return {
    navigation: {
      folder: "inbox",
      route: "list",
      selectedId: null,
      composeMode: null,
      composerTab: "editor",
    },
    privateMailState: "ready",
    counts: { inbox: messages.length, sent: 0, outbox: 0, unread: messages.length },
    messages: messages as readonly MailMessageSummary[],
    selectedMessage: null,
    unreadOnly: false,
    searchQuery: "",
    composer: EMPTY_DRAFT,
    storage: {
      usedLabel: "0 B",
      messageCount: messages.length,
      cleanupCounts: { read_inbox: 0, unknown_senders: null, all_mail: messages.length },
    },
    cleanupDialog: null,
    confirmationDialog: null,
    onNavigate() {},
    onUnreadOnlyChange() {},
    onSearchQueryChange() {},
    onDraftChange() {},
    onChooseRecipient() {},
    onInsertMarkdown() {},
    onSend() {},
    onToggleRead() {},
    onDeleteMessage() {},
    onSetUpPrivateMail() {},
    onRetryPrivateMail() {},
    onRequestCleanup() {},
    onCancelCleanup() {},
    onConfirmCleanup() {},
    onCancelConfirmation() {},
    onConfirmConfirmation() {},
    ...overrides,
  };
}
