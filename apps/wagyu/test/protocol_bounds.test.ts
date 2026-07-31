import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import {
  WAGYU_IDL,
  WAGYU_LIMITS,
  WagyuProtocolError,
  bytes32,
  decodeWagyuPackage,
  encodeWagyuPackage,
  hashLp,
  lowerHex,
  utf8,
} from "../src/protocol/index.ts";
import { buildGoldenPackageValues } from "../candid/fixtures/v1-values.ts";

describe("Wagyu V1 protocol bounds", () => {
  test("LP framing uses u32be byte lengths and the frozen SHA-256 result", () => {
    expect(lowerHex(hashLp(utf8("x"), Uint8Array.of(1, 2)))).toBe(
      "0005a3b49e9df6de37fdc1f5bf47ff59b9677fcafbb11587e02b1d0152624487",
    );
  });

  test("fixed blobs reject adjacent lengths", () => {
    expect(() => bytes32(new Uint8Array(31))).toThrow(WagyuProtocolError);
    expect(() => bytes32(new Uint8Array(33))).toThrow(WagyuProtocolError);
    expect(bytes32(new Uint8Array(32))).toHaveLength(32);
  });

  test("local encoders require current non-null extensible tags", () => {
    const post = buildGoldenPackageValues().PostBodyV1;
    expect(() =>
      encodeWagyuPackage("PostBodyV1", {
        ...post,
        header: { ...post.header, action_kind: [] },
      }),
    ).toThrow("one known V1 tag");

    const delivery = buildGoldenPackageValues().DeliverBodyV1;
    expect(() =>
      encodeWagyuPackage("DeliverBodyV1", {
        ...delivery,
        event: [],
      }),
    ).toThrow("one known V1 tag");
  });

  test("present avatars require dimensions in 1..1024", () => {
    const profile = buildGoldenPackageValues().ProfileV1;
    const avatar = profile.avatar[0]!;

    expect(() =>
      encodeWagyuPackage("ProfileV1", {
        ...profile,
        avatar: [{ ...avatar, width: 0 }],
      }),
    ).toThrow("Avatar dimensions");
    expect(() =>
      encodeWagyuPackage("ProfileV1", {
        ...profile,
        avatar: [
          { ...avatar, height: WAGYU_LIMITS.profileAvatarDimension + 1 },
        ],
      }),
    ).toThrow("Avatar dimensions");

    const edit = buildGoldenPackageValues().ProfileEditRequestV1;
    expect(() =>
      encodeWagyuPackage("ProfileEditRequestV1", {
        ...edit,
        avatar: [{ ...edit.avatar[0]!, width: 0 }],
      }),
    ).toThrow("avatar dimensions");
  });

  test("profile text, capability order, and avatar bytes are bounded", () => {
    const profile = buildGoldenPackageValues().ProfileV1;
    expect(() =>
      encodeWagyuPackage("ProfileV1", {
        ...profile,
        display_name: "x".repeat(81),
      }),
    ).toThrow("80 UTF-8 bytes");
    expect(() =>
      encodeWagyuPackage("ProfileV1", {
        ...profile,
        description: "unsafe\u0000text",
      }),
    ).toThrow("control character");
    expect(() =>
      encodeWagyuPackage("ProfileV1", {
        ...profile,
        capabilities: [["wagyu:z", "wagyu:a"]],
      }),
    ).toThrow("sorted and duplicate-free");
    expect(() =>
      encodeWagyuPackage("ProfileV1", {
        ...profile,
        avatar: [
          {
            ...profile.avatar[0]!,
            bytes: new Uint8Array(WAGYU_LIMITS.profileAvatarBytes + 1),
          },
        ],
      }),
    ).toThrow("Avatar bytes");
  });

  test("profile edits accept only canonical non-empty bounded avatar bytes", () => {
    const edit = buildGoldenPackageValues().ProfileEditRequestV1;
    const avatar = edit.avatar[0]!;
    const maximum = new Uint8Array(WAGYU_LIMITS.profileAvatarBytes);
    const encoded = encodeWagyuPackage("ProfileEditRequestV1", {
      ...edit,
      avatar: [{ ...avatar, bytes: maximum }],
    });
    expect(
      decodeWagyuPackage("ProfileEditRequestV1", encoded)
        .value.avatar[0]!.bytes,
    ).toHaveLength(WAGYU_LIMITS.profileAvatarBytes);

    expect(() =>
      encodeWagyuPackage("ProfileEditRequestV1", {
        ...edit,
        avatar: [{ ...avatar, bytes: new Uint8Array(0) }],
      })
    ).toThrow("must not be empty");
    expect(() =>
      encodeWagyuPackage("ProfileEditRequestV1", {
        ...edit,
        avatar: [{
          ...avatar,
          bytes: [] as unknown as Uint8Array,
        }],
      })
    ).toThrow("must be a Uint8Array");
    expect(() =>
      encodeWagyuPackage("ProfileEditRequestV1", {
        ...edit,
        avatar: [{
          ...avatar,
          bytes: new Uint8Array(WAGYU_LIMITS.profileAvatarBytes + 1),
        }],
      })
    ).toThrow(`${WAGYU_LIMITS.profileAvatarBytes} bytes`);

    const oversizedWire = IDL.encode(
      [WAGYU_IDL.ProfileEditRequestV1],
      [{
        ...edit,
        avatar: [{
          ...avatar,
          bytes: new Uint8Array(WAGYU_LIMITS.profileAvatarBytes + 1),
        }],
      }],
    );
    expect(() =>
      decodeWagyuPackage("ProfileEditRequestV1", oversizedWire)
    ).toThrow(`${WAGYU_LIMITS.profileAvatarBytes} bytes`);
  });

  test("send quote recipient previews stay bounded and canonically ordered", () => {
    const quote = buildGoldenPackageValues().SendQuoteV1;
    expect(() =>
      encodeWagyuPackage("SendQuoteV1", {
        ...quote,
        eligible_recipient_preview: Array.from(
          { length: 9 },
          () => quote.eligible_recipient_preview[0]!,
        ),
      })
    ).toThrow("authoritative bound");
    expect(() =>
      encodeWagyuPackage("SendQuoteV1", {
        ...quote,
        eligible_recipient_preview: [
          quote.eligible_recipient_preview[0]!,
          quote.eligible_recipient_preview[0]!,
        ],
      })
    ).toThrow("canonically ascending");
    expect(() =>
      encodeWagyuPackage("SendQuoteV1", {
        ...quote,
        eligible_delivery_count: 1,
      })
    ).toThrow("authoritative bound");
  });

  test("normal and final-partial like batch counts are disjoint", () => {
    const batch = buildGoldenPackageValues().LikeBatchV1;
    expect(() =>
      encodeWagyuPackage("LikeBatchV1", {
        ...batch,
        final_partial: false,
      }),
    ).toThrow("150 receipts");
    expect(() =>
      encodeWagyuPackage("LikeBatchV1", {
        ...batch,
        receipts: [],
      }),
    ).toThrow("1-149");
  });

  test("the populated Like head fixture remains under 4 KiB", () => {
    const encoded = encodeWagyuPackage(
      "LikeHeadV1",
      buildGoldenPackageValues().LikeHeadV1,
    );
    expect(encoded.byteLength).toBeLessThan(WAGYU_LIMITS.likeHeadObjectBytes);
  });
});
