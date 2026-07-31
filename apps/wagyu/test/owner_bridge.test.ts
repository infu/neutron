import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import {
  WAGYU_OWNER_BRIDGE_CONTRACTS,
  WAGYU_OWNER_BRIDGE_METHODS,
  WagyuOwnerBridge,
  buildBlockStatusesSelfRequest,
  buildFeedPromoteSelfRequest,
  buildFinalizeSelfRequest,
  buildFollowSelfRequest,
  buildLikePrepareSelfRequest,
  buildNotificationEvidenceSelfRequest,
  buildNotificationPromoteSelfRequest,
  buildPostPrepareSelfRequest,
  buildProfileEditSelfRequest,
  buildSharePrepareSelfRequest,
  buildTombstonePrepareSelfRequest,
  buildWithdrawalAdvanceSelfRequest,
  decodeFeedPageSelfResponse,
  decodeNotificationEvidenceSelfResponse,
  decodeNotificationPageSelfResponse,
  parseBlockStatusesSelfResponse,
  parseProfileEditSelfResult,
  parsePublishSelfResult,
  type WagyuOwnerSelfCallTransport,
} from "../src/app/owner_bridge.ts";
import {
  WAGYU_CODECS,
  WAGYU_IDL,
  lowerHex,
  sha256Exact,
} from "../src/protocol/index.ts";
import type {
  JsonValue,
  SelfCallValue,
} from "neutron-tools/app";
import {
  GOLDEN_ACTOR_A,
  GOLDEN_ACTOR_B,
  buildGoldenPackageValues,
} from "../candid/fixtures/v1-values.ts";

const HEX_16 = "0a".repeat(16);
const HEX_32 = "0b".repeat(32);
const OTHER_HEX_32 = "0c".repeat(32);

const EXPECTED_MATRIX = [
  ["wagyu_feed_page_self_v1", "query", 0, 614_400],
  ["wagyu_notification_page_self_v1", "query", 0, 131_072],
  ["wagyu_notification_evidence_self_v1", "query", 0, 8_192],
  ["wagyu_block_statuses_self_v1", "query", 0, 0],
  ["wagyu_profile_edit_v1", "update", 262_144, 0],
  ["wagyu_follow_self_v1", "update", 0, 0],
  ["wagyu_post_prepare_self_v1", "update", 0, 0],
  ["wagyu_share_prepare_self_v1", "update", 16_384, 0],
  ["wagyu_like_prepare_self_v1", "update", 0, 0],
  ["wagyu_tombstone_prepare_self_v1", "update", 0, 0],
  ["wagyu_post_finalize_self_v1", "update", 5_500, 0],
  ["wagyu_share_finalize_self_v1", "update", 5_500, 0],
  ["wagyu_like_finalize_self_v1", "update", 5_500, 0],
  ["wagyu_tombstone_finalize_self_v1", "update", 5_500, 0],
  ["wagyu_feed_promote_self_v1", "update", 0, 0],
  ["wagyu_feed_reject_self_v1", "update", 0, 0],
  ["wagyu_notification_promote_self_v1", "update", 0, 0],
  ["wagyu_like_seal_self_v1", "update", 0, 0],
  ["wagyu_withdrawal_advance_self_v1", "update", 0, 0],
] as const;

test("owner bridge freezes the approved nineteen-method self-call matrix", () => {
  const methodNames = Object.values(WAGYU_OWNER_BRIDGE_METHODS);
  expect(methodNames).toHaveLength(19);
  expect(new Set(methodNames).size).toBe(19);
  const actual = methodNames.map((name) => {
      const contract = WAGYU_OWNER_BRIDGE_CONTRACTS[name];
      return [
        name,
        contract.mode,
        contract.maxInputBlobBytes,
        contract.maxOutputBlobBytes,
      ];
    });
  expect(actual).toEqual(EXPECTED_MATRIX.map((row) => [...row]));
});

describe("normalized owner update builders", () => {
  test("binary identifiers become exact lowercase fixed-width hex", () => {
    const follow = buildFollowSelfRequest({
      node: GOLDEN_ACTOR_A,
      subscription_id: Uint8Array.from({ length: 16 }, () => 0x0a),
    });
    expect(follow).toEqual({
      node: GOLDEN_ACTOR_A.toText(),
      subscription_id_hex: HEX_16,
    });

    const post = buildPostPrepareSelfRequest({
      body_markdown: "exact post",
      nonce: HEX_16,
      reply_to: {
        author: GOLDEN_ACTOR_A,
        post_id: HEX_32,
        body_hash: OTHER_HEX_32,
        body_length: 42,
        object_digest: new Uint8Array(32).fill(0x0d),
      },
    });
    expect(post).toEqual({
      body_markdown: "exact post",
      nonce_hex: HEX_16,
      reply_to: {
        author: GOLDEN_ACTOR_A.toText(),
        post_id_hex: HEX_32,
        body_hash_hex: OTHER_HEX_32,
        body_length: 42,
        object_digest_hex: "0d".repeat(32),
      },
    });

    expect(
      buildLikePrepareSelfRequest({
        post_author: GOLDEN_ACTOR_A,
        post_id: HEX_32,
        post_body_hash: OTHER_HEX_32,
        post_object_digest: null,
        nonce: HEX_16,
      }),
    ).toEqual({
      post_author: GOLDEN_ACTOR_A.toText(),
      post_id_hex: HEX_32,
      post_body_hash_hex: OTHER_HEX_32,
      nonce_hex: HEX_16,
    });

    expect(
      buildTombstonePrepareSelfRequest({
        post_id: HEX_32,
        nonce: HEX_16,
      }),
    ).toEqual({ post_id_hex: HEX_32, nonce_hex: HEX_16 });
    expect(
      buildWithdrawalAdvanceSelfRequest({
        post_id: HEX_32,
        nonce: HEX_16,
      }),
    ).toEqual({ post_id_hex: HEX_32, nonce_hex: HEX_16 });
  });

  test("already textual identifiers must be lowercase, canonical, and exact", () => {
    expect(() =>
      buildFollowSelfRequest({
        node: GOLDEN_ACTOR_A,
        subscription_id: HEX_16.toUpperCase(),
      })
    ).toThrow("lowercase");
    expect(() =>
      buildFeedPromoteSelfRequest({
        candidate_id: "ab",
        verified_author: GOLDEN_ACTOR_A,
        verified_post_id: HEX_32,
        verified_body_hash: OTHER_HEX_32,
        verified_object_digest: HEX_32,
      })
    ).toThrow("64 lowercase");
    expect(() =>
      buildNotificationEvidenceSelfRequest({ local_sequence: "01" })
    ).toThrow("canonical decimal");
  });

  test("icblast-bound optionals omit absence and use direct present values", () => {
    expect(
      buildNotificationPromoteSelfRequest({
        local_sequence: 7n,
        disposition: "verified",
      }),
    ).toEqual({
      local_sequence: "7",
      disposition: { verified: null },
    });
    expect(
      buildNotificationPromoteSelfRequest({
        local_sequence: 7n,
        disposition: null,
      }),
    ).toEqual({ local_sequence: "7" });
    expect(
      buildNotificationPromoteSelfRequest({
        local_sequence: 8n,
        disposition: "verified",
        verified_reply: {
          author: GOLDEN_ACTOR_A,
          post_id: HEX_32,
          body_hash: OTHER_HEX_32,
          body_length: 128,
          object_digest: HEX_32,
          reply_to: {
            author: GOLDEN_ACTOR_B,
            post_id: OTHER_HEX_32,
            body_hash: HEX_32,
            body_length: 256,
            object_digest: OTHER_HEX_32,
          },
        },
      }),
    ).toEqual({
      local_sequence: "8",
      disposition: { verified: null },
      verified_reply: {
        author: GOLDEN_ACTOR_A.toText(),
        post_id_hex: HEX_32,
        body_hash_hex: OTHER_HEX_32,
        body_length: 128,
        object_digest_hex: HEX_32,
        reply_to: {
          author: GOLDEN_ACTOR_B.toText(),
          post_id_hex: OTHER_HEX_32,
          body_hash_hex: HEX_32,
          body_length: 256,
          object_digest_hex: OTHER_HEX_32,
        },
      },
    });
  });
});

describe("exact Block status owner query", () => {
  test("deduplicates by rejecting ambiguous requests and binds response order", () => {
    const request = buildBlockStatusesSelfRequest({
      nodes: [GOLDEN_ACTOR_A, GOLDEN_ACTOR_B],
    });
    expect(request).toEqual({
      nodes: [GOLDEN_ACTOR_A.toText(), GOLDEN_ACTOR_B.toText()],
    });
    expect(
      parseBlockStatusesSelfResponse(request, {
        relationship_revision: "7",
        items: [
          { node: GOLDEN_ACTOR_A.toText(), blocked: false },
          { node: GOLDEN_ACTOR_B.toText(), blocked: true },
        ],
      }),
    ).toEqual({
      relationship_revision: "7",
      items: [
        { node: GOLDEN_ACTOR_A.toText(), blocked: false },
        { node: GOLDEN_ACTOR_B.toText(), blocked: true },
      ],
    });
    expect(() =>
      buildBlockStatusesSelfRequest({
        nodes: [GOLDEN_ACTOR_A, GOLDEN_ACTOR_A],
      })
    ).toThrow("duplicate");
    expect(() =>
      buildBlockStatusesSelfRequest({ nodes: [] })
    ).toThrow("between 1 and 500");
    expect(() =>
      buildBlockStatusesSelfRequest({
        nodes: Array.from({ length: 501 }, () => GOLDEN_ACTOR_A),
      })
    ).toThrow("between 1 and 500");
    expect(() =>
      parseBlockStatusesSelfResponse(request, {
        relationship_revision: "7",
        items: [
          { node: GOLDEN_ACTOR_B.toText(), blocked: false },
          { node: GOLDEN_ACTOR_A.toText(), blocked: true },
        ],
      })
    ).toThrow("reordered");
    expect(() =>
      parseBlockStatusesSelfResponse(request, {
        relationship_revision: "01",
        items: [
          { node: GOLDEN_ACTOR_A.toText(), blocked: false },
          { node: GOLDEN_ACTOR_B.toText(), blocked: true },
        ],
      })
    ).toThrow("canonical");
    expect(() =>
      parseBlockStatusesSelfResponse(request, {
        relationship_revision: "7",
        items: [
          { node: GOLDEN_ACTOR_A.toText(), blocked: "false" },
          { node: GOLDEN_ACTOR_B.toText(), blocked: true },
        ],
      })
    ).toThrow("boolean");
  });

  test("bridge uses the approved query transport", async () => {
    const transport = new FixtureTransport();
    const bridge = new WagyuOwnerBridge(transport);
    transport.queryValue = {
      relationship_revision: "9",
      items: [{ node: GOLDEN_ACTOR_A.toText(), blocked: true }],
    };
    await expect(
      bridge.blockStatuses({ nodes: [GOLDEN_ACTOR_A] }),
    ).resolves.toEqual({
      relationship_revision: "9",
      items: [{ node: GOLDEN_ACTOR_A.toText(), blocked: true }],
    });
    expect(transport.calls).toEqual([{
      kind: "query",
      method: WAGYU_OWNER_BRIDGE_METHODS.blockStatuses,
      request: { nodes: [GOLDEN_ACTOR_A.toText()] },
    }]);
  });
});

describe("exact nested Candid bytes", () => {
  test("share prepare validates but never re-encodes a compatible post ref", () => {
    const postRef = buildGoldenPackageValues().CertifiedPostRefV1;
    const ExtendedCertifiedPostRefV1 = IDL.Record({
      author: IDL.Principal,
      post_id: IDL.Vec(IDL.Nat8),
      body_hash: IDL.Vec(IDL.Nat8),
      body_length: IDL.Nat32,
      object_digest: IDL.Vec(IDL.Nat8),
      proof: WAGYU_IDL.CertifiedHttpProofV1,
      future_hint: IDL.Opt(IDL.Text),
    });
    const exact = IDL.encode(
      [ExtendedCertifiedPostRefV1],
      [{ ...postRef, future_hint: ["preserve-me"] }],
    );
    const call = buildSharePrepareSelfRequest({
      nonce: null,
      exact_original_post_ref_candid: exact,
    });
    const firstByte = call.request.exact_original_post_ref_candid[0]!;
    exact[0] = exact[0]! ^ 0xff;

    expect(call.request.exact_original_post_ref_candid[0]).toBe(firstByte);
    expect(call.decoded.exact_bytes[0]).toBe(firstByte);
    expect(call.request.exact_original_post_ref_candid.byteLength).not.toBe(
      WAGYU_CODECS.CertifiedPostRefV1.encode(postRef).byteLength,
    );
  });

  test("finalize validates but never re-encodes a compatible proof", () => {
    const proof = buildGoldenPackageValues().CertifiedHttpProofV1;
    const ExtendedCertifiedHttpProofV1 = IDL.Record({
      certificate_version: IDL.Nat8,
      certificate_cbor: IDL.Vec(IDL.Nat8),
      witness_cbor: IDL.Vec(IDL.Nat8),
      expression_path_cbor: IDL.Vec(IDL.Nat8),
      certificate_time_ns: IDL.Nat64,
      future_hint: IDL.Opt(IDL.Text),
    });
    const exact = IDL.encode(
      [ExtendedCertifiedHttpProofV1],
      [{ ...proof, future_hint: ["preserve-me"] }],
    );
    const call = buildFinalizeSelfRequest({
      action_id: HEX_32,
      object_digest: OTHER_HEX_32,
      exact_proof_candid: exact,
    });

    expect(call.request).toEqual({
      action_id_hex: HEX_32,
      object_digest_hex: OTHER_HEX_32,
      exact_proof_candid: exact,
    });
    expect(Array.from(call.request.exact_proof_candid)).toEqual(
      Array.from(exact),
    );
    expect(Array.from(call.decoded.exact_bytes)).toEqual(Array.from(exact));
    expect(call.request.exact_proof_candid.byteLength).not.toBe(
      WAGYU_CODECS.CertifiedHttpProofV1.encode(proof).byteLength,
    );
  });

  test("wrong nested Candid types fail before transport", () => {
    const postBody = WAGYU_CODECS.PostBodyV1.encode(
      buildGoldenPackageValues().PostBodyV1,
    );
    expect(() =>
      buildFinalizeSelfRequest({
        action_id: HEX_32,
        object_digest: OTHER_HEX_32,
        exact_proof_candid: postBody,
      })
    ).toThrow();
  });
});

describe("profile edit nested avatar boundary", () => {
  test("profile request and result options use omitted-or-direct projection", () => {
    expect(
      buildProfileEditSelfRequest({
        expected_profile_generation: 1n,
        expected_revision: 2n,
        display_name: "Alice",
        description: "Exact profile",
        avatar: null,
      }),
    ).toEqual({
      expected_profile_generation: "1",
      expected_revision: "2",
      display_name: "Alice",
      description: "Exact profile",
    });
    expect(parseProfileEditSelfResult({})).toEqual({
      outcome: null,
    });
    expect(
      parseProfileEditSelfResult({
        outcome: { rejected: {} },
      }),
    ).toEqual({
      outcome: { rejected: { reason: null } },
    });
    expect(
      parseProfileEditSelfResult({
        outcome: { rejected: { reason: { invalid: null } } },
      }),
    ).toEqual({
      outcome: { rejected: { reason: "invalid" } },
    });
    expect(() =>
      parseProfileEditSelfResult({ outcome: null })
    ).toThrow("omitted or contain one direct");
    expect(() =>
      parseProfileEditSelfResult({
        outcome: [{ rejected: {} }],
      })
    ).toThrow("omitted or contain one direct");
    expect(() =>
      parseProfileEditSelfResult({
        outcome: { rejected: { reason: null } },
      })
    ).toThrow("omitted or contain one direct");
    expect(() =>
      parseProfileEditSelfResult({
        outcome: { rejected: { reason: [{ invalid: null }] } },
      })
    ).toThrow("omitted or contain one direct");
  });

  test("updated result consumes only the canonical 32-byte body_digest blob", () => {
    const digest = Uint8Array.from(
      { length: 32 },
      (_, index) => index,
    );
    const parsed = parseProfileEditSelfResult({
      outcome: {
        updated: {
          profile_generation: "3",
          revision: "4",
          body_digest: digest,
        },
      },
    });

    expect(parsed).toEqual({
      outcome: {
        updated: {
          profile_generation: "3",
          revision: "4",
          body_digest: digest,
        },
      },
    });
    if (parsed.outcome && "updated" in parsed.outcome) {
      expect(parsed.outcome.updated.body_digest).not.toBe(digest);
    }

    for (const body_digest of [
      new Uint8Array(31),
      new Uint8Array(33),
      Array.from({ length: 32 }, () => 0),
      new ArrayBuffer(32),
      "00".repeat(32),
    ]) {
      expect(() =>
        parseProfileEditSelfResult({
          outcome: {
            updated: {
              profile_generation: "3",
              revision: "4",
              body_digest,
            },
          },
        })
      ).toThrow();
    }

    expect(() =>
      parseProfileEditSelfResult({
        outcome: {
          updated: {
            profile_generation: "3",
            revision: "4",
            body_digest_hex: "00".repeat(32),
          },
        },
      })
    ).toThrow();
  });

  test("empty and maximum avatar blobs stay nested; maximum-plus-one fails", async () => {
    const transport = new FixtureTransport();
    const bridge = new WagyuOwnerBridge(transport);
    transport.updateValue = {};
    const base = {
      expected_profile_generation: 1n,
      expected_revision: 2n,
      display_name: "Alice",
      description: "",
      avatar: null,
    } as const;

    await bridge.profileEdit(base);
    expect(transport.calls[0]).toMatchObject({
      kind: "update",
      method: WAGYU_OWNER_BRIDGE_METHODS.profileEdit,
      request: {
        expected_profile_generation: "1",
        expected_revision: "2",
        display_name: "Alice",
        description: "",
      },
    });

    await bridge.profileEdit(
      {
        ...base,
        avatar: {
          media_type: "png",
          width: 1,
          height: 1,
          bytes: new Uint8Array(262_144),
        },
      },
    );
    expect(transport.calls[1]).toMatchObject({
      kind: "update",
      method: WAGYU_OWNER_BRIDGE_METHODS.profileEdit,
      request: {
        avatar: {
          media_type: { png: null },
          width: 1,
          height: 1,
          bytes: new Uint8Array(262_144),
        },
      },
    });
    const secondRequest = transport.calls[1]!.request as unknown as {
      avatar: { bytes: Uint8Array };
    };
    expect(secondRequest.avatar.bytes).toBeInstanceOf(Uint8Array);
    expect(secondRequest.avatar.bytes.byteLength).toBe(262_144);

    await expect(
      bridge.profileEdit({
        ...base,
        avatar: {
          media_type: "png",
          width: 1,
          height: 1,
          bytes: new Uint8Array(0),
        },
      }),
    ).rejects.toMatchObject({ code: "WAGYU_OWNER_BINARY_EMPTY" });
    await expect(
      bridge.profileEdit({
        ...base,
        avatar: {
          media_type: "png",
          width: 1,
          height: 1,
          bytes: new Uint8Array(262_145),
        },
      }),
    ).rejects.toMatchObject({ code: "WAGYU_OWNER_BINARY_TOO_LARGE" });
    expect(transport.calls).toHaveLength(2);
  });
});

describe("nested query output blobs", () => {
  test("feed and notification pages decode exact Candid and bind all metadata", () => {
    const feedBody = WAGYU_CODECS.FeedPageV1.encode({
      revision: 7n,
      items: [],
      next_before_sequence: [],
    });
    const feed = decodeFeedPageSelfResponse(
      binaryResponse(feedBody, {
        revision: "7",
        item_count: 0,
      }),
    );
    expect(feed.value.revision).toBe(7n);
    expect(feed.exact_bytes).toEqual(feedBody);

    const notificationBody = WAGYU_CODECS.NotificationPageV1.encode({
      revision: 8n,
      items: [],
      next_before_sequence: [],
    });
    const notifications = decodeNotificationPageSelfResponse(
      binaryResponse(notificationBody, {
        revision: "8",
        item_count: 0,
      }),
    );
    expect(notifications.value.revision).toBe(8n);
    expect(notifications.exact_bytes).toEqual(notificationBody);
  });

  test("page bodies must be valid Candid and metadata must match exact bytes", () => {
    const body = WAGYU_CODECS.FeedPageV1.encode({
      revision: 7n,
      items: [],
      next_before_sequence: [],
    });
    const valid = metadata(body, { revision: "7", item_count: 0 });

    expect(() =>
      decodeFeedPageSelfResponse(
        {
          value: { ...valid, body_bytes: body.byteLength + 1 },
          body,
        },
      )
    ).toThrow("does not match");
    expect(() =>
      decodeFeedPageSelfResponse(
        {
          value: { ...valid, body_digest_hex: "00".repeat(32) },
          body,
        },
      )
    ).toThrow("does not match");
    expect(() =>
      decodeFeedPageSelfResponse(
        { value: { ...valid, revision: "8" }, body },
      )
    ).toThrow("does not match");
    expect(() =>
      decodeFeedPageSelfResponse(
        {
          value: valid,
          body: Uint8Array.of(0x44, 0x49, 0x44, 0x4c),
        },
      )
    ).toThrow();
    expect(() =>
      decodeFeedPageSelfResponse({
        value: valid,
        body: Array.from(body),
      })
    ).toThrow("Uint8Array");
  });

  test("evidence binds requested sequence, found flag, digest, and exact body", () => {
    const body = WAGYU_CODECS.NotificationEvidenceV1.encode({
      local_sequence: 11n,
      found: false,
      evidence: [],
    });
    const request = buildNotificationEvidenceSelfRequest({
      local_sequence: 11n,
    });
    const valid = metadata(body, {
      local_sequence: "11",
      found: false,
    });
    const result = decodeNotificationEvidenceSelfResponse(
      request,
      { value: valid, body },
    );
    expect(result.value.local_sequence).toBe(11n);
    expect(result.exact_bytes).toEqual(body);

    expect(() =>
      decodeNotificationEvidenceSelfResponse(
        request,
        { value: { ...valid, local_sequence: "12" }, body },
      )
    ).toThrow("does not match");
    expect(() =>
      decodeNotificationEvidenceSelfResponse(
        request,
        { value: { ...valid, found: true }, body },
      )
    ).toThrow("does not match");
  });
});

test("the narrow class dispatches ordinary calls with nested exact bytes", async () => {
  const transport = new FixtureTransport();
  const bridge = new WagyuOwnerBridge(transport);
  const body = WAGYU_CODECS.FeedPageV1.encode({
    revision: 1n,
    items: [],
    next_before_sequence: [],
  });
  transport.queryValue = binaryResponse(body, {
    revision: "1",
    item_count: 0,
  });

  await bridge.feedPage({ before_sequence: null, limit: 25 });
  expect(transport.calls[0]).toMatchObject({
    kind: "query",
    method: WAGYU_OWNER_BRIDGE_METHODS.feedPage,
    request: { limit: 25 },
  });

  const exactRef = WAGYU_CODECS.CertifiedPostRefV1.encode(
    buildGoldenPackageValues().CertifiedPostRefV1,
  );
  transport.updateValue = publishSuccess();
  await bridge.sharePrepare({
    nonce: HEX_16,
    exact_original_post_ref_candid: exactRef,
  });
  expect(transport.calls[1]).toMatchObject({
    kind: "update",
    method: WAGYU_OWNER_BRIDGE_METHODS.sharePrepare,
    request: {
      nonce_hex: HEX_16,
      exact_original_post_ref_candid: exactRef,
    },
  });
  expect(
    Array.from(
      (transport.calls[1]!.request as unknown as {
        exact_original_post_ref_candid: Uint8Array;
      }).exact_original_post_ref_candid,
    ),
  ).toEqual(
    Array.from(exactRef),
  );
});

test("publish response hex is checked rather than silently normalized", () => {
  expect(parsePublishSelfResult(publishSuccess())).toMatchObject({
    stage: "awaiting_proof",
    post_id_hex: HEX_32,
    action_id_hex: OTHER_HEX_32,
    object_digest_hex: "0d".repeat(32),
  });
  expect(() =>
    parsePublishSelfResult({ ok: publishSuccess() })
  ).toThrow();
  expect(() =>
    parsePublishSelfResult({ err: { invalid: null } })
  ).toThrow();
  expect(() =>
    parsePublishSelfResult({
      ...(publishSuccess() as Record<string, JsonValue>),
      action_id_hex: HEX_32.toUpperCase(),
    })
  ).toThrow("lowercase");
  expect(() =>
    parsePublishSelfResult({
      ...(publishSuccess() as Record<string, JsonValue>),
      stage: [{ awaiting_proof: null }],
    })
  ).toThrow("omitted or contain one direct");
  expect(() =>
    parsePublishSelfResult({
      ...(publishSuccess() as Record<string, JsonValue>),
      post_id_hex: null,
    })
  ).toThrow("omitted or contain one direct");
});

type FixtureCall = {
  kind: "query" | "update";
  method: string;
  request: SelfCallValue;
};

class FixtureTransport implements WagyuOwnerSelfCallTransport {
  readonly calls: FixtureCall[] = [];
  queryValue: SelfCallValue = {};
  updateValue: SelfCallValue = {};

  async query<T extends SelfCallValue = SelfCallValue>(
    method: string,
    args: SelfCallValue[],
    _timeoutSeconds: number,
  ): Promise<T> {
    this.calls.push({
      kind: "query",
      method,
      request: args[0] ?? null,
    });
    return this.queryValue as T;
  }

  async update<T extends SelfCallValue = SelfCallValue>(
    method: string,
    args: SelfCallValue[],
    _timeoutSeconds: number,
  ): Promise<T> {
    this.calls.push({
      kind: "update",
      method,
      request: args[0] ?? null,
    });
    return this.updateValue as T;
  }

}

function metadata(
  body: Uint8Array,
  fields: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return {
    ...fields,
    body_bytes: body.byteLength,
    body_digest_hex: lowerHex(sha256Exact(body)),
  };
}

function binaryResponse(
  body: Uint8Array,
  fields: Record<string, JsonValue>,
): SelfCallValue {
  return {
    value: metadata(body, fields),
    body: Uint8Array.from(body),
  };
}

function publishSuccess(): JsonValue {
  return {
    stage: { awaiting_proof: null },
    post_id_hex: HEX_32,
    action_id_hex: OTHER_HEX_32,
    object_digest_hex: "0d".repeat(32),
    queued_recipient_count: 0,
    queued_notice_count: 0,
    accepted_recipient_count: 0,
    failed_recipient_count: 0,
    message: "prepared",
  };
}
