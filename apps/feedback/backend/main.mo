import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Capabilities "mo:neutron-capabilities";
import Config "./config";
import Memory "./memory/state/v1";

module {
    public type State = { seed : ?Blob; owner : Principal };
    public type Draft = { id : Text; value : Blob };
    public type DraftPageRequest = { cursor : ?Text; limit : Nat };
    public type DraftPage = { items : [Draft]; nextCursor : ?Text };
    public type Call = { method : Text; args : Blob };
    public type StateResult = { #ok : State; #err : Text };
    public type TextResult = { #ok : Text; #err : Text };
    public type BlobResult = { #ok : Blob; #err : Text };
    public type AppBackendEnvironment = {
        stable_memory : { state : Memory.Mem };
        capabilities : { backend_calls : Capabilities.BackendCallsV1 };
    };

    // Reads use the registered browser identity directly. Moderator assignment
    // belongs to the protocol administrator and is not an application action.
    public func allowed(method : Text) : Bool {
        switch (method) {
            case ("read_delegate_set" or "thread_create" or "reply" or "moderation_reply" or "mark_read" or "issue_status_set") true;
            case (_) false;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.state;
        let calls = env.capabilities.backend_calls;
        let protocol = Principal.fromText(Config.PROTOCOL_CANISTER);

        func snapshot() : State { { seed = mem.seed; owner = calls.canister_principal } };

        public func /*query*/ feedback_state(()) : State { snapshot() };

        public func /*update*/ feedback_initialize(seed : Blob) : StateResult {
            if (Blob.size(seed) != 32) return #err("The browser read key must contain 32 bytes.");
            if (mem.seed == null) mem.seed := ?seed;
            #ok(snapshot());
        };

        public func /*query*/ feedback_draft(id : Text) : ?Blob {
            switch (Map.get(mem.drafts, Text.compare, id)) {
                case null null;
                case (?value) ?Text.encodeUtf8(value);
            };
        };

        public func /*query*/ feedback_drafts(request : DraftPageRequest) : DraftPage {
            let items = List.empty<Draft>();
            var last : ?Text = null;
            let entries = switch (request.cursor) {
                case null Map.entries(mem.drafts);
                case (?cursor) Map.entriesFrom(mem.drafts, Text.compare, cursor);
            };
            for ((id, value) in entries) {
                if (request.cursor != ?id) {
                    if (List.size(items) >= request.limit) return { items = List.toArray(items); nextCursor = last };
                    List.add(items, { id; value = Text.encodeUtf8(value) });
                    last := ?id;
                };
            };
            { items = List.toArray(items); nextCursor = null };
        };

        // Persist the exact intent before a protocol update so a lost response
        // can be reconciled with the same operation ID and original payload.
        public func /*update*/ feedback_save_draft(request : Draft) : TextResult {
            let value = switch (Text.decodeUtf8(request.value)) {
                case null return #err("The saved request is not valid UTF-8.");
                case (?text) text;
            };
            switch (Map.get(mem.drafts, Text.compare, request.id)) {
                case (?saved) {
                    if (saved != value) return #err("This operation ID already belongs to a different saved request.");
                    #ok(request.id);
                };
                case null {
                    Map.add(mem.drafts, Text.compare, request.id, value);
                    #ok(request.id);
                };
            };
        };

        // Once the protocol confirms a mutation, its permanent deduplication
        // record handles retries. Remove only that exact local pending intent.
        public func /*update*/ feedback_complete_draft(request : Draft) : TextResult {
            switch (Map.get(mem.drafts, Text.compare, request.id)) {
                case null #ok(request.id);
                case (?saved) {
                    if (Text.encodeUtf8(saved) != request.value) return #err("The saved request does not match this completed operation.");
                    Map.remove(mem.drafts, Text.compare, request.id);
                    #ok(request.id);
                };
            };
        };

        public func /*update*/ feedback_call(request : Call) : async* BlobResult {
            if (not allowed(request.method)) return #err("This is not a Feedback update method.");
            switch (await* calls.call({ canister = protocol; method = request.method; args = request.args; cycles = 0 })) {
                case (#ok(reply)) #ok(reply);
                case (#err(error)) #err(error.code # ": " # error.message);
            };
        };
    };

/*---NEUTRON GENERATED BEGIN---*/

public type feedback_state_Input = (());
public type feedback_state_Output = State;

public type feedback_initialize_Input = (seed : Blob);
public type feedback_initialize_Output = StateResult;

public type feedback_draft_Input = (id : Text);
public type feedback_draft_Output = ?Blob;

public type feedback_drafts_Input = (request : DraftPageRequest);
public type feedback_drafts_Output = DraftPage;

public type feedback_save_draft_Input = (request : Draft);
public type feedback_save_draft_Output = TextResult;

public type feedback_complete_draft_Input = (request : Draft);
public type feedback_complete_draft_Output = TextResult;

public type feedback_call_Input = (request : Call);
public type feedback_call_Output = BlobResult;

/*---NEUTRON GENERATED END---*/
};
