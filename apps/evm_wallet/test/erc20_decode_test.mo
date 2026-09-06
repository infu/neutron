import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Decode "../backend/token/Decode";
import Hex "../backend/evm/Hex";

func bytes(input : Text) : Blob {
  switch (Hex.decode(input)) { case (#ok(value)) value; case (#err(error)) Runtime.trap(error) }
};
func decoded(input : Text) : Decode.Decoded {
  let ?value = Decode.decode(token, wallet, bytes(input)) else Runtime.trap("Expected recognized calldata");
  value
};

let token = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
let wallet = "0x1111111111111111111111111111111111111111";
let owner = "0x2222222222222222222222222222222222222222";
let spender = "0x3333333333333333333333333333333333333333";
let recipient = "0x4444444444444444444444444444444444444444";
// Literal ABI words and expected calls keep the vectors independent of the decoder.
let zeroWord = "0000000000000000000000000000000000000000000000000000000000000000";
let maxWord = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
let ownerWord = "0000000000000000000000002222222222222222222222222222222222222222";
let spenderWord = "0000000000000000000000003333333333333333333333333333333333333333";
let recipientWord = "0000000000000000000000004444444444444444444444444444444444444444";
let amountWord = "0000000000000000000000000000000000000000000000000000000000000102";

let approveMax = "0x095ea7b3" # spenderWord # maxWord;
let approval = decoded(approveMax);
assert approval.method == "approve";
assert approval.token == "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
assert approval.owner == wallet;
assert approval.spender == ?spender;
assert approval.recipient == null;
assert approval.amount == 115792089237316195423570985008687907853269984665640564039457584007913129639935;
assert approval.balance_call == "0x70a082310000000000000000000000001111111111111111111111111111111111111111";
assert approval.allowance_call == ?"0xdd62ed3e00000000000000000000000011111111111111111111111111111111111111110000000000000000000000003333333333333333333333333333333333333333";
assert decoded("0x095ea7b3" # spenderWord # zeroWord).amount == 0;

let transferZero = "0xa9059cbb" # recipientWord # zeroWord;
let transfer = decoded(transferZero);
assert transfer.method == "transfer";
assert transfer.owner == wallet;
assert transfer.spender == null;
assert transfer.recipient == ?recipient;
assert transfer.amount == 0;
assert transfer.balance_call == approval.balance_call;
assert transfer.allowance_call == null;
assert decoded("0xa9059cbb" # recipientWord # maxWord).amount == approval.amount;

let delegatedTransfer = "0x23b872dd" # ownerWord # recipientWord # amountWord;
let delegated = decoded(delegatedTransfer);
assert delegated.method == "transferFrom";
assert delegated.owner == owner;
assert delegated.spender == ?wallet;
assert delegated.recipient == ?recipient;
assert delegated.amount == 258;
assert delegated.balance_call == "0x70a082310000000000000000000000002222222222222222222222222222222222222222";
assert delegated.allowance_call == ?"0xdd62ed3e00000000000000000000000022222222222222222222222222222222222222220000000000000000000000001111111111111111111111111111111111111111";
assert decoded("0x23b872dd" # ownerWord # recipientWord # maxWord).amount == approval.amount;

// Zero addresses are valid ABI addresses; no token policy is inferred here.
let burnShaped = decoded("0xa9059cbb" # zeroWord # amountWord);
assert burnShaped.recipient == ?"0x0000000000000000000000000000000000000000";

for (input in [approveMax, transferZero, delegatedTransfer].vals()) {
  let complete = bytes(input);
  let full = Blob.toArray(complete);
  var length = 0;
  while (length < full.size()) {
    // Every truncation, including incomplete selectors and one-byte-short words.
    assert Decode.decode(token, wallet, Blob.fromArray(Array.tabulate<Nat8>(length, func(i) { full[i] }))) == null;
    length += 1;
  };
  assert Decode.decode(token, wallet, bytes(input # "00")) == null;
  assert Decode.decode(token, wallet, bytes(input # zeroWord)) == null;
  // Every byte of address padding must be zero, not only its leading byte.
  for (offset in (if (full.size() == 100) [4, 36] else [4]).vals()) {
    var i = 0;
    while (i < 12) {
      let bad = Blob.fromArray(Array.tabulate<Nat8>(full.size(), func(j) { if (j == offset + i) 1 else full[j] }));
      assert Decode.decode(token, wallet, bad) == null;
      i += 1;
    };
  };
  for (invalidAddress in ["", "0x", "0x1234", "1111111111111111111111111111111111111111", "0x111111111111111111111111111111111111111111", "0xgg11111111111111111111111111111111111111"].vals()) {
    assert Decode.decode(invalidAddress, wallet, complete) == null;
    assert Decode.decode(token, invalidAddress, complete) == null;
  };
};

// Unknown methods and known read selectors do not imply a transfer or approval.
for (selector in ["0xdeadbeef", "0x70a08231", "0xdd62ed3e", "0x00000000"].vals()) {
  assert Decode.decode(token, wallet, bytes(selector # spenderWord # zeroWord)) == null;
  assert Decode.decode(token, wallet, bytes(selector # ownerWord # recipientWord # zeroWord)) == null;
};
Debug.print("ERC-20 calldata decoding passed");
