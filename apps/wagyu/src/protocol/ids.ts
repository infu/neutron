import type { Principal } from "@dfinity/principal";
import { hashLp, sha256Exact, u64be, utf8 } from "./bytes.ts";
import { WAGYU_HASH_DOMAINS } from "./constants.ts";
import type {
  WagyuBytes16,
  WagyuBytes32,
  WagyuExactCandidBytes,
} from "./types.ts";

function principalBytes(principal: Principal): Uint8Array {
  return principal.toUint8Array();
}

export function deriveNetworkId(
  exactPinnedIcRootSpkiDerBytes: Uint8Array,
): WagyuBytes32 {
  return hashLp(
    utf8(WAGYU_HASH_DOMAINS.networkId),
    exactPinnedIcRootSpkiDerBytes,
  );
}

export function derivePostBodyHash(
  exactPostBodyCandid: Uint8Array | WagyuExactCandidBytes,
): WagyuBytes32 {
  return hashLp(
    utf8(WAGYU_HASH_DOMAINS.postBody),
    exactPostBodyCandid,
  );
}

export function derivePostId(
  networkId: WagyuBytes32,
  author: Principal,
  bodyHash: WagyuBytes32,
): WagyuBytes32 {
  return hashLp(
    utf8(WAGYU_HASH_DOMAINS.postId),
    networkId,
    principalBytes(author),
    bodyHash,
  );
}

export function deriveShareId(
  networkId: WagyuBytes32,
  sharer: Principal,
  originalAuthor: Principal,
  originalPostId: WagyuBytes32,
): WagyuBytes32 {
  return hashLp(
    utf8(WAGYU_HASH_DOMAINS.shareId),
    networkId,
    principalBytes(sharer),
    principalBytes(originalAuthor),
    originalPostId,
  );
}

export function deriveLikeId(
  networkId: WagyuBytes32,
  liker: Principal,
  postAuthor: Principal,
  postId: WagyuBytes32,
): WagyuBytes32 {
  return hashLp(
    utf8(WAGYU_HASH_DOMAINS.likeId),
    networkId,
    principalBytes(liker),
    principalBytes(postAuthor),
    postId,
  );
}

export function deriveTombstoneId(
  networkId: WagyuBytes32,
  author: Principal,
  postId: WagyuBytes32,
  authorSequence: bigint,
): WagyuBytes32 {
  return hashLp(
    utf8(WAGYU_HASH_DOMAINS.tombstoneId),
    networkId,
    principalBytes(author),
    postId,
    u64be(authorSequence, "author_sequence"),
  );
}

export function deriveFeedCandidateId(
  immediateCaller: Principal,
  operationId: WagyuBytes16,
  payloadDigest: WagyuBytes32,
): WagyuBytes32 {
  return hashLp(
    utf8(WAGYU_HASH_DOMAINS.feedCandidateId),
    principalBytes(immediateCaller),
    operationId,
    payloadDigest,
  );
}

export function deriveObjectDigest(
  exactResponseBodyBytes: Uint8Array,
): WagyuBytes32 {
  return sha256Exact(exactResponseBodyBytes);
}

export function derivePostRefDigest(
  exactCertifiedPostRefCandid: Uint8Array,
): WagyuBytes32 {
  return sha256Exact(exactCertifiedPostRefCandid);
}

export function derivePayloadDigest(
  exactBodyCandid: Uint8Array,
): WagyuBytes32 {
  return sha256Exact(exactBodyCandid);
}
