import Map "mo:core/Map";
import CapabilityTypes "../capabilities/Types";

module {
    public type AppScope = CapabilityTypes.AppScope;

    public type StoreDeclaration = {
        id : Text;
        purpose : Text;
        schema_version : Nat;
        max_entries : Nat;
        max_key_bytes : Nat;
        max_value_bytes : Nat;
        max_bytes : Nat;
    };

    public type Declaration = { stores : [StoreDeclaration] };
    public type AppDeclaration = {
        app_scope : AppScope;
        stable_store : ?Declaration;
    };

    public type Condition = {
        #unconditional;
        #if_absent;
        #if_revision : Nat64;
    };

    public type Cursor = {
        namespace_uid : Nat64;
        prefix : Blob;
        after : Blob;
    };

    public type Entry = {
        key : Blob;
        value : Blob;
        revision : Nat64;
        schema_version : Nat;
    };

    public type StoredEntry = {
        value : Blob;
        revision : Nat64;
        schema_version : Nat;
    };

    public type Usage = {
        store : Text;
        schema_version : Nat;
        entries : Nat;
        bytes : Nat;
        max_entries : Nat;
        max_bytes : Nat;
        over_quota : Bool;
    };

    public type Error = {
        #source_gone;
        #not_declared;
        #disabled;
        #invalid_request;
        #too_large;
        #quota_exceeded;
        #not_found;
        #conflict : { current_revision : ?Nat64 };
        #low_cycles;
        #not_replicated;
        #revision_exhausted;
        #cursor_stale;
    };

    public type GetInput = { store : Text; key : Blob };
    public type PutInput = {
        store : Text;
        key : Blob;
        value : Blob;
        condition : Condition;
    };
    public type DeleteInput = {
        store : Text;
        key : Blob;
        expected_revision : ?Nat64;
    };
    public type ListInput = {
        store : Text;
        prefix : Blob;
        cursor : ?Cursor;
        limit : Nat;
    };
    public type ClearPageInput = {
        store : Text;
        prefix : Blob;
        limit : Nat;
    };

    public type PutReceipt = {
        revision : Nat64;
        schema_version : Nat;
        usage : Usage;
    };
    public type Page = {
        entries : [Entry];
        next : ?Cursor;
        observed_revision : Nat64;
    };
    public type ClearPageReceipt = {
        removed_entries : Nat;
        removed_bytes : Nat;
        more : Bool;
        usage : Usage;
    };

    public type Result<T> = { #ok : T; #err : Error };
    public type GetResult = Result<?Entry>;
    public type PutResult = Result<PutReceipt>;
    public type DeleteResult = Result<Usage>;
    public type ListResult = Result<Page>;
    public type UsageResult = Result<Usage>;
    public type ClearPageResult = Result<ClearPageReceipt>;

    public type Capability = {
        get : GetInput -> GetResult;
        put : PutInput -> PutResult;
        delete : DeleteInput -> DeleteResult;
        list : ListInput -> ListResult;
        usage : Text -> UsageResult;
        clear_page : ClearPageInput -> ClearPageResult;
    };

    public type UsageTotals = { entries : Nat; bytes : Nat };

    // Purpose is deliberately absent. It is untrusted presentation text and
    // never changes storage identity, retention, accounting, or authority.
    public type StoreState = {
        scope : AppScope;
        id : Text;
        namespace_uid : Nat64;
        var schema_version : Nat;
        var max_entries : Nat;
        var max_key_bytes : Nat;
        var max_value_bytes : Nat;
        var max_bytes : Nat;
        var entries : Map.Map<Blob, StoredEntry>;
        var bytes : Nat;
        var oversized_entries : Nat;
        var observed_revision : Nat64;
    };

    public type Memory = {
        var next_namespace_uid : Nat64;
        var next_revision : Nat64;
        stores : Map.Map<Text, StoreState>;
        usage_by_scope : Map.Map<Text, UsageTotals>;
        var total_entries : Nat;
        var total_bytes : Nat;
    };
};
