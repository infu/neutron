// All rights reserved. See ../../LICENSE.
import Test "mo:test";
import Feedback "../../mo/Feedback";
import FeedbackStore "../../mo/FeedbackStore";
import PublisherStore "../../mo/PublisherStore";
import Store "../../mo/Store";
import ReleaseStore "../../mo/ReleaseStore";
import Fixtures "Fixtures";

persistent actor {
  public func feedback_clean_initialization_and_first_rating() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(Fixtures.memory(), PublisherStore.init(), ReleaseStore.init());
      let memory = FeedbackStore.init();
      let feedback = Feedback.Service(db, memory, func(_ : Text, _ : Nat64, _ : Nat, _ : Blob) : Bool { false });
      ignore Fixtures.stored(Store.insertApp(db, {
        appId = "empty-feedback"; owner = Fixtures.owner(); title = "New app"; summary = ""; description = "";
        priceUsdMicros = 0; revision = 1; approvedCandidate = null; visible = true;
        iconArtifact = null; screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = 1; updatedAtNs = 1;
      }));
      let before = memory.maintenance;
      assert feedback.advance(0) == 0 and memory.maintenance == before;
      assert feedback.advance(1) == 0;
      assert feedback.histogram("empty-feedback") == #ok({ five = 0; four = 0; three = 0; two = 0; one = 0; count = 0; total = 0; complete = true });
      assert not memory.maintenance.legacyTextCutover;
      assert feedback.validateLegacyReview("Old client text is still supported") == #ok(());
      switch (feedback.setRating(Fixtures.other(), "empty-feedback", 5, 2)) { case (#err(_)) {}; case (_) assert false };
      ignore Fixtures.stored(Store.insertEntitlement(db, { owner = Fixtures.other(); appId = "empty-feedback"; orderId = 1; kind = #free; acquiredAtNs = 2 }));
      let #ok(first) = feedback.setRating(Fixtures.other(), "empty-feedback", 5, 3) else { assert false; loop {} };
      assert feedback.setRating(Fixtures.other(), "empty-feedback", 5, 4) == #ok(first);
      assert feedback.histogram("empty-feedback") == #ok({ five = 1; four = 0; three = 0; two = 0; one = 0; count = 1; total = 5; complete = true });
      let restored = Feedback.Service(db, memory, func(_ : Text, _ : Nat64, _ : Nat, _ : Blob) : Bool { false });
      assert restored.histogram("empty-feedback") == feedback.histogram("empty-feedback");
      switch (restored.setRating(Fixtures.other(), "empty-feedback", 0, 5)) { case (#err(_)) {}; case (_) assert false };
      assert Store.getRating(db, Fixtures.other(), "empty-feedback") == ?first;
    });
  };
};
