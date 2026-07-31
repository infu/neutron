import { readFile } from "node:fs/promises";

import { expect, test } from "bun:test";

const backend = new URL("../backend/", import.meta.url);

test("V101 keeps publication and feed conflict lookup on direct bounded indexes", async () => {
  const [main, memory, feed] = await Promise.all([
    readFile(new URL("main.mo", backend), "utf8"),
    readFile(new URL("memory/wagyu/v3.mo", backend), "utf8"),
    readFile(new URL("feed/Types.mo", backend), "utf8"),
  ]);

  expect(memory).toContain("authored_post_by_nonce");
  expect(memory).toContain("feed_candidates_by_claimed_slot");
  expect(memory).toContain("verified_feed_by_post_slot");
  expect(main).toContain("Map.get(\n                    mem.authored_post_by_nonce");
  expect(main).not.toContain(
    "for ((_, existing) in Map.entries(mem.authored_posts))",
  );
  expect(main).toContain("MAX_LOCAL_PAGE_ROWS_EXAMINED : Nat = 256");
  expect(feed).toContain("MAX_CANDIDATES_PER_CLAIMED_SLOT : Nat = 64");
});
