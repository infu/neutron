import Array "mo:core/Array";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Order "mo:core/Order";
import Text "mo:core/Text";
import Memory "./memory/uniswap_actions/v1";

module {
    public type BeginInput = {
        id : Text;
        input_json : Text;
        summary : Text;
        state_json : Text;
        phase : Text;
    };
    public type UpdateInput = {
        id : Text;
        expected_revision : Nat;
        state_json : Text;
        phase : Text;
    };
    public type Result = { #ok : Memory.Action; #err : Text };
    public type Summary = {
        id : Text;
        summary : Text;
        phase : Text;
        revision : Nat;
        created_at : Int;
        updated_at : Int;
    };
    public type PageInput = { cursor : ?Text; limit : Nat };
    public type Page = { rows : [Summary]; next_cursor : ?Text };
    public type PageResult = { #ok : Page; #err : Text };
    public type PositionResult = { #ok : Memory.PositionRef; #err : Text };

    // References are discovery hints, not evidence of NFT ownership. Retain
    // imported and newly minted ids even if an indexer is unavailable; clients
    // must read ownerOf and the position state before displaying or using one.
    public func trackPosition(mem : Memory.Mem, input : Memory.PositionRef) : PositionResult {
        if (input.chain_id == 0 or (input.protocol != "v3" and input.protocol != "v4")) {
            return #err("A position requires its EVM chain and Uniswap protocol");
        };
        let ?tokenId = Nat.fromText(input.token_id)
            else return #err("A position token id must be a non-negative decimal integer");
        let canonical : Memory.PositionRef = {
            input with token_id = Nat.toText(tokenId);
        };
        let key = Nat.toText(canonical.chain_id) # ":" # canonical.protocol # ":" # canonical.token_id;
        switch (Map.get(mem.positions, Text.compare, key)) {
            case (?existing) #ok(existing);
            case null {
                Map.add(mem.positions, Text.compare, key, canonical);
                #ok(canonical);
            };
        };
    };

    public func positionRefs(mem : Memory.Mem, chainId : Nat) : [Memory.PositionRef] {
        Iter.toArray(Iter.filter<Memory.PositionRef>(Map.values(mem.positions), func(reference) {
            reference.chain_id == chainId;
        }));
    };

    // The resident app validates the immutable caller/account/action envelope
    // and stores exact Wallet requests in state_json before dispatch. The
    // backend records progress only; it does not sign or send transactions.
    public func begin(mem : Memory.Mem, input : BeginInput, now : Int) : Result {
        switch (Map.get(mem.actions, Text.compare, input.id)) {
            case (?existing) {
                if (existing.input_json != input.input_json or existing.summary != input.summary) {
                    return #err("This action id already belongs to a different immutable intent");
                };
                // A lost begin reply must recover later progress, never reset
                // the action to a newly computed initial plan.
                return #ok(existing);
            };
            case null {};
        };
        if (input.id == "" or input.input_json == "" or input.summary == "" or input.state_json == "" or input.phase == "") {
            return #err("The action intent is incomplete");
        };
        let action : Memory.Action = {
            id = input.id;
            input_json = input.input_json;
            summary = input.summary;
            state_json = input.state_json;
            phase = input.phase;
            revision = 0;
            created_at = now;
            updated_at = now;
        };
        Map.add(mem.actions, Text.compare, input.id, action);
        #ok(action);
    };

    public func get(mem : Memory.Mem, id : Text) : ?Memory.Action {
        Map.get(mem.actions, Text.compare, id);
    };

    // Compare-and-swap prevents stale tabs and workers from overwriting later
    // progress. Repeating the exact stored value is harmless after a lost
    // response and preserves both the revision and its original timestamp.
    public func update(mem : Memory.Mem, input : UpdateInput, now : Int) : Result {
        let ?existing = Map.get(mem.actions, Text.compare, input.id)
            else return #err("The action was not found");
        if (input.state_json == "" or input.phase == "") {
            return #err("The action progress is incomplete");
        };
        if (input.expected_revision > existing.revision) {
            return #err("The action revision is ahead of its stored progress; reload before updating");
        };
        if (input.state_json == existing.state_json and input.phase == existing.phase) return #ok(existing);
        if (input.expected_revision != existing.revision) {
            return #err("The action changed; reload its current progress before updating");
        };
        let next : Memory.Action = {
            existing with
            state_json = input.state_json;
            phase = input.phase;
            revision = existing.revision + 1;
            updated_at = now;
        };
        Map.add(mem.actions, Text.compare, input.id, next);
        #ok(next);
    };

    // Pages contain summaries, never plans, typed signatures, or raw receipts.
    // Full action data remains available individually through get(). The
    // cursor uses immutable creation order, so progress updates or new actions
    // cannot shift an already requested page. No records are pruned or capped.
    public func page(mem : Memory.Mem, input : PageInput) : PageResult {
        if (input.limit == 0) return #err("Action page size must be positive");
        let anchor = switch (input.cursor) {
            case null null;
            case (?id) switch (Map.get(mem.actions, Text.compare, id)) {
                case null return #err("Action cursor was not found; reload from the first page");
                case (?record) ?record;
            };
        };
        let sorted = Array.sort<Memory.Action>(Iter.toArray(Map.values(mem.actions)), newestFirst);
        let rows = List.empty<Summary>();
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
                List.add(rows, {
                    id = record.id;
                    summary = record.summary;
                    phase = record.phase;
                    revision = record.revision;
                    created_at = record.created_at;
                    updated_at = record.updated_at;
                });
                lastId := ?record.id;
            };
        };
        #ok({ rows = List.toArray(rows); next_cursor = if (more) lastId else null });
    };

    func newestFirst(left : Memory.Action, right : Memory.Action) : Order.Order {
        switch (Int.compare(right.created_at, left.created_at)) {
            case (#equal) Text.compare(right.id, left.id);
            case (order) order;
        };
    };
};
