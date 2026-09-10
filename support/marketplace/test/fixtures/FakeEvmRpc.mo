import Array "mo:core/Array";
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Rpc "../../mo/EvmRpc";

// Local PocketIC only. This actor never makes HTTP outcalls. Its production
// method signatures deliberately use the same wire projection as the client.
persistent actor class FakeEvmRpc() {
    public type Behavior = { #normal; #reject : Text; #hold : Principal };
    public type Observation = {
        method : { #receipt : Text; #block : Rpc.BlockTag };
        caller : Principal; services : Rpc.RpcServices; config : ?Rpc.RpcConfig;
        attachedCycles : Nat; acceptedCycles : Nat;
    };
    type ReceiptEntry = { hash : Text; result : Rpc.MultiGetTransactionReceiptResult };
    type BlockEntry = { number : Nat; result : Rpc.MultiGetBlockByNumberResult };
    var receipt : Rpc.MultiGetTransactionReceiptResult = #Consistent(#Ok(null));
    var block : Rpc.MultiGetBlockByNumberResult = #Consistent(#Err(#ValidationError(#Custom("No fixture block configured"))));
    var receiptEntries : [ReceiptEntry] = [];
    var blockEntries : [BlockEntry] = [];
    var receiptCost : Rpc.RequestCostResult = #Ok(1);
    var blockCost : Rpc.RequestCostResult = #Ok(1);
    var receiptCostError : ?Text = null;
    var blockCostError : ?Text = null;
    var receiptBehavior : Behavior = #normal;
    var blockBehavior : Behavior = #normal;
    var receiptCalls : Nat = 0;
    var blockCalls : Nat = 0;
    var observations : [Observation] = [];

    public shared func setReceipt(value : Rpc.MultiGetTransactionReceiptResult) : async () { receipt := value };
    public shared func setBlock(value : Rpc.MultiGetBlockByNumberResult) : async () { block := value };
    public shared func setReceiptFor(hash : Text, value : Rpc.MultiGetTransactionReceiptResult) : async () {
        let normalized = Text.toLower(hash);
        receiptEntries := Array.concat<ReceiptEntry>(
            Array.filter<ReceiptEntry>(receiptEntries, func(entry) { entry.hash != normalized }),
            [{ hash = normalized; result = value }],
        );
    };
    public shared func setBlockFor(number : Nat, value : Rpc.MultiGetBlockByNumberResult) : async () {
        blockEntries := Array.concat<BlockEntry>(
            Array.filter<BlockEntry>(blockEntries, func(entry) { entry.number != number }),
            [{ number; result = value }],
        );
    };
    public shared func setCosts(value : { receipt : Rpc.RequestCostResult; block : Rpc.RequestCostResult }) : async () {
        receiptCost := value.receipt;
        blockCost := value.block;
    };
    public shared func setCostErrors(value : { receipt : ?Text; block : ?Text }) : async () {
        receiptCostError := value.receipt;
        blockCostError := value.block;
    };
    public shared func setBehavior(value : { receipt : Behavior; block : Behavior }) : async () {
        receiptBehavior := value.receipt;
        blockBehavior := value.block;
    };
    public shared query func stats() : async { receiptCalls : Nat; blockCalls : Nat; observations : [Observation] } {
        { receiptCalls; blockCalls; observations }
    };

    // Cost methods are genuine queries. They cannot persist a query counter;
    // only the replicated paid calls below appear in observations.
    public shared query func eth_getTransactionReceiptCyclesCost(_services : Rpc.RpcServices, _config : ?Rpc.RpcConfig, _hash : Text) : async Rpc.RequestCostResult {
        switch (receiptCostError) { case (?message) throw Error.reject(message); case null receiptCost }
    };
    public shared query func eth_getBlockByNumberCyclesCost(_services : Rpc.RpcServices, _config : ?Rpc.RpcConfig, _tag : Rpc.BlockTag) : async Rpc.RequestCostResult {
        switch (blockCostError) { case (?message) throw Error.reject(message); case null blockCost }
    };

    func charge<system>(cost : Rpc.RequestCostResult) : { #ok : Nat; #err : Rpc.RpcError } {
        switch (cost) {
            case (#Err(error)) #err(error);
            case (#Ok(required)) {
                let available = Cycles.available();
                if (available < required) return #err(#ProviderError(#TooFewCycles({ expected = required; received = available })));
                #ok(Cycles.accept<system>(required));
            };
        }
    };
    func wait(behavior : Behavior) : async* () {
        switch (behavior) {
            case (#normal) {};
            case (#reject(message)) throw Error.reject(message);
            case (#hold(principal)) {
                let gate : actor { wait : shared () -> async () } = actor (Principal.toText(principal));
                await gate.wait();
            };
        }
    };
    func receiptFor(hash : Text) : Rpc.MultiGetTransactionReceiptResult {
        switch (Array.find<ReceiptEntry>(receiptEntries, func(entry) { entry.hash == Text.toLower(hash) })) {
            case (?entry) entry.result;
            case null receipt;
        }
    };
    func blockFor(tag : Rpc.BlockTag) : Rpc.MultiGetBlockByNumberResult {
        switch (tag) {
            case (#Number(number)) {
                switch (Array.find<BlockEntry>(blockEntries, func(entry) { entry.number == number })) {
                    case (?entry) entry.result;
                    case null block;
                }
            };
            case _ block;
        }
    };
    public shared ({ caller }) func eth_getTransactionReceipt(services : Rpc.RpcServices, config : ?Rpc.RpcConfig, hash : Text) : async Rpc.MultiGetTransactionReceiptResult {
        receiptCalls += 1;
        let attachedCycles = Cycles.available();
        let charged = charge<system>(receiptCost);
        let acceptedCycles = switch (charged) { case (#ok(value)) value; case (#err(_)) 0 };
        observations := Array.concat<Observation>(observations, [{ method = #receipt(hash); caller; services; config; attachedCycles; acceptedCycles }]);
        switch (charged) { case (#err(error)) return #Consistent(#Err(error)); case _ {} };
        let result = receiptFor(hash);
        await* wait(receiptBehavior);
        result
    };
    public shared ({ caller }) func eth_getBlockByNumber(services : Rpc.RpcServices, config : ?Rpc.RpcConfig, tag : Rpc.BlockTag) : async Rpc.MultiGetBlockByNumberResult {
        blockCalls += 1;
        let attachedCycles = Cycles.available();
        let charged = charge<system>(blockCost);
        let acceptedCycles = switch (charged) { case (#ok(value)) value; case (#err(_)) 0 };
        observations := Array.concat<Observation>(observations, [{ method = #block(tag); caller; services; config; attachedCycles; acceptedCycles }]);
        switch (charged) { case (#err(error)) return #Consistent(#Err(error)); case _ {} };
        let result = blockFor(tag);
        await* wait(blockBehavior);
        result
    };
};
