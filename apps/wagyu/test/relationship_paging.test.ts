import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RelationshipsView } from "../src/app/components/RelationshipsView.tsx";
import {
  applyRelationshipProfileHydration,
  appendRelationshipPage,
  invalidateRelationshipContinuation,
  markRelationshipProfileUnavailable,
} from "../src/app/relationship_state.ts";
import {
  parseRelationshipPage,
} from "../src/app/service_adapter.ts";

const FIRST = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const SECOND = "rrkah-fqaaa-aaaaa-aaaaq-cai";

describe("relationship page boundary", () => {
  test("retains the revision and exact continuation node", () => {
    const page = parseRelationshipPage({
      revision: "7",
      items: [relationship(FIRST), relationship(SECOND)],
      next_before_node: SECOND,
    });
    expect(page.revision).toBe("7");
    expect(page.items.map((item) => item.nodeId)).toEqual([FIRST, SECOND]);
    expect(page.nextCursor).toBe(SECOND);
  });

  test("rejects oversized, duplicate, and detached cursors", () => {
    expect(() =>
      parseRelationshipPage({
        revision: "1",
        items: Array.from({ length: 51 }, () => relationship(FIRST)),
      })
    ).toThrow("exceeded 50 rows");
    expect(() =>
      parseRelationshipPage({
        revision: "1",
        items: [relationship(FIRST), relationship(FIRST)],
      })
    ).toThrow("invalid Node ID");
    expect(() =>
      parseRelationshipPage({
        revision: "1",
        items: [relationship(FIRST)],
        next_before_node: SECOND,
      })
    ).toThrow("cursor is invalid");
    expect(() =>
      parseRelationshipPage({
        revision: "1",
        items: [relationship(SECOND), relationship(FIRST)],
      })
    ).toThrow("order is invalid");
  });

  test("appends only a pinned, non-overlapping continuation", () => {
    const first = parseRelationshipPage({
      revision: "9",
      items: [relationship(FIRST)],
      next_before_node: FIRST,
    });
    const older = parseRelationshipPage({
      revision: "9",
      items: [relationship(SECOND)],
    });
    expect(appendRelationshipPage(first, older, FIRST)).toEqual({
      revision: "9",
      items: [first.items[0]!, older.items[0]!],
      nextCursor: null,
    });
    expect(() =>
      appendRelationshipPage(first, { ...older, revision: "10" }, FIRST)
    ).toThrow("changed");
    expect(() =>
      appendRelationshipPage(
        first,
        { ...older, items: first.items },
        FIRST,
      )
    ).toThrow("repeated");
  });

  test("exposes an explicit bounded continuation control", () => {
    const html = renderToStaticMarkup(
      createElement(RelationshipsView, {
        relationships: [parseRelationshipPage({
          revision: "1",
          items: [relationship(FIRST)],
        }).items[0]!],
        busy: null,
        refreshing: false,
        error: null,
        hasMore: true,
        loadingMore: false,
        onFollow: async () => undefined,
        onLoadMore: () => undefined,
        onUnfollow: async () => undefined,
        onSetBlocked: async () => undefined,
        onRefresh: async () => undefined,
      }),
    );
    expect(html).toContain("Load older relationships");
  });

  test("invalidates a pre-mutation continuation without inventing rows", () => {
    const page = parseRelationshipPage({
      revision: "9",
      items: [relationship(FIRST)],
      next_before_node: FIRST,
    });
    const invalidated = invalidateRelationshipContinuation(page);
    expect(invalidated).toEqual({ ...page, nextCursor: null });
    expect(invalidated.items[0]).toBe(page.items[0]);
  });

  test("discards stale profile hydration without changing relationship rows", () => {
    const page = parseRelationshipPage({
      revision: "9",
      items: [relationship(FIRST)],
    });
    const stale = applyRelationshipProfileHydration(
      page,
      "8",
      FIRST,
      {
        displayName: "Stale name",
        avatarUrl: "blob:stale",
        profileProof: "fresh",
      },
    );
    expect(stale).toBe(page);
    expect(stale.items[0]?.displayName).toBeNull();
  });

  test("isolates profile failure from authoritative graph state", () => {
    const page = parseRelationshipPage({
      revision: "9",
      items: [relationship(FIRST), relationship(SECOND)],
    });
    const failed = markRelationshipProfileUnavailable(page, "9", FIRST);
    expect(failed.items[0]).toMatchObject({
      nodeId: FIRST,
      youFollow: true,
      followsYou: false,
      followingState: "active",
      displayName: null,
      avatarUrl: null,
      profileProof: "unavailable",
    });
    expect(failed.items[1]).toBe(page.items[1]);
    expect(failed.nextCursor).toBe(page.nextCursor);
  });

  test("rejects fields and optional encodings outside the current relationship shape", () => {
    expect(() =>
      parseRelationshipPage({
        revision: "9",
        items: [{
          ...relationship(FIRST),
          profile: {
            display_name: "Unverified assertion",
          },
        }],
      })
    ).toThrow("unexpected field profile");
    expect(() =>
      parseRelationshipPage({
        revision: "9",
        items: [relationship(FIRST)],
        next_before_node: [FIRST],
      })
    ).toThrow("principal text");
    expect(() =>
      parseRelationshipPage({
        revision: 9,
        items: [relationship(FIRST)],
      })
    ).toThrow("canonical Nat");
  });
});

function relationship(node: string) {
  return {
    node,
    following: true,
    follower: false,
    following_state: { active: null },
    follower_delivery_credits: 0,
    following_renewal_requested: false,
    following_auto_renew_due: false,
    blocked: false,
    bond_cycles: "7000000000",
    protocol: "wagyu_v1",
    compatible: true,
  };
}
