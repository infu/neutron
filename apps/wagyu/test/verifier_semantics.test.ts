import { describe, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  assertConfiguredNetworkId,
  sha256,
  validateLikeHeadSemantics,
  validateLikeSemantics,
  validateProfileSemantics,
  validateReplyIndexSemantics,
  wagyuHash,
} from "../src/verifier/index.ts";

const NODE = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const NODE_PRINCIPAL = Principal.fromText(NODE);
const POST_AUTHOR = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const NETWORK = new Uint8Array(32).fill(7);
const POST_ID = new Uint8Array(32).fill(8);
const POST_HASH = new Uint8Array(32).fill(9);

test("trusted network ID is explicit and cannot be zero/unconfigured", () => {
  expect(assertConfiguredNetworkId(NETWORK)).toBe(NETWORK);
  expect(() => assertConfiguredNetworkId(new Uint8Array(32))).toThrow(
    "unconfigured",
  );
});

test("like validation binds exact bytes, ref, actor, network, and semantic ID", async () => {
  const exactBody = new TextEncoder().encode("exact-like-candid");
  const likeId = await wagyuHash(
    "wagyu.like-id.v1",
    NETWORK,
    NODE_PRINCIPAL.toUint8Array(),
    POST_AUTHOR.toUint8Array(),
    POST_ID,
  );
  const objectDigest = await sha256(exactBody);
  const body = {
    header: {
      network_id: NETWORK,
      actor: NODE_PRINCIPAL,
      action_kind: [{ like: null }],
    },
    like_id: likeId,
    issued_at_ns: 55n,
    post_author: POST_AUTHOR,
    post_id: POST_ID,
    post_body_hash: POST_HASH,
  };
  const ref = {
    actor: NODE_PRINCIPAL,
    action_kind: [{ like: null }],
    object_digest: objectDigest,
    body_length: exactBody.byteLength,
  };
  await expect(validateLikeSemantics(body, ref, {
    networkId: NETWORK,
    actor: NODE,
    exactBody,
  })).resolves.toMatchObject({ likeId, objectDigest });

  await expect(validateLikeSemantics(
    { ...body, like_id: new Uint8Array(32) },
    ref,
    { networkId: NETWORK, actor: NODE, exactBody },
  )).rejects.toThrow("semantic preimage");
});

describe("profile and head semantic bounds", () => {
  test("accepts a safe profile and makes unknown avatar media non-fatal", () => {
    const base = {
      network_id: NETWORK,
      node: NODE_PRINCIPAL,
      profile_generation: 1n,
      revision: 0n,
      updated_at_ns: 4n,
      previous_profile_digest: [],
      display_name: "Alice",
      description: "A profile",
      capabilities: [["wagyu_v1:feature-a"]],
      avatar: [],
    };
    expect(validateProfileSemantics(base, {
      networkId: NETWORK,
      node: NODE,
    }).avatar.state).toBe("absent");
    expect(validateProfileSemantics({
      ...base,
      avatar: [{
        media_type: [],
        width: 1,
        height: 1,
        bytes: Uint8Array.of(1, 2, 3),
      }],
    }, {
      networkId: NETWORK,
      node: NODE,
    }).avatar.state).toBe("unsupported");
  });

  test("rejects controls and unsorted/duplicate capabilities", () => {
    const profile = {
      network_id: NETWORK,
      node: NODE_PRINCIPAL,
      profile_generation: 1n,
      revision: 0n,
      updated_at_ns: 4n,
      previous_profile_digest: [],
      display_name: "bad\u0000name",
      description: "",
      capabilities: [["z", "a"]],
      avatar: [],
    };
    expect(() =>
      validateProfileSemantics(profile, { networkId: NETWORK, node: NODE })
    ).toThrow();
  });

  test("like head rejects incoherent option pairs/counts and wrong binding", () => {
    const head = {
      network_id: NETWORK,
      post_author: POST_AUTHOR,
      post_id: POST_ID,
      post_body_hash: POST_HASH,
      store_generation: 2n,
      revision: 1n,
      previous_head_hash: [],
      latest_batch_number: [0n],
      latest_batch_digest: [new Uint8Array(32).fill(3)],
      sealed_batch_count: 1n,
      sealed_receipt_count: 150n,
      accepting_likes: true,
    };
    expect(() =>
      validateLikeHeadSemantics(head, {
        networkId: NETWORK,
        postAuthor: POST_AUTHOR.toText(),
        postId: POST_ID,
        postBodyHash: POST_HASH,
      })
    ).not.toThrow();
    expect(() =>
      validateLikeHeadSemantics(
        { ...head, latest_batch_digest: [] },
        {
          networkId: NETWORK,
          postAuthor: POST_AUTHOR.toText(),
          postId: POST_ID,
          postBodyHash: POST_HASH,
        },
      )
    ).toThrow("co-occur");
    expect(() =>
      validateLikeHeadSemantics(
        { ...head, latest_batch_number: [7n] },
        {
          networkId: NETWORK,
          postAuthor: POST_AUTHOR.toText(),
          postId: POST_ID,
          postBodyHash: POST_HASH,
        },
      )
    ).toThrow("sealed count");
  });

  test("reply index binds its parent and rejects duplicate reply identities", () => {
    const reply = {
      author: NODE_PRINCIPAL,
      post_id: new Uint8Array(32).fill(10),
      object_digest: new Uint8Array(32).fill(11),
      object_length: 240,
      received_at_ns: 50n,
    };
    const index = {
      network_id: NETWORK,
      post_author: POST_AUTHOR,
      post_id: POST_ID,
      post_body_hash: POST_HASH,
      store_generation: 2n,
      revision: 1n,
      previous_index_hash: [],
      replies: [reply],
    };
    expect(() =>
      validateReplyIndexSemantics(index, {
        networkId: NETWORK,
        postAuthor: POST_AUTHOR.toText(),
        postId: POST_ID,
        postBodyHash: POST_HASH,
      })
    ).not.toThrow();
    expect(() =>
      validateReplyIndexSemantics(
        { ...index, replies: [reply, reply] },
        {
          networkId: NETWORK,
          postAuthor: POST_AUTHOR.toText(),
          postId: POST_ID,
          postBodyHash: POST_HASH,
        },
      )
    ).toThrow("duplicate");
  });
});
