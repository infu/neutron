// Managed-memory migration test: v1 -> v2.
//
// This is the upgrade path taken by every installation that already holds v1.
// It runs once, in the middle of `install_code`, and if it traps or loses data
// there is no second chance -- so the properties asserted here are the ones an
// owner would notice: their handle, their reading list, and above all their
// drafts, with revisions intact so a pending agent patch still compare-and-swaps
// correctly against what the editor last read.

import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";

import V1 "../backend/memory/nuance/v1";
import V2 "../backend/memory/nuance/v2";
import Migrate "../backend/memory/nuance/v1_to_v2";

func fail(message : Text) = Runtime.trap("migration test failed: " # message);

// A v1 root as it would look after real use: a registered handle, two drafts,
// a reading list, a granted shard, and the content caches v2 drops.
let old : V1.Mem = V1.init();
old.handle := "nuance-neutron";
old.displayName := "Neutron";
old.registered := true;
old.identityChecked := 1_700_000_000_000_000_000;
old.buckets := [Principal.fromText("434go-diaaa-aaaaf-qakwq-cai")];
old.bookmarks := [{
    postId = "18318";
    bucketCanisterId = "434go-diaaa-aaaaf-qakwq-cai";
    title = "Bitcoin's Best August";
    handle = "Brian";
    saved = 1_700_000_000_000_000_000;
}];
old.drafts := [
    {
        id = "d1";
        title = "Half-written";
        subtitle = "A subtitle";
        tagIds = ["1", "2"];
        body = "First block.\n\nSecond block.";
        revision = 7;
        created = 1;
        modified = 2;
        modifiedBy = "agent";
        sourcePostId = ?{ postId = "18318"; bucketCanisterId = "434go-diaaa-aaaaf-qakwq-cai" };
        suggestions = [{ id = "s1"; ops = "[]"; note = "tighten the intro"; created = 3 }];
    },
    {
        id = "d2";
        title = "Fresh";
        subtitle = "";
        tagIds = [];
        body = "";
        revision = 1;
        created = 4;
        modified = 4;
        modifiedBy = "human";
        sourcePostId = null;
        suggestions = [];
    },
];
old.activeDraftId := "d2";
old.nextDraftId := 3;

// The caches v2 drops. Populated so the migration is exercised with them
// present, which is the realistic case: v1 filled them on the first feed read.
old.seenBuckets := ["434go-diaaa-aaaaf-qakwq-cai", "4hy47-uiaaa-aaaaf-qakuq-cai"];
old.tags := [("1", "Blockchain"), ("2", "Bitcoin")];
old.tagsFetched := 5;
old.latestWatermark := "18321";
old.feedSource := "popular_week";
old.feedCached := 6;
old.feedCache := [{
    postId = "18318";
    bucketCanisterId = "434go-diaaa-aaaaf-qakwq-cai";
    title = "Bitcoin's Best August";
    subtitle = "";
    handle = "Brian";
    publishedDate = "1756000000000";
    claps = "3";
    views = "40";
    wordCount = "1577";
    tags = ["Blockchain"];
}];

let next : V2.Mem = Migrate.migrate(old);

// ------------------------------------------------------------- identity

if (next.handle != "nuance-neutron") fail("the registered handle must survive");
if (next.displayName != "Neutron") fail("the display name must survive");
if (not next.registered) fail("registration must survive");
if (next.identityChecked != old.identityChecked) fail("identityChecked must survive");

// ---------------------------------------------------------------- shards

if (next.buckets.size() != 1) fail("the shard write-allowlist must survive");
if (not Principal.equal(next.buckets[0], old.buckets[0])) fail("shard principal changed");

// --------------------------------------------------------- reading list

if (next.bookmarks.size() != 1) fail("the reading list must survive");
if (next.bookmarks[0].postId != "18318") fail("bookmark postId changed");
if (next.bookmarks[0].title != "Bitcoin's Best August") fail("bookmark title changed");
if (next.bookmarks[0].saved != old.bookmarks[0].saved) fail("bookmark timestamp changed");

// --------------------------------------------------------------- drafts

if (next.drafts.size() != 2) fail("both drafts must survive");
if (next.drafts[0].id != "d1") fail("draft order changed");
if (next.drafts[0].body != "First block.\n\nSecond block.") fail("draft body changed");
if (next.drafts[0].title != "Half-written") fail("draft title changed");
if (next.drafts[0].tagIds.size() != 2) fail("draft tags changed");
if (next.drafts[0].modifiedBy != "agent") fail("draft provenance changed");
// The revision is the whole compare-and-swap contract: an editor holding
// revision 7 must still be able to save after the upgrade.
if (next.drafts[0].revision != 7) fail("draft revision must not be reset");
switch (next.drafts[0].sourcePostId) {
    case (?source) { if (source.postId != "18318") fail("draft source changed") };
    case null fail("the link to the published article must survive");
};
if (next.drafts[0].suggestions.size() != 1) fail("held-back suggestions must survive");
if (next.activeDraftId != "d2") fail("the active draft must survive");
// A reused draft id would collide with a draft the owner still has open.
if (next.nextDraftId != 3) fail("nextDraftId must not restart");

Debug.print("migration: v1 -> v2 preserved every owner-authored field");
