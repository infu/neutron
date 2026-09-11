import { expect, test } from "bun:test";
import {
  compareFeedProposals,
  loadProposalFeedPage,
  type FeedProposal,
  type ProposalFeedReader,
} from "../src/data/feed";
import { SnsError } from "../src/data/errors";
import type { ProposalSummary } from "../src/data/types";

function proposal(id: bigint, createdAtSeconds: bigint): ProposalSummary {
  return {
    id, createdAtSeconds, title: `Proposal ${id}`, summary: "", url: "",
    status: "open", actionKind: "Motion",
  };
}

function reader(rows: Record<string, ProposalSummary[]>) {
  const calls: Parameters<ProposalFeedReader>[0][] = [];
  const read: ProposalFeedReader = async (params) => {
    calls.push(params);
    const remaining = rows[params.sns]!.filter((row) =>
      params.beforeProposal === undefined || row.id < params.beforeProposal,
    );
    const proposals = remaining.slice(0, params.limit);
    return {
      proposals,
      ...(proposals.length === params.limit ? { nextBefore: proposals.at(-1)!.id } : {}),
    };
  };
  return { read, calls };
}

function keys(rows: FeedProposal[]) {
  return rows.map((row) => `${row.sns}/${row.proposal.id}`);
}

test("merged pagination retains unread source buffers and traverses every upstream page", async () => {
  const { read, calls } = reader({
    alpha: [proposal(5n, 100n), proposal(4n, 90n), proposal(3n, 80n), proposal(2n, 30n), proposal(1n, 10n)],
    beta: [proposal(3n, 70n), proposal(2n, 60n), proposal(1n, 50n)],
  });
  let cursor: string | undefined;
  const all: FeedProposal[] = [];
  const pages: string[][] = [];
  do {
    const page = await loadProposalFeedPage({
      sns: ["beta", "alpha"], limit: 2, ...(cursor === undefined ? {} : { cursor }),
    }, read);
    expect(page.failures).toEqual([]);
    all.push(...page.proposals);
    pages.push(keys(page.proposals));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  expect(pages).toEqual([
    ["alpha/5", "alpha/4"], ["alpha/3", "beta/3"],
    ["beta/2", "beta/1"], ["alpha/2", "alpha/1"],
  ]);
  expect(keys(all)).toEqual(keys([...all].sort(compareFeedProposals)));
  expect(calls.filter((call) => call.sns === "beta")).toEqual([
    { sns: "beta", limit: 2 }, { sns: "beta", limit: 2, beforeProposal: 2n },
  ]);
  expect(new Set(keys(all)).size).toBe(8);
});

test("serialized cursor round-trips bigint payloads and supports changing page size", async () => {
  const huge = 9_007_199_254_740_999n;
  const buffered = {
    ...proposal(huge, 10n), deadlineSeconds: huge + 1n,
    tally: { yes: huge + 2n, no: 0n, total: huge + 3n, timestampSeconds: 10n },
    summary: '{"$bigint":"123"}',
  };
  const { read } = reader({ alpha: [proposal(1n, 20n)], beta: [buffered] });
  const first = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 1 }, read);
  const transported = JSON.parse(JSON.stringify(first.nextCursor)) as string;
  const second = await loadProposalFeedPage({ sns: ["beta", "alpha"], limit: 3, cursor: transported }, read);
  expect(second.proposals).toEqual([{ sns: "beta", proposal: buffered }]);
  expect(second.nextCursor).toBeUndefined();
});

test("identical timestamps use SNS then descending bigint proposal id even across pages", async () => {
  const { read } = reader({
    alpha: [proposal(9_007_199_254_740_999n, 50n), proposal(9_007_199_254_740_998n, 50n)],
    beta: [proposal(8n, 50n)],
  });
  const first = await loadProposalFeedPage({ sns: ["beta", "alpha", "alpha"], limit: 1 }, read);
  const second = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 2, cursor: first.nextCursor! }, read);
  expect(keys([...first.proposals, ...second.proposals])).toEqual([
    "alpha/9007199254740999", "alpha/9007199254740998", "beta/8",
  ]);
});

test("a failed source is reported once per call, retained, and recovered without skipping rows", async () => {
  const { read, calls } = reader({
    alpha: [proposal(2n, 100n), proposal(1n, 90n)],
    beta: [proposal(2n, 200n), proposal(1n, 80n)],
  });
  let unavailable = true;
  const withFailure: ProposalFeedReader = async (params) => {
    if (params.sns === "beta" && unavailable) {
      throw new SnsError("UPSTREAM_UNAVAILABLE", "network unavailable");
    }
    return read(params);
  };
  const first = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 2 }, withFailure);
  expect(keys(first.proposals)).toEqual(["alpha/2", "alpha/1"]);
  expect(first.failures).toEqual([
    { scope: "beta", code: "UPSTREAM_UNAVAILABLE", message: "network unavailable" },
  ]);
  expect(first.nextCursor).toBeString();
  unavailable = false;
  const second = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 3, cursor: first.nextCursor! }, withFailure);
  expect(keys(second.proposals)).toEqual(["beta/2", "beta/1"]);
  expect(second.failures).toEqual([]);
  expect(second.nextCursor).toBeUndefined();
  expect(calls.find((call) => call.sns === "beta")?.beforeProposal).toBeUndefined();
  expect(keys([...first.proposals, ...second.proposals].sort(compareFeedProposals))).toEqual([
    "beta/2", "alpha/2", "alpha/1", "beta/1",
  ]);
});

test("a refill failure retries the exact source cursor after other sources progress", async () => {
  const { read } = reader({ alpha: [proposal(3n, 90n), proposal(2n, 80n), proposal(1n, 70n)], beta: [proposal(1n, 60n)] });
  const attempts: (bigint | undefined)[] = [];
  let unavailable = true;
  const withFailure: ProposalFeedReader = async (params) => {
    if (params.sns === "alpha") {
      attempts.push(params.beforeProposal);
      if (params.beforeProposal === 2n && unavailable) throw new Error("fetch failed");
    }
    return read(params);
  };
  const first = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 2 }, withFailure);
  const second = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 2, cursor: first.nextCursor! }, withFailure);
  expect(keys(second.proposals)).toEqual(["beta/1"]);
  expect(second.failures[0]?.scope).toBe("alpha");
  unavailable = false;
  const third = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 2, cursor: second.nextCursor! }, withFailure);
  expect(keys(third.proposals)).toEqual(["alpha/1"]);
  expect(third.nextCursor).toBeUndefined();
  expect(attempts).toEqual([undefined, 2n, 2n]);
});

test("all failures retain a resumable empty page and empty selections complete", async () => {
  const fail: ProposalFeedReader = async () => { throw new Error("fetch failed"); };
  const first = await loadProposalFeedPage({ sns: ["alpha", "beta"] }, fail);
  expect(first.proposals).toEqual([]);
  expect(first.failures.map((failure) => failure.scope)).toEqual(["alpha", "beta"]);
  expect(first.nextCursor).toBeString();
  expect(await loadProposalFeedPage({ sns: [] }, fail)).toEqual({ proposals: [], failures: [] });
});

test("result pages can exceed the upstream page cap without imposing a feed quota", async () => {
  const { read, calls } = reader({ alpha: Array.from({ length: 125 }, (_, index) => proposal(BigInt(125 - index), BigInt(125 - index))) });
  const page = await loadProposalFeedPage({ sns: ["alpha"], limit: 125 }, read);
  expect(page.proposals).toHaveLength(125);
  expect(page.nextCursor).toBeUndefined();
  expect(calls).toEqual([
    { sns: "alpha", limit: 100 }, { sns: "alpha", limit: 100, beforeProposal: 26n },
  ]);
});

test("an exactly full final upstream page finishes on its empty continuation", async () => {
  const { read, calls } = reader({ alpha: [proposal(2n, 20n), proposal(1n, 10n)] });
  const first = await loadProposalFeedPage({ sns: ["alpha"], limit: 2 }, read);
  expect(keys(first.proposals)).toEqual(["alpha/2", "alpha/1"]);
  const second = await loadProposalFeedPage({ sns: ["alpha"], limit: 2, cursor: first.nextCursor! }, read);
  expect(second).toEqual({ proposals: [], failures: [] });
  expect(calls.at(-1)?.beforeProposal).toBe(1n);
});

test("a stalled upstream continuation is reported without repeating rows or looping", async () => {
  const { read } = reader({ alpha: [proposal(2n, 20n), proposal(1n, 10n)] });
  const first = await loadProposalFeedPage({ sns: ["alpha"], limit: 1 }, read);
  let calls = 0;
  const stalled: ProposalFeedReader = async (params) => {
    calls += 1;
    return { proposals: [proposal(2n, 20n)], nextBefore: params.beforeProposal! };
  };
  const second = await loadProposalFeedPage({ sns: ["alpha"], cursor: first.nextCursor! }, stalled);
  expect(second.proposals).toEqual([]);
  expect(second.failures).toEqual([
    { scope: "alpha", code: "INTERNAL", message: "proposal page did not advance its continuation" },
  ]);
  expect(second.nextCursor).toBe(first.nextCursor);
  expect(calls).toBe(1);
  const recovered = await loadProposalFeedPage({ sns: ["alpha"], cursor: second.nextCursor! }, read);
  expect(keys(recovered.proposals)).toEqual(["alpha/1"]);
});

test("a cursor belongs to its SNS selection and malformed inputs fail before reads", async () => {
  const { read, calls } = reader({ alpha: [proposal(2n, 20n), proposal(1n, 10n)] });
  const page = await loadProposalFeedPage({ sns: ["alpha"], limit: 1 }, read);
  await expect(loadProposalFeedPage({ sns: ["beta"], cursor: page.nextCursor! }, read)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  for (const cursor of ["not json", "null", '{"version":9,"sources":[]}']) {
    await expect(loadProposalFeedPage({ sns: ["alpha"], cursor }, read)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    await expect(loadProposalFeedPage({ sns: ["alpha"], limit }, read)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  }
  expect(calls).toHaveLength(1);
});
