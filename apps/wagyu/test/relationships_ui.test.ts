import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RelationshipsView } from "../src/app/components/RelationshipsView.tsx";
import { parseRelationship } from "../src/app/service_adapter.ts";

const NODE = "2vxsx-fae";

function relationshipRecord(renewalRequested = false) {
  return {
    node: NODE,
    following: true,
    follower: false,
    following_state: { active: null },
    follower_delivery_credits: 0,
    following_renewal_requested: renewalRequested,
    following_auto_renew_due: false,
    blocked: false,
    bond_cycles: "7000000000",
    protocol: "wagyu_v1",
    compatible: true,
  };
}

describe("relationship renewal presentation", () => {
  test("parses the exact current remote renewal request", () => {
    expect(
      parseRelationship(relationshipRecord(true))
        .followingRenewalRequested,
    ).toBeTrue();
    expect(
      parseRelationship(relationshipRecord(false))
        .followingRenewalRequested,
    ).toBeFalse();
  });

  test("rejects missing required fields and predecessor optional shapes", () => {
    const { compatible: _missing, ...missingRequired } = relationshipRecord();
    expect(() => parseRelationship(missingRequired)).toThrow("compatible");
    expect(() =>
      parseRelationship({
        ...relationshipRecord(),
        follower_state: [],
      })
    ).toThrow("relationship state");
    expect(() =>
      parseRelationship({
        ...relationshipRecord(),
        follower_lease_expires_ns: ["1784851200000000000"],
      })
    ).toThrow("canonical Nat");
    const {
      following_renewal_requested: _missingRenewal,
      ...missingRenewal
    } = relationshipRecord();
    expect(() => parseRelationship(missingRenewal)).toThrow(
      "following_renewal_requested",
    );
  });

  test("keeps automatic renewal state out of the interface", () => {
    const relationship = parseRelationship(relationshipRecord(true));
    const html = renderToStaticMarkup(
      createElement(RelationshipsView, {
        relationships: [relationship],
        busy: null,
        error: null,
        hasMore: false,
        loadingMore: false,
        onFollow: async () => undefined,
        onLoadMore: () => undefined,
        onUnfollow: async () => undefined,
        onSetBlocked: async () => undefined,
      }),
    );

    expect(html).not.toContain("is-renewal-requested");
    expect(html).not.toContain("Remote renewal requested");
    expect(html).not.toContain("Renew now");
    expect(html).not.toContain(`Renew following registration with ${NODE}`);
  });

  test("does not expose manual renewal without a remote request", () => {
    const relationship = parseRelationship(relationshipRecord(false));
    const html = renderToStaticMarkup(
      createElement(RelationshipsView, {
        relationships: [relationship],
        busy: null,
        error: null,
        hasMore: false,
        loadingMore: false,
        onFollow: async () => undefined,
        onLoadMore: () => undefined,
        onUnfollow: async () => undefined,
        onSetBlocked: async () => undefined,
      }),
    );

    expect(html).not.toContain("is-renewal-requested");
    expect(html).not.toContain("Remote renewal requested");
    expect(html).not.toContain(">Renew</button>");
  });

  test("uses user language while keeping relationship directions and IDs explicit", () => {
    const relationship = parseRelationship(relationshipRecord(false));
    const html = renderToStaticMarkup(
      createElement(RelationshipsView, {
        relationships: [relationship],
        busy: null,
        error: null,
        hasMore: false,
        loadingMore: false,
        onFollow: async () => undefined,
        onLoadMore: () => undefined,
        onUnfollow: async () => undefined,
        onSetBlocked: async () => undefined,
      }),
    );
    expect(html).toContain("<h2");
    expect(html).toContain("Follow user");
    expect(html).toContain(
      "Enter the exact user id. Registration attaches a 0.007000 TC bond and prepays 32 delivery credits.",
    );
    expect(html).toContain("You follow");
    expect(html).toContain("Does not follow you");
    expect(html).toContain("user id");
    expect(html).toContain(`aria-label="Copy user ID ${NODE}"`);
    expect(html).not.toContain("Wagyu node");
    expect(html).not.toContain("canister principal");
    expect(html).not.toContain('aria-label="Refresh');
  });

  test("guards follow controls for an incompatible user", () => {
    const relationship = {
      ...parseRelationship(relationshipRecord(false)),
      youFollow: false,
      compatible: false,
      followingState: "incompatible" as const,
    };
    const html = renderToStaticMarkup(
      createElement(RelationshipsView, {
        relationships: [relationship],
        busy: null,
        error: null,
        hasMore: false,
        loadingMore: false,
        onFollow: async () => undefined,
        onLoadMore: () => undefined,
        onUnfollow: async () => undefined,
        onSetBlocked: async () => undefined,
      }),
    );
    expect(html).toContain(
      'disabled="" title="This user cannot connect to this version of Wagyu"',
    );
    expect(html).toContain('type="button">Follow</button>');
  });

  test("keeps new follows locked until peer delivery is enabled", () => {
    const relationship = parseRelationship(relationshipRecord(false));
    const html = renderToStaticMarkup(
      createElement(RelationshipsView, {
        relationships: [relationship],
        busy: null,
        error: null,
        hasMore: false,
        loadingMore: false,
        peerDeliveryEnabled: false,
        onFollow: async () => undefined,
        onLoadMore: () => undefined,
        onUnfollow: async () => undefined,
        onSetBlocked: async () => undefined,
      }),
    );
    expect(html).toContain(
      'title="Enable peer delivery before following a user."',
    );
    expect(html).not.toContain(">Renew</button>");
    expect(html).toContain(">Unfollow</button>");
  });
});
