import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Text "mo:core/Text";

module {
    public type PKKey = Text;

    public type Doc = {
        id : PKKey;
        chunks : Nat;
        content : [Blob];
        content_encoding : Text;
        content_type : Text;
    };

    public type Init = Map.Map<PKKey, Doc>;

    public func init() : Init {
        Map.empty<PKKey, Doc>();
    };

    public class Use(store : Init) {
        public func put(doc : Doc) : () {
            Map.add(store, Text.compare, doc.id, doc);
        };

        public func get(key : PKKey) : ?Doc {
            Map.get(store, Text.compare, key);
        };

        public func delete(key : PKKey) : Bool {
            Map.delete(store, Text.compare, key);
        };

        public func entries(prefix : Text) : Iter.Iter<(PKKey, Doc)> {
            Iter.filter(
                Map.entries(store),
                func((key, _)) { Text.startsWith(key, #text prefix) },
            );
        };

        public func entriesFrom(key : Text) : Iter.Iter<(PKKey, Doc)> {
            Map.entriesFrom(store, Text.compare, key);
        };

        public func keys(prefix : Text, limit : Nat) : [PKKey] {
            let result = List.empty<PKKey>();
            label matching for ((key, _) in entries(prefix)) {
                if (List.size(result) >= limit) break matching;
                List.add(result, key);
            };
            List.toArray(result);
        };

        public func allKeys(prefix : Text) : [PKKey] {
            keys(prefix, Map.size(store));
        };
    };

    public func use(init : Init) : Use {
        Use(init);
    };
};
