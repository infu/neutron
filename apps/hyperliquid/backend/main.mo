import Array "mo:core/Array";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Memory "./memory/hyperliquid/v1";

module {
    public type OperationV1 = {
        id : Text; root_id : Text; input_json : Text; summary : Text; state_json : Text;
        phase : Text; revision : Nat; created_at : Int; updated_at : Int;
    };
    public type SummaryV1 = {
        id : Text; summary : Text; phase : Text; revision : Nat;
        created_at : Int; updated_at : Int;
    };
    public type BeginV1 = { id : Text; root_id : Text; input_json : Text; summary : Text; state_json : Text; phase : Text };
    public type UpdateV1 = { id : Text; expected_revision : Nat; state_json : Text; phase : Text };
    public type ResultV1 = { #ok : OperationV1; #err : Text };
    public type PageInputV1 = { cursor : ?Text; limit : Nat };
    public type PageV1 = { rows : [SummaryV1]; next_cursor : ?Text };
    public type PageResultV1 = { #ok : PageV1; #err : Text };
    public type AppBackendEnvironment = { stable_memory : { hyperliquid : Memory.Mem } };

    public class Init(env : AppBackendEnvironment) {
        let memory = env.stable_memory.hyperliquid;

        public func /*update*/hyperliquid_begin_v1(input : BeginV1) : ResultV1 {
            switch (Map.get(memory.operations, Text.compare, input.id)) {
                case (?saved) {
                    if (saved.root_id != input.root_id or saved.input_json != input.input_json or saved.summary != input.summary) {
                        return #err("This operation ID already belongs to another intent");
                    };
                    return #ok(saved);
                };
                case null {};
            };
            if (input.id == "" or input.root_id == "" or input.input_json == "" or input.state_json == "" or input.summary == "" or input.phase == "") {
                return #err("The operation intent is incomplete");
            };
            let now = Time.now();
            let saved : OperationV1 = { input with revision = 0; created_at = now; updated_at = now };
            Map.add(memory.operations, Text.compare, input.id, saved);
            #ok(saved);
        };

        public func /*query*/hyperliquid_get_v1(id : Text) : ?OperationV1 {
            Map.get(memory.operations, Text.compare, id);
        };

        public func /*update*/hyperliquid_update_v1(input : UpdateV1) : ResultV1 {
            let ?saved = Map.get(memory.operations, Text.compare, input.id) else return #err("Operation not found");
            if (input.state_json == "" or input.phase == "") return #err("Operation progress is incomplete");
            if (input.expected_revision > saved.revision) return #err("Operation revision is ahead of the journal");
            if (input.state_json == saved.state_json and input.phase == saved.phase) return #ok(saved);
            if (input.expected_revision != saved.revision) return #err("Operation changed; reload before continuing");
            let next : OperationV1 = {
                saved with state_json = input.state_json; phase = input.phase;
                revision = saved.revision + 1; updated_at = Time.now();
            };
            Map.add(memory.operations, Text.compare, input.id, next);
            #ok(next);
        };

        public func /*query*/hyperliquid_page_v1(input : PageInputV1) : PageResultV1 {
            if (input.limit == 0) return #err("Page size must be positive");
            let anchor = switch (input.cursor) {
                case null null;
                case (?id) {
                    let ?saved = Map.get(memory.operations, Text.compare, id) else return #err("History cursor not found");
                    ?saved;
                };
            };
            func compare(a : OperationV1, b : OperationV1) : { #less; #equal; #greater } {
                switch (Int.compare(b.created_at, a.created_at)) {
                    case (#equal) Text.compare(b.id, a.id);
                    case other other;
                };
            };
            let rows = List.empty<SummaryV1>();
            var last : ?Text = null;
            var more = false;
            label scan for (saved in Array.sort<OperationV1>(Iter.toArray(Map.values(memory.operations)), compare).vals()) {
                let after = switch (anchor) { case null true; case (?prior) compare(saved, prior) == #greater };
                if (after and saved.id == saved.root_id) {
                    if (List.size(rows) == input.limit) { more := true; break scan };
                    List.add(rows, {
                        id = saved.id; summary = saved.summary; phase = saved.phase;
                        revision = saved.revision; created_at = saved.created_at; updated_at = saved.updated_at;
                    });
                    last := ?saved.id;
                };
            };
            #ok({ rows = List.toArray(rows); next_cursor = if (more) last else null });
        };

    };
/*---NEUTRON GENERATED BEGIN---*/

public type hyperliquid_begin_v1_Input = (input : BeginV1);
public type hyperliquid_begin_v1_Output = ResultV1;

public type hyperliquid_get_v1_Input = (id : Text);
public type hyperliquid_get_v1_Output = ?OperationV1;

public type hyperliquid_update_v1_Input = (input : UpdateV1);
public type hyperliquid_update_v1_Output = ResultV1;

public type hyperliquid_page_v1_Input = (input : PageInputV1);
public type hyperliquid_page_v1_Output = PageResultV1;

/*---NEUTRON GENERATED END---*/
}

