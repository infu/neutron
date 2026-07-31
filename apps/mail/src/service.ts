import {
  exposeTool,
  setTrayState,
  type JsonObject,
} from "neutron-tools/app";
import { getMailBackendPulse } from "./backend.ts";
import {
  MAIL_HELP_TOPICS,
  getMailHelp,
  isMailHelpTopic,
} from "./help.ts";
import {
  MAIL_STATUS_OUTPUT_SCHEMA,
  projectMailStatusTool,
} from "./status_tool.ts";
import { exposeMailAgentTools } from "./agent_tools.ts";
import {
  createMailScopedBackend,
  mailComposeBackendPort,
  mailPrivateBackendPort,
} from "./agent_scoped_backend.ts";
import { MailCryptoWorkerClient } from "./crypto_worker_client.ts";
import {
  MAIL_CRYPTO_SESSION_TOOL,
  MailCryptoResidentSession,
  assertMailCryptoTrayCaller,
  assertMailCryptoTileCaller,
} from "./mail_crypto_session.ts";
import {
  MAIL_PRIVATE_GET_TOOL,
  MAIL_PRIVATE_LIST_TOOL,
  MAIL_PRIVATE_SEARCH_TOOL,
  MailPrivateResidentProjection,
  defaultMailPrivateDependencies,
} from "./mail_private.ts";
import {
  MAIL_PRIVATE_GET_OPTIONS,
  MAIL_PRIVATE_LIST_OPTIONS,
  MAIL_PRIVATE_SEARCH_OPTIONS,
  privateFailure,
} from "./mail_private_client.ts";
import type { MailFolder } from "./model.ts";
import {
  MAIL_PRIVATE_RETRY_TOOL,
  MAIL_PRIVATE_ACCESS_PREPARE_TOOL,
  MAIL_PRIVATE_SEND_TOOL,
  MAIL_PRIVATE_SETTINGS_GET_TOOL,
  MAIL_PRIVATE_SETTINGS_SET_TOOL,
  MailComposeResidentWorkflow,
  defaultMailComposeDependencies,
  type MailComposeRecipient,
  type MailPrivateSendRequest,
} from "./mail_compose.ts";
import {
  MAIL_PRIVATE_RETRY_OPTIONS,
  MAIL_PRIVATE_ACCESS_PREPARE_OPTIONS,
  MAIL_PRIVATE_SEND_OPTIONS,
  MAIL_PRIVATE_SETTINGS_GET_OPTIONS,
  MAIL_PRIVATE_SETTINGS_SET_OPTIONS,
  composeFailure,
} from "./mail_compose_client.ts";
import { parseMailDeliveryAccessPreparation } from "./mail_delivery_access.ts";
import { MailTrayResidentProjection, MAIL_TRAY_PROJECTION_TOOL } from "./mail_tray_projection.ts";
import { MAIL_TRAY_PROJECTION_OPTIONS } from "./mail_tray_client.ts";
import { mailBadgePollDelay } from "./mail_badge.ts";
import {
  MAIL_CRYPTO_MIGRATE_TOOL,
  MailRotationResidentWorkflow,
  defaultMailRotationDependencies,
} from "./mail_rotation.ts";
import {
  MAIL_CRYPTO_MIGRATE_OPTIONS,
  mailRotationFailure,
} from "./mail_rotation_client.ts";
import { bindMailInactivityCleanup } from "./mail_inactivity.ts";

const stringArraySchema: JsonObject = {
  type: "array",
  maxItems: 12,
  items: { type: "string", maxLength: 500 },
};

const nullableDecimalSchema: JsonObject = {
  oneOf: [
    { type: "string", pattern: "^0$|^[1-9][0-9]*$", maxLength: 20 },
    { type: "null" },
  ],
};

const cryptoSessionSchema: JsonObject = {
  type: "object",
  required: [
    "version",
    "lockState",
    "currentEpoch",
    "previousEpoch",
    "currentUnlocked",
    "previousUnlocked",
    "inactivityExpiresAt",
  ],
  properties: {
    version: { type: "number", enum: [1] },
    lockState: {
      type: "string",
      enum: ["not_configured", "locked", "unlocked"],
    },
    currentEpoch: nullableDecimalSchema,
    previousEpoch: nullableDecimalSchema,
    currentUnlocked: { type: "boolean" },
    previousUnlocked: { type: "boolean" },
    inactivityExpiresAt: nullableDecimalSchema,
  },
  additionalProperties: false,
};

// The resident owns the only crypto worker. A tile or tray never constructs a
// key-bearing runtime of its own. Key recovery is automatic, source-bound, and
// private to this resident; tools receive plaintext only after kernel routing.
const cryptoWorker = new MailCryptoWorkerClient();
const cryptoSession = new MailCryptoResidentSession(cryptoWorker);
const privateMail = new MailPrivateResidentProjection(
  defaultMailPrivateDependencies({ session: cryptoSession, worker: cryptoWorker }),
);
const composeMail = new MailComposeResidentWorkflow(
  defaultMailComposeDependencies({ session: cryptoSession, worker: cryptoWorker }),
);
const trayMail = new MailTrayResidentProjection({ session: cryptoSession, privateMail });
const rotationMail = new MailRotationResidentWorkflow(
  defaultMailRotationDependencies({
    session: { status: () => cryptoSession.ensureCurrentAndPrevious() },
    worker: cryptoWorker,
  }),
);

exposeTool(
  MAIL_CRYPTO_SESSION_TOOL,
  {
    title: "Prepare Private Mail",
    description:
      "Internal same-app readiness check. The resident recovers its app-isolated key automatically and returns no key material.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: cryptoSessionSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async (_args, context) => {
    assertMailCryptoTileCaller(context.caller);
    return cryptoSession.status();
  },
);

exposeTool(
  MAIL_PRIVATE_LIST_TOOL,
  MAIL_PRIVATE_LIST_OPTIONS,
  async (args, context) => {
    try {
      assertMailCryptoTileCaller(context.caller);
      const folder = privateFolder(args.folder);
      const page = await privateMail.list({
        folder,
        unreadOnly: privateBoolean(args.unreadOnly),
        offset: privateDecimal(args.offset, true),
        limit: privateLimit(args.limit),
        expectedRevision: privateNullableDecimal(args.expectedRevision),
        expectedContactsRevision: privateNullableDecimal(args.expectedContactsRevision),
      });
      queueTrayBadgeRefresh();
      return { ok: true, page } as unknown as JsonObject;
    } catch (error) {
      return privateFailure(error);
    }
  },
);

exposeTool(
  MAIL_PRIVATE_GET_TOOL,
  MAIL_PRIVATE_GET_OPTIONS,
  async (args, context) => {
    try {
      assertMailCryptoTileCaller(context.caller);
      const message = await privateMail.get(
        privateFolder(args.folder),
        privateDecimal(args.localId, false),
      );
      return { ok: true, message } as unknown as JsonObject;
    } catch (error) {
      return privateFailure(error);
    }
  },
);

exposeTool(
  MAIL_PRIVATE_SEARCH_TOOL,
  MAIL_PRIVATE_SEARCH_OPTIONS,
  async (args, context) => {
    try {
      assertMailCryptoTileCaller(context.caller);
      if (typeof args.query !== "string") throw new Error("Invalid Mail search");
      const search = await privateMail.search(
        privateFolder(args.folder),
        args.query,
        privateLimit(args.limit),
      );
      return { ok: true, search } as unknown as JsonObject;
    } catch (error) {
      return privateFailure(error);
    }
  },
);

exposeTool(
  MAIL_TRAY_PROJECTION_TOOL,
  MAIL_TRAY_PROJECTION_OPTIONS,
  async (args, context) => {
    assertMailCryptoTrayCaller(context.caller);
    return await trayMail.snapshot({
      expectedRevision: privateDecimal(args.expectedRevision, true),
      expectedContactsRevision: privateDecimal(args.expectedContactsRevision, true),
    }) as unknown as JsonObject;
  },
);

exposeTool(
  MAIL_CRYPTO_MIGRATE_TOOL,
  MAIL_CRYPTO_MIGRATE_OPTIONS,
  async (_args, context) => {
    try {
      assertMailCryptoTileCaller(context.caller);
      const step = await rotationMail.migrateStep();
      if (step.changed !== "0") privateMail.clear();
      return { ok: true, step } as unknown as JsonObject;
    } catch (error) {
      return mailRotationFailure(error);
    }
  },
);

exposeTool(
  MAIL_PRIVATE_ACCESS_PREPARE_TOOL,
  MAIL_PRIVATE_ACCESS_PREPARE_OPTIONS,
  async (args, context) => {
    try {
      assertMailCryptoTileCaller(context.caller);
      const accessRequest = await composeMail.prepareDeliveryAccess(privateSendRequest(args));
      return { ok: true, accessRequest } as unknown as JsonObject;
    } catch (error) {
      return composeFailure(error);
    }
  },
);

exposeTool(
  MAIL_PRIVATE_SEND_TOOL,
  MAIL_PRIVATE_SEND_OPTIONS,
  async (args, context) => {
    try {
      assertMailCryptoTileCaller(context.caller);
      const delivery = await composeMail.send(privateSendRequest(args));
      privateMail.clear();
      queueTrayBadgeRefresh();
      return { ok: true, delivery } as unknown as JsonObject;
    } catch (error) {
      return composeFailure(error);
    }
  },
);

exposeTool(
  MAIL_PRIVATE_RETRY_TOOL,
  MAIL_PRIVATE_RETRY_OPTIONS,
  async (args, context) => {
    try {
      assertMailCryptoTileCaller(context.caller);
      const delivery = await composeMail.retry(privateDecimal(args.localId, false));
      privateMail.clear();
      queueTrayBadgeRefresh();
      return { ok: true, delivery } as unknown as JsonObject;
    } catch (error) {
      return composeFailure(error);
    }
  },
);

exposeTool(
  MAIL_PRIVATE_SETTINGS_GET_TOOL,
  MAIL_PRIVATE_SETTINGS_GET_OPTIONS,
  async (_args, context) => {
    try {
      assertMailCryptoTileCaller(context.caller);
      return { ok: true, settings: await composeMail.getSettings() } as unknown as JsonObject;
    } catch (error) {
      return composeFailure(error);
    }
  },
);

exposeTool(
  MAIL_PRIVATE_SETTINGS_SET_TOOL,
  MAIL_PRIVATE_SETTINGS_SET_OPTIONS,
  async (args, context) => {
    try {
      assertMailCryptoTileCaller(context.caller);
      if (typeof args.senderName !== "string") throw new Error("Invalid sender name");
      const settings = await composeMail.setSenderName(args.senderName);
      return { ok: true, settings } as unknown as JsonObject;
    } catch (error) {
      return composeFailure(error);
    }
  },
);

exposeTool(
  "mail_help",
  {
    title: "Mail Help",
    description:
      "Explain private Neutron Mail, Markdown links, trust, limits, agent safety, and closed error states. This performs no mail operation.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: [...MAIL_HELP_TOPICS] },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["topic", "title", "summary", "points", "examples"],
      properties: {
        topic: { type: "string", enum: [...MAIL_HELP_TOPICS] },
        title: { type: "string", maxLength: 120 },
        summary: { type: "string", maxLength: 500 },
        points: stringArraySchema,
        examples: stringArraySchema,
      },
      additionalProperties: false,
    },
    annotations: { "neutron:effects": ["read"] },
  },
  async (args) => {
    const topic = args.topic ?? "overview";
    if (!isMailHelpTopic(topic)) throw new Error("Unknown Mail help topic");
    return getMailHelp(topic) as unknown as JsonObject;
  },
);

exposeTool(
  "mail_status",
  {
    title: "Mail Status",
    description:
      "Read private Mail setup, private-content availability, unread count, delivery activity, and bounded ciphertext storage usage. This never returns message plaintext or key material.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: MAIL_STATUS_OUTPUT_SCHEMA,
    annotations: { "neutron:effects": ["read"] },
  },
  async (_args, context) => {
    const scoped = createMailScopedBackend(context.kernel);
    const status = await scoped.status();
    let privateMailState: "not_configured" | "preparing" | "ready" | "unavailable" =
      status.privateMailActive ? "preparing" : "not_configured";
    if (status.privateMailActive) {
      try {
        const session = await cryptoSession.observeLocal(await scoped.cryptoStatus());
        if (
          session.currentUnlocked &&
          session.currentEpoch === status.currentEpoch
        ) privateMailState = "ready";
      } catch {
        privateMailState = "unavailable";
      }
    }
    return projectMailStatusTool(status, privateMailState) as unknown as JsonObject;
  },
);

let lastBadge: number | null = null;
let refreshRunning = false;
let consecutiveBadgeFailures = 0;
let badgePollTimer: number | null = null;

async function refreshTrayBadge(): Promise<void> {
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    const pulse = await getMailBackendPulse();
    const unread = Number(BigInt(pulse.unread));
    const badge = unread > 0 ? unread : null;
    if (badge !== lastBadge) {
      await setTrayState({ badge });
      lastBadge = badge;
    }
    consecutiveBadgeFailures = 0;
  } catch {
    // Keep the last authoritative badge during transient backend errors.
    consecutiveBadgeFailures += 1;
  } finally {
    refreshRunning = false;
  }
}

function scheduleTrayBadgePoll(): void {
  if (badgePollTimer !== null) window.clearTimeout(badgePollTimer);
  badgePollTimer = window.setTimeout(() => {
    badgePollTimer = null;
    queueTrayBadgeRefresh();
  }, mailBadgePollDelay(consecutiveBadgeFailures));
}

function queueTrayBadgeRefresh(): void {
  void refreshTrayBadge().finally(scheduleTrayBadgePoll);
}

const agentTools = exposeMailAgentTools({
  status: (context) => createMailScopedBackend(context.kernel).status(),
  privateList: async (request, context) => {
    const scoped = createMailScopedBackend(context.kernel);
    const session = {
      status: async () => cryptoSession.statusLocal(await scoped.cryptoStatus()),
    };
    return privateMail.list(request, mailPrivateBackendPort(scoped), session);
  },
  privateGet: async (folder, localId, context) => {
    const scoped = createMailScopedBackend(context.kernel);
    const session = {
      status: async () => cryptoSession.statusLocal(await scoped.cryptoStatus()),
    };
    return privateMail.get(folder, localId, mailPrivateBackendPort(scoped), session);
  },
  send: async (request, context) => {
    const scoped = createMailScopedBackend(context.kernel);
    const session = {
      status: async () => cryptoSession.statusLocal(await scoped.cryptoStatus()),
    };
    return composeMail.send(request, mailComposeBackendPort(scoped), session);
  },
  retry: async (localId, context) => {
    const scoped = createMailScopedBackend(context.kernel);
    return composeMail.retry(localId, mailComposeBackendPort(scoped));
  },
  getSettings: async (context) => {
    const scoped = createMailScopedBackend(context.kernel);
    const session = {
      status: async () => cryptoSession.statusLocal(await scoped.cryptoStatus()),
    };
    return composeMail.getSettings(mailComposeBackendPort(scoped), session);
  },
  setSenderName: async (senderName, context) => {
    const scoped = createMailScopedBackend(context.kernel);
    const session = {
      status: async () => cryptoSession.statusLocal(await scoped.cryptoStatus()),
    };
    return composeMail.setSenderName(
      senderName,
      mailComposeBackendPort(scoped),
      session,
    );
  },
  afterMutation: () => {
    privateMail.clear();
    queueTrayBadgeRefresh();
  },
});
const unbindInactivityCleanup = bindMailInactivityCleanup({
  worker: cryptoWorker,
  session: cryptoSession,
  privateProjections: [
    privateMail,
    { clear: agentTools.clearPrivateCache },
  ],
  rotation: rotationMail,
});

window.addEventListener("pagehide", () => {
  if (badgePollTimer !== null) window.clearTimeout(badgePollTimer);
  unbindInactivityCleanup();
  privateMail.clear();
  agentTools();
  rotationMail.reset();
  cryptoWorker.close();
}, { once: true });

queueTrayBadgeRefresh();

function privateFolder(value: unknown): MailFolder {
  if (value !== "inbox" && value !== "sent" && value !== "outbox") {
    throw new Error("Invalid Mail folder");
  }
  return value;
}

function privateSendRequest(value: JsonObject): MailPrivateSendRequest {
  const approvedPreparation = value.approvedPreparation === undefined
    ? undefined
    : parseMailDeliveryAccessPreparation(value.approvedPreparation);
  if (value.kind === "new") {
    privateExactKeys(value, [
      "kind", "commandId", "recipient", "subject", "bodyMarkdown",
      ...(approvedPreparation === undefined ? [] : ["approvedPreparation"]),
    ]);
    if (typeof value.subject !== "string" || typeof value.bodyMarkdown !== "string") {
      throw new Error("Invalid Mail draft");
    }
    const request = {
      kind: "new",
      commandId: privateCommandId(value.commandId),
      recipient: privateRecipient(value.recipient),
      subject: value.subject,
      bodyMarkdown: value.bodyMarkdown,
    } as const;
    return approvedPreparation === undefined
      ? request
      : {
          ...request,
          approvedPreparation: value.approvedPreparation as NonNullable<MailPrivateSendRequest["approvedPreparation"]>,
        };
  }
  if (value.kind === "reply") {
    privateExactKeys(value, [
      "kind", "commandId", "replyTo", "subject", "bodyMarkdown",
      ...(approvedPreparation === undefined ? [] : ["approvedPreparation"]),
    ]);
    if (typeof value.subject !== "string" || typeof value.bodyMarkdown !== "string") {
      throw new Error("Invalid Mail draft");
    }
    const reply = privateObject(value.replyTo);
    privateExactKeys(reply, ["folder", "localId"]);
    if (reply.folder !== "inbox") throw new Error("Invalid Mail reply source");
    const request = {
      kind: "reply",
      commandId: privateCommandId(value.commandId),
      replyTo: { folder: "inbox", localId: privateDecimal(reply.localId, false) },
      subject: value.subject,
      bodyMarkdown: value.bodyMarkdown,
    } as const;
    return approvedPreparation === undefined
      ? request
      : {
          ...request,
          approvedPreparation: value.approvedPreparation as NonNullable<MailPrivateSendRequest["approvedPreparation"]>,
        };
  }
  throw new Error("Invalid Mail send kind");
}

function privateCommandId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value) || /^0+$/u.test(value)) {
    throw new Error("Invalid Mail command id");
  }
  return value;
}

function privateRecipient(value: unknown): MailComposeRecipient {
  const recipient = privateObject(value);
  if (recipient.kind === "direct") {
    privateExactKeys(recipient, ["kind", "principal"]);
    if (typeof recipient.principal !== "string") throw new Error("Invalid Mail recipient");
    return { kind: "direct", principal: recipient.principal };
  }
  if (recipient.kind === "contact") {
    privateExactKeys(recipient, [
      "kind",
      "principal",
      "contactId",
      "expectedContactRevision",
    ]);
    if (typeof recipient.principal !== "string") throw new Error("Invalid Mail recipient");
    return {
      kind: "contact",
      principal: recipient.principal,
      contactId: privateDecimal(recipient.contactId, false),
      expectedContactRevision: privateDecimal(recipient.expectedContactRevision, false),
    };
  }
  throw new Error("Invalid Mail recipient");
}

function privateObject(value: unknown): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error("Invalid private Mail object");
  return value as JsonObject;
}

function privateExactKeys(value: JsonObject, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw new Error("Invalid private Mail fields");
  }
}

function privateBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid Mail filter");
  return value;
}

function privateDecimal(value: unknown, allowZero: boolean): string {
  if (
    typeof value !== "string" ||
    !(allowZero ? /^(0|[1-9][0-9]*)$/u : /^[1-9][0-9]*$/u).test(value) ||
    value.length > 20
  ) {
    throw new Error("Invalid Mail decimal");
  }
  return value;
}

function privateNullableDecimal(value: unknown): string | null {
  return value === null ? null : privateDecimal(value, true);
}

function privateLimit(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 50) {
    throw new Error("Invalid Mail limit");
  }
  return value as number;
}
