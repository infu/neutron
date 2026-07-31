import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";

import Memory "../../backend/memory/wagyu/v3";
import Reconciliation "../../backend/publication/Reconciliation";

func repeated(size : Nat, byte : Nat8) : Blob {
    Blob.fromArray(Array.repeat<Nat8>(byte, size));
};

let digest = repeated(32, 0x31);
let otherDigest = repeated(32, 0x32);
let target : Memory.CertifiedTarget = {
    collection = #shares;
    collection_generation = 7;
    key = #digest(digest);
};
let otherTarget : Memory.CertifiedTarget = {
    collection = #shares;
    collection_generation = 7;
    key = #digest(otherDigest);
};
let identity : Memory.KernelRecordIdentity = {
    target;
    kernel_revision = 4;
    content_tag = digest;
    body_digest = digest;
    body_length = 512;
};

assert (
    Reconciliation.matches(
        target,
        ?identity,
        #present(identity),
    )
);
assert (
    not Reconciliation.matches(
        target,
        ?identity,
        #present({
            identity with
            kernel_revision = 5;
        }),
    )
);
assert (
    not Reconciliation.matches(
        target,
        ?{
            identity with
            target = otherTarget;
        },
        #present(identity),
    )
);
assert (
    not Reconciliation.matches(
        target,
        null,
        #present(identity),
    )
);
assert (Reconciliation.matches(target, null, #absent(7)));
assert (not Reconciliation.matches(target, null, #absent(8)));
assert (
    Reconciliation.matches(
        target,
        null,
        #recently_deleted(target),
    )
);
assert (
    Reconciliation.matches(
        target,
        null,
        #deleted_high_water(target),
    )
);
assert (
    not Reconciliation.matches(
        target,
        null,
        #recently_deleted(otherTarget),
    )
);
assert (
    not Reconciliation.matches(
        target,
        null,
        #deleted_high_water(otherTarget),
    )
);
