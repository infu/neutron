// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
import Map "mo:core/Map";

module {
    public type HistoryOperation = {
        #transfer;
        #mint;
        #burn;
        #approve;
        #authorized_mint;
        #authorized_burn;
    };

    public type HistoryAddress = {
        #icrc : { owner : Principal; subaccount : ?Blob };
        #icp_account_identifier : Blob;
    };

    public type TransferIntent = {
        contact_id : Nat;
        address_id : Nat;
        contact_name : Text;
        address_label : ?Text;
        network : Text;
        destination : Text;
        native : Bool;
    };

    public type NativeHistoryContext = {
        network : Text;
        transaction_id : ?Text;
        output_index : ?Nat;
        related_ledger : ?Principal;
        related_block_index : ?Nat;
    };

    public type HistoryVerification = {
        #pending;
        #verified;
        #prebaseline;
        #unverified_scan_limit;
    };

    public type HistoryTransaction = {
        block_index : Nat;
        operation : HistoryOperation;
        timestamp_ns : Nat64;
        amount : Nat;
        fee : ?Nat;
        balance_effect : Int;
        from : ?HistoryAddress;
        to : ?HistoryAddress;
        spender : ?HistoryAddress;
        memo : ?Blob;
        intent : ?TransferIntent;
        native : ?NativeHistoryContext;
        provenance : { #local_pending; #index; #ledger };
        verification : HistoryVerification;
    };

    public type HistoryAdjustmentKind = {
        #opening_balance;
        #unexplained_balance;
        #scan_limit;
        #unsupported_operation;
    };

    public type HistoryAdjustment = {
        id : Nat;
        kind : HistoryAdjustmentKind;
        ledger : Principal;
        timestamp_ns : Nat64;
        balance_effect : Int;
        previous_balance : Nat;
        observed_balance : Nat;
        from_tip_exclusive : Nat;
        to_tip_exclusive : Nat;
        detail : Text;
    };

    public type HistoryRecordRef = {
        #transaction : { ledger : Principal; block_index : Nat };
        #adjustment : { ledger : Principal; adjustment_id : Nat };
    };

    public type HistoryOrderKey = {
        timestamp_ns : Nat64;
        ledger : Principal;
        kind_order : Nat8;
        id : Nat;
    };

    public type HistoryCheckpoint = {
        tip_exclusive : Nat;
        balance : Nat;
        checked_at : Int;
    };

    public type HistoryScan = {
        index : Principal;
        from_tip_exclusive : Nat;
        target_tip_exclusive : Nat;
        previous_balance : Nat;
        target_balance : Nat;
        cursor : ?Nat;
        candidates : Map.Map<Nat, HistoryTransaction>;
        unsupported_block_ids : [Nat];
        page_count : Nat;
        started_at : Int;
        config_epoch : Nat;
    };

    public type HistorySource = {
        #index : Principal;
        #unavailable;
    };

    public type HistoryState = {
        #idle;
        #syncing;
        #catching_up;
        #waiting_for_index;
        #permission_required;
        #degraded;
    };

    public type LedgerHistory = {
        transactions : Map.Map<Nat, HistoryTransaction>;
        adjustments : Map.Map<Nat, HistoryAdjustment>;
        var next_adjustment_id : Nat;
        var checkpoint : ?HistoryCheckpoint;
        var scan : ?HistoryScan;
        var config_epoch : Nat;
        var last_attempt_at : ?Int;
        var last_success_at : ?Int;
        var last_error : ?Text;
        var source : HistorySource;
        var state : HistoryState;
    };

    public type NativePendingDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
        confirmations : Nat;
        required_confirmations : Nat;
    };

    public type NativeProcessingDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
    };

    public type NativeMintedDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
        minted_amount : Nat;
        block_index : Nat;
        minted_at : Int;
    };

    public type NativeDepositIssueKind = {
        #value_too_small;
        #tainted;
        #quarantined;
    };

    public type NativeDepositIssue = {
        txid : Text;
        vout : Nat;
        value : Nat;
        kind : NativeDepositIssueKind;
        earliest_retry : ?Nat;
    };

    public type NativeDepositProgress = {
        checked_at : Int;
        current_confirmations : ?Nat;
        required_confirmations : ?Nat;
        pending : [NativePendingDeposit];
        processing : [NativeProcessingDeposit];
        recent_minted : [NativeMintedDeposit];
        issues : [NativeDepositIssue];
    };

    public type Ledger = {
        id : Nat;
        principal : Principal;
        name : ?Text;
        symbol : ?Text;
        decimals : ?Nat;
        fee : ?Nat;
        logo : ?Text;
        balance : ?Nat;
        metadata_updated_at : ?Int;
        balance_updated_at : ?Int;
        metadata_error : ?Text;
        balance_error : ?Text;
        native_address : ?Text;
        native_address_updated_at : ?Int;
        native_address_error : ?Text;
        native_refresh_updated_at : ?Int;
        native_refresh_error : ?Text;
        native_deposit_progress : ?NativeDepositProgress;
        enabled : Bool;
        history : LedgerHistory;
    };

    public type Mem = {
        var next_id : Nat;
        ledgers : Map.Map<Principal, Ledger>;
        activity_order : Map.Map<HistoryOrderKey, HistoryRecordRef>;
        var metadata_epoch : Nat;
        var balance_epoch : Nat;
        var native_epoch : Nat;
        var configured : Bool;
    };

    public func init() : Mem {
        {
            var next_id = 1;
            ledgers = Map.empty<Principal, Ledger>();
            activity_order = Map.empty<HistoryOrderKey, HistoryRecordRef>();
            var metadata_epoch = 0;
            var balance_epoch = 0;
            var native_epoch = 0;
            var configured = false;
        };
    };
};
