import type {
  FeedItem,
  NotificationItem,
  NotificationVerification,
  ProofState,
  PublishStage,
  SendQuote,
  VerificationState,
} from "./model.ts";

const NODE_ID_VISIBLE_HEAD = 8;
const NODE_ID_VISIBLE_TAIL = 5;
const TC_DIVISOR = 1_000_000_000_000n;
const TC_DECIMALS = 6;
const UTF8 = new TextEncoder();

export function shortenNodeId(nodeId: string): string {
  const clean = nodeId.trim();
  if (clean.length <= NODE_ID_VISIBLE_HEAD + NODE_ID_VISIBLE_TAIL + 1) {
    return clean;
  }
  return `${clean.slice(0, NODE_ID_VISIBLE_HEAD)}…${clean.slice(-NODE_ID_VISIBLE_TAIL)}`;
}

export function generatedAvatarText(nodeId: string): string {
  const alphanumeric = nodeId.replace(/[^a-z0-9]/giu, "").toUpperCase();
  return (alphanumeric.slice(0, 2) || "WN").padEnd(2, "N");
}

export function avatarHue(nodeId: string): number {
  let hash = 0;
  for (const character of nodeId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % 360;
}

export function profileMayRenderRemoteText(state: ProofState): boolean {
  return state === "fresh" || state === "stale";
}

export function feedMayRenderBody(state: VerificationState): boolean {
  return state === "verified";
}

export function safeFeedBody(item: FeedItem): string | null {
  if (
    !feedMayRenderBody(item.verification) ||
    item.promotion !== "committed"
  ) return null;
  return item.body;
}

export interface VerificationPresentation {
  label: string;
  detail: string;
  tone: "info" | "success" | "warning" | "danger" | "neutral";
  progress: number;
}

export function verificationPresentation(
  state: VerificationState,
): VerificationPresentation {
  switch (state) {
    case "candidate":
      return {
        label: "Candidate",
        detail: "Received locally. No remote content is shown until verification begins.",
        tone: "neutral",
        progress: 0,
      };
    case "fetching":
      return {
        label: "Fetching proof",
        detail: "Loading the immutable object from its certified Wagyu path.",
        tone: "info",
        progress: 20,
      };
    case "http-certified":
      return {
        label: "HTTP certified",
        detail: "The IC response is certified; its object digest is being checked.",
        tone: "info",
        progress: 45,
      };
    case "object-digest-valid":
      return {
        label: "Digest valid",
        detail: "Exact bytes match the certified digest; action semantics are being checked.",
        tone: "info",
        progress: 70,
      };
    case "action-body-valid":
      return {
        label: "Action valid",
        detail: "Author, IDs, path, and action body agree. Promoting locally.",
        tone: "info",
        progress: 90,
      };
    case "verified":
      return {
        label: "Verified",
        detail: "Certificate, path, headers, digest, and action body were verified.",
        tone: "success",
        progress: 100,
      };
    case "unavailable":
      return {
        label: "Unavailable",
        detail: "The certified object could not be loaded. Untrusted bytes remain hidden.",
        tone: "warning",
        progress: 0,
      };
    case "unverified":
      return {
        label: "Unverified",
        detail: "Proof verification could not complete. Remote content remains hidden.",
        tone: "warning",
        progress: 0,
      };
    case "invalid":
      return {
        label: "Quarantined",
        detail: "A proof, digest, path, or semantic binding failed. The bytes were rejected.",
        tone: "danger",
        progress: 0,
      };
    case "unsupported":
      return {
        label: "Unsupported",
        detail: "This row uses a protocol tag this version of Wagyu does not understand.",
        tone: "warning",
        progress: 0,
      };
  }
}

export function trustedActorLabel(item: NotificationItem): string {
  if (
    (item.verification === "verified" ||
      item.verification === "transport-authenticated") &&
    item.actorDisplayName &&
    profileMayRenderRemoteText(item.actorProfileProof)
  ) {
    return item.actorDisplayName;
  }
  return shortenNodeId(item.actorNodeId);
}

export function notificationCopy(item: NotificationItem): string {
  const actor = trustedActorLabel(item);
  switch (item.verification) {
    case "pending":
      return `Unverified activity from ${shortenNodeId(item.actorNodeId)}`;
    case "invalid":
      return `Invalid activity from ${shortenNodeId(item.actorNodeId)} was quarantined`;
    case "unavailable":
      return `Activity from ${shortenNodeId(item.actorNodeId)} is unavailable`;
    case "unsupported":
      return `Unsupported activity from ${shortenNodeId(item.actorNodeId)}`;
    case "transport-authenticated":
    case "verified":
      switch (item.kind) {
        case "follow":
          return `${actor} followed you`;
        case "like":
          return `${actor} liked your post`;
        case "reply":
          return `${actor} replied to your post`;
        case "share":
          return `${actor} shared your post`;
        case "unsupported":
          return `Unsupported activity from ${shortenNodeId(item.actorNodeId)}`;
      }
  }
}

export function notificationStateLabel(
  state: NotificationVerification,
): string {
  switch (state) {
    case "transport-authenticated":
      return "Caller authenticated";
    case "pending":
      return "Pending verification";
    case "verified":
      return "Verified";
    case "invalid":
      return "Quarantined";
    case "unavailable":
      return "Unavailable";
    case "unsupported":
      return "Unsupported";
  }
}

export function markdownByteLength(markdown: string): number {
  return UTF8.encode(markdown).byteLength;
}

export function formatCyclesAsTc(cycles: bigint): string {
  const whole = cycles / TC_DIVISOR;
  const remainder = cycles % TC_DIVISOR;
  if (remainder === 0n) return `${whole}.000000`;
  const scaled = ((remainder * 10n ** BigInt(TC_DECIMALS)) / TC_DIVISOR)
    .toString()
    .padStart(TC_DECIMALS, "0");
  return `${whole}.${scaled}`;
}

export function quoteRows(quote: SendQuote): Array<{
  label: string;
  value: string;
  emphasis?: boolean;
}> {
  const overhead =
    quote.callAndByteCycles +
    quote.localPublicationCycles;
  return [
    {
      label: "Follower Neutrons",
      value: quote.registeredFollowers.toLocaleString(),
    },
    {
      label: "Eligible recipients",
      value: quote.eligibleRecipients.toLocaleString(),
    },
    {
      label: "Receiver floors",
      value: `${formatCyclesAsTc(quote.receiverFloorCycles)} TC`,
    },
    ...(quote.authorNoticeFloorCycles > 0n
      ? [{
          label: "Remote author-notice floor",
          value: `${formatCyclesAsTc(quote.authorNoticeFloorCycles)} TC`,
        }]
      : []),
    {
      label: "Publication / calls",
      value: `${formatCyclesAsTc(overhead)} TC`,
    },
    {
      label: "Estimated total",
      value: `${formatCyclesAsTc(quote.totalCycles)} TC`,
      emphasis: true,
    },
  ];
}

export const PUBLISH_STAGES: readonly PublishStage[] = [
  "encoding",
  "publishing",
  "awaiting-proof",
  "certified-ref-ready",
  "fanout-queued",
  "sending",
  "complete",
];

export function publishStageRequiresOpenTile(stage: PublishStage): boolean {
  return (
    stage !== "draft" &&
    stage !== "fanout-queued" &&
    stage !== "complete" &&
    stage !== "partial" &&
    stage !== "failed" &&
    stage !== "uncertain"
  );
}

export function publishStageIsDurableHandoff(stage: PublishStage): boolean {
  return (
    stage === "fanout-queued" ||
    stage === "complete" ||
    stage === "partial"
  );
}

export function publishStageLabel(stage: PublishStage): string {
  switch (stage) {
    case "draft":
      return "Draft";
    case "encoding":
      return "Encoding exact Candid";
    case "publishing":
      return "Publishing certified action";
    case "awaiting-proof":
      return "Awaiting HTTP proof";
    case "certified-ref-ready":
      return "Certified reference ready";
    case "withdrawal-closing":
      return "Finishing Like archival";
    case "fanout-queued":
      return "Fanout queued";
    case "sending":
      return "Sending batches";
    case "complete":
      return "Complete";
    case "partial":
      return "Partially delivered";
    case "failed":
      return "Failed";
    case "uncertain":
      return "Delivery uncertain";
  }
}

export function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  return formatter.format(Math.round(seconds / 86_400), "day");
}
