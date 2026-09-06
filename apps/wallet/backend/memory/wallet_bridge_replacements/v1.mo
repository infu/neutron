// Additive sidecar for released bridge intents. Original transaction hashes in
// wallet_bridge/v1 remain immutable; every proven replacement stays attributable
// to its original intent and step, including superseded replacement ancestors.
import Map "mo:core/Map";
module {
    public type StepKind = { #reset_approval; #approval; #deposit };
    public type Entry = {
        step : StepKind;
        original_transaction_hash : Text;
        previous_transaction_hash : Text;
        transaction_hash : Text;
        recorded_at : Int;
    };
    public type Mem = { replacements : Map.Map<Blob, [Entry]> };
    public func init() : Mem { { replacements = Map.empty<Blob, [Entry]>() } };
};
