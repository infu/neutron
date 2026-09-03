import Memory "../backend/memory/kitchensink/v1";

// Fresh installs use every released v1 default.
let fresh = Memory.init();
assert (fresh.profileName == "Ada");
assert (fresh.profileEmail == "ada@example.test");
assert (fresh.profileNotes == "This profile is stored in app memory.");
assert fresh.subscribed;
assert (fresh.counter == 0);
assert (fresh.lastMessage == "Kitchen Sink is ready");
assert (fresh.scheduledRuns == 0);
assert (fresh.lastScheduledCounter == 0);
assert (fresh.httpPostRuns == 0);
assert (fresh.lastHttpPostPath == "");
assert (fresh.lastHttpPostBody == "");
assert (fresh.lastHttpPostRequestId == "");
assert (fresh.lastHttpPostCounter == 0);

// Exercise non-default representative data across the whole root. The archive
// transition test proves that 0.3.7 -> 0.3.8 is #keep, so restoration reuses
// this object and never calls init().
fresh.profileName := "Grace";
fresh.profileEmail := "grace@example.test";
fresh.profileNotes := "Retained production profile";
fresh.subscribed := false;
fresh.counter := 41;
fresh.lastMessage := "Retained message";
fresh.scheduledRuns := 7;
fresh.lastScheduledCounter := 39;
fresh.httpPostRuns := 3;
fresh.lastHttpPostPath := "/retained";
fresh.lastHttpPostBody := "retained-body";
fresh.lastHttpPostRequestId := "request-17";
fresh.lastHttpPostCounter := 40;

let restored : Memory.Mem = fresh;
assert (restored.profileName == "Grace");
assert (restored.profileEmail == "grace@example.test");
assert (restored.profileNotes == "Retained production profile");
assert not restored.subscribed;
assert (restored.counter == 41);
assert (restored.lastMessage == "Retained message");
assert (restored.scheduledRuns == 7);
assert (restored.lastScheduledCounter == 39);
assert (restored.httpPostRuns == 3);
assert (restored.lastHttpPostPath == "/retained");
assert (restored.lastHttpPostBody == "retained-body");
assert (restored.lastHttpPostRequestId == "request-17");
assert (restored.lastHttpPostCounter == 40);
