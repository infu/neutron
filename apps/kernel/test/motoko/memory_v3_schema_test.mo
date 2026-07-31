import Text "mo:core/Text";
import Map "mo:core/Map";
import Allocator "../../backend/certified_assets/Allocator";
import AuthenticatedForest "../../backend/certified_assets/AuthenticatedForest";
import AssetTypes "../../backend/certified_assets/Types";
import CapabilityTypes "../../backend/capabilities/Types";
import CertifiedHttpV2 "../../backend/certified_http_v2";
import MemoryV3 "../../backend/memory/kernel/v3";

// These assignments deliberately go in both directions. Any field, mutability,
// nested variant, map key/value, or Region representation drift between the
// service model and the frozen kernel V3 schema makes this test fail to typecheck.
func asServiceMemory(
    memory : MemoryV3.CertifiedAssetsMemory,
) : AssetTypes.Memory {
    memory;
};

func asStableMemory(
    memory : AssetTypes.Memory,
) : MemoryV3.CertifiedAssetsMemory {
    memory;
};

func asRuntimeAppInstance(
    instance : MemoryV3.AppInstance,
) : CapabilityTypes.AppInstance {
    instance;
};

func asStableAppInstance(
    instance : CapabilityTypes.AppInstance,
) : MemoryV3.AppInstance {
    instance;
};

func asServiceCapabilityRegistry(
    memory : MemoryV3.CapabilityRegistryMemory,
) : CapabilityTypes.CapabilityRegistryMemory {
    memory;
};

func asStableCapabilityRegistry(
    memory : CapabilityTypes.CapabilityRegistryMemory,
) : MemoryV3.CapabilityRegistryMemory {
    memory;
};

let serviceCapabilityRegistry = asServiceCapabilityRegistry({
    entries = Map.empty<Text, MemoryV3.CapabilityRegistryEntry>();
});
let stableCapabilityRegistry = asStableCapabilityRegistry(
    serviceCapabilityRegistry
);

let appInstance : MemoryV3.AppInstance = {
    scope = { app_id = "sample"; installation_uid = 1 };
    version = 1;
    deployment_id = "deployment";
    capability_plan_fingerprint = "plan";
    resident_frame_security = #credentialless_ephemeral_dedicated_v1;
    browser_origin_nonce = "nonce";
    browser_origin_authority_epoch = 1;
};
let runtimeAppInstance = asRuntimeAppInstance(appInstance);
let stableAppInstance = asStableAppInstance(runtimeAppInstance);

// Do not call MemoryV3.init() here: moc's native interpreter deliberately
// cannot execute Region.new. The bidirectional assignments above still lock
// every field and nested type, while the allocator's compiled WASI test covers
// Region initialization and its zero-state counters.
let stableForest = MemoryV3.initAuthenticatedForest();
switch (
    AuthenticatedForest.validateAndRestore(
        stableForest,
        Text.encodeUtf8(
            CertifiedHttpV2.responsePolicyTableCanonicalV1(),
        ),
        Allocator.layoutFingerprint(),
    )
) {
    case (#ok(_)) {};
    case (#err(_)) assert false;
};
assert (
    stableAppInstance.resident_frame_security ==
    #credentialless_ephemeral_dedicated_v1
);
assert (Map.size(stableCapabilityRegistry.entries) == 0);
