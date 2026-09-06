import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import VarArray "mo:core/VarArray";

/// Ethereum's Keccak-256 (not FIPS SHA3-256): rate 1088, capacity 512,
/// Keccak-f[1600], and original suffix 0x01. The transformation follows
/// https://keccak.team/keccak_specs_summary.html with lanes indexed x + 5*y.
module {
  let rounds : [Nat64] = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808a,
    0x8000000080008000, 0x000000000000808b, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009, 0x000000000000008a,
    0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
    0x000000008000808b, 0x800000000000008b, 0x8000000000008089,
    0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
    0x000000000000800a, 0x800000008000000a, 0x8000000080008081,
    0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
  ];
  let rotations : [Nat64] = [
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
  ];

  func permute(state : [var Nat64]) {
    let c = VarArray.repeat<Nat64>(0, 5);
    let d = VarArray.repeat<Nat64>(0, 5);
    let b = VarArray.repeat<Nat64>(0, 25);
    for (round in rounds.vals()) {
      var x = 0;
      while (x < 5) {
        c[x] := state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
        x += 1;
      };
      x := 0;
      while (x < 5) {
        d[x] := c[(x + 4) % 5] ^ Nat64.bitrotLeft(c[(x + 1) % 5], 1);
        x += 1;
      };
      var y = 0;
      while (y < 5) {
        x := 0;
        while (x < 5) {
          let i = x + 5 * y;
          b[y + 5 * ((2 * x + 3 * y) % 5)] := Nat64.bitrotLeft(state[i] ^ d[x], rotations[i]);
          x += 1;
        };
        y += 1;
      };
      y := 0;
      while (y < 5) {
        x := 0;
        while (x < 5) {
          let i = x + 5 * y;
          state[i] := b[i] ^ ((^ b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y]);
          x += 1;
        };
        y += 1;
      };
      state[0] := state[0] ^ round;
    };
  };

  public func hash(input : Blob) : Blob {
    let state = VarArray.repeat<Nat64>(0, 25);
    var position = 0;
    for (byte in input.vals()) {
      let lane = position / 8;
      state[lane] := state[lane] ^ (Nat64.fromNat(Nat8.toNat(byte)) << Nat64.fromNat(8 * (position % 8)));
      position += 1;
      if (position == 136) {
        permute(state);
        position := 0;
      };
    };
    let lane = position / 8;
    state[lane] := state[lane] ^ (1 << Nat64.fromNat(8 * (position % 8)));
    state[16] := state[16] ^ 0x8000000000000000;
    permute(state);
    Blob.fromArray(Array.tabulate<Nat8>(32, func(i) {
      Nat8.fromNat(Nat64.toNat((state[i / 8] >> Nat64.fromNat(8 * (i % 8))) & 0xff))
    }))
  };
}
