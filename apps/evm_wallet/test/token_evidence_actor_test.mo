import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Memory "../backend/memory/evm_evidence/v1";
import Wallet "../backend/memory/evm_wallet/v1";
import Evidence "../backend/token/Evidence";
import Hex "../backend/evm/Hex";

persistent actor {
  public func run() : async Text {
    func bytes(value : Text) : Blob { let #ok(result) = Hex.decode(value) else { assert false; loop {} }; result };
    let wallet = "0x0000000000000000000000000000000000000001";
    let token = "0x0000000000000000000000000000000000000002";
    let spender = "0x0000000000000000000000000000000000000003";
    let source = "0x0000000000000000000000000000000000000004";
    let recipient = "0x0000000000000000000000000000000000000005";
    let word3 = "0000000000000000000000000000000000000000000000000000000000000003";
    let word4 = "0000000000000000000000000000000000000000000000000000000000000004";
    let word5 = "0000000000000000000000000000000000000000000000000000000000000005";
    let amount = "0000000000000000000000000000000000000000000000000000000000000064";
    let blockHash = "0x" # Text.join(Array.repeat<Text>("ab", 32).vals(), "");
    let mem = Memory.init();
    // No RPC client or backend capability is needed to retain public reads.
    let service = Evidence.Service(mem);
    let approve : Wallet.Transaction = { chainId = 1; nonce = 0; gasLimit = 50000; to = ?token; value = 0; data = bytes("0x095ea7b3" # word3 # amount); accessList = []; fee = #eip1559({ maxFeePerGas = 100; maxPriorityFeePerGas = 2 }) };
    let observed : Evidence.Observation = {
      block_number = ?"0x10"; block_hash = ?blockHash; block_error = null;
      balance = { value = ?"200"; error = null };
      allowance = ?{ value = ?Nat.toText(2 ** 256 - 1); error = null };
    };
    assert service.capture(1, approve, wallet, observed) == #ok(());
    let ?first = service.get(1) else { assert false; loop {} };
    assert first.method == "approve" and first.owner == wallet and first.spender == ?spender;
    assert first.amount == "100" and first.recognition == "erc20_calldata";
    assert first.block_number == ?"0x10" and first.block_hash == ?blockHash;
    assert first.balance.value == ?"200" and first.balance.error == null;
    let ?allowance = first.allowance else { assert false; loop {} };
    assert allowance.value == ?Nat.toText(2 ** 256 - 1);

    // Partial provider failures are explicit and do not fabricate a zero allowance.
    assert service.capture(1, approve, wallet, { observed with allowance = ?{ value = null; error = ?"allowance provider failed" } }) == #ok(());
    let ?partial = service.get(1) else { assert false; loop {} };
    assert partial.balance.value == ?"200";
    let ?missing = partial.allowance else { assert false; loop {} };
    assert missing.value == null and missing.error == ?"allowance provider failed";
    assert service.capture(1, approve, wallet, { observed with block_hash = null; block_error = ?"hash provider failed" }) == #ok(());
    let ?partialBlock = service.get(1) else { assert false; loop {} };
    assert partialBlock.block_number == ?"0x10" and partialBlock.block_hash == null;
    assert partialBlock.block_error == ?"hash provider failed" and partialBlock.balance.value == ?"200";

    // Malformed observations cannot replace the previous review's valid facts.
    let malformed = [
      { observed with block_number = ?"latest" },
      { observed with block_hash = ?"0x00" },
      { observed with block_error = ?"hash failed despite a value" },
      { observed with balance = { value = ?Nat.toText(2 ** 256); error = null } },
      { observed with balance = { value = ?"-1"; error = null } },
      { observed with balance = { value = ?"0x01"; error = null } },
      { observed with balance = { value = ?"1e2"; error = null } },
      { observed with balance = { value = ?"0"; error = ?"failed" } },
      { observed with balance = { value = null; error = null } },
      { observed with allowance = null },
    ];
    for (input in malformed.vals()) {
      let #err(_) = service.capture(1, approve, wallet, input) else { assert false; loop {} };
      assert service.get(1) == ?partialBlock;
    };

    // Method, owner, spender, recipient and amount come from the transaction;
    // transfer has no allowance, while transferFrom uses its encoded owner.
    let transfer = { approve with data = bytes("0xa9059cbb" # word5 # amount) };
    let #err(_) = service.capture(2, transfer, wallet, observed) else { assert false; loop {} };
    assert service.get(2) == null;
    assert service.capture(2, transfer, wallet, { observed with allowance = null }) == #ok(());
    let ?sent = service.get(2) else { assert false; loop {} };
    assert sent.method == "transfer" and sent.owner == wallet and sent.recipient == ?recipient and sent.spender == null and sent.allowance == null;
    let transferFrom = { approve with data = bytes("0x23b872dd" # word4 # word5 # amount) };
    assert service.capture(3, transferFrom, wallet, observed) == #ok(());
    let ?delegated = service.get(3) else { assert false; loop {} };
    assert delegated.method == "transferFrom" and delegated.owner == source and delegated.spender == ?wallet and delegated.recipient == ?recipient;

    // A missing current head clears old values instead of relabeling them live,
    // even if a caller accidentally includes successful readings from last time.
    assert service.capture(3, transferFrom, wallet, { observed with block_number = null; block_error = ?"head unavailable" }) == #ok(());
    let ?noBlock = service.get(3) else { assert false; loop {} };
    assert noBlock.block_number == null and noBlock.block_hash == null and noBlock.block_error == ?"head unavailable";
    assert noBlock.balance.value == null and noBlock.balance.error == ?"No observation block: head unavailable";
    let ?noAllowance = noBlock.allowance else { assert false; loop {} };
    assert noAllowance.value == null and noAllowance.error != null;

    // Unknown or malformed selectors do not acquire a fabricated ABI. If an
    // operation no longer carries recognized calldata, discard its old evidence.
    assert service.capture(1, { approve with data = bytes("0x12345678") }, wallet, observed) == #ok(());
    assert service.get(1) == null;
    assert service.capture(2, { transfer with to = null }, wallet, observed) == #ok(());
    assert service.get(2) == null;

    // Evidence remains in its independent released root across service restore.
    let restored = Evidence.Service(mem);
    assert restored.get(3) == ?noBlock;
    assert Map.get(mem.observations, Nat.compare, 3) == ?noBlock;
    restored.fail(3, "refresh unavailable");
    let ?failed = restored.get(3) else { assert false; loop {} };
    assert failed.balance.value == null and failed.balance.error == ?"refresh unavailable";
    restored.clear(3);
    assert restored.get(3) == null;
    "Browser ERC20 observations preserve exact amounts, transaction attribution and unavailable states without canister RPC";
  };
};
