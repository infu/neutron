// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
module {
    public type Mem = {
        var profileName : Text;
        var profileEmail : Text;
        var profileNotes : Text;
        var subscribed : Bool;
        var counter : Nat;
        var lastMessage : Text;
        var scheduledRuns : Nat;
        var lastScheduledCounter : Nat;
        var httpPostRuns : Nat;
        var lastHttpPostPath : Text;
        var lastHttpPostBody : Text;
        var lastHttpPostRequestId : Text;
        var lastHttpPostCounter : Nat;
    };

    public func init() : Mem {
        {
            var profileName = "Ada";
            var profileEmail = "ada@example.test";
            var profileNotes = "This profile is stored in app memory.";
            var subscribed = true;
            var counter = 0;
            var lastMessage = "Kitchen Sink is ready";
            var scheduledRuns = 0;
            var lastScheduledCounter = 0;
            var httpPostRuns = 0;
            var lastHttpPostPath = "";
            var lastHttpPostBody = "";
            var lastHttpPostRequestId = "";
            var lastHttpPostCounter = 0;
        };
    };
};
