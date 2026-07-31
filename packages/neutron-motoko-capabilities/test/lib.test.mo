import Caps "../src/lib";

type NarrowEnvironment = {
    capabilities : {
        deferred_timers : Caps.DeferredTimersV1;
        backend_calls : Caps.BackendCallsV1;
        randomness : Caps.RandomnessV1;
        chain_key_signing : Caps.ChainKeySigningV1;
        stable_store : Caps.StableStoreV1;
        https_outcalls : Caps.HttpsOutcallsV1;
        vetkeys_public : Caps.VetKeysPublicV1;
        certified_assets : Caps.CertifiedAssetsV2;
        public_ingress_cycles : Caps.PublicIngressCyclesV1;
    };
};

func _request(canister : Principal) : Caps.BackendCallRequestV1 {
    {
        canister;
        method = "icrc1_fee";
        args = "";
        cycles = 0;
    };
};
let _timerResult : Caps.DeferredTimerArmResultV1 = #err(#full);
let _result : Caps.RandomnessResultV1 = #err(#busy);
let _chainKeyAlgorithm : Caps.ChainKeyAlgorithmV1 = #schnorr_ed25519;
let _chainKeyMessageFormat : Caps.ChainKeyMessageFormatV1 =
    #neutron_app_assertion_v1;
let _chainKeyPublicKey : Caps.ChainKeyPublicKeyV1 = {
    slot = "receipts";
    algorithm = #schnorr_ed25519;
    public_key = "public";
    key_fingerprint = "fingerprint";
    signing_domain = "domain";
    namespace_version = 1;
    message_format = #neutron_app_assertion_v1;
};
let _chainKeySignature : Caps.ChainKeySignatureV1 = {
    slot = "receipts";
    algorithm = #schnorr_ed25519;
    digest = "digest";
    signature = "signature";
    signing_domain = "domain";
    message_format = #neutron_app_assertion_v1;
};
let _chainKeyRequest : Caps.ChainKeySignAssertionRequestV1 = {
    slot = "receipts";
    assertion = "receipt";
};
let _chainKeyPublicResult : Caps.ChainKeyPublicKeyResultV1 =
    #ok(_chainKeyPublicKey);
let _chainKeySignatureResult : Caps.ChainKeySignatureResultV1 =
    #ok(_chainKeySignature);
let _chainKeyUnknown : Caps.ChainKeySignatureResultV1 =
    #err(#outcome_unknown);
let _stableStoreCondition : Caps.StableStoreConditionV1 = #if_revision(4);
let _stableStoreCursor : Caps.StableStoreCursorV1 = {
    namespace_uid = 8;
    prefix = "note/";
    after = "note/b";
};
let _stableStoreEntry : Caps.StableStoreEntryV1 = {
    key = "note/a";
    value = "hello";
    revision = 4;
    schema_version = 2;
};
let _stableStoreUsage : Caps.StableStoreUsageV1 = {
    store = "notes";
    schema_version = 2;
    entries = 1;
    bytes = 11;
    max_entries = 16;
    max_bytes = 4_096;
    over_quota = false;
};
let _stableStoreGet : Caps.StableStoreGetResultV1 = #ok(?_stableStoreEntry);
let _stableStorePut : Caps.StableStorePutResultV1 = #ok({
    revision = 5;
    schema_version = 2;
    usage = _stableStoreUsage;
});
let _stableStoreDelete : Caps.StableStoreDeleteResultV1 = #ok(_stableStoreUsage);
let _stableStoreList : Caps.StableStoreListResultV1 = #ok({
    entries = [_stableStoreEntry];
    next = ?_stableStoreCursor;
    observed_revision = 5;
});
let _stableStoreClear : Caps.StableStoreClearPageResultV1 = #ok({
    removed_entries = 1;
    removed_bytes = 11;
    more = false;
    usage = _stableStoreUsage;
});
let _stableStoreConflict : Caps.StableStorePutResultV1 =
    #err(#conflict({ current_revision = ?5 }));
let _httpsRequest : Caps.HttpsOutcallRequestV1 = {
    endpoint = "example";
    method = #get;
    path = "v1/status";
    query_params = [("format", "short")];
    headers = [{ name = "accept"; value = "application/json" }];
    body = "";
    idempotency_key = null;
};
let _httpsResult : Caps.HttpsOutcallResultV1 =
    #err(#cost_too_high);
let _certifiedResult : Caps.RecordStatusResult = #err(#not_found);
let _publicIngressCycles : Caps.PublicIngressCyclesV1 = {
    available = func() : Nat { 10_000_000 };
    request = func(_amount : Nat) : () {};
};
let _publicIngressRequest : Caps.PublicIngressRequestV1 = {
    method = "status";
    payload = "candid";
};
let _publicIngressResult : Caps.PublicIngressResultV1 = #err(#rate_limited);
let _httpPostUpdateHandlerRequest : Caps.HttpPostUpdateHandlerRequestV1 = {
    path = "/item";
    headers = [("content-type", "application/json")];
    body = "{}";
    request_id_hash = "digest";
};
let _httpPostUpdateHandlerResponse : Caps.HttpPostUpdateHandlerResponseV1 = {
    status = #created;
    content_type = "application/json";
    body = "{}";
};
let _environment : ?NarrowEnvironment = null;

switch (_environment) {
    case (null) {};
    case (?_) assert false;
};
