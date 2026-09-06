import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Capabilities "../../backend/capabilities/Types";
import Settlement "../../backend/transfers/Settlement";

// These are independent fixtures for the published minter interfaces, executed
// as compiled IC Wasm so Candid width and variant compatibility are exercised.
persistent actor {
public func run() : async () {
    let minter = Principal.fromText("mqygn-kiaaa-aaaar-qaadq-cai");
    let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
    let block : Nat64 = 18_446_744_073_709_551_615;
    let requests = [
        (Settlement.requestBtc(minter, block), "retrieve_btc_status_v2"),
        (Settlement.requestDoge(minter, block), "retrieve_doge_status"),
        (Settlement.requestSol(minter, block), "withdrawal_status"),
    ];
    for ((request, method) in requests.vals()) {
        assert (request.canister == minter and request.method == method and request.cycles == 0);
        let decoded : ?{ block_index : Nat64 } = from_candid request.args;
        assert (decoded == ?{ block_index = block });
        let wrongScalar : ?Nat64 = from_candid request.args;
        assert (wrongScalar == null);
    };
    // Ethereum retains its existing scalar argument, unlike the three additions.
    let ethRequest = Settlement.request(minter, block);
    let ethBlock : ?Nat64 = from_candid ethRequest.args;
    assert (ethRequest.method == "retrieve_eth_status" and ethBlock == ?block);

    type Account = { owner : Principal; subaccount : ?Blob };
    type Reason = { #CallFailed; #TaintedDestination : { kyt_fee : Nat64; kyt_provider : Principal } };
    type RemoteUtxo = {
        #Unknown;
        #Pending;
        #Signing;
        #Sending : { txid : Blob };
        #Submitted : { txid : Blob };
        #AmountTooLow;
        #Confirmed : { txid : Blob };
        #WillReimburse : { account : Account; amount : Nat64; reason : Reason };
        #Reimbursed : { account : Account; amount : Nat64; reason : Reason; mint_block_index : Nat64 };
    };
    func utxo(value : RemoteUtxo) : Settlement.Status {
        Settlement.classifyUtxo(#ok(to_candid (value)));
    };
    func pending(status : Settlement.Status) {
        switch (status) { case (#pending(message)) assert (message.size() > 0); case (_) assert false };
    };
    func unknown(status : Settlement.Status) {
        switch (status) { case (#unknown(message)) assert (message.size() > 0); case (_) assert false };
    };

    // Non-palindromic bytes make an accidental forward encoding observable.
    // Official ic_btc_interface::Txid Display reverses its Candid blob bytes.
    let txid : Blob = "\00\01\02\03\04\05\06\07\08\09\0a\0b\0c\0d\0e\0f\10\11\12\13\14\15\16\17\18\19\1a\1b\1c\1d\1e\1f";
    let displayed = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
    for (value in ([#Pending, #Signing] : [RemoteUtxo]).vals()) pending(utxo(value));
    unknown(utxo(#Unknown));
    switch (utxo(#Sending({ txid }))) {
        case (#pending(message)) assert (Text.contains(message, #text(displayed)));
        case (_) assert false;
    };
    switch (utxo(#Submitted({ txid }))) {
        case (#submitted(value)) assert (value.transaction_hash == displayed);
        case (_) assert false;
    };
    switch (utxo(#Confirmed({ txid }))) {
        case (#confirmed(value)) assert (value.transaction_hash == displayed);
        case (_) assert false;
    };
    switch (utxo(#AmountTooLow)) {
        case (#failed(message)) {
            assert (Text.contains(message, #text("fees")));
            assert (not Text.contains(message, #text("reimbursed")));
        };
        case (_) assert false;
    };
    // Exercise both reimbursement reasons and both account representations;
    // Nat64 amounts/indexes must not silently narrow to Nat32 or become Nat.
    let accounts : [Account] = [{ owner; subaccount = null }, { owner; subaccount = ?txid }];
    let reasons : [Reason] = [#CallFailed, #TaintedDestination({ kyt_fee = block; kyt_provider = minter })];
    for (account in accounts.vals()) {
        for (reason in reasons.vals()) {
            switch (utxo(#WillReimburse({ account; amount = block; reason }))) {
                case (#pending(message)) {
                    assert (Text.contains(message, #text("18446744073709551615")));
                    assert (Text.contains(message, #text("pending")));
                };
                case (_) assert false;
            };
            switch (utxo(#Reimbursed({ account; amount = block; reason; mint_block_index = 4_294_967_300 }))) {
                case (#failed(message)) {
                    assert (Text.contains(message, #text("18446744073709551615")));
                    assert (Text.contains(message, #text("4294967300")));
                    assert (Text.contains(message, #text("reimbursed")));
                };
                case (_) assert false;
            };
        };
    };
    // A recognized status carrying an invalid hash cannot establish a usable
    // submission or confirmed receipt. Unknown is still refreshable.
    for (invalid in (["", "\01", Blob.fromArray([1, 2, 3])] : [Blob]).vals()) {
        unknown(utxo(#Sending({ txid = invalid })));
        unknown(utxo(#Submitted({ txid = invalid })));
        unknown(utxo(#Confirmed({ txid = invalid })));
    };

    type RemoteSol = {
        #NotFound;
        #Pending;
        #TxSent : { transaction_id : Text };
        #TxFinalized : {
            #Success : { transaction_id : Text; effective_transaction_fee : ?Nat };
            #Failure : { transaction_id : Text };
        };
    };
    func sol(value : RemoteSol) : Settlement.Status {
        Settlement.classifySol(#ok(to_candid (value)));
    };
    let signature = "5VERv8NMvzbJmePGhZUW";
    unknown(sol(#NotFound));
    pending(sol(#Pending));
    switch (sol(#TxSent({ transaction_id = signature }))) {
        case (#submitted(value)) assert (value.transaction_hash == signature);
        case (_) assert false;
    };
    for (fee in ([null, ?5_000] : [?Nat]).vals()) {
        switch (sol(#TxFinalized(#Success({ transaction_id = signature; effective_transaction_fee = fee })))) {
            case (#confirmed(value)) assert (value.transaction_hash == signature);
            case (_) assert false;
        };
    };
    switch (sol(#TxFinalized(#Failure({ transaction_id = signature })))) {
        case (#failed(message)) {
            assert (Text.contains(message, #text(signature)));
            assert (Text.contains(message, #text("error")));
            assert (not Text.contains(message, #text("reimbursed")));
        };
        case (_) assert false;
    };

    let future : { #FutureStatus : Nat } = #FutureStatus(1);
    let unavailable : Capabilities.CallResult = #err({ code = "unavailable"; message = "status reply lost" });
    // Valid Candid of an unexpected type/future variant must remain unknown;
    // these fixtures do not claim to recover syntactically invalid Candid.
    for (reply in ([unavailable, #ok(to_candid (future)), #ok(to_candid ("wrong type"))] : [Capabilities.CallResult]).vals()) {
        unknown(Settlement.classifyUtxo(reply));
        unknown(Settlement.classifySol(reply));
        unknown(Settlement.classify(reply));
    };
    let futureRefund : { #Reimbursed : { account : Account; amount : Nat64; mint_block_index : Nat64; reason : { #FutureReason } } } =
        #Reimbursed({ account = accounts[0]; amount = 42; mint_block_index = 7; reason = #FutureReason });
    unknown(Settlement.classifyUtxo(#ok(to_candid (futureRefund))));
    // Distinct transaction-field names prevent decoding ETH success as SOL.
    let ethSuccess : { #TxFinalized : { #Success : { transaction_hash : Text; effective_transaction_fee : ?Nat } } } =
        #TxFinalized(#Success({ transaction_hash = "0x1234"; effective_transaction_fee = ?1 }));
    unknown(Settlement.classifySol(#ok(to_candid (ethSuccess))));
    let successfulSol : RemoteSol = #TxFinalized(#Success({ transaction_id = signature; effective_transaction_fee = ?5_000 }));
    unknown(Settlement.classify(#ok(to_candid (successfulSol))));
    switch (Settlement.classify(#ok(to_candid (ethSuccess)))) {
        case (#confirmed(value)) assert (value.transaction_hash == "0x1234");
        case (_) assert false;
    };
};
};
