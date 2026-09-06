import Blob "mo:core/Blob";
import Map "mo:core/Map";
import BridgeMemory "../memory/wallet_bridge/v1";
import Memory "../memory/wallet_bridge_replacements/v1";
module {
    public type Request = {
        id : Blob;
        revision : Nat;
        step : BridgeMemory.StepKind;
        original_transaction_hash : Text;
        previous_transaction_hash : Text;
        transaction_hash : Text;
        state : { #submitted; #confirmed; #failed };
        error : ?Text;
    };
    public type HashRequest = { id : Blob; step : BridgeMemory.StepKind };
    public func entries(mem : Memory.Mem, id : Blob) : [Memory.Entry] {
        switch (Map.get(mem.replacements, Blob.compare, id)) { case null []; case (?value) value };
    };
    public func effectiveHash(mem : Memory.Mem, id : Blob, step : BridgeMemory.StepKind, original : ?Text) : ?Text {
        var result = original;
        for (entry in entries(mem, id).vals()) if (entry.step == step) result := ?entry.transaction_hash;
        result;
    };
    public func usedElsewhere(mem : Memory.Mem, id : Blob, step : BridgeMemory.StepKind, hash : Text) : Bool {
        for ((savedId, values) in Map.entries(mem.replacements)) for (entry in values.vals()) {
            if ((savedId != id or entry.step != step) and (entry.original_transaction_hash == hash or entry.previous_transaction_hash == hash or entry.transaction_hash == hash)) return true;
        };
        false;
    };
};
