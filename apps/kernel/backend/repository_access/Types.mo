module {
    // Repository protocol V1. The source owns entitlement and fee policy;
    // the Kernel only authenticates its owner and transports this request.
    public type Request = {
        request_id : Text;
        token : Text;
        paths : [Text];
        fee_version : Nat;
    };

    public type AccessResult = {
        #ok : {
            request_id : Text;
            paths : [Text];
            accepted_cycles : Nat;
        };
        #err : { code : Text; message : Text };
    };

    public type Input = {
        source : Principal;
        cycles : Nat;
        request : Request;
    };

    public type Source = actor {
        repo_access_v1 : shared Request -> async AccessResult;
    };

    public type TransportResult = {
        #ok : { reply : AccessResult; charged_cycles : Nat };
        #err : { charged_cycles : ?Nat };
    };

    public type Transport = Input -> async TransportResult;

    public type Output = {
        result : AccessResult;
        // Actual attached cycles retained by the source, after IC refunds.
        // This is distinct from the source's reported accepted_cycles and
        // excludes the IC's inter-canister transport fee. A native rejection
        // does not preserve the refund in Motoko, so its charge is unknown.
        charged_cycles : ?Nat;
    };
};
