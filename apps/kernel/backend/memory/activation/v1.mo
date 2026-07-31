import Blob "mo:core/Blob";
import Principal "mo:core/Principal";

module {
    public type Mem = {
        var hash : ?Blob;
        var setter : ?Principal;
        var consumed : Bool;
    };

    public func init() : Mem {
        {
            var hash = null;
            var setter = null;
            var consumed = false;
        };
    };
};
