import Blob "mo:core/Blob";
import Array "mo:core/Array";
import Text "mo:core/Text";
import Codec "../../backend/certified_assets/Codec";
import Paths "../../backend/certified_assets/Paths";
import Types "../../backend/certified_assets/Types";

func repeated(byte : Nat8, count : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(count, func(_) { byte }));
};

let publicationBegin : Types.BeginStageInput = {
    nonce = repeated(0xaa, 16);
    target = #allocate_publication({
        collection = "publications";
        collection_generation = 7;
        filename = "a.txt";
        presentation = #attachment;
    });
    expected_bytes = 8;
};
assert (
    Codec.hex(Codec.beginFingerprint(publicationBegin)) ==
    "777eb8fc8bad23de4fea9b5f5cf1718855623c9aa73daec0a2a7edf7299d09d0"
);
assert (
    Codec.beginFingerprint(publicationBegin) ==
    Codec.beginFingerprint({
        publicationBegin with nonce = repeated(0xee, 16)
    })
);

let immutableBegin : Types.BeginStageInput = {
    nonce = repeated(0xbb, 16);
    target = #derive_body_sha256({
        collection = "objects";
        collection_generation = 9;
    });
    expected_bytes = 3;
};
assert (
    Codec.hex(Codec.beginFingerprint(immutableBegin)) ==
    "acd369723d0b53eff9c1acc8b8a7972aef7a8a342e719d18eb7041e72e06cfb3"
);

let target : Types.Target = {
    collection = "objects";
    collection_generation = 9;
    locator = #body_sha256({ digest = repeated(0x11, 32) });
};
let positive : Types.CommitBatchInput = {
    nonce = repeated(0xcc, 16);
    operations = [#put({
        target;
        condition = #absent;
        body = #inline(Text.encodeUtf8("abc"));
    })];
    requires_present_after = [];
};
assert (
    Codec.hex(Codec.batchFingerprint(positive, false)) ==
    "25010eb8e869da958d16d666f0d513b85d69ff2e374b42818132a29b12f3ac69"
);
assert (
    Codec.batchFingerprint(positive, false) ==
    Codec.batchFingerprint(
        { positive with nonce = repeated(0xef, 16) },
        false,
    )
);
let positiveInlineDigests = Codec.inlineBodyDigests(positive);
assert (positiveInlineDigests.size() == positive.operations.size());
assert (
    positiveInlineDigests[0] ==
    ?Codec.sha256(Text.encodeUtf8("abc"))
);
assert (
    Codec.batchFingerprintFromInlineDigests(
        positive,
        false,
        positiveInlineDigests,
    ) == Codec.batchFingerprint(positive, false)
);

let deletion : Types.CommitBatchInput = {
    nonce = repeated(0xdd, 16);
    operations = [#delete({
        target;
        condition = {
            revision = 4;
            content_tag = repeated(0x22, 32);
        };
    })];
    requires_present_after = [];
};
assert (
    Codec.hex(Codec.batchFingerprint(deletion, true)) ==
    "73503c70e4ee9f0c44fc3b96628fbf235bed2f04c1f5c74f6146a35e0b5c7966"
);
assert (
    Codec.batchFingerprintFromInlineDigests(
        deletion,
        true,
        Codec.inlineBodyDigests(deletion),
    ) == Codec.batchFingerprint(deletion, true)
);

assert (
    Codec.hex(Codec.sha256Chunks([
        Text.encodeUtf8("abc"),
        Text.encodeUtf8("defgh"),
    ])) ==
    "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab"
);

let exactMutable : Types.CollectionDeclaration = {
    id = "singleton";
    mount = "first";
    kind = #mutable_blob;
    path_prefix = null;
    exact_path = ?"/singleton";
    max_object_bytes = null;
    authority_epoch = 1;
    generation = 1;
    serving = #enabled;
    writes = #enabled;
};
assert (
    Paths.collectionsOverlap(
        exactMutable,
        { exactMutable with id = "second" },
    )
);
assert (
    not Paths.collectionsOverlap(
        exactMutable,
        { exactMutable with id = "second"; mount = "second" },
    )
);
