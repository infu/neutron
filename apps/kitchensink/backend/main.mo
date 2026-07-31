import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Iter "mo:core/Iter";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import NeutronCapabilities "mo:neutron-capabilities";
import Memory "./memory/kitchensink/v1";

module {

    public type TaskCapabilities = {
        backend_calls : NeutronCapabilities.BackendCallsV1;
    };

    public type ScheduledStatus = {
        task_id : Text;
        runs : Nat;
        last_counter : Nat;
        interval_seconds : Nat;
    };

    public type DependencyStatus = {
        dependency_alias : Text;
        target_app : Text;
        minimum_version : Nat;
        exported_method : Text;
        contacts_revision : Nat;
    };

    public type FunctionResourceSnapshot = {
        caller : Text;
        canister : Text;
        counter : Nat;
    };

    public type AppCalls = {
        contacts : {
            contacts_neutron_revision_v2 : (()) -> Nat;
        };
    };

    public type MutableBlobDemoV1 = {
        schema : Nat;
        message : Text;
    };

    public type ChainKeyPublicDemo = {
        ok : Bool;
        error : Text;
        slot : Text;
        algorithm : Text;
        public_key_hex : Text;
        key_fingerprint_hex : Text;
        signing_domain_hex : Text;
        namespace_version : Nat;
        message_format : Text;
    };

    public type ChainKeySignatureDemo = {
        ok : Bool;
        error : Text;
        assertion_text : Text;
        slot : Text;
        algorithm : Text;
        digest_hex : Text;
        signature_hex : Text;
        signing_domain_hex : Text;
        message_format : Text;
    };

    public type StableNotesEntry = {
        key : Text;
        value : Text;
        revision : Text;
        schema_version : Nat;
    };

    public type StableNotesUsage = {
        entries : Nat;
        bytes : Nat;
        max_entries : Nat;
        max_bytes : Nat;
        over_quota : Bool;
        schema_version : Nat;
    };

    public type StableNotesResult = {
        ok : Bool;
        error : Text;
        entry : ?StableNotesEntry;
        usage : ?StableNotesUsage;
    };

    public type StableNotesPage = {
        ok : Bool;
        error : Text;
        entries : [StableNotesEntry];
        has_more : Bool;
        next_namespace_uid : Text;
        next_after : Text;
        observed_revision : Text;
    };

    public type StableNotesClearPage = {
        ok : Bool;
        error : Text;
        removed_entries : Nat;
        removed_bytes : Nat;
        more : Bool;
        usage : ?StableNotesUsage;
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            kitchensink : Memory.Mem;
        };
        app_calls : AppCalls;
        capabilities : {
            backend_calls : NeutronCapabilities.BackendCallsV1;
            randomness : NeutronCapabilities.RandomnessV1;
            chain_key_signing : NeutronCapabilities.ChainKeySigningV1;
            https_outcalls : NeutronCapabilities.HttpsOutcallsV1;
            certified_assets : NeutronCapabilities.CertifiedAssetsV2;
            stable_store : NeutronCapabilities.StableStoreV1;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let MAX_COUNTER : Nat = 1_000_000_000;
        let MAX_COUNTER_STEP : Nat = 10_000;
        let mem = env.stable_memory.kitchensink;
        let appCalls = env.app_calls;
        let backendCalls = env.capabilities.backend_calls;
        let randomness = env.capabilities.randomness;
        let chainKeySigning = env.capabilities.chain_key_signing;
        let httpsOutcalls = env.capabilities.https_outcalls;
        let certifiedAssets = env.capabilities.certified_assets;
        let stableStore = env.capabilities.stable_store;
        let MAX_NAT64 : Nat = 18_446_744_073_709_551_615;
        let RECEIPT_ASSERTION =
            "Kitchen Sink receipt assertion v1\n" #
            "item=capability-lab-demo\n" #
            "amount=0\n" #
            "currency=none";

        public func /*query*/public_status() : Text {
            "Kitchen Sink capability lab is ready";
        };

        public func /*query*/read_profile() : Text {
            "Name: " # mem.profileName #
            "\nEmail: " # mem.profileEmail #
            "\nSubscribed: " # debug_show(mem.subscribed) #
            "\nNotes: " # mem.profileNotes;
        };

        public func /*update*/save_profile(name : Text, email : Text, notes : Text, subscribed : Bool) : Text {
            if (name.size() > 80) return "Name must be 80 characters or fewer";
            if (email.size() > 160) return "Email must be 160 characters or fewer";
            if (notes.size() > 2_000) return "Notes must be 2,000 characters or fewer";
            mem.profileName := name;
            mem.profileEmail := email;
            mem.profileNotes := notes;
            mem.subscribed := subscribed;
            "Saved " # name # " <" # email # ">";
        };

        public func /*update*/echo(message : Text) : Text {
            if (message.size() > 256) return "Message must be 256 characters or fewer";
            mem.lastMessage := message;
            "Echo: " # message;
        };

        public func /*update*/add(left : Int, right : Int) : Int {
            left + right;
        };

        public func /*update*/bump_counter(step : Nat) : Nat {
            if (not bumpCounter(step)) {
                Runtime.trap("Counter step exceeds 10,000 or the counter reached its 1,000,000,000 limit");
            };
            mem.counter;
        };

        public func /*query*/read_counter() : Nat {
            mem.counter;
        };

        public func /*update*/random_bytes() : async* Text {
            switch (await* randomness.fresh_bytes()) {
                case (#ok(bytes)) "0x" # hex(bytes);
                case (#err(error)) randomnessErrorText(error);
            };
        };

        public func /*update*/chain_key_public_key() : async* ChainKeyPublicDemo {
            switch (await* chainKeySigning.public_key("receipt_assertions")) {
                case (#ok(info)) {
                    {
                        ok = true;
                        error = "";
                        slot = info.slot;
                        algorithm = chainKeyAlgorithmText(info.algorithm);
                        public_key_hex = "0x" # hex(info.public_key);
                        key_fingerprint_hex = "0x" # hex(info.key_fingerprint);
                        signing_domain_hex = "0x" # hex(info.signing_domain);
                        namespace_version = info.namespace_version;
                        message_format = chainKeyMessageFormatText(info.message_format);
                    };
                };
                case (#err(error)) emptyChainKeyPublicDemo(chainKeyErrorText(error));
            };
        };

        public func /*update*/chain_key_sign_receipt() : async* ChainKeySignatureDemo {
            switch (await* chainKeySigning.sign_assertion({
                slot = "receipt_assertions";
                assertion = Text.encodeUtf8(RECEIPT_ASSERTION);
            })) {
                case (#ok(info)) {
                    {
                        ok = true;
                        error = "";
                        assertion_text = RECEIPT_ASSERTION;
                        slot = info.slot;
                        algorithm = chainKeyAlgorithmText(info.algorithm);
                        digest_hex = "0x" # hex(info.digest);
                        signature_hex = "0x" # hex(info.signature);
                        signing_domain_hex = "0x" # hex(info.signing_domain);
                        message_format = chainKeyMessageFormatText(info.message_format);
                    };
                };
                case (#err(error)) emptyChainKeySignatureDemo(chainKeyErrorText(error));
            };
        };

        public func /*update*/https_example(method : Text) : async* Text {
            let result = if (method == "GET") {
                await* httpsOutcalls.request({
                    endpoint = "example";
                    method = #get;
                    path = "";
                    query_params = [];
                    headers = [{ name = "accept"; value = "text/html" }];
                    body = Text.encodeUtf8("");
                    idempotency_key = null;
                });
            } else if (method == "HEAD") {
                await* httpsOutcalls.request({
                    endpoint = "example";
                    method = #head;
                    path = "";
                    query_params = [];
                    headers = [{ name = "accept"; value = "text/html" }];
                    body = Text.encodeUtf8("");
                    idempotency_key = null;
                });
            } else {
                return "Choose GET or HEAD";
            };

            switch (result) {
                case (#ok(response)) {
                    let prefix =
                        method # " https://example.com/ returned HTTP " #
                        Nat.toText(response.status) # " with " #
                        Nat.toText(response.body.size()) # " body bytes";
                    if (response.body.size() == 0) prefix
                    else prefix # "\n\nBody preview:\n" # safeTextPreview(response.body, 320);
                };
                case (#err(error)) {
                    "HTTPS outcall failed: " # boundedText(debug_show(error), 160);
                };
            };
        };

        public func /*update*/backend_probe(target : Principal) : async* Text {
            if (not backendCalls.can_call(target, "icrc1_fee")) {
                return "Reserve exact icrc1_fee access for this ledger first";
            };
            switch (await* backendCalls.call({
                canister = target;
                method = "icrc1_fee";
                args = to_candid ();
                cycles = 1_000_000;
            })) {
                case (#err(error)) {
                    "Backend call failed (" # boundedText(error.code, 64) # "): " #
                    boundedText(error.message, 256);
                };
                case (#ok(reply)) {
                    let decoded : ?Nat = from_candid reply;
                    switch (decoded) {
                        case (?fee) {
                            "icrc1_fee returned " # boundedText(Nat.toText(fee), 128) #
                            ". The demo attached 1,000,000 cycles; a ledger that accepts none refunds them."
                        };
                        case null "The ledger returned an invalid icrc1_fee reply";
                    };
                };
            };
        };

        public func /*internal*/scheduled_tick(
            (),
            /*task_capabilities*/ taskCapabilities : TaskCapabilities,
        ) : async* () {
            ignore taskCapabilities.backend_calls.canister_principal;
            ignore bumpCounter(1);
            mem.scheduledRuns += 1;
            mem.lastScheduledCounter := mem.counter;
        };

        public func /*query*/scheduled_status() : ScheduledStatus {
            {
                task_id = "daily_tick";
                runs = mem.scheduledRuns;
                last_counter = mem.lastScheduledCounter;
                interval_seconds = 86_400;
            };
        };

        public func /*query*/dependency_status() : DependencyStatus {
            {
                dependency_alias = "contacts";
                target_app = "contacts";
                minimum_version = 101;
                exported_method = "contacts_neutron_revision_v2";
                contacts_revision = appCalls.contacts.contacts_neutron_revision_v2(());
            };
        };

        public func /*query*/function_resource_snapshot(
            (),
            /*caller,canister_principal,memory_kitchensink*/ caller : Principal,
            canisterPrincipal : Principal,
            kitchensinkMemory : Memory.Mem,
        ) : FunctionResourceSnapshot {
            {
                caller = Principal.toText(caller);
                canister = Principal.toText(canisterPrincipal);
                counter = kitchensinkMemory.counter;
            };
        };

        // The store is binary-safe; this reference page deliberately wraps it
        // in a UTF-8 notes model so browser and Candid callers never have to
        // manufacture raw Blob values.
        public func /*update*/stable_notes_create(key : Text, value : Text) : StableNotesResult {
            switch (stableStore.put({
                store = "notes";
                key = Text.encodeUtf8(key);
                value = Text.encodeUtf8(value);
                condition = #if_absent;
            })) {
                case (#ok(receipt)) {
                    {
                        ok = true;
                        error = "";
                        entry = ?stableNotesEntry(key, value, receipt.revision, receipt.schema_version);
                        usage = ?stableNotesUsage(receipt.usage);
                    };
                };
                case (#err(error)) stableNotesFailure(stableStoreErrorText(error));
            };
        };

        public func /*query*/stable_notes_load(key : Text) : StableNotesResult {
            switch (stableStore.get({
                store = "notes";
                key = Text.encodeUtf8(key);
            })) {
                case (#ok(?entry)) {
                    {
                        ok = true;
                        error = "";
                        entry = ?stableNotesEntryFromStore(entry);
                        usage = null;
                    };
                };
                case (#ok(null)) {
                    {
                        ok = true;
                        error = "";
                        entry = null;
                        usage = null;
                    };
                };
                case (#err(error)) stableNotesFailure(stableStoreErrorText(error));
            };
        };

        public func /*update*/stable_notes_update(
            key : Text,
            value : Text,
            expectedRevision : Text,
        ) : StableNotesResult {
            let ?revision = stableNotesRevision(expectedRevision) else {
                return stableNotesFailure("Expected revision must be a Nat64 decimal string");
            };
            switch (stableStore.put({
                store = "notes";
                key = Text.encodeUtf8(key);
                value = Text.encodeUtf8(value);
                condition = #if_revision(revision);
            })) {
                case (#ok(receipt)) {
                    {
                        ok = true;
                        error = "";
                        entry = ?stableNotesEntry(key, value, receipt.revision, receipt.schema_version);
                        usage = ?stableNotesUsage(receipt.usage);
                    };
                };
                case (#err(error)) stableNotesFailure(stableStoreErrorText(error));
            };
        };

        public func /*query*/stable_notes_list(
            prefix : Text,
            continuing : Bool,
            cursorNamespaceUid : Text,
            cursorAfter : Text,
        ) : StableNotesPage {
            let cursor : ?NeutronCapabilities.StableStoreCursorV1 = if (continuing) {
                let ?namespaceUid = stableNotesRevision(cursorNamespaceUid) else {
                    return stableNotesPageFailure("Cursor namespace must be a Nat64 decimal string");
                };
                ?{
                    namespace_uid = namespaceUid;
                    prefix = Text.encodeUtf8(prefix);
                    after = Text.encodeUtf8(cursorAfter);
                };
            } else null;
            switch (stableStore.list({
                store = "notes";
                prefix = Text.encodeUtf8(prefix);
                cursor;
                limit = 2;
            })) {
                case (#ok(page)) {
                    let next = switch (page.next) {
                        case null (false, "", "");
                        case (?value) (
                            true,
                            Nat.toText(Nat64.toNat(value.namespace_uid)),
                            stableNotesText(value.after),
                        );
                    };
                    {
                        ok = true;
                        error = "";
                        entries = Array.map<NeutronCapabilities.StableStoreEntryV1, StableNotesEntry>(
                            page.entries,
                            stableNotesEntryFromStore,
                        );
                        has_more = next.0;
                        next_namespace_uid = next.1;
                        next_after = next.2;
                        observed_revision = Nat.toText(Nat64.toNat(page.observed_revision));
                    };
                };
                case (#err(error)) stableNotesPageFailure(stableStoreErrorText(error));
            };
        };

        public func /*query*/stable_notes_usage() : StableNotesResult {
            switch (stableStore.usage("notes")) {
                case (#ok(usage)) {
                    {
                        ok = true;
                        error = "";
                        entry = null;
                        usage = ?stableNotesUsage(usage);
                    };
                };
                case (#err(error)) stableNotesFailure(stableStoreErrorText(error));
            };
        };

        public func /*update*/stable_notes_delete(
            key : Text,
            expectedRevision : Text,
        ) : StableNotesResult {
            let ?revision = stableNotesRevision(expectedRevision) else {
                return stableNotesFailure("Expected revision must be a Nat64 decimal string");
            };
            switch (stableStore.delete({
                store = "notes";
                key = Text.encodeUtf8(key);
                expected_revision = ?revision;
            })) {
                case (#ok(usage)) {
                    {
                        ok = true;
                        error = "";
                        entry = null;
                        usage = ?stableNotesUsage(usage);
                    };
                };
                case (#err(error)) stableNotesFailure(stableStoreErrorText(error));
            };
        };

        public func /*update*/stable_notes_clear_page(prefix : Text) : StableNotesClearPage {
            switch (stableStore.clear_page({
                store = "notes";
                prefix = Text.encodeUtf8(prefix);
                limit = 2;
            })) {
                case (#ok(receipt)) {
                    {
                        ok = true;
                        error = "";
                        removed_entries = receipt.removed_entries;
                        removed_bytes = receipt.removed_bytes;
                        more = receipt.more;
                        usage = ?stableNotesUsage(receipt.usage);
                    };
                };
                case (#err(error)) {
                    {
                        ok = false;
                        error = stableStoreErrorText(error);
                        removed_entries = 0;
                        removed_bytes = 0;
                        more = false;
                        usage = null;
                    };
                };
            };
        };

        // A publication always traverses the ordered staging API. The kernel
        // allocates the opaque path and fixes the inline-text delivery policy.
        // The token supplies only idempotency nonces; it is not a path or
        // scope selector.
        public func /*update*/publish_publication(message : Text, token : Text) : Text {
            let body = Text.encodeUtf8(message);
            if (body.size() == 0 or body.size() > 2_048) {
                return rememberAssetEvent("Publication failed: body must contain 1..2,048 UTF-8 bytes");
            };
            let ?tokenBytes = assetToken(token) else {
                return rememberAssetEvent("Publication failed: token must encode to exactly 16 bytes");
            };
            let #ok(generation) = collectionGeneration("publication_demo") else {
                return rememberAssetEvent("Publication failed: collection is unavailable");
            };
            let beginResult = certifiedAssets.begin_stage({
                nonce = domainNonce(tokenBytes, 1);
                target = #allocate_publication({
                    collection = "publication_demo";
                    collection_generation = generation;
                    filename = "message.txt";
                    presentation = #inline_text;
                });
                expected_bytes = body.size();
            });
            let #ok(stage) = beginResult else {
                return rememberAssetEvent(
                    "Publication failed: " # certifiedAssetResultError(beginResult),
                );
            };
            let ?target = stage.identity.computed_target else {
                ignore certifiedAssets.abort_stage(stage.stage_id);
                return rememberAssetEvent("Publication failed: kernel did not allocate a target");
            };
            switch (certifiedAssets.stage_status(stage.stage_id)) {
                case (#err(error)) {
                    return rememberAssetEvent(
                        "Publication failed: " # certifiedAssetErrorText(error),
                    );
                };
                // A lost commit reply replays begin to the exact consumed
                // stage. Do not resend a chunk to terminal stage state; replay
                // the original commit fingerprint below.
                case (#ok(#consumed(_))) {};
                case (#ok(#active(_))) {
                    let chunkResult = certifiedAssets.put_chunk({
                        stage_id = stage.stage_id;
                        index = 0;
                        body;
                    });
                    let #ok(chunk) = chunkResult else {
                        ignore certifiedAssets.abort_stage(stage.stage_id);
                        return rememberAssetEvent(
                            "Publication failed: " # certifiedAssetResultError(chunkResult),
                        );
                    };
                    if (not chunk.complete) {
                        ignore certifiedAssets.abort_stage(stage.stage_id);
                        return rememberAssetEvent("Publication failed: the one-block stage is incomplete");
                    };
                };
                case (#ok(#aborted(_))) {
                    return rememberAssetEvent("Publication failed: stage was aborted");
                };
                case (#ok(#expired(_))) {
                    return rememberAssetEvent("Publication failed: stage expired");
                };
                case (#ok(#unknown)) {
                    return rememberAssetEvent("Publication failed: stage receipt is no longer available");
                };
            };
            let commitResult = certifiedAssets.commit_batch({
                nonce = domainNonce(tokenBytes, 2);
                operations = [
                    #put({
                        target;
                        condition = #absent;
                        body = #stage(stage.stage_id);
                    }),
                ];
                requires_present_after = [];
            });
            switch (commitResult) {
                case (#err(error)) {
                    ignore certifiedAssets.abort_stage(stage.stage_id);
                    rememberAssetEvent(
                        "Publication failed: " # certifiedAssetErrorText(error),
                    );
                };
                case (#ok(receipt)) {
                    let ?lifecycle = putLifecycle(receipt) else {
                        return rememberAssetEvent("Publication failed: kernel returned an invalid receipt");
                    };
                    let identity = lifecycle.committed;
                    rememberAssetEvent(
                        "Published staged fixture: " # publicationPath(identity.target) #
                        " (revision " # Nat.toText(Nat64.toNat(identity.kernel_revision)) #
                        ", " # Nat.toText(identity.body_bytes) # " bytes)",
                    );
                };
            };
        };

        // The browser supplies the same body/token pair used by publish. That
        // replays begin_stage, recovers the kernel-generated target, and then
        // performs an exact conditional revocation.
        public func /*update*/delete_publication(message : Text, token : Text) : Text {
            let body = Text.encodeUtf8(message);
            if (body.size() == 0 or body.size() > 2_048) {
                return rememberAssetEvent("Publication delete failed: original body must contain 1..2,048 UTF-8 bytes");
            };
            let ?tokenBytes = assetToken(token) else {
                return rememberAssetEvent("Publication delete failed: token must encode to exactly 16 bytes");
            };
            let #ok(generation) = collectionGeneration("publication_demo") else {
                return rememberAssetEvent("Publication delete failed: collection is unavailable");
            };
            let beginResult = certifiedAssets.begin_stage({
                nonce = domainNonce(tokenBytes, 1);
                target = #allocate_publication({
                    collection = "publication_demo";
                    collection_generation = generation;
                    filename = "message.txt";
                    presentation = #inline_text;
                });
                expected_bytes = body.size();
            });
            let #ok(stage) = beginResult else {
                return rememberAssetEvent(
                    "Publication delete failed: token/body mismatch (" #
                    certifiedAssetResultError(beginResult) # ")",
                );
            };
            let ?target = stage.identity.computed_target else {
                return rememberAssetEvent("Publication delete failed: target is unavailable");
            };
            switch (certifiedAssets.record_status(target)) {
                case (#err(error)) {
                    rememberAssetEvent("Publication delete failed: " # certifiedAssetErrorText(error));
                };
                case (#ok(#present(identity))) {
                    let deleteResult = certifiedAssets.commit_batch({
                        nonce = domainNonce(tokenBytes, 3);
                        operations = [
                            #delete({
                                target;
                                condition = {
                                    revision = identity.kernel_revision;
                                    content_tag = identity.content_tag;
                                };
                            }),
                        ];
                        requires_present_after = [];
                    });
                    switch (deleteResult) {
                        case (#ok(_)) rememberAssetEvent(
                            "Deleted staged fixture: " # publicationPath(target),
                        );
                        case (#err(error)) rememberAssetEvent(
                            "Publication delete failed: " # certifiedAssetErrorText(error),
                        );
                    };
                };
                case (#ok(#absent(_))) rememberAssetEvent("Publication delete failed: target is absent");
                case (#ok(#recently_deleted(_))) rememberAssetEvent(
                    "Deleted staged fixture: " # publicationPath(target) # " (replayed)",
                );
                case (#ok(#deleted_high_water(_))) rememberAssetEvent(
                    "Publication delete failed: target is retired",
                );
            };
        };

        // An immutable blob uses the same ordered staging engine. Once its
        // final chunk is accepted, the kernel derives its content-addressed
        // target from the exact body SHA-256 and commits it create-if-absent.
        public func /*update*/publish_immutable_blob(message : Text, token : Text) : Text {
            let body = Text.encodeUtf8(message);
            if (body.size() == 0 or body.size() > 2_048) {
                return rememberAssetEvent("Immutable blob failed: body must contain 1..2,048 UTF-8 bytes");
            };
            let ?tokenBytes = assetToken(token) else {
                return rememberAssetEvent("Immutable blob failed: token must encode to exactly 16 bytes");
            };
            let #ok(generation) = collectionGeneration("immutable_blob_demo") else {
                return rememberAssetEvent("Immutable blob failed: collection is unavailable");
            };
            let beginResult = certifiedAssets.begin_stage({
                nonce = domainNonce(tokenBytes, 4);
                target = #derive_body_sha256({
                    collection = "immutable_blob_demo";
                    collection_generation = generation;
                });
                expected_bytes = body.size();
            });
            let #ok(stage) = beginResult else {
                return rememberAssetEvent(
                    "Immutable blob failed: " # certifiedAssetResultError(beginResult),
                );
            };
            var computedTarget : ?NeutronCapabilities.Target = stage.identity.computed_target;
            switch (certifiedAssets.stage_status(stage.stage_id)) {
                case (#err(error)) {
                    return rememberAssetEvent(
                        "Immutable blob failed: " # certifiedAssetErrorText(error),
                    );
                };
                case (#ok(#consumed(terminal))) {
                    computedTarget := ?terminal.lifecycle.committed.target;
                };
                case (#ok(#active(_))) {
                    let chunkResult = certifiedAssets.put_chunk({
                        stage_id = stage.stage_id;
                        index = 0;
                        body;
                    });
                    let #ok(chunk) = chunkResult else {
                        ignore certifiedAssets.abort_stage(stage.stage_id);
                        return rememberAssetEvent(
                            "Immutable blob failed: " # certifiedAssetResultError(chunkResult),
                        );
                    };
                    if (not chunk.complete) {
                        ignore certifiedAssets.abort_stage(stage.stage_id);
                        return rememberAssetEvent("Immutable blob failed: the one-block stage is incomplete");
                    };
                    computedTarget := chunk.computed_target;
                };
                case (#ok(#aborted(_))) {
                    return rememberAssetEvent("Immutable blob failed: stage was aborted");
                };
                case (#ok(#expired(_))) {
                    return rememberAssetEvent("Immutable blob failed: stage expired");
                };
                case (#ok(#unknown)) {
                    return rememberAssetEvent("Immutable blob failed: stage receipt is no longer available");
                };
            };
            let ?target = computedTarget else {
                ignore certifiedAssets.abort_stage(stage.stage_id);
                return rememberAssetEvent("Immutable blob failed: digest target is unavailable");
            };
            switch (certifiedAssets.record_status(target)) {
                case (#ok(#present(identity))) {
                    ignore certifiedAssets.abort_stage(stage.stage_id);
                    return rememberAssetEvent(
                        "Immutable blob already exists: " # immutableBlobPath(identity.target) #
                        " (" # Nat.toText(identity.body_bytes) # " bytes)",
                    );
                };
                case (#ok(#absent(_))) {};
                case (#ok(#recently_deleted(_))) {
                    ignore certifiedAssets.abort_stage(stage.stage_id);
                    return rememberAssetEvent("Immutable blob failed: digest was deleted and is retired");
                };
                case (#ok(#deleted_high_water(_))) {
                    ignore certifiedAssets.abort_stage(stage.stage_id);
                    return rememberAssetEvent("Immutable blob failed: digest was deleted and is retired");
                };
                case (#err(error)) {
                    ignore certifiedAssets.abort_stage(stage.stage_id);
                    return rememberAssetEvent(
                        "Immutable blob failed: " # certifiedAssetErrorText(error),
                    );
                };
            };
            switch (certifiedAssets.commit_batch({
                nonce = domainNonce(tokenBytes, 5);
                operations = [
                    #put({
                        target;
                        condition = #absent;
                        body = #stage(stage.stage_id);
                    }),
                ];
                requires_present_after = [];
            })) {
                case (#err(error)) {
                    ignore certifiedAssets.abort_stage(stage.stage_id);
                    rememberAssetEvent(
                        "Immutable blob failed: " # certifiedAssetErrorText(error),
                    );
                };
                case (#ok(receipt)) {
                    let ?lifecycle = putLifecycle(receipt) else {
                        return rememberAssetEvent("Immutable blob failed: kernel returned an invalid receipt");
                    };
                    let identity = lifecycle.committed;
                    rememberAssetEvent(
                        "Published immutable blob: " # immutableBlobPath(identity.target) #
                        " (" # Nat.toText(identity.body_bytes) # " bytes)",
                    );
                };
            };
        };

        // A mutable blob uses one fixed 32-byte key and an inline Candid body.
        // Repeating this call with a fresh token performs exact revision/tag
        // CAS rather than a blind replacement.
        public func /*update*/put_mutable_blob(message : Text, token : Text) : Text {
            if (message.size() > 1_800) {
                return rememberAssetEvent("Mutable blob failed: message must be 1,800 characters or fewer");
            };
            let ?tokenBytes = assetToken(token) else {
                return rememberAssetEvent("Mutable blob failed: token must encode to exactly 16 bytes");
            };
            let #ok(generation) = collectionGeneration("mutable_blob_demo") else {
                return rememberAssetEvent("Mutable blob failed: collection is unavailable");
            };
            let target : NeutronCapabilities.Target = {
                collection = "mutable_blob_demo";
                collection_generation = generation;
                locator = #key32({ key = MUTABLE_BLOB_KEY });
            };
            let condition : NeutronCapabilities.Condition = switch (
                certifiedAssets.record_status(target)
            ) {
                case (#ok(#absent(_))) #absent;
                case (#ok(#present(identity))) #match({
                    revision = identity.kernel_revision;
                    content_tag = identity.content_tag;
                });
                case (#ok(#recently_deleted(_))) {
                    return rememberAssetEvent("Mutable blob failed: key was deleted and is retired");
                };
                case (#ok(#deleted_high_water(_))) {
                    return rememberAssetEvent("Mutable blob failed: key was deleted and is retired");
                };
                case (#err(error)) {
                    return rememberAssetEvent(
                        "Mutable blob failed: " # certifiedAssetErrorText(error),
                    );
                };
            };
            let body = to_candid ({
                schema = 1;
                message;
            } : MutableBlobDemoV1);
            if (body.size() > 2_048) {
                return rememberAssetEvent("Mutable blob failed: encoded Candid body exceeds 2,048 bytes");
            };
            switch (certifiedAssets.commit_batch({
                nonce = domainNonce(tokenBytes, 6);
                operations = [
                    #put({
                        target;
                        condition;
                        body = #inline(body);
                    }),
                ];
                requires_present_after = [];
            })) {
                case (#err(error)) rememberAssetEvent(
                    "Mutable blob failed: " # certifiedAssetErrorText(error),
                );
                case (#ok(receipt)) {
                    let ?lifecycle = putLifecycle(receipt) else {
                        return rememberAssetEvent("Mutable blob failed: kernel returned an invalid receipt");
                    };
                    let identity = lifecycle.committed;
                    rememberAssetEvent(
                        "Published inline/CAS mutable blob: " # mutableBlobPath() #
                        " (kernel revision " #
                        Nat.toText(Nat64.toNat(identity.kernel_revision)) # ")",
                    );
                };
            };
        };

        public func /*query*/asset_status() : Text {
            switch (certifiedAssets.scope_info()) {
                case (#err(error)) "Certified Assets unavailable: " # certifiedAssetErrorText(error);
                case (#ok(info)) {
                    var summary =
                        "installation generation " #
                        Nat.toText(Nat64.toNat(info.installation_generation)) #
                        ", store authority epoch " #
                        Nat.toText(Nat64.toNat(info.store_authority_epoch));
                    for (collection in info.collections.vals()) {
                        summary #= "; " # collection.id # " generation " #
                            Nat.toText(Nat64.toNat(collection.generation));
                    };
                    summary # ". Last backend event: " # boundedText(mem.lastMessage, 256);
                };
            };
        };

        public func /*query*/certified_assets_usage() : Text {
            switch (certifiedAssets.usage()) {
                case (#err(error)) "Certified Assets usage unavailable: " # certifiedAssetErrorText(error);
                case (#ok(usage)) {
                    let current = usage.current;
                    Nat.toText(current.live_entries) # " live / " #
                    Nat.toText(current.occupied_entry_slots) # " occupied entries; " #
                    Nat.toText(current.committed_body_bytes) # " committed body bytes; " #
                    Nat.toText(current.accepted_staged_bytes) # " accepted staged bytes; " #
                    Nat.toText(current.active_stages) # " active stages; " #
                    Nat.toText(current.receipt_lanes) # " receipt lanes";
                };
            };
        };

        let MUTABLE_BLOB_KEY : Blob = Blob.fromArray(Array.tabulate<Nat8>(32, func(index) {
            Nat8.fromNat(index);
        }));

        func assetToken(value : Text) : ?Blob {
            let encoded = Text.encodeUtf8(value);
            if (encoded.size() == 16) ?encoded else null;
        };

        func domainNonce(token : Blob, domain : Nat8) : Blob {
            let bytes = Blob.toArray(token);
            Blob.fromArray(Array.tabulate<Nat8>(16, func(index) {
                if (index == 0) bytes[0] ^ domain else bytes[index];
            }));
        };

        func collectionGeneration(collectionId : Text) : { #ok : Nat64; #err } {
            switch (certifiedAssets.scope_info()) {
                case (#err(_)) #err;
                case (#ok(info)) {
                    for (collection in info.collections.vals()) {
                        if (collection.id == collectionId) return #ok(collection.generation);
                    };
                    #err;
                };
            };
        };

        func putLifecycle(
            receipt : NeutronCapabilities.BatchReceipt,
        ) : ?NeutronCapabilities.LifecycleOutcome {
            if (receipt.operations.size() != 1) return null;
            switch (receipt.operations[0]) {
                case (#put(putReceipt)) ?putReceipt.lifecycle;
                case (#delete(_)) null;
            };
        };

        func publicationPath(target : NeutronCapabilities.Target) : Text {
            switch (target.locator) {
                case (#publication(locator)) {
                    "/app/kitchensink/_route/publication_demo/" #
                    hex(locator.publication_id) # "/" # locator.filename;
                };
                case (_) "(invalid publication target)";
            };
        };

        func immutableBlobPath(target : NeutronCapabilities.Target) : Text {
            switch (target.locator) {
                case (#body_sha256(locator)) {
                    "/app/kitchensink/_route/blob_demo/v1/immutable/" #
                    hex(locator.digest);
                };
                case (_) "(invalid immutable blob target)";
            };
        };

        func mutableBlobPath() : Text {
            "/app/kitchensink/_route/blob_demo/v1/mutable/" #
            hex(MUTABLE_BLOB_KEY);
        };

        func rememberAssetEvent(status : Text) : Text {
            mem.lastMessage := boundedText(status, 512);
            status;
        };

        func certifiedAssetResultError(result : { #ok : Any; #err : NeutronCapabilities.Error }) : Text {
            switch (result) {
                case (#ok(_)) "unexpected success";
                case (#err(error)) certifiedAssetErrorText(error);
            };
        };

        func certifiedAssetErrorText(error : NeutronCapabilities.Error) : Text {
            switch (error) {
                case (#invalid) "invalid request";
                case (#stale_scope) "capability source is gone";
                case (#stale_generation(info)) {
                    "collection generation is stale; current generation is " #
                    Nat.toText(Nat64.toNat(info.current));
                };
                case (#disabled) "public route or store is disabled";
                case (#frozen) "certified mutations are frozen";
                case (#not_found) "record or stage was not found";
                case (#retired_key) "mutable key is retired";
                case (#conflict(_)) "CAS or idempotency conflict";
                case (#quota) "certified-assets quota is exhausted";
                case (#receipt_full) "idempotency receipt capacity is exhausted";
                case (#aborted) "stage was aborted";
                case (#expired) "stage expired";
                case (#incomplete(info)) {
                    "stage is incomplete (" # Nat.toText(info.missing_blocks.size()) #
                    " missing blocks)";
                };
                case (#not_ready) "publication entropy is not ready";
                case (#generation_exhausted) "collection generation space is exhausted";
                case (#revision_exhausted) "record revision space is exhausted";
                case (#low_cycles) "certified mutation is paused because Neutron cycles are low";
                case (#busy) "certified-assets maintenance is busy";
            };
        };

        func stableNotesEntry(
            key : Text,
            value : Text,
            revision : Nat64,
            schemaVersion : Nat,
        ) : StableNotesEntry {
            {
                key;
                value;
                revision = Nat.toText(Nat64.toNat(revision));
                schema_version = schemaVersion;
            };
        };

        func stableNotesEntryFromStore(
            entry : NeutronCapabilities.StableStoreEntryV1,
        ) : StableNotesEntry {
            stableNotesEntry(
                stableNotesText(entry.key),
                stableNotesText(entry.value),
                entry.revision,
                entry.schema_version,
            );
        };

        func stableNotesText(value : Blob) : Text {
            switch (Text.decodeUtf8(value)) {
                case (?text) text;
                case null "0x" # hex(value);
            };
        };

        func stableNotesRevision(value : Text) : ?Nat64 {
            let ?parsed = Nat.fromText(value) else return null;
            if (parsed > MAX_NAT64) return null;
            ?Nat.toNat64(parsed);
        };

        func stableNotesUsage(
            usage : NeutronCapabilities.StableStoreUsageV1,
        ) : StableNotesUsage {
            {
                entries = usage.entries;
                bytes = usage.bytes;
                max_entries = usage.max_entries;
                max_bytes = usage.max_bytes;
                over_quota = usage.over_quota;
                schema_version = usage.schema_version;
            };
        };

        func stableNotesFailure(error : Text) : StableNotesResult {
            { ok = false; error; entry = null; usage = null };
        };

        func stableNotesPageFailure(error : Text) : StableNotesPage {
            {
                ok = false;
                error;
                entries = [];
                has_more = false;
                next_namespace_uid = "";
                next_after = "";
                observed_revision = "0";
            };
        };

        func stableStoreErrorText(
            error : NeutronCapabilities.StableStoreErrorV1,
        ) : Text {
            switch (error) {
                case (#source_gone) "The Kitchen Sink installation changed; reload before retrying";
                case (#not_declared) "The notes store is not declared by this installation";
                case (#disabled) "Stable Store is disabled in Neutron settings";
                case (#invalid_request) "The store request is invalid";
                case (#too_large) "The UTF-8 key or value exceeds the notes store ceiling";
                case (#quota_exceeded) "The notes store quota is exhausted";
                case (#not_found) "The note does not exist";
                case (#conflict(info)) switch (info.current_revision) {
                    case (?revision) "Revision conflict: the current revision is " # Nat.toText(Nat64.toNat(revision));
                    case null "Revision conflict: the note no longer exists";
                };
                case (#low_cycles) "Stable growth is paused because Neutron cycles are low";
                case (#not_replicated) "Stable mutations require a replicated update call";
                case (#revision_exhausted) "The stable-store revision space is exhausted";
                case (#cursor_stale) "This page cursor is stale; start again from the first page";
            };
        };

        func randomnessErrorText(error : NeutronCapabilities.RandomnessErrorV1) : Text {
            switch (error) {
                case (#busy) "Randomness service is busy";
                case (#low_cycles) "Randomness is unavailable because cycles are low";
                case (#management_failure) "The consensus randomness request failed";
                case (#source_gone) "The randomness capability is no longer available";
            };
        };

        func emptyChainKeyPublicDemo(error : Text) : ChainKeyPublicDemo {
            {
                ok = false;
                error = error;
                slot = "receipt_assertions";
                algorithm = "ecdsa_secp256k1";
                public_key_hex = "";
                key_fingerprint_hex = "";
                signing_domain_hex = "";
                namespace_version = 0;
                message_format = "neutron_app_assertion_v1";
            };
        };

        func emptyChainKeySignatureDemo(error : Text) : ChainKeySignatureDemo {
            {
                ok = false;
                error = error;
                assertion_text = RECEIPT_ASSERTION;
                slot = "receipt_assertions";
                algorithm = "ecdsa_secp256k1";
                digest_hex = "";
                signature_hex = "";
                signing_domain_hex = "";
                message_format = "neutron_app_assertion_v1";
            };
        };

        func chainKeyAlgorithmText(
            algorithm : NeutronCapabilities.ChainKeyAlgorithmV1,
        ) : Text {
            switch (algorithm) {
                case (#ecdsa_secp256k1) "ecdsa_secp256k1";
                case (#schnorr_bip340secp256k1) "schnorr_bip340secp256k1";
                case (#schnorr_ed25519) "schnorr_ed25519";
            };
        };

        func chainKeyMessageFormatText(
            format : NeutronCapabilities.ChainKeyMessageFormatV1,
        ) : Text {
            switch (format) {
                case (#neutron_app_assertion_v1) "neutron_app_assertion_v1";
            };
        };

        func chainKeyErrorText(
            error : NeutronCapabilities.ChainKeySigningErrorV1,
        ) : Text {
            switch (error) {
                case (#invalid_request) "The assertion request is invalid";
                case (#not_declared) "The receipt assertion slot is not declared";
                case (#disabled) "Receipt assertion signing is disabled in Neutron settings";
                case (#busy) "The chain-key service is busy";
                case (#cost_too_high) "The threshold-key quote exceeds Neutron's per-call cost ceiling";
                case (#low_cycles) "Chain-key signing is unavailable because Neutron cycles are low";
                case (#key_unavailable) "The configured threshold key is unavailable on this network";
                case (#management_failure) "The threshold-key request failed";
                case (#outcome_unknown) "The signing outcome is unknown; this demo will not retry automatically";
                case (#source_gone) "The Kitchen Sink installation changed while the request was running";
                case (#revoked_after_dispatch) "Signing authority was revoked after dispatch; no signature is returned, but the threshold operation may already have produced one";
            };
        };

        func bumpCounter(step : Nat) : Bool {
            if (step > MAX_COUNTER_STEP or mem.counter >= MAX_COUNTER) return false;
            let next = mem.counter + step;
            if (next > MAX_COUNTER) return false;
            mem.counter := next;
            true;
        };

        func safeTextPreview(value : Blob, limit : Nat) : Text {
            switch (Text.decodeUtf8(value)) {
                case (?decoded) boundedSafeText(decoded, limit);
                case null {
                    let byteLimit = if (limit > 2) Nat.sub(limit, 2) / 2 else 0;
                    "0x" # hexPrefix(value, byteLimit);
                };
            };
        };

        func boundedSafeText(value : Text, byteLimit : Nat) : Text {
            var result = "";
            var bytes = 0;
            for (char in value.chars()) {
                let code = Char.toNat32(char);
                let part = if (char == '\n') {
                    "\\n";
                } else if (char == '\r') {
                    "\\r";
                } else if (char == '\t') {
                    "\\t";
                } else if (char == '\\') {
                    "\\\\";
                } else if (
                    code < 32 or
                    (code >= 127 and code <= 159) or
                    (code >= 0x200B and code <= 0x200F) or
                    (code >= 0x202A and code <= 0x202E) or
                    (code >= 0x2060 and code <= 0x206F) or
                    code == 0xFEFF
                ) {
                    "?";
                } else {
                    Char.toText(char);
                };
                let partBytes = Text.encodeUtf8(part).size();
                if (bytes + partBytes > byteLimit) return result;
                result #= part;
                bytes += partBytes;
            };
            result;
        };

        func hex(bytes : Blob) : Text {
            var result = "";
            for (byte in bytes.vals()) {
                let value = Nat8.toNat(byte);
                result #= hexDigit(value / 16);
                result #= hexDigit(value % 16);
            };
            result;
        };

        func hexPrefix(bytes : Blob, limit : Nat) : Text {
            var result = "";
            var count = 0;
            label scanning for (byte in bytes.vals()) {
                if (count >= limit) break scanning;
                let value = Nat8.toNat(byte);
                result #= hexDigit(value / 16);
                result #= hexDigit(value % 16);
                count += 1;
            };
            result;
        };

        func hexDigit(value : Nat) : Text {
            switch (value) {
                case (0) "0";
                case (1) "1";
                case (2) "2";
                case (3) "3";
                case (4) "4";
                case (5) "5";
                case (6) "6";
                case (7) "7";
                case (8) "8";
                case (9) "9";
                case (10) "a";
                case (11) "b";
                case (12) "c";
                case (13) "d";
                case (14) "e";
                case (_) "f";
            };
        };

        func boundedText(value : Text, limit : Nat) : Text {
            if (value.size() <= limit) value else Text.fromIter(Iter.take(value.chars(), limit));
        };

    };


/*---NEUTRON GENERATED BEGIN---*/

public type public_status_Input = ();
public type public_status_Output = Text;

public type read_profile_Input = ();
public type read_profile_Output = Text;

public type save_profile_Input = (name : Text, email : Text, notes : Text, subscribed : Bool);
public type save_profile_Output = Text;

public type echo_Input = (message : Text);
public type echo_Output = Text;

public type add_Input = (left : Int, right : Int);
public type add_Output = Int;

public type bump_counter_Input = (step : Nat);
public type bump_counter_Output = Nat;

public type read_counter_Input = ();
public type read_counter_Output = Nat;

public type random_bytes_Input = ();
public type random_bytes_Output = Text;

public type chain_key_public_key_Input = ();
public type chain_key_public_key_Output = ChainKeyPublicDemo;

public type chain_key_sign_receipt_Input = ();
public type chain_key_sign_receipt_Output = ChainKeySignatureDemo;

public type https_example_Input = (method : Text);
public type https_example_Output = Text;

public type backend_probe_Input = (target : Principal);
public type backend_probe_Output = Text;

public type scheduled_tick_Input = (());
public type scheduled_tick_Output = ();

public type scheduled_status_Input = ();
public type scheduled_status_Output = ScheduledStatus;

public type dependency_status_Input = ();
public type dependency_status_Output = DependencyStatus;

public type function_resource_snapshot_Input = (());
public type function_resource_snapshot_Output = FunctionResourceSnapshot;

public type stable_notes_create_Input = (key : Text, value : Text);
public type stable_notes_create_Output = StableNotesResult;

public type stable_notes_load_Input = (key : Text);
public type stable_notes_load_Output = StableNotesResult;

public type stable_notes_update_Input = (key : Text,
            value : Text,
            expectedRevision : Text,);
public type stable_notes_update_Output = StableNotesResult;

public type stable_notes_list_Input = (prefix : Text,
            continuing : Bool,
            cursorNamespaceUid : Text,
            cursorAfter : Text,);
public type stable_notes_list_Output = StableNotesPage;

public type stable_notes_usage_Input = ();
public type stable_notes_usage_Output = StableNotesResult;

public type stable_notes_delete_Input = (key : Text,
            expectedRevision : Text,);
public type stable_notes_delete_Output = StableNotesResult;

public type stable_notes_clear_page_Input = (prefix : Text);
public type stable_notes_clear_page_Output = StableNotesClearPage;

public type publish_publication_Input = (message : Text, token : Text);
public type publish_publication_Output = Text;

public type delete_publication_Input = (message : Text, token : Text);
public type delete_publication_Output = Text;

public type publish_immutable_blob_Input = (message : Text, token : Text);
public type publish_immutable_blob_Output = Text;

public type put_mutable_blob_Input = (message : Text, token : Text);
public type put_mutable_blob_Output = Text;

public type asset_status_Input = ();
public type asset_status_Output = Text;

public type certified_assets_usage_Input = ();
public type certified_assets_usage_Output = Text;

/*---NEUTRON GENERATED END---*/
}
