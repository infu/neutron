import Caps "mo:neutron-capabilities";
import Types "../../backend/certified_assets/Types";

// Both assignments must continue to compile. They make the public leaf package
// the type authority and catch accidental backend-only copies or field drift.
let _backendToPublic : Types.CertifiedAssetsV2 -> Caps.CertifiedAssetsV2 =
    func(value) { value };
let _publicToBackend : Caps.CertifiedAssetsV2 -> Types.CertifiedAssetsV2 =
    func(value) { value };

let _backendLimitsToPublic : Types.Limits -> Caps.Limits =
    func(value) { value };
let _publicLimitsToBackend : Caps.Limits -> Types.Limits =
    func(value) { value };

let _backendUsageToPublic : Types.UsageCounters -> Caps.UsageCounters =
    func(value) { value };
let _publicUsageToBackend : Caps.UsageCounters -> Types.UsageCounters =
    func(value) { value };
