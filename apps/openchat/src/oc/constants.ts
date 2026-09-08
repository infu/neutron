// OpenChat mainnet canister ids and network facts.
//
// OpenChat runs on IC mainnet, so this client always talks to the mainnet
// boundary regardless of whether the host Neutron is local or on the IC. The
// only requirement is that the resident surface's CSP (service.html) allows the
// boundary origin; see public/service.html.
//
// Ids are from OpenChat's canister_ids.json (the "ic" network entries).

export const OC_BOUNDARY_HOST = "https://icp-api.io";

/** Base host pattern for OpenChat blob/media (avatars, attachments). */
export const OC_BLOB_HOST_SUFFIX = ".raw.icp0.io";

export const OC_CANISTERS = {
  identity: "6klfq-niaaa-aaaar-qadbq-cai",
  signInWithEmail: "zi2i7-nqaaa-aaaar-qaemq-cai",
  userIndex: "4bkt6-4aaaa-aaaaf-aaaiq-cai",
  groupIndex: "4ijyc-kiaaa-aaaaf-aaaja-cai",
  // The default registration/local index. A user's live chats each carry their
  // own local_user_index id, discovered from the bootstrap summaries; this
  // constant is only the entry point used for a fresh registration.
  localUserIndex: "nq4qv-wqaaa-aaaaf-bhdgq-cai",
  storageIndex: "rturd-qaaaa-aaaaf-aabaq-cai",
} as const;

/** Delegations are minted by OpenChat with a 30-day default / 90-day max TTL. */
export const OC_DELEGATION_TTL_NS = 30n * 24n * 60n * 60n * 1_000_000_000n;

/** Refresh the OpenChat delegation when it is within this window of expiry. */
export const OC_DELEGATION_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
