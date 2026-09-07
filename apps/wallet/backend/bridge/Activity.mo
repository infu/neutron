import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Time "mo:core/Time";
import Memory "../memory/wallet_bridge_activity/v1";
import BridgeMemory "../memory/wallet_bridge/v1";
import Types "Types";
module {
    public type ListRequest = { ledger : ?Principal };
    public type Entry = { id : Blob; dismissed_at : Int };
    public type Page = { records : [Entry] };
    public type DismissRequest = { id : Blob; dismissed : Bool };

    // This service has no network capability. Dismissing a reminder never
    // changes, cancels, or revokes any recorded financial operation.
    public class Service(mem : Memory.Mem, bridges : BridgeMemory.Mem) {
        public func list(request : ListRequest) : Page {
            let records = List.empty<Entry>();
            for ((id, dismissed_at) in Map.entries(mem.dismissed)) {
                switch (Map.get(bridges.intents, Blob.compare, id)) {
                    case null {};
                    case (?intent) {
                        if (request.ledger == null or request.ledger == ?intent.quote.ledger) {
                            List.add(records, { id; dismissed_at });
                        };
                    };
                };
            };
            { records = List.toArray(records) };
        };

        public func dismiss(request : DismissRequest) : Types.Result<Types.Intent> {
            let intent = switch (Map.get(bridges.intents, Blob.compare, request.id)) {
                case null return #err("Bridge intent not found");
                case (?value) value;
            };
            if (request.dismissed) {
                // Retrying after a lost reply leaves the same dismissal intact.
                if (not Map.containsKey(mem.dismissed, Blob.compare, request.id)) {
                    Map.add(mem.dismissed, Blob.compare, request.id, Time.now());
                };
            } else {
                Map.remove(mem.dismissed, Blob.compare, request.id);
            };
            #ok(intent);
        };
    };
};
