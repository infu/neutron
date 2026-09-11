// All rights reserved. See ../LICENSE.
import Test "mo:test";
import Array "mo:core/Array";
import EvmRpc "../mo/EvmRpc";

persistent actor {
  let transactionHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let blockHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let otherHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  let options : EvmRpc.Options = {
    providers = [#PublicNode, #Cloudflare, #Ankr]; receiptResponseBytes = 8_192;
    blockResponseBytes = 16_384; receiptCycles = 100; blockCycles = 200;
  };
  let receipt : EvmRpc.TransactionReceipt = {
    transactionHash; blockHash; blockNumber = 25_940_701; status = ?1;
    to = ?"0x1111111111111111111111111111111111111111"; root = null;
    from = "0x2222222222222222222222222222222222222222"; logs = [];
    type_ = "0x2"; transactionIndex = 2; effectiveGasPrice = 10;
    logsBloom = "0x00"; contractAddress = null; gasUsed = 21_000; cumulativeGasUsed = 40_000;
  };
  let block : EvmRpc.Block = {
    hash = blockHash; number = receipt.blockNumber; miner = "0x1111111111111111111111111111111111111111";
    totalDifficulty = null; receiptsRoot = otherHash; stateRoot = otherHash; difficulty = ?0;
    size = 1_000; uncles = []; baseFeePerGas = ?5; extraData = "0x";
    transactionsRoot = ?otherHash; sha3Uncles = otherHash; nonce = 0; timestamp = 1_788_967_000;
    transactions = [transactionHash]; gasLimit = 30_000_000; logsBloom = "0x00";
    parentHash = otherHash; gasUsed = 40_000; mixHash = otherHash;
  };
  let rpcError : EvmRpc.RpcError = #JsonRpcError({ code = -32_000; message = "provider unavailable" });

  // Each mock validates the complete selected provider/config/argument tuple.
  // There is no HTTP request, real EVM effect or cycle-paying remote call here.
  class Mock() {
    public var methods : [Text] = [];
    public var quotedReceipt : EvmRpc.Result<EvmRpc.RequestCostResult> = #ok(#Ok(70));
    public var gotReceipt : EvmRpc.Result<EvmRpc.MultiGetTransactionReceiptResult> = #ok(#Consistent(#Ok(?receipt)));
    public var quotedBlock : EvmRpc.Result<EvmRpc.RequestCostResult> = #ok(#Ok(150));
    public var gotBlock : EvmRpc.Result<EvmRpc.MultiGetBlockByNumberResult> = #ok(#Consistent(#Ok(block)));
    func record(method : Text, services : EvmRpc.RpcServices, config : ?EvmRpc.RpcConfig, size : Nat64) {
      methods := Array.concat(methods, [method]);
      assert services == #EthMainnet(?options.providers);
      assert config == ?{ responseSizeEstimate = ?size; responseConsensus = ?#Equality };
    };
    public func client() : EvmRpc.Client {
      {
        receiptCost = func(services : EvmRpc.RpcServices, config : ?EvmRpc.RpcConfig, hash : Text) : async* EvmRpc.Result<EvmRpc.RequestCostResult> {
          record("receipt_cost", services, config, options.receiptResponseBytes);
          assert hash == transactionHash;
          quotedReceipt;
        };
        receipt = func(cycles : Nat, services : EvmRpc.RpcServices, config : ?EvmRpc.RpcConfig, hash : Text) : async* EvmRpc.Result<EvmRpc.MultiGetTransactionReceiptResult> {
          record("receipt", services, config, options.receiptResponseBytes);
          assert hash == transactionHash;
          // Attach the caller's fixed cap; the cost query never increases it or
          // silently replaces it with a provider-selected amount.
          assert cycles == options.receiptCycles;
          gotReceipt;
        };
        blockCost = func(services : EvmRpc.RpcServices, config : ?EvmRpc.RpcConfig, tag : EvmRpc.BlockTag) : async* EvmRpc.Result<EvmRpc.RequestCostResult> {
          record("block_cost", services, config, options.blockResponseBytes);
          assert tag == #Number(receipt.blockNumber);
          quotedBlock;
        };
        block = func(cycles : Nat, services : EvmRpc.RpcServices, config : ?EvmRpc.RpcConfig, tag : EvmRpc.BlockTag) : async* EvmRpc.Result<EvmRpc.MultiGetBlockByNumberResult> {
          record("block", services, config, options.blockResponseBytes);
          assert tag == #Number(receipt.blockNumber);
          assert cycles == options.blockCycles;
          gotBlock;
        };
      };
    };
  };

  public func success_uses_three_equality_providers_and_exact_canonical_block() : async Test.Metrics {
    let mock = Mock();
    let observed = await* EvmRpc.readWith(mock.client(), options, "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    Test.test(func() {
      assert observed == #ok({ receipt; block });
      assert mock.methods == ["receipt_cost", "receipt", "block_cost", "block"];
    });
  };

  public func receipt_cost_failures_never_dispatch_paid_reads() : async Test.Metrics {
    let cases : [(EvmRpc.Result<EvmRpc.RequestCostResult>, EvmRpc.Failure)] = [
      (#ok(#Ok(101)), #budget({ method = "eth_getTransactionReceipt"; required = 101; available = 100 })),
      (#ok(#Err(rpcError)), #rpc({ method = "eth_getTransactionReceipt"; error = rpcError })),
      (#err(#transport({ method = "eth_getTransactionReceiptCyclesCost"; message = "reply lost" })), #transport({ method = "eth_getTransactionReceiptCyclesCost"; message = "reply lost" })),
    ];
    for ((input, expected) in cases.vals()) {
      let mock = Mock(); mock.quotedReceipt := input;
      assert (await* EvmRpc.readWith(mock.client(), options, transactionHash)) == #err(expected);
      assert mock.methods == ["receipt_cost"];
    };
    Test.test(func() { assert cases.size() == 3 });
  };

  public func receipt_outcomes_stop_before_any_header_query() : async Test.Metrics {
    let cases : [(EvmRpc.Result<EvmRpc.MultiGetTransactionReceiptResult>, EvmRpc.Failure)] = [
      (#ok(#Consistent(#Ok(null))), #notMined),
      (#ok(#Consistent(#Ok(?{ receipt with status = ?0 }))), #reverted),
      (#ok(#Inconsistent([(#EthMainnet(#PublicNode), #Ok(?receipt)), (#EthMainnet(#Cloudflare), #Ok(null))])), #inconsistent({ method = "eth_getTransactionReceipt" })),
      (#ok(#Consistent(#Err(rpcError))), #rpc({ method = "eth_getTransactionReceipt"; error = rpcError })),
      (#err(#transport({ method = "eth_getTransactionReceipt"; message = "timeout" })), #transport({ method = "eth_getTransactionReceipt"; message = "timeout" })),
    ];
    for ((input, expected) in cases.vals()) {
      let mock = Mock(); mock.gotReceipt := input;
      assert (await* EvmRpc.readWith(mock.client(), options, transactionHash)) == #err(expected);
      assert mock.methods == ["receipt_cost", "receipt"];
    };
    Test.test(func() { assert cases.size() == 5 });
  };

  public func mismatched_or_statusless_receipts_never_fetch_headers() : async Test.Metrics {
    let cases : [EvmRpc.TransactionReceipt] = [
      { receipt with transactionHash = otherHash },
      { receipt with transactionHash = "0x1234" },
      { receipt with blockHash = "0x1234" },
      { receipt with status = null },
      { receipt with status = ?2 },
    ];
    for (input in cases.vals()) {
      let mock = Mock(); mock.gotReceipt := #ok(#Consistent(#Ok(?input)));
      switch (await* EvmRpc.readWith(mock.client(), options, transactionHash)) {
        case (#err(#invalidEvidence(_))) {}; case (_) assert false;
      };
      assert mock.methods == ["receipt_cost", "receipt"];
    };
    Test.test(func() { assert cases.size() == 5 });
  };

  public func header_cost_failures_never_dispatch_paid_header() : async Test.Metrics {
    let cases : [(EvmRpc.Result<EvmRpc.RequestCostResult>, EvmRpc.Failure)] = [
      (#ok(#Ok(201)), #budget({ method = "eth_getBlockByNumber"; required = 201; available = 200 })),
      (#ok(#Err(rpcError)), #rpc({ method = "eth_getBlockByNumber"; error = rpcError })),
      (#err(#transport({ method = "eth_getBlockByNumberCyclesCost"; message = "timeout" })), #transport({ method = "eth_getBlockByNumberCyclesCost"; message = "timeout" })),
    ];
    for ((input, expected) in cases.vals()) {
      let mock = Mock(); mock.quotedBlock := input;
      assert (await* EvmRpc.readWith(mock.client(), options, transactionHash)) == #err(expected);
      assert mock.methods == ["receipt_cost", "receipt", "block_cost"];
    };
    Test.test(func() { assert cases.size() == 3 });
  };

  public func inconsistent_and_failed_canonical_headers_are_not_success() : async Test.Metrics {
    let cases : [(EvmRpc.Result<EvmRpc.MultiGetBlockByNumberResult>, EvmRpc.Failure)] = [
      (#ok(#Inconsistent([(#EthMainnet(#PublicNode), #Ok(block)), (#EthMainnet(#Cloudflare), #Ok({ block with hash = otherHash }))])), #inconsistent({ method = "eth_getBlockByNumber" })),
      (#ok(#Consistent(#Err(rpcError))), #rpc({ method = "eth_getBlockByNumber"; error = rpcError })),
      (#err(#transport({ method = "eth_getBlockByNumber"; message = "timeout" })), #transport({ method = "eth_getBlockByNumber"; message = "timeout" })),
    ];
    for ((input, expected) in cases.vals()) {
      let mock = Mock(); mock.gotBlock := input;
      assert (await* EvmRpc.readWith(mock.client(), options, transactionHash)) == #err(expected);
      assert mock.methods == ["receipt_cost", "receipt", "block_cost", "block"];
    };
    Test.test(func() { assert cases.size() == 3 });
  };

  public func changed_canonical_hash_or_height_invalidates_receipt() : async Test.Metrics {
    let cases : [EvmRpc.Block] = [
      { block with hash = otherHash },
      { block with number = receipt.blockNumber + 1 },
      { block with hash = "0x1234" },
    ];
    for (input in cases.vals()) {
      let mock = Mock(); mock.gotBlock := #ok(#Consistent(#Ok(input)));
      switch (await* EvmRpc.readWith(mock.client(), options, transactionHash)) {
        case (#err(#invalidEvidence(_))) {}; case (_) assert false;
      };
      assert mock.methods == ["receipt_cost", "receipt", "block_cost", "block"];
    };
    Test.test(func() { assert cases.size() == 3 });
  };

  public func invalid_provider_selection_or_budgets_make_no_calls() : async Test.Metrics {
    let cases : [EvmRpc.Options] = [
      { options with providers = [] },
      { options with providers = [#PublicNode, #Ankr] },
      { options with providers = [#PublicNode, #Ankr, #Cloudflare, #Llama] },
      { options with providers = [#PublicNode, #PublicNode, #Ankr] },
      { options with providers = [#PublicNode, #Ankr, #PublicNode] },
      { options with providers = [#PublicNode, #Ankr, #Ankr] },
      { options with receiptResponseBytes = 0 }, { options with blockResponseBytes = 0 },
      { options with receiptCycles = 0 }, { options with blockCycles = 0 },
    ];
    for (input in cases.vals()) {
      let mock = Mock();
      switch (await* EvmRpc.readWith(mock.client(), input, transactionHash)) {
        case (#err(#invalidRequest(_))) {}; case (_) assert false;
      };
      assert mock.methods == [];
    };
    Test.test(func() { assert cases.size() == 10 });
  };

  public func invalid_hashes_make_no_calls() : async Test.Metrics {
    let cases = ["", "0x", "0x1234", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaag", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
    for (input in cases.vals()) {
      let mock = Mock();
      switch (await* EvmRpc.readWith(mock.client(), options, input)) {
        case (#err(#invalidRequest(_))) {}; case (_) assert false;
      };
      assert mock.methods == [];
    };
    Test.test(func() { assert cases.size() == 6 });
  };
}
