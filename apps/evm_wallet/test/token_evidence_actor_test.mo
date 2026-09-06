import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Memory "../backend/memory/evm_evidence/v1";
import Wallet "../backend/memory/evm_wallet/v1";
import Evidence "../backend/token/Evidence";
import Hex "../backend/evm/Hex";
import Json "../backend/rpc/Json";
import Rpc "../backend/rpc/Client";

persistent actor {
  public func run() : async Text {
    func bytes(value : Text) : Blob { let #ok(result) = Hex.decode(value) else { assert false; loop {} }; result };
    let wallet = "0x0000000000000000000000000000000000000001";
    let token = "0x0000000000000000000000000000000000000002";
    let spender = "0x0000000000000000000000000000000000000003";
    let source = "0x0000000000000000000000000000000000000004";
    let recipient = "0x0000000000000000000000000000000000000005";
    let word1 = "0000000000000000000000000000000000000000000000000000000000000001";
    let word3 = "0000000000000000000000000000000000000000000000000000000000000003";
    let word4 = "0000000000000000000000000000000000000000000000000000000000000004";
    let word5 = "0000000000000000000000000000000000000000000000000000000000000005";
    let amount = "0000000000000000000000000000000000000000000000000000000000000064";
    let blockHash = "0x" # Text.join(Array.repeat<Text>("ab", 32).vals(), "");
    let mem = Memory.init();
    var reads : [(Text, Text)] = [];
    var allowanceUnavailable = false;
    var malformedBalance = false;
    var blockUnavailable = false;
    let service = Evidence.Service(mem, {
      request = func(chain : Nat, method : Text, params : Text) : async* Rpc.Result<Text> {
        assert chain == 1;
        reads := Array.concat(reads, [(method, params)]);
        switch (method) {
          case ("eth_blockNumber") { if (blockUnavailable) #err("providers disagree on the head") else #ok("\"0x10\"") };
          case ("eth_getBlockByNumber") {
            assert params == "[\"0x10\",false]";
            #ok("{\"hash\":" # Json.quote(blockHash) # "}");
          };
          case ("eth_call") {
            let #ok(#array(values)) = Json.parse(params) else { assert false; loop {} };
            assert values.size() == 2 and values[1] == #string("0x10");
            assert Json.field(values[0], "from") == ?#string(wallet);
            assert Json.field(values[0], "to") == ?#string(token);
            let ?#string(data) = Json.field(values[0], "data") else { assert false; loop {} };
            if (Text.startsWith(data, #text("0x70a08231"))) {
              if (malformedBalance) #ok("\"0x00\"")
              else #ok(Json.quote("0x00000000000000000000000000000000000000000000000000000000000000c8"));
            } else {
              assert Text.startsWith(data, #text("0xdd62ed3e"));
              if (allowanceUnavailable) #err("allowance providers disagree")
              else #ok(Json.quote("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));
            };
          };
          case (_) { assert false; #err("Unexpected non-read method") };
        };
      };
    });
    let approve : Wallet.Transaction = { chainId = 1; nonce = 0; gasLimit = 50000; to = ?token; value = 0; data = bytes("0x095ea7b3" # word3 # amount); accessList = []; fee = #eip1559({ maxFeePerGas = 100; maxPriorityFeePerGas = 2 }) };
    await* service.capture(1, approve, wallet, ?"0x10");
    let ?first = service.get(1) else { assert false; loop {} };
    assert first.method == "approve" and first.owner == wallet and first.spender == ?spender;
    assert first.amount == "100" and first.recognition == "erc20_calldata";
    assert first.block_number == ?"0x10" and first.block_hash == ?blockHash;
    assert first.balance.value == ?"200" and first.balance.error == null;
    let ?allowance = first.allowance else { assert false; loop {} };
    assert allowance.value == ?Nat.toText(2 ** 256 - 1);
    assert Array.any<(Text, Text)>(reads, func((_, params)) { Text.contains(params, #text("0x70a08231" # word1)) });
    assert Array.any<(Text, Text)>(reads, func((_, params)) { Text.contains(params, #text("0xdd62ed3e" # word1 # word3)) });
    assert not Array.any<(Text, Text)>(reads, func((method, _)) { method == "eth_blockNumber" });
    // Partial failures are explicit and do not fabricate a zero allowance.
    allowanceUnavailable := true;
    await* service.capture(1, approve, wallet, null);
    let ?partial = service.get(1) else { assert false; loop {} };
    assert partial.balance.value == ?"200";
    let ?missing = partial.allowance else { assert false; loop {} };
    assert missing.value == null and missing.error == ?"allowance providers disagree";
    malformedBalance := true;
    await* service.capture(1, approve, wallet, ?"0x10");
    let ?malformed = service.get(1) else { assert false; loop {} };
    assert malformed.balance.value == null and malformed.balance.error != null;
    malformedBalance := false; allowanceUnavailable := false;
    reads := [];
    let transfer = { approve with data = bytes("0xa9059cbb" # word5 # amount) };
    await* service.capture(2, transfer, wallet, ?"0x10");
    let ?sent = service.get(2) else { assert false; loop {} };
    assert sent.method == "transfer" and sent.recipient == ?recipient and sent.spender == null and sent.allowance == null;
    assert not Array.any<(Text, Text)>(reads, func((_, params)) { Text.contains(params, #text("0xdd62ed3e")) });
    reads := [];
    let transferFrom = { approve with data = bytes("0x23b872dd" # word4 # word5 # amount) };
    await* service.capture(3, transferFrom, wallet, ?"0x10");
    let ?delegated = service.get(3) else { assert false; loop {} };
    assert delegated.method == "transferFrom" and delegated.owner == source and delegated.spender == ?wallet and delegated.recipient == ?recipient;
    assert Array.any<(Text, Text)>(reads, func((_, params)) { Text.contains(params, #text("0x70a08231" # word4)) });
    assert Array.any<(Text, Text)>(reads, func((_, params)) { Text.contains(params, #text("0xdd62ed3e" # word4 # word1)) });
    // A missing current head clears old values instead of relabeling them live.
    blockUnavailable := true;
    await* service.capture(3, transferFrom, wallet, null);
    let ?noBlock = service.get(3) else { assert false; loop {} };
    assert noBlock.block_number == null and noBlock.block_hash == null and noBlock.block_error != null;
    assert noBlock.balance.value == null and noBlock.balance.error != null;
    // Unknown selectors remain unknown; no fabricated ABI or exploratory reads.
    reads := [];
    await* service.capture(4, { approve with data = bytes("0x12345678") }, wallet, null);
    assert service.get(4) == null and reads.size() == 0;
    // Evidence is an independent root: its restoration neither recreates nor
    // changes the released wallet command and nonce objects.
    let restored : Memory.Mem = mem;
    assert Map.get(restored.observations, Nat.compare, 1) == ?malformed;
    "ERC20 balance and allowance observations preserve exact amounts, scope and unavailable states";
  };
};
