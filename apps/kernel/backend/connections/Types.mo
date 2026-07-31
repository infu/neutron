import Map "mo:core/Map";
import CapabilityTypes "../capabilities/Types";

module {
    public type AppScope = CapabilityTypes.AppScope;

    public type FlowStatus = {
        #pending;
        #exchanging;
    };

    // Compiler-authored, exact connection authority for one installed app
    // scope. Provider ids are unique within a declaration. Connections have
    // one access mode: the declaring resident receives the credential.
    public type ProviderDeclaration = {
        provider : Text;
        scopes : [Text];
    };

    public type Declaration = {
        providers : [ProviderDeclaration];
    };

    public type AppDeclaration = {
        app_scope : AppScope;
        connections : ?Declaration;
    };

    public type OAuthFlow = {
        flow_id_hash : Blob;
        owner_principal : Principal;
        owner_scope : AppScope;
        provider : Text;
        declaration_scopes : [Text];
        pkce_verifier : Text;
        callback_url : Text;
        created_at : Nat64;
        expires_at : Nat64;
        status : FlowStatus;
    };

    public type Connection = {
        owner_scope : AppScope;
        provider : Text;
        declaration_scopes : [Text];
        credential : Text;
        created_at : Nat64;
    };

    public type Memory = {
        flows : Map.Map<Blob, OAuthFlow>;
        connections : Map.Map<Text, Connection>;
    };

    public type ExchangeSuccess = {
        credential : Text;
        charged_cycles : Nat;
    };

    public type ExchangeFailure = {
        message : Text;
        charged_cycles : Nat;
    };

    public type ExchangeResult = {
        #ok : ExchangeSuccess;
        #err : ExchangeFailure;
    };

    public type ConnectionSummary = {
        app_id : Text;
        installation_uid : Nat64;
        provider : Text;
        created_at : Nat64;
    };

    public type BeginConnectionInput = {
        app_id : Text;
        provider : Text;
        callback_base : Text;
    };

    public type BeginConnectionResult = {
        flow_id : Text;
        provider : Text;
        authorization_url : Text;
        expires_at : Nat64;
    };

    public type CompleteConnectionInput = {
        flow_id : Text;
        code : Text;
    };

    public type ListConnectionsInput = {
        app_id : Text;
        provider : ?Text;
    };

    public type ConnectionInput = {
        app_id : Text;
        provider : Text;
    };

    public type SensitiveCredential = {
        provider : Text;
        credential : Text;
    };
};
