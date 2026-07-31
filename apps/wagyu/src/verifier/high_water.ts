import { equalBytes, requireBytes } from "./bytes.ts";
import type {
  HighWaterDecisionV1,
  LikeHeadHighWaterV1,
  ProfileHighWaterV1,
  ReplyIndexHighWaterV1,
} from "./types.ts";

export function checkProfileHighWater(
  prior: ProfileHighWaterV1 | null,
  next: ProfileHighWaterV1 & {
    readonly previousProfileDigest: Uint8Array | null;
  },
): HighWaterDecisionV1 {
  validateCounter(next.profileGeneration, "Profile generation");
  validateCounter(next.revision, "Profile revision");
  requireBytes(next.bodyDigest, "Profile body digest", 32);
  if (next.previousProfileDigest !== null) {
    requireBytes(next.previousProfileDigest, "Previous profile digest", 32);
  }
  if (prior === null) return { state: "advance" };
  validateCounter(prior.profileGeneration, "Prior profile generation");
  validateCounter(prior.revision, "Prior profile revision");
  requireBytes(prior.bodyDigest, "Prior profile digest", 32);

  if (next.profileGeneration < prior.profileGeneration) {
    return reject("profile_generation_rollback", "Profile generation regressed");
  }
  if (next.profileGeneration > prior.profileGeneration) {
    return { state: "advance" };
  }
  if (next.revision < prior.revision) {
    return reject("profile_revision_rollback", "Profile revision regressed");
  }
  if (next.revision === prior.revision) {
    return equalBytes(next.bodyDigest, prior.bodyDigest)
      ? { state: "replay" }
      : reject(
        "profile_revision_equivocation",
        "One profile revision had two different bodies",
      );
  }
  if (
    next.revision === prior.revision + 1n &&
    (
      next.previousProfileDigest === null ||
      !equalBytes(next.previousProfileDigest, prior.bodyDigest)
    )
  ) {
    return reject(
      "profile_chain_mismatch",
      "Adjacent profile revision does not bind the preceding digest",
    );
  }
  return { state: "advance" };
}

export function checkLikeHeadHighWater(
  prior: LikeHeadHighWaterV1 | null,
  next: LikeHeadHighWaterV1 & {
    readonly previousHeadHash: Uint8Array | null;
  },
): HighWaterDecisionV1 {
  validateCounter(next.storeGeneration, "Like-head store generation");
  validateCounter(next.revision, "Like-head revision");
  requireBytes(next.bodyDigest, "Like-head body digest", 32);
  if (next.previousHeadHash !== null) {
    requireBytes(next.previousHeadHash, "Previous head hash", 32);
  }
  if (prior === null) return { state: "advance" };
  validateCounter(prior.storeGeneration, "Prior like-head store generation");
  validateCounter(prior.revision, "Prior like-head revision");
  requireBytes(prior.bodyDigest, "Prior like-head digest", 32);

  if (next.storeGeneration < prior.storeGeneration) {
    return reject("head_generation_rollback", "Like-head generation regressed");
  }
  if (next.storeGeneration > prior.storeGeneration) {
    return { state: "advance" };
  }
  if (next.revision < prior.revision) {
    return reject("head_revision_rollback", "Like-head revision regressed");
  }
  if (next.revision === prior.revision) {
    return equalBytes(next.bodyDigest, prior.bodyDigest)
      ? { state: "replay" }
      : reject(
        "head_revision_equivocation",
        "One like-head revision had two different bodies",
      );
  }
  if (
    next.revision === prior.revision + 1n &&
    (
      next.previousHeadHash === null ||
      !equalBytes(next.previousHeadHash, prior.bodyDigest)
    )
  ) {
    return reject(
      "head_chain_mismatch",
      "Adjacent like-head revision does not bind the preceding digest",
    );
  }
  return { state: "advance" };
}

export function checkReplyIndexHighWater(
  prior: ReplyIndexHighWaterV1 | null,
  next: ReplyIndexHighWaterV1 & {
    readonly previousIndexHash: Uint8Array | null;
  },
): HighWaterDecisionV1 {
  validateCounter(next.storeGeneration, "Reply-index store generation");
  validateCounter(next.revision, "Reply-index revision");
  requireBytes(next.bodyDigest, "Reply-index body digest", 32);
  if (next.previousIndexHash !== null) {
    requireBytes(next.previousIndexHash, "Previous reply-index hash", 32);
  }
  if (prior === null) return { state: "advance" };
  validateCounter(prior.storeGeneration, "Prior reply-index store generation");
  validateCounter(prior.revision, "Prior reply-index revision");
  requireBytes(prior.bodyDigest, "Prior reply-index digest", 32);

  if (next.storeGeneration < prior.storeGeneration) {
    return reject(
      "reply_index_generation_rollback",
      "Reply-index generation regressed",
    );
  }
  if (next.storeGeneration > prior.storeGeneration) {
    return { state: "advance" };
  }
  if (next.revision < prior.revision) {
    return reject(
      "reply_index_revision_rollback",
      "Reply-index revision regressed",
    );
  }
  if (next.revision === prior.revision) {
    return equalBytes(next.bodyDigest, prior.bodyDigest)
      ? { state: "replay" }
      : reject(
        "reply_index_revision_equivocation",
        "One reply-index revision had two different bodies",
      );
  }
  if (
    next.revision === prior.revision + 1n &&
    (
      next.previousIndexHash === null ||
      !equalBytes(next.previousIndexHash, prior.bodyDigest)
    )
  ) {
    return reject(
      "reply_index_chain_mismatch",
      "Adjacent reply-index revision does not bind the preceding digest",
    );
  }
  return { state: "advance" };
}

function validateCounter(value: bigint, label: string): void {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > 0xffff_ffff_ffff_ffffn
  ) {
    throw new Error(`${label} must be Nat64`);
  }
}

function reject(code: string, reason: string): HighWaterDecisionV1 {
  return { state: "reject", code, reason };
}
