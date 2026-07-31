import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Order "mo:core/Order";
import Region "mo:core/Region";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";
import SHA256 "mo:sha2/Sha256";
import Types "Types";

module {
    type VirtualCandidate = {
        #base : Types.FreeExtent;
        #added : {
            index : Nat;
            extent : Types.FreeExtent;
        };
    };

    type AllocationPlan = {
        removed_base : [var ?Types.FreeExtent];
        added : [var ?Types.FreeExtent];
        var removed_base_count : Nat;
        var added_count : Nat;
        var committed_bytes : Nat64;
        var allocated_bytes : Nat64;
        var allocated_extents : Nat;
        var free_extents : Nat;
        var mutation_epoch : Nat64;
    };

    public type AuditCursor = {
        next_offset : Nat64;
        scanned_free_extents : Nat;
        free_bytes : Nat64;
        snapshot_committed_bytes : Nat64;
        snapshot_allocated_bytes : Nat64;
        snapshot_allocated_extents : Nat;
        snapshot_free_extents : Nat;
        snapshot_mutation_epoch : Nat64;
    };

    public type AuditPage = {
        valid : Bool;
        complete : Bool;
        scanned_nodes : Nat;
        partition_valid : ?Bool;
        next : ?AuditCursor;
    };

    public type AllocatedAuditCursor = {
        next_offset : Nat64;
        scanned_allocated_extents : Nat;
        allocated_bytes : Nat64;
        snapshot_committed_bytes : Nat64;
        snapshot_allocated_bytes : Nat64;
        snapshot_allocated_extents : Nat;
        snapshot_free_extents : Nat;
        snapshot_mutation_epoch : Nat64;
    };

    public type AllocatedAuditPage = {
        valid : Bool;
        complete : Bool;
        scanned_nodes : Nat;
        ownership_bytes_valid : ?Bool;
        next : ?AllocatedAuditCursor;
    };

    public let ARENA_PAGE_BYTES_V3 : Nat64 = 65_536;
    public let ARENA_GROWTH_QUANTUM_V3 : Nat64 = 2_097_152;
    public let ARENA_GROWTH_PAGES_V3 : Nat64 = 32;
    public let ARENA_ALIGNMENT_V3 : Nat64 = 16;
    public let ARENA_SPLIT_MIN_V3 : Nat64 = 256;
    public let ARENA_EXTENT_CAPACITY_MAX_V3 : Nat64 = 2_097_152;
    // Region.Region is an isolated stable-memory address space. Consequently
    // the compiled base in that address space is page zero; it is still a
    // frozen layout value and is 2-MiB aligned. It must not be interpreted as
    // page zero of the canister's non-region stable memory.
    public let ARENA_BASE_PAGE_V3 : Nat64 = 0;
    public let ARENA_CAPACITY_MAX_V3 : Nat64 = 2_147_483_648;
    public let MAX_ARENA_EXTENTS_V3 : Nat = 250_000;
    public let FRAGMENTATION_RESERVE_V3 : Nat64 = 268_435_456;
    public let ARENA_ALLOCATABLE_CAPACITY_MAX_V3 : Nat64 = 1_879_048_192;
    public let MAX_ALLOCATION_TRANSACTION_EXTENTS_V3 : Nat = 36;
    public let MAX_ARENA_AUDIT_PAGE_NODES_V3 : Nat = 2_048;

    // Shared allocator metadata is paid from the engine reserve rather than
    // charged to whichever scope happens to split a free descriptor. These
    // conservative V3 charging constants are part of the layout/accounting
    // fingerprint: a fixed 528-byte arena header and 288 bytes per logical
    // descriptor (including free/ownership indexes and their tree nodes).
    public let ARENA_HEADER_METADATA_CHARGE_V3 : Nat = 528;
    public let ARENA_DESCRIPTOR_METADATA_CHARGE_V3 : Nat = 288;
    public let ARENA_METADATA_RESERVE_V3 : Nat = 72_000_528;

    public let STAGE_EXTENT_BYTES_MAX : Nat = 1_900_000;
    public let ALLOCATOR_LAYOUT_CANONICAL_V3 : Text =
        "neutron.certified-assets.allocator-layout.v3\narena_page_bytes=65536\narena_growth_pages=32\narena_growth_quantum=2097152\narena_alignment=16\narena_split_min=256\narena_extent_capacity_max=2097152\narena_base_page=0\narena_capacity_max=2147483648\nmax_arena_extents=250000\nfragmentation_reserve=268435456\narena_allocatable_capacity_max=1879048192\nmax_allocation_transaction_extents=36\nmax_arena_audit_page_nodes=2048\narena_header_metadata_charge=528\narena_descriptor_metadata_charge=288\narena_metadata_reserve=72000528\nallocated_ownership_index=nat64_to_extent_ref_v1\nmutation_epoch=nat64_monotonic_every_grow_allocate_free_v1\nstage_extent_bytes_max=1900000\n";

    let REGION_GROW_FAILED : Nat64 = 18_446_744_073_709_551_615;
    let MAX_NORMALIZED_REQUEST_V3 : Nat64 = 1_900_000;
    // A fresh-arena plan can add one grown extent and one split remainder per
    // requested extent: 2 * MAX_ALLOCATION_TRANSACTION_EXTENTS_V3.
    let PLAN_OVERLAY_MAX : Nat = 72;

    public func init() : Types.ArenaMemory {
        assertFrozenLayout();
        {
            region = Region.new();
            free_by_size = Map.empty<Types.ExtentSizeKey, Types.FreeExtent>();
            free_by_offset = Map.empty<Nat64, Types.FreeExtent>();
            allocated_by_offset = Map.empty<Nat64, Types.ExtentRef>();
            var committed_bytes = 0;
            var allocated_bytes = 0;
            var allocated_extents = 0;
            var mutation_epoch = 0;
        };
    };

    public func layoutFingerprint() : Blob {
        SHA256.fromBlob(
            #sha256,
            Text.encodeUtf8(ALLOCATOR_LAYOUT_CANONICAL_V3),
        );
    };

    public func allocate(
        memory : Types.ArenaMemory,
        requested : Nat,
    ) : ?Types.ExtentRef {
        if (requested == 0) return null;
        if (requested > STAGE_EXTENT_BYTES_MAX) return null;
        let needNat = normalize(requested);
        if (needNat > Nat64.toNat(ARENA_GROWTH_QUANTUM_V3)) return null;
        let need = Nat64.fromNat(needNat);

        switch (bestFree(memory, need)) {
            case (?extent) takeExtent(memory, need, extent);
            case null {
                if (not growFor(memory, need)) return null;
                let ?grown = bestFree(memory, need) else {
                    Runtime.trap("Certified-assets arena growth produced no extent");
                };
                switch (takeExtent(memory, need, grown)) {
                    case (?extent) ?extent;
                    case null {
                        Runtime.trap(
                            "Certified-assets arena growth violated preflight"
                        );
                    };
                };
            };
        };
    };

    // Allocate a geometry/batch in canonical input order. A bounded virtual
    // overlay first executes the exact best-fit/split/coalesce sequence
    // without changing the arena or scanning either base index. Deterministic
    // failure therefore returns null before mutation. Once planned, the real
    // sequence must match byte-for-byte; an unexpected Region.grow failure or
    // mismatch traps so the enclosing IC update rolls back atomically.
    public func allocateMany(
        memory : Types.ArenaMemory,
        requested : [Nat],
    ) : ?[?Types.ExtentRef] {
        let ?planned = planMany(memory, requested) else return null;

        let result = VarArray.repeat<?Types.ExtentRef>(null, requested.size());
        var index = 0;
        while (index < requested.size()) {
            switch (planned[index]) {
                case (?expected) {
                    let ?actual = allocate(memory, requested[index]) else {
                        Runtime.trap(
                            "Certified-assets allocation diverged from preflight"
                        );
                    };
                    if (actual != expected) {
                        Runtime.trap(
                            "Certified-assets allocation order mismatch"
                        );
                    };
                    result[index] := ?actual;
                };
                case null {};
            };
            index += 1;
        };
        ?VarArray.toArray(result);
    };

    // Exact, non-mutating feasibility check used by Service error
    // precedence. The real allocation repeats this deterministic plan and
    // traps if the arena diverges within the same synchronous call.
    public func canAllocateMany(
        memory : Types.ArenaMemory,
        requested : [Nat],
    ) : Bool {
        planMany(memory, requested) != null;
    };

    func planMany(
        memory : Types.ArenaMemory,
        requested : [Nat],
    ) : ?[?Types.ExtentRef] {
        if (requested.size() > MAX_ALLOCATION_TRANSACTION_EXTENTS_V3) {
            return null;
        };
        for (size in requested.values()) {
            if (size > STAGE_EXTENT_BYTES_MAX) return null;
        };

        let plan : AllocationPlan = {
            removed_base = VarArray.repeat<?Types.FreeExtent>(
                null,
                PLAN_OVERLAY_MAX,
            );
            added = VarArray.repeat<?Types.FreeExtent>(
                null,
                PLAN_OVERLAY_MAX,
            );
            var removed_base_count = 0;
            var added_count = 0;
            var committed_bytes = memory.committed_bytes;
            var allocated_bytes = memory.allocated_bytes;
            var allocated_extents = memory.allocated_extents;
            var free_extents = Map.size(memory.free_by_offset);
            var mutation_epoch = memory.mutation_epoch;
        };
        let planned = VarArray.repeat<?Types.ExtentRef>(
            null,
            requested.size(),
        );
        var index = 0;
        while (index < requested.size()) {
            let size = requested[index];
            if (size > 0) {
                let need = Nat64.fromNat(normalize(size));
                let ?extent = planAllocate(memory, plan, need) else return null;
                planned[index] := ?extent;
            };
            index += 1;
        };
        ?VarArray.toArray(planned);
    };

    public func write(
        memory : Types.ArenaMemory,
        extent : Types.ExtentRef,
        body : Blob,
    ) : () {
        writeAt(memory, extent, 0, body);
    };

    public func writeAt(
        memory : Types.ArenaMemory,
        extent : Types.ExtentRef,
        relativeOffset : Nat,
        body : Blob,
    ) : () {
        validateOwned(memory, extent);
        let capacity = Nat32.toNat(extent.allocated_capacity);
        if (relativeOffset > capacity or body.size() > capacity - relativeOffset) {
            Runtime.trap("Certified-assets extent write exceeds capacity");
        };
        Region.storeBlob(
            memory.region,
            checkedAdd(extent.arena_offset, Nat64.fromNat(relativeOffset)),
            body,
        );
    };

    public func read(
        memory : Types.ArenaMemory,
        extent : Types.ExtentRef,
        logicalLength : Nat,
    ) : ?Blob {
        readAt(memory, extent, 0, logicalLength);
    };

    public func readAt(
        memory : Types.ArenaMemory,
        extent : Types.ExtentRef,
        relativeOffset : Nat,
        logicalLength : Nat,
    ) : ?Blob {
        validateOwned(memory, extent);
        let capacity = Nat32.toNat(extent.allocated_capacity);
        if (
            relativeOffset > capacity or
            logicalLength > capacity - relativeOffset
        ) Runtime.trap("Certified-assets extent read exceeds capacity");
        ?Region.loadBlob(
            memory.region,
            checkedAdd(extent.arena_offset, Nat64.fromNat(relativeOffset)),
            logicalLength,
        );
    };

    public func ownershipAt(
        memory : Types.ArenaMemory,
        arena_offset : Nat64,
    ) : ?Types.ExtentRef {
        Map.get(memory.allocated_by_offset, Nat64.compare, arena_offset);
    };

    public func hasExactOwnership(
        memory : Types.ArenaMemory,
        extent : Types.ExtentRef,
    ) : Bool {
        ownershipAt(memory, extent.arena_offset) == ?extent;
    };

    // The content descriptor must atomically null its owning slot in the same
    // enclosing update that calls this function. A double free or overlap is
    // treated as durable-state corruption and traps.
    public func free(
        memory : Types.ArenaMemory,
        extent : Types.ExtentRef,
    ) : () {
        validateOwned(memory, extent);
        let offset = extent.arena_offset;
        let capacity = Nat64.fromNat(Nat32.toNat(extent.allocated_capacity));
        if (
            memory.allocated_extents == 0 or
            memory.allocated_bytes < capacity
        ) Runtime.trap("Certified-assets allocated counters underflow");
        requireMutationEpoch(memory);
        var nextOffset = offset;
        var nextCapacity = capacity;

        let predecessor = Map.reverseEntriesFrom(
            memory.free_by_offset,
            Nat64.compare,
            offset,
        ).next();
        switch (predecessor) {
            case (?(priorOffset, prior)) {
                let priorEnd = checkedAdd(priorOffset, prior.capacity);
                if (priorEnd > offset) {
                    Runtime.trap("Certified-assets allocator overlap");
                };
                if (priorEnd == offset) {
                    removeFree(memory, prior);
                    nextOffset := priorOffset;
                    nextCapacity := checkedAdd(prior.capacity, nextCapacity);
                };
            };
            case null {};
        };

        let successor = Map.entriesFrom(
            memory.free_by_offset,
            Nat64.compare,
            offset,
        ).next();
        switch (successor) {
            case (?(afterOffset, after)) {
                let end = checkedAdd(nextOffset, nextCapacity);
                if (end > afterOffset) {
                    Runtime.trap("Certified-assets allocator overlap");
                };
                if (end == afterOffset) {
                    removeFree(memory, after);
                    nextCapacity := checkedAdd(nextCapacity, after.capacity);
                };
            };
            case null {};
        };

        if (
            not Map.delete(
                memory.allocated_by_offset,
                Nat64.compare,
                extent.arena_offset,
            )
        ) Runtime.trap("Certified-assets ownership index mismatch");
        memory.allocated_bytes -= capacity;
        memory.allocated_extents -= 1;
        insertFree(memory, { arena_offset = nextOffset; capacity = nextCapacity });
        bumpMutationEpoch(memory);
        assertDescriptorBound(memory);
    };

    // Upgrade and hot-path validation: scalar fields plus Region/Map sizes
    // only. It is O(1) and deliberately does not enumerate either free index.
    public func validateHeader(memory : Types.ArenaMemory) : Bool {
        if (not frozenLayoutValid()) return false;
        let freeByOffset = Map.size(memory.free_by_offset);
        let freeBySize = Map.size(memory.free_by_size);
        if (freeByOffset != freeBySize) return false;
        if (
            Map.size(memory.allocated_by_offset) !=
            memory.allocated_extents
        ) return false;
        if (
            memory.committed_bytes > ARENA_CAPACITY_MAX_V3 or
            memory.committed_bytes % ARENA_GROWTH_QUANTUM_V3 != 0 or
            Region.size(memory.region) !=
                memory.committed_bytes / ARENA_PAGE_BYTES_V3 or
            memory.allocated_bytes > memory.committed_bytes or
            memory.allocated_bytes > ARENA_ALLOCATABLE_CAPACITY_MAX_V3 or
            memory.allocated_bytes % ARENA_ALIGNMENT_V3 != 0 or
            (memory.allocated_extents == 0) !=
                (memory.allocated_bytes == 0) or
            memory.allocated_extents > MAX_ARENA_EXTENTS_V3 or
            memory.allocated_extents + freeByOffset >
                MAX_ARENA_EXTENTS_V3
        ) return false;
        if (
            Nat64.fromNat(memory.allocated_extents) * ARENA_ALIGNMENT_V3 >
            memory.allocated_bytes
        ) return false;
        true;
    };

    // Explicit bounded free-index audit. Each processed logical free
    // descriptor counts as one node and cross-checks its size-index twin.
    // The cursor freezes the scalar header; callers must restart if ordinary
    // allocator traffic changes it between pages.
    public func auditPage(
        memory : Types.ArenaMemory,
        cursor : ?AuditCursor,
        max_nodes : Nat,
    ) : AuditPage {
        if (not validateHeader(memory)) return invalidAuditPage(0);
        let freeExtents = Map.size(memory.free_by_offset);
        let state : AuditCursor = switch (cursor) {
            case null {
                {
                    next_offset = 0;
                    scanned_free_extents = 0;
                    free_bytes = 0;
                    snapshot_committed_bytes = memory.committed_bytes;
                    snapshot_allocated_bytes = memory.allocated_bytes;
                    snapshot_allocated_extents = memory.allocated_extents;
                    snapshot_free_extents = freeExtents;
                    snapshot_mutation_epoch = memory.mutation_epoch;
                };
            };
            case (?value) {
                if (
                    value.snapshot_committed_bytes != memory.committed_bytes or
                    value.snapshot_allocated_bytes != memory.allocated_bytes or
                    value.snapshot_allocated_extents !=
                        memory.allocated_extents or
                    value.snapshot_free_extents != freeExtents or
                    value.snapshot_mutation_epoch != memory.mutation_epoch or
                    value.scanned_free_extents > freeExtents or
                    value.next_offset > memory.committed_bytes or
                    value.next_offset % ARENA_ALIGNMENT_V3 != 0 or
                    value.free_bytes > memory.committed_bytes or
                    (
                        value.scanned_free_extents == 0 and
                        (
                            value.next_offset != 0 or
                            value.free_bytes != 0
                        )
                    )
                ) return invalidAuditPage(0);
                value;
            };
        };

        if (state.scanned_free_extents == freeExtents) {
            return completeAuditPage(memory, state.free_bytes, 0);
        };

        let limit = if (max_nodes < MAX_ARENA_AUDIT_PAGE_NODES_V3) {
            max_nodes;
        } else {
            MAX_ARENA_AUDIT_PAGE_NODES_V3;
        };
        let entries = Map.entriesFrom(
            memory.free_by_offset,
            Nat64.compare,
            state.next_offset,
        );
        var nextOffset = state.next_offset;
        var totalScanned = state.scanned_free_extents;
        var freeBytes = state.free_bytes;
        var pageScanned = 0;
        var exhausted = false;

        label page while (
            pageScanned < limit and totalScanned < freeExtents
        ) {
            let ?(offset, extent) = entries.next() else {
                exhausted := true;
                break page;
            };
            let ?end = addIfFits(offset, extent.capacity) else {
                return invalidAuditPage(pageScanned + 1);
            };
            if (
                offset != extent.arena_offset or
                offset % ARENA_ALIGNMENT_V3 != 0 or
                extent.capacity == 0 or
                extent.capacity % ARENA_ALIGNMENT_V3 != 0 or
                (
                    totalScanned > 0 and
                    offset <= nextOffset
                ) or
                end > memory.committed_bytes or
                Map.get(
                    memory.free_by_size,
                    compareSize,
                    { capacity = extent.capacity; arena_offset = offset },
                ) != ?extent
            ) return invalidAuditPage(pageScanned + 1);
            let ?nextFreeBytes = addIfFits(freeBytes, extent.capacity) else {
                return invalidAuditPage(pageScanned + 1);
            };
            freeBytes := nextFreeBytes;
            nextOffset := end;
            totalScanned += 1;
            pageScanned += 1;
        };

        if (exhausted and totalScanned < freeExtents) {
            return invalidAuditPage(pageScanned);
        };
        if (totalScanned == freeExtents) {
            return completeAuditPage(memory, freeBytes, pageScanned);
        };
        {
            valid = true;
            complete = false;
            scanned_nodes = pageScanned;
            partition_valid = null;
            next = ?{
                next_offset = nextOffset;
                scanned_free_extents = totalScanned;
                free_bytes = freeBytes;
                snapshot_committed_bytes = state.snapshot_committed_bytes;
                snapshot_allocated_bytes = state.snapshot_allocated_bytes;
                snapshot_allocated_extents =
                    state.snapshot_allocated_extents;
                snapshot_free_extents = state.snapshot_free_extents;
                snapshot_mutation_epoch = state.snapshot_mutation_epoch;
            };
        };
    };

    // Companion bounded pass over the exact ownership index. Completion
    // proves its byte sum equals allocated_bytes; every row is also checked
    // against neighboring allocated rows and both free-index neighbors.
    public func auditAllocatedPage(
        memory : Types.ArenaMemory,
        cursor : ?AllocatedAuditCursor,
        max_nodes : Nat,
    ) : AllocatedAuditPage {
        if (not validateHeader(memory)) {
            return invalidAllocatedAuditPage(0);
        };
        let allocatedExtents = Map.size(memory.allocated_by_offset);
        let freeExtents = Map.size(memory.free_by_offset);
        let state : AllocatedAuditCursor = switch (cursor) {
            case null {
                {
                    next_offset = 0;
                    scanned_allocated_extents = 0;
                    allocated_bytes = 0;
                    snapshot_committed_bytes = memory.committed_bytes;
                    snapshot_allocated_bytes = memory.allocated_bytes;
                    snapshot_allocated_extents = allocatedExtents;
                    snapshot_free_extents = freeExtents;
                    snapshot_mutation_epoch = memory.mutation_epoch;
                };
            };
            case (?value) {
                if (
                    value.snapshot_committed_bytes != memory.committed_bytes or
                    value.snapshot_allocated_bytes != memory.allocated_bytes or
                    value.snapshot_allocated_extents != allocatedExtents or
                    value.snapshot_free_extents != freeExtents or
                    value.snapshot_mutation_epoch != memory.mutation_epoch or
                    value.scanned_allocated_extents > allocatedExtents or
                    value.next_offset > memory.committed_bytes or
                    value.next_offset % ARENA_ALIGNMENT_V3 != 0 or
                    value.allocated_bytes > memory.committed_bytes or
                    (
                        value.scanned_allocated_extents == 0 and
                        (
                            value.next_offset != 0 or
                            value.allocated_bytes != 0
                        )
                    )
                ) return invalidAllocatedAuditPage(0);
                value;
            };
        };

        if (state.scanned_allocated_extents == allocatedExtents) {
            return completeAllocatedAuditPage(
                memory,
                state.allocated_bytes,
                0,
            );
        };
        let limit = if (max_nodes < MAX_ARENA_AUDIT_PAGE_NODES_V3) {
            max_nodes;
        } else {
            MAX_ARENA_AUDIT_PAGE_NODES_V3;
        };
        let entries = Map.entriesFrom(
            memory.allocated_by_offset,
            Nat64.compare,
            state.next_offset,
        );
        var nextOffset = state.next_offset;
        var totalScanned = state.scanned_allocated_extents;
        var allocatedBytes = state.allocated_bytes;
        var pageScanned = 0;
        var exhausted = false;

        label page while (
            pageScanned < limit and totalScanned < allocatedExtents
        ) {
            let ?(offset, extent) = entries.next() else {
                exhausted := true;
                break page;
            };
            let capacity = Nat64.fromNat(
                Nat32.toNat(extent.allocated_capacity)
            );
            let ?end = addIfFits(offset, capacity) else {
                return invalidAllocatedAuditPage(pageScanned + 1);
            };
            if (
                offset != extent.arena_offset or
                offset % ARENA_ALIGNMENT_V3 != 0 or
                capacity == 0 or capacity % ARENA_ALIGNMENT_V3 != 0 or
                capacity > ARENA_EXTENT_CAPACITY_MAX_V3 or
                (totalScanned > 0 and offset < nextOffset) or
                end > memory.committed_bytes or
                overlapsFree(memory, offset, end)
            ) return invalidAllocatedAuditPage(pageScanned + 1);
            let ?nextAllocatedBytes = addIfFits(
                allocatedBytes,
                capacity,
            ) else return invalidAllocatedAuditPage(pageScanned + 1);
            allocatedBytes := nextAllocatedBytes;
            nextOffset := end;
            totalScanned += 1;
            pageScanned += 1;
        };

        if (exhausted and totalScanned < allocatedExtents) {
            return invalidAllocatedAuditPage(pageScanned);
        };
        if (totalScanned == allocatedExtents) {
            return completeAllocatedAuditPage(
                memory,
                allocatedBytes,
                pageScanned,
            );
        };
        {
            valid = true;
            complete = false;
            scanned_nodes = pageScanned;
            ownership_bytes_valid = null;
            next = ?{
                next_offset = nextOffset;
                scanned_allocated_extents = totalScanned;
                allocated_bytes = allocatedBytes;
                snapshot_committed_bytes = state.snapshot_committed_bytes;
                snapshot_allocated_bytes = state.snapshot_allocated_bytes;
                snapshot_allocated_extents =
                    state.snapshot_allocated_extents;
                snapshot_free_extents = state.snapshot_free_extents;
                snapshot_mutation_epoch = state.snapshot_mutation_epoch;
            };
        };
    };

    // Full eager audit retained for tests and bounded maintenance assertions.
    public func validate(memory : Types.ArenaMemory) : Bool {
        if (not validateHeader(memory)) return false;
        var freeBytes : Nat64 = 0;
        var priorEnd : Nat64 = 0;
        var havePrior = false;
        for ((offset, extent) in Map.entries(memory.free_by_offset)) {
            let ?end = addIfFits(offset, extent.capacity) else return false;
            if (
                offset != extent.arena_offset or
                offset % ARENA_ALIGNMENT_V3 != 0 or extent.capacity == 0 or
                extent.capacity % ARENA_ALIGNMENT_V3 != 0 or
                (havePrior and offset <= priorEnd) or
                end > memory.committed_bytes or
                Map.get(
                    memory.free_by_size,
                    compareSize,
                    { capacity = extent.capacity; arena_offset = offset },
                ) != ?extent
            ) return false;
            priorEnd := end;
            havePrior := true;
            let ?nextFreeBytes = addIfFits(freeBytes, extent.capacity) else {
                return false;
            };
            freeBytes := nextFreeBytes;
        };
        var auditedAllocatedBytes : Nat64 = 0;
        priorEnd := 0;
        havePrior := false;
        for ((offset, extent) in Map.entries(memory.allocated_by_offset)) {
            let capacity = Nat64.fromNat(
                Nat32.toNat(extent.allocated_capacity)
            );
            let ?end = addIfFits(offset, capacity) else return false;
            if (
                offset != extent.arena_offset or
                offset % ARENA_ALIGNMENT_V3 != 0 or
                capacity == 0 or capacity % ARENA_ALIGNMENT_V3 != 0 or
                capacity > ARENA_EXTENT_CAPACITY_MAX_V3 or
                (havePrior and offset < priorEnd) or
                end > memory.committed_bytes or
                overlapsFree(memory, offset, end)
            ) return false;
            priorEnd := end;
            havePrior := true;
            let ?nextAllocatedBytes = addIfFits(
                auditedAllocatedBytes,
                capacity,
            ) else return false;
            auditedAllocatedBytes := nextAllocatedBytes;
        };
        if (auditedAllocatedBytes != memory.allocated_bytes) return false;
        switch (addIfFits(freeBytes, memory.allocated_bytes)) {
            case (?total) total == memory.committed_bytes;
            case null false;
        };
    };

    public func descriptorCount(memory : Types.ArenaMemory) : Nat {
        memory.allocated_extents + Map.size(memory.free_by_offset);
    };

    public func metadataCharge(memory : Types.ArenaMemory) : Nat {
        ARENA_HEADER_METADATA_CHARGE_V3 +
        descriptorCount(memory) * ARENA_DESCRIPTOR_METADATA_CHARGE_V3;
    };

    public func remainingAllocatableCapacity(
        memory : Types.ArenaMemory
    ) : Nat64 {
        if (memory.allocated_bytes >= ARENA_ALLOCATABLE_CAPACITY_MAX_V3) {
            0;
        } else {
            ARENA_ALLOCATABLE_CAPACITY_MAX_V3 - memory.allocated_bytes;
        };
    };

    public func diagnostics(
        memory : Types.ArenaMemory
    ) : Types.AllocatorDiagnostics {
        let freeExtents = Map.size(memory.free_by_offset);
        {
            header_valid = validateHeader(memory);
            mutation_epoch = memory.mutation_epoch;
            committed_high_water_bytes = memory.committed_bytes;
            allocated_bytes = memory.allocated_bytes;
            allocated_extents = memory.allocated_extents;
            free_extents = freeExtents;
            descriptor_count = memory.allocated_extents + freeExtents;
            descriptor_limit = MAX_ARENA_EXTENTS_V3;
            capacity_limit_bytes = ARENA_CAPACITY_MAX_V3;
            allocatable_limit_bytes = ARENA_ALLOCATABLE_CAPACITY_MAX_V3;
            allocatable_headroom_bytes =
                remainingAllocatableCapacity(memory);
            metadata_charge_bytes =
                ARENA_HEADER_METADATA_CHARGE_V3 +
                (memory.allocated_extents + freeExtents) *
                    ARENA_DESCRIPTOR_METADATA_CHARGE_V3;
        };
    };

    func bestFree(
        memory : Types.ArenaMemory,
        need : Nat64,
    ) : ?Types.FreeExtent {
        let candidate = Map.entriesFrom(
            memory.free_by_size,
            compareSize,
            { capacity = need; arena_offset = (0 : Nat64) },
        ).next();
        switch (candidate) {
            case (?(_, extent)) ?extent;
            case null null;
        };
    };

    func takeExtent(
        memory : Types.ArenaMemory,
        need : Nat64,
        freeExtent : Types.FreeExtent,
    ) : ?Types.ExtentRef {
        let remaining = freeExtent.capacity - need;
        if (
            remaining >= ARENA_SPLIT_MIN_V3 and
            descriptorCount(memory) + 1 > MAX_ARENA_EXTENTS_V3
        ) return null;

        let allocatedCapacity = if (remaining >= ARENA_SPLIT_MIN_V3) {
            need;
        } else {
            freeExtent.capacity;
        };
        if (
            memory.allocated_bytes >
                ARENA_ALLOCATABLE_CAPACITY_MAX_V3 - allocatedCapacity
        ) return null;
        if (memory.mutation_epoch == REGION_GROW_FAILED) return null;

        let allocated : Types.ExtentRef = {
            arena_offset = freeExtent.arena_offset;
            allocated_capacity = Nat32.fromNat(
                Nat64.toNat(allocatedCapacity)
            );
        };
        removeFree(memory, freeExtent);
        if (remaining >= ARENA_SPLIT_MIN_V3) {
            insertFree(memory, {
                arena_offset = checkedAdd(freeExtent.arena_offset, need);
                capacity = remaining;
            });
        };

        if (allocatedCapacity > ARENA_EXTENT_CAPACITY_MAX_V3) {
            Runtime.trap("Certified-assets extent capacity overflow");
        };
        insertAllocated(memory, allocated);
        memory.allocated_bytes += allocatedCapacity;
        memory.allocated_extents += 1;
        bumpMutationEpoch(memory);
        assertDescriptorBound(memory);
        ?allocated;
    };

    func growFor(memory : Types.ArenaMemory, need : Nat64) : Bool {
        let ?newCommitted = addIfFits(
            memory.committed_bytes,
            ARENA_GROWTH_QUANTUM_V3,
        ) else return false;
        if (newCommitted > ARENA_CAPACITY_MAX_V3) return false;
        if (memory.mutation_epoch == REGION_GROW_FAILED) return false;

        let oldEnd = memory.committed_bytes;
        let predecessor = Map.reverseEntriesFrom(
            memory.free_by_offset,
            Nat64.compare,
            oldEnd,
        ).next();
        var combinedOffset = oldEnd;
        var combinedCapacity = ARENA_GROWTH_QUANTUM_V3;
        var coalesced = false;
        switch (predecessor) {
            case (?(priorOffset, prior)) {
                let priorEnd = checkedAdd(priorOffset, prior.capacity);
                if (priorEnd > oldEnd) {
                    Runtime.trap("Certified-assets allocator overlap");
                };
                if (priorEnd == oldEnd) {
                    combinedOffset := priorOffset;
                    combinedCapacity := checkedAdd(
                        prior.capacity,
                        ARENA_GROWTH_QUANTUM_V3,
                    );
                    coalesced := true;
                };
            };
            case null {};
        };

        let remaining = combinedCapacity - need;
        let split = remaining >= ARENA_SPLIT_MIN_V3;
        let projectedDescriptors =
            descriptorCount(memory) +
            (if (coalesced) 0 else 1) +
            (if (split) 1 else 0);
        if (projectedDescriptors > MAX_ARENA_EXTENTS_V3) return false;
        let allocatedCapacity = if (split) need else combinedCapacity;
        if (
            allocatedCapacity > ARENA_EXTENT_CAPACITY_MAX_V3 or
            memory.allocated_bytes >
                ARENA_ALLOCATABLE_CAPACITY_MAX_V3 - allocatedCapacity
        ) return false;

        let expectedOldPages = oldEnd / ARENA_PAGE_BYTES_V3;
        let priorPages = Region.grow(memory.region, ARENA_GROWTH_PAGES_V3);
        if (priorPages == REGION_GROW_FAILED) return false;
        if (priorPages != expectedOldPages) {
            Runtime.trap("Certified-assets arena Region size mismatch");
        };
        memory.committed_bytes := newCommitted;
        if (coalesced) {
            let ?(_, prior) = predecessor else {
                Runtime.trap("Certified-assets allocator predecessor vanished");
            };
            removeFree(memory, prior);
        };
        insertFree(memory, {
            arena_offset = combinedOffset;
            capacity = combinedCapacity;
        });
        bumpMutationEpoch(memory);
        true;
    };

    func insertFree(memory : Types.ArenaMemory, extent : Types.FreeExtent) : () {
        if (
            extent.capacity == 0 or
            extent.arena_offset % ARENA_ALIGNMENT_V3 != 0 or
            extent.capacity % ARENA_ALIGNMENT_V3 != 0 or
            checkedAdd(extent.arena_offset, extent.capacity) >
            memory.committed_bytes
        ) Runtime.trap("Invalid certified-assets free extent");
        if (
            Map.get(memory.free_by_offset, Nat64.compare, extent.arena_offset) != null or
            Map.get(
                memory.free_by_size,
                compareSize,
                {
                    capacity = extent.capacity;
                    arena_offset = extent.arena_offset;
                },
            ) != null
        ) Runtime.trap("Duplicate certified-assets free extent");
        Map.add(memory.free_by_offset, Nat64.compare, extent.arena_offset, extent);
        Map.add(
            memory.free_by_size,
            compareSize,
            { capacity = extent.capacity; arena_offset = extent.arena_offset },
            extent,
        );
    };

    func removeFree(memory : Types.ArenaMemory, extent : Types.FreeExtent) : () {
        if (
            Map.get(memory.free_by_offset, Nat64.compare, extent.arena_offset) != ?extent or
            Map.get(
                memory.free_by_size,
                compareSize,
                { capacity = extent.capacity; arena_offset = extent.arena_offset },
            ) != ?extent
        ) {
            Runtime.trap("Certified-assets free indexes disagree");
        };
        ignore Map.delete(memory.free_by_offset, Nat64.compare, extent.arena_offset);
        ignore Map.delete(
            memory.free_by_size,
            compareSize,
            { capacity = extent.capacity; arena_offset = extent.arena_offset },
        );
    };

    func insertAllocated(
        memory : Types.ArenaMemory,
        extent : Types.ExtentRef,
    ) : () {
        if (
            Map.get(
                memory.allocated_by_offset,
                Nat64.compare,
                extent.arena_offset,
            ) != null
        ) Runtime.trap("Duplicate certified-assets allocated extent");
        let capacity = Nat64.fromNat(Nat32.toNat(extent.allocated_capacity));
        let end = checkedAdd(extent.arena_offset, capacity);
        switch (
            Map.reverseEntriesFrom(
                memory.allocated_by_offset,
                Nat64.compare,
                extent.arena_offset,
            ).next()
        ) {
            case (?(priorOffset, prior)) {
                let priorEnd = checkedAdd(
                    priorOffset,
                    Nat64.fromNat(Nat32.toNat(prior.allocated_capacity)),
                );
                if (priorEnd > extent.arena_offset) {
                    Runtime.trap("Certified-assets allocated extent overlap");
                };
            };
            case null {};
        };
        switch (
            Map.entriesFrom(
                memory.allocated_by_offset,
                Nat64.compare,
                extent.arena_offset,
            ).next()
        ) {
            case (?(nextOffset, _)) {
                if (end > nextOffset) {
                    Runtime.trap("Certified-assets allocated extent overlap");
                };
            };
            case null {};
        };
        Map.add(
            memory.allocated_by_offset,
            Nat64.compare,
            extent.arena_offset,
            extent,
        );
    };

    func validateOwned(memory : Types.ArenaMemory, extent : Types.ExtentRef) : () {
        let capacity = Nat32.toNat(extent.allocated_capacity);
        let end = checkedAdd(extent.arena_offset, Nat64.fromNat(capacity));
        if (
            capacity == 0 or
            Nat64.fromNat(capacity) % ARENA_ALIGNMENT_V3 != 0 or
            Nat64.fromNat(capacity) > ARENA_EXTENT_CAPACITY_MAX_V3 or
            extent.arena_offset % ARENA_ALIGNMENT_V3 != 0 or
            end > memory.committed_bytes
        ) Runtime.trap("Invalid certified-assets extent reference");
        if (not hasExactOwnership(memory, extent)) {
            Runtime.trap("Certified-assets extent is not exactly owned");
        };
        let maybeFree = Map.reverseEntriesFrom(
            memory.free_by_offset,
            Nat64.compare,
            checkedAdd(extent.arena_offset, 1),
        ).next();
        switch (maybeFree) {
            case (?(offset, freeExtent)) {
                if (
                    offset <= extent.arena_offset and
                    checkedAdd(offset, freeExtent.capacity) > extent.arena_offset
                ) Runtime.trap("Certified-assets extent is already free");
            };
            case null {};
        };
        switch (
            Map.entriesFrom(
                memory.free_by_offset,
                Nat64.compare,
                extent.arena_offset,
            ).next()
        ) {
            case (?(freeOffset, _)) {
                if (freeOffset < end) {
                    Runtime.trap("Certified-assets extent overlaps free space");
                };
            };
            case null {};
        };
    };

    func normalize(requested : Nat) : Nat {
        ((requested + 15) / 16) * 16;
    };

    func compareSize(
        left : Types.ExtentSizeKey,
        right : Types.ExtentSizeKey,
    ) : Order.Order {
        switch (Nat64.compare(left.capacity, right.capacity)) {
            case (#equal) Nat64.compare(left.arena_offset, right.arena_offset);
            case (order) order;
        };
    };

    func checkedAdd(left : Nat64, right : Nat64) : Nat64 {
        switch (addIfFits(left, right)) {
            case (?sum) sum;
            case null Runtime.trap("Certified-assets Nat64 overflow");
        };
    };

    func addIfFits(left : Nat64, right : Nat64) : ?Nat64 {
        if (left > REGION_GROW_FAILED - right) return null;
        ?(left + right);
    };

    func requireMutationEpoch(memory : Types.ArenaMemory) : () {
        if (memory.mutation_epoch == REGION_GROW_FAILED) {
            Runtime.trap("Certified-assets allocator mutation epoch overflow");
        };
    };

    func bumpMutationEpoch(memory : Types.ArenaMemory) : () {
        requireMutationEpoch(memory);
        memory.mutation_epoch += 1;
    };

    func planAllocate(
        memory : Types.ArenaMemory,
        plan : AllocationPlan,
        need : Nat64,
    ) : ?Types.ExtentRef {
        var candidate = virtualBest(memory, plan, need);
        switch (candidate) {
            case null {
                if (plan.mutation_epoch == REGION_GROW_FAILED) return null;
                let ?newCommitted = addIfFits(
                    plan.committed_bytes,
                    ARENA_GROWTH_QUANTUM_V3,
                ) else return null;
                if (newCommitted > ARENA_CAPACITY_MAX_V3) return null;

                let predecessor = virtualPredecessor(
                    memory,
                    plan,
                    plan.committed_bytes,
                );
                var combinedOffset = plan.committed_bytes;
                var combinedCapacity = ARENA_GROWTH_QUANTUM_V3;
                var coalesced = false;
                switch (predecessor) {
                    case (?prior) {
                        let priorExtent = virtualExtent(prior);
                        let priorEnd = checkedAdd(
                            priorExtent.arena_offset,
                            priorExtent.capacity,
                        );
                        if (priorEnd > plan.committed_bytes) {
                            Runtime.trap("Certified-assets allocator overlap");
                        };
                        if (priorEnd == plan.committed_bytes) {
                            combinedOffset := priorExtent.arena_offset;
                            combinedCapacity := checkedAdd(
                                priorExtent.capacity,
                                ARENA_GROWTH_QUANTUM_V3,
                            );
                            coalesced := true;
                        };
                    };
                    case null {};
                };

                let remaining = combinedCapacity - need;
                let split = remaining >= ARENA_SPLIT_MIN_V3;
                let projected =
                    plan.allocated_extents + plan.free_extents +
                    (if (coalesced) 0 else 1) +
                    (if (split) 1 else 0);
                let allocatedCapacity = if (split) need else combinedCapacity;
                if (
                    projected > MAX_ARENA_EXTENTS_V3 or
                    allocatedCapacity > ARENA_EXTENT_CAPACITY_MAX_V3 or
                    plan.allocated_bytes >
                        ARENA_ALLOCATABLE_CAPACITY_MAX_V3 -
                            allocatedCapacity
                ) return null;

                switch (predecessor) {
                    case (?prior) {
                        if (coalesced) virtualRemove(plan, prior);
                    };
                    case null {};
                };
                plan.committed_bytes := newCommitted;
                plan.mutation_epoch += 1;
                let addedIndex = virtualAdd(plan, {
                    arena_offset = combinedOffset;
                    capacity = combinedCapacity;
                });
                candidate := ?#added({
                    index = addedIndex;
                    extent = {
                        arena_offset = combinedOffset;
                        capacity = combinedCapacity;
                    };
                });
            };
            case (?existing) {
                let freeExtent = virtualExtent(existing);
                let remaining = freeExtent.capacity - need;
                let split = remaining >= ARENA_SPLIT_MIN_V3;
                let allocatedCapacity = if (split) need else freeExtent.capacity;
                if (
                    plan.allocated_extents + plan.free_extents +
                        (if (split) 1 else 0) >
                        MAX_ARENA_EXTENTS_V3 or
                    plan.allocated_bytes >
                        ARENA_ALLOCATABLE_CAPACITY_MAX_V3 -
                            allocatedCapacity
                ) return null;
            };
        };

        let ?selected = candidate else {
            Runtime.trap("Certified-assets allocation planner lost candidate");
        };
        let freeExtent = virtualExtent(selected);
        if (plan.mutation_epoch == REGION_GROW_FAILED) return null;
        let remaining = freeExtent.capacity - need;
        let split = remaining >= ARENA_SPLIT_MIN_V3;
        let allocatedCapacity = if (split) need else freeExtent.capacity;
        virtualRemove(plan, selected);
        if (split) {
            ignore virtualAdd(plan, {
                arena_offset = checkedAdd(freeExtent.arena_offset, need);
                capacity = remaining;
            });
        };
        plan.allocated_bytes += allocatedCapacity;
        plan.allocated_extents += 1;
        plan.mutation_epoch += 1;
        ?{
            arena_offset = freeExtent.arena_offset;
            allocated_capacity = Nat32.fromNat(
                Nat64.toNat(allocatedCapacity)
            );
        };
    };

    func virtualBest(
        memory : Types.ArenaMemory,
        plan : AllocationPlan,
        need : Nat64,
    ) : ?VirtualCandidate {
        var best : ?VirtualCandidate = null;
        let base = Map.entriesFrom(
            memory.free_by_size,
            compareSize,
            { capacity = need; arena_offset = (0 : Nat64) },
        );
        label seekBase loop {
            switch (base.next()) {
                case (?(_, extent)) {
                    if (not baseRemoved(plan, extent)) {
                        best := ?#base(extent);
                        break seekBase;
                    };
                };
                case null { break seekBase };
            };
        };

        var index = 0;
        while (index < plan.added_count) {
            switch (plan.added[index]) {
                case (?extent) {
                    if (extent.capacity >= need) {
                        let next = #added({ index; extent });
                        switch (best) {
                            case (?prior) {
                                if (
                                    compareFree(
                                        extent,
                                        virtualExtent(prior),
                                    ) == #less
                                ) best := ?next;
                            };
                            case null { best := ?next };
                        };
                    };
                };
                case null {};
            };
            index += 1;
        };
        best;
    };

    func virtualPredecessor(
        memory : Types.ArenaMemory,
        plan : AllocationPlan,
        offset : Nat64,
    ) : ?VirtualCandidate {
        var best : ?VirtualCandidate = null;
        let base = Map.reverseEntriesFrom(
            memory.free_by_offset,
            Nat64.compare,
            offset,
        );
        label seekBase loop {
            switch (base.next()) {
                case (?(_, extent)) {
                    if (not baseRemoved(plan, extent)) {
                        best := ?#base(extent);
                        break seekBase;
                    };
                };
                case null { break seekBase };
            };
        };

        var index = 0;
        while (index < plan.added_count) {
            switch (plan.added[index]) {
                case (?extent) {
                    if (extent.arena_offset <= offset) {
                        let next = #added({ index; extent });
                        switch (best) {
                            case (?prior) {
                                if (
                                    extent.arena_offset >
                                    virtualExtent(prior).arena_offset
                                ) best := ?next;
                            };
                            case null { best := ?next };
                        };
                    };
                };
                case null {};
            };
            index += 1;
        };
        best;
    };

    func virtualExtent(candidate : VirtualCandidate) : Types.FreeExtent {
        switch (candidate) {
            case (#base(extent)) extent;
            case (#added(value)) value.extent;
        };
    };

    func virtualRemove(
        plan : AllocationPlan,
        candidate : VirtualCandidate,
    ) : () {
        switch (candidate) {
            case (#base(extent)) {
                if (baseRemoved(plan, extent)) {
                    Runtime.trap("Certified-assets planner double removal");
                };
                if (plan.removed_base_count >= PLAN_OVERLAY_MAX) {
                    Runtime.trap("Certified-assets planner removal overflow");
                };
                plan.removed_base[plan.removed_base_count] := ?extent;
                plan.removed_base_count += 1;
            };
            case (#added(value)) {
                if (
                    value.index >= plan.added_count or
                    plan.added[value.index] != ?value.extent
                ) {
                    Runtime.trap("Certified-assets planner index mismatch");
                };
                plan.added[value.index] := null;
            };
        };
        if (plan.free_extents == 0) {
            Runtime.trap("Certified-assets planner free-count underflow");
        };
        plan.free_extents -= 1;
    };

    func virtualAdd(
        plan : AllocationPlan,
        extent : Types.FreeExtent,
    ) : Nat {
        if (plan.added_count >= PLAN_OVERLAY_MAX) {
            Runtime.trap("Certified-assets planner addition overflow");
        };
        let index = plan.added_count;
        plan.added[index] := ?extent;
        plan.added_count += 1;
        plan.free_extents += 1;
        index;
    };

    func baseRemoved(
        plan : AllocationPlan,
        extent : Types.FreeExtent,
    ) : Bool {
        var index = 0;
        while (index < plan.removed_base_count) {
            if (plan.removed_base[index] == ?extent) return true;
            index += 1;
        };
        false;
    };

    func compareFree(
        left : Types.FreeExtent,
        right : Types.FreeExtent,
    ) : Order.Order {
        compareSize(
            { capacity = left.capacity; arena_offset = left.arena_offset },
            { capacity = right.capacity; arena_offset = right.arena_offset },
        );
    };

    func invalidAuditPage(scanned : Nat) : AuditPage {
        {
            valid = false;
            complete = false;
            scanned_nodes = scanned;
            partition_valid = null;
            next = null;
        };
    };

    func invalidAllocatedAuditPage(scanned : Nat) : AllocatedAuditPage {
        {
            valid = false;
            complete = false;
            scanned_nodes = scanned;
            ownership_bytes_valid = null;
            next = null;
        };
    };

    func completeAuditPage(
        memory : Types.ArenaMemory,
        freeBytes : Nat64,
        scanned : Nat,
    ) : AuditPage {
        let partition = switch (
            addIfFits(freeBytes, memory.allocated_bytes)
        ) {
            case (?total) total == memory.committed_bytes;
            case null false;
        };
        {
            valid = partition;
            complete = true;
            scanned_nodes = scanned;
            partition_valid = ?partition;
            next = null;
        };
    };

    func completeAllocatedAuditPage(
        memory : Types.ArenaMemory,
        allocatedBytes : Nat64,
        scanned : Nat,
    ) : AllocatedAuditPage {
        let ownershipValid = allocatedBytes == memory.allocated_bytes;
        {
            valid = ownershipValid;
            complete = true;
            scanned_nodes = scanned;
            ownership_bytes_valid = ?ownershipValid;
            next = null;
        };
    };

    func overlapsFree(
        memory : Types.ArenaMemory,
        offset : Nat64,
        end : Nat64,
    ) : Bool {
        switch (
            Map.reverseEntriesFrom(
                memory.free_by_offset,
                Nat64.compare,
                checkedAdd(offset, 1),
            ).next()
        ) {
            case (?(freeOffset, freeExtent)) {
                if (
                    freeOffset <= offset and
                    checkedAdd(freeOffset, freeExtent.capacity) > offset
                ) return true;
            };
            case null {};
        };
        switch (
            Map.entriesFrom(
                memory.free_by_offset,
                Nat64.compare,
                offset,
            ).next()
        ) {
            case (?(freeOffset, _)) {
                if (freeOffset < end) return true;
            };
            case null {};
        };
        false;
    };

    func frozenLayoutValid() : Bool {
        ARENA_GROWTH_QUANTUM_V3 ==
            ARENA_GROWTH_PAGES_V3 * ARENA_PAGE_BYTES_V3 and
        (ARENA_BASE_PAGE_V3 * ARENA_PAGE_BYTES_V3) %
            ARENA_GROWTH_QUANTUM_V3 == 0 and
        ARENA_CAPACITY_MAX_V3 % ARENA_GROWTH_QUANTUM_V3 == 0 and
        ARENA_ALLOCATABLE_CAPACITY_MAX_V3 +
            FRAGMENTATION_RESERVE_V3 == ARENA_CAPACITY_MAX_V3 and
        MAX_NORMALIZED_REQUEST_V3 + ARENA_SPLIT_MIN_V3 - 1 <=
            ARENA_EXTENT_CAPACITY_MAX_V3 and
        ARENA_METADATA_RESERVE_V3 ==
            ARENA_HEADER_METADATA_CHARGE_V3 +
            MAX_ARENA_EXTENTS_V3 *
                ARENA_DESCRIPTOR_METADATA_CHARGE_V3;
    };

    // Motoko library-module initializers only admit static expressions, so
    // these are asserted whenever a fresh arena header is constructed.
    func assertFrozenLayout() : () {
        assert (frozenLayoutValid());
    };

    func assertDescriptorBound(memory : Types.ArenaMemory) : () {
        if (descriptorCount(memory) > MAX_ARENA_EXTENTS_V3) {
            Runtime.trap("Certified-assets extent descriptor overflow");
        };
    };
};
