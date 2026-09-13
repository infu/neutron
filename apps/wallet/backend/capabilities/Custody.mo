import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Catalog "../Catalog";
import Types "./Types";

module {
    // Custody requires the whole principal, even if historical method grants
    // would individually authorize a request. Defaulting to this rule also
    // covers custom ledgers and new minter methods without a catalog lookup.
    // Public index reads retain their ordinary Kernel grants. The CMC also
    // requires exclusivity: notification chooses the destination subaccount
    // for an already-paid mint, so its caller identity is custody authority.
    func requiresPrincipal(canister : Principal, method : Text) : Bool {
        if (method == "get_account_transactions") {
            for (ledger in Catalog.ledgers.vals()) {
                switch (ledger.index) {
                    case (?index) if (canister == Principal.fromText(index)) return false;
                    case (_) {};
                };
            };
        };
        true;
    };

    public func guard(base : Types.BackendCalls) : Types.BackendCalls {
        func owns(canister : Principal, method : Text) : Bool {
            not requiresPrincipal(canister, method) or base.owns_principal(canister);
        };
        func checkReply(request : Types.CallRequest, result : Types.CallResult) : Types.CallResult {
            if (not owns(request.canister, request.method)) {
                return #err({
                    code = "revoked_after_dispatch";
                    message = "Wallet's exclusive principal access was revoked after dispatch; the remote outcome may be unknown";
                });
            };
            result;
        };
        func call(request : Types.CallRequest) : async* Types.CallResult {
            if (not owns(request.canister, request.method)) {
                return #err({
                    code = "not_reserved";
                    message = "Wallet requires exclusive principal access before using this ledger, minter or funding service";
                });
            };
            checkReply(request, await* base.call(request));
        };
        {
            canister_principal = base.canister_principal;
            owns_principal = base.owns_principal;
            can_call = func(canister : Principal, method : Text) : Bool {
                owns(canister, method) and base.can_call(canister, method);
            };
            call;
            call_batch = func(requests : [Types.CallRequest]) : async* [Types.CallResult] {
                for (request in requests.vals()) {
                    if (not owns(request.canister, request.method)) {
                        return Array.map<Types.CallRequest, Types.CallResult>(requests, func(_) {
                            #err({
                                code = "not_reserved";
                                message = "Wallet batch requires exclusive principal access to every ledger, minter and funding service before dispatch";
                            });
                        });
                    };
                };
                // Preserve the Kernel's original whole-batch admission and
                // concurrent dispatch. It creates all admitted remote futures
                // before awaiting, so ownership cannot change between slots.
                let results = await* base.call_batch(requests);
                Array.tabulate<Types.CallResult>(results.size(), func(index) {
                    if (index < requests.size()) checkReply(requests[index], results[index]) else results[index];
                });
            };
        };
    };
};
