import Map "mo:core/Map";
import Array "mo:core/Array";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Order "mo:core/Order";
import Text "mo:core/Text";
import Memory "./memory/uniswap/v1";

module {
    public type BeginInput = {
        id : Text;
        account_id : Text;
        chain_id : Nat;
        recipient : Text;
        quote_json : Text;
        approval_request_id : ?Text;
        approval_request_json : ?Text;
        swap_request_id : Text;
        swap_request_json : Text;
    };

    public type UpdateInput = {
        id : Text;
        expected_revision : Nat;
        stage : Text;
        request_id : Text;
        account_id : Text;
        chain_id : Nat;
        operation_json : ?Text;
        phase : Text;
    };

    public type Result = { #ok : Memory.Swap; #err : Text };
    public type HistoryInput = { cursor : ?Text; limit : Nat };
    public type HistoryPage = { rows : [Memory.Swap]; next_cursor : ?Text };
    public type HistoryResult = { #ok : HistoryPage; #err : Text };

    // The UI stores a validated quote and the exact EVM Wallet requests before
    // asking that wallet to execute them. This journal never performs an effect.
    // Reusing an id with changed account, network, quote, or request is an error.
    public func begin(mem : Memory.Mem, input : BeginInput, now : Int) : Result {
        switch (Map.get(mem.swaps, Text.compare, input.id)) {
            case (?existing) {
                if (sameIntent(existing, input)) return #ok(existing);
                return #err("This swap id already belongs to a different immutable intent");
            };
            case null {};
        };
        if (
            input.id == "" or input.account_id == "" or input.chain_id == 0 or
            input.recipient == "" or input.quote_json == "" or
            input.swap_request_id == "" or input.swap_request_json == ""
        ) return #err("The swap intent is incomplete");
        switch (input.approval_request_id, input.approval_request_json) {
            case (null, null) {};
            case (?id, ?request) {
                if (id == "" or request == "") return #err("The approval request is incomplete");
                if (id == input.swap_request_id) return #err("Approval and swap require different wallet request ids");
            };
            case (_) return #err("Approval request id and request must be supplied together");
        };
        let swap : Memory.Swap = {
            id = input.id;
            account_id = input.account_id;
            chain_id = input.chain_id;
            recipient = input.recipient;
            quote_json = input.quote_json;
            approval_request_id = input.approval_request_id;
            approval_request_json = input.approval_request_json;
            swap_request_id = input.swap_request_id;
            swap_request_json = input.swap_request_json;
            approval_operation_json = null;
            swap_operation_json = null;
            phase = "queued";
            revision = 0;
            created_at = now;
            updated_at = now;
        };
        Map.add(mem.swaps, Text.compare, input.id, swap);
        #ok(swap);
    };

    // CAS keeps stale browser/Agent observations from replacing later progress.
    // An absent operation marks the pre-dispatch phase without discarding an
    // earlier receipt. A lost reply can always be reconciled with the saved
    // request id; a caller must never replace it with a freshly generated id.
    public func update(mem : Memory.Mem, input : UpdateInput, now : Int) : Result {
        let ?existing = Map.get(mem.swaps, Text.compare, input.id)
            else return #err("The swap was not found");
        if (input.account_id != existing.account_id or input.chain_id != existing.chain_id) {
            return #err("The wallet operation belongs to a different account or network");
        };
        let approval = if (input.stage == "approval") {
            switch (existing.approval_request_id) {
                case (?id) {
                    if (id != input.request_id) return #err("The approval wallet request id does not match");
                };
                case null return #err("This swap has no approval request");
            };
            true;
        } else if (input.stage == "swap") {
            if (input.request_id != existing.swap_request_id) return #err("The swap wallet request id does not match");
            false;
        } else return #err("Choose the approval or swap stage");
        if (input.phase == "") return #err("A progress phase is required");
        switch (input.operation_json) {
            case (?"") return #err("A wallet operation cannot be empty");
            case (_) {};
        };
        let priorOperation = if (approval) existing.approval_operation_json else existing.swap_operation_json;
        let operation = switch (input.operation_json) {
            case null priorOperation;
            case (?value) ?value;
        };
        // A repeated update whose reply was lost is harmless even with the old
        // revision, but its immutable identity was checked above first.
        if (existing.phase == input.phase and operation == priorOperation) return #ok(existing);
        if (input.expected_revision != existing.revision) return #err("The swap changed; reload its current progress before updating");
        let next : Memory.Swap = {
            existing with
            approval_operation_json = if (approval) operation else existing.approval_operation_json;
            swap_operation_json = if (approval) existing.swap_operation_json else operation;
            phase = input.phase;
            revision = existing.revision + 1;
            updated_at = now;
        };
        Map.add(mem.swaps, Text.compare, input.id, next);
        #ok(next);
    };

    public func get(mem : Memory.Mem, id : Text) : ?Memory.Swap {
        Map.get(mem.swaps, Text.compare, id);
    };

    public func list(mem : Memory.Mem) : [Memory.Swap] {
        Iter.toArray(Map.values(mem.swaps));
    };

    // Cursor identity refers to a retained record's immutable creation time and
    // id. Unlike an array offset, it cannot shift when a newer swap is inserted
    // while the user loads later pages. This only controls the response size;
    // records and their complete request/receipt contents are never discarded.
    public func history(mem : Memory.Mem, input : HistoryInput) : HistoryResult {
        if (input.limit == 0) return #err("History page size must be positive");
        let anchor = switch (input.cursor) {
            case null null;
            case (?id) switch (Map.get(mem.swaps, Text.compare, id)) {
                case null return #err("History cursor was not found; reload history from its first page");
                case (?record) ?record;
            };
        };
        // Sorting copies record references, not their potentially large JSON
        // strings. Only the selected page is included in the query response.
        let sorted = Array.sort<Memory.Swap>(Iter.toArray(Map.values(mem.swaps)), newestFirst);
        let rows = List.empty<Memory.Swap>();
        var lastId : ?Text = null;
        var more = false;
        label scan for (record in sorted.vals()) {
            let followsCursor = switch (anchor) {
                case null true;
                case (?prior) newestFirst(record, prior) == #greater;
            };
            if (followsCursor) {
                if (List.size(rows) == input.limit) {
                    more := true;
                    break scan;
                };
                List.add(rows, record);
                lastId := ?record.id;
            };
        };
        #ok({ rows = List.toArray(rows); next_cursor = if (more) lastId else null });
    };

    func newestFirst(left : Memory.Swap, right : Memory.Swap) : Order.Order {
        switch (Int.compare(right.created_at, left.created_at)) {
            case (#equal) Text.compare(right.id, left.id);
            case (order) order;
        };
    };

    func sameIntent(existing : Memory.Swap, input : BeginInput) : Bool {
        existing.id == input.id and
        existing.account_id == input.account_id and
        existing.chain_id == input.chain_id and
        existing.recipient == input.recipient and
        existing.quote_json == input.quote_json and
        existing.approval_request_id == input.approval_request_id and
        existing.approval_request_json == input.approval_request_json and
        existing.swap_request_id == input.swap_request_id and
        existing.swap_request_json == input.swap_request_json;
    };
};
