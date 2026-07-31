import Cycles "mo:core/Cycles";
import IC "../aaa_interface";
import Prim "mo:prim";
import Principal "mo:core/Principal";
import Types "./Types";

module {
    let WASM_PAGE_BYTES : Nat = 65_536;
    let WASM64_HARD_LIMIT_BYTES : Nat = 6_442_450_944;
    let STABLE_MEMORY_LIMIT_BYTES : Nat = 536_870_912_000;

    public func snapshot() : Types.Snapshot {
        {
            snapshot_version = 1;
            cycles_balance = Cycles.balance();
            rts_version = Prim.rts_version();
            wasm_memory_bytes = Prim.rts_memory_size();
            heap_size_bytes = Prim.rts_heap_size();
            total_allocation_bytes = Prim.rts_total_allocation();
            reclaimed_bytes = Prim.rts_reclaimed();
            max_live_size_bytes = Prim.rts_max_live_size();
            stable_memory_bytes = Prim.rts_stable_memory_size() * WASM_PAGE_BYTES;
            logical_stable_memory_bytes = Prim.rts_logical_stable_memory_size() * WASM_PAGE_BYTES;
        };
    };

    public func memorySnapshot(self : actor {}) : async* Types.MemorySnapshot {
        let status = await IC.management.canister_status({
            canister_id = Principal.fromActor(self);
        });
        let configuredWasmLimit = status.settings.wasm_memory_limit;
        let wasmLimit = if (
            configuredWasmLimit == 0 or
            configuredWasmLimit > WASM64_HARD_LIMIT_BYTES
        ) {
            WASM64_HARD_LIMIT_BYTES;
        } else {
            configuredWasmLimit;
        };
        {
            snapshot_version = 1;
            wasm_memory_bytes = status.memory_metrics.wasm_memory_size;
            stable_memory_bytes = status.memory_metrics.stable_memory_size;
            wasm_memory_limit_bytes = wasmLimit;
            stable_memory_limit_bytes = STABLE_MEMORY_LIMIT_BYTES;
        };
    };
};
