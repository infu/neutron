import Map "mo:core/Map";

// Released memory schemas are immutable. Keep the read identity and saved
// operation intents when restoring this root during an application upgrade.
module {
    public type Mem = {
        var seed : ?Blob;
        drafts : Map.Map<Text, Text>;
    };

    public func init() : Mem {
        { var seed = null; drafts = Map.empty<Text, Text>() };
    };
};
