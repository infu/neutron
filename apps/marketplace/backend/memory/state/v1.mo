import Map "mo:core/Map";

module {
    public type Mem = {
        var seed : ?Blob;
        var canister : ?Principal;
        var host : Text;
        var revision : Nat;
        drafts : Map.Map<Text, Text>;
    };
    public func init() : Mem {
        { var seed = null; var canister = null; var host = "https://icp-api.io"; var revision = 0; drafts = Map.empty<Text, Text>() };
    };
};
