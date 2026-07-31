import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAIL_CLEANUP_ACTIONS,
  MailUi,
  reduceMailUiNavigation,
  requestComposerSend,
  showMailDeliverySetupNotice,
  type MailComposerDraft,
  type MailIdentity,
  type MailMessageDetail,
  type MailMessageSummary,
  type MailUiNavigation,
  type MailUiProps,
} from "../src/mail_ui.tsx";

const contact: MailIdentity = {
  principal: "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe",
  trust: "in_contacts",
  contactName: "Ada Contact",
};

const unknown: MailIdentity = {
  principal: "aaaaa-bbbbb-ccccc-ddddd-eeee-fffff-ggggg-hhhhh-iiiii-jjjjj-kkk",
  trust: "not_in_contacts",
  claimedName: "Unverified Mallory",
};

const message: MailMessageDetail = {
  id: "m1",
  folder: "inbox",
  read: false,
  sender: unknown,
  recipient: contact,
  subject: "Quarterly secret",
  bodyMarkdown: "Hello **privately**. [Plan](https://example.com/plan)",
  timestampLabel: "10:42",
  timestampIso: "2026-07-14T10:42:00.000Z",
};

const draft: MailComposerDraft = {
  mode: "new",
  recipientInput: "",
  recipient: null,
  subject: "",
  bodyMarkdown: "",
};

const navigation: MailUiNavigation = {
  folder: "inbox",
  route: "list",
  selectedId: null,
  composeMode: null,
  composerTab: "editor",
};

function props(overrides: Partial<MailUiProps> = {}): MailUiProps {
  return {
    navigation,
    privateMailState: "ready",
    deliverySetupState: "ready",
    counts: { inbox: 2, sent: 1, outbox: 0, unread: 1 },
    messages: [message],
    selectedMessage: null,
    unreadOnly: false,
    composer: draft,
    recipientOptions: [],
    storage: {
      usedLabel: "12 KiB",
      messageCount: 3,
      cleanupCounts: { read_inbox: 1, unknown_senders: 1, all_mail: 3 },
    },
    cleanupDialog: null,
    confirmationDialog: null,
    onNavigate() {},
    onUnreadOnlyChange() {},
    onDraftChange() {},
    onChooseRecipient() {},
    onAddToContacts() {},
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

describe("Mail UI navigation contract", () => {
  test("in-app confirmations are modal, cancel-first, and show the exact direct address", () => {
    const markup = renderToStaticMarkup(<MailUi {...props({
      confirmationDialog: {
        title: "Send to a direct address?",
        description: "Direct addresses are not bound to a Contacts revision.",
        confirmLabel: "Send to this address",
        detailLabel: "Exact Neutron principal",
        detailValue: unknown.principal,
      },
    })} />);
    const dialog = markup.slice(markup.indexOf('role="dialog"'), markup.indexOf("</section>", markup.indexOf('role="dialog"')));

    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain('aria-labelledby="mail-confirmation-dialog-title"');
    expect(dialog).toContain('aria-describedby="mail-confirmation-dialog-description"');
    expect(dialog).toContain(`>${unknown.principal}</bdi>`);
    expect(dialog).not.toContain("autofocus");
    expect(dialog.indexOf(">Cancel</button>")).toBeLessThan(dialog.indexOf(">Send to this address</button>"));
  });

  test("dirty draft confirmation uses decision-specific actions", () => {
    const markup = renderToStaticMarkup(<MailUi {...props({
      confirmationDialog: {
        title: "Discard this draft?",
        description: "Your unsent draft exists only in this tile.",
        cancelLabel: "Continue editing",
        confirmLabel: "Discard message",
        destructive: true,
      },
    })} />);
    expect(markup).toContain(">Continue editing</button>");
    expect(markup).toContain(">Discard message</button>");
  });

  test("composer has no native form submission and handles activation in-app", () => {
    const markup = renderToStaticMarkup(<MailUi {...props({
      navigation: { ...navigation, route: "compose", composeMode: "new" },
      composer: { ...draft, subject: "Sandbox-safe send" },
    })} />);
    const composerStart = markup.indexOf('<section class="mail-composer"');
    const composer = markup.slice(composerStart, markup.indexOf("</section>", composerStart));
    const sendButton = composer.match(/<button\b[^>]*class="nt-button"[^>]*>/)?.[0];
    const composerButtons = composer.match(/<button\b[^>]*>/g) ?? [];

    expect(sendButton).toContain('type="button"');
    expect(markup).not.toContain("<form");
    expect(composerButtons.length).toBeGreaterThan(1);
    expect(composerButtons.every((button) => button.includes('type="button"'))).toBe(true);

    let prevented = 0;
    const sent: MailComposerDraft[] = [];
    const event = { preventDefault: () => { prevented += 1; } };
    requestComposerSend(event, draft, false, (nextDraft) => sent.push(nextDraft));
    requestComposerSend(event, draft, true, (nextDraft) => sent.push(nextDraft));

    expect(prevented).toBe(2);
    expect(sent).toEqual([draft]);
  });

  test("keeps Compose available while private Mail prepares without key controls", () => {
    const ready = renderToStaticMarkup(<MailUi {...props()} />);
    expect(ready).toContain('class="nt-app nt-app--fill mail-ui');
    expect(ready).toContain('class="nt-button mail-compose-button"');
    expect(ready).toContain('aria-label="Compose"');
    const preparing = renderToStaticMarkup(<MailUi {...props({ privateMailState: "preparing" })} />);
    expect(preparing).toContain('aria-label="Compose"');
    expect(preparing).not.toMatch(/>Unlock<|>Lock<|aria-label="(?:Unlock|Lock)/u);
  });

  test("retains one Compose activation while a fresh browser prepares its key", () => {
    const composing = reduceMailUiNavigation(navigation, { type: "compose" });
    expect(composing).toMatchObject({
      route: "compose",
      composeMode: "new",
      composerTab: "editor",
    });

    const preparing = renderToStaticMarkup(<MailUi {...props({
      navigation: composing,
      privateMailState: "preparing",
    })} />);
    expect(preparing).toContain("Preparing private Mail…");
    expect(preparing).not.toContain("Ready to unlock in this browser");
    expect(preparing).not.toContain('id="mail-compose-title"');

    // Key recovery changes only readiness. The retained navigation intent is
    // enough to reveal the composer; no second Compose activation is needed.
    const recovered = renderToStaticMarkup(<MailUi {...props({
      navigation: composing,
      privateMailState: "ready",
    })} />);
    expect(recovered).toContain('id="mail-compose-title">New message</h2>');
    expect(recovered).not.toMatch(/>Unlock<|>Lock<|aria-label="(?:Unlock|Lock)/u);
  });

  test("offers the one-time setup action only when private Mail is not configured", () => {
    const setup = renderToStaticMarkup(<MailUi {...props({
      privateMailState: "not_configured",
      messages: [],
      neutronAddress: unknown.principal,
    })} />);
    const preparing = renderToStaticMarkup(<MailUi {...props({
      privateMailState: "preparing",
      messages: [],
      neutronAddress: unknown.principal,
    })} />);
    const ready = renderToStaticMarkup(<MailUi {...props()} />);
    expect(setup).toContain(">Set up private Mail</button>");
    expect(setup).not.toContain("Private Mail active");
    expect(preparing).not.toContain("Private Mail active");
    expect(ready).not.toContain(">Set up private Mail</button>");
  });

  test("supports folder, reader, reply, editor/preview, mobile back, and compose flows", () => {
    const markup = renderToStaticMarkup(<MailUi {...props()} />);
    expect(markup).toContain('aria-label="Show unread mail only"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain('type="checkbox"');
    const unreadMarkup = renderToStaticMarkup(<MailUi {...props({ unreadOnly: true })} />);
    expect(unreadMarkup).toContain('aria-pressed="true"');
    expect(markup.match(/data-mail-return-focus="folder-/g)).toHaveLength(2);
    expect(markup).not.toContain("folder-outbox");
    const withOutbox = renderToStaticMarkup(<MailUi {...props({
      counts: { inbox: 2, sent: 1, outbox: 1, unread: 1 },
    })} />);
    expect(withOutbox.match(/data-mail-return-focus="folder-/g)).toHaveLength(3);
    expect(withOutbox).toContain("folder-outbox");
    const whileSending = renderToStaticMarkup(<MailUi {...props({ sendPending: true })} />);
    expect(whileSending).toContain("folder-outbox");

    let state = navigation;
    state = reduceMailUiNavigation(state, { type: "select_folder", folder: "sent" });
    expect(state).toMatchObject({ folder: "sent", route: "list", selectedId: null });

    state = reduceMailUiNavigation(state, { type: "select_message", id: "sent-1" });
    expect(state).toMatchObject({ route: "reader", selectedId: "sent-1" });

    state = reduceMailUiNavigation(state, { type: "reply", id: "sent-1" });
    expect(state).toMatchObject({
      route: "compose",
      selectedId: "sent-1",
      composeMode: "reply",
      composerTab: "editor",
    });

    state = reduceMailUiNavigation(state, { type: "composer_tab", tab: "preview" });
    expect(state.composerTab).toBe("preview");
    state = reduceMailUiNavigation(state, { type: "back" });
    expect(state).toMatchObject({ route: "reader", selectedId: "sent-1", composeMode: null });
    state = reduceMailUiNavigation(state, { type: "back" });
    expect(state).toMatchObject({ route: "list", selectedId: null });

    state = reduceMailUiNavigation(state, { type: "compose" });
    expect(state).toMatchObject({ route: "compose", composeMode: "new", selectedId: null });
    state = reduceMailUiNavigation(state, { type: "back" });
    expect(state.route).toBe("list");
    state = reduceMailUiNavigation(state, { type: "settings" });
    expect(state.route).toBe("settings");
    expect(reduceMailUiNavigation(state, { type: "back" }).route).toBe("list");
  });

  test("renders one bounded page with a range and Previous/Next controls", () => {
    const lastPage = Array.from({ length: 50 }, (_, index) => ({
      ...message,
      id: `mail-${index + 551}`,
      subject: `Message ${index + 551}`,
    }));
    const markup = renderToStaticMarkup(<MailUi {...props({
      messages: lastPage,
      pageOffset: 550,
      pageTotal: 600,
      hasPreviousPage: true,
      hasNextPage: false,
    })} />);
    expect(markup).toContain('aria-label="Mail pages"');
    expect(markup).toContain("551–600 of 600");
    expect(markup.match(/role="listitem"/gu)).toHaveLength(50);
    expect(markup).toContain('data-mail-row-index="550"');
    expect(markup).toContain('aria-posinset="551" aria-setsize="600"');
    expect(markup).toContain('aria-posinset="600" aria-setsize="600"');
    expect(markup).toContain(">Previous</button>");
    expect(markup).toContain(">Next</button>");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/u);
    expect(markup).not.toContain("Load older mail");

    const first = renderToStaticMarkup(<MailUi {...props({
      pageOffset: 0,
      pageTotal: 600,
      hasPreviousPage: false,
      hasNextPage: true,
    })} />);
    expect(first).toContain("1–1 of 600");
    expect(first).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button>/u);

    const noMatch = renderToStaticMarkup(<MailUi {...props({
      pageOffset: 50,
      pageTotal: 600,
      searchQuery: "no such header",
      onSearchQueryChange() {},
    })} />);
    expect(noMatch).toContain("Search checks this page&#x27;s sender and subject headers");
  });

  test("shows a quiet 80% notice and a strong 95% storage notice", () => {
    const approaching = renderToStaticMarkup(<MailUi {...props({
      storage: { ...props().storage, level: "approaching_limit" },
    })} />);
    expect(approaching).toContain("Storage 80% full");
    expect(approaching).toContain("Manage storage");
    expect(approaching).toContain('role="status"');

    const almostFull = renderToStaticMarkup(<MailUi {...props({
      storage: { ...props().storage, level: "almost_full" },
    })} />);
    expect(almostFull).toContain("Storage almost full");
    expect(almostFull).toContain("New mail may be rejected.");
    expect(almostFull).toContain('role="alert"');
  });
});

describe("Mail UI privacy and trust projections", () => {
  test("preparing list rows expose a local contact name or shortened principal, never decrypted fields", () => {
    const contactMessage: MailMessageSummary = {
      ...message,
      id: "m2",
      sender: contact,
      subject: "Contact-only secret",
    };
    const markup = renderToStaticMarkup(
      <MailUi
        {...props({
          privateMailState: "preparing",
          messages: [message, contactMessage],
          selectedMessage: message,
          navigation: { ...navigation, route: "reader", selectedId: "m1" },
        })}
      />,
    );

    expect(markup).toContain("Ada Contact");
    expect(markup).toContain("aaaaa-bbbb…jjjj-kkk");
    expect(markup.match(/Private message/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).not.toContain("Unverified Mallory");
    expect(markup).not.toContain("Quarterly secret");
    expect(markup).not.toContain("Contact-only secret");
    expect(markup).not.toContain("Hello <strong>privately</strong>");
  });

  test("reader clearly labels sender-supplied names as unverified", () => {
    const markup = renderToStaticMarkup(
      <MailUi
        {...props({
          navigation: { ...navigation, route: "reader", selectedId: "m1" },
          selectedMessage: message,
        })}
      />,
    );
    expect(markup).toContain("Unverified Mallory");
    expect(markup).toContain("Not in Contacts");
    expect(markup).toContain("Name supplied by sender and not verified");
    expect(markup).toContain("Quarterly secret");
    expect(markup).toContain("<strong>privately</strong>");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("href=");
    expect(markup).toContain(unknown.principal);
    expect(markup).toContain('aria-label="Add sender to Contacts"');
    expect(markup).toContain('title="Add to Contacts"');
    expect(markup).not.toContain("Copy full address");
  });

  test("reader keeps sender-created time inside Details", () => {
    const withSenderTime: MailMessageDetail = {
      ...message,
      senderTimestampLabel: "Jul 14, 10:40 AM",
      senderTimestampIso: "2026-07-14T10:40:00.000Z",
    };
    const markup = renderToStaticMarkup(<MailUi {...props({
      navigation: { ...navigation, route: "reader", selectedId: message.id },
      selectedMessage: withSenderTime,
    })} />);
    const details = markup.slice(markup.indexOf('<details class="mail-message-details"'));
    expect(details).toContain("Sender-created time");
    expect(details).toContain("2026-07-14T10:40:00.000Z");
    expect(markup.slice(0, markup.indexOf('<details class="mail-message-details"')))
      .not.toContain("Sender-created time");
  });

  test("new arrivals wait behind a banner and an externally deleted selection is explicit", () => {
    const banner = renderToStaticMarkup(
      <MailUi {...props({ newMailCount: 2 })} />,
    );
    expect(banner).toContain("2 new messages");
    expect(banner).toContain(">Show<");

    const deleted = renderToStaticMarkup(
      <MailUi {...props({
        navigation: { ...navigation, route: "reader", selectedId: "inbox:42" },
        selectedMessage: null,
        selectionUnavailableMessage: "It was deleted in another Mail view.",
      })} />,
    );
    expect(deleted).toContain("Message no longer available");
    expect(deleted).toContain("It was deleted in another Mail view.");
    expect(deleted).toContain("Back to mail");
  });

  test("a preparing compose route cannot render a plaintext draft", () => {
    const markup = renderToStaticMarkup(
      <MailUi
        {...props({
          privateMailState: "preparing",
          navigation: { ...navigation, route: "compose", composeMode: "new" },
          composer: {
            ...draft,
            recipientInput: "Secret Recipient",
            subject: "Draft secret",
            bodyMarkdown: "Draft plaintext that must stay hidden",
          },
        })}
      />,
    );
    expect(markup).toContain("Preparing private Mail…");
    expect(markup).not.toContain("Secret Recipient");
    expect(markup).not.toContain("Draft secret");
    expect(markup).not.toContain("Draft plaintext that must stay hidden");
  });

  test("private Mail preparation is neutral and actual failures stay retryable", () => {
    const pending = renderToStaticMarkup(
      <MailUi {...props({
        privateMailState: "preparing",
        privateMailNotice: "Preparing private Mail…",
      })} />,
    );
    expect(pending).toContain("Preparing private Mail…");
    expect(pending).not.toContain(">Retry</button>");

    const failed = renderToStaticMarkup(
      <MailUi {...props({
        privateMailState: "unavailable",
        privateMailNotice: "The private key service is unavailable. Try again.",
      })} />,
    );
    expect(failed).toContain("role=\"alert\"");
    expect(failed).toContain("The private key service is unavailable. Try again.");
    expect(failed).toContain(">Retry</button>");
  });

  test("unavailable reader exposes add-to-Contacts without decrypted sender text", () => {
    const markup = renderToStaticMarkup(
      <MailUi
        {...props({
          privateMailState: "unavailable",
          navigation: { ...navigation, route: "reader", selectedId: "m1" },
          selectedMessage: message,
          privateMailNotice: "App-isolated vetKeys storage is unavailable.",
        })}
      />,
    );
    expect(markup).toContain(unknown.principal);
    expect(markup).toContain('aria-label="Add sender to Contacts"');
    expect(markup).not.toContain("Copy full address");
    expect(markup).toContain("Not in Contacts");
    expect(markup).not.toContain("Known when received");
    expect(markup).not.toContain("Unverified Mallory");
  });

  test("Inbox header shows the local receiving address without an empty-state explainer box", () => {
    const address = "rrkah-fqaaa-aaaaa-aaaaq-cai";
    const markup = renderToStaticMarkup(
      <MailUi
        {...props({
          counts: { inbox: 0, sent: 0, outbox: 0, unread: 0 },
          messages: [],
          neutronAddress: address,
        })}
      />,
    );
    expect(markup).toContain('aria-label="Your Neutron address"');
    expect(markup).toContain(`Copy full Neutron canister address: ${address}`);
    expect(markup).toContain(address);
    expect(markup).not.toContain("Receiving Mail address");
    expect(markup).not.toContain("Private Mail active");
    expect(markup).not.toContain("Up to 10 messages from people not in Contacts");

    const loading = renderToStaticMarkup(
      <MailUi
        {...props({
          privateMailState: "preparing",
          counts: { inbox: 0, sent: 0, outbox: 0, unread: 0 },
          messages: [],
          neutronAddress: address,
          loading: true,
        })}
      />,
    );
    expect(loading).toContain('aria-label="Your Neutron address"');
    expect(loading).toContain(`Copy full Neutron canister address: ${address}`);
    expect(loading).toContain("Loading mail…");
  });

  test("received mail identifies this Neutron as Me instead of repeating its address", () => {
    const markup = renderToStaticMarkup(<MailUi {...props({
      navigation: { ...navigation, route: "reader", selectedId: message.id },
      selectedMessage: message,
    })} />);
    const destinationStart = markup.indexOf('class="mail-meta-destination"');
    const destination = markup.slice(destinationStart, markup.indexOf("</div>", destinationStart));
    expect(destination).toContain(">To</span>");
    expect(destination).toContain(">Me</strong>");
    expect(destination).not.toContain(message.recipient.principal);
  });

  test("contact conflicts never select a contact or sender-supplied name", () => {
    const conflict: MailIdentity = {
      ...unknown,
      trust: "contact_conflict",
      contactName: "Ambiguous Contact",
      claimedName: "Sender claim",
    };
    const conflicted = { ...message, sender: conflict };
    const markup = renderToStaticMarkup(<MailUi {...props({
      messages: [conflicted],
      navigation: { ...navigation, route: "reader", selectedId: conflicted.id },
      selectedMessage: conflicted,
    })} />);
    expect(markup.match(/Unknown sender/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).toContain("Contact conflict");
    expect(markup).toContain("No contact name was trusted");
    expect(markup).not.toContain("Ambiguous Contact");
    expect(markup).not.toContain("Sender claim");
  });
});

describe("Mail compose and cleanup", () => {
  test("delivery setup stays out of the UI while an install grant is being checked", () => {
    expect(showMailDeliverySetupNotice("checking")).toBe(false);
    expect(showMailDeliverySetupNotice("ready")).toBe(false);
    expect(showMailDeliverySetupNotice("required")).toBe(true);
    expect(showMailDeliverySetupNotice("requesting")).toBe(true);
    expect(showMailDeliverySetupNotice("unavailable")).toBe(true);

    const markup = renderToStaticMarkup(<MailUi {...props({
      navigation: { ...navigation, route: "compose", composeMode: "new" },
      deliverySetupState: "checking",
    })} />);
    expect(markup).not.toContain("Checking Mail delivery setup");
    expect(markup).not.toContain("Finish Mail setup");
  });

  test("compose offers Markdown Editor and Preview without attachment controls", () => {
    const markup = renderToStaticMarkup(
      <MailUi
        {...props({
          navigation: { ...navigation, route: "compose", composeMode: "new" },
          composer: { ...draft, bodyMarkdown: "**Draft**" },
          recipientOptions: [{ principal: contact.principal, label: "Ada Contact", source: "contact" }],
        })}
      />,
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain(">Editor<");
    expect(markup).toContain(">Preview<");
    expect(markup).toContain('aria-label="Markdown formatting"');
    expect(markup).toContain('aria-label="Code block"');
    expect(markup).toContain("Markdown help");
    expect(markup).toContain("[Plan](https://example.com/plan)");
    expect(markup).not.toContain('role="combobox"');
    expect(markup).not.toContain('role="listbox"');
    expect(markup).not.toContain('role="option"');
    expect(markup).toContain("Remote images never load");
    expect(markup).not.toMatch(/attachment|attach file|type="file"|upload/i);
    expect(markup).toContain('id="mail-editor-tab"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-labelledby="mail-editor-tab"');
    expect(markup).not.toContain("mail-body-byte-count");
  });

  test("body byte count appears only near the 32 KiB limit", () => {
    const markup = renderToStaticMarkup(<MailUi {...props({
      navigation: { ...navigation, route: "compose", composeMode: "new" },
      composer: { ...draft, bodyMarkdown: "x".repeat(24 * 1_024) },
    })} />);
    expect(markup).toContain("mail-body-byte-count");
    expect(markup).toContain("24576 / 32 KiB");
  });

  test("one-time delivery setup is separate from Send and preserves the draft", () => {
    const markup = renderToStaticMarkup(<MailUi {...props({
      navigation: { ...navigation, route: "compose", composeMode: "new" },
      composer: {
        ...draft,
        recipientInput: "Ada Contact",
        recipient: { principal: contact.principal, label: "Ada Contact", source: "contact" },
        subject: "Review",
        bodyMarkdown: "Private body",
      },
      deliverySetupState: "required",
      onSetUpDelivery() {},
      onManageContacts() {},
    })} />);
    expect(markup).toContain("Finish Mail setup");
    expect(markup).toContain("Finish Mail setup once to send encrypted messages");
    expect(markup).toContain(">Send</button>");
    expect(markup).not.toContain("Review access");
    expect(markup).not.toContain("then choose Apply");
    expect(markup).toContain(contact.principal);
    expect(markup).toContain("In Contacts");
    expect(markup).toContain("Manage Contacts");
    expect(markup).not.toContain("Allow &amp; retry");
  });

  test("direct recipients remain explicitly marked outside Contacts before send", () => {
    const markup = renderToStaticMarkup(<MailUi {...props({
      navigation: { ...navigation, route: "compose", composeMode: "new" },
      composer: {
        ...draft,
        recipientInput: unknown.principal,
        recipient: { principal: unknown.principal, label: unknown.principal, source: "principal" },
      },
      onManageContacts() {},
    })} />);
    expect(markup).toContain(unknown.principal);
    expect(markup).toContain("Not in Contacts");
    expect(markup).not.toContain("Direct principal");
    expect(markup).toContain("Manage Contacts");
  });

  test("pending send freezes every editable composer control", () => {
    const markup = renderToStaticMarkup(
      <MailUi {...props({
        navigation: { ...navigation, route: "compose", composeMode: "new" },
        composer: { ...draft, subject: "In flight", bodyMarkdown: "Encrypted" },
        sendPending: true,
        recipientOptions: [{ principal: contact.principal, label: "Ada", source: "contact" }],
      })} />,
    );
    const composerStart = markup.indexOf('<section class="mail-composer"');
    const composer = markup.slice(composerStart, markup.indexOf("</section>", composerStart));
    const inputs = composer.match(/<input\b[^>]*>/g) ?? [];
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    expect(inputs.every((input) => input.includes('disabled=""'))).toBe(true);
    expect(composer.match(/<textarea\b[^>]*disabled=""/g)).toHaveLength(1);
    expect(markup).toContain("Sending…");
  });

  test("retryable Outbox mail offers exact Retry and a separate editable copy", () => {
    const outbox: MailMessageDetail = {
      ...message,
      id: "outbox:8",
      folder: "outbox",
      read: true,
      sender: contact,
      recipient: unknown,
      deliveryStatus: "delivery_uncertain",
    };
    const markup = renderToStaticMarkup(
      <MailUi {...props({
        navigation: { ...navigation, folder: "outbox", route: "reader", selectedId: outbox.id },
        selectedMessage: outbox,
        onRetryMessage() {},
        onEditMessageCopy() {},
      })} />,
    );
    expect(markup).toContain("Retry the exact encrypted message");
    expect(markup).toContain("Edit copy");
    expect(markup).toContain("leave this Outbox record unchanged");
  });

  test("Preview renders through the copy-only safe Markdown surface", () => {
    const markup = renderToStaticMarkup(
      <MailUi
        {...props({
          navigation: {
            ...navigation,
            route: "compose",
            composeMode: "new",
            composerTab: "preview",
          },
          composer: {
            ...draft,
            bodyMarkdown: "[safe](https://example.com) ![remote](https://example.com/a.png)",
          },
        })}
      />,
    );
    expect(markup).toContain("Message preview");
    expect(markup).toContain("Copy link: https://example.com/");
    expect(markup).toContain("Remote image not loaded: remote");
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("src=");
  });

  test("storage presents exactly three review actions and a server-preview confirmation", () => {
    expect(MAIL_CLEANUP_ACTIONS.map((action) => action.scope)).toEqual([
      "read_inbox",
      "unknown_senders",
      "all_mail",
    ]);
    const markup = renderToStaticMarkup(
      <MailUi
        {...props({
          navigation: { ...navigation, route: "settings" },
          neutronAddress: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          lifecycleKeyManager: contact.principal,
          storage: {
            ...props().storage,
            cleanupDetails: {
              read_inbox: { count: 1, bytesLabel: "3 KiB" },
              unknown_senders: { count: 1, bytesLabel: "4 KiB" },
              all_mail: { count: 3, bytesLabel: "12 KiB" },
            },
          },
          cleanupDialog: {
            preview: {
              scope: "all_mail",
              previewToken: "opaque-preview-token",
              total: 3,
              unread: 1,
              inbox: 2,
              sent: 1,
              outbox: 0,
              activeSends: 0,
              bytesLabel: "12 KiB",
            },
          },
        })}
      />,
    );
    expect(markup.match(/data-cleanup-action=/g)).toHaveLength(3);
    expect(markup.match(/data-mail-return-focus="cleanup-/g)).toHaveLength(3);
    expect(markup).toContain("Delete read Inbox mail");
    expect(markup).toContain("Delete mail from unknown senders");
    expect(markup).toContain("Delete all mail");
    expect(markup).toContain("Deleting a local copy does not delete the recipient");
    expect(markup).toContain("A send already dispatched");
    expect(markup.match(/nt-settings-row/g)).toHaveLength(3);
    expect(markup.match(/nt-button nt-button--secondary nt-button--sm mail-cleanup-button/g)).toHaveLength(3);
    expect(markup).toContain("3 messages · 12 KiB");
    expect(markup).not.toContain("mail-cleanup-button--danger");
    expect(markup).toContain("Private Mail active");
    expect(markup).toContain("Anyone with a Neutron canister can send private Mail");
    expect(markup).toContain("Every principal currently authorized in this Neutron can access existing Mail history");
    expect(markup).toContain("Key lifecycle manager");
    expect(markup).toContain("active controller can replace Mail or Neutron code");
    expect(markup).toContain("no forward secrecy");
    expect(markup).toContain("given Neutron permission to use a Mail tool");
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Review the current server preview");
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("Delete 3");
    expect(markup).toContain('class="nt-button nt-button--danger"');
    expect(markup).not.toContain("autofocus");
  });

  test("unknown-senders cleanup remains reviewable until its authoritative count is fetched", () => {
    const markup = renderToStaticMarkup(
      <MailUi
        {...props({
          navigation: { ...navigation, route: "settings" },
          storage: {
            usedLabel: "12 KiB",
            messageCount: 3,
            cleanupCounts: { read_inbox: 1, unknown_senders: null, all_mail: 3 },
          },
        })}
      />,
    );
    const start = markup.indexOf('data-cleanup-action="unknown_senders"');
    const button = markup.slice(markup.lastIndexOf("<button", start), markup.indexOf("</button>", start));
    expect(start).toBeGreaterThan(0);
    expect(button).toContain("Review");
    expect(button).not.toContain('aria-disabled="true"');
    expect(button).toContain("get an authoritative preview");
  });
});

test("responsive CSS has the three-pane, compact split, and single-route spines", async () => {
  const css = await readFile(new URL("../src/mail_ui.scss", import.meta.url), "utf8");
  expect(css).toContain('grid-template-areas: "rail list content"');
  expect(css).toContain("@media (max-width: 899px)");
  expect(css).toContain('"list content"');
  expect(css).toContain("@media (max-width: 619px)");
  expect(css).toContain(".mail-mobile-back {");
  expect(css).toContain(".mail-ui:not(.mail-ui--route-list) .mail-mobile-back {");
  expect(css).not.toContain(".mail-mobile-back.mail-icon-button");
  expect(css).toContain(".mail-ui--route-list .mail-content-pane");
  expect(css).toContain(".mail-ui:not(.mail-ui--route-list) .mail-list-pane");
  expect(css).toContain("overscroll-behavior: contain");
});

test("composer and confirmations stay inside the sandbox-safe app UI", async () => {
  const [ui, rotation, app, css] = await Promise.all([
    readFile(new URL("../src/mail_ui.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/mail_key_rotation_ui.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/mail_app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/mail_ui.scss", import.meta.url), "utf8"),
  ]);
  expect(ui).not.toContain("<form");
  expect(app).not.toContain("beforeunload");
  expect(`${ui}\n${app}`).not.toMatch(/\b(?:confirm|alert|prompt)\s*\(/u);
  expect(`${ui}\n${rotation}`).not.toMatch(
    /mail-(?:primary|secondary|danger|action)-button/u,
  );
  expect(css).not.toMatch(/\.mail-(?:primary|secondary|danger|action)-button/u);
  expect(app).toContain('className="nt-app mail-tray"');
});
