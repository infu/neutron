import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IDL } from "@dfinity/candid";
import {
  WAGYU_CODECS,
  WAGYU_IDL,
  decodeWagyuPackage,
  deriveLikeId,
  deriveNetworkId,
  deriveObjectDigest,
  derivePostBodyHash,
  derivePostId,
  deriveShareId,
  deriveTombstoneId,
  encodeWagyuPackage,
  lowerHex,
  sha256Exact,
  type WagyuPackageName,
} from "../src/protocol/index.ts";
import {
  GOLDEN_ACTOR_A,
  GOLDEN_ACTOR_B,
  GOLDEN_MAINNET_ROOT_DER,
  GOLDEN_NETWORK_ID,
  buildDefaultProfileValue,
  buildGoldenPackageValues,
} from "../candid/fixtures/v1-values.ts";

interface GoldenFixture {
  mainnet_root_der: { byte_length: number; sha256: string };
  default_profile: {
    byte_length: number;
    sha256: string;
    candid_hex: string;
  };
  semantic: {
    network_id: string;
    post_body_hash: string;
    post_id: string;
    post_object_digest: string;
    share_id: string;
    like_id: string;
    tombstone_id: string;
  };
  packages: Record<string, { byte_length: number; sha256: string }>;
}

const golden = JSON.parse(
  readFileSync(
    new URL("../candid/fixtures/golden-v1.json", import.meta.url),
    "utf8",
  ),
) as GoldenFixture;

describe("Wagyu V1 golden Candid packages", () => {
  test("every registered package is frozen by byte length and SHA-256", () => {
    const values = buildGoldenPackageValues();
    expect(Object.keys(values).sort()).toEqual(Object.keys(WAGYU_CODECS).sort());
    expect(Object.keys(golden.packages).sort()).toEqual(
      Object.keys(WAGYU_CODECS).sort(),
    );

    for (const name of Object.keys(WAGYU_CODECS) as WagyuPackageName[]) {
      const encoded = encodeWagyuPackage(name, values[name] as never);
      const expected = golden.packages[name]!;
      expect(encoded.byteLength, `${name} byte length`).toBe(
        expected.byte_length,
      );
      expect(lowerHex(sha256Exact(encoded)), `${name} SHA-256`).toBe(
        expected.sha256,
      );

      const decoded = decodeWagyuPackage(name, encoded);
      expect(lowerHex(decoded.object_digest)).toBe(expected.sha256);
      expect(Array.from(decoded.exact_bytes)).toEqual(Array.from(encoded));
    }
  });

  test("network and semantic identifiers match independent golden values", () => {
    const values = buildGoldenPackageValues();
    const postBytes = encodeWagyuPackage("PostBodyV1", values.PostBodyV1);
    const bodyHash = derivePostBodyHash(postBytes);
    const postId = derivePostId(
      GOLDEN_NETWORK_ID,
      GOLDEN_ACTOR_A,
      bodyHash,
    );

    expect(GOLDEN_MAINNET_ROOT_DER.byteLength).toBe(
      golden.mainnet_root_der.byte_length,
    );
    expect(lowerHex(sha256Exact(GOLDEN_MAINNET_ROOT_DER))).toBe(
      golden.mainnet_root_der.sha256,
    );
    expect(lowerHex(deriveNetworkId(GOLDEN_MAINNET_ROOT_DER))).toBe(
      golden.semantic.network_id,
    );
    expect(lowerHex(bodyHash)).toBe(golden.semantic.post_body_hash);
    expect(lowerHex(postId)).toBe(golden.semantic.post_id);
    expect(lowerHex(deriveObjectDigest(postBytes))).toBe(
      golden.semantic.post_object_digest,
    );
    expect(
      lowerHex(
        deriveShareId(
          GOLDEN_NETWORK_ID,
          GOLDEN_ACTOR_B,
          GOLDEN_ACTOR_A,
          postId,
        ),
      ),
    ).toBe(golden.semantic.share_id);
    expect(
      lowerHex(
        deriveLikeId(
          GOLDEN_NETWORK_ID,
          GOLDEN_ACTOR_B,
          GOLDEN_ACTOR_A,
          postId,
        ),
      ),
    ).toBe(golden.semantic.like_id);
    expect(
      lowerHex(
        deriveTombstoneId(
          GOLDEN_NETWORK_ID,
          GOLDEN_ACTOR_A,
          postId,
          8n,
        ),
      ),
    ).toBe(golden.semantic.tombstone_id);
  });

  test("default revision-zero profile has frozen exact bytes", () => {
    const encoded = encodeWagyuPackage(
      "ProfileV1",
      buildDefaultProfileValue(),
    );
    expect(encoded.byteLength).toBe(golden.default_profile.byte_length);
    expect(lowerHex(encoded)).toBe(golden.default_profile.candid_hex);
    expect(lowerHex(sha256Exact(encoded))).toBe(
      golden.default_profile.sha256,
    );
  });

  test("decoder owns and hashes the received bytes before decoding", () => {
    const encoded = encodeWagyuPackage(
      "PostBodyV1",
      buildGoldenPackageValues().PostBodyV1,
    );
    const expectedDigest = lowerHex(sha256Exact(encoded));
    const decoded = decodeWagyuPackage("PostBodyV1", encoded);

    encoded[0] = encoded[0]! ^ 0xff;
    expect(decoded.exact_bytes[0]).toBe(0x44);
    expect(lowerHex(decoded.object_digest)).toBe(expectedDigest);
  });

  test("outer ingress fixtures carry exact valid nested packages", () => {
    const values = buildGoldenPackageValues();
    expect(values.PublicIngressRequestV1.method).toBe("deliver");
    const ingress = decodeWagyuPackage(
      "WagyuIngressV1",
      values.PublicIngressRequestV1.payload,
    );
    expect(ingress.value.operation_id).toEqual(
      values.WagyuIngressV1.operation_id,
    );
    const delivery = decodeWagyuPackage(
      "DeliverBodyV1",
      ingress.value.body_candid,
    );
    expect(delivery.value.subscription_id).toEqual(
      values.DeliverBodyV1.subscription_id,
    );

    if (!("ok" in values.PublicIngressResultV1)) {
      throw new Error("golden public ingress result must be ok");
    }
    const routeResult = decodeWagyuPackage(
      "WagyuRouteResultV1",
      values.PublicIngressResultV1.ok,
    );
    expect(routeResult.value.outcome).toEqual([{ accepted: null }]);
  });

  test("a compatible extended encoding decodes but keeps a distinct digest", () => {
    const post = buildGoldenPackageValues().PostBodyV1;
    const ExtendedPostBodyV1 = IDL.Record({
      header: WAGYU_IDL.ActionHeaderV1,
      author_sequence: IDL.Nat64,
      nonce: IDL.Vec(IDL.Nat8),
      created_at_ns: IDL.Nat64,
      body_markdown: IDL.Text,
      reply_to: IDL.Opt(WAGYU_IDL.ReplyLocatorV1),
      future_hint: IDL.Opt(IDL.Text),
    });
    const baseline = encodeWagyuPackage("PostBodyV1", post);
    const extended = IDL.encode(
      [ExtendedPostBodyV1],
      [{ ...post, future_hint: ["compatible-extension"] }],
    );

    const decoded = decodeWagyuPackage("PostBodyV1", extended);
    expect(decoded.value.body_markdown).toBe(post.body_markdown);
    expect(decoded.value.author_sequence).toBe(post.author_sequence);
    expect(lowerHex(decoded.object_digest)).not.toBe(
      lowerHex(sha256Exact(baseline)),
    );
    expect(Array.from(decoded.exact_bytes)).toEqual(Array.from(extended));
  });

  test("a future optional-variant tag becomes null only at that field", () => {
    const header = buildGoldenPackageValues().ActionHeaderV1;
    const FutureActionKindV1 = IDL.Variant({
      post: IDL.Null,
      share: IDL.Null,
      tombstone: IDL.Null,
      like: IDL.Null,
      future_action: IDL.Null,
    });
    const FutureHeaderV1 = IDL.Record({
      network_id: IDL.Vec(IDL.Nat8),
      actor: IDL.Principal,
      action_kind: IDL.Opt(FutureActionKindV1),
    });
    const bytes = IDL.encode(
      [FutureHeaderV1],
      [{ ...header, action_kind: [{ future_action: null }] }],
    );

    const decoded = decodeWagyuPackage("ActionHeaderV1", bytes);
    expect(decoded.value.network_id).toEqual(header.network_id);
    expect(decoded.value.actor.toText()).toBe(header.actor.toText());
    expect(decoded.value.action_kind).toEqual([]);
  });
});
