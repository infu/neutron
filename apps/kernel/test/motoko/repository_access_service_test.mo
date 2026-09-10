import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Service "../../backend/repository_access/Service";
import Types "../../backend/repository_access/Types";

persistent actor Self {
    // A disposable repository endpoint verifies the real unbounded raw
    // transport, including authenticated calling principal and IC refunds.
    public shared ({ caller }) func repo_access_v1(request : Types.Request) : async Types.AccessResult {
        assert (caller == Principal.fromActor(Self));
        if (request.fee_version == 5) throw Error.reject("Private upstream error: " # request.token);
        let acceptedCycles = Cycles.accept<system>(70_000_000);
        #ok({
            request_id = request.request_id;
            paths = request.paths;
            accepted_cycles = acceptedCycles;
        });
    };

    public func run() : async () {
        let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
        let source = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
        let requestId = "0123456789abcdef0123456789abcdef";
        let token = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let packagePath = "/repo/v1/packages/" # hash # ".neutron";
        let sourcePath = "/repo/v1/sources/" # hash # ".source.v1.msgpack.gz";
        let request : Types.Request = {
            request_id = requestId;
            token;
            paths = [packagePath, sourcePath];
            fee_version = 4;
        };
        let input : Types.Input = { source; cycles = 100_000_000; request };
        let accepted : Types.AccessResult = #ok({
            request_id = requestId;
            paths = request.paths;
            accepted_cycles = 70_000_000;
        });
        var live = true;
        var calls = 0;
        var revokeDuringCall = false;
        var reply : Types.TransportResult = #ok({
            reply = accepted;
            charged_cycles = 70_000_000;
        });
        let transport : Types.Transport = func(received : Types.Input) : async Types.TransportResult {
            calls += 1;
            assert (received == input);
            if (revokeDuringCall) live := false;
            reply;
        };
        let broker = Service.Service(transport, func(caller) { live and caller == owner });
        func expectError(output : Types.Output, code : Text, charged : ?Nat) {
            assert (output.charged_cycles == charged);
            switch (output.result) {
                case (#err(error)) assert (error.code == code);
                case (#ok(_)) Runtime.trap("Expected repository access error");
            };
        };

        assert (Service.validPath(packagePath));
        assert (Service.validPath(sourcePath));
        for (path in [
            packagePath # "?token=" # token,
            "/repo/v1/packages/../" # hash # ".neutron",
            "/repo/v1/packages/" # hash # "0.neutron",
            "/repo/v1/packages/ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab.neutron",
            "/repo/v1/sources/" # hash # ".neutron",
            "/repo/v1/sources/" # hash # ".source.v1.msgpack.gz/extra",
            "https://example.test" # packagePath,
            "/repo/v1/packages/%30" # hash # ".neutron",
        ].vals()) assert (not Service.validPath(path));
        assert (Service.validInput(input));
        assert (Service.validInput({ input with cycles = 0 }));
        // Source fee policy decides the number of paths and cycles; the Kernel
        // adds neither a cycle ceiling nor a path-count policy.
        assert (Service.validInput({ input with cycles = 10 ** 30; request = { request with paths = [] } }));
        assert (not Service.validInput({ input with source = Principal.fromText("aaaaa-aa") }));
        assert (not Service.validInput({ input with source = Principal.fromText("2vxsx-fae") }));
        assert (not Service.validInput({ input with request = { request with request_id = "ABCDEF0123456789abcdef0123456789ab" } }));
        assert (not Service.validInput({ input with request = { request with token = token # "0" } }));

        expectError(await* broker.access(input, Principal.fromText("2vxsx-fae")), "unauthorized", ?0);
        expectError(await* broker.access(input, source), "unauthorized", ?0);
        expectError(await* broker.access({ input with request = { request with token = "invalid" } }, owner), "invalid_request", ?0);
        assert (calls == 0);

        let result = await* broker.access(input, owner);
        assert (result.result == accepted and result.charged_cycles == ?70_000_000);
        assert (calls == 1);

        let denied : Types.AccessResult = #err({ code = "not_owned"; message = "Acquire this application before downloading it." });
        reply := #ok({ reply = denied; charged_cycles = 3_000 });
        let denial = await* broker.access(input, owner);
        assert (denial.result == denied and denial.charged_cycles == ?3_000);
        assert (calls == 2);

        reply := #err({ charged_cycles = null });
        let uncertain = await* broker.access(input, owner);
        expectError(uncertain, "invocation_unknown", null);
        assert (calls == 3); // no automatic retry of an uncertain update
        switch (uncertain.result) {
            case (#err(error)) assert (error.message == "The repository access reply was unavailable. Reconcile the original request before requesting access again.");
            case (#ok(_)) Runtime.trap("Expected uncertain request");
        };

        for (leak in [
            #err({ code = token; message = "Credential rejected" }),
            #err({ code = "denied"; message = "Credential " # token # " was rejected" }),
        ].vals()) {
            let failure : Types.AccessResult = leak;
            reply := #ok({ reply = failure; charged_cycles = 5 });
            expectError(await* broker.access(input, owner), "repository_error", ?5);
        };

        let unrelated : Types.AccessResult = #ok({ request_id = requestId; paths = [packagePath]; accepted_cycles = 7 });
        reply := #ok({ reply = unrelated; charged_cycles = 7 });
        expectError(await* broker.access(input, owner), "invalid_reply", ?7);

        revokeDuringCall := true;
        reply := #ok({ reply = accepted; charged_cycles = 70_000_000 });
        expectError(await* broker.access(input, owner), "revoked_after_dispatch", ?70_000_000);
        let finalCalls = calls;
        expectError(await* broker.access(input, owner), "unauthorized", ?0);
        assert (calls == finalCalls);

        let direct = await (with cycles = input.cycles) Self.repo_access_v1(request);
        let directRefund = Cycles.refunded();
        assert (direct == accepted);
        if (directRefund != 30_000_000) Runtime.trap("Unexpected direct IC refund: " # debug_show directRefund);
        let realBroker = Service.Service(Service.transport(), func(caller) { caller == owner });
        let realReply = await* realBroker.access({ input with source = Principal.fromActor(Self) }, owner);
        if (realReply.charged_cycles != ?70_000_000 or realReply.result != accepted) {
            Runtime.trap("Unexpected real repository transport accounting: " # debug_show realReply);
        };
        let rejected = await* realBroker.access({ input with source = Principal.fromActor(Self); request = { request with fee_version = 5 } }, owner);
        expectError(rejected, "invocation_unknown", null);
    };
};
