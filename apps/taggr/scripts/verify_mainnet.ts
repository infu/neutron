/**
 * Anonymous, query-only check of the shipped Taggr client and parsers.
 *
 *   bun scripts/verify_mainnet.ts
 *
 * Prints compact coverage counts. No authentication, invoices, registrations,
 * posts, reactions, or payments are created; update routes throw locally.
 */
import assert from "node:assert/strict";
import { AnonymousIdentity } from "@dfinity/agent";
import { TAGGR_MAINNET_CANISTER } from "../src/identity.ts";
import { createTaggrClient } from "../src/taggr_client.ts";
import {
  browseRealms,
  conversation,
  domains,
  feed,
  FEED_PAGE_SIZE,
  recentTags,
  search,
  setTaggrTransport,
  stats,
  user,
} from "../src/taggr_api.ts";
import { resolveDomain } from "../src/domain.ts";

const client = await createTaggrClient({
  canisterId: TAGGR_MAINNET_CANISTER,
  identity: new AnonymousIdentity(),
  host: "https://icp-api.io",
  local: false,
});
const methods = new Set<string>();
const query = async (method: string, payload = "null") => {
  methods.add(method);
  return client.query(method, payload);
};
setTaggrTransport({
  query,
  update: async () => { throw new Error("Mainnet verification permits queries only"); },
  addPost: async () => { throw new Error("Mainnet verification permits queries only"); },
});

const config = JSON.parse(await query("config")) as { feed_page_size: number; post_cost: number };
assert.equal(config.feed_page_size, FEED_PAGE_SIZE, "Live page size differs from the client");
const counts = await stats();
const configuredDomains = await domains();
const domain = resolveDomain({ canister: TAGGR_MAINNET_CANISTER, domains: configuredDomains });
assert(configuredDomains.some((entry) => entry.name === domain), "Resolved domain must exist");
const newest = await feed({ domain, mode: "new" });
const hot = await feed({ domain, mode: "hot" });
const tags = await recentTags({ domain });
const realms = await browseRealms({ domain });
const searchResults = await search(domain, "Taggr");
const sample = newest[0] ?? hot[0];
let threadEntries: number | null = null;
let profileRead = false;
if (sample) {
  const view = await conversation(sample.post.id);
  assert(view.entries.some((entry) => entry.post.id === sample.post.id), "Conversation lost its focus post");
  threadEntries = view.entries.length;
  const profile = await user(domain, sample.meta.authorName);
  assert(profile, "The observed post author must have a profile");
  profileRead = true;
}
console.log(JSON.stringify({
  verified: true,
  observedAt: new Date().toISOString(),
  canister: TAGGR_MAINNET_CANISTER,
  anonymous: client.principal === "2vxsx-fae",
  queryMethods: [...methods],
  domain,
  counts: {
    domains: configuredDomains.length,
    networkUsers: counts.users,
    networkPosts: counts.posts,
    newest: newest.length,
    hot: hot.length,
    tags: tags.length,
    realms: realms.length,
    searchResults: searchResults.length,
    threadEntries,
  },
  profileRead,
  mutations: 0,
}));
