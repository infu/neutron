import Blob "mo:core/Blob";
import Keys "../../backend/files/Keys";
import Memory "../../backend/memory/files/v1";

func assertBytes(actual : Blob, expected : [Nat8]) {
    let bytes = Blob.toArray(actual);
    assert (bytes.size() == expected.size());
    var index = 0;
    while (index < bytes.size()) {
        assert (bytes[index] == expected[index]);
        index += 1;
    };
};

let zero : Memory.Id128 = { hi = 0; lo = 0 };
let low : Memory.Id128 = { hi = 0; lo = 1 };
let high : Memory.Id128 = { hi = 1; lo = 0 };
assert (Keys.compareId128(zero, low) == #less);
assert (Keys.compareId128(low, high) == #less);
assert (Keys.compareId128(high, high) == #equal);
assert (Keys.compareId128(high, low) == #greater);

let tag0 : Memory.Tag256 = (0, 0, 0, 0);
let tag1 : Memory.Tag256 = (0, 0, 0, 1);
let tag2 : Memory.Tag256 = (0, 0, 1, 0);
assert (Keys.compareTag256(tag0, tag1) == #less);
assert (Keys.compareTag256(tag1, tag2) == #less);
assert (Keys.compareTag256(tag2, tag2) == #equal);

let child0 = Keys.childNameKey(zero, tag0);
let child1 = Keys.childNameKey(zero, tag1);
let child2 = Keys.childNameKey(low, tag0);
assert (Keys.compareChildNameKey(child0, child1) == #less);
assert (Keys.compareChildNameKey(child1, child2) == #less);

let block0 = Keys.blockKey(zero, 0);
let block1 = Keys.blockKey(zero, 1);
let block2 = Keys.blockKey(low, 0);
assert (Keys.compareBlockKey(block0, block1) == #less);
assert (Keys.compareBlockKey(block1, block2) == #less);

let receiptExpiry0 : Memory.PrivateReceiptExpiryKey = (10, 0, 9);
let receiptExpiry1 : Memory.PrivateReceiptExpiryKey = (10, 1, 0);
assert (
    Keys.comparePrivateReceiptExpiryKey(receiptExpiry0, receiptExpiry1) ==
    #less
);

assertBytes(
    Keys.id128Bytes({
        hi = 0x0102030405060708;
        lo = 0x1112131415161718;
    }),
    [
        1, 2, 3, 4, 5, 6, 7, 8,
        17, 18, 19, 20, 21, 22, 23, 24,
    ],
);

assertBytes(
    Keys.tag256Bytes((
        0x0102030405060708,
        0x1112131415161718,
        0x2122232425262728,
        0x3132333435363738,
    )),
    [
        1, 2, 3, 4, 5, 6, 7, 8,
        17, 18, 19, 20, 21, 22, 23, 24,
        33, 34, 35, 36, 37, 38, 39, 40,
        49, 50, 51, 52, 53, 54, 55, 56,
    ],
);

assertBytes(
    Keys.blockKeyBytes((
        0x0102030405060708,
        0x1112131415161718,
        0x21222324,
    )),
    [
        1, 2, 3, 4, 5, 6, 7, 8,
        17, 18, 19, 20, 21, 22, 23, 24,
        33, 34, 35, 36,
    ],
);

assertBytes(
    Keys.privateReceiptExpiryKeyBytes((
        0x0102030405060708,
        0x1112131415161718,
        0x2122232425262728,
    )),
    [
        1, 2, 3, 4, 5, 6, 7, 8,
        17, 18, 19, 20, 21, 22, 23, 24,
        33, 34, 35, 36, 37, 38, 39, 40,
    ],
);
