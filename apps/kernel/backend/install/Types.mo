import CapabilityTypes "../capabilities/Types";

module {
    public type AppScope = CapabilityTypes.AppScope;
    public type ResidentFrameSecurity = CapabilityTypes.ResidentFrameSecurity;
    public type RuntimeApp = CapabilityTypes.RuntimeApp;
    public type AppInstance = CapabilityTypes.AppInstance;

    public type AssetCopy = {
        source : Text;
        target : Text;
    };

    // Public, identity-free transaction request. A caller declares the exact
    // compiled target, but cannot choose or replay installation identities.
    public type BeginInput = {
        deployment_id : Text;
        copies : [AssetCopy];
        clear_prefixes : [Text];
        target_app_inventory : [RuntimeApp];
    };

    // Private stable transaction record. Both sides of the transition are
    // complete snapshots, including capability-free apps.
    public type Journal = {
        deployment_id : Text;
        allocation_start_uid : Nat64;
        copies : [AssetCopy];
        clear_prefixes : [Text];
        removed_apps : [Text];
        committed_app_instances : [AppInstance];
        target_app_instances : [AppInstance];
    };

    public type Memory = {
        var browser_origin_epoch : ?Nat64;
        var next_installation_uid : Nat64;
        var committed_app_instances : [AppInstance];
        var pending : ?Journal;
    };

    public type CheckedBeginInput = {
        journal : BeginInput;
        expected_deployment_id : Text;
    };

    public type DeploymentInput = {
        deployment_id : Text;
    };

    public type CommitResult = {
        #committed;
        #blocked;
    };

    public type Status = {
        deployment_id : Text;
        copy_count : Nat;
        clear_count : Nat;
        removed_apps : [Text];
        committed_app_instances : [AppInstance];
        target_app_instances : [AppInstance];
    };
};
