import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Capabilities "../capabilities/Types";

module {
    // The minter's withdrawal ID is the ckETH burn block for both ckETH and
    // ckERC20. Its update method takes one nat64 (not a record or a nat).
    // https://github.com/dfinity/ic/blob/master/rs/ethereum/cketh/minter/cketh_minter.did
    public let MAX_WITHDRAWAL_ID : Nat = 18_446_744_073_709_551_615;

    public type Status = {
        #pending : Text;
        #submitted : { transaction_hash : Text; message : Text };
        #confirmed : { transaction_hash : Text };
        #failed : Text;
        #unknown : Text;
    };

    type RetrieveEthStatus = {
        #NotFound;
        #Pending;
        #TxCreated;
        #TxSent : { transaction_hash : Text };
        #TxFinalized : {
            #Success : {
                transaction_hash : Text;
                effective_transaction_fee : ?Nat;
            };
            #PendingReimbursement : { transaction_hash : Text };
            #Reimbursed : {
                transaction_hash : Text;
                reimbursed_amount : Nat;
                reimbursed_in_block : Nat;
            };
        };
    };

    // BTC and DOGE expose the same status variants, including reimbursement
    // evidence. Their returned transaction IDs are 32-byte little-endian blobs.
    // https://github.com/dfinity/ic/blob/065e28175a3e34a258a07524e37c4666972a1125/rs/bitcoin/ckbtc/minter/ckbtc_minter.did#L319
    type ReimbursementReason = {
        #CallFailed;
        #TaintedDestination : { kyt_fee : Nat64; kyt_provider : Principal };
    };
    type Reimbursement = {
        account : { owner : Principal; subaccount : ?Blob };
        amount : Nat64;
        reason : ReimbursementReason;
    };
    type RetrieveUtxoStatus = {
        #Unknown;
        #Pending;
        #Signing;
        #Sending : { txid : Blob };
        #Submitted : { txid : Blob };
        #AmountTooLow;
        #Confirmed : { txid : Blob };
        #WillReimburse : Reimbursement;
        #Reimbursed : Reimbursement and { mint_block_index : Nat64 };
    };

    // SOL uses transaction_id and has no reimbursement variants.
    // https://github.com/dfinity/cksol/blob/f84a62e0343a82fa1af64d4c0ace181c1209f250/minter/cksol_minter.did#L250
    type WithdrawalSolStatus = {
        #NotFound;
        #Pending;
        #TxSent : { transaction_id : Text };
        #TxFinalized : {
            #Success : { transaction_id : Text; effective_transaction_fee : ?Nat };
            #Failure : { transaction_id : Text };
        };
    };

    public func request(minter : Principal, block : Nat64) : Capabilities.CallRequest {
        {
            canister = minter;
            method = "retrieve_eth_status";
            args = to_candid (block);
            cycles = 0;
        };
    };

    public func requestBtc(minter : Principal, block : Nat64) : Capabilities.CallRequest {
        blockRequest(minter, "retrieve_btc_status_v2", block);
    };

    public func requestDoge(minter : Principal, block : Nat64) : Capabilities.CallRequest {
        blockRequest(minter, "retrieve_doge_status", block);
    };

    public func requestSol(minter : Principal, block : Nat64) : Capabilities.CallRequest {
        blockRequest(minter, "withdrawal_status", block);
    };

    func blockRequest(minter : Principal, method : Text, block : Nat64) : Capabilities.CallRequest {
        { canister = minter; method; args = to_candid ({ block_index = block }); cycles = 0 };
    };

    public func classify(result : Capabilities.CallResult) : Status {
        switch (result) {
            case (#err(error)) #unknown("Could not check the Ethereum withdrawal: " # error.code # ": " # error.message);
            case (#ok(reply)) {
                let decoded : ?RetrieveEthStatus = from_candid reply;
                switch (decoded) {
                    case null #unknown("The minter returned an unrecognized Ethereum withdrawal status.");
                    case (?#NotFound) #unknown("The minter has no matching Ethereum withdrawal record yet.");
                    case (?#Pending) #pending("Withdrawal accepted; waiting for an Ethereum transaction.");
                    case (?#TxCreated) #pending("Ethereum transaction created; waiting for broadcast.");
                    case (?#TxSent(value)) #submitted({
                        transaction_hash = value.transaction_hash;
                        message = "Ethereum transaction broadcast; waiting for finalization.";
                    });
                    case (?#TxFinalized(#Success(value))) #confirmed({ transaction_hash = value.transaction_hash });
                    case (?#TxFinalized(#PendingReimbursement(value))) {
                        // A finalized reverted transaction is not a successful
                        // payout. Keep polling until reimbursement is recorded;
                        // pending may include refunds needing manual attention.
                        #pending("Ethereum transaction " # value.transaction_hash # " failed. Reimbursement is pending.");
                    };
                    case (?#TxFinalized(#Reimbursed(value))) {
                        #failed("Ethereum transaction " # value.transaction_hash # " failed. The minter reimbursed " #
                            Nat.toText(value.reimbursed_amount) # " ledger base units in block " #
                            Nat.toText(value.reimbursed_in_block) # ".");
                    };
                };
            };
        };
    };

    public func classifyUtxo(result : Capabilities.CallResult) : Status {
        let reply = switch (result) {
            case (#err(error)) return #unknown("Could not check the withdrawal: " # error.code # ": " # error.message);
            case (#ok(bytes)) bytes;
        };
        let decoded : ?RetrieveUtxoStatus = from_candid reply;
        switch (decoded) {
            case null #unknown("The minter returned an unrecognized withdrawal status.");
            // Unknown also covers pruned history and quarantined reimbursement.
            // It never proves that a previous burn did not occur.
            case (?#Unknown) #unknown("The minter has no available withdrawal status for this burn.");
            case (?#Pending) #pending("Withdrawal accepted; waiting for a native transaction.");
            case (?#Signing) #pending("The minter is signing the native transaction.");
            case (?#Sending(value)) {
                let ?hash = utxoTransactionId(value.txid) else return #unknown("The minter returned an invalid transaction ID.");
                #pending("Native transaction " # hash # " is signed; waiting for broadcast to be acknowledged.");
            };
            case (?#Submitted(value)) {
                let ?hash = utxoTransactionId(value.txid) else return #unknown("The minter returned an invalid transaction ID.");
                #submitted({ transaction_hash = hash; message = "Native transaction broadcast; waiting for confirmations." });
            };
            case (?#Confirmed(value)) {
                let ?hash = utxoTransactionId(value.txid) else return #unknown("The minter returned an invalid transaction ID.");
                #confirmed({ transaction_hash = hash });
            };
            case (?#AmountTooLow) #failed("The withdrawal amount was too low to cover native transaction fees. No payout was completed.");
            case (?#WillReimburse(value)) #pending("Native payout was not completed. Reimbursement of " # Nat64.toText(value.amount) # " ledger base units is pending.");
            case (?#Reimbursed(value)) #failed("Native payout was not completed. The minter reimbursed " # Nat64.toText(value.amount) # " ledger base units in block " # Nat64.toText(value.mint_block_index) # ".");
        };
    };

    public func classifySol(result : Capabilities.CallResult) : Status {
        let reply = switch (result) {
            case (#err(error)) return #unknown("Could not check the Solana withdrawal: " # error.code # ": " # error.message);
            case (#ok(bytes)) bytes;
        };
        let decoded : ?WithdrawalSolStatus = from_candid reply;
        switch (decoded) {
            case null #unknown("The minter returned an unrecognized Solana withdrawal status.");
            case (?#NotFound) #unknown("The minter has no matching Solana withdrawal record yet.");
            case (?#Pending) #pending("Withdrawal accepted; waiting for a Solana transaction.");
            case (?#TxSent(value)) #submitted({ transaction_hash = value.transaction_id; message = "Solana transaction broadcast; waiting for finalization." });
            case (?#TxFinalized(#Success(value))) #confirmed({ transaction_hash = value.transaction_id });
            case (?#TxFinalized(#Failure(value))) #failed("Solana transaction " # value.transaction_id # " finalized with an error. No successful payout or reimbursement is confirmed.");
        };
    };

    func utxoTransactionId(value : Blob) : ?Text {
        // Match the upstream Txid Display implementation, which reverses the
        // bytes encoded by Candid for both BTC and DOGE.
        // https://github.com/dfinity/bitcoin-canister/blob/bcbce85c465632eba1a2bd5cb73bafee2450abe4/interface/src/lib.rs#L200
        let bytes = Blob.toArray(value);
        if (bytes.size() != 32) return null;
        let digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
        var result = "";
        var remaining = bytes.size();
        while (remaining > 0) {
            remaining -= 1;
            let byte = Nat8.toNat(bytes[remaining]);
            result #= digits[byte / 16] # digits[byte % 16];
        };
        ?result;
    };
};
