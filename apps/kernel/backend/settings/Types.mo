module {
    public type Snapshot = {
        snapshot_version : Nat;
        cycles_balance : Nat;
        rts_version : Text;
        wasm_memory_bytes : Nat;
        heap_size_bytes : Nat;
        total_allocation_bytes : Nat;
        reclaimed_bytes : Nat;
        max_live_size_bytes : Nat;
        stable_memory_bytes : Nat;
        logical_stable_memory_bytes : Nat;
    };

    public type MemorySnapshot = {
        snapshot_version : Nat;
        wasm_memory_bytes : Nat;
        stable_memory_bytes : Nat;
        wasm_memory_limit_bytes : Nat;
        stable_memory_limit_bytes : Nat;
    };

    public type AccessSnapshot = {
        snapshot_version : Nat;
        authorized_principals : [Principal];
        controllers : [Principal];
        self_principal : Principal;
        controller_limit : Nat;
    };
};
