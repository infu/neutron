import NeutronCapabilities "mo:neutron-capabilities";

module {
    public type CallRequest = NeutronCapabilities.BackendCallRequestV1;
    public type CallError = NeutronCapabilities.BackendCallErrorV1;
    public type CallResult = NeutronCapabilities.BackendCallResultV1;
    public type BackendCalls = NeutronCapabilities.BackendCallsV1;
    public type PublicIngressRequest = NeutronCapabilities.PublicIngressRequestV1;
    public type PublicIngressResult = NeutronCapabilities.PublicIngressResultV1;
    public type VetKeySlotStatus = NeutronCapabilities.VetKeySlotStatusV1;
    public type VetKeyGenerationStatus = NeutronCapabilities.VetKeyGenerationStatusV1;
    public type VetKeyEnvironment = NeutronCapabilities.VetKeyEnvironmentV1;
    public type VetKeyGenerationSummary = NeutronCapabilities.VetKeyGenerationSummaryV1;
    public type VetKeySlotSummary = NeutronCapabilities.VetKeySlotSummaryV1;
    public type VetKeyPublicInfo = NeutronCapabilities.VetKeyPublicKeyInfoV1;
    public type VetKeyError = NeutronCapabilities.VetKeysPublicErrorV1;
    public type VetKeyPublicResult = NeutronCapabilities.VetKeyPublicKeyResultV1;

    // Public-key discovery is deliberately the only backend vetKeys handle.
    // Transport secrets, derivation, management calls, key names and cycle
    // selection remain outside an app backend's authority.
    public type VetKeysPublic = NeutronCapabilities.VetKeysPublicV1;
};
