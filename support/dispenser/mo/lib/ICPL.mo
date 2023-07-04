
import SHA224 "./sha";
import Binary "./encoding";
import Blob "mo:base/Blob";
import Hash "mo:base/Hash";
import Nat64 "mo:base/Nat64";
import Nat8 "mo:base/Nat8";
import Array "mo:base/Array";
import Principal "mo:base/Principal";
import CRC32 "./CRC32";
import Result "mo:base/Result";
import Nat32 "mo:base/Nat32";

module {
    public let FEE:Nat64 = 10000;


    public type LedgerInterface = actor {
        transfer        : TransferArgs       -> async TransferResult;
        account_balance : AccountBalanceArgs -> async ICP;
    };
    

    // Amount of ICP tokens, measured in 10^-8 of a token.
    public type ICP = {
        e8s : Nat64;
    };

    // Number of nanoseconds from the UNIX epoch (00:00:00 UTC, Jan 1, 1970).
    public type Timestamp = {
        timestamp_nanos: Nat64;
    };

    // AccountIdentifier is a 32-byte array.
    // The first 4 bytes is big-endian encoding of a CRC32 checksum of the last 28 bytes.
    public type AccountIdentifier = Blob;

    // Subaccount is an arbitrary 32-byte byte array.
    // Ledger uses subaccounts to compute the source address, which enables one
    // principal to control multiple ledger accounts.
    public type SubAccount = Blob;

    // Sequence number of a block produced by the ledger.
    public type BlockIndex = Nat64;

    // An arbitrary number associated with a transaction.
    // The caller can set it in a `transfer` call as a correlation identifier.
    public type Memo = Nat64;

    // Arguments for the `transfer` call.
    public type TransferArgs = {
        // Transaction memo.
        // See comments for the `Memo` type.
        memo : Memo;
        // The amount that the caller wants to transfer to the destination address.
        amount : ICP;
        // The amount that the caller pays for the transaction.
        // Must be 10000 e8s.
        fee : ICP;
        // The subaccount from which the caller wants to transfer funds.
        // If null, the ledger uses the default (all zeros) subaccount to compute the source address.
        // See comments for the `SubAccount` type.
        from_subaccount : ?SubAccount;
        // The destination account.
        // If the transfer is successful, the balance of this account increases by `amount`.
        to : AccountIdentifier;
        // The point in time when the caller created this request.
        // If null, the ledger uses current IC time as the timestamp.
        created_at_time : ?Timestamp;
    };

    public type TransferError = {
        // The fee that the caller specified in the transfer request was not the one that the ledger expects.
        // The caller can change the transfer fee to the `expected_fee` and retry the request.
        #BadFee : { expected_fee : ICP };
        // The account specified by the caller doesn't have enough funds.
        #InsufficientFunds : { balance: ICP };
        // The request is too old.
        // The ledger only accepts requests created within a 24 hours window.
        // This is a non-recoverable error.
        #TxTooOld : { allowed_window_nanos: Nat64 };
        // The caller specified `created_at_time` that is too far in future.
        // The caller can retry the request later.
        #TxCreatedInFuture;
        // The ledger has already executed the request.
        // `duplicate_of` field is equal to the index of the block containing the original transaction.
        #TxDuplicate : { duplicate_of: BlockIndex; };
    };

    public type TransferResult = {
        #Ok : BlockIndex;
        #Err : TransferError;
    };

    public type AccountBalanceArgs = {
        account : AccountIdentifier;
    };
 

    public module AccountIdentifier = {
        private let prefix : [Nat8] = [10, 97, 99, 99, 111, 117, 110, 116, 45, 105, 100];

        public func equal(a : AccountIdentifier, b : AccountIdentifier) : Bool {
            a == b
        };

        public func hash(accountId : AccountIdentifier) : Hash.Hash {
            CRC32.checksum(Blob.toArray(accountId));
        };

        public func fromPrincipal(p : Principal, subAccount : ?SubAccount) : AccountIdentifier {
            fromBlob(Principal.toBlob(p), subAccount);
        };

        public func fromBlob(data : Blob, subAccount : ?SubAccount) : AccountIdentifier {
            fromArray(Blob.toArray(data), subAccount);
        };
 
        public func fromArray(data : [Nat8], subAccount : ?SubAccount) : AccountIdentifier {
            let account : [Nat8] = switch (subAccount) {
                case (null) { Array.freeze(Array.init<Nat8>(32, 0)); };
                case (?sa)  { Blob.toArray(sa); };
            };
            
            let inner = SHA224.sha224(Array.flatten<Nat8>([prefix, data, account]));

            Blob.fromArray(Array.append<Nat8>(
                Binary.BigEndian.fromNat32(CRC32.checksum(inner)),
                inner,
            ));
        };

    };

    public module SubAccount = {
        public func fromPrincipal(p: Principal) : Blob {
            let pa = Blob.toArray(Principal.toBlob(p));
            let pa_size = pa.size();
            Blob.fromArray(Array.tabulate<Nat8>(32, func (idx) {
                if (idx == 0) return Nat8.fromNat(pa_size);
                if (idx <= pa_size) return pa[idx-1];
                return 0;
            }));

        };
        public func fromNat(idx: Nat) : SubAccount {
            Blob.fromArray(Array.append<Nat8>(
                Array.freeze(Array.init<Nat8>(24, 0)),
                Binary.BigEndian.fromNat64(Nat64.fromNat(idx))
            ));
        };
    };

};