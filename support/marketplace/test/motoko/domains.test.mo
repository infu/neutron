import Test "mo:test";
import Fixtures "Fixtures";
import Store "../../mo/Store";
import Types "../../mo/Types";
import Catalog "../../mo/Catalog";
import Publishing "../../mo/Publishing";
import Audits "../../mo/Audits";
import Rankings "../../mo/Rankings";
import Views "../../mo/Views";
import Principal "mo:core/Principal";

persistent actor {
  public func listing_retries_and_revision_conflicts() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(Fixtures.memory());
      let initial = Fixtures.draft(db, "testapp", 0);
      assert Catalog.save(db, Fixtures.owner(), Fixtures.listing("testapp", 0, null), 9) == #ok(initial);
      assert db.listings.size() == 1 and db.apps.size() == 1;
      switch (Catalog.save(db, Fixtures.other(), Fixtures.listing("testapp", 0, ?1), 10)) { case (#err(_)) {}; case _ assert false };
      switch (Catalog.save(db, Fixtures.owner(), Fixtures.listing("testapp", 1_000_000, null), 10)) { case (#err(_)) {}; case _ assert false };
      let revised = Fixtures.ok(Catalog.save(db, Fixtures.owner(), Fixtures.listing("testapp", 1_000_001, ?1), 11));
      assert revised.revision == 2 and revised.priceUsdMicros == 1_000_001;
      assert db.listings.size() == 2 and db.apps.size() == 1;
      assert not Catalog.eligible(db, revised);
    });
  };

  public func listing_cannot_publish_another_publishers_private_image() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(Fixtures.memory());
      ignore Fixtures.draft(db, "testapp", 0);
      let image = Fixtures.upload(db, "testapp", "private-image", #image);
      let owned = Fixtures.ok(Catalog.save(db, Fixtures.owner(), { Fixtures.listing("testapp", 0, ?1) with iconArtifact = ?image.id }, 3));
      assert owned.iconArtifact == ?image.id;
      switch (Catalog.save(db, Fixtures.other(), { Fixtures.listing("otherapp", 0, null) with iconArtifact = ?image.id }, 4)) { case (#err(_)) {}; case _ assert false };
      assert db.apps.size() == 1;
    });
  };

  public func exact_audits_retry_and_revocation_preserve_ownership() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(Fixtures.memory());
      ignore Fixtures.draft(db, "testapp", 1_000_000);
      let candidate = Fixtures.candidate(db, "testapp", 100, "submit-1");
      let request = { requestId = "approve-1"; candidateId = candidate.id; expectedDigest = candidate.digest; expectedSourceDigest = candidate.sourceDigest; decision = #approved; analysis = "Inspected exact bytes"; reason = null };
      switch (Audits.stamp(db, Fixtures.owner(), request, 3)) { case (#err(_)) {}; case _ assert false };
      switch (Audits.stamp(db, Fixtures.auditor(), { request with expectedDigest = "different-package" }, 3)) { case (#err(_)) {}; case _ assert false };
      switch (Audits.stamp(db, Fixtures.auditor(), { request with expectedSourceDigest = ?"different-source" }, 3)) { case (#err(_)) {}; case _ assert false };
      switch (Audits.stamp(db, Fixtures.auditor(), { request with expectedSourceDigest = null }, 3)) { case (#err(_)) {}; case _ assert false };
      assert db.audits.size() == 0;
      assert db.candidates.get(candidate.id) == ?candidate;
      let first = Fixtures.ok(Audits.stamp(db, Fixtures.auditor(), request, 3));
      assert first.publicationChanged and Catalog.eligible(db, first.app);
      let repeat = Fixtures.ok(Audits.stamp(db, Fixtures.auditor(), request, 4));
      assert repeat.audit == first.audit and not repeat.publicationChanged and db.audits.size() == 1;
      switch (Audits.stamp(db, Fixtures.auditor(), { request with expectedDigest = "different-package" }, 4)) { case (#err(_)) {}; case _ assert false };
      switch (Audits.stamp(db, Fixtures.auditor(), { request with expectedSourceDigest = null }, 4)) { case (#err(_)) {}; case _ assert false };
      switch (Audits.stamp(db, Fixtures.auditor(), { request with analysis = "Changed" }, 4)) { case (#err(_)) {}; case _ assert false };
      ignore Fixtures.stored(Store.insertEntitlement(db, { owner = Fixtures.other(); appId = "testapp"; orderId = 1; kind = #paid; acquiredAtNs = 4 }));
      let next = Fixtures.candidate(db, "testapp", 101, "submit-2");
      assert Catalog.approvedRelease(db, first.app) == ?first.candidate;
      let rejected = Fixtures.ok(Audits.stamp(db, Fixtures.auditor(), { requestId = "reject-2"; candidateId = next.id; expectedDigest = next.digest; expectedSourceDigest = next.sourceDigest; decision = #rejected; analysis = "Examined source"; reason = ?"Unexpected behavior" }, 5));
      assert rejected.candidate.state == #rejected and not rejected.publicationChanged;
      assert Catalog.eligible(db, rejected.app);
      let revoked = Fixtures.ok(Audits.stamp(db, Fixtures.auditor(), { requestId = "revoke-1"; candidateId = candidate.id; expectedDigest = candidate.digest; expectedSourceDigest = candidate.sourceDigest; decision = #revoked; analysis = "Reexamined bytes"; reason = ?"New finding" }, 6));
      assert revoked.candidate.state == #revoked and revoked.app.approvedCandidate == ?candidate.id;
      assert not Catalog.eligible(db, revoked.app);
      assert Store.getEntitlement(db, Fixtures.other(), "testapp") != null;
      assert db.audits.size() == 3;
      assert not Catalog.eligible(db, revoked.app);
    });
  };

  public func candidate_idempotency_and_published_version_monotonicity() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(Fixtures.memory());
      ignore Fixtures.draft(db, "testapp", 0);
      let lower = Fixtures.candidate(db, "testapp", 100, "lower");
      let higher = Fixtures.candidate(db, "testapp", 101, "higher");
      ignore Fixtures.approve(db, higher, "approve-higher");
      switch (Audits.stamp(db, Fixtures.auditor(), { requestId = "approve-lower"; candidateId = lower.id; expectedDigest = lower.digest; expectedSourceDigest = lower.sourceDigest; decision = #approved; analysis = "Reviewed"; reason = null }, 10)) { case (#err(_)) {}; case _ assert false };
      assert db.audits.size() == 1;
      let replay = Fixtures.ok(Publishing.submit(db, Fixtures.owner(), { requestId = "higher"; appId = "testapp"; version = 101; artifactId = higher.artifactId; sourceArtifactId = higher.sourceArtifactId; dependencies = []; feeVersion = 1 }, 11));
      assert replay.id == higher.id and db.candidates.size() == 2;
      switch (Publishing.submit(db, Fixtures.owner(), { requestId = "higher"; appId = "testapp"; version = 102; artifactId = higher.artifactId; sourceArtifactId = higher.sourceArtifactId; dependencies = []; feeVersion = 1 }, 11)) { case (#err(_)) {}; case _ assert false };
      let fresh = Fixtures.candidate(db, "testapp", 102, "successor");
      let published = Fixtures.approve(db, fresh, "approve-successor");
      assert published.app.approvedCandidate == ?fresh.id and published.candidate.version == 102;
    });
  };

  public func rolling_expiry_retries_backlog_and_live_visibility() : async Test.Metrics {
    Test.test(func() {
      let mem = Fixtures.memory();
      let db = Store.Use(mem);
      ignore Fixtures.draft(db, "alpha", 0);
      ignore Fixtures.draft(db, "bravo", 0);
      let alpha = Fixtures.approve(db, Fixtures.candidate(db, "alpha", 100, "alpha-package"), "alpha-audit");
      let bravo = Fixtures.approve(db, Fixtures.candidate(db, "bravo", 100, "bravo-package"), "bravo-audit");
      let input : Types.CreateAcquisition = { owner = Fixtures.other(); appId = "alpha"; orderId = 1; kind = #free; atNs = 10; paidAtoms = 0; ledger = null; block = null };
      let first = Rankings.recordAcquisition(db, input);
      assert Rankings.recordAcquisition(db, input) == first;
      ignore Rankings.recordAcquisition(db, { input with owner = Fixtures.owner(); orderId = 2 });
      ignore Rankings.recordAcquisition(db, { input with appId = "bravo"; orderId = 3; atNs = 11 });
      assert db.acquisitions.size() == 3;
      let initial = Rankings.advance(db, 12, 10);
      assert initial.published;
      let chart = Fixtures.ok(Rankings.chart(db, #free, #week, null, 2, 12));
      assert chart.entries == [{ appId = "alpha"; score = 2 }, { appId = "bravo"; score = 1 }];
      let cutoff = 10 + Rankings.weekNs;
      let pending = Rankings.advance(db, cutoff, 1);
      assert not pending.published;
      let stale = Fixtures.ok(Rankings.chart(db, #free, #week, null, 2, cutoff));
      assert stale.generation == chart.generation and stale.refreshing and stale.entries == chart.entries;
      ignore Fixtures.ok(Audits.stamp(db, Fixtures.auditor(), { requestId = "hide-alpha"; candidateId = alpha.candidate.id; expectedDigest = alpha.candidate.digest; expectedSourceDigest = alpha.candidate.sourceDigest; decision = #revoked; analysis = "Reexamined"; reason = ?"New finding" }, cutoff));
      let hidden = Fixtures.ok(Rankings.chart(db, #free, #week, null, 1, cutoff));
      assert hidden.entries == [{ appId = "bravo"; score = 1 }];
      ignore Rankings.recordAcquisition(db, { input with owner = Principal.fromText("aaaaa-aa"); appId = "bravo"; orderId = 4; atNs = cutoff });
      let current = Rankings.advance(Store.Use(mem), cutoff, 10);
      assert current.published and current.generation > chart.generation;
      let fresh = Fixtures.ok(Rankings.chart(db, #free, #week, null, 2, cutoff));
      assert fresh.entries == [{ appId = "bravo"; score = 2 }] and not fresh.refreshing;
      let ?alphaStats = Store.getRanking(db, "alpha") else { assert false; loop {} };
      assert alphaStats.free7 == 0 and alphaStats.free30 == 2 and alphaStats.freeAll == 2;
      let priceChanged = Fixtures.ok(Catalog.save(db, Fixtures.owner(), Fixtures.listing("bravo", 1_000_000, ?bravo.app.revision), cutoff));
      assert priceChanged.priceUsdMicros == 1_000_000;
      assert Fixtures.ok(Rankings.chart(db, #free, #week, null, 10, cutoff)).entries.size() == 0;
      ignore Rankings.advance(db, cutoff + 1, 10);
      assert Fixtures.ok(Rankings.chart(db, #paid, #all, null, 10, cutoff + 1)).entries == [{ appId = "bravo"; score = 0 }];
      let ?bravoStats = Store.getRanking(db, "bravo") else { assert false; loop {} };
      assert bravoStats.freeAll == 2 and bravoStats.paidAll == 0;
      ignore Rankings.advance(Store.Use(mem), cutoff + Rankings.monthNs + 1, 100);
      let ?expiredStats = Store.getRanking(db, "bravo") else { assert false; loop {} };
      assert expiredStats.free7 == 0 and expiredStats.free30 == 0 and expiredStats.freeAll == 2;
    });
  };

  public func catalog_search_continues_beyond_nonmatching_rank_pages() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(Fixtures.memory());
      for (appId in ["alpha", "bravo", "zulu"].vals()) {
        ignore Fixtures.draft(db, appId, 0);
        ignore Fixtures.approve(db, Fixtures.candidate(db, appId, 100, appId # "package"), appId # "approve");
      };
      ignore Rankings.advance(db, 10, 10);
      let #ok(result) = Views.catalog(db, Fixtures.owner(), null, {
        search = "brav"; tier = #free; window = #all; cursor = null; limit = 1;
      }, 10) else { assert false; loop {} };
      assert result.apps.size() == 1 and result.apps[0].appId == "bravo";
      let #ok(tail) = Views.catalog(db, Fixtures.owner(), null, {
        search = "brav"; tier = #free; window = #all; cursor = result.nextCursor; limit = 1;
      }, 10) else { assert false; loop {} };
      assert tail.apps.size() == 0 and tail.nextCursor == null;
      switch (Views.catalog(db, Fixtures.owner(), null, { search = ""; tier = #free; window = #all; cursor = null; limit = 0 }, 10)) { case (#err(_)) {}; case _ assert false };
    });
  };

  public func public_views_keep_lifetime_free_and_paid_acquisitions_distinct() : async Test.Metrics {
    Test.test(func() {
      let memory = Fixtures.memory();
      let db = Store.Use(memory);
      ignore Fixtures.draft(db, "countedapp", 0);
      let published = Fixtures.approve(db, Fixtures.candidate(db, "countedapp", 100, "counted-package"), "counted-audit");
      assert Views.app(db, Fixtures.owner(), null, published.app).acquisitionCounts == ?{ free = 0; paid = 0 };
      let free : Types.CreateAcquisition = { owner = Fixtures.other(); appId = "countedapp"; orderId = 1; kind = #free; atNs = 10; paidAtoms = 0; ledger = null; block = null };
      let first = Rankings.recordAcquisition(db, free);
      ignore Fixtures.stored(Store.insertEntitlement(db, { owner = free.owner; appId = free.appId; orderId = free.orderId; kind = free.kind; acquiredAtNs = free.atNs }));
      let paidApp = Fixtures.ok(Catalog.save(db, Fixtures.owner(), Fixtures.listing("countedapp", 1_000_000, ?published.app.revision), 11));
      let paid : Types.CreateAcquisition = { free with owner = Fixtures.owner(); orderId = 2; kind = #paid; atNs = 12; paidAtoms = 1_000_000; ledger = ?Fixtures.auditor(); block = ?123 };
      ignore Rankings.recordAcquisition(db, paid);
      assert Rankings.recordAcquisition(db, { free with orderId = 3; kind = #paid; paidAtoms = 1_000_000 }) == first;
      ignore Rankings.advance(db, 13, 10);
      let #ok(catalog) = Views.catalog(db, Fixtures.owner(), null, { search = ""; tier = #paid; window = #all; cursor = null; limit = 10 }, 13) else { assert false; loop {} };
      assert catalog.apps.size() == 1 and catalog.apps[0].acquisitionCounts == ?{ free = 1; paid = 1 };
      let #ok(detail) = Views.detail(db, Fixtures.owner(), null, paidApp.appId) else { assert false; loop {} };
      assert detail.app.acquisitionCounts == ?{ free = 1; paid = 1 };
      let #ok(library) = Views.library(db, Fixtures.owner(), free.owner, { cursor = null; limit = 10 }) else { assert false; loop {} };
      assert library.apps.size() == 1 and library.apps[0].acquisitionCounts == ?{ free = 1; paid = 1 };
      let #ok(publisher) = Views.publisherApps(db, Fixtures.owner(), Fixtures.owner(), { cursor = null; limit = 10 }) else { assert false; loop {} };
      assert publisher.apps.size() == 1 and publisher.apps[0].acquisitionCounts == ?{ free = 1; paid = 1 };
      ignore Rankings.advance(db, Rankings.monthNs + 13, 10);
      let restored = Store.Use(memory);
      let ?ranking = Store.getRanking(restored, paidApp.appId) else { assert false; loop {} };
      assert ranking.paid30 == 0 and ranking.free30 == 0;
      assert Views.app(restored, Fixtures.owner(), null, paidApp).acquisitionCounts == ?{ free = 1; paid = 1 };
      assert restored.acquisitions.size() == 2;
    });
  };

  public func private_library_and_earnings_preserve_revoked_ownership() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(Fixtures.memory());
      ignore Fixtures.draft(db, "draftapp", 0);
      switch (Views.detail(db, Fixtures.owner(), null, "draftapp")) { case (#err(_)) {}; case _ assert false };
      let #ok(draft) = Views.detail(db, Fixtures.owner(), ?Fixtures.owner(), "draftapp") else { assert false; loop {} };
      assert not draft.app.visible;
      ignore Fixtures.draft(db, "ownedapp", 1_000_000);
      let published = Fixtures.approve(db, Fixtures.candidate(db, "ownedapp", 100, "owned-package"), "owned-audit");
      ignore Fixtures.stored(Store.insertEntitlement(db, { owner = Fixtures.other(); appId = "ownedapp"; orderId = 1; kind = #paid; acquiredAtNs = 4 }));
      ignore Fixtures.ok(Audits.stamp(db, Fixtures.auditor(), { requestId = "revoke-owned"; candidateId = published.candidate.id; expectedDigest = published.candidate.digest; expectedSourceDigest = published.candidate.sourceDigest; decision = #revoked; analysis = "Reviewed"; reason = ?"New finding" }, 5));
      let #ok(library) = Views.library(db, Fixtures.owner(), Fixtures.other(), { cursor = null; limit = 10 }) else { assert false; loop {} };
      assert library.apps.size() == 1 and library.apps[0].owned and not library.apps[0].visible;
      let #ok(detail) = Views.detail(db, Fixtures.owner(), ?Fixtures.other(), "ownedapp") else { assert false; loop {} };
      assert detail.app.owned and detail.app.version == null;
      ignore Fixtures.stored(Store.insertCredit(db, { owner = Fixtures.other(); ledger = Fixtures.owner(); isBurn = false; available = 20; reserved = 10; updatedAtNs = 5 }));
      ignore Fixtures.stored(Store.insertCredit(db, { owner = Fixtures.other(); ledger = Fixtures.owner(); isBurn = true; available = 100; reserved = 0; updatedAtNs = 5 }));
      let earnings = Views.earnings(db, Fixtures.other());
      assert earnings.credits.size() == 1 and earnings.credits[0].available == 20 and earnings.credits[0].reserved == 10;
    });
  };

  public func operation_history_has_independent_owner_scoped_cursors() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(Fixtures.memory());
      for (requestId in ["purchase-old", "purchase-middle", "purchase-new"].vals()) {
        ignore Fixtures.stored(Store.insertOrder(db, {
          owner = Fixtures.owner(); requestId; intentHash = ""; quoteCommitment = ""; ledger = Fixtures.other();
          amount = 1; fee = 1; affiliate = null; rateId = 0; items = [];
          state = #outcome_unknown; currentAttempt = null; createdAtNs = 1; updatedAtNs = 1; finalizedAtNs = null; lastError = null;
        }));
      };
      ignore Fixtures.stored(Store.insertOrder(db, {
        owner = Fixtures.other(); requestId = "private-other"; intentHash = ""; quoteCommitment = ""; ledger = Fixtures.other();
        amount = 1; fee = 1; affiliate = null; rateId = 0; items = [];
        state = #complete; currentAttempt = null; createdAtNs = 1; updatedAtNs = 1; finalizedAtNs = ?1; lastError = null;
      }));
      for ((requestId, isBurn) in [("withdrawal-old", false), ("withdrawal-new", false), ("burn", true)].vals()) {
        ignore Fixtures.stored(Store.insertWithdrawal(db, {
          owner = Fixtures.owner(); requestId; intentHash = ""; ledger = Fixtures.other(); to = { owner = Fixtures.owner(); subaccount = null };
          totalDebit = 2; fee = 1; isBurn; state = #outcome_unknown; currentAttempt = null;
          createdAtNs = 1; updatedAtNs = 1; finalizedAtNs = null; lastError = null;
        }));
      };
      let #ok(first) = Views.operationRows(db, Fixtures.owner(), { purchaseCursor = #start; withdrawalCursor = #start; limit = 1 }) else { assert false; loop {} };
      assert first.purchases.size() == 1 and first.purchases[0].requestId == "purchase-new";
      assert first.withdrawals.size() == 1 and first.withdrawals[0].requestId == "withdrawal-new";
      let #ok(second) = Views.operationRows(db, Fixtures.owner(), { purchaseCursor = first.nextPurchaseCursor; withdrawalCursor = first.nextWithdrawalCursor; limit = 1 }) else { assert false; loop {} };
      assert second.purchases.size() == 1 and second.purchases[0].requestId == "purchase-middle";
      assert second.withdrawals.size() == 1 and second.withdrawals[0].requestId == "withdrawal-old";
      assert second.nextWithdrawalCursor == #done and second.nextPurchaseCursor != #done;
      let #ok(third) = Views.operationRows(db, Fixtures.owner(), { purchaseCursor = second.nextPurchaseCursor; withdrawalCursor = second.nextWithdrawalCursor; limit = 1 }) else { assert false; loop {} };
      assert third.purchases.size() == 1 and third.purchases[0].requestId == "purchase-old";
      assert third.withdrawals.size() == 0 and third.nextWithdrawalCursor == #done;
      assert third.nextPurchaseCursor == #done;
      assert db.orders.size() == 4 and db.withdrawals.size() == 3;
    });
  };
}
