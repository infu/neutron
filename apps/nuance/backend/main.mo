// Nuance client backend.
//
// This canister does only what the browser cannot.
//
// It is NOT the read path. Nuance's entire read surface -- feeds, articles,
// comments, search, tags, profiles -- is public `query`, so the tile and the
// resident background call it directly and anonymously for free. Routing those
// through here turned free browser queries into replicated inter-canister
// updates the owner paid for: roughly 1.2M cycles of ingress reception, 5M of
// update execution, and 260k per brokered call, plus instructions. Reading one
// article that way also made this canister re-parse the whole HTML body to
// produce a plain-text field the tile discarded.
//
// What remains here needs the Neutron's own identity, or is durable app state:
//
//   * writes to Nuance -- publish, comment, vote, applaud, register;
//   * `nuance_my_posts`, which Nuance scopes to the caller;
//   * shared drafts, the reading list, and the shard write-allowlist.
//
// Identity: calls reach Nuance as this Neutron canister's own principal
// (`backendCalls.canister_principal`), not as the owner's Internet Identity.
// Nuance therefore sees a fresh account owned by this Neutron. That is a
// deliberate consequence of needing writes to work with no tile open and no
// per-call dialog; it is disclosed to the owner in the account view.

import Error "mo:core/Error";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";

import Caps "mo:neutron-capabilities";

import Memory "./memory/nuance/v2";
import Client "./nuance/Client";
import Draft "./nuance/Draft";
import Markup "./nuance/Markup";
import NuanceTypes "./nuance/Types";

module {

    // Nuance's own limits, enforced here so the UI and agents get a precise
    // error instead of an opaque canister reject.
    let MAX_TITLE : Nat = 400;
    let MAX_SUBTITLE : Nat = 400;
    let MAX_BODY : Nat = 300_000;
    let MAX_COMMENT : Nat = 400;
    let MAX_TAGS : Nat = 3;
    let MAX_HANDLE : Nat = 32;

    // Local bounds. Drafts live in a shared actor, so they are capped here
    // rather than only in the UI.
    let MAX_DRAFTS : Nat = 8;
    let MAX_BOOKMARKS : Nat = 200;
    let MAX_PAGE : Nat = 40;
    let MAX_OFFSET : Nat = 100_000;

    // A module-level binding must be a static expression, so this is one literal
    // rather than a concatenation.
    let IDENTITY_NOTE : Text = "This Neutron posts to Nuance under its own canister principal, not your nuance.xyz login. Internet Identity principals are scoped per origin, so this is a separate Nuance account with its own handle.";

    // ------------------------------------------------------------ app types
    //
    // These mirror types defined in the memory schema and the patch engine.
    // Motoko is structurally typed, so the duplicates are interchangeable with
    // their originals; they exist because the packaged method-schema generator
    // resolves only aliases declared in this module, not qualified names.

    public type SourceRef = {
        postId : Text;
        bucketCanisterId : Text;
    };

    public type BookmarkView = {
        postId : Text;
        bucketCanisterId : Text;
        title : Text;
        handle : Text;
        saved : Int;
    };

    public type PostTag = {
        tagId : Text;
        tagName : Text;
    };

    /// One PostCore index row, returned verbatim. The browser hydrates these into
    /// full rows itself, because the shard read that supplies titles is public.
    public type PostIndexRow = {
        postId : Text;
        bucketCanisterId : Text;
        handle : Text;
        claps : Text;
        views : Text;
        created : Text;
        modified : Text;
        publishedDate : Text;
        isDraft : Bool;
        tags : [PostTag];
    };

    public type PatchOp = {
        #replace : { find : Text; replaceWith : Text; occurrence : ?Nat };
        #insert_after : { find : Text; text : Text };
        #insert_before : { find : Text; text : Text };
        #append : { text : Text };
        #prepend : { text : Text };
        #replace_section : { heading : Text; body : Text };
        #set_title : Text;
        #set_subtitle : Text;
        #set_tags : [Text];
    };

    public type Identity = {
        principalId : Text;
        handle : Text;
        displayName : Text;
        registered : Bool;
        note : Text;
    };

    public type DraftView = {
        id : Text;
        title : Text;
        subtitle : Text;
        tagIds : [Text];
        body : Text;
        revision : Nat;
        created : Int;
        modified : Int;
        modifiedBy : Text;
        sourcePostId : ?SourceRef;
        wordCount : Nat;
        isActive : Bool;
    };

    public type Published = {
        postId : Text;
        bucketCanisterId : Text;
        url : Text;
        isDraft : Bool;
        title : Text;
    };

    /// Everything the tile needs from the canister for a first paint, from
    /// memory only. The article content it shows alongside comes from Nuance
    /// directly and costs nothing.
    public type AppState = {
        identity : Identity;
        drafts : [DraftView];
        activeDraftId : Text;
        bookmarks : [BookmarkView];
        buckets : [Text];
    };

    public type DraftInput = {
        id : Text;
        expectedRevision : Nat;
        title : Text;
        subtitle : Text;
        tagIds : [Text];
        body : Text;
        editor : Text;
    };

    public type DraftCreateInput = {
        title : Text;
        subtitle : Text;
        body : Text;
        sourcePostId : ?SourceRef;
    };

    public type PatchInput = {
        id : Text;
        expectedRevision : Nat;
        ops : [PatchOp];
        editor : Text;
    };

    public type CommentInput = {
        postId : Text;
        bucketCanisterId : Text;
        content : Text;
        replyToCommentId : ?Text;
        editCommentId : ?Text;
    };

    // Result aliases. Concrete rather than generic so the generated Candid and
    // the derived JSON schemas stay legible to callers.
    public type IdentityResult = { #ok : Identity; #err : Text };
    public type PublishResult = { #ok : Published; #err : Text };
    public type AckResult = { #ok : Text; #err : Text };
    public type DraftReadResult = { #ok : DraftView; #err : Text };
    public type IndexResult = { #ok : [PostIndexRow]; #err : Text };

    /// Draft writes are compare-and-swap. `#conflict` carries the current draft
    /// so the loser can rebase without a second round trip.
    public type DraftWriteResult = {
        #ok : DraftView;
        #conflict : DraftView;
        #err : Text;
    };

    public type PatchResult = {
        #ok : { draft : DraftView; applied : [Text] };
        #conflict : DraftView;
        #err : Text;
    };

    // ---------------------------------------------------------- environment

    public type AppBackendEnvironment = {
        stable_memory : {
            nuance : Memory.Mem;
        };
        capabilities : {
            backend_calls : Caps.BackendCallsV1;
        };
    };

    public class Init(env : AppBackendEnvironment) {

        let mem = env.stable_memory.nuance;
        let backendCalls = env.capabilities.backend_calls;

        // Init is retained for the installed actor's lifetime. Coordinate
        // overlapping saves of the same local draft so two new-post requests
        // cannot both leave before the first returns its article id. This is
        // intentionally not a durable retry journal: after a lost response,
        // callers must reconcile My posts before choosing to publish again.
        var publishingDrafts = List.empty<Text>();

        func finishPublishing(id : Text) {
            publishingDrafts := List.filter<Text>(publishingDrafts, func(current : Text) : Bool { current != id });
        };

        // ------------------------------------------------------- bookkeeping

        /// Bootstrap the shard write-allowlist from the package-time constants.
        /// Only runs while the list is empty, so owner-registered shards survive
        /// upgrades.
        func ensureBuckets() {
            if (mem.buckets.size() > 0) return;
            let out = List.empty<Principal>();
            for (id in Client.knownBuckets.vals()) {
                List.add(out, Principal.fromText(id));
            };
            mem.buckets := List.toArray(out);
        };

        func lookupBucket(id : Text) : ?Principal {
            ensureBuckets();
            for (p in mem.buckets.vals()) {
                if (Principal.toText(p) == id) return ?p;
            };
            null;
        };

        func principalId() : Text {
            Principal.toText(backendCalls.canister_principal);
        };

        func natToText(value : Nat) : Text = Nat.toText(value);

        func clampPage(value : Nat) : Nat32 {
            let bounded = if (value == 0) { 10 } else if (value > MAX_PAGE) { MAX_PAGE } else { value };
            Nat32.fromNat(bounded);
        };

        func clampOffset(value : Nat) : Nat32 {
            Nat32.fromNat(if (value > MAX_OFFSET) { MAX_OFFSET } else { value });
        };

        // ---------------------------------------------------------- identity

        func identitySnapshot() : Identity {
            {
                principalId = principalId();
                handle = mem.handle;
                displayName = mem.displayName;
                registered = mem.registered;
                note = IDENTITY_NOTE;
            };
        };

        func validHandle(handle : Text) : Bool {
            if (handle == "" or handle.size() > MAX_HANDLE) return false;
            for (c in handle.chars()) {
                let ok =
                    (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or
                    (c >= '0' and c <= '9') or c == '-';
                if (not ok) return false;
            };
            true;
        };

        public func /*update*/nuance_register(
            handle : Text,
            displayName : Text,
            avatar : Text,
        ) : async* IdentityResult {
            if (mem.registered) return #err("This Neutron already has the handle @" # mem.handle # ".");
            let trimmed = Text.trim(handle, #char ' ');
            if (not validHandle(trimmed)) {
                return #err(
                    "A Nuance handle is 1-" # natToText(MAX_HANDLE) #
                    " characters of letters, digits, or hyphens."
                );
            };

            let request = Client.registerUserRequest(trimmed, displayName, avatar);
            switch (Client.decodeUserProfile(await* backendCalls.call(request))) {
                case (#err(message)) #err(message);
                case (#ok(profile)) {
                    mem.handle := profile.handle;
                    mem.displayName := profile.displayName;
                    mem.registered := true;
                    mem.identityChecked := Time.now();
                    #ok(identitySnapshot());
                };
            };
        };

        // ------------------------------------------------ caller-scoped reads

        /// Nuance scopes these to the calling principal, so they cannot be read
        /// from the browser. Only the index rows are returned; the browser
        /// hydrates titles from the shards itself, for free.
        public func /*update*/nuance_my_posts(
            kind : Text,
            offset : Nat,
            limit : Nat,
        ) : async* IndexResult {
            if (mem.handle == "") return #err("Register a Nuance handle first.");
            let capped = clampPage(limit);
            let from = clampOffset(offset);
            let to = from + capped;
            let request = if (kind == "drafts") {
                Client.myDraftPostsRequest(from, to);
            } else {
                Client.myPublishedPostsRequest(from, to);
            };
            switch (Client.decodeKeyPropertiesList(await* backendCalls.call(request))) {
                case (#err(message)) #err(message);
                case (#ok(keys)) #ok(keys);
            };
        };

        // ------------------------------------------------------------- writes

        public func /*update*/nuance_comment(input : CommentInput) : async* AckResult {
            if (mem.handle == "") {
                return #err("Register a Nuance handle before commenting.");
            };
            let content = Text.trim(input.content, #char ' ');
            if (content == "") return #err("A comment cannot be empty.");
            if (content.size() > MAX_COMMENT) {
                return #err(
                    "Nuance limits comments to " # natToText(MAX_COMMENT) #
                    " characters; this one is " # natToText(content.size()) # "."
                );
            };

            let ?bucket = lookupBucket(input.bucketCanisterId) else {
                return #err(shardError(input.bucketCanisterId));
            };

            let model : NuanceTypes.SaveCommentModel = {
                postId = input.postId;
                content;
                commentId = input.editCommentId;
                replyToCommentId = input.replyToCommentId;
            };
            let request = Client.saveCommentRequest(bucket, model);
            switch (Client.decodeComments(await* backendCalls.call(request))) {
                case (#err(message)) #err(message);
                case (#ok(_)) #ok("Comment posted.");
            };
        };

        public func /*update*/nuance_vote_comment(
            bucketCanisterId : Text,
            commentId : Text,
            vote : Text,
        ) : async* AckResult {
            let ?bucket = lookupBucket(bucketCanisterId) else {
                return #err(shardError(bucketCanisterId));
            };
            let request = Client.voteCommentRequest(bucket, commentId, vote);
            switch (Client.decodeComments(await* backendCalls.call(request))) {
                case (#err(message)) #err(message);
                case (#ok(_)) #ok("Vote recorded.");
            };
        };

        func shardError(id : Text) : Text {
            "This app has no write access to Nuance shard " # id #
            ". Grant it from the account view, then retry.";
        };

        public func /*update*/nuance_clap(postId : Text) : async* AckResult {
            if (mem.handle == "") return #err("Register a Nuance handle before applauding.");
            switch (Client.decodeAcknowledgement(await* backendCalls.call(Client.clapRequest(postId)))) {
                case (#ok(())) #ok("Applauded.");
                case (#err(message)) #err(message);
            };
        };

        public func /*update*/nuance_publish(id : Text, asDraft : Bool) : async* PublishResult {
            if (mem.handle == "") return #err("Register a Nuance handle before publishing.");
            let resolved = resolveDraftId(id);
            let ?draft = findDraft(resolved) else {
                return #err("No draft with id " # debug_show (resolved) # ".");
            };
            if (List.contains<Text>(publishingDrafts, Text.equal, resolved)) {
                return #err("This draft is already being published. Wait for that result before publishing it again.");
            };

            let title = Text.trim(draft.title, #char ' ');
            if (title == "") return #err("Give the article a title before publishing.");
            if (title.size() > MAX_TITLE) {
                return #err("Nuance limits titles to " # natToText(MAX_TITLE) # " characters.");
            };
            if (draft.subtitle.size() > MAX_SUBTITLE) {
                return #err("Nuance limits subtitles to " # natToText(MAX_SUBTITLE) # " characters.");
            };
            if (Text.trim(draft.body, #char ' ') == "") {
                return #err("Nuance rejects an empty body.");
            };
            if (draft.tagIds.size() == 0) {
                return #err("Nuance requires at least one tag.");
            };
            if (draft.tagIds.size() > MAX_TAGS) {
                return #err("Nuance allows at most " # natToText(MAX_TAGS) # " tags.");
            };

            // Markup generation stays here on purpose: `nuance_publish` takes a
            // draft id, not a body, so an agent cannot publish something other
            // than what the human sees in the editor.
            let content = Markup.textToHtml(draft.body);
            if (content == "") {
                return #err("The body has no content once formatting is applied.");
            };
            if (content.size() > MAX_BODY) {
                return #err(
                    "The generated article body is " # natToText(content.size()) #
                    " characters; Nuance's limit is " # natToText(MAX_BODY) # "."
                );
            };

            let existingId = switch (draft.sourcePostId) {
                case (?source) source.postId;
                case null "";
            };

            let model : NuanceTypes.PostSaveModel = {
                postId = existingId;
                title;
                subtitle = draft.subtitle;
                content;
                category = "";
                handle = mem.handle;
                // Personal posts carry an empty creator handle; that field marks
                // publication authorship, which this app does not use.
                creatorHandle = "";
                headerImage = "";
                isDraft = asDraft;
                isMembersOnly = false;
                isPublication = false;
                premium = null;
                scheduledPublishedDate = null;
                tagIds = draft.tagIds;
            };

            let request = Client.saveRequest(model);
            List.add(publishingDrafts, resolved);
            let reply = try {
                await* backendCalls.call(request);
            } catch (error) {
                finishPublishing(resolved);
                return #err("The publish reply was interrupted: " # Error.message(error) # ". Check My posts before publishing again; Nuance may have saved the article.");
            };
            finishPublishing(resolved);
            switch (Client.decodeSavedPost(reply)) {
                case (#err(message)) #err(message);
                case (#ok(saved)) {
                    // A draft can be edited or discarded while Nuance saves
                    // the submitted snapshot. Attach the returned article to
                    // the current draft without replacing newer text/revisions
                    // or recreating a draft the owner already discarded.
                    switch (findDraft(draft.id)) {
                        case null {};
                        case (?current) {
                            storeDraft({
                                current with
                                sourcePostId = ?{
                                    postId = saved.postId;
                                    bucketCanisterId = saved.bucketCanisterId;
                                };
                                revision = current.revision + 1;
                                modified = Time.now();
                            });
                        };
                    };
                    #ok({
                        postId = saved.postId;
                        bucketCanisterId = saved.bucketCanisterId;
                        url = "https://nuance.xyz" # saved.url;
                        isDraft = saved.isDraft;
                        title = saved.title;
                    });
                };
            };
        };

        // ------------------------------------------------------------ shards

        /// Add a shard the owner has just granted a write reservation for. Takes
        /// a principal, not text, so nothing here has to parse one.
        public func /*update*/nuance_register_bucket(bucket : Principal) : AckResult {
            ensureBuckets();
            let id = Principal.toText(bucket);
            for (p in mem.buckets.vals()) {
                if (Principal.equal(p, bucket)) return #ok("Shard " # id # " was already registered.");
            };
            if (not backendCalls.can_call(bucket, "saveComment")) {
                return #err(
                    "No backend-call reservation for " # id #
                    " yet. Grant it first, then register the shard."
                );
            };
            let out = List.empty<Principal>();
            for (p in mem.buckets.vals()) List.add(out, p);
            List.add(out, bucket);
            mem.buckets := List.toArray(out);
            #ok("Registered Nuance shard " # id # ".");
        };

        // ------------------------------------------------------------ drafts

        func draftView(d : Memory.Draft) : DraftView {
            {
                id = d.id;
                title = d.title;
                subtitle = d.subtitle;
                tagIds = d.tagIds;
                body = d.body;
                revision = d.revision;
                created = d.created;
                modified = d.modified;
                modifiedBy = d.modifiedBy;
                sourcePostId = d.sourcePostId;
                wordCount = Markup.wordCount(d.body);
                isActive = d.id == mem.activeDraftId;
            };
        };

        func resolveDraftId(id : Text) : Text {
            if (id != "") return id;
            if (mem.activeDraftId != "") return mem.activeDraftId;
            if (mem.drafts.size() > 0) return mem.drafts[0].id;
            "";
        };

        func findDraft(id : Text) : ?Memory.Draft {
            for (d in mem.drafts.vals()) { if (d.id == id) return ?d };
            null;
        };

        func storeDraft(value : Memory.Draft) {
            let out = List.empty<Memory.Draft>();
            var replaced = false;
            for (d in mem.drafts.vals()) {
                if (d.id == value.id) {
                    List.add(out, value);
                    replaced := true;
                } else List.add(out, d);
            };
            if (not replaced) List.add(out, value);
            mem.drafts := List.toArray(out);
        };

        func normalizeEditor(editor : Text) : Text {
            switch (editor) {
                case ("human") "human";
                case ("agent") "agent";
                case (_) "";
            };
        };

        func createDraft(input : DraftCreateInput) : DraftWriteResult {
            if (mem.drafts.size() >= MAX_DRAFTS) {
                return #err(
                    "This app keeps at most " # natToText(MAX_DRAFTS) #
                    " drafts. Publish or discard one first."
                );
            };
            if (input.body.size() > MAX_BODY) {
                return #err("The body exceeds Nuance's " # natToText(MAX_BODY) # " character limit.");
            };
            let now = Time.now();
            let id = "d" # natToText(mem.nextDraftId);
            let draft : Memory.Draft = {
                id;
                title = input.title;
                subtitle = input.subtitle;
                tagIds = [];
                body = input.body;
                revision = 1;
                created = now;
                modified = now;
                modifiedBy = "human";
                sourcePostId = input.sourcePostId;
                suggestions = [];
            };
            mem.nextDraftId += 1;
            storeDraft(draft);
            mem.activeDraftId := id;
            #ok(draftView(draft));
        };

        public func /*query*/nuance_draft_list() : [DraftView] {
            let out = List.empty<DraftView>();
            for (d in mem.drafts.vals()) List.add(out, draftView(d));
            List.toArray(out);
        };

        public func /*query*/nuance_draft_read(id : Text) : DraftReadResult {
            let resolved = resolveDraftId(id);
            switch (findDraft(resolved)) {
                case (?d) #ok(draftView(d));
                case null #err("No draft with id " # debug_show (resolved) # ".");
            };
        };

        public func /*update*/nuance_draft_new(title : Text, body : Text) : DraftWriteResult {
            createDraft({ title; subtitle = ""; body; sourcePostId = null });
        };

        /// Seed a draft from an article the browser already fetched. Nuance
        /// enforces authorship on publish, so this is a convenience, not a gate.
        public func /*update*/nuance_draft_create(input : DraftCreateInput) : DraftWriteResult {
            createDraft(input);
        };

        public func /*update*/nuance_draft_discard(id : Text) : AckResult {
            let resolved = resolveDraftId(id);
            switch (findDraft(resolved)) {
                case null #err("No draft with id " # debug_show (resolved) # ".");
                case (?_) {
                    let out = List.empty<Memory.Draft>();
                    for (d in mem.drafts.vals()) { if (d.id != resolved) List.add(out, d) };
                    mem.drafts := List.toArray(out);
                    if (mem.activeDraftId == resolved) {
                        mem.activeDraftId := if (List.size(out) > 0) List.toArray(out)[0].id else "";
                    };
                    #ok("Discarded draft " # resolved # ".");
                };
            };
        };

        /// Full-field write. The tile's editor uses this on a debounce; the
        /// revision check is what stops it from overwriting an agent edit that
        /// landed while the human was typing.
        public func /*update*/nuance_draft_set(input : DraftInput) : DraftWriteResult {
            let resolved = resolveDraftId(input.id);
            let ?current = findDraft(resolved) else {
                return #err("No draft with id " # debug_show (resolved) # ".");
            };
            if (current.revision != input.expectedRevision) return #conflict(draftView(current));
            if (input.body.size() > MAX_BODY) {
                return #err("The body exceeds Nuance's " # natToText(MAX_BODY) # " character limit.");
            };

            let updated : Memory.Draft = {
                current with
                title = input.title;
                subtitle = input.subtitle;
                tagIds = input.tagIds;
                body = input.body;
                revision = current.revision + 1;
                modified = Time.now();
                modifiedBy = normalizeEditor(input.editor);
            };
            storeDraft(updated);
            #ok(draftView(updated));
        };

        /// Ordered, atomic patch. This is the agent's main write path.
        public func /*update*/nuance_draft_patch(input : PatchInput) : PatchResult {
            let resolved = resolveDraftId(input.id);
            let ?current = findDraft(resolved) else {
                return #err("No draft with id " # debug_show (resolved) # ".");
            };
            if (current.revision != input.expectedRevision) return #conflict(draftView(current));

            let target : Draft.Target = {
                title = current.title;
                subtitle = current.subtitle;
                tagIds = current.tagIds;
                body = current.body;
            };
            switch (Draft.apply(target, input.ops, MAX_BODY)) {
                case (#err(error)) #err(Draft.errorText(error));
                case (#ok({ target = next; applied })) {
                    let updated : Memory.Draft = {
                        current with
                        title = next.title;
                        subtitle = next.subtitle;
                        tagIds = next.tagIds;
                        body = next.body;
                        revision = current.revision + 1;
                        modified = Time.now();
                        modifiedBy = normalizeEditor(input.editor);
                    };
                    storeDraft(updated);
                    #ok({ draft = draftView(updated); applied });
                };
            };
        };

        // --------------------------------------------------------- bookmarks

        func isBookmarked(postId : Text) : Bool {
            for (b in mem.bookmarks.vals()) {
                if (b.postId == postId) return true;
            };
            false;
        };

        public func /*query*/nuance_bookmarks() : [BookmarkView] {
            mem.bookmarks;
        };

        public func /*update*/nuance_toggle_bookmark(
            postId : Text,
            bucketCanisterId : Text,
            title : Text,
            handle : Text,
        ) : AckResult {
            if (isBookmarked(postId)) {
                let out = List.empty<Memory.Bookmark>();
                for (b in mem.bookmarks.vals()) { if (b.postId != postId) List.add(out, b) };
                mem.bookmarks := List.toArray(out);
                return #ok("Removed from your reading list.");
            };
            if (mem.bookmarks.size() >= MAX_BOOKMARKS) {
                return #err("Your reading list holds " # natToText(MAX_BOOKMARKS) # " articles. Remove one first.");
            };
            let out = List.empty<Memory.Bookmark>();
            List.add(out, { postId; bucketCanisterId; title; handle; saved = Time.now() });
            for (b in mem.bookmarks.vals()) List.add(out, b);
            mem.bookmarks := List.toArray(out);
            #ok("Saved to your reading list.");
        };

        // ------------------------------------------------------------- state

        public func /*query*/nuance_state() : AppState {
            ensureBuckets();
            let drafts = List.empty<DraftView>();
            for (d in mem.drafts.vals()) List.add(drafts, draftView(d));
            let buckets = List.empty<Text>();
            for (p in mem.buckets.vals()) List.add(buckets, Principal.toText(p));
            {
                identity = identitySnapshot();
                drafts = List.toArray(drafts);
                activeDraftId = mem.activeDraftId;
                bookmarks = mem.bookmarks;
                buckets = List.toArray(buckets);
            };
        };
    };

    /*---NEUTRON GENERATED BEGIN---*/

public type nuance_register_Input = (handle : Text,
            displayName : Text,
            avatar : Text,);
public type nuance_register_Output = IdentityResult;

public type nuance_my_posts_Input = (kind : Text,
            offset : Nat,
            limit : Nat,);
public type nuance_my_posts_Output = IndexResult;

public type nuance_comment_Input = (input : CommentInput);
public type nuance_comment_Output = AckResult;

public type nuance_vote_comment_Input = (bucketCanisterId : Text,
            commentId : Text,
            vote : Text,);
public type nuance_vote_comment_Output = AckResult;

public type nuance_clap_Input = (postId : Text);
public type nuance_clap_Output = AckResult;

public type nuance_publish_Input = (id : Text, asDraft : Bool);
public type nuance_publish_Output = PublishResult;

public type nuance_register_bucket_Input = (bucket : Principal);
public type nuance_register_bucket_Output = AckResult;

public type nuance_draft_list_Input = ();
public type nuance_draft_list_Output = [DraftView];

public type nuance_draft_read_Input = (id : Text);
public type nuance_draft_read_Output = DraftReadResult;

public type nuance_draft_new_Input = (title : Text, body : Text);
public type nuance_draft_new_Output = DraftWriteResult;

public type nuance_draft_create_Input = (input : DraftCreateInput);
public type nuance_draft_create_Output = DraftWriteResult;

public type nuance_draft_discard_Input = (id : Text);
public type nuance_draft_discard_Output = AckResult;

public type nuance_draft_set_Input = (input : DraftInput);
public type nuance_draft_set_Output = DraftWriteResult;

public type nuance_draft_patch_Input = (input : PatchInput);
public type nuance_draft_patch_Output = PatchResult;

public type nuance_bookmarks_Input = ();
public type nuance_bookmarks_Output = [BookmarkView];

public type nuance_toggle_bookmark_Input = (postId : Text,
            bucketCanisterId : Text,
            title : Text,
            handle : Text,);
public type nuance_toggle_bookmark_Output = AckResult;

public type nuance_state_Input = ();
public type nuance_state_Output = AppState;

/*---NEUTRON GENERATED END---*/
};
