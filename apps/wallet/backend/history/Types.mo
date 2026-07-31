import Memory "../memory/wallet/v1";

module {
    public type Result<T> = {
        #ok : T;
        #err : Text;
    };

    public type IndexedPage = {
        balance : Nat;
        transactions : [Memory.HistoryTransaction];
        unsupported_block_ids : [Nat];
        oldest_tx_id : ?Nat;
        next_cursor : ?Nat;
        crossed_floor : Bool;
    };

    public type AccountHead = {
        balance : Nat;
        newest_block_id : ?Nat;
    };

    public type AccountAnchor = {
        tip_exclusive : Nat;
        balance : Nat;
    };

    public func capturedHeadMatches(
        firstBlockId : ?Nat,
        start : ?Nat,
        floor : Nat,
        targetTip : Nat,
    ) : Bool {
        // The first page is bounded by the account head captured immediately
        // before the scan. It must still begin with that exact transaction;
        // continuation pages use a lower cursor and do not repeat this check.
        if (start != ?targetTip or targetTip <= floor) return true;
        firstBlockId == ?(targetTip - 1);
    };

    public type PageRequest = {
        ledger : ?Principal;
        before : ?Memory.HistoryOrderKey;
        limit : Nat;
    };

    public type Record = {
        #transaction : {
            ledger : Principal;
            symbol : ?Text;
            decimals : ?Nat;
            logo : ?Text;
            value : Memory.HistoryTransaction;
        };
        #adjustment : {
            symbol : ?Text;
            decimals : ?Nat;
            logo : ?Text;
            value : Memory.HistoryAdjustment;
        };
    };

    public type Page = {
        records : [Record];
        next : ?Memory.HistoryOrderKey;
        inspected : Nat;
        has_more : Bool;
        warning : ?Text;
    };

    public type HistorySource = {
        #index : Principal;
        #ledger;
        #unavailable;
    };

    public type LedgerStatus = {
        ledger : Principal;
        symbol : ?Text;
        enabled : Bool;
        source : HistorySource;
        state : Memory.HistoryState;
        checkpoint : ?Memory.HistoryCheckpoint;
        last_attempt_at : ?Int;
        last_success_at : ?Int;
        last_error : ?Text;
        transaction_count : Nat;
        adjustment_count : Nat;
    };

    public type Status = {
        running : Bool;
        ledgers : [LedgerStatus];
    };

    public type SyncLedgerResult = {
        ledger : Principal;
        status : Text;
        records_added : Nat;
        checkpoint : ?Memory.HistoryCheckpoint;
        error : ?Text;
    };

    public type SyncReport = {
        started_at : Int;
        finished_at : Int;
        skipped_overlap : Bool;
        ledgers : [SyncLedgerResult];
    };

    public type SourceStatus = {
        ledger : Principal;
        index : ?Principal;
        ready : Bool;
        missing_methods : [Text];
    };
};
