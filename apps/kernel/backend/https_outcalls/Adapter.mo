import Cycles "mo:core/Cycles";
import Nat64 "mo:core/Nat64";
import Prim "mo:prim";
import Principal "mo:core/Principal";
import IC "../aaa_interface";
import Types "Types";

module {
    public let TRANSFORM_METHOD = "kernel_https_outcall_transform";
    let EMPTY_BLOB : Blob = "";
    // costHttpRequest accounts for the textual transform callback and context
    // in addition to the URL, request headers, and body. Keep a deliberately
    // conservative fixed allowance so a future wire-encoding change cannot
    // make the broker under-attach cycles for a declaration at its ceiling.
    public let QUOTE_REQUEST_OVERHEAD_BYTES : Nat = 512;

    public func management(self : Types.TransformActor) : Types.Adapter {
        {
            quote = Prim.costHttpRequest;
            cycle_balance = Cycles.balance;
            request = func(request : Types.AdapterRequest) : async Types.AdapterResult {
                try {
                    let response = await (with cycles = request.cycles) IC.management.http_request({
                        url = request.url;
                        max_response_bytes = ?request.max_response_bytes;
                        method = managementMethod(request.method);
                        headers = request.headers;
                        body = switch (request.method) {
                            case (#post) ?request.body;
                            case (#get) null;
                            case (#head) null;
                        };
                        transform = ?{
                            function = self.kernel_https_outcall_transform;
                            context = request.transform_context;
                        };
                        // V1 deliberately excludes the experimental weak-
                        // integrity single-replica mode.
                        is_replicated = ?true;
                    });
                    #ok({
                        response;
                        charged_cycles = charged(request.cycles);
                    });
                } catch (_) {
                    // Raw management reject text can contain remote details
                    // and is never part of the app-facing capability.
                    #err({ charged_cycles = charged(request.cycles) });
                };
            };
        };
    };

    func managementMethod(method : Types.Method) : IC.http_method {
        switch (method) {
            case (#get) #get;
            case (#head) #head;
            case (#post) #post;
        };
    };

    func charged(attached : Nat) : Nat {
        let refunded = Cycles.refunded();
        if (refunded >= attached) 0 else attached - refunded;
    };

    // Exact formal input to ic0.cost_http_request. Every textual component is
    // ASCII in V1 except query values, whose UTF-8 byte lengths are counted by
    // Service before calling this helper.
    public func conservativeRequestSize(
        declaredMaxRequestBytes : Nat,
    ) : Nat64 {
        Nat64.fromNat(
            declaredMaxRequestBytes + QUOTE_REQUEST_OVERHEAD_BYTES
        );
    };

    public func transform(
        args : IC.http_transform_args,
    ) : IC.http_request_result {
        assert (validTransformContext(args.context));
        let body = if (args.context == "\01") {
            EMPTY_BLOB;
        } else {
            args.response.body;
        };
        {
            status = args.response.status;
            headers = [];
            body;
        };
    };

    public func validTransformContext(context : Blob) : Bool {
        context == "\00" or context == "\01";
    };

    public func managementCaller(caller : Principal) : Bool {
        Principal.toText(caller) == "aaaaa-aa";
    };
}
