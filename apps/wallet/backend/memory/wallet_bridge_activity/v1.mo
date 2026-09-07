// Persistent schema: immutable after its first production release. Deposit
// visibility is separate from the released financial journal and its receipts.
import Map "mo:core/Map";
module {
    public type Mem = { dismissed : Map.Map<Blob, Int> };
    public func init() : Mem { { dismissed = Map.empty<Blob, Int>() } };
};
