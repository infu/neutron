import IC "../aaa_interface";
import Types "./Types";
import Array "mo:core/Array";
import Error "mo:core/Error";
import Principal "mo:core/Principal";
import Set "mo:core/Set";

module {
    let CONTROLLER_LIMIT : Nat = 10;

    public class Service(authorized : Set.Set<Principal>) {
        var controllerMutationActive = false;

        public func snapshot(self : actor {}) : async* Types.AccessSnapshot {
            let selfPrincipal = Principal.fromActor(self);
            let status = await IC.management.canister_status({
                canister_id = selfPrincipal;
            });
            makeSnapshot(status.settings.controllers, selfPrincipal);
        };

        public func addController(
            principal : Principal,
            self : actor {},
        ) : async* Types.AccessSnapshot {
            if (not validPrincipal(principal)) {
                throw Error.reject("The anonymous principal cannot be granted access");
            };
            if (not beginControllerMutation()) {
                throw Error.reject("Another controller change is in progress");
            };
            let result = try {
                await* addControllerUnlocked(principal, self);
            } catch (cause) {
                controllerMutationActive := false;
                throw cause;
            };
            controllerMutationActive := false;
            result;
        };

        public func removeController(
            principal : Principal,
            self : actor {},
        ) : async* Types.AccessSnapshot {
            if (not beginControllerMutation()) {
                throw Error.reject("Another controller change is in progress");
            };
            let result = try {
                await* removeControllerUnlocked(principal, self);
            } catch (cause) {
                controllerMutationActive := false;
                throw cause;
            };
            controllerMutationActive := false;
            result;
        };

        public func authorizeFromController(
            principal : Principal,
            caller : Principal,
            self : actor {},
        ) : async* () {
            if (not validPrincipal(principal)) {
                throw Error.reject("The anonymous principal cannot be granted access");
            };
            let selfPrincipal = Principal.fromActor(self);
            let status = await IC.management.canister_status({
                canister_id = selfPrincipal;
            });
            if (not contains(status.settings.controllers, caller)) {
                throw Error.reject("Only a canister controller can recover access");
            };
            Set.add(authorized, Principal.compare, principal);
        };

        public func assertController(
            caller : Principal,
            self : actor {},
        ) : async* () {
            if (not validPrincipal(caller)) {
                throw Error.reject("Only a canister controller can arm activation");
            };
            let selfPrincipal = Principal.fromActor(self);
            let status = await IC.management.canister_status({
                canister_id = selfPrincipal;
            });
            if (not contains(status.settings.controllers, caller)) {
                throw Error.reject("Only a canister controller can arm activation");
            };
        };

        func addControllerUnlocked(
            principal : Principal,
            self : actor {},
        ) : async* Types.AccessSnapshot {
            let selfPrincipal = Principal.fromActor(self);
            let status = await IC.management.canister_status({
                canister_id = selfPrincipal;
            });
            let controllers = status.settings.controllers;
            if (not contains(controllers, selfPrincipal)) {
                throw Error.reject(
                    "Neutron cannot manage controllers because it is not a controller of itself"
                );
            };
            if (contains(controllers, principal)) {
                return makeSnapshot(controllers, selfPrincipal);
            };
            if (controllers.size() >= CONTROLLER_LIMIT) {
                throw Error.reject("The controller limit has been reached");
            };

            let next = Array.concat<Principal>(controllers, [principal]);
            await updateControllers(selfPrincipal, next);
            makeSnapshot(next, selfPrincipal);
        };

        func removeControllerUnlocked(
            principal : Principal,
            self : actor {},
        ) : async* Types.AccessSnapshot {
            let selfPrincipal = Principal.fromActor(self);
            if (Principal.equal(principal, selfPrincipal)) {
                throw Error.reject("Neutron must remain a controller of itself");
            };

            let status = await IC.management.canister_status({
                canister_id = selfPrincipal;
            });
            let controllers = status.settings.controllers;
            if (not contains(controllers, selfPrincipal)) {
                throw Error.reject(
                    "Neutron cannot manage controllers because it is not a controller of itself"
                );
            };
            if (not contains(controllers, principal)) {
                return makeSnapshot(controllers, selfPrincipal);
            };

            let next = Array.filter<Principal>(
                controllers,
                func(current) { not Principal.equal(current, principal) },
            );
            await updateControllers(selfPrincipal, next);
            makeSnapshot(next, selfPrincipal);
        };

        func updateControllers(
            selfPrincipal : Principal,
            controllers : [Principal],
        ) : async () {
            await IC.management.update_settings({
                canister_id = selfPrincipal;
                sender_canister_version = null;
                settings = {
                    controllers = ?controllers;
                    compute_allocation = null;
                    memory_allocation = null;
                    freezing_threshold = null;
                    reserved_cycles_limit = null;
                    log_visibility = null;
                    snapshot_visibility = null;
                    wasm_memory_limit = null;
                    wasm_memory_threshold = null;
                    environment_variables = null;
                };
            });
        };

        func makeSnapshot(
            controllers : [Principal],
            selfPrincipal : Principal,
        ) : Types.AccessSnapshot {
            {
                snapshot_version = 1;
                authorized_principals = Set.toArray(authorized);
                controllers;
                self_principal = selfPrincipal;
                controller_limit = CONTROLLER_LIMIT;
            };
        };

        func beginControllerMutation() : Bool {
            if (controllerMutationActive) return false;
            controllerMutationActive := true;
            true;
        };
    };

    public func validPrincipal(principal : Principal) : Bool {
        not Principal.isAnonymous(principal);
    };

    public func contains(principals : [Principal], target : Principal) : Bool {
        for (principal in principals.vals()) {
            if (Principal.equal(principal, target)) return true;
        };
        false;
    };
};
