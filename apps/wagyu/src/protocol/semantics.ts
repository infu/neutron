import type { Principal } from "@dfinity/principal";
import {
  equalBytes,
  requireKnownOpt,
  WagyuProtocolError,
} from "./bytes.ts";
import {
  deriveLikeId,
  deriveObjectDigest,
  derivePostBodyHash,
  derivePostId,
  derivePostRefDigest,
  deriveShareId,
  deriveTombstoneId,
} from "./ids.ts";
import type {
  ActionHeaderV1,
  ActionKindV1,
  CertifiedActionRefV1,
  CertifiedPostRefV1,
  ExactDecodedCandidV1,
  LikeActionV1,
  PostBodyV1,
  ProfileV1,
  ShareActionV1,
  TombstoneActionV1,
  WagyuBytes32,
} from "./types.ts";

export type KnownActionKindV1 = "post" | "share" | "tombstone" | "like";

export interface DerivedPostIdentityV1 {
  body_hash: WagyuBytes32;
  post_id: WagyuBytes32;
  object_digest: WagyuBytes32;
  body_length: number;
}

export function actionKindTag(
  actionKind: ActionHeaderV1["action_kind"],
): KnownActionKindV1 | null {
  if (actionKind.length === 0) return null;
  return variantTag(actionKind[0]!);
}

export function requireActionKind(
  actionKind: ActionHeaderV1["action_kind"],
  label = "action_kind",
): KnownActionKindV1 {
  requireKnownOpt(actionKind, label);
  const tag = actionKindTag(actionKind);
  if (tag === null) {
    throw new WagyuProtocolError(
      "WAGYU_UNSUPPORTED_ACTION_KIND",
      `${label} is missing or unsupported`,
    );
  }
  return tag;
}

export function assertActionHeader(
  header: ActionHeaderV1,
  expectedNetworkId: WagyuBytes32,
  expectedActor: Principal,
  expectedKind: KnownActionKindV1,
): void {
  assertBytesEqual(
    header.network_id,
    expectedNetworkId,
    "action header network_id",
  );
  assertPrincipalEqual(header.actor, expectedActor, "action header actor");
  const kind = requireActionKind(header.action_kind);
  if (kind !== expectedKind) {
    throw new WagyuProtocolError(
      "WAGYU_ACTION_KIND_MISMATCH",
      `Expected ${expectedKind} action, received ${kind}`,
    );
  }
}

export function derivePostIdentity(
  post: ExactDecodedCandidV1<PostBodyV1>,
): DerivedPostIdentityV1 {
  const bodyHash = derivePostBodyHash(post.exact_bytes);
  return Object.freeze({
    body_hash: bodyHash,
    post_id: derivePostId(
      post.value.header.network_id,
      post.value.header.actor,
      bodyHash,
    ),
    object_digest: post.object_digest,
    body_length: post.exact_bytes.byteLength,
  });
}

export function assertCertifiedPostRefMatchesBody(
  ref: CertifiedPostRefV1,
  post: ExactDecodedCandidV1<PostBodyV1>,
  expectedNetworkId: WagyuBytes32,
): DerivedPostIdentityV1 {
  assertActionHeader(
    post.value.header,
    expectedNetworkId,
    ref.author,
    "post",
  );
  const identity = derivePostIdentity(post);
  assertBytesEqual(ref.post_id, identity.post_id, "post ref post_id");
  assertBytesEqual(ref.body_hash, identity.body_hash, "post ref body_hash");
  assertBytesEqual(
    ref.object_digest,
    identity.object_digest,
    "post ref object_digest",
  );
  if (ref.body_length !== identity.body_length) {
    throw new WagyuProtocolError(
      "WAGYU_BODY_LENGTH_MISMATCH",
      "Post ref body_length does not match exact received bytes",
    );
  }
  return identity;
}

export function assertShareActionIdentity(
  action: ShareActionV1,
  exactOriginalPostRefCandid: Uint8Array,
  expectedNetworkId: WagyuBytes32,
  expectedSharer: Principal,
): void {
  assertActionHeader(
    action.header,
    expectedNetworkId,
    expectedSharer,
    "share",
  );
  const expectedShareId = deriveShareId(
    action.header.network_id,
    action.header.actor,
    action.original_author,
    action.original_post_id,
  );
  assertBytesEqual(action.share_id, expectedShareId, "share_id");
  assertBytesEqual(
    action.post_ref_digest,
    derivePostRefDigest(exactOriginalPostRefCandid),
    "share post_ref_digest",
  );
}

export function assertLikeActionIdentity(
  action: LikeActionV1,
  expectedNetworkId: WagyuBytes32,
  expectedLiker: Principal,
): void {
  assertActionHeader(action.header, expectedNetworkId, expectedLiker, "like");
  assertBytesEqual(
    action.like_id,
    deriveLikeId(
      action.header.network_id,
      action.header.actor,
      action.post_author,
      action.post_id,
    ),
    "like_id",
  );
}

export function assertTombstoneActionIdentity(
  action: TombstoneActionV1,
  expectedNetworkId: WagyuBytes32,
  expectedAuthor: Principal,
): void {
  assertActionHeader(
    action.header,
    expectedNetworkId,
    expectedAuthor,
    "tombstone",
  );
  assertBytesEqual(
    action.tombstone_id,
    deriveTombstoneId(
      action.header.network_id,
      action.header.actor,
      action.post_id,
      action.author_sequence,
    ),
    "tombstone_id",
  );
}

export function assertCertifiedActionRef(
  ref: CertifiedActionRefV1,
  exactActionBody: Uint8Array,
  expectedActor: Principal,
  expectedKind: KnownActionKindV1,
): void {
  assertPrincipalEqual(ref.actor, expectedActor, "certified ref actor");
  const kind = requireActionKind(ref.action_kind, "certified ref action_kind");
  if (kind !== expectedKind) {
    throw new WagyuProtocolError(
      "WAGYU_ACTION_KIND_MISMATCH",
      `Expected ${expectedKind} certified ref, received ${kind}`,
    );
  }
  assertBytesEqual(
    ref.object_digest,
    deriveObjectDigest(exactActionBody),
    "certified ref object_digest",
  );
  if (ref.body_length !== exactActionBody.byteLength) {
    throw new WagyuProtocolError(
      "WAGYU_BODY_LENGTH_MISMATCH",
      "Certified ref body_length does not match exact received bytes",
    );
  }
}

export function assertProfileBinding(
  profile: ProfileV1,
  expectedNetworkId: WagyuBytes32,
  expectedNode: Principal,
): void {
  assertBytesEqual(profile.network_id, expectedNetworkId, "profile network_id");
  assertPrincipalEqual(profile.node, expectedNode, "profile node");
}

export function assertPrincipalEqual(
  actual: Principal,
  expected: Principal,
  label: string,
): void {
  if (actual.compareTo(expected) !== "eq") {
    throw new WagyuProtocolError(
      "WAGYU_PRINCIPAL_MISMATCH",
      `${label} does not match the expected Node ID`,
    );
  }
}

export function assertBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string,
): void {
  if (!equalBytes(actual, expected)) {
    throw new WagyuProtocolError(
      "WAGYU_DIGEST_MISMATCH",
      `${label} does not match`,
    );
  }
}

function variantTag(value: ActionKindV1): KnownActionKindV1 {
  if ("post" in value) return "post";
  if ("share" in value) return "share";
  if ("tombstone" in value) return "tombstone";
  return "like";
}
