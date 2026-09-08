import { Principal } from "@dfinity/principal";
import type { ChatVM, MessageImageVM, MessagePreview, MessageVM } from "../shared/protocol.ts";

// Defensive decoding of OpenChat msgpack records into JSON-safe view models.
// msgpack replies are plain JS values; we read only the fields we render and
// degrade gracefully if a field is absent, so protocol additions never crash
// the client.

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (isRec(v) ? v : {});
function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// serde externally-tagged enums over msgpack: a *unit* variant (no payload) is
// encoded as a bare string (e.g. "NotFound"), while a variant with data is a
// single-key map (e.g. { Success: {...} }). These helpers read either form so
// `"Tag" in value` never throws on a unit-variant string.
export function variantTag(v: unknown): string {
  if (typeof v === "string") return v;
  if (isRec(v)) return Object.keys(v)[0] ?? "";
  return "";
}
export function variantIs(v: unknown, tag: string): boolean {
  return typeof v === "string" ? v === tag : isRec(v) && tag in v;
}
export function variantPayload(v: unknown, tag: string): Rec {
  return isRec(v) && isRec(v[tag]) ? (v[tag] as Rec) : {};
}
/** The raw payload of a data variant, whatever its shape (array, string, …). */
export function variantValue(v: unknown, tag: string): unknown {
  return isRec(v) ? v[tag] : undefined;
}

// OpenChat's OCError is a serde tuple struct `OCError(u16, Option<String>)`, so
// over msgpack it is the array [code, message?] — not a { code, message } map.
export function parseOcError(v: unknown): { code: number; message: string } {
  if (Array.isArray(v)) {
    return { code: num(v[0]), message: typeof v[1] === "string" ? v[1] : "" };
  }
  if (isRec(v)) return { code: num(v.code), message: str(v.message) };
  return { code: 0, message: "" };
}

// The subset of OpenChat error codes (backend/libraries/error_codes) most likely
// to surface from join / register / send, mapped to plain language.
const OC_ERROR_NAMES: Record<number, string> = {
  0: "Unknown error",
  100: "Your account wasn't found",
  101: "Not authorized",
  102: "Your account is suspended",
  103: "You're not in this chat",
  104: "You're not in this community",
  105: "Your membership has lapsed",
  106: "You're blocked from this chat",
  200: "Group not found",
  202: "Community not found",
  210: "Invalid request",
  224: "Already registered",
  233: "This chat is frozen",
  234: "This community is frozen",
  239: "Member limit reached",
  253: "Requires Diamond membership",
  257: "OpenChat is temporarily low on cycles",
  269: "You need an invite to join",
  282: "You must accept the community rules first",
  283: "You must accept the chat rules first",
  296: "This chat is full",
  305: "This chat isn't public",
  320: "Rate limited — try again shortly",
  500: "OpenChat internal error (inter-canister call failed)",
  600: "Unexpected OpenChat error",
};

export function ocErrorMessage(v: unknown): string {
  const { code, message } = parseOcError(v);
  return message || OC_ERROR_NAMES[code] || `OpenChat error ${code}`;
}
export function ocErrorCode(v: unknown): number {
  return parseOcError(v).code;
}

export function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return Uint8Array.from(v as number[]);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

export function principalText(v: unknown): string | null {
  const b = asBytes(v);
  if (!b) return null;
  try {
    return Principal.fromUint8Array(b).toText();
  } catch {
    return null;
  }
}

/**
 * The canister that holds a user's data. OpenChat may pack several users into a
 * single canister ("indexed" users): such a UserId is a canister id whose two
 * trailing class-tag bytes ([0x01, 0x01]) are overwritten by the user's index,
 * with the 0x80 top-bit set in the final byte — so it is deliberately NOT a
 * valid canister id. For those we restore the tag bytes to recover the holding
 * canister. Every ordinary UserId already equals its own canister id and is
 * returned unchanged: a real canister id always ends in a class tag (0x01..0x04)
 * whose top bit is clear, so this transform is a no-op for it. Use this whenever
 * addressing the user's OWN canister (initial_state, events, direct send); a
 * counterparty's UserId (a message key, not a canister address) stays raw.
 */
export function userCanisterId(userId: string): string {
  try {
    const bytes = Principal.fromText(userId).toUint8Array();
    if (bytes.length === 10 && (bytes[9]! & 0x80) !== 0) {
      const canister = new Uint8Array(10);
      canister.set(bytes.subarray(0, 8), 0);
      canister[8] = 0x01;
      canister[9] = 0x01;
      return Principal.fromUint8Array(canister).toText();
    }
  } catch {
    /* not a principal we can reshape — use as-is */
  }
  return userId;
}

export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Coerce a value that may be a bigint, a number, or a decimal string into a
 * bigint. OpenChat serializes u64/large ints as strings on the wire
 * (rmp_serde `with_large_ints_as_strings`), so fields like a delegation
 * expiration arrive as strings from the msgpack canisters.
 */
export function toBigInt(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  } catch {
    /* fall through */
  }
  return null;
}

export function bigintText(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Math.trunc(v).toString();
  if (typeof v === "string") return v;
  return "0";
}

export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Unwrap a serde `Option<T>` decoded as value | null | undefined | [] | [x]. */
function opt(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v.length > 0 ? v[0] : undefined;
  return v;
}

function shortId(id: string): string {
  return id.length > 15 ? `${id.slice(0, 12)}…` : id;
}

/** Extract `{text, kind}` from a MessageContent variant. */
export function contentText(content: unknown): { text: string; kind: string } {
  if (!isRec(content)) return { text: "", kind: "unknown" };
  const kind = Object.keys(content)[0] ?? "unknown";
  const body = rec(content[kind]);
  switch (kind) {
    case "Text":
      return { text: str(body.text), kind: "text" };
    case "Image":
    case "Video":
    case "Audio":
    case "File":
    case "Giphy": {
      const caption = str(opt(body.caption) as string, "");
      return { text: caption || `[${kind.toLowerCase()}]`, kind: kind.toLowerCase() };
    }
    case "Crypto":
      return { text: "[token transfer]", kind: "crypto" };
    case "Poll":
      return { text: "[poll]", kind: "poll" };
    case "Deleted":
      return { text: "[deleted]", kind: "deleted" };
    default:
      return { text: `[${kind.toLowerCase()}]`, kind: kind.toLowerCase() };
  }
}

/** Full-resolution blob URL on the IC http gateway (matches OpenChat's own
 *  BlobReference::blob_url — `https://<canister>.raw.icp0.io/files/<blobId>`). */
function blobUrl(blobReference: unknown): string | null {
  const ref = opt(blobReference);
  if (!isRec(ref)) return null;
  const canister = principalText(ref.canister_id);
  const blobId = ref.blob_id;
  if (!canister || blobId === undefined || blobId === null) return null;
  return `https://${canister}.raw.icp0.io/files/${bigintText(blobId)}`;
}

/** A renderable image for Image/Video content: the inline data-URL thumbnail
 *  (always safe to show) plus the full-res blob URL. Other kinds → null. */
export function messageImage(content: unknown): MessageImageVM | null {
  if (!isRec(content)) return null;
  const kind = Object.keys(content)[0] ?? "";
  if (kind !== "Image" && kind !== "Video") return null;
  const body = rec(content[kind]);
  // ThumbnailData is a newtype over String → a bare `data:image/...;base64,...`.
  const thumb = str(body.thumbnail_data);
  const full = blobUrl(kind === "Image" ? body.blob_reference : body.image_blob_reference);
  if (!thumb && !full) return null;
  return {
    thumbnailDataUrl: thumb && thumb.startsWith("data:") ? thumb : null,
    fullUrl: full,
    width: num(body.width),
    height: num(body.height),
  };
}

export function messagePreview(latest: unknown): MessagePreview | null {
  const wrapper = opt(latest);
  if (!isRec(wrapper)) return null;
  const event = rec(wrapper.event);
  const { text } = contentText(event.content);
  return {
    text,
    senderId: principalText(event.sender),
    timestampMs: num(wrapper.timestamp),
  };
}

export function unreadFrom(latestIndex: unknown, readUpTo: unknown): number {
  const latest = opt(latestIndex);
  const read = opt(readUpTo);
  if (latest === undefined) return 0;
  const l = num(latest);
  const r = read === undefined ? -1 : num(read);
  return Math.max(0, l - r);
}

export { shortId };

export function directChatVM(summary: Rec): ChatVM | null {
  const them = principalText(summary.them);
  if (!them) return null;
  return {
    id: `direct:${them}`,
    kind: "direct",
    title: shortId(them),
    subtitle: null,
    lastMessage: messagePreview(summary.latest_message),
    unread: unreadFrom(summary.latest_message_index, summary.read_by_me_up_to),
    lastUpdatedMs: num(summary.last_updated),
  };
}

// Total message volume of a channel from its ChatMetrics — a "most active by
// messages" score, not merely the freshest message. Falls back to the latest
// message index (≈ lifetime message count) when metrics are absent.
export function channelActivity(ch: Rec): number {
  const m = rec(ch.metrics);
  const counts = [
    m.text_messages, m.image_messages, m.video_messages, m.audio_messages, m.file_messages,
    m.polls, m.crypto_messages, m.giphy_messages, m.prize_messages, m.custom_type_messages,
  ];
  const total = counts.reduce((sum: number, v) => sum + num(v), 0);
  return total > 0 ? total : num(ch.latest_message_index);
}

/**
 * Choose a community's primary ("general") channel. OpenChat exposes no default
 * marker, so: pick the most active channel by message volume; if nothing has
 * any messages yet, prefer one literally named "general", else the first.
 * Returns its channel id, or null if the community has no channels.
 */
export function pickPrimaryChannel(channels: Rec[]): number | null {
  if (channels.length === 0) return null;
  let best: Rec | null = null;
  let bestScore = -1;
  for (const ch of channels) {
    const score = channelActivity(ch);
    if (score > bestScore) {
      best = ch;
      bestScore = score;
    }
  }
  if (best && bestScore > 0) return num(best.channel_id);
  const general = channels.find((ch) => str(ch.name).trim().toLowerCase() === "general");
  return num((general ?? channels[0]!).channel_id);
}

function messageVM(msg: Rec, timestampMs: number, myUserId: string | null): MessageVM | null {
  if (Object.keys(msg).length === 0) return null;
  const { text, kind } = contentText(msg.content);
  const senderId = principalText(msg.sender) ?? "";
  return {
    messageId: bigintText(msg.message_id),
    index: num(msg.message_index),
    senderId,
    senderName: null,
    senderAvatarUrl: null,
    text,
    contentKind: kind,
    image: messageImage(msg.content),
    timestampMs,
    mine: myUserId !== null && senderId === myUserId,
    edited: msg.edited === true,
  };
}

export function messagesFromEvents(events: unknown, myUserId: string | null): MessageVM[] {
  if (!Array.isArray(events)) return [];
  const out: MessageVM[] = [];
  for (const raw of events) {
    const wrapper = rec(raw);
    // Events are EventWrapper<ChatEvent>: the inner `event` is the ChatEvent
    // enum, so a real message is `{ Message: {...} }` while system events are
    // other variants (e.g. bare "Empty", { ParticipantJoined: {...} }). Only
    // the Message variant carries a message.
    if (!variantIs(wrapper.event, "Message")) continue;
    const vm = messageVM(variantPayload(wrapper.event, "Message"), num(wrapper.timestamp), myUserId);
    if (vm) out.push(vm);
  }
  return out;
}

/** Full-resolution avatar URL on the IC http gateway for a user's own canister.
 *  Mirrors OpenChat's buildUserAvatarUrl: https://<userCanister>.raw.icp0.io/avatar/<id> */
export function userAvatarUrl(userId: string, avatarId: unknown): string | null {
  const id = toBigInt(avatarId);
  if (id === null) return null;
  return `https://${userCanisterId(userId)}.raw.icp0.io/avatar/${id.toString()}`;
}

/** Avatar URL for a group/community canister: https://<canister>.raw.icp0.io/avatar/<id> */
export function canisterAvatarUrl(canisterId: string, avatarId: unknown): string | null {
  const id = toBigInt(avatarId);
  if (id === null) return null;
  return `https://${canisterId}.raw.icp0.io/avatar/${id.toString()}`;
}

export type UserSummary = { userId: string; username: string; displayName: string | null; avatarUrl: string | null };

/** Parse the user_index `users` batch response (UserSummaryV2: user_id +
 *  nested `stable.{username, display_name, avatar_id}`) for the name/avatar cache. */
export function parseUserSummariesV2(resp: unknown): UserSummary[] {
  const users = variantPayload(resp, "Success").users;
  if (!Array.isArray(users)) return [];
  const out: UserSummary[] = [];
  for (const raw of users) {
    const u = rec(raw);
    const userId = principalText(u.user_id);
    if (!userId) continue;
    const stable = rec(opt(u.stable));
    const username = str(stable.username);
    if (!username) continue;
    const display = opt(stable.display_name);
    out.push({
      userId,
      username,
      displayName: typeof display === "string" ? display : null,
      avatarUrl: userAvatarUrl(userId, opt(stable.avatar_id)),
    });
  }
  return out;
}

export function whoAmIFromCurrentUser(resp: unknown): { userId?: string; username?: string; avatarUrl?: string } {
  const success = variantPayload(resp, "Success");
  const userId = principalText(success.user_id);
  const username = str(success.username);
  const out: { userId?: string; username?: string; avatarUrl?: string } = {};
  if (userId) out.userId = userId;
  if (username) out.username = username;
  const avatarUrl = userId ? userAvatarUrl(userId, opt(success.avatar_id)) : null;
  if (avatarUrl) out.avatarUrl = avatarUrl;
  return out;
}
