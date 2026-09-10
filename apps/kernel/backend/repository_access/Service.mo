import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Cycles "mo:core/Cycles";
import Types "Types";

module {
    public func transport() : Types.Transport {
        func(input : Types.Input) : async Types.TransportResult {
            let source : Types.Source = actor (Principal.toText(input.source));
            // A typed shared call exposes the source's native refund. The
            // raw-call prelude accepts all cycles in an intermediate helper,
            // hiding its source refund from the caller of IC.call.
            try {
                let reply = await (with cycles = input.cycles) source.repo_access_v1(input.request);
                let refunded = Cycles.refunded();
                #ok({ reply; charged_cycles = if (refunded >= input.cycles) 0 else input.cycles - refunded });
            } catch (_) {
                // Motoko resets its refund observation on rejected awaits.
                // The source may have accepted cycles; do not fabricate a
                // zero charge or treat all attached cycles as consumed.
                #err({ charged_cycles = null });
            };
        };
    };

    public func validHex(value : Text, size : Nat) : Bool {
        if (value.size() != size) return false;
        for (char in value.chars()) {
            if (not ((char >= '0' and char <= '9') or (char >= 'a' and char <= 'f'))) {
                return false;
            };
        };
        true;
    };

    public func validPath(path : Text) : Bool {
        let (prefix, suffix) = if (Text.startsWith(path, #text "/repo/v1/packages/")) {
            ("/repo/v1/packages/", ".neutron");
        } else {
            ("/repo/v1/sources/", ".source.v1.msgpack.gz");
        };
        let ?withoutPrefix = Text.stripStart(path, #text prefix) else return false;
        let ?hash = Text.stripEnd(withoutPrefix, #text suffix) else return false;
        validHex(hash, 64);
    };

    public func validInput(input : Types.Input) : Bool {
        if (
            Principal.isAnonymous(input.source) or
            Principal.toText(input.source) == "aaaaa-aa" or
            not validHex(input.request.request_id, 32) or
            not validHex(input.request.token, 64)
        ) return false;
        for (path in input.request.paths.vals()) {
            if (not validPath(path)) return false;
        };
        true;
    };

    func failure(code : Text, message : Text, charged_cycles : ?Nat) : Types.Output {
        { result = #err({ code; message }); charged_cycles };
    };

    public class Service(
        send : Types.Transport,
        authorized : Principal -> Bool,
    ) {
        public func access(input : Types.Input, caller : Principal) : async* Types.Output {
            if (Principal.isAnonymous(caller) or not authorized(caller)) {
                return failure("unauthorized", "Repository access requires an authorized Neutron owner.", ?0);
            };
            if (not validInput(input)) {
                return failure("invalid_request", "Repository access requires a source principal, canonical request ID, token, and package or source paths.", ?0);
            };

            // The typed transport owns the await/refund context. No app
            // capability, marketplace identity, or persistent token is created.
            let response = await send(input);
            let chargedCycles = switch (response) {
                case (#ok(value)) ?value.charged_cycles;
                case (#err(value)) value.charged_cycles;
            };
            if (Principal.isAnonymous(caller) or not authorized(caller)) {
                return failure("revoked_after_dispatch", "Owner access changed while the repository request was in progress. The repository may have accepted the original request.", chargedCycles);
            };
            switch (response) {
                case (#err(_)) {
                    // Remote rejection strings can echo the bearer token.
                    // The outcome can be uncertain: never retry automatically.
                    failure("invocation_unknown", "The repository access reply was unavailable. Reconcile the original request before requesting access again.", chargedCycles);
                };
                case (#ok(value)) {
                    let result = value.reply;
                    switch (result) {
                        case (#ok(access)) {
                            if (access.request_id != input.request.request_id or access.paths != input.request.paths) {
                                return failure("invalid_reply", "The repository access reply did not match the original request.", chargedCycles);
                            };
                            { result; charged_cycles = chargedCycles };
                        };
                        case (#err(error)) {
                            // Protocol errors remain useful to the caller, but
                            // no untrusted field may echo the access credential.
                            if (Text.contains(error.code, #text(input.request.token)) or Text.contains(error.message, #text(input.request.token))) {
                                failure("repository_error", "The repository could not authorize this access request.", chargedCycles);
                            } else {
                                { result; charged_cycles = chargedCycles };
                            };
                        };
                    };
                };
            };
        };
    };
};
