import { Principal } from "@dfinity/principal";
import {
  equalBytes,
  requireBytes,
  sha256,
  u64be,
  utf8,
} from "./bytes.ts";
import { wagyuHash } from "./hash.ts";
import {
  confirmBrowserRasterDecode,
  inspectStaticRaster,
  type WagyuRasterBitmapDecoderV1,
  type WagyuRasterMediaTypeV1,
} from "./raster.ts";
import type { ActionKindV1 } from "./types.ts";

type PrincipalValue = string | Principal;

export interface ActionHeaderShapeV1 {
  readonly network_id: Uint8Array;
  readonly actor: PrincipalValue;
  readonly action_kind: unknown;
}

export interface PostBodyShapeV1 {
  readonly header: ActionHeaderShapeV1;
  readonly author_sequence: bigint;
  readonly nonce: Uint8Array;
  readonly created_at_ns: bigint;
  readonly body_markdown: string;
  readonly reply_to: unknown;
}

export interface CertifiedPostRefShapeV1 {
  readonly author: PrincipalValue;
  readonly post_id: Uint8Array;
  readonly body_hash: Uint8Array;
  readonly body_length: number | bigint;
  readonly object_digest: Uint8Array;
}

export interface ShareActionShapeV1 {
  readonly header: ActionHeaderShapeV1;
  readonly share_id: Uint8Array;
  readonly share_sequence: bigint;
  readonly issued_at_ns: bigint;
  readonly original_author: PrincipalValue;
  readonly original_post_id: Uint8Array;
  readonly original_body_hash: Uint8Array;
  readonly post_ref_digest: Uint8Array;
}

export interface CertifiedShareRefShapeV1 {
  readonly sharer: PrincipalValue;
  readonly share_id: Uint8Array;
  readonly body_length: number | bigint;
  readonly object_digest: Uint8Array;
}

export interface LikeActionShapeV1 {
  readonly header: ActionHeaderShapeV1;
  readonly like_id: Uint8Array;
  readonly issued_at_ns: bigint;
  readonly post_author: PrincipalValue;
  readonly post_id: Uint8Array;
  readonly post_body_hash: Uint8Array;
}

export interface TombstoneActionShapeV1 {
  readonly header: ActionHeaderShapeV1;
  readonly tombstone_id: Uint8Array;
  readonly author_sequence: bigint;
  readonly issued_at_ns: bigint;
  readonly post_id: Uint8Array;
  readonly post_body_hash: Uint8Array;
}

export interface CertifiedActionRefShapeV1 {
  readonly actor: PrincipalValue;
  readonly action_kind: unknown;
  readonly object_digest: Uint8Array;
  readonly body_length: number | bigint;
}

export interface ProfileShapeV1 {
  readonly network_id: Uint8Array;
  readonly node: PrincipalValue;
  readonly profile_generation: bigint;
  readonly revision: bigint;
  readonly updated_at_ns: bigint;
  readonly previous_profile_digest: unknown;
  readonly display_name: string;
  readonly description: string;
  readonly capabilities: unknown;
  readonly avatar: unknown;
}

export interface LikeHeadShapeV1 {
  readonly network_id: Uint8Array;
  readonly post_author: PrincipalValue;
  readonly post_id: Uint8Array;
  readonly post_body_hash: Uint8Array;
  readonly store_generation: bigint;
  readonly revision: bigint;
  readonly previous_head_hash: unknown;
  readonly latest_batch_number: unknown;
  readonly latest_batch_digest: unknown;
  readonly sealed_batch_count: bigint;
  readonly sealed_receipt_count: bigint;
  readonly accepting_likes: boolean;
}

export interface ReplyIndexShapeV1 {
  readonly network_id: Uint8Array;
  readonly post_author: PrincipalValue;
  readonly post_id: Uint8Array;
  readonly post_body_hash: Uint8Array;
  readonly store_generation: bigint;
  readonly revision: bigint;
  readonly previous_index_hash: unknown;
  readonly replies: readonly {
    readonly author: PrincipalValue;
    readonly post_id: Uint8Array;
    readonly object_digest: Uint8Array;
    readonly object_length: number | bigint;
    readonly received_at_ns: bigint;
  }[];
}

export interface SemanticActionContextV1 {
  readonly networkId: Uint8Array;
  readonly actor: string;
  readonly exactBody: Uint8Array;
}

export type StructurallyCheckedProfileAvatarV1 =
  | { readonly state: "absent" }
  | { readonly state: "unsupported" }
  | {
      readonly state: "decode-required";
      readonly mediaType: WagyuRasterMediaTypeV1;
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    };

export type VerifiedProfileAvatarV1 =
  | { readonly state: "absent" }
  | { readonly state: "unsupported" }
  | {
      readonly state: "verified";
      readonly mediaType: WagyuRasterMediaTypeV1;
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    };

export function assertConfiguredNetworkId(value: Uint8Array): Uint8Array {
  const networkId = requireBytes(value, "Trusted network ID", 32);
  if (networkId.every((byte) => byte === 0)) {
    throw new Error("Trusted network ID is unconfigured");
  }
  return networkId;
}

export function validateActionHeader(
  header: ActionHeaderShapeV1,
  expected: {
    readonly networkId: Uint8Array;
    readonly actor: string;
    readonly kind: ActionKindV1;
  },
): void {
  const networkId = assertConfiguredNetworkId(expected.networkId);
  if (!equalBytes(requireBytes(header.network_id, "Action network ID", 32), networkId)) {
    throw new Error("Action network ID does not match trusted configuration");
  }
  if (principalText(header.actor) !== canonicalPrincipalText(expected.actor, true)) {
    throw new Error("Action actor does not match the serving node");
  }
  if (knownActionKind(header.action_kind) !== expected.kind) {
    throw new Error("Action kind does not match its path/ref");
  }
}

export async function validatePostSemantics(
  body: PostBodyShapeV1,
  ref: CertifiedPostRefShapeV1,
  context: SemanticActionContextV1,
): Promise<{ readonly bodyHash: Uint8Array; readonly postId: Uint8Array; readonly objectDigest: Uint8Array }> {
  validateActionHeader(body.header, {
    networkId: context.networkId,
    actor: context.actor,
    kind: "post",
  });
  validateNat64(body.author_sequence, "Author sequence");
  validateNat64(body.created_at_ns, "Post creation time");
  requireBytes(body.nonce, "Post nonce", 16);
  validatePlainText(body.body_markdown, "Post body", 8 * 1_024);
  validateReplyLocator(optional(body.reply_to));

  const actor = canonicalPrincipalText(context.actor, true);
  if (principalText(ref.author) !== actor) {
    throw new Error("Post ref author does not match its action");
  }
  assertBodyLength(ref.body_length, context.exactBody.byteLength);
  const objectDigest = await sha256(context.exactBody);
  if (!equalBytes(requireBytes(ref.object_digest, "Post object digest", 32), objectDigest)) {
    throw new Error("Post ref digest does not match exact Candid bytes");
  }
  const bodyHash = await wagyuHash("wagyu.post-body.v1", context.exactBody);
  if (!equalBytes(requireBytes(ref.body_hash, "Post body hash", 32), bodyHash)) {
    throw new Error("Post body hash does not match exact Candid bytes");
  }
  const postId = await wagyuHash(
    "wagyu.post-id.v1",
    assertConfiguredNetworkId(context.networkId),
    principalBytes(actor),
    bodyHash,
  );
  if (!equalBytes(requireBytes(ref.post_id, "Post ID", 32), postId)) {
    throw new Error("Post ID does not match its semantic preimage");
  }
  return { bodyHash, postId, objectDigest };
}

export async function validateShareSemantics(
  body: ShareActionShapeV1,
  ref: CertifiedShareRefShapeV1,
  context: SemanticActionContextV1,
): Promise<{ readonly shareId: Uint8Array; readonly objectDigest: Uint8Array }> {
  validateActionHeader(body.header, {
    networkId: context.networkId,
    actor: context.actor,
    kind: "share",
  });
  validateNat64(body.share_sequence, "Share sequence");
  validateNat64(body.issued_at_ns, "Share issue time");
  const actor = canonicalPrincipalText(context.actor, true);
  const originalAuthor = principalText(body.original_author);
  const postId = requireBytes(body.original_post_id, "Original post ID", 32);
  requireBytes(body.original_body_hash, "Original post body hash", 32);
  requireBytes(body.post_ref_digest, "Post ref digest", 32);
  if (principalText(ref.sharer) !== actor) {
    throw new Error("Share ref actor does not match its action");
  }
  assertBodyLength(ref.body_length, context.exactBody.byteLength);
  const objectDigest = await sha256(context.exactBody);
  if (!equalBytes(requireBytes(ref.object_digest, "Share object digest", 32), objectDigest)) {
    throw new Error("Share ref digest does not match exact Candid bytes");
  }
  const shareId = await wagyuHash(
    "wagyu.share-id.v1",
    assertConfiguredNetworkId(context.networkId),
    principalBytes(actor),
    principalBytes(originalAuthor),
    postId,
  );
  if (
    !equalBytes(requireBytes(body.share_id, "Share ID", 32), shareId) ||
    !equalBytes(requireBytes(ref.share_id, "Share ref ID", 32), shareId)
  ) {
    throw new Error("Share ID does not match its semantic preimage");
  }
  return { shareId, objectDigest };
}

export async function validateLikeSemantics(
  body: LikeActionShapeV1,
  ref: CertifiedActionRefShapeV1,
  context: SemanticActionContextV1,
): Promise<{ readonly likeId: Uint8Array; readonly objectDigest: Uint8Array }> {
  validateActionHeader(body.header, {
    networkId: context.networkId,
    actor: context.actor,
    kind: "like",
  });
  validateNat64(body.issued_at_ns, "Like issue time");
  const actor = canonicalPrincipalText(context.actor, true);
  const postAuthor = principalText(body.post_author);
  const postId = requireBytes(body.post_id, "Liked post ID", 32);
  requireBytes(body.post_body_hash, "Liked post body hash", 32);
  validateGenericActionRef(ref, actor, "like", context.exactBody);
  const objectDigest = await sha256(context.exactBody);
  if (!equalBytes(ref.object_digest, objectDigest)) {
    throw new Error("Like ref digest does not match exact Candid bytes");
  }
  const likeId = await wagyuHash(
    "wagyu.like-id.v1",
    assertConfiguredNetworkId(context.networkId),
    principalBytes(actor),
    principalBytes(postAuthor),
    postId,
  );
  if (!equalBytes(requireBytes(body.like_id, "Like ID", 32), likeId)) {
    throw new Error("Like ID does not match its semantic preimage");
  }
  return { likeId, objectDigest };
}

export async function validateTombstoneSemantics(
  body: TombstoneActionShapeV1,
  ref: CertifiedActionRefShapeV1,
  context: SemanticActionContextV1,
): Promise<{ readonly tombstoneId: Uint8Array; readonly objectDigest: Uint8Array }> {
  validateActionHeader(body.header, {
    networkId: context.networkId,
    actor: context.actor,
    kind: "tombstone",
  });
  validateNat64(body.author_sequence, "Tombstone author sequence");
  validateNat64(body.issued_at_ns, "Tombstone issue time");
  const actor = canonicalPrincipalText(context.actor, true);
  const postId = requireBytes(body.post_id, "Withdrawn post ID", 32);
  requireBytes(body.post_body_hash, "Withdrawn post body hash", 32);
  validateGenericActionRef(ref, actor, "tombstone", context.exactBody);
  const objectDigest = await sha256(context.exactBody);
  if (!equalBytes(ref.object_digest, objectDigest)) {
    throw new Error("Tombstone ref digest does not match exact Candid bytes");
  }
  const tombstoneId = await wagyuHash(
    "wagyu.tombstone-id.v1",
    assertConfiguredNetworkId(context.networkId),
    principalBytes(actor),
    postId,
    u64be(body.author_sequence),
  );
  if (!equalBytes(requireBytes(body.tombstone_id, "Tombstone ID", 32), tombstoneId)) {
    throw new Error("Tombstone ID does not match its semantic preimage");
  }
  return { tombstoneId, objectDigest };
}

function validateGenericActionRef(
  ref: CertifiedActionRefShapeV1,
  actor: string,
  kind: ActionKindV1,
  exactBody: Uint8Array,
): void {
  if (principalText(ref.actor) !== actor || knownActionKind(ref.action_kind) !== kind) {
    throw new Error("Action ref actor/kind does not match its body");
  }
  assertBodyLength(ref.body_length, exactBody.byteLength);
  requireBytes(ref.object_digest, "Action object digest", 32);
}

export function validateProfileSemantics(
  profile: ProfileShapeV1,
  expected: {
    readonly networkId: Uint8Array;
    readonly node: string;
  },
): {
  readonly avatar: StructurallyCheckedProfileAvatarV1;
} {
  if (
    !equalBytes(
      requireBytes(profile.network_id, "Profile network ID", 32),
      assertConfiguredNetworkId(expected.networkId),
    )
  ) {
    throw new Error("Profile network ID does not match trusted configuration");
  }
  if (principalText(profile.node) !== canonicalPrincipalText(expected.node, true)) {
    throw new Error("Profile node does not match the serving canister");
  }
  validateNat64(profile.profile_generation, "Profile generation");
  validateNat64(profile.revision, "Profile revision");
  validateNat64(profile.updated_at_ns, "Profile update time");
  const previous = optional(profile.previous_profile_digest);
  if (previous !== null) requireBytes(previous, "Previous profile digest", 32);
  validatePlainText(profile.display_name, "Display name", 80);
  validatePlainText(profile.description, "Profile description", 1_024);
  validateCapabilities(optional(profile.capabilities));
  return { avatar: validateAvatar(optional(profile.avatar)) };
}

export async function confirmProfileAvatarSafety(
  avatar: StructurallyCheckedProfileAvatarV1,
  decoder?: WagyuRasterBitmapDecoderV1 | null,
): Promise<VerifiedProfileAvatarV1> {
  if (avatar.state !== "decode-required") return avatar;
  const decoded = await confirmBrowserRasterDecode(
    avatar.bytes,
    {
      mediaType: avatar.mediaType,
      width: avatar.width,
      height: avatar.height,
    },
    decoder,
  );
  if (decoded === "unavailable") return { state: "unsupported" };
  return {
    state: "verified",
    mediaType: avatar.mediaType,
    bytes: avatar.bytes.slice(),
    width: avatar.width,
    height: avatar.height,
  };
}

export function validateLikeHeadSemantics(
  head: LikeHeadShapeV1,
  expected: {
    readonly networkId: Uint8Array;
    readonly postAuthor: string;
    readonly postId: Uint8Array;
    readonly postBodyHash: Uint8Array;
  },
): void {
  if (
    !equalBytes(
      requireBytes(head.network_id, "Like-head network ID", 32),
      assertConfiguredNetworkId(expected.networkId),
    )
  ) throw new Error("Like-head network ID mismatch");
  if (principalText(head.post_author) !== canonicalPrincipalText(expected.postAuthor, true)) {
    throw new Error("Like-head post author mismatch");
  }
  if (!equalBytes(requireBytes(head.post_id, "Like-head post ID", 32), requireBytes(expected.postId, "Expected post ID", 32))) {
    throw new Error("Like-head post ID mismatch");
  }
  if (!equalBytes(requireBytes(head.post_body_hash, "Like-head body hash", 32), requireBytes(expected.postBodyHash, "Expected post body hash", 32))) {
    throw new Error("Like-head post body hash mismatch");
  }
  validateNat64(head.store_generation, "Like-head store generation");
  validateNat64(head.revision, "Like-head revision");
  const previous = optional(head.previous_head_hash);
  if (previous !== null) requireBytes(previous, "Previous head hash", 32);
  const latestNumber = optional(head.latest_batch_number);
  const latestDigest = optional(head.latest_batch_digest);
  if ((latestNumber === null) !== (latestDigest === null)) {
    throw new Error("Like-head latest batch number and digest must co-occur");
  }
  if (latestNumber !== null) validateNat64(latestNumber, "Latest batch number");
  if (latestDigest !== null) requireBytes(latestDigest, "Latest batch digest", 32);
  validateNat64(head.sealed_batch_count, "Sealed batch count");
  validateNat64(head.sealed_receipt_count, "Sealed receipt count");
  if (typeof head.accepting_likes !== "boolean") {
    throw new Error("Like-head accepting flag must be Boolean");
  }
  if ((head.sealed_batch_count === 0n) !== (latestDigest === null)) {
    throw new Error("Like-head empty/nonempty batch fields are inconsistent");
  }
  if (
    latestNumber !== null &&
    latestNumber + 1n !== head.sealed_batch_count
  ) {
    throw new Error("Like-head latest number does not match sealed count");
  }
  if (
    head.sealed_receipt_count < head.sealed_batch_count ||
    head.sealed_receipt_count > head.sealed_batch_count * 150n
  ) {
    throw new Error("Like-head sealed counts are impossible");
  }
}

export function validateReplyIndexSemantics(
  index: ReplyIndexShapeV1,
  expected: {
    readonly networkId: Uint8Array;
    readonly postAuthor: string;
    readonly postId: Uint8Array;
    readonly postBodyHash: Uint8Array;
  },
): void {
  if (
    !equalBytes(
      requireBytes(index.network_id, "Reply-index network ID", 32),
      assertConfiguredNetworkId(expected.networkId),
    )
  ) throw new Error("Reply-index network ID mismatch");
  if (
    principalText(index.post_author) !==
      canonicalPrincipalText(expected.postAuthor, true)
  ) {
    throw new Error("Reply-index post author mismatch");
  }
  if (
    !equalBytes(
      requireBytes(index.post_id, "Reply-index post ID", 32),
      requireBytes(expected.postId, "Expected post ID", 32),
    )
  ) throw new Error("Reply-index post ID mismatch");
  if (
    !equalBytes(
      requireBytes(index.post_body_hash, "Reply-index body hash", 32),
      requireBytes(expected.postBodyHash, "Expected post body hash", 32),
    )
  ) throw new Error("Reply-index post body hash mismatch");
  validateNat64(index.store_generation, "Reply-index store generation");
  validateNat64(index.revision, "Reply-index revision");
  if (index.revision === 0n) {
    throw new Error("Reply-index revision must start at one");
  }
  const previous = optional(index.previous_index_hash);
  if (previous !== null) {
    requireBytes(previous, "Previous reply-index hash", 32);
  }
  if ((index.revision === 1n) !== (previous === null)) {
    throw new Error("Reply-index predecessor shape is inconsistent");
  }
  if (!Array.isArray(index.replies) || index.replies.length > 4_096) {
    throw new Error("Reply-index entry count is invalid");
  }
  const seen = new Set<string>();
  let lastReceivedAt = 0n;
  index.replies.forEach((reply, position) => {
    const author = principalText(reply.author);
    const postId = requireBytes(reply.post_id, "Reply post ID", 32);
    requireBytes(reply.object_digest, "Reply object digest", 32);
    const length = typeof reply.object_length === "bigint"
      ? reply.object_length
      : BigInt(reply.object_length);
    if (
      (typeof reply.object_length === "number" &&
        !Number.isSafeInteger(reply.object_length)) ||
      length < 1n ||
      length > 1_044_480n
    ) throw new Error("Reply object length is invalid");
    validateNat64(reply.received_at_ns, "Reply receipt time");
    if (position > 0 && reply.received_at_ns < lastReceivedAt) {
      throw new Error("Reply-index entries are not append ordered");
    }
    lastReceivedAt = reply.received_at_ns;
    const key = `${author}:${Array.from(postId, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")}`;
    if (seen.has(key)) throw new Error("Reply-index entry is duplicated");
    seen.add(key);
  });
}

export function knownActionKind(value: unknown): ActionKindV1 {
  if (
    value === "post" ||
    value === "share" ||
    value === "tombstone" ||
    value === "like"
  ) return value;
  const unwrapped = optional(value);
  if (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    !Array.isArray(unwrapped)
  ) {
    const keys = Object.keys(unwrapped);
    if (
      keys.length === 1 &&
      (keys[0] === "post" ||
        keys[0] === "share" ||
        keys[0] === "tombstone" ||
        keys[0] === "like")
    ) return keys[0];
  }
  throw new Error("Action kind is absent, unknown, or malformed");
}

function validateReplyLocator(value: unknown): void {
  if (value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reply locator is malformed");
  }
  const locator = value as Record<string, unknown>;
  principalText(locator.author as PrincipalValue);
  requireBytes(locator.post_id, "Parent post ID", 32);
  requireBytes(locator.body_hash, "Parent body hash", 32);
  requireBytes(locator.object_digest, "Parent object digest", 32);
  const length = locator.body_length;
  if (
    !(
      (typeof length === "number" && Number.isInteger(length)) ||
      typeof length === "bigint"
    ) ||
    BigInt(length) < 0n ||
    BigInt(length) > 0xffff_ffffn
  ) throw new Error("Parent body length is not Nat32");
}

function validateCapabilities(value: unknown): void {
  if (value === null) return;
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("Profile capabilities exceed their vector bound");
  }
  let previous: string | null = null;
  for (const token of value) {
    if (
      typeof token !== "string" ||
      utf8(token).byteLength > 64 ||
      !/^[a-z0-9._:-]+$/u.test(token) ||
      (previous !== null && token <= previous)
    ) {
      throw new Error("Profile capabilities must be sorted unique ASCII tokens");
    }
    previous = token;
  }
}

function validateAvatar(
  value: unknown,
): StructurallyCheckedProfileAvatarV1 {
  if (value === null) return { state: "absent" };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Profile avatar is malformed");
  }
  const avatar = value as Record<string, unknown>;
  // A future media tag must remain isolated to the avatar. Enforce the outer
  // byte bound first, but require non-empty/decodable bytes only for a known
  // current format below.
  const bytes = requireBytes(avatar.bytes, "Avatar", 0, 256 * 1_024);
  const width = boundedDimension(avatar.width, "Avatar width");
  const height = boundedDimension(avatar.height, "Avatar height");
  const mediaType = knownMediaType(optional(avatar.media_type));
  if (mediaType === null) return { state: "unsupported" };
  const inspection = inspectStaticRaster(bytes, mediaType);
  if (inspection.width !== width || inspection.height !== height) {
    throw new Error("Avatar declared dimensions do not match raster bytes");
  }
  return {
    state: "decode-required",
    mediaType,
    bytes: bytes.slice(),
    width,
    height,
  };
}

function knownMediaType(value: unknown): "jpeg" | "png" | "webp" | null {
  if (value === "jpeg" || value === "png" || value === "webp") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && (keys[0] === "jpeg" || keys[0] === "png" || keys[0] === "webp")) {
      return keys[0];
    }
  }
  return null;
}

function boundedDimension(value: unknown, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > 1_024
  ) throw new Error(`${label} must be 1-1024`);
  return number;
}

function validatePlainText(value: unknown, label: string, maximumBytes: number): void {
  if (typeof value !== "string" || utf8(value).byteLength > maximumBytes) {
    throw new Error(`${label} exceeds its UTF-8 byte bound`);
  }
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code === 0 ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) throw new Error(`${label} contains a non-text control`);
  }
}

function optional(value: unknown): unknown | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return value[0];
    throw new Error("Candid option has more than one value");
  }
  return value;
}

function validateNat64(value: unknown, label: string): asserts value is bigint {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > 0xffff_ffff_ffff_ffffn
  ) throw new Error(`${label} must be Nat64`);
}

function assertBodyLength(value: number | bigint, expected: number): void {
  const length = typeof value === "bigint" ? value : BigInt(value);
  if (
    (typeof value === "number" && !Number.isInteger(value)) ||
    length < 0n ||
    length > 0xffff_ffffn ||
    length !== BigInt(expected)
  ) throw new Error("Action ref body length does not match exact bytes");
}

function principalText(value: PrincipalValue): string {
  if (typeof value === "string") return canonicalPrincipalText(value, true);
  if (!Principal.isPrincipal(value)) throw new Error("Principal field is malformed");
  const text = value.toText();
  return canonicalPrincipalText(text, true);
}

function canonicalPrincipalText(value: string, requireCanister: boolean): string {
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch {
    throw new Error("Principal field is malformed");
  }
  const canonical = principal.toText();
  if (
    canonical !== value ||
    principal.compareTo(Principal.anonymous()) === "eq" ||
    (requireCanister && !isCanisterPrincipal(principal))
  ) throw new Error("Principal field is not a canonical canister");
  return canonical;
}

function isCanisterPrincipal(principal: Principal): boolean {
  const bytes = principal.toUint8Array();
  return bytes.byteLength > 0 && bytes.at(-1) === 0x01;
}

function principalBytes(value: string): Uint8Array {
  return Principal.fromText(canonicalPrincipalText(value, true)).toUint8Array();
}
