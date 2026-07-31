import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Planner "../../backend/actions/Planner";
import Publication "../../backend/actions/Publication";
import Protocol "../../backend/protocol/Types";

func bytes(parts : [[Nat8]]) : [Nat8] {
    Array.flatten<Nat8>(parts);
};

func u16be(value : Nat) : [Nat8] {
    [
        Nat8.fromNat(value / 256 % 256),
        Nat8.fromNat(value % 256),
    ];
};

func u16le(value : Nat) : [Nat8] {
    [
        Nat8.fromNat(value % 256),
        Nat8.fromNat(value / 256 % 256),
    ];
};

func u24le(value : Nat) : [Nat8] {
    [
        Nat8.fromNat(value % 256),
        Nat8.fromNat(value / 256 % 256),
        Nat8.fromNat(value / 65_536 % 256),
    ];
};

func u32be(value : Nat) : [Nat8] {
    [
        Nat8.fromNat(value / 16_777_216 % 256),
        Nat8.fromNat(value / 65_536 % 256),
        Nat8.fromNat(value / 256 % 256),
        Nat8.fromNat(value % 256),
    ];
};

func u32le(value : Nat) : [Nat8] {
    [
        Nat8.fromNat(value % 256),
        Nat8.fromNat(value / 256 % 256),
        Nat8.fromNat(value / 65_536 % 256),
        Nat8.fromNat(value / 16_777_216 % 256),
    ];
};

func png(width : Nat, height : Nat, animated : Bool) : Blob {
    let animation : [Nat8] = if (animated) {
        [
            0, 0, 0, 8, // acTL payload length
            97, 99, 84, 76, // acTL
            0, 0, 0, 1, // one frame
            0, 0, 0, 0, // infinite plays
            0, 0, 0, 0, // ignored CRC
        ];
    } else [];
    Blob.fromArray(
        bytes([
            [137, 80, 78, 71, 13, 10, 26, 10],
            [0, 0, 0, 13, 73, 72, 68, 82],
            u32be(width),
            u32be(height),
            [8, 6, 0, 0, 0],
            [0, 0, 0, 0], // ignored IHDR CRC
            animation,
            [0, 0, 0, 0, 73, 68, 65, 84],
            [0, 0, 0, 0], // ignored IDAT CRC
            [0, 0, 0, 0, 73, 69, 78, 68],
            [0, 0, 0, 0], // ignored IEND CRC
        ])
    );
};

func maximalPng(width : Nat, height : Nat) : Blob {
    let filler = Array.repeat<Nat8>(0, 262_075);
    Blob.fromArray(
        bytes([
            [137, 80, 78, 71, 13, 10, 26, 10],
            [0, 0, 0, 13, 73, 72, 68, 82],
            u32be(width),
            u32be(height),
            [8, 6, 0, 0, 0],
            [0, 0, 0, 0],
            u32be(filler.size()),
            [118, 112, 65, 103], // private ancillary vpAg chunk
            filler,
            [0, 0, 0, 0],
            [0, 0, 0, 0, 73, 68, 65, 84],
            [0, 0, 0, 0],
            [0, 0, 0, 0, 73, 69, 78, 68],
            [0, 0, 0, 0],
        ])
    );
};

func jpeg(width : Nat, height : Nat) : Blob {
    Blob.fromArray(
        bytes([
            [0xff, 0xd8],
            [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00],
            [0xff, 0xc0, 0x00, 0x11, 0x08],
            u16be(height),
            u16be(width),
            [
                0x03,
                0x01, 0x11, 0x00,
                0x02, 0x11, 0x00,
                0x03, 0x11, 0x00,
            ],
            [0xff, 0xd9],
        ])
    );
};

func webpChunk(kind : [Nat8], payload : [Nat8]) : [Nat8] {
    let padding : [Nat8] = if (payload.size() % 2 == 0) [] else [0];
    bytes([
        kind,
        u32le(payload.size()),
        payload,
        padding,
    ]);
};

func webp(chunks : [[Nat8]]) : Blob {
    let payload = bytes(chunks);
    Blob.fromArray(
        bytes([
            [82, 73, 70, 70],
            u32le(payload.size() + 4),
            [87, 69, 66, 80],
            payload,
        ])
    );
};

func vp8(width : Nat, height : Nat) : [Nat8] {
    webpChunk(
        [86, 80, 56, 32],
        bytes([
            [0, 0, 0, 0x9d, 0x01, 0x2a],
            u16le(width),
            u16le(height),
        ]),
    );
};

func vp8l(width : Nat, height : Nat) : [Nat8] {
    let packed = Nat.sub(width, 1) + Nat.sub(height, 1) * 16_384;
    webpChunk(
        [86, 80, 56, 76],
        bytes([[0x2f], u32le(packed)]),
    );
};

func vp8x(width : Nat, height : Nat, flags : Nat8) : [Nat8] {
    webpChunk(
        [86, 80, 56, 88],
        bytes([
            [flags, 0, 0, 0],
            u24le(Nat.sub(width, 1)),
            u24le(Nat.sub(height, 1)),
        ]),
    );
};

func avatar(
    mediaType : ?Protocol.AvatarMediaTypeV1,
    width : Nat,
    height : Nat,
    body : Blob,
) : ?Protocol.AvatarV1 {
    ?{
        media_type = mediaType;
        width = Nat16.fromNat(width);
        height = Nat16.fromNat(height);
        bytes = body;
    };
};

let #ok(null) = Planner.validateAvatarAdmission(null) else {
    Runtime.trap("an absent avatar must remain valid");
};

let pngBody = png(3, 2, false);
let #ok(?pngInspection) = Planner.validateAvatarAdmission(
    avatar(?#png, 3, 2, pngBody)
) else Runtime.trap("valid PNG admission failed");
assert (pngInspection.media_type == #png);
assert (pngInspection.width == 3);
assert (pngInspection.height == 2);

let #err(#missing_media_type) = Planner.validateAvatarAdmission(
    avatar(null, 3, 2, pngBody)
) else Runtime.trap("a present avatar requires a known media tag");
let #err(#media_content_mismatch) = Planner.validateAvatarAdmission(
    avatar(?#jpeg, 3, 2, pngBody)
) else Runtime.trap("declared media must match raster magic");
let #err(#media_content_mismatch) = Planner.validateAvatarAdmission(
    avatar(?#png, 1, 1, Blob.fromArray([]))
) else Runtime.trap("a present avatar cannot have empty bytes");
let #err(#declared_dimensions_mismatch) =
    Planner.validateAvatarAdmission(
        avatar(?#png, 2, 3, pngBody)
    ) else Runtime.trap("declared PNG dimensions must match IHDR");
let #err(#invalid_dimensions) = Planner.validateAvatarAdmission(
    avatar(?#png, 0, 2, pngBody)
) else Runtime.trap("zero declared dimensions must fail");
let #err(#invalid_dimensions) = Planner.validateAvatarAdmission(
    avatar(?#png, 1_025, 2, png(1_025, 2, false))
) else Runtime.trap("dimensions over 1024 must fail");
let #err(#animation_forbidden) = Planner.validateAvatarAdmission(
    avatar(?#png, 3, 2, png(3, 2, true))
) else Runtime.trap("APNG must fail admission");

let #ok(?jpegInspection) = Planner.validateAvatarAdmission(
    avatar(?#jpeg, 5, 4, jpeg(5, 4))
) else Runtime.trap("valid JPEG SOF dimensions were not accepted");
assert (jpegInspection.width == 5);
assert (jpegInspection.height == 4);
let #err(#media_content_mismatch) = Planner.validateAvatarAdmission(
    avatar(?#jpeg, 1, 1, Blob.fromArray([0xff, 0xd8, 0xff, 0xd9]))
) else Runtime.trap("JPEG without a SOF marker must fail");

let #ok(?vp8Inspection) = Planner.validateAvatarAdmission(
    avatar(?#webp, 7, 6, webp([vp8(7, 6)]))
) else Runtime.trap("valid VP8 WebP dimensions were not accepted");
assert (vp8Inspection.width == 7);
assert (vp8Inspection.height == 6);

let #ok(?vp8lInspection) = Planner.validateAvatarAdmission(
    avatar(?#webp, 9, 8, webp([vp8l(9, 8)]))
) else Runtime.trap("valid VP8L WebP dimensions were not accepted");
assert (vp8lInspection.width == 9);
assert (vp8lInspection.height == 8);

let #ok(?vp8xInspection) = Planner.validateAvatarAdmission(
    avatar(?#webp, 11, 10, webp([vp8x(11, 10, 0), vp8(11, 10)]))
) else Runtime.trap("valid VP8X WebP dimensions were not accepted");
assert (vp8xInspection.width == 11);
assert (vp8xInspection.height == 10);

let #err(#animation_forbidden) = Planner.validateAvatarAdmission(
    avatar(
        ?#webp,
        11,
        10,
        webp([vp8x(11, 10, 0x02), vp8(11, 10)]),
    )
) else Runtime.trap("animated VP8X must fail admission");
let #err(#media_content_mismatch) = Planner.validateAvatarAdmission(
    avatar(?#webp, 11, 10, webp([vp8x(11, 10, 0), vp8(10, 10)]))
) else Runtime.trap("VP8X canvas and bitstream dimensions must agree");

let tooLarge = Blob.fromArray(
    Array.repeat<Nat8>(0, 262_145)
);
let maximum = maximalPng(3, 2);
assert (maximum.size() == 262_144);
let #ok(_) = Planner.validateAvatarAdmission(
    avatar(?#png, 3, 2, maximum)
) else Runtime.trap("an exact 256 KiB avatar must remain admissible");
let #err(#too_large) = Planner.validateAvatarAdmission(
    avatar(?#png, 1, 1, tooLarge)
) else Runtime.trap("the 256 KiB avatar byte cap must be enforced first");

// prepareProfileEdit consumes the strict validator, so callers cannot bypass
// admission by constructing Protocol.AvatarV1 themselves.
let node = Principal.fromBlob(Blob.fromArray([1, 1]));
let network = Blob.fromArray(Array.repeat<Nat8>(1, 32));
let nonce = Blob.fromArray(Array.repeat<Nat8>(2, 16));
let #ok(defaultProfile) = Planner.defaultProfile({
    network_id = network;
    node;
    profile_generation = 1;
    updated_at_ns = 1;
    capabilities = null;
}) else Runtime.trap("default profile setup failed");
let target = Publication.profileTarget(1);
let identity = Publication.stored({
    target;
    kernel_revision = 1;
    content_tag = defaultProfile.body_digest;
    body_bytes = defaultProfile.body_candid.size();
    geometry = {
        block_bytes = defaultProfile.body_candid.size();
        block_count = 1;
        expected_bytes = defaultProfile.body_candid.size();
    };
    block_hashes = [defaultProfile.body_digest];
});
let invalidEdit : Planner.PrepareProfileEditInput = {
    current = defaultProfile.value;
    current_body_candid = defaultProfile.body_candid;
    current_identity = identity;
    updated_at_ns = 2;
    display_name = "Owner";
    description = "";
    capabilities = null;
    avatar = avatar(null, 3, 2, pngBody);
    publication_nonce = nonce;
};
let #err(#invalid_profile) = Planner.prepareProfileEdit(invalidEdit) else {
    Runtime.trap("profile planning must enforce strict avatar admission");
};

let #ok(lazyProfile) = Planner.createProfile({
    network_id = network;
    node;
    profile_generation = 9;
    updated_at_ns = 2;
    display_name = "Owner";
    description = "Created after install";
    capabilities = null;
    avatar = null;
    profile_collection_generation = 7;
    publication_nonce = nonce;
}) else Runtime.trap("lazy profile planning failed");
assert (lazyProfile.value.profile_generation == 9);
assert (lazyProfile.value.revision == 1);
assert (lazyProfile.value.previous_profile_digest == null);
assert (lazyProfile.target.locator == #exact_path);
let #put(lazyProfilePut) = lazyProfile.commit.operations[0] else {
    Runtime.trap("lazy profile plan must create a mutable blob");
};
assert (lazyProfilePut.condition == #absent);
let #ok(_) = Planner.prepareProfileEdit({
    invalidEdit with
    avatar = avatar(?#png, 3, 2, pngBody);
}) else Runtime.trap("a valid raster avatar must remain publishable");
