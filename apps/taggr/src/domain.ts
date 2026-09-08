// Taggr's domain model, and the post filter that goes with it.
//
// Taggr serves one canister under many hostnames, and `state.domains` gives
// each one its own view: a realm blacklist or whitelist, one user's journal,
// and a downvote ceiling. `domain_realm_post_filter` applies the realm part in
// the backend, and Taggr's own client applies the rest — `postAllowed` in
// `src/frontend/src/common.tsx` — so a client that skips it shows posts the
// network's own front ends suppress.
//
// The domain a browser front end uses is its own `location.hostname`. This app
// has no Taggr hostname of its own, so it resolves one:
//
//   1. `<canister>.icp0.io`, which is what Taggr calls its canonical domain
//      (`getCanonicalDomain`). On mainnet it is DAO-managed, blacklists no
//      realm, and carries the default downvote ceiling, so it is the fullest
//      view of the network and imposes no third party's policy.
//   2. `<canister>.ic0.app`, the older boundary-node host, if the deployment
//      registered that instead.
//   3. `localhost`, which every `State::init()` inserts. On a local deployment
//      it is the only domain there is.
//
// An unregistered value is not an error: `domain_realm_post_filter` returns
// `None`, which the feed reads as "nothing", so the UI has to say so rather
// than look empty.

import {
  DOWNVOTE_REACTION_ID,
  type Post,
  type PostMeta,
  type TaggrDomain,
} from "./model.ts";

/** Taggr's own `getCanonicalDomain()`: `${canister_id}.icp0.io`. */
export const canonicalDomain = (canister: string): string => `${canister}.icp0.io`;

const legacyDomain = (canister: string): string => `${canister}.ic0.app`;

/**
 * The domain to browse under, given what the deployment actually registered.
 * Falls back to the canonical name so a deployment that answers nothing still
 * gets a stable value rather than an empty string.
 */
export const resolveDomain = (input: {
  canister: string;
  domains: readonly TaggrDomain[];
  /** A domain the owner chose explicitly always wins, if it still exists. */
  preferred?: string | null;
}): string => {
  const known = new Set(input.domains.map((domain) => domain.name));
  const preferred = input.preferred?.trim();
  if (preferred && (known.size === 0 || known.has(preferred))) return preferred;
  for (const candidate of [
    canonicalDomain(input.canister),
    legacyDomain(input.canister),
    "localhost",
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return canonicalDomain(input.canister);
};

export const findDomain = (
  domains: readonly TaggrDomain[],
  name: string,
): TaggrDomain | null => domains.find((domain) => domain.name === name) ?? null;

/** How a domain describes itself in one line, for the settings picker. */
export const describeDomain = (domain: TaggrDomain): string => {
  const managed = domain.owner === null ? "DAO-managed" : "community-run";
  const scope =
    domain.scope.kind === "journal"
      ? "one user's journal"
      : domain.scope.kind === "whitelist"
        ? `only ${domain.scope.realms.length} realm${domain.scope.realms.length === 1 ? "" : "s"}`
        : domain.scope.realms.length === 0
          ? "every realm"
          : `every realm but ${domain.scope.realms.length}`;
  return `${managed}, ${scope}, hides posts past ${domain.maxDownvotes} downvote${
    domain.maxDownvotes === 1 ? "" : "s"
  }`;
};

/**
 * Why a domain suppresses a post, or `null` when it does not.
 *
 * This is Taggr's `postAllowed`, kept in the same order: the realm's own
 * downvote ceiling first — `Post::with_meta` sets `max_downvotes_reached` from
 * the realm, so that one names the realm — then the domain's ceiling, then the
 * domain's realm scope. An unregistered domain suppresses nothing here,
 * because the backend already returned nothing for it.
 */
export type Suppression = { by: "realm" | "domain"; where: string };

export const postSuppression = (input: {
  post: Post;
  meta: PostMeta;
  domain: TaggrDomain | null;
}): Suppression | null => {
  const { post, meta, domain } = input;
  if (meta.maxDownvotesReached) {
    return { by: "realm", where: post.realm ?? "this realm" };
  }
  if (domain === null) return null;

  const downvotes =
    post.reactions.find((reaction) => reaction.id === DOWNVOTE_REACTION_ID)?.users.length ?? 0;
  if (downvotes > domain.maxDownvotes) return { by: "domain", where: domain.name };

  if (post.realm === null) {
    // A journal domain carries no realm scope for postless-realm content;
    // the backend's filter already restricted it to that user's posts.
    return null;
  }
  if (domain.scope.kind === "whitelist" && !domain.scope.realms.includes(post.realm)) {
    return { by: "domain", where: domain.name };
  }
  if (domain.scope.kind === "blacklist" && domain.scope.realms.includes(post.realm)) {
    return { by: "domain", where: domain.name };
  }
  return null;
};

export const suppressionMessage = (suppression: Suppression): string =>
  suppression.by === "realm"
    ? `Suppressed in ${suppression.where}: too many downvotes.`
    : `Not shown on ${suppression.where}.`;
