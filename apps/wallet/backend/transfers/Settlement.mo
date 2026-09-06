import Nat "mo:core/Nat";
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

    public func request(minter : Principal, block : Nat64) : Capabilities.CallRequest {
        {
            canister = minter;
            method = "retrieve_eth_status";
            args = to_candid (block);
            cycles = 0;
        };
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
};
