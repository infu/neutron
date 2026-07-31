import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import type { JsonObject, JsonValue } from "neutron-tools/app";
import {
  hydrateRelationshipProfileWithLoader,
  parsePeerDeliveryEnabled,
  parseProfile,
  parseSendQuote,
  parseStatus,
} from "../src/app/service_adapter.ts";
import {
  GOLDEN_ACTOR_A,
  GOLDEN_ACTOR_B,
} from "../candid/fixtures/v1-values.ts";

test("relationship presentation uses only the certified profile loader", async () => {
  const relationship = {
    nodeId: "2vxsx-fae",
    displayName: null,
    avatarUrl: null,
    profileProof: "loading" as const,
    youFollow: true,
    followsYou: false,
    followingState: "active" as const,
    followerState: null,
    followerCredits: 0,
    followerLeaseExpiresAt: null,
    followingRenewalRequested: false,
    renewalCostCycles: "7000000000",
    protocolVersion: "wagyu_v1",
    compatible: true,
    blocked: false,
  };
  const hydrated = await hydrateRelationshipProfileWithLoader(
    relationship,
    async (nodeId, fallback) => {
      expect(nodeId).toBe(relationship.nodeId);
      expect(fallback.displayName).toBe("");
      expect(fallback.avatarUrl).toBeNull();
      return {
        ...fallback,
        displayName: "Certified name",
        avatarUrl: "blob:certified-avatar",
        proofState: "fresh",
      };
    },
  );
  expect(hydrated).toEqual({
    ...relationship,
    displayName: "Certified name",
    avatarUrl: "blob:certified-avatar",
    profileProof: "fresh",
  });
});

test("ordinary self-call status reads the exact current WagyuStatusV1", () => {
  expect(parseStatus(status()).configuredNetworkId).toBe("5a".repeat(32));
});

test("ordinary self-call profile reads the exact current ProfileViewV1", () => {
  const profile = parseProfile({
    node: "2vxsx-fae",
    network_id: "5a".repeat(32),
    profile_generation: "1",
    revision: "2",
    updated_at_ns: "3",
    display_name: "Ada",
    description: "Current profile",
    avatar_present: true,
    avatar_media_type: { png: null },
    avatar_width: 1,
    avatar_height: 1,
    protocol: "wagyu_v1",
    compatible: true,
  });

  expect(profile).toMatchObject({
    nodeId: "2vxsx-fae",
    profileGeneration: "1",
    revision: "2",
    displayName: "Ada",
    description: "Current profile",
    avatarUrl: null,
    avatar: null,
    protocolVersion: "wagyu_v1",
    compatible: true,
  });
});

test("current status and profile readers reject predecessor/default shapes", () => {
  expect(() =>
    parseStatus({
      ...status(),
      network_id: Array.from(new Uint8Array(32).fill(0x2a)),
    })
  ).toThrow("network ID");
  expect(() =>
    parseStatus({
      ...status(),
      network_id: new Uint8Array(32).fill(0x2a),
    })
  ).toThrow("network ID");
  expect(() =>
    parseStatus({
      ...status(),
      configured_network_id: "5a".repeat(32),
    })
  ).toThrow("unexpected field");
  const { profile_generation: _missing, ...missingRequired } = status();
  expect(() => parseStatus(missingRequired)).toThrow("profile_generation");
  expect(() =>
    parseStatus({
      ...status(),
      unread_feed_count: 0,
    })
  ).toThrow("canonical Nat");
  expect(() =>
    parseProfile({
      node: "2vxsx-fae",
      network_id: "5a".repeat(32),
      profile_generation: "1",
      revision: "2",
      updated_at_ns: "3",
      display_name: "Ada",
      description: "Current profile",
      avatar_present: true,
      avatar_media_type: [{ png: null }],
      avatar_width: [1],
      avatar_height: [1],
      protocol: "wagyu_v1",
      compatible: true,
    })
  ).toThrow("avatar media type");
});

test("peer delivery state comes only from the exact method reservation", () => {
  const reservation = {
    id: "1",
    appId: "wagyu",
    scopeKind: "method",
    principal: null,
    method: "app_wagyu__wagyu_v1_update",
    createdAt: "1",
    createdBy: "owner",
  };
  expect(
    parsePeerDeliveryEnabled({ reservations: [reservation] }),
  ).toBeTrue();
  expect(
    parsePeerDeliveryEnabled({
      reservations: [{ ...reservation, method: "another_method" }],
    }),
  ).toBeFalse();
  expect(() =>
    parsePeerDeliveryEnabled({
      reservations: [reservation, { ...reservation, id: "2" }],
    })
  ).toThrow("duplicated");
  expect(() =>
    parsePeerDeliveryEnabled({
      reservations: [{ ...reservation, principal: "2vxsx-fae" }],
    })
  ).toThrow("scope");
});

test("send quote keeps only the backend-authoritative canonical recipient preview", () => {
  const recipients = [GOLDEN_ACTOR_A, GOLDEN_ACTOR_B]
    .sort((left, right) => left.compareTo(right) === "lt" ? -1 : 1)
    .map((principal) => principal.toText());
  const quote = parseSendQuote(sendQuote({
    eligible_delivery_count: 3,
    eligible_recipient_preview: recipients,
  }));

  expect(quote.eligibleRecipients).toBe(3);
  expect(quote.recipientPreview).toEqual(recipients);
});

test("send quote rejects recipient previews outside backend protocol bounds", () => {
  const ascending = [GOLDEN_ACTOR_A, GOLDEN_ACTOR_B]
    .sort((left, right) => left.compareTo(right) === "lt" ? -1 : 1)
    .map((principal) => principal.toText());

  expect(() =>
    parseSendQuote(sendQuote({
      eligible_delivery_count: 1,
      eligible_recipient_preview: ascending,
    }))
  ).toThrow("eligible recipient count");
  expect(() =>
    parseSendQuote(sendQuote({
      eligible_recipient_preview: Array.from(
        { length: 9 },
        (_, index) =>
          Principal.fromUint8Array(
            Uint8Array.of(index + 1, 0x01),
          ).toText(),
      ),
    }))
  ).toThrow("exceeded 8 nodes");
  expect(() =>
    parseSendQuote(sendQuote({
      eligible_recipient_preview: [
        ascending[0]!,
        ascending[0]!,
      ],
    }))
  ).toThrow("order is invalid");
  expect(() =>
    parseSendQuote(sendQuote({
      eligible_recipient_preview: [...ascending].reverse(),
    }))
  ).toThrow("order is invalid");
  expect(() =>
    parseSendQuote(sendQuote({
      eligible_recipient_preview: ["2vxsx-fae"],
    }))
  ).toThrow("invalid Node ID");
});

function sendQuote(
  overrides: Record<string, JsonValue> = {},
): JsonObject {
  return {
    follower_revision: "7",
    registered_follower_count: 4,
    eligible_delivery_count: 4,
    ineligible_follower_count: 0,
    eligible_recipient_preview: [],
    receiver_floor_cycles: "1",
    author_notice_floor_cycles: "2",
    estimated_call_and_byte_cycles: "3",
    estimated_local_publication_cycles: "4",
    estimated_total_cycles: "10",
    ...overrides,
  };
}

function status(): JsonObject {
  return {
    node: "2vxsx-fae",
    network_id: "5a".repeat(32),
    protocol: "wagyu_v1",
    profile_generation: "1",
    profile_revision: "2",
    state_revision: "3",
    feed_revision: "4",
    notification_revision: "5",
    relationship_revision: "6",
    unread_feed_count: "7",
    unread_notification_count: "8",
    outbound_work_pending: false,
    outbox_queued_count: "9",
    outbox_error_count: "10",
    outbox_paused: false,
    certified_assets_ready: true,
  };
}
