// All rights reserved. See ../LICENSE.
// Official helper ABI: https://github.com/dfinity/ic/blob/b75c0e59d0d6c1f8cd652f188eaf4f59dd41e83e/rs/ethereum/cketh/minter/DepositHelperWithSubaccount.sol
import Array "mo:core/Array";
import Char "mo:core/Char";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Encoding "./Encoding";
import Minter "./EvmMinter";
import Rpc "./EvmRpc";

module {
  // keccak256("ReceivedEthOrErc20(address,address,uint256,bytes32,bytes32)")
  public let eventTopic = "0x918adbebdb8f3b36fc337ab76df10b147b2def5c9dd62cb3456d9aeca40e0b07";
  public type Expected = {
    chainId : Nat; helper : Text; token : Text; payer : Text; recipient : Principal;
    subaccount : Blob; amount : Nat; transactionHash : Text;
  };
  public type Proof = {
    eventKey : Text; transactionHash : Text; logIndex : Nat; blockNumber : Nat;
    blockHash : Text; payer : Text; amount : Nat;
  };
  public type Result<T> = { #ok : T; #err : Text };
  public func principalWord(recipient : Principal) : Text { "0x" # Encoding.hex(Minter.principalWord(recipient)) };
  func body(value : Text, bytes : Nat) : ?Text {
    switch (Text.stripStart(Text.toLower(value), #text("0x"))) {
      case (?hex) { if (Encoding.isHex(hex, bytes)) ?hex else null };
      case null null;
    };
  };
  func same(left : Text, right : Text, bytes : Nat) : Bool {
    switch (body(left, bytes), body(right, bytes)) { case (?a, ?b) a == b; case (_) false };
  };
  func addressTopic(value : Text) : ?Text {
    switch (body(value, 20)) { case (?hex) ?("0x000000000000000000000000" # hex); case null null };
  };
  func uint256(hex : Text) : Nat {
    var value : Nat = 0;
    for (character in hex.chars()) {
      let code = Nat32.toNat(Char.toNat32(character));
      let digit = if (character <= '9') code - 48 else code - 87;
      value := value * 16 + digit;
    };
    value;
  };
  public func validate(expected : Expected) : Result<()> {
    if (expected.chainId != 1) return #err("Only Ethereum mainnet USDC deposits are supported");
    if (not same(expected.token, Minter.usdcAddress, 20)) return #err("Invoice token is not canonical Ethereum USDC");
    if (body(expected.helper, 20) == null or body(expected.payer, 20) == null) return #err("Invoice helper and payer must be Ethereum addresses");
    if (body(expected.transactionHash, 32) == null) return #err("Invoice transaction hash must contain exactly 32 bytes");
    if (expected.subaccount.size() != 32) return #err("Invoice subaccount must contain exactly 32 bytes");
    if (expected.amount == 0 or expected.amount >= 2 ** 256) return #err("Invoice deposit amount must be a positive uint256");
    #ok(());
  };
  // A receipt is mined evidence, not finality, ckUSDC settlement, or permission
  // to grant an app. The caller must consume eventKey atomically with its invoice
  // and entitlement journal and keep proceeds unavailable until ledger settlement.
  public func verify(expected : Expected, receipt : Rpc.TransactionReceipt, block : Rpc.Block) : Result<Proof> {
    switch (validate(expected)) { case (#err(error)) return #err(error); case (_) {} };
    if (receipt.status != ?1) return #err("Ethereum deposit receipt is not successful");
    if (not same(receipt.transactionHash, expected.transactionHash, 32)) return #err("Receipt transaction hash does not match the invoice");
    if (not same(receipt.blockHash, block.hash, 32) or receipt.blockNumber != block.number) return #err("Receipt is not in the observed canonical Ethereum block");
    // The helper's indexed owner is the token payer. receipt.from can instead
    // be a relayer/bundler when a contract wallet invokes the helper.
    let ?tokenTopic = addressTopic(expected.token) else return #err("Invalid invoice token");
    let ?payerTopic = addressTopic(expected.payer) else return #err("Invalid invoice payer");
    let recipientTopic = principalWord(expected.recipient);
    var matched : ?Proof = null;
    label events for (log in receipt.logs.vals()) {
      // Other events (including the token Transfer) are not deposit evidence.
      if (same(log.address, expected.helper, 20) and log.topics.size() > 0 and same(log.topics[0], eventTopic, 32)) {
        // A contract wallet may pay multiple invoices in one transaction.
        // Unrelated events, even malformed ones, cannot prove this invoice and
        // must not invalidate a separate exact matching deposit.
        if (log.topics.size() != 4) continue events;
        if (not same(log.topics[1], tokenTopic, 32) or not same(log.topics[2], payerTopic, 32) or not same(log.topics[3], recipientTopic, 32)) {
          continue events;
        };
        let ?data = body(log.data, 64) else continue events;
        let chars = Text.toArray(data);
        let amountHex = Text.fromIter(Array.tabulate<Char>(64, func(index) { chars[index] }).vals());
        let subaccountHex = Text.fromIter(Array.tabulate<Char>(64, func(index) { chars[index + 64] }).vals());
        if (uint256(amountHex) != expected.amount or subaccountHex != Encoding.hex(expected.subaccount)) {
          continue events;
        };
        if (log.removed) return #err("Helper deposit event was removed from the canonical chain");
        let ?logIndex = log.logIndex else return #err("Helper deposit event has no log index");
        let ?hash = log.transactionHash else return #err("Helper deposit event has no transaction hash");
        let ?blockHash = log.blockHash else return #err("Helper deposit event has no block hash");
        if (not same(hash, receipt.transactionHash, 32) or not same(blockHash, receipt.blockHash, 32) or log.blockNumber != ?receipt.blockNumber or log.transactionIndex != ?receipt.transactionIndex) {
          return #err("Helper deposit event metadata does not match its receipt");
        };
        if (matched != null) return #err("Multiple helper deposits match this invoice; explicit event selection is required");
        let transactionHash = Text.toLower(receipt.transactionHash);
        matched := ?{
          eventKey = "1:" # transactionHash # ":" # Nat.toText(logIndex);
          transactionHash; logIndex; blockNumber = receipt.blockNumber;
          blockHash = Text.toLower(receipt.blockHash); payer = Text.toLower(expected.payer); amount = expected.amount;
        };
      };
    };
    switch matched { case (?proof) #ok(proof); case null #err("No matching official helper deposit event was found") };
  };
  public func verifyWith(calls : Rpc.Client, options : Rpc.Options, expected : Expected) : async* Rpc.Result<Proof> {
    switch (validate(expected)) { case (#err(error)) return #err(#invalidRequest(error)); case (_) {} };
    switch (await* Rpc.readWith(calls, options, expected.transactionHash)) {
      case (#err(error)) #err(error);
      case (#ok(value)) switch (verify(expected, value.receipt, value.block)) {
        case (#ok(proof)) #ok(proof);
        case (#err(error)) #err(#invalidEvidence(error));
      };
    };
  };
}
