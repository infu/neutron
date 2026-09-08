// The Taggr methods this client is allowed to invoke.
//
// The resident background is the only surface that reaches the network, and it
// checks every request against these lists before it builds a call. Reads and
// writes are separate so a defect on a read path cannot reach a mutating Taggr
// endpoint, and so the tile's read requests can use fast non-replicated queries
// while writes go through consensus.

/** Taggr `canister_query` exports. Invoked as ordinary IC queries. */
export const READ_METHODS: readonly string[] = [
  "all_realms",
  "config",
  "domains",
  "hot_posts",
  "journal",
  "last_posts",
  "personal_feed",
  "posts",
  "posts_by_tags",
  "realm_search",
  "realms",
  "recent_tags",
  "search",
  "stats",
  "tags_cost",
  "thread",
  "user",
  "user_posts",
  "users_data",
  "validate_username",
];

/**
 * Taggr `canister_update` exports. Deliberately small: no editing, no deleting,
 * no moderation, no credit transfers, no proposals, no governance. `add_post`
 * is absent because it is Candid and has its own typed path.
 */
export const WRITE_METHODS: readonly string[] = [
  "create_user",
  "mint_credits_with_icp",
  "react",
  "toggle_bookmark",
  "toggle_following_user",
  "toggle_realm_membership",
  "update_last_activity",
  "vote_on_poll",
];

export const isReadMethod = (method: string): boolean => READ_METHODS.includes(method);
export const isWriteMethod = (method: string): boolean => WRITE_METHODS.includes(method);
