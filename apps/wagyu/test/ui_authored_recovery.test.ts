import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appendAuthoredPage } from "../src/app/feed_state.ts";
import type {
  AuthoredItem,
  AuthoredPage,
  AuthoredPost,
  AuthoredProtocolAction,
  PublishResult,
} from "../src/app/model.ts";
import { AuthoredPostsPanel } from "../src/app/components/FeedView.tsx";
import {
  parseAuthoredPage,
  resumeAuthoredActionThroughFinalizer,
  type PreparedAction,
} from "../src/app/service_adapter.ts";
import {
  closingWithdrawalPosts,
  continueWithdrawalUntilComplete,
} from "../src/app/withdrawal_progress.ts";

function authored(
  sequence: string,
  state: AuthoredPost["state"] = "live",
): AuthoredPost {
  return {
    sequence,
    kind: "post",
    postId: sequence.padStart(64, "0"),
    actionId: sequence.padStart(64, "0"),
    objectDigest: state === "awaiting-proof" ? "ab".repeat(32) : null,
    state,
    createdAt: "2026-07-24T00:00:00.000Z",
    bodyMarkdown: `Authored post ${sequence}`,
    replyTo: null,
  };
}

function authoredAction(
  sequence: string,
  kind: AuthoredProtocolAction["kind"],
  state: AuthoredProtocolAction["state"] = "awaiting-proof",
): AuthoredProtocolAction {
  return {
    sequence,
    kind,
    actionId: sequence.padStart(64, "0"),
    objectDigest: state === "awaiting-proof" ? "cd".repeat(32) : null,
    state,
    createdAt: "2026-07-24T00:00:00.000Z",
  };
}

function page(
  revision: string,
  items: AuthoredItem[],
  nextCursor: string | null,
): AuthoredPage {
  return { revision, items, nextCursor };
}

function publishResult(stage: PublishResult["stage"]): PublishResult {
  return {
    stage,
    postId: authored("1").postId,
    queuedRecipients: 0,
    queuedNotices: 0,
    acceptedRecipients: 0,
    failedRecipients: 0,
    message: stage,
  };
}

describe("authored recovery continuation", () => {
  test("appends a bounded older page without replacing loaded recovery rows", () => {
    const pending = authored("100", "awaiting-proof");
    const current = page("10", [pending, authored("90")], "90");
    const older = page(
      "11",
      [
        authored("90", "withdrawn"),
        authored("80", "withdrawal-closing"),
        authored("70"),
      ],
      "70",
    );

    const result = appendAuthoredPage(current, older, "90");
    expect(result.revision).toBe("11");
    expect(result.items.map((item) => item.sequence)).toEqual([
      "100",
      "90",
      "80",
      "70",
    ]);
    expect(result.items[0]).toBe(pending);
    expect(result.items[1]?.state).toBe("live");
    expect(result.nextCursor).toBe("70");
  });

  test("ignores delayed continuations after refresh or revision regression", () => {
    const current = page("12", [authored("120")], "100");
    const staleCursor = page("13", [authored("90")], null);
    const staleRevision = page("11", [authored("90")], null);

    expect(appendAuthoredPage(current, staleCursor, "90")).toBe(current);
    expect(appendAuthoredPage(current, staleRevision, "100")).toBe(current);
  });

  test("terminates a repeated or non-decreasing backend cursor", () => {
    const current = page("12", [authored("120")], "100");
    const repeated = page("12", [authored("90")], "100");
    const forward = page("12", [authored("90")], "101");

    expect(appendAuthoredPage(current, repeated, "100").nextCursor).toBeNull();
    expect(appendAuthoredPage(current, forward, "100").nextCursor).toBeNull();
  });

  test("rejects rows outside the cursor and duplicate kind/action identities", () => {
    const existing = authored("120");
    const duplicatePost = {
      ...authored("80"),
      postId: existing.postId,
      actionId: existing.actionId,
    };
    const current = page("12", [existing], "100");
    const older = page(
      "12",
      [authored("101"), authored("100"), authored("90"), duplicatePost],
      null,
    );

    expect(
      appendAuthoredPage(current, older, "100").items.map((item) => item.sequence),
    ).toEqual(["120", "90"]);
  });
});

describe("automatic bounded withdrawal continuation", () => {
  test("one UI operation drives every bounded closing page", async () => {
    const results: PublishResult[] = [
      publishResult("certified-ref-ready"),
      publishResult("withdrawal-closing"),
      publishResult("certified-ref-ready"),
      publishResult("complete"),
    ];
    let calls = 0;
    let yields = 0;

    const result = await continueWithdrawalUntilComplete({
      advance: async () => results[calls++]!,
      yieldBetween: async () => {
        yields += 1;
      },
    });

    expect(result.stage).toBe("complete");
    expect(calls).toBe(4);
    expect(yields).toBe(3);
  });

  test("cancellation and the protocol cap stop further calls safely", async () => {
    const controller = new AbortController();
    let cancelledCalls = 0;
    await expect(
      continueWithdrawalUntilComplete({
        signal: controller.signal,
        advance: async () => {
          cancelledCalls += 1;
          return publishResult("withdrawal-closing");
        },
        yieldBetween: async () => controller.abort(
          new Error("tile closed"),
        ),
      }),
    ).rejects.toThrow("tile closed");
    expect(cancelledCalls).toBe(1);

    let boundedCalls = 0;
    await expect(
      continueWithdrawalUntilComplete({
        maximumCalls: 3,
        advance: async () => {
          boundedCalls += 1;
          return publishResult("withdrawal-closing");
        },
        yieldBetween: async () => undefined,
      }),
    ).rejects.toThrow("protocol continuation bound");
    expect(boundedCalls).toBe(3);
  });

  test("reopening resumes closing rows but leaves proof recovery manual", () => {
    expect(
      closingWithdrawalPosts([
        authored("30", "live"),
        authored("20", "withdrawal-awaiting-proof"),
        authored("10", "withdrawal-closing"),
      ]).map((item) => item.postId),
    ).toEqual([authored("10").postId]);
  });
});

describe("authored page protocol preservation", () => {
  test("parses post, share, like, and tombstone rows without dropping actions", () => {
    const ids = [
      "11".repeat(32),
      "22".repeat(32),
      "33".repeat(32),
      "44".repeat(32),
    ] as const;
    const parsed = parseAuthoredPage({
      revision: "19",
      items: [
        {
          sequence: "104",
          action_kind: { post: null },
          action_id: ids[0],
          object_digest: "aa".repeat(32),
          state: "live",
          created_at_ns: "1784851200000000000",
          body_markdown: "A readable owner-local post.",
          reply_to: {
            author: "y2dvw-l7777-77774-aaabq-cai",
            post_id: "99".repeat(32),
          },
          local_like_view: {
            post_body_hash_hex: "ef".repeat(32),
            unsealed_receipt_count: 2,
            unsealed_liker_ids: [
              "ryjl3-tyaaa-aaaaa-aaaba-cai",
              "y2dvw-l7777-77774-aaabq-cai",
            ],
          },
        },
        {
          sequence: "103",
          action_kind: { share: null },
          action_id: ids[1],
          object_digest: "bb".repeat(32),
          state: "awaiting_proof",
          created_at_ns: "1784851200000000000",
          target_post_id: "91".repeat(32),
        },
        {
          sequence: "102",
          action_kind: { like: null },
          action_id: ids[2],
          object_digest: "cc".repeat(32),
          state: "certified",
          created_at_ns: "1784851200000000000",
          target_post_id: "92".repeat(32),
        },
        {
          sequence: "101",
          action_kind: { tombstone: null },
          action_id: ids[3],
          object_digest: "dd".repeat(32),
          state: "uncertain",
          created_at_ns: "1784851200000000000",
          target_post_id: "93".repeat(32),
        },
      ],
      next_before_sequence: "101",
    });

    expect(parsed.items.map((item) => item.kind)).toEqual([
      "post",
      "share",
      "like",
      "tombstone",
    ]);
    expect(parsed.items.map((item) => item.actionId)).toEqual(Array.from(ids));
    expect(parsed.items.map((item) => item.state)).toEqual([
      "live",
      "awaiting-proof",
      "certified",
      "uncertain",
    ]);
    expect(parsed.items[0]).toMatchObject({
      kind: "post",
      postId: ids[0],
      localLikeView: {
        postBodyHash: "ef".repeat(32),
        unsealedReceiptCount: 2,
        unsealedLikerIds: [
          "ryjl3-tyaaa-aaaaa-aaaba-cai",
          "y2dvw-l7777-77774-aaabq-cai",
        ],
        revision: "19",
      },
      bodyMarkdown: "A readable owner-local post.",
      replyTo: {
        authorNodeId: "y2dvw-l7777-77774-aaabq-cai",
        postId: "99".repeat(32),
      },
    });
    expect(parsed.items[1]).toMatchObject({
      kind: "share",
      targetPostId: "91".repeat(32),
    });
    expect(parsed.items[2]).toMatchObject({
      kind: "like",
      targetPostId: "92".repeat(32),
    });
    expect(parsed.items[3]).toMatchObject({
      kind: "tombstone",
      targetPostId: "93".repeat(32),
    });
    expect(parsed.nextCursor).toBe("101");
  });

  test("rejects malformed owner-local unsealed Like accounting", () => {
    expect(() =>
      parseAuthoredPage({
        revision: "19",
        items: [{
          sequence: "104",
          action_kind: { post: null },
          action_id: "11".repeat(32),
          object_digest: "aa".repeat(32),
          state: "live",
          created_at_ns: "1784851200000000000",
          local_like_view: {
            post_body_hash_hex: "ef".repeat(32),
            unsealed_receipt_count: 300,
          },
        }],
      }),
    ).toThrow("local Like accounting");
  });

  test("rejects predecessor authored aliases, option arrays, and scalar defaults", () => {
    const current = {
      sequence: "104",
      action_kind: { post: null },
      action_id: "11".repeat(32),
      object_digest: "aa".repeat(32),
      state: "live",
      created_at_ns: "1784851200000000000",
      body_markdown: "Current owner-local post.",
      reply_to: {
        author: "y2dvw-l7777-77774-aaabq-cai",
        post_id: "99".repeat(32),
      },
    };
    expect(() =>
      parseAuthoredPage({
        revision: "19",
        items: [{
          ...current,
          created_at: current.created_at_ns,
        }],
      })
    ).toThrow("unexpected field created_at");
    expect(() =>
      parseAuthoredPage({
        revision: "19",
        items: [{ ...current, created_at_ns: 1784851200 }],
      })
    ).toThrow("canonical Nat");
    expect(() =>
      parseAuthoredPage({
        revision: "19",
        items: [{ ...current, reply_to: [current.reply_to] }],
      })
    ).toThrow("reply locator");
    expect(() =>
      parseAuthoredPage({
        revision: 19,
        items: [current],
      })
    ).toThrow("canonical Nat");
    const { object_digest: _missing, ...missingDigest } = current;
    expect(() =>
      parseAuthoredPage({
        revision: "19",
        items: [missingDigest],
      })
    ).toThrow("object_digest");
  });

  test("routes every awaiting-proof kind through the same exact finalizer", async () => {
    const items: AuthoredItem[] = [
      authored("104", "awaiting-proof"),
      authoredAction("103", "share"),
      authoredAction("102", "like"),
      authoredAction("101", "tombstone"),
    ];
    const captured: PreparedAction[] = [];
    const stages: string[] = [];
    const finalized: PublishResult = {
      stage: "fanout-queued",
      postId: null,
      queuedRecipients: 1,
      queuedNotices: 0,
      acceptedRecipients: 0,
      failedRecipients: 0,
      message: "queued",
    };

    for (const item of items) {
      const result = await resumeAuthoredActionThroughFinalizer(
        item,
        "2vxsx-fae",
        async (prepared) => {
          captured.push(prepared);
          return finalized;
        },
        (stage) => stages.push(stage),
      );
      expect(result).toBe(finalized);
    }

    expect(captured.map((item) => item.kind)).toEqual([
      "post",
      "share",
      "like",
      "tombstone",
    ]);
    expect(captured.map((item) => item.actionId.byteLength)).toEqual([
      32,
      32,
      32,
      32,
    ]);
    expect(captured.map((item) => item.objectDigest.byteLength)).toEqual([
      32,
      32,
      32,
      32,
    ]);
    expect(stages).toEqual([
      "awaiting-proof",
      "fanout-queued",
      "awaiting-proof",
      "fanout-queued",
      "awaiting-proof",
      "fanout-queued",
      "awaiting-proof",
      "fanout-queued",
    ]);
  });

  test("never finalizes a row that is no longer awaiting proof", async () => {
    let called = false;
    await expect(
      resumeAuthoredActionThroughFinalizer(
        authoredAction("20", "like", "certified"),
        "2vxsx-fae",
        async () => {
          called = true;
          throw new Error("must not run");
        },
        () => undefined,
      ),
    ).rejects.toThrow("awaiting proof");
    expect(called).toBeFalse();
  });
});

describe("authored recovery panel", () => {
  const callbacks = {
    onWithdraw: () => undefined,
    onResumePost: () => undefined,
    onAdvanceWithdrawal: () => undefined,
    onOpenLikes: () => undefined,
  };

  test("keeps every unfinished action visible with ordinary continuation copy", () => {
    const html = renderToStaticMarkup(
      createElement(AuthoredPostsPanel, {
        ...callbacks,
        actionStages: new Map(),
        onLoadMore: () => undefined,
        onResumeAction: () => undefined,
        page: page(
          "12",
          [
            {
              ...authored("120", "awaiting-proof"),
              localLikeView: {
                postBodyHash: "ef".repeat(32),
                unsealedReceiptCount: 149,
                unsealedLikerIds: [],
                revision: "12",
              },
            },
            authored("110", "withdrawal-closing"),
            authoredAction("109", "share"),
            authoredAction("108", "like"),
            authoredAction("107", "tombstone"),
          ],
          "107",
        ),
      }),
    );

    expect(html).toContain("Finish sending");
    expect(html).toContain("Finish sharing");
    expect(html).toContain("Finish Like");
    expect(html).toContain("Finish deletion");
    expect(html).toContain("Continue deletion");
    expect(html).toContain("Load older posts");
    expect(html).toContain("149 recent likes");
    expect(html).toContain("ready to finish");
    expect(html).toContain("Authored post 120");
    expect(html).toContain('aria-label="Your post"');
    expect(html).toContain('class="wg-feed-card"');
    expect(html).toContain('data-kind="share"');
    expect(html).toContain('data-kind="like"');
    expect(html).toContain('data-kind="tombstone"');
    expect(html).not.toContain("Resume post proof");
    expect(html).not.toContain("awaiting certification");
  });

  test("does not expose post withdrawal controls on protocol-action rows", () => {
    const html = renderToStaticMarkup(
      createElement(AuthoredPostsPanel, {
        ...callbacks,
        actionStages: new Map(),
        onResumeAction: () => undefined,
        page: page(
          "12",
          [
            authoredAction("109", "share", "certified"),
            authoredAction("108", "like", "failed"),
            authoredAction("107", "tombstone", "uncertain"),
          ],
          null,
        ),
      }),
    );

    expect(html).toContain("could not finish");
    expect(html).toContain("checking status");
    expect(html).not.toContain('data-kind="share"');
    expect(html).toContain('data-kind="like"');
    expect(html).toContain('data-kind="tombstone"');
    expect(html).not.toContain(">Withdraw</button>");
  });

  test("disables continuation while an older authored page is in flight", () => {
    const html = renderToStaticMarkup(
      createElement(AuthoredPostsPanel, {
        ...callbacks,
        actionStages: new Map(),
        loadingMore: true,
        onLoadMore: () => undefined,
        page: page("12", [authored("120")], "120"),
      }),
    );

    expect(html).toContain("Loading older posts…");
    expect(html).toContain("disabled");
  });
});
