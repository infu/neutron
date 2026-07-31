import Caps "mo:neutron-capabilities";
import CapabilityTypes "../capabilities/Types";
import IC "../aaa_interface";

module {
    public type Method = { #get; #head; #post };
    public type Transform = { #strip_headers };

    // Compiler-authored declaration ceiling. The URL prefix, methods, request
    // header names, transport bounds, and transform are all
    // fixed before an app receives its attenuated handle.
    public type EndpointDeclaration = {
        id : Text;
        url_prefix : Text;
        methods : [Method];
        request_headers : [Text];
        max_request_bytes : Nat;
        max_response_bytes : Nat;
        transform : Transform;
    };

    public type Declaration = {
        endpoints : [EndpointDeclaration];
    };

    public type AppDeclaration = {
        app_scope : CapabilityTypes.AppScope;
        https_outcalls : ?Declaration;
    };

    public type Request = Caps.HttpsOutcallRequestV1;
    public type Error = Caps.HttpsOutcallErrorV1;
    public type Response = Caps.HttpsOutcallResponseV1;
    public type Result = Caps.HttpsOutcallResultV1;
    public type Capability = Caps.HttpsOutcallsV1;

    public type AdapterRequest = {
        url : Text;
        method : Method;
        headers : [IC.http_header];
        body : Blob;
        max_response_bytes : Nat64;
        transform_context : Blob;
        cycles : Nat;
    };

    public type AdapterResponse = {
        response : IC.http_request_result;
        charged_cycles : Nat;
    };

    public type AdapterFailure = {
        charged_cycles : Nat;
    };

    public type AdapterResult = {
        #ok : AdapterResponse;
        #err : AdapterFailure;
    };

    public type Adapter = {
        quote : (Nat64, Nat64) -> Nat;
        cycle_balance : () -> Nat;
        request : AdapterRequest -> async AdapterResult;
    };

    // The assembler supplies only this narrowed self reference. App code
    // never receives it and cannot select a callback or transform context.
    public type TransformActor = actor {
        kernel_https_outcall_transform : shared query IC.http_transform_args -> async IC.http_request_result;
    };
}
