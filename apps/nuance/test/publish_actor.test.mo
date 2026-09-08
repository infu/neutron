import Error "mo:core/Error";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Main "../backend/main";
import Memory "../backend/memory/nuance/v2";
import Types "../backend/nuance/Types";

// A real local actor executes the production request builder and Candid
// decoder. The fake broker yields before changing drafts and returning its
// reply, reproducing an edit made while the outbound save is awaiting Nuance.
persistent actor {
    public func run() : async Text {
        func okDraft(result : Main.DraftWriteResult) : Main.DraftView {
            switch (result) {
                case (#ok(value)) value;
                case (_) Runtime.trap("Expected an accepted draft write: " # debug_show (result));
            };
        };
        func read(app : Main.Init, id : Text) : Main.DraftView {
            switch (app.nuance_draft_read(id)) {
                case (#ok(value)) value;
                case (#err(message)) Runtime.trap(message);
            };
        };
        func published(result : Main.PublishResult) : Main.Published {
            switch (result) {
                case (#ok(value)) value;
                case (#err(message)) Runtime.trap(message);
            };
        };
        class Fixture() {
            public let mem = Memory.init();
            mem.handle := "test-neutron";
            public var calls = 0;
            public var fail = false;
            public var reject = false;
            public var submitted : ?Types.PostSaveModel = null;
            public var onDispatch : () -> async* () = func() : async* () {};
            func dispatch(request : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
                assert request.method == "save";
                assert Principal.toText(request.canister) == "322sd-3iaaa-aaaaf-qakgq-cai";
                let ?model : ?Types.PostSaveModel = from_candid request.args else Runtime.trap("Invalid save request");
                submitted := ?model;
                calls += 1;
                // Real await: the backend must not reuse its pre-await draft.
                await async { await* onDispatch() };
                if (reject) throw Error.reject("test lost reply");
                if (fail) return #err({ code = "test"; message = "save failed" });
                let result : Types.SavedPostResult = #ok({
                    postId = if (model.postId == "") "new-article" else model.postId;
                    bucketCanisterId = "434go-diaaa-aaaaf-qakwq-cai";
                    handle = model.handle;
                    title = model.title;
                    url = "/test-neutron/article";
                    isDraft = model.isDraft;
                    publishedDate = "100";
                    wordCount = "2";
                });
                #ok(to_candid (result));
            };
            let callsCapability : Caps.BackendCallsV1 = {
                canister_principal = Principal.fromText("aaaaa-aa");
                can_call = func(_ : Principal, _ : Text) : Bool { true };
                call = dispatch;
                call_batch = func(_ : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
                    Runtime.trap("Publishing should dispatch one save");
                };
            };
            public let app = Main.Init({
                stable_memory = { nuance = mem };
                capabilities = { backend_calls = callsCapability };
            });
            public func draft(source : ?Main.SourceRef) : Main.DraftView {
                let initial = okDraft(app.nuance_draft_create({
                    title = "Original title"; subtitle = "Original subtitle";
                    body = "Original body."; sourcePostId = source;
                }));
                okDraft(app.nuance_draft_set({
                    id = initial.id; expectedRevision = initial.revision;
                    title = initial.title; subtitle = initial.subtitle;
                    body = initial.body; tagIds = ["initial-tag"]; editor = "human";
                }));
            };
        };

        // Full-field edits and a following patch both survive, including tags,
        // provenance, the monotonic revision, and the article link needed by
        // the next save. The externally published text is the original snapshot.
        let edits = Fixture();
        let draft = edits.draft(null);
        edits.onDispatch := func() : async* () {
            let updated = okDraft(edits.app.nuance_draft_set({
                id = draft.id; expectedRevision = draft.revision;
                title = "Edited title"; subtitle = "Edited subtitle";
                body = "Edited body."; tagIds = ["new-tag"]; editor = "human";
            }));
            switch (edits.app.nuance_draft_patch({
                id = draft.id; expectedRevision = updated.revision;
                ops = [#append({ text = "Agent paragraph." })]; editor = "agent";
            })) {
                case (#ok(_)) {};
                case (_) Runtime.trap("Concurrent patch failed");
            };
        };
        let result = published(await* edits.app.nuance_publish(draft.id, false));
        assert result.title == "Original title";
        assert result.postId == "new-article";
        assert result.isDraft == false;
        assert result.url == "https://nuance.xyz/test-neutron/article";
        let live = read(edits.app, draft.id);
        assert live.title == "Edited title";
        assert live.subtitle == "Edited subtitle";
        assert live.body == "Edited body.\n\nAgent paragraph.";
        assert live.tagIds == ["new-tag"];
        assert live.modifiedBy == "agent";
        assert live.created == draft.created;
        assert live.revision == draft.revision + 3;
        assert live.sourcePostId == ?{
            postId = "new-article"; bucketCanisterId = "434go-diaaa-aaaaf-qakwq-cai";
        };
        let ?sent = edits.submitted else Runtime.trap("No submitted model");
        assert sent.title == draft.title;
        assert sent.tagIds == draft.tagIds;
        assert sent.content == "<p>Original body.</p>";
        // A CAS against the concurrent editor's old revision must conflict
        // rather than overwrite the newly attached source article.
        switch (edits.app.nuance_draft_set({
            id = draft.id; expectedRevision = live.revision - 1;
            title = "Stale"; subtitle = ""; body = "Stale"; tagIds = []; editor = "human";
        })) {
            case (#conflict(current)) assert current == live;
            case (_) Runtime.trap("Publishing must advance the current revision");
        };
        // The next publish uses the returned article id and the latest text.
        edits.onDispatch := func() : async* () {};
        ignore published(await* edits.app.nuance_publish(draft.id, true));
        let ?resubmitted = edits.submitted else Runtime.trap("No next submitted model");
        assert resubmitted.postId == "new-article";
        assert resubmitted.title == "Edited title";
        assert resubmitted.isDraft;
        assert edits.calls == 2;

        // Discarding the original and creating another active draft during
        // publication must neither resurrect the first nor bind the second.
        let deletion = Fixture();
        let removed = deletion.draft(null);
        var replacementId = "";
        deletion.onDispatch := func() : async* () {
            switch (deletion.app.nuance_draft_discard(removed.id)) {
                case (#ok(_)) {};
                case (#err(message)) Runtime.trap(message);
            };
            replacementId := deletion.draft(null).id;
        };
        assert published(await* deletion.app.nuance_publish("", false)).postId == "new-article";
        switch (deletion.app.nuance_draft_read(removed.id)) {
            case (#err(_)) {};
            case (#ok(_)) Runtime.trap("A published response resurrected a discarded draft");
        };
        assert deletion.app.nuance_draft_list().size() == 1;
        assert read(deletion.app, replacementId).sourcePostId == null;
        assert deletion.app.nuance_state().activeDraftId == replacementId;

        // Changing which draft is active must not change the identity of the
        // draft that receives a returned article id.
        let selection = Fixture();
        let selected = selection.draft(null);
        var otherId = "";
        selection.onDispatch := func() : async* () { otherId := selection.draft(null).id };
        ignore published(await* selection.app.nuance_publish("", false));
        assert read(selection.app, selected.id).sourcePostId != null;
        assert read(selection.app, otherId).sourcePostId == null;
        assert selection.app.nuance_state().activeDraftId == otherId;

        // Updating an existing article retains its identity and concurrent
        // text; a failed publish does not alter revisions or article binding.
        let existing = Fixture();
        let existingSource = { postId = "existing-article"; bucketCanisterId = "434go-diaaa-aaaaf-qakwq-cai" };
        let original = existing.draft(?existingSource);
        existing.fail := true;
        existing.onDispatch := func() : async* () {
            ignore okDraft(existing.app.nuance_draft_set({
                id = original.id; expectedRevision = original.revision;
                title = "Kept after failure"; subtitle = original.subtitle;
                body = original.body; tagIds = original.tagIds; editor = "human";
            }));
        };
        switch (await* existing.app.nuance_publish(original.id, false)) {
            case (#err(message)) assert message == "test: save failed";
            case (#ok(_)) Runtime.trap("Expected the broker failure");
        };
        let afterFailure = read(existing.app, original.id);
        assert afterFailure.title == "Kept after failure";
        assert afterFailure.revision == original.revision + 1;
        assert afterFailure.sourcePostId == ?existingSource;
        existing.fail := false;
        existing.onDispatch := func() : async* () {};
        assert published(await* existing.app.nuance_publish(original.id, false)).postId == "existing-article";
        assert read(existing.app, original.id).revision == afterFailure.revision + 1;

        // Overlapping calls for one draft issue exactly one save. A different
        // draft remains independently publishable during the first response.
        let overlap = Fixture();
        let first = overlap.draft(null);
        let second = overlap.draft(null);
        overlap.onDispatch := func() : async* () {
            overlap.onDispatch := func() : async* () {};
            switch (await* overlap.app.nuance_publish(first.id, false)) {
                case (#err(message)) assert Text.contains(message, #text "already being published");
                case (#ok(_)) Runtime.trap("The overlapping request created a duplicate save");
            };
            assert overlap.calls == 1;
            ignore published(await* overlap.app.nuance_publish(second.id, false));
            assert overlap.calls == 2;
        };
        ignore published(await* overlap.app.nuance_publish(first.id, false));
        assert overlap.calls == 2;
        // A new, explicit save works once its preceding call has completed.
        ignore published(await* overlap.app.nuance_publish(first.id, false));
        assert overlap.calls == 3;

        // A broker rejection releases transient coordination and makes no
        // automatic retry. Its result explains that upstream state must be
        // reconciled before the caller chooses another publication.
        let interrupted = Fixture();
        let uncertain = interrupted.draft(null);
        interrupted.reject := true;
        switch (await* interrupted.app.nuance_publish(uncertain.id, false)) {
            case (#err(message)) {
                assert Text.contains(message, #text "Check My posts");
                assert Text.contains(message, #text "may have saved");
            };
            case (#ok(_)) Runtime.trap("Expected an interrupted reply");
        };
        assert interrupted.calls == 1;
        assert read(interrupted.app, uncertain.id).revision == uncertain.revision;
        assert read(interrupted.app, uncertain.id).sourcePostId == null;
        interrupted.reject := false;
        ignore published(await* interrupted.app.nuance_publish(uncertain.id, false));
        assert interrupted.calls == 2;

        "Publish/edit, patch, deletion, active-draft change, article reuse, overlapping calls and failed-save regressions passed";
    };
};
