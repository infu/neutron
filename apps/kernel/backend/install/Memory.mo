import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import Runtime "mo:core/Runtime";
import Types "Types";

module {
    public func init() : Types.Memory {
        {
            var browser_origin_epoch = null;
            var next_installation_uid = 1;
            var committed_app_instances = [];
            var pending = null;
        };
    };

    public func has(mem : Types.Memory, deploymentId : Text) : Bool {
        switch (mem.pending) {
            case (?journal) journal.deployment_id == deploymentId;
            case null false;
        };
    };

    // Kernel-owned canister installation epoch. Specialized capabilities use
    // this generic accessor instead of reaching into install stable memory or
    // inventing capability-specific identity state.
    public func installEpoch(mem : Types.Memory) : Nat64 {
        switch (mem.browser_origin_epoch) {
            case (?value) value;
            case null Runtime.trap("Install epoch is not initialized");
        };
    };

    public func committedScope(
        mem : Types.Memory,
        appId : Text,
    ) : ?CapabilityTypes.AppScope {
        switch (findApp(mem.committed_app_instances, appId)) {
            case (?instance) ?instance.scope;
            case null null;
        };
    };

    // Actor-wide commit state is deliberately distinct from scope liveness.
    // Activation-only effects such as run_on_start use this deployment fact;
    // app code additionally needs its exact scope to be live.
    public func deploymentCommitted(
        mem : Types.Memory,
        runningDeploymentId : Text,
    ) : Bool {
        allForDeployment(
            mem.committed_app_instances,
            runningDeploymentId,
        );
    };

    // Scope liveness is actor/deployment-relative. Merely recording a journal
    // cannot mutate the predecessor actor. A target actor has no active app
    // scopes until commit: version and capability-plan equality cannot prove
    // that app code or public ingress is unchanged, especially because
    // same-version package replacement is supported.
    public func scopeActive(
        mem : Types.Memory,
        runningDeploymentId : Text,
        scope : CapabilityTypes.AppScope,
    ) : Bool {
        let ?committed = findScope(mem.committed_app_instances, scope) else {
            return false;
        };
        committed.deployment_id == runningDeploymentId and
        deploymentCommitted(mem, runningDeploymentId);
    };

    // Actor construction may resolve only its exact committed deployment or
    // the exact staged deployment that is waiting for activation/commit.
    public func instancesForDeployment(
        mem : Types.Memory,
        deploymentId : Text,
    ) : ?[Types.AppInstance] {
        if (allForDeployment(mem.committed_app_instances, deploymentId)) {
            return ?mem.committed_app_instances;
        };
        switch (mem.pending) {
            case (?journal) {
                if (
                    journal.deployment_id == deploymentId and
                    allForDeployment(journal.target_app_instances, deploymentId)
                ) return ?journal.target_app_instances;
            };
            case null {};
        };
        null;
    };

    public func appScopeForDeployment(
        mem : Types.Memory,
        appId : Text,
        deploymentId : Text,
    ) : ?CapabilityTypes.AppScope {
        let ?instances = instancesForDeployment(mem, deploymentId) else {
            return null;
        };
        switch (findApp(instances, appId)) {
            case (?instance) ?instance.scope;
            case null null;
        };
    };

    public func findApp(
        instances : [Types.AppInstance],
        appId : Text,
    ) : ?Types.AppInstance {
        for (instance in instances.vals()) {
            if (instance.scope.app_id == appId) return ?instance;
        };
        null;
    };

    public func findScope(
        instances : [Types.AppInstance],
        scope : CapabilityTypes.AppScope,
    ) : ?Types.AppInstance {
        for (instance in instances.vals()) {
            if (CapabilityScope.equal(instance.scope, scope)) return ?instance;
        };
        null;
    };

    func allForDeployment(
        instances : [Types.AppInstance],
        deploymentId : Text,
    ) : Bool {
        // Empty is never an actor inventory: every compiled Neutron contains
        // at least the kernel app.
        if (instances.size() == 0) return false;
        for (instance in instances.vals()) {
            if (instance.deployment_id != deploymentId) return false;
        };
        true;
    };
};
