import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Codec "../../backend/certified_assets/Codec";

func pattern(offset : Nat, count : Nat) : Blob {
    Blob.fromArray(
        Array.tabulate<Nat8>(
            count,
            func(index : Nat) : Nat8 {
                Nat8.fromNat((offset + index) % 251);
            },
        )
    );
};

func serializedCopy(state : Codec.Sha256State) : Codec.Sha256State {
    {
        h0 = state.h0;
        h1 = state.h1;
        h2 = state.h2;
        h3 = state.h3;
        h4 = state.h4;
        h5 = state.h5;
        h6 = state.h6;
        h7 = state.h7;
        total_bytes = state.total_bytes;
        tail = state.tail;
    };
};

func check(length : Nat, expected : Text) : () {
    let body = pattern(0, length);
    let state = Codec.sha256Update(Codec.sha256Init(), body);
    assert Codec.sha256StateValid(state);
    let persisted = serializedCopy(state);
    let digest = Codec.sha256Finalize(persisted);
    assert Codec.hex(digest) == expected;
    assert Codec.sha256Finalize(persisted) == digest;
    assert persisted == state;
};

check(0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
check(1, "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d");
check(55, "463eb28e72f82e0a96c0a4cc53690c571281131f672aa229e0d45ae59b598b59");
check(56, "da2ae4d6b36748f2a318f23e7ab1dfdf45acdc9d049bd80e59de82a60895f562");
check(63, "29af2686fd53374a36b0846694cc342177e428d1647515f078784d69cdb9e488");
check(64, "fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108");
check(65, "4bfd2c8b6f1eec7a2afeb48b934ee4b2694182027e6d0fc075074f2fabb31781");
check(65_535, "dda402a2c028f0cbbdbc5c6ebae965eed9c75f71236e7022b0386d3455d5ae2f");
check(65_536, "4b640d85ab3ba30fd02c9fc9db4a8928f416322ad27022ea58a65aaee68a4df2");
check(65_537, "237356e18b503616912abb8ffaed3a72591e397d4ac294c4637917d48a3f529d");

var resumed = Codec.sha256Init();
resumed := Codec.sha256Update(resumed, pattern(0, 1));
resumed := Codec.sha256Update(serializedCopy(resumed), pattern(1, 54));
resumed := Codec.sha256Update(serializedCopy(resumed), pattern(55, 1));
resumed := Codec.sha256Update(serializedCopy(resumed), pattern(56, 8));
resumed := Codec.sha256Update(serializedCopy(resumed), pattern(64, 1));
assert Codec.sha256StateValid(resumed);
assert (
    Codec.hex(Codec.sha256Finalize(resumed)) ==
    "4bfd2c8b6f1eec7a2afeb48b934ee4b2694182027e6d0fc075074f2fabb31781"
);

let initial = Codec.sha256Init();
assert Codec.sha256StateValid(initial);
assert not Codec.sha256StateValid({
    initial with
    total_bytes = 1;
});
assert not Codec.sha256StateValid({
    initial with
    total_bytes = 64;
    tail = pattern(0, 64);
});
assert not Codec.sha256StateValid({
    initial with
    total_bytes = 2_305_843_009_213_693_952;
});

// A byte count of 2^32 must use all 64 bits of SHA-256's bit-length field.
assert (
    Codec.hex(Codec.u64be((4_294_967_296 : Nat64) * 8)) ==
    "0000000800000000"
);
let syntheticLongState : Codec.Sha256State = {
    initial with
    total_bytes = 4_294_967_296;
};
assert Codec.sha256StateValid(syntheticLongState);
assert (
    Codec.hex(Codec.sha256Finalize(syntheticLongState)) ==
    "7ccf0d399639597c6ac9bd868695ea3bdcba23e33da8cb4e089e20cdff2e3300"
);
