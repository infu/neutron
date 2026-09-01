// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
import Map "mo:core/Map";

module {
    public type Account = {
        owner : Principal;
        subaccount : ?Blob;
    };

    public type ApprovalSpender = {
        #icrc : Account;
        #icp_account_identifier : Blob;
    };

    // The stored variant, not caller-provided method text, selects the only
    // ledger method that may receive call_args.
    public type Operation = {
        #transfer : {
            to : Account;
            amount : Nat;
            memo : ?Blob;
        };
        #approve : {
            spender : Account;
            amount : Nat;
            expected_allowance : Nat;
            expected_expires_at : ?Nat64;
            expires_at : Nat64;
        };
        #revoke : {
            spender : ApprovalSpender;
            expected_allowance : Nat;
            expected_expires_at : ?Nat64;
        };
    };

    public type Caller = {
        endpoint : Text;
        app_id : Text;
        role : ?Text;
        agent_mode : Bool;
    };

    // These are the authoritative token facts shown for the prepared command.
    // For approvals, fee is the approval fee and transfer_fee is the fee folded
    // into allowance; direct transfers and revocations use null transfer_fee.
    public type ReviewFacts = {
        token_name : ?Text;
        token_symbol : Text;
        decimals : Nat;
        fee : Nat;
        transfer_fee : ?Nat;
        current_allowance : ?Nat;
        current_expires_at : ?Nat64;
        allowance : ?Nat;
        total_debit : Nat;
        expires_at : ?Nat64;
    };

    public type CommandError = {
        code : Text;
        message : Text;
        at : Int;
    };

    public type Receipt = {
        // Legacy ICP approval removal does not return a ledger block index.
        block_index : ?Nat;
        duplicate : Bool;
        completed_at : Int;
    };

    public type Status = {
        // Only a command that has never been dispatched may expire here.
        #prepared;
        // Pending covers both an in-flight call and an ambiguous broker result;
        // last_error records the latter without claiming a definite rejection.
        // Passing valid_until never converts pending work into #rejected.
        #pending : {
            attempts : Nat;
            started_at : Int;
            last_error : ?CommandError;
        };
        // Retained terminal states replay their exact result after valid_until.
        #succeeded : Receipt;
        // Rejected is terminal and is used only for a definite non-execution.
        #rejected : CommandError;
    };

    public type CommandKey = {
        caller_app_id : Text;
        // Runtime accepts only the canonical 16-byte (128-bit) representation.
        request_id : Blob;
    };

    public type Command = {
        caller : Caller;
        ledger : Principal;
        operation : Operation;
        // Canonical bounded Candid compared for caller-key idempotency.
        intent : Blob;
        prepared_at : Int;
        valid_until : Nat64;
        retain_until : Int;
        review : ReviewFacts;
        // Filled before the first value-moving await and then reused verbatim.
        var call_args : ?Blob;
        var updated_at : Int;
        var status : Status;
    };

    // Runtime code owns all field limits, the global/per-caller prepared quotas,
    // bounded cleanup, and the key comparator. It may expire only a never-
    // dispatched #prepared command. It never expires, rejects, or evicts
    // #pending work; it may exact-replay pending call_args only when the closed
    // operation's retry and deadline rules make that safe. Retained #succeeded
    // and #rejected tombstones replay after valid_until until retain_until. Once
    // a tombstone is pruned, the random 128-bit request ID is the remaining
    // collision defense.
    public type Mem = {
        commands : Map.Map<CommandKey, Command>;
    };

    public func init() : Mem {
        {
            commands = Map.empty<CommandKey, Command>();
        };
    };
};
