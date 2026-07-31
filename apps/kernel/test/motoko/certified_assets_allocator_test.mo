import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Region "mo:core/Region";
import Runtime "mo:core/Runtime";
import Allocator "../../backend/certified_assets/Allocator";
import Codec "../../backend/certified_assets/Codec";
import Types "../../backend/certified_assets/Types";

func extent(value : ?Types.ExtentRef) : Types.ExtentRef {
    switch (value) {
        case (?result) result;
        case null Runtime.trap("expected allocated extent");
    };
};

func onlyFree(memory : Types.ArenaMemory) : Types.FreeExtent {
    let entries = Map.entries(memory.free_by_offset);
    let ?(_, result) = entries.next() else {
        Runtime.trap("expected one free extent");
    };
    assert (entries.next() == null);
    result;
};

func bytes(value : Nat8, size : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(size, func(_) { value }));
};

// Frozen V3 layout and accounting constants.
assert (Allocator.ARENA_PAGE_BYTES_V3 == 65_536);
assert (Allocator.ARENA_GROWTH_PAGES_V3 == 32);
assert (Allocator.ARENA_GROWTH_QUANTUM_V3 == 2_097_152);
assert (Allocator.ARENA_BASE_PAGE_V3 == 0);
assert (Allocator.ARENA_ALIGNMENT_V3 == 16);
assert (Allocator.ARENA_SPLIT_MIN_V3 == 256);
assert (Allocator.ARENA_EXTENT_CAPACITY_MAX_V3 == 2_097_152);
assert (Allocator.ARENA_CAPACITY_MAX_V3 == 2_147_483_648);
assert (Allocator.FRAGMENTATION_RESERVE_V3 == 268_435_456);
assert (Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3 == 1_879_048_192);
assert (Allocator.MAX_ARENA_EXTENTS_V3 == 250_000);
assert (Allocator.MAX_ALLOCATION_TRANSACTION_EXTENTS_V3 == 36);
assert (Allocator.MAX_ARENA_AUDIT_PAGE_NODES_V3 == 2_048);
assert (Allocator.ARENA_HEADER_METADATA_CHARGE_V3 == 528);
assert (Allocator.ARENA_DESCRIPTOR_METADATA_CHARGE_V3 == 288);
assert (Allocator.ARENA_METADATA_RESERVE_V3 == 72_000_528);
assert (
    Codec.hex(Allocator.layoutFingerprint()) ==
    "61a26c482fbbd5ed3b0a0715baaf0f646cbedfbe9f3299eed1491474bb13f8c5"
);

// Initialization, alignment, split, exact byte I/O, and full coalescing.
let memory = Allocator.init();
let initialDiagnostics = Allocator.diagnostics(memory);
assert (initialDiagnostics.header_valid);
assert (initialDiagnostics.mutation_epoch == 0);
assert (initialDiagnostics.committed_high_water_bytes == 0);
assert (initialDiagnostics.allocated_bytes == 0);
assert (initialDiagnostics.allocated_extents == 0);
assert (initialDiagnostics.free_extents == 0);
assert (initialDiagnostics.descriptor_count == 0);
assert (
    initialDiagnostics.descriptor_limit == Allocator.MAX_ARENA_EXTENTS_V3
);
assert (
    initialDiagnostics.capacity_limit_bytes ==
        Allocator.ARENA_CAPACITY_MAX_V3
);
assert (
    initialDiagnostics.allocatable_limit_bytes ==
        Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3
);
assert (
    initialDiagnostics.allocatable_headroom_bytes ==
        Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3
);
assert (
    initialDiagnostics.metadata_charge_bytes ==
        Allocator.ARENA_HEADER_METADATA_CHARGE_V3
);
assert (memory.mutation_epoch == 0);
assert (Allocator.validateHeader(memory));
assert (Allocator.validate(memory));
assert (Region.size(memory.region) == 0);
assert (Allocator.metadataCharge(memory) == 528);
assert (Allocator.allocate(memory, 0) == null);
assert (
    Allocator.allocate(
        memory,
        Allocator.STAGE_EXTENT_BYTES_MAX + 1,
    ) == null
);
assert (memory.committed_bytes == 0);
assert (Allocator.canAllocateMany(memory, [17, 0, 33]));
assert (memory.committed_bytes == 0);
assert (memory.allocated_bytes == 0);
assert (memory.mutation_epoch == 0);
assert (
    not Allocator.canAllocateMany(
        memory,
        [Allocator.STAGE_EXTENT_BYTES_MAX + 1],
    )
);

let first = extent(Allocator.allocate(memory, 17));
assert (first.arena_offset == 0);
assert (first.allocated_capacity == (32 : Nat32));
assert (memory.committed_bytes == 2_097_152);
assert (Region.size(memory.region) == 32);
assert (memory.allocated_bytes == 32);
assert (Allocator.descriptorCount(memory) == 2);
assert (Allocator.metadataCharge(memory) == 1_104);
assert (Map.size(memory.allocated_by_offset) == 1);
assert (Allocator.hasExactOwnership(memory, first));
assert (memory.mutation_epoch == 2);
assert (Allocator.validate(memory));
let allocatedDiagnostics = Allocator.diagnostics(memory);
assert (allocatedDiagnostics.header_valid);
assert (allocatedDiagnostics.mutation_epoch == 2);
assert (allocatedDiagnostics.committed_high_water_bytes == 2_097_152);
assert (allocatedDiagnostics.allocated_bytes == 32);
assert (allocatedDiagnostics.allocated_extents == 1);
assert (allocatedDiagnostics.free_extents == 1);
assert (allocatedDiagnostics.descriptor_count == 2);
assert (allocatedDiagnostics.metadata_charge_bytes == 1_104);

let payload = bytes(0x5a, 17);
Allocator.write(memory, first, payload);
assert (Allocator.read(memory, first, 17) == ?payload);
Allocator.writeAt(memory, first, 8, bytes(0xa5, 8));
assert (Allocator.readAt(memory, first, 8, 8) == ?bytes(0xa5, 8));

let second = extent(Allocator.allocate(memory, 17));
assert (second.arena_offset == 32);
assert (second.allocated_capacity == (32 : Nat32));
assert (memory.mutation_epoch == 3);
Allocator.free(memory, first);
assert (not Allocator.hasExactOwnership(memory, first));
Allocator.free(memory, second);
assert (memory.mutation_epoch == 5);
assert (memory.allocated_bytes == 0);
assert (memory.allocated_extents == 0);
assert (Allocator.descriptorCount(memory) == 1);
let whole = onlyFree(memory);
assert (whole.arena_offset == 0);
assert (whole.capacity == 2_097_152);
assert (Allocator.validate(memory));
let releasedDiagnostics = Allocator.diagnostics(memory);
assert (releasedDiagnostics.header_valid);
assert (releasedDiagnostics.committed_high_water_bytes == 2_097_152);
assert (releasedDiagnostics.allocated_bytes == 0);
assert (releasedDiagnostics.allocated_extents == 0);
assert (releasedDiagnostics.free_extents == 1);
assert (releasedDiagnostics.descriptor_count == 1);

// The explicit audit is cursor-bounded, cross-checks both indexes, and proves
// the final free+allocated byte partition without using the eager validator.
let paged = Allocator.init();
let pageBody0 = extent(Allocator.allocate(paged, 256));
let pageGuard0 = extent(Allocator.allocate(paged, 16));
let pageBody1 = extent(Allocator.allocate(paged, 256));
let pageGuard1 = extent(Allocator.allocate(paged, 16));
let pageBody2 = extent(Allocator.allocate(paged, 256));
let pageGuard2 = extent(Allocator.allocate(paged, 16));
Allocator.free(paged, pageBody0);
Allocator.free(paged, pageBody1);
Allocator.free(paged, pageBody2);
assert (Allocator.validateHeader(paged));
let zeroPage = Allocator.auditPage(paged, null, 0);
assert (zeroPage.valid);
assert (not zeroPage.complete);
assert (zeroPage.scanned_nodes == 0);
let page1 = Allocator.auditPage(paged, zeroPage.next, 2);
assert (page1.valid);
assert (not page1.complete);
assert (page1.scanned_nodes == 2);
assert (page1.partition_valid == null);
let page2 = Allocator.auditPage(paged, page1.next, 50_000);
assert (page2.valid);
assert (page2.complete);
assert (page2.scanned_nodes == 2);
assert (page2.partition_valid == ?true);
assert (page2.next == null);
let ownedPage1 = Allocator.auditAllocatedPage(paged, null, 2);
assert (ownedPage1.valid);
assert (not ownedPage1.complete);
assert (ownedPage1.scanned_nodes == 2);
let ownedPage2 = Allocator.auditAllocatedPage(
    paged,
    ownedPage1.next,
    50_000,
);
assert (ownedPage2.valid);
assert (ownedPage2.complete);
assert (ownedPage2.scanned_nodes == 1);
assert (ownedPage2.ownership_bytes_valid == ?true);
Allocator.free(paged, pageGuard0);
Allocator.free(paged, pageGuard1);
Allocator.free(paged, pageGuard2);
assert (Allocator.validate(paged));

let emptyAudit = Allocator.auditPage(Allocator.init(), null, 2_048);
assert (emptyAudit.valid);
assert (emptyAudit.complete);
assert (emptyAudit.scanned_nodes == 0);
assert (emptyAudit.partition_valid == ?true);
let emptyOwnedAudit = Allocator.auditAllocatedPage(
    Allocator.init(),
    null,
    2_048,
);
assert (emptyOwnedAudit.valid);
assert (emptyOwnedAudit.complete);
assert (emptyOwnedAudit.ownership_bytes_valid == ?true);

// Any scalar allocation change invalidates an in-progress cursor.
let staleAudit = Allocator.init();
let stale0 = extent(Allocator.allocate(staleAudit, 256));
let staleGuard = extent(Allocator.allocate(staleAudit, 16));
Allocator.free(staleAudit, stale0);
let stalePage = Allocator.auditPage(staleAudit, null, 1);
assert (stalePage.valid and not stalePage.complete);
let staleMutation = extent(Allocator.allocate(staleAudit, 32));
let staleResult = Allocator.auditPage(staleAudit, stalePage.next, 1);
assert (not staleResult.valid);
assert (not staleResult.complete);
assert (staleResult.next == null);
Allocator.free(staleAudit, staleMutation);
Allocator.free(staleAudit, staleGuard);

// Epoch snapshots reject a cursor even when an exact free/reallocate restores
// every byte/count/index scalar to its previous value.
let epochStale = Allocator.init();
ignore Allocator.allocate(epochStale, 256);
let epochExtent = extent(Allocator.allocate(epochStale, 16));
let epochCursor = Allocator.auditPage(epochStale, null, 0);
let epochBytes = epochStale.allocated_bytes;
let epochCount = epochStale.allocated_extents;
let epochFreeCount = Map.size(epochStale.free_by_offset);
Allocator.free(epochStale, epochExtent);
let epochReplacement = extent(Allocator.allocate(epochStale, 16));
assert (epochReplacement == epochExtent);
assert (epochStale.allocated_bytes == epochBytes);
assert (epochStale.allocated_extents == epochCount);
assert (Map.size(epochStale.free_by_offset) == epochFreeCount);
let epochRejected = Allocator.auditPage(
    epochStale,
    epochCursor.next,
    1,
);
assert (not epochRejected.valid);

// Header checks are intentionally O(1); the page audit detects a scalar-valid
// but impossible byte partition at completion.
let badPartition = Allocator.init();
let badSeed = extent(Allocator.allocate(badPartition, 16));
badPartition.allocated_bytes := 32;
assert (Allocator.validateHeader(badPartition));
let badAudit = Allocator.auditPage(badPartition, null, 2_048);
assert (badAudit.complete);
assert (not badAudit.valid);
assert (badAudit.partition_valid == ?false);
let badOwnedAudit = Allocator.auditAllocatedPage(
    badPartition,
    null,
    2_048,
);
assert (badOwnedAudit.complete);
assert (not badOwnedAudit.valid);
assert (badOwnedAudit.ownership_bytes_valid == ?false);
assert (not Allocator.validate(badPartition));

// Exact ownership rejects fabricated subextents and same-offset descriptors.
let exactOwnership = Allocator.init();
let exactlyOwned = extent(Allocator.allocate(exactOwnership, 256));
let forgedSubextent : Types.ExtentRef = {
    arena_offset = exactlyOwned.arena_offset + 16;
    allocated_capacity = (240 : Nat32);
};
let forgedCapacity : Types.ExtentRef = {
    arena_offset = exactlyOwned.arena_offset;
    allocated_capacity = (128 : Nat32);
};
assert (Allocator.hasExactOwnership(exactOwnership, exactlyOwned));
assert (not Allocator.hasExactOwnership(exactOwnership, forgedSubextent));
assert (not Allocator.hasExactOwnership(exactOwnership, forgedCapacity));
Allocator.free(exactOwnership, exactlyOwned);
assert (not Allocator.hasExactOwnership(exactOwnership, exactlyOwned));

// Corrupt duplicate/overlap fixtures are rejected by the header/full audits.
let duplicateOwnership = Allocator.init();
let duplicateOriginal = extent(Allocator.allocate(duplicateOwnership, 256));
Map.add(
    duplicateOwnership.allocated_by_offset,
    Nat64.compare,
    duplicateOriginal.arena_offset,
    {
        arena_offset = duplicateOriginal.arena_offset;
        allocated_capacity = (128 : Nat32);
    },
);
assert (Allocator.validateHeader(duplicateOwnership));
assert (not Allocator.validate(duplicateOwnership));

let overlappingOwnership = Allocator.init();
ignore Allocator.allocate(overlappingOwnership, 256);
let overlapping : Types.ExtentRef = {
    arena_offset = 128;
    allocated_capacity = (16 : Nat32);
};
Map.add(
    overlappingOwnership.allocated_by_offset,
    Nat64.compare,
    overlapping.arena_offset,
    overlapping,
);
overlappingOwnership.allocated_extents += 1;
overlappingOwnership.allocated_bytes += 16;
assert (Allocator.validateHeader(overlappingOwnership));
assert (not Allocator.validate(overlappingOwnership));

// Deterministic best fit uses the lower address to break equal-capacity ties.
let bestFit = Allocator.init();
let low = extent(Allocator.allocate(bestFit, 256));
let guard1 = extent(Allocator.allocate(bestFit, 16));
let high = extent(Allocator.allocate(bestFit, 256));
let guard2 = extent(Allocator.allocate(bestFit, 16));
Allocator.free(bestFit, low);
Allocator.free(bestFit, high);
let picked = extent(Allocator.allocate(bestFit, 240));
assert (picked.arena_offset == low.arena_offset);
// A remainder below 256 is charged as part of the allocated extent.
assert (picked.allocated_capacity == (256 : Nat32));
Allocator.free(bestFit, picked);
Allocator.free(bestFit, guard1);
Allocator.free(bestFit, guard2);
assert (onlyFree(bestFit).capacity == 2_097_152);
assert (Allocator.validate(bestFit));

// Exactly 256 bytes is split; 240 bytes is absorbed into the allocation.
let split = Allocator.init();
let splitLarge = extent(Allocator.allocate(split, 1_900_000));
let splitExact = extent(Allocator.allocate(split, 196_896));
assert (splitExact.allocated_capacity == (196_896 : Nat32));
assert (onlyFree(split).capacity == 256);
Allocator.free(split, splitExact);
Allocator.free(split, splitLarge);
assert (onlyFree(split).capacity == 2_097_152);
assert (Allocator.validate(split));

let absorb = Allocator.init();
let absorbLarge = extent(Allocator.allocate(absorb, 1_900_000));
let absorbFinal = extent(Allocator.allocate(absorb, 196_912));
assert (absorbFinal.allocated_capacity == (197_152 : Nat32));
assert (Map.size(absorb.free_by_offset) == 0);
Allocator.free(absorb, absorbFinal);
Allocator.free(absorb, absorbLarge);
assert (Allocator.validate(absorb));

// Growth merges the old end-tail before retrying, leaving one free
// descriptor instead of adjacent quantum descriptors.
let growth = Allocator.init();
let growthFirst = extent(Allocator.allocate(growth, 1_900_000));
let growthSecond = extent(Allocator.allocate(growth, 1_048_576));
assert (growthSecond.arena_offset == 1_900_000);
assert (growth.committed_bytes == 4_194_304);
assert (Map.size(growth.free_by_offset) == 1);
assert (Allocator.descriptorCount(growth) == 3);
assert (Allocator.validate(growth));
Allocator.free(growth, growthSecond);
Allocator.free(growth, growthFirst);
assert (onlyFree(growth).capacity == 4_194_304);
assert (Allocator.validate(growth));

// A multi-extent reservation preserves canonical order and the zero-length
// special case. Invalid input is rejected before any arena mutation.
let batch = Allocator.init();
let ?reserved = Allocator.allocateMany(batch, [31, 0, 33]) else {
    Runtime.trap("expected multi-extent reservation");
};
assert (reserved.size() == 3);
let batch0 = extent(reserved[0]);
assert (reserved[1] == null);
let batch2 = extent(reserved[2]);
assert (batch0.arena_offset == 0);
assert (batch0.allocated_capacity == (32 : Nat32));
assert (batch2.arena_offset == 32);
assert (batch2.allocated_capacity == (48 : Nat32));
assert (batch.allocated_bytes == 80);
assert (batch.mutation_epoch == 3);
assert (Allocator.validate(batch));
Allocator.free(batch, batch2);
Allocator.free(batch, batch0);
assert (Allocator.validate(batch));

// A fresh maximum transaction exercises the planner's worst-case two overlay
// additions per extent while remaining within the aggregate 64 MiB geometry.
let maximumTransaction = Allocator.init();
let maximumTransactionLengths = Array.tabulate<Nat>(
    Allocator.MAX_ALLOCATION_TRANSACTION_EXTENTS_V3,
    func(index) {
        if (
            index + 1 ==
            Allocator.MAX_ALLOCATION_TRANSACTION_EXTENTS_V3
        ) {
            608_864;
        } else {
            Allocator.STAGE_EXTENT_BYTES_MAX;
        };
    },
);
assert (
    Allocator.canAllocateMany(
        maximumTransaction,
        maximumTransactionLengths,
    )
);
assert (maximumTransaction.committed_bytes == 0);
let ?maximumTransactionExtents = Allocator.allocateMany(
    maximumTransaction,
    maximumTransactionLengths,
) else {
    Runtime.trap("expected maximum 36-extent reservation");
};
assert (
    maximumTransactionExtents.size() ==
    Allocator.MAX_ALLOCATION_TRANSACTION_EXTENTS_V3
);
assert (
    maximumTransaction.allocated_extents ==
    Allocator.MAX_ALLOCATION_TRANSACTION_EXTENTS_V3
);
assert (maximumTransaction.committed_bytes == 67_108_864);
assert (maximumTransaction.allocated_bytes == 67_108_864);
assert (Map.size(maximumTransaction.free_by_offset) == 0);
assert (Allocator.descriptorCount(maximumTransaction) == 36);
assert (maximumTransaction.mutation_epoch == 68);
assert (Allocator.validate(maximumTransaction));
for (maybeExtent in maximumTransactionExtents.vals()) {
    let ?allocatedExtent = maybeExtent else {
        Runtime.trap("expected nonempty transaction extent");
    };
    Allocator.free(maximumTransaction, allocatedExtent);
};
assert (maximumTransaction.allocated_bytes == 0);
assert (onlyFree(maximumTransaction).capacity == 67_108_864);
assert (Allocator.validate(maximumTransaction));

let rejected = Allocator.init();
assert (
    Allocator.allocateMany(
        rejected,
        [16, Allocator.STAGE_EXTENT_BYTES_MAX + 1],
    ) == null
);
assert (
    Allocator.allocateMany(
        rejected,
        Array.repeat<Nat>(
            16,
            Allocator.MAX_ALLOCATION_TRANSACTION_EXTENTS_V3 + 1,
        ),
    ) == null
);
assert (rejected.committed_bytes == 0);
assert (rejected.allocated_bytes == 0);
assert (Region.size(rejected.region) == 0);
assert (Allocator.validate(rejected));

let exhaustedEpoch = Allocator.init();
exhaustedEpoch.mutation_epoch := 18_446_744_073_709_551_615;
assert (Allocator.allocate(exhaustedEpoch, 16) == null);
assert (exhaustedEpoch.committed_bytes == 0);
assert (Region.size(exhaustedEpoch.region) == 0);

// Synthetic near-ceiling headers exercise failure ordering without creating
// 250,000 bodies. A candidate that cannot legally split must not trigger
// arena growth, and a later multi-allocation failure is found by the virtual
// plan before the first real allocation or Region.grow.
let descriptorBound = Allocator.init();
let descriptorSeed = extent(Allocator.allocate(descriptorBound, 16));
Allocator.free(descriptorBound, descriptorSeed);
descriptorBound.allocated_extents :=
    Allocator.MAX_ARENA_EXTENTS_V3 - 1;
let descriptorCommitted = descriptorBound.committed_bytes;
let descriptorPages = Region.size(descriptorBound.region);
assert (Allocator.allocate(descriptorBound, 16) == null);
assert (descriptorBound.committed_bytes == descriptorCommitted);
assert (Region.size(descriptorBound.region) == descriptorPages);

let atomicPlan = Allocator.init();
atomicPlan.allocated_extents := Allocator.MAX_ARENA_EXTENTS_V3 - 2;
assert (Allocator.allocateMany(atomicPlan, [16, 16]) == null);
assert (atomicPlan.committed_bytes == 0);
assert (atomicPlan.allocated_bytes == 0);
assert (
    atomicPlan.allocated_extents == Allocator.MAX_ARENA_EXTENTS_V3 - 2
);
assert (Map.size(atomicPlan.free_by_offset) == 0);
assert (Region.size(atomicPlan.region) == 0);

// Header validation cross-checks persisted byte counters against Region size.
let corruptHeader = Allocator.init();
corruptHeader.committed_bytes := Allocator.ARENA_GROWTH_QUANTUM_V3;
assert (not Allocator.validateHeader(corruptHeader));
assert (not Allocator.validate(corruptHeader));
