import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Text "mo:core/Text";
import Principal "mo:core/Principal";
import Capabilities "mo:neutron-capabilities";
import Memory "./memory/state/v1";

module {
    public type State = { seed : ?Blob; canister : ?Principal; host : Text; owner : Principal; revision : Nat };
    public type Configure = { canister : Principal; host : Text };
    public type Draft = { id : Text; value : Blob };
    public type DraftRevision = { id : Text; expected : Blob; value : Blob; revision : Text };
    public type DraftPageRequest = { cursor : ?Text; limit : Nat };
    public type DraftPage = { items : [{ id : Text; value : Blob }]; nextCursor : ?Text };
    public type Call = { canister : Principal; method : Text; args : Blob; cycles : Nat };
    public type StateResult = { #ok : State; #err : Text };
    public type TextResult = { #ok : Text; #err : Text };
    public type BlobResult = { #ok : Blob; #err : Text };
    public type AppBackendEnvironment = {
        stable_memory : { state : Memory.Mem };
        capabilities : { backend_calls : Capabilities.BackendCallsV1 };
    };
    // Explicit mutation contract. Reads never use this broker.
    public func allowed(method : Text) : Bool {
        switch (method) {
            case ("read_delegate_set" or "purchase" or "withdraw" or "referral_get_or_create" or "rating_set" or "listing_save" or "upload_begin" or "upload_chunk" or "upload_finish" or "candidate_submit" or "install_prepare" or "ethereum_prepare" or "ethereum_verify" or "ethereum_settle" or "ethereum_cancel" or "admin_auditor_set" or "admin_reserve_app" or "admin_set_burn_account" or "rates_refresh") true;
            case (_) false;
        };
    };
    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.state;
        let calls = env.capabilities.backend_calls;
        func snapshot() : State { { seed = mem.seed; canister = mem.canister; host = mem.host; owner = calls.canister_principal; revision = mem.revision } };
        public func /*query*/ marketplace_state(()) : State { snapshot() };
        public func /*update*/ marketplace_initialize(seed : Blob) : StateResult {
            if (Blob.size(seed) != 32) return #err("The browser read key must contain 32 bytes.");
            if (mem.seed == null) { mem.seed := ?seed; mem.revision += 1 };
            #ok(snapshot());
        };
        public func /*update*/ marketplace_configure(request : Configure) : StateResult {
            if (Principal.isAnonymous(request.canister)) return #err("Select the marketplace protocol canister.");
            if (request.host == "") return #err("Select the replica host.");
            mem.canister := ?request.canister; mem.host := request.host; mem.revision += 1;
            #ok(snapshot());
        };
        public func /*query*/ marketplace_draft(id : Text) : ?Blob {
            switch (Map.get(mem.drafts, Text.compare, id)) { case null null; case (?value) ?Text.encodeUtf8(value) };
        };
        public func /*query*/ marketplace_drafts(request : DraftPageRequest) : DraftPage {
            let items = List.empty<{ id : Text; value : Blob }>();
            var last : ?Text = null;
            let entries = switch (request.cursor) { case null Map.entries(mem.drafts); case (?cursor) Map.entriesFrom(mem.drafts, Text.compare, cursor) };
            for ((id, value) in entries) {
                if (request.cursor != ?id) {
                    if (List.size(items) >= request.limit) return { items = List.toArray(items); nextCursor = last };
                    List.add(items, { id; value = Text.encodeUtf8(value) });
                    last := ?id;
                };
            };
            { items = List.toArray(items); nextCursor = null };
        };
        public func /*update*/ marketplace_save_draft(request : Draft) : TextResult {
            let value = switch (Text.decodeUtf8(request.value)) { case null return #err("The saved intent is not valid UTF-8."); case (?text) text };
            switch (Map.get(mem.drafts, Text.compare, request.id)) {
                case (?saved) { if (saved != value) return #err("This operation ID already belongs to a different saved intent."); #ok(request.id) };
                case null { Map.add(mem.drafts, Text.compare, request.id, value); #ok(request.id) };
            };
        };
        public func /*update*/ marketplace_revise_draft(request : DraftRevision) : TextResult {
            let expected = switch (Text.decodeUtf8(request.expected)) { case null return #err("The previous intent is not valid UTF-8."); case (?value) value };
            let value = switch (Text.decodeUtf8(request.value)) { case null return #err("The revised intent is not valid UTF-8."); case (?value) value };
            let saved = switch (Map.get(mem.drafts, Text.compare, request.id)) { case null return #err("The original intent is unavailable."); case (?value) value };
            if (saved == value) return #ok(request.id);
            if (saved != expected) return #err("The saved operation changed. Read its current status before reviewing again.");
            if (request.revision == "") return #err("A revision identity is required.");
            let historyId = "history:" # request.id # ":" # request.revision;
            switch (Map.get(mem.drafts, Text.compare, historyId)) { case (?prior) { if (prior != saved) return #err("The revision already identifies different previous terms.") }; case null {} };
            Map.add(mem.drafts, Text.compare, historyId, saved);
            Map.add(mem.drafts, Text.compare, request.id, value);
            #ok(request.id);
        };
        public func /*update*/ marketplace_call(request : Call) : async* BlobResult {
            switch (mem.canister) {
                case (?selected) { if (selected != request.canister) return #err("The marketplace changed. Resume this request using its original protocol.") };
                case null return #err("Configure the marketplace protocol first.");
            };
            if (not allowed(request.method)) return #err("This is not a marketplace update method.");
            switch (await* calls.call(request)) {
                case (#ok(reply)) #ok(reply);
                case (#err(error)) #err(error.code # ": " # error.message);
            };
        };
    };
/*---NEUTRON GENERATED BEGIN---*/

public type marketplace_state_Input = (());
public type marketplace_state_Output = State;

public type marketplace_initialize_Input = (seed : Blob);
public type marketplace_initialize_Output = StateResult;

public type marketplace_configure_Input = (request : Configure);
public type marketplace_configure_Output = StateResult;

public type marketplace_draft_Input = (id : Text);
public type marketplace_draft_Output = ?Blob;

public type marketplace_drafts_Input = (request : DraftPageRequest);
public type marketplace_drafts_Output = DraftPage;

public type marketplace_save_draft_Input = (request : Draft);
public type marketplace_save_draft_Output = TextResult;

public type marketplace_revise_draft_Input = (request : DraftRevision);
public type marketplace_revise_draft_Output = TextResult;

public type marketplace_call_Input = (request : Call);
public type marketplace_call_Output = BlobResult;

/*---NEUTRON GENERATED END---*/
};
