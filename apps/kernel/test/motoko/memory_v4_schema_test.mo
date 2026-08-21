import Map "mo:core/Map";
import CapabilityTypes "../../backend/capabilities/Types";
import MediaTypes "../../backend/media_sessions/Types";
import MemoryV4 "../../backend/memory/kernel/v4";

// Bidirectional assignments pin the mutable fields, map key/value types, and
// capability variant used by the live services to the released V4 schema.
func asServiceMedia(memory : MemoryV4.MediaSessionsMemory) : MediaTypes.Memory { memory };
func asStableMedia(memory : MediaTypes.Memory) : MemoryV4.MediaSessionsMemory { memory };
func asServiceRegistry(memory : MemoryV4.CapabilityRegistryMemory) : CapabilityTypes.CapabilityRegistryMemory { memory };
func asStableRegistry(memory : CapabilityTypes.CapabilityRegistryMemory) : MemoryV4.CapabilityRegistryMemory { memory };

let serviceMedia = asServiceMedia({
    var next_session_id = 1;
    var authority_epoch = 1;
    var active_session_id = null;
    leases = Map.empty<Text, MemoryV4.MediaLease>();
});
let stableMedia = asStableMedia(serviceMedia);
let serviceRegistry = asServiceRegistry({ entries = Map.empty<Text, MemoryV4.CapabilityRegistryEntry>() });
let stableRegistry = asStableRegistry(serviceRegistry);

assert (stableMedia.active_session_id == null);
assert (Map.size(stableMedia.leases) == 0);
assert (Map.size(stableRegistry.entries) == 0);
