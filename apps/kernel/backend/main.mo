import Painless "./lib/Painless";
import IC "./aaa_interface";
import ConnectionsMemory "./connections/Memory";
import ConnectionsService "./connections/Service";
import ConnectionTypes "./connections/Types";
import InstallMemory "./install/Memory";
import InstallService "./install/Service";
import InstallTypes "./install/Types";
import FrontendRuntimeAdmission "./frontend_runtime/Admission";
import BackendCallsService "./backend_calls/Service";
import BackendCallsRaw "./backend_calls/Raw";
import BackendCallTypes "./backend_calls/Types";
import RandomnessAdapter "./randomness/Adapter";
import RandomnessService "./randomness/Service";
import RandomnessTypes "./randomness/Types";
import HttpsOutcallsAdapter "./https_outcalls/Adapter";
import HttpsOutcallsService "./https_outcalls/Service";
import HttpsOutcallsTypes "./https_outcalls/Types";
import ChainKeySigningAdapter "./chain_key_signing/Adapter";
import ChainKeySigningService "./chain_key_signing/Service";
import ChainKeySigningTypes "./chain_key_signing/Types";
import StableStoreService "./stable_store/Service";
import StableStoreTypes "./stable_store/Types";
import SettingsService "./settings/Service";
import SettingsAccess "./settings/Access";
import SettingsTypes "./settings/Types";
import SchedulerService "./scheduler/Service";
import SchedulerTypes "./scheduler/Types";
import VetKeysAdapter "./vetkeys/Adapter";
import VetKeysService "./vetkeys/Service";
import VetKeyTypes "./vetkeys/Types";
import CapabilityRegistry "./capabilities/Registry";
import CapabilityScope "./capabilities/Scope";
import CapabilityTypes "./capabilities/Types";
import AppUsageService "./app_usage/Service";
import AppUsageTypes "./app_usage/Types";
import CertifiedAssetsService "./certified_assets/Service";
import CertifiedAssetsTypes "./certified_assets/Types";
import HttpPostUpdateHandlersService "./http_post_update_handlers/Service";
import HttpPostUpdateHandlersTypes "./http_post_update_handlers/Types";
import PublicIngressService "./public_ingress/Service";
import PublicIngressTypes "./public_ingress/Types";
import GatewayAuthority "./http_routes/GatewayAuthority";
import RouteNamespace "./http_routes/Namespace";
import KernelMemory "./memory/kernel/v3";
import ActivationMemory "./memory/activation/v1";
import ActivationService "./activation/Service";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Int "mo:core/Int";
import InternetComputer "mo:core/InternetComputer";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Prim "mo:prim";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import VarArray "mo:core/VarArray";
// import AP "./apps";
import Cert "./certified_http";
import CertV2 "./certified_http_v2";
import Assets "./assets";

module {
    let MAX_STATIC_LIST_KEYS = 20_000;
    let MAX_INSTALL_WASM_CHUNK_BYTES = 1_048_576;
    let MAX_INSTALL_WASM_CHUNKS = 100;
    let SHA256_BYTES = 32;
    let MAX_HTTP_URL_BYTES = 8_192;
    let MAX_HTTP_PATH_SEGMENTS =
        CertV2.CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2;
    let MAX_HTTP_HEADERS = 64;
    let MAX_HTTP_HEADER_BYTES = 16_384;
    let LOWER_HEX_DIGITS : [Text] = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f",
    ];
    public type AuthSet = Set.Set<Principal>;
    public type BackendCallsCapability = BackendCallTypes.Capability;
    public type RandomnessCapability = RandomnessTypes.Capability;
    public type HttpsOutcallsCapability = HttpsOutcallsTypes.Capability;
    public type ChainKeySigningCapability = ChainKeySigningTypes.Capability;
    public type StableStoreCapability = StableStoreTypes.Capability;
    public type CertifiedAssetsCapability = CertifiedAssetsTypes.Capability;
    public type DeferredTimersV1 = SchedulerTypes.DeferredTimersV1;
    public type HttpPostUpdateHandlerDispatchV1 = HttpPostUpdateHandlersTypes.DispatchV1;
    public type HttpPostUpdateHandlerResponseV1 = HttpPostUpdateHandlersTypes.HandlerResponseV1;
    public type HttpPostUpdateHandlerV1 = HttpPostUpdateHandlersTypes.HandlerV1;
    public type PublicIngressRequestV1 = PublicIngressTypes.RequestV1;
    public type PublicIngressResultV1 = PublicIngressTypes.ResultV1;
    public type PublicIngressHandlerRequestV1 = PublicIngressTypes.HandlerRequestV1;
    public type PublicIngressCyclesV1 = PublicIngressTypes.PublicIngressCyclesV1;
    public type PublicIngressDispatchV1 = PublicIngressTypes.DispatchV1;
    public type PublicIngressQueryHandlerV1 = PublicIngressTypes.QueryHandlerV1;
    public type PublicIngressUpdateHandlerV1 = PublicIngressTypes.UpdateHandlerV1;
    public type PublicIngressHandlerRegistrationV1 = PublicIngressTypes.HandlerRegistrationV1;
    public type TaskInvocationLease = SchedulerTypes.InvocationLease;

    public type AppCapabilitiesDeclaration = {
        app_scope : CapabilityTypes.AppScope;
        backend_calls : ?BackendCallTypes.BackendCallsDeclaration;
        randomness : ?RandomnessTypes.Declaration;
        https_outcalls : ?HttpsOutcallsTypes.Declaration;
        chain_key_signing : ?ChainKeySigningTypes.Declaration;
        stable_store : ?StableStoreTypes.Declaration;
        vetkeys : ?VetKeyTypes.Declaration;
        connections : ?ConnectionTypes.Declaration;
        resident_frame_security : CapabilityTypes.ResidentFrameSecurity;
        resident_background_path : ?Text;
        http_routes_v1 : ?HttpPostUpdateHandlersTypes.RoutesDeclaration;
        certified_assets : ?CertifiedAssetsTypes.AuthoredStoreDeclaration;
        public_ingress : ?PublicIngressTypes.RoutesDeclaration;
    };

    public type AppCapabilitiesConfiguration = {
        vetkeys_environment : VetKeyTypes.Environment;
        chain_key_signing_keys : ChainKeySigningTypes.KeyConfiguration;
    };
    

    public type StaticCmd = {
        #store_chunk: {key: Text; chunk_id:Nat; content: Blob};
        #store: {key: Text; val: File};
        #delete: {key: Text};
        #clear: {prefix: Text};
    };
    
    public type StaticCmdQuery = {
        #list: {prefix: Text};
    };

    public type HttpAssetOriginPolicy = {
        #deny;
        #kernel;
        #opaque_app;
        #persistent_app;
    };

    public type RequestHostAuthority = GatewayAuthority.RequestAuthority;

    public type PublicationEntropyInitializeResult = {
        #ok : { fingerprint : Blob };
        #err : { #randomness_failed };
    };


    public type File = {content: Blob; content_encoding:Text; content_type:Text; chunks: Nat};

    func isPathOrDescendant(path : Text, root : Text) : Bool {
        path == root or Text.startsWith(path, #text (root # "/"));
    };

    // The system namespace stays internal except for its committed public
    // metadata. Package metadata, Motoko sources, the app registry, runtime
    // deployment config, and install provenance are ordinary HTTP assets.
    public func isInternalHttpStatePath(path : Text) : Bool {
        if (not isPathOrDescendant(path, "/system")) return false;
        path != "/system/apps.json" and
        path != "/system/runtime-config.json" and
        path != "/system/install-provenance.json";
    };

    func sha256ModuleAssetHash(path : Text) : ?Text {
        let ?fileName = Text.stripStart(path, #text "/mo/") else return null;
        let ?hash = Text.stripEnd(fileName, #text ".mo") else return null;
        if (hash.size() != 64) return null;
        for (char in hash.chars()) {
            if (
                not (
                    (char >= '0' and char <= '9') or
                    (char >= 'a' and char <= 'f')
                )
            ) return null;
        };
        ?hash;
    };

    public func isImmutableHttpAssetPath(path : Text) : Bool {
        sha256ModuleAssetHash(path) != null;
    };

    func lowerHex(value : Blob) : Text {
        var result = "";
        for (byte in value.values()) {
            let natural = Nat8.toNat(byte);
            result #= LOWER_HEX_DIGITS[natural / 16] #
                LOWER_HEX_DIGITS[natural % 16];
        };
        result;
    };

    public func isImmutableHttpAssetResponse(
        path : Text,
        contentEncoding : Text,
        bodyHash : Blob,
    ) : Bool {
        if (bodyHash.size() != 32) return false;
        switch (sha256ModuleAssetHash(path)) {
            case (?expected) {
                contentEncoding == "identity" and expected == lowerHex(bodyHash);
            };
            case null false;
        };
    };

    public func httpAssetCacheControl(
        path : Text,
        contentEncoding : Text,
        bodyHash : Blob,
    ) : Text {
        if (isImmutableHttpAssetResponse(path, contentEncoding, bodyHash)) {
            "public, max-age=31536000, immutable";
        } else {
            "no-cache";
        };
    };

    public func isPackageHttpAssetPath(path : Text) : Bool {
        if (isPathOrDescendant(path, "/mo")) return true;
        if (isPathOrDescendant(path, "/pkg")) return true;
        if (
            path == "/system/apps.json" or
            path == "/system/runtime-config.json" or
            path == "/system/install-provenance.json"
        ) return true;

        switch (Text.stripStart(path, #text "/app/")) {
            case null false;
            case (?relative) {
                let segments = Text.split(relative, #char '/');
                let appId = switch (segments.next()) {
                    case (?value) value;
                    case null return false;
                };
                if (appId == "") return false;
                switch (segments.next()) {
                    case (?segment) segment == "pkg";
                    case null false;
                };
            };
        };
    };

    public func isSharedAppRoutePath(path : Text) : Bool {
        RouteNamespace.isSharedRoutePath(path);
    };

    func stripAfter(value : Text, separator : Char) : Text {
        let parts = Text.split(value, #char separator);
        switch (parts.next()) {
            case (?prefix) prefix;
            case null value;
        };
    };

    // `X-Forwarded-Host` is intentionally not authority. It may be supplied
    // by the client on gateways without a documented stripping contract.
    public func requestHostAuthority(
        headers : [Painless.HeaderField],
    ) : RequestHostAuthority {
        GatewayAuthority.fromHeaders(headers);
    };

    public func validatedHttpAssetPath(url : Text) : ?Text {
        if (url.size() == 0 or Text.encodeUtf8(url).size() > MAX_HTTP_URL_BYTES) {
            return null;
        };
        // Fragments are never part of an HTTP request target. Percent escapes
        // and backslashes are forbidden in the certified path so path
        // splitting cannot disagree with the gateway's canonical expression
        // path. Publications may ignore query aliases; portable blobs reject
        // a non-empty query before route lookup.
        if (Text.contains(url, #char '#')) return null;
        let path = stripAfter(url, '?');
        if (
            Text.contains(path, #char '%') or
            Text.contains(path, #char '\\')
        ) return null;
        if (not Text.startsWith(path, #char '/')) return null;
        if (Text.contains(path, #text "//")) return null;
        for (char in path.chars()) {
            if (char < ' ' or char == '\u{7f}') return null;
        };
        var segmentCount = 0;
        for (segment in Text.split(path, #char '/')) {
            if (segment == "." or segment == "..") return null;
            if (segment != "") {
                segmentCount += 1;
                if (segmentCount > MAX_HTTP_PATH_SEGMENTS) return null;
            };
        };
        ?path;
    };

    public func supportedHttpCertificationVersion(version : ?Nat16) : Bool {
        CertV2.supportsCertificateVersion(version);
    };

    public func boundedCertifiedHttpRequest(request : Painless.Request) : Bool {
        if (
            (request.method != "GET" and request.method != "HEAD") or
            request.body.size() != 0 or
            not boundedHttpEnvelope(request.url, request.headers)
        ) return false;
        true;
    };

    public func boundedHttpEnvelope(
        url : Text,
        headers : [Painless.HeaderField],
    ) : Bool {
        if (headers.size() > MAX_HTTP_HEADERS or validatedHttpAssetPath(url) == null) {
            return false;
        };
        var headerBytes = 0;
        for ((name, value) in headers.vals()) {
            headerBytes += Text.encodeUtf8(name).size();
            headerBytes += Text.encodeUtf8(value).size();
            if (headerBytes > MAX_HTTP_HEADER_BYTES) return false;
        };
        true;
    };

    public func boundedStaticHttpRequest(request : Painless.Request) : Bool {
        request.method == "GET" and boundedCertifiedHttpRequest(request);
    };

    func appOriginPrefix(appId : Text) : Text {
        "a" # Text.map(
            appId,
            func(char) { if (char == '_') '-' else char },
        ) # "a";
    };

    func persistentAppOriginPrefix(browserOriginNonce : Text) : Text {
        "p" # Text.fromIter(Iter.take(browserOriginNonce.chars(), 24));
    };

    public func appIdFromAssetUrl(url : Text) : ?Text {
        switch (Text.stripStart(url, #text "/app/")) {
            case (null) null;
            case (?relative) {
                let segments = Text.split(relative, #char '/');
                switch (segments.next()) {
                    case (?appId) {
                        if (appId == "") null else ?appId;
                    };
                    case null null;
                };
            };
        };
    };

    // Pure host classification is public for the Motoko security fixture.
    // The live declaration bit comes only from compiler-authored AppScope
    // configuration below, never from an HTTP request or an app callback.
    public func appAssetOriginPolicy(
        hostLabel : ?Text,
        canisterId : Text,
        appId : Text,
        browserOriginNonce : Text,
        dedicatedResidentOrigin : Bool,
    ) : HttpAssetOriginPolicy {
        let ?host = hostLabel else return #opaque_app;
        let canisterSuffix = "--" # canisterId;
        if (not Text.endsWith(host, #text canisterSuffix)) {
            // The unprefixed canister host and same-host local proxies remain
            // usable for opaque tile/tray/background documents only.
            return #opaque_app;
        };
        if (dedicatedResidentOrigin) {
            if (
                host == persistentAppOriginPrefix(browserOriginNonce) #
                    canisterSuffix
            ) #persistent_app else #deny;
        } else {
            if (host == appOriginPrefix(appId) # canisterSuffix) {
                #opaque_app
            } else {
                #deny
            };
        };
    };

    public func appAssetOriginPolicyForHeaders(
        headers : [Painless.HeaderField],
        canisterId : Text,
        appId : Text,
        browserOriginNonce : Text,
        dedicatedResidentOrigin : Bool,
    ) : HttpAssetOriginPolicy {
        switch (requestHostAuthority(headers)) {
            case (#invalid) #deny;
            case (#missing) appAssetOriginPolicy(
                null,
                canisterId,
                appId,
                browserOriginNonce,
                dedicatedResidentOrigin,
            );
            case (#present(authority)) {
                // Host parsing establishes canonical syntax only. This
                // runtime surface separately admits the two verified gateway
                // authorities and rejects raw or custom gateways.
                if (
                    authority.authority != GatewayAuthority.icAuthority(
                        authority.host_label,
                    ) and
                    authority.authority != GatewayAuthority.localAuthority(
                        authority.host_label,
                    )
                ) return #deny;
                appAssetOriginPolicy(
                    ?authority.host_label,
                    canisterId,
                    appId,
                    browserOriginNonce,
                    dedicatedResidentOrigin,
                );
            };
        };
    };

    func residentFrameSecurityText(
        mode : CapabilityTypes.ResidentFrameSecurity,
    ) : Text {
        switch (mode) {
            case (#credentialless_opaque_v1) "credentialless_opaque_v1";
            case (#credentialless_ephemeral_dedicated_v1) {
                "credentialless_ephemeral_dedicated_v1";
            };
            case (#persistent_dedicated_v1) "persistent_dedicated_v1";
        };
    };

    func dedicatedResidentQuery(
        instance : InstallTypes.AppInstance,
    ) : Text {
        "app=" # instance.scope.app_id #
        "&role=background" #
        "&installation-uid=" # Nat64.toText(
            instance.scope.installation_uid
        ) #
        "&resident-frame-security=" # residentFrameSecurityText(
            instance.resident_frame_security
        ) #
        "&browser-origin-nonce=" # instance.browser_origin_nonce #
        "&browser-origin-authority-epoch=" # Nat64.toText(
            instance.browser_origin_authority_epoch
        );
    };

    // A dedicated-origin HTML document is executable only for the exact
    // kernel-authored resident iframe URL of the current committed instance.
    // Subresources deliberately do not carry this query binding.
    public func dedicatedResidentHtmlRequestBound(
        requestUrl : Text,
        canonicalPath : Text,
        headers : [Painless.HeaderField],
        instance : InstallTypes.AppInstance,
    ) : Bool {
        switch (instance.resident_frame_security) {
            case (#credentialless_opaque_v1) return false;
            case (_) {};
        };

        var iframeDest = false;
        for ((name, value) in headers.vals()) {
            if (Text.toLower(name) == "sec-fetch-dest") {
                if (iframeDest or value != "iframe") return false;
                iframeDest := true;
            };
        };
        if (not iframeDest) return false;
        requestUrl == canonicalPath # "?" # dedicatedResidentQuery(instance);
    };

    // A nonce Host is an origin selector, never an ambient document
    // capability. Only the exact current resident HTML iframe navigation may
    // create a browsing context there. In particular, SVG/XML/PDF and
    // object/embed navigations cannot bypass the HTML binding. Ordinary
    // subresources remain available to that authenticated resident document.
    public func dedicatedResidentAssetRequestBound(
        requestUrl : Text,
        canonicalPath : Text,
        headers : [Painless.HeaderField],
        contentType : Text,
        instance : InstallTypes.AppInstance,
    ) : Bool {
        switch (instance.resident_frame_security) {
            case (#credentialless_opaque_v1) return false;
            case (_) {};
        };

        var destination : ?Text = null;
        for ((name, value) in headers.vals()) {
            if (Text.toLower(name) == "sec-fetch-dest") {
                if (destination != null) return false;
                destination := ?value;
            };
        };

        switch (destination) {
            case (?"iframe") {
                Text.startsWith(
                    Text.toLower(contentType),
                    #text "text/html",
                ) and dedicatedResidentHtmlRequestBound(
                    requestUrl,
                    canonicalPath,
                    headers,
                    instance,
                );
            };
            case (?"document") false;
            case (?"frame") false;
            case (?"object") false;
            case (?"embed") false;
            // The ephemeral capability promises one dedicated Worker. Do not
            // silently widen it to a persistent ServiceWorker or a
            // cross-document SharedWorker authority.
            case (?"serviceworker") {
                instance.resident_frame_security == #persistent_dedicated_v1;
            };
            case (?"sharedworker") {
                instance.resident_frame_security == #persistent_dedicated_v1;
            };
            case (?"audio") true;
            case (?"audioworklet") true;
            case (?"empty") true;
            case (?"font") true;
            case (?"image") true;
            case (?"manifest") true;
            case (?"paintworklet") true;
            case (?"report") true;
            case (?"script") true;
            case (?"style") true;
            case (?"track") true;
            case (?"video") true;
            case (?"worker") true;
            // A nonce Host has no ambient response profile. Missing Fetch
            // Metadata cannot select any certified resident leaf.
            case null false;
            case _ false;
        };
    };

    public func appAssetSandboxHeaders(
        policy : HttpAssetOriginPolicy,
    ) : [Painless.HeaderField] {
        switch (policy) {
            case (#opaque_app) [
                ("Content-Security-Policy", "sandbox allow-scripts")
            ];
            case _ [];
        };
    };


    public class Init(
        mem : KernelMemory.Mem,
        activationMem : ActivationMemory.Mem,
        runningDeploymentId : Text,
        activeAppInstanceInventory : [InstallTypes.RuntimeApp],
        canisterPrincipal : Principal,
    ) {
        do {
            InstallService.initializeFresh(
                mem.install,
                runningDeploymentId,
                activeAppInstanceInventory,
                Prim.canisterVersion(),
            );
        };
        let assets = Assets.use(mem.core.assets);
        let residentBackgroundPaths = Map.empty<Text, Text>();
        let capabilityRegistry = CapabilityRegistry.Service(
            mem.capability_registry,
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            func() {
                InstallMemory.deploymentCommitted(
                    mem.install,
                    runningDeploymentId,
                )
            },
            nowNanos,
        );
        let appUsage = AppUsageService.Service(
            mem.app_usage,
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            nowNanos,
            func() { Prim.performanceCounter(1) },
        );
        let outgoingCycleAccounting : AppUsageTypes.OutgoingCycleAccounting = {
            reserve = appUsage.reserveOutgoingCycles;
            commit = appUsage.commitOutgoingDispatch;
            cancel = appUsage.cancelOutgoingReservation;
            finalize = appUsage.finalizeOutgoingCycles;
        };
        let runtimeCapabilityRegistry : CapabilityTypes.RuntimeRegistry = {
            allowed = func(
                scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resourceId : Text,
            ) : Bool {
                capabilityRegistry.allowed(scope, kind, resourceId);
            };
            lease = func(
                scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resourceId : Text,
            ) : ?CapabilityTypes.RuntimeLease {
                capabilityRegistry.lease(scope, kind, resourceId);
            };
            record = func(
                scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resourceId : Text,
                operation : Text,
                outcome : CapabilityTypes.CapabilityOutcome,
            ) : Bool {
                capabilityRegistry.record(
                    scope,
                    kind,
                    resourceId,
                    operation,
                    outcome,
                );
            };
        };
        let connections = ConnectionsService.Service(
            mem.connections,
            func(appId) { InstallMemory.committedScope(mem.install, appId) },
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            runtimeCapabilityRegistry,
            outgoingCycleAccounting,
        );
        let backendCalls = BackendCallsService.Service(
            mem.backend_calls,
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            runtimeCapabilityRegistry,
            BackendCallsRaw.transport(),
            outgoingCycleAccounting,
        );
        let randomness = RandomnessService.Service(
            RandomnessAdapter.management(),
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            runtimeCapabilityRegistry,
            outgoingCycleAccounting,
        );
        let httpsOutcallTransformActor : HttpsOutcallsTypes.TransformActor =
            actor (Principal.toText(canisterPrincipal));
        let httpsOutcalls = HttpsOutcallsService.Service(
            HttpsOutcallsAdapter.management(httpsOutcallTransformActor),
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            func() {
                InstallMemory.deploymentCommitted(mem.install, runningDeploymentId)
            },
            runtimeCapabilityRegistry,
            outgoingCycleAccounting,
        );
        let chainKeySigning = ChainKeySigningService.Service(
            mem.chain_key_signing,
            ChainKeySigningAdapter.management(),
            canisterPrincipal,
            InstallMemory.installEpoch(mem.install),
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            func() {
                InstallMemory.deploymentCommitted(mem.install, runningDeploymentId)
            },
            runtimeCapabilityRegistry,
            outgoingCycleAccounting,
        );
        let stableStore = StableStoreService.Service(
            mem.stable_store,
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            func() {
                InstallMemory.deploymentCommitted(mem.install, runningDeploymentId)
            },
            runtimeCapabilityRegistry,
            Cycles.balance,
            InternetComputer.isReplicated,
        );
        let scheduler = SchedulerService.Service(
            runtimeCapabilityRegistry,
            func() {
                InstallMemory.deploymentCommitted(
                    mem.install,
                    runningDeploymentId,
                )
            },
            func(scope) {
                InstallMemory.scopeActive(
                    mem.install,
                    runningDeploymentId,
                    scope,
                )
            },
            nowNanos,
        );

        let vetkeys = VetKeysService.Service(
            mem.vetkeys,
            VetKeysAdapter.management(),
            func(principal : Principal) : Bool {
                Set.contains(mem.core.authorized, Principal.compare, principal);
            },
            func(appId) { InstallMemory.committedScope(mem.install, appId) },
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            runtimeCapabilityRegistry,
            outgoingCycleAccounting,
        );
        let canisterId = Principal.toText(canisterPrincipal);

        func dedicatedResidentOriginActive(
            instance : InstallTypes.AppInstance,
        ) : Bool {
            switch (instance.resident_frame_security) {
                case (#credentialless_opaque_v1) false;
                case (#credentialless_ephemeral_dedicated_v1) {
                    capabilityRegistry.enabledAfterCommit(
                        instance.scope,
                        #dedicated_resident_origin,
                        "background",
                    );
                };
                case (#persistent_dedicated_v1) {
                    capabilityRegistry.enabledAfterCommit(
                        instance.scope,
                        #persistent_browser_storage,
                        "background",
                    );
                };
            };
        };

        func validHttpHeaderValue(value : Text, maxBytes : Nat) : Bool {
            if (Text.encodeUtf8(value).size() > maxBytes) return false;
            for (char in value.chars()) {
                if (char < ' ' or char == '\u{7f}') return false;
            };
            true;
        };

        func residentBackgroundPath(
            instance : InstallTypes.AppInstance,
        ) : ?Text {
            Map.get(
                residentBackgroundPaths,
                Text.compare,
                instance.scope.app_id,
            );
        };

        func contentTypeBase(contentType : Text) : Text {
            let parts = Text.split(Text.toLower(contentType), #char ';');
            switch (parts.next()) {
                case (?value) value;
                case null "";
            };
        };

        func residentSubresourceDestinations(
            contentType : Text,
            allowPersistentWorkers : Bool,
        ) : [Text] {
            let mime = contentTypeBase(contentType);
            let result = List.empty<Text>();
            func add(value : Text) : () {
                for (current in List.values(result)) {
                    if (current == value) return;
                };
                List.add(result, value);
            };

            // Programmatic fetches are inert because their proof cannot be
            // replayed for a document, frame, worker, or service worker.
            if (
                mime != "text/html" and
                mime != "application/xhtml+xml"
            ) add("empty");

            if (
                mime == "text/javascript" or
                mime == "application/javascript" or
                mime == "application/ecmascript" or
                mime == "text/ecmascript"
            ) {
                add("script");
                add("worker");
                add("audioworklet");
                add("paintworklet");
                if (allowPersistentWorkers) {
                    add("serviceworker");
                    add("sharedworker");
                };
            } else if (mime == "text/css") {
                add("style");
            } else if (Text.startsWith(mime, #text "image/")) {
                add("image");
            } else if (
                Text.startsWith(mime, #text "font/") or
                mime == "application/font-woff" or
                mime == "application/font-woff2" or
                mime == "application/vnd.ms-fontobject"
            ) {
                add("font");
            } else if (Text.startsWith(mime, #text "audio/")) {
                add("audio");
            } else if (Text.startsWith(mime, #text "video/")) {
                add("video");
            } else if (mime == "text/vtt") {
                add("track");
            } else if (
                mime == "application/manifest+json" or
                mime == "text/cache-manifest"
            ) {
                add("manifest");
            };
            List.toArray(result);
        };

        func residentRequestKindForRequest(
            requestUrl : Text,
            canonicalPath : Text,
            headers : [Painless.HeaderField],
            contentType : Text,
            instance : InstallTypes.AppInstance,
        ) : ?Cert.ResidentRequestKind {
            var destination : ?Text = null;
            for ((name, value) in headers.vals()) {
                if (Text.toLower(name) == "sec-fetch-dest") {
                    if (destination != null) return null;
                    destination := ?value;
                };
            };
            let ?selected = destination else return null;
            if (selected == "iframe") {
                let ?residentPath = residentBackgroundPath(instance) else {
                    return null;
                };
                if (
                    canonicalPath != residentPath or
                    not dedicatedResidentHtmlRequestBound(
                        requestUrl,
                        canonicalPath,
                        headers,
                        instance,
                    )
                ) return null;
                return ?#html_v1({
                    canonical_query = dedicatedResidentQuery(instance);
                });
            };
            let allowPersistentWorkers =
                instance.resident_frame_security == #persistent_dedicated_v1;
            for (allowed in residentSubresourceDestinations(
                contentType,
                allowPersistentWorkers,
            ).vals()) {
                if (selected == allowed) {
                    return ?#subresource_v1({ destination = selected });
                };
            };
            null;
        };

        func certifiedResponseHeaders(
            key : Text,
            file : Assets.Doc,
            policy : HttpAssetOriginPolicy,
            bodyHash : Blob,
            expressionOverride : ?Text,
        ) : [Painless.HeaderField] {
            Array.concat<Painless.HeaderField>(
                [
                    ("Content-Type", file.content_type),
                    ("Content-Encoding", file.content_encoding),
                    (
                        "Cache-Control",
                        httpAssetCacheControl(
                            key,
                            file.content_encoding,
                            bodyHash,
                        ),
                    ),
                    ("X-Content-Type-Options", "nosniff"),
                    ("Referrer-Policy", "no-referrer"),
                    (
                        "Permissions-Policy",
                        "camera=(), geolocation=(), microphone=()",
                    ),
                    (
                        Cert.CERTIFICATE_EXPRESSION_HEADER,
                        switch (expressionOverride) {
                            case (?expression) expression;
                            case null {
                                if (isPackageHttpAssetPath(key)) {
                                    Cert.PORTABLE_CERTIFICATION_EXPRESSION
                                } else {
                                    Cert.HOST_BOUND_CERTIFICATION_EXPRESSION
                                };
                            };
                        },
                    ),
                ],
                appAssetSandboxHeaders(policy),
            );
        };

        func certifiedAuthorities(hostLabel : Text) : [Text] {
            GatewayAuthority.canisterAuthorities(hostLabel);
        };

        func appendCertificationVariants(
            result : [var ?Cert.CertificationVariant],
            offset : Nat,
            hostLabel : Text,
            headers : [Painless.HeaderField],
        ) : Nat {
            var index = offset;
            for (authority in certifiedAuthorities(hostLabel).vals()) {
                result[index] := ?{
                    host = authority;
                    response_headers = headers;
                };
                index += 1;
            };
            index;
        };

        func publicCertificationVariants(
            key : Text,
            file : Assets.Doc,
            bodyHash : Blob,
        ) : [Cert.CertificationVariant] {
            if (
                isInternalHttpStatePath(key) or
                isSharedAppRoutePath(key) or
                validatedHttpAssetPath(key) != ?key or
                file.chunks != file.content.size() or
                not validHttpHeaderValue(file.content_type, 256) or
                (
                    file.content_encoding != "identity" and
                    file.content_encoding != "gzip"
                )
            ) return [];

            func portablePackageVariants() : [Cert.CertificationVariant] {
                [{
                    // Empty is an internal owner sentinel for the portable
                    // request expression, which omits Host but still binds
                    // the method and empty request body.
                    host = "";
                    response_headers = certifiedResponseHeaders(
                        key,
                        file,
                        #opaque_app,
                        bodyHash,
                        null,
                    );
                }];
            };

            switch (appIdFromAssetUrl(key)) {
                case null {
                    if (isPackageHttpAssetPath(key)) {
                        return portablePackageVariants();
                    };
                    Array.map<Text, Cert.CertificationVariant>(
                        certifiedAuthorities(canisterId),
                        func(authority) {
                            {
                                host = authority;
                                response_headers = certifiedResponseHeaders(
                                    key,
                                    file,
                                    #kernel,
                                    bodyHash,
                                    null,
                                );
                            };
                        },
                    );
                };
                case (?appId) {
                    let ?instances = InstallMemory.instancesForDeployment(
                        mem.install,
                        runningDeploymentId,
                    ) else return [];
                    let ?instance = InstallMemory.findApp(instances, appId) else {
                        return [];
                    };
                    if (isPackageHttpAssetPath(key)) {
                        return portablePackageVariants();
                    };
                    let hasDedicatedOrigin =
                        dedicatedResidentOriginActive(instance);
                    let dedicatedLabel =
                        appOriginPrefix(appId) # "--" # canisterId;
                    let variants = VarArray.repeat<?Cert.CertificationVariant>(
                        null,
                        if (hasDedicatedOrigin) 2 else 4,
                    );
                    var next = appendCertificationVariants(
                        variants,
                        0,
                        canisterId,
                        certifiedResponseHeaders(
                            key,
                            file,
                            #opaque_app,
                            bodyHash,
                            null,
                        ),
                    );
                    if (not hasDedicatedOrigin) {
                        next := appendCertificationVariants(
                            variants,
                            next,
                            dedicatedLabel,
                            certifiedResponseHeaders(
                                key,
                                file,
                                #opaque_app,
                                bodyHash,
                                null,
                            ),
                        );
                    };
                    Array.tabulate<Cert.CertificationVariant>(
                        next,
                        func(index) {
                            let ?variant = variants[index] else {
                                Runtime.trap("Missing HTTP certification variant");
                            };
                            variant;
                        },
                    );
                };
            };
        };

        func residentCertificationVariants(
            key : Text,
            file : Assets.Doc,
            bodyHash : Blob,
        ) : [Cert.ResidentResponseVariant] {
            if (
                isInternalHttpStatePath(key) or
                isSharedAppRoutePath(key) or
                isPackageHttpAssetPath(key) or
                validatedHttpAssetPath(key) != ?key or
                file.chunks != file.content.size() or
                not validHttpHeaderValue(file.content_type, 256) or
                (
                    file.content_encoding != "identity" and
                    file.content_encoding != "gzip"
                )
            ) return [];
            let ?appId = appIdFromAssetUrl(key) else return [];
            let ?instances = InstallMemory.instancesForDeployment(
                mem.install,
                runningDeploymentId,
            ) else return [];
            let ?instance = InstallMemory.findApp(instances, appId) else {
                return [];
            };
            if (not dedicatedResidentOriginActive(instance)) return [];

            let kinds = List.empty<Cert.ResidentRequestKind>();
            let mime = contentTypeBase(file.content_type);
            if (mime == "text/html") {
                if (residentBackgroundPath(instance) == ?key) {
                    List.add(kinds, #html_v1({
                        canonical_query = dedicatedResidentQuery(instance);
                    }));
                };
            } else {
                let allowPersistentWorkers =
                    instance.resident_frame_security ==
                        #persistent_dedicated_v1;
                for (destination in residentSubresourceDestinations(
                    file.content_type,
                    allowPersistentWorkers,
                ).vals()) {
                    List.add(
                        kinds,
                        #subresource_v1({ destination }),
                    );
                };
            };
            let selectedKinds = List.toArray(kinds);
            if (selectedKinds.size() == 0) return [];

            let hostLabel =
                persistentAppOriginPrefix(instance.browser_origin_nonce) #
                "--" # canisterId;
            let authorities = certifiedAuthorities(hostLabel);
            Array.tabulate<Cert.ResidentResponseVariant>(
                authorities.size() * selectedKinds.size(),
                func(index) {
                    let kind = selectedKinds[
                        index % selectedKinds.size()
                    ];
                    {
                        method = "GET";
                        host = authorities[index / selectedKinds.size()];
                        kind;
                        status_code = 200;
                        body_hash = bodyHash;
                        response_headers = certifiedResponseHeaders(
                            key,
                            file,
                            #persistent_app,
                            bodyHash,
                            ?Cert.residentCertificationExpression(kind),
                        );
                    };
                },
            );
        };

        func residentStaticCertificationOwners(
            key : Text,
            file : Assets.Doc,
        ) : [Cert.ResidentRequestOwner] {
            let ?appId = appIdFromAssetUrl(key) else return [];
            let result = List.empty<Cert.ResidentRequestOwner>();
            func addInstance(instance : InstallTypes.AppInstance) : () {
                if (
                    instance.scope.app_id != appId or
                    instance.resident_frame_security ==
                        #credentialless_opaque_v1
                ) return;
                let kinds = List.empty<Cert.ResidentRequestKind>();
                if (contentTypeBase(file.content_type) == "text/html") {
                    if (residentBackgroundPath(instance) == ?key) {
                        List.add(kinds, #html_v1({
                            canonical_query =
                                dedicatedResidentQuery(instance);
                        }));
                    };
                } else {
                    // Removal uses the persistent superset so an
                    // ephemeral-mode transition also removes any prior
                    // service/shared-worker leaves.
                    for (destination in residentSubresourceDestinations(
                        file.content_type,
                        true,
                    ).vals()) {
                        List.add(
                            kinds,
                            #subresource_v1({ destination }),
                        );
                    };
                };
                let hostLabel =
                    persistentAppOriginPrefix(
                        instance.browser_origin_nonce
                    ) # "--" # canisterId;
                for (authority in certifiedAuthorities(hostLabel).vals()) {
                    for (kind in List.values(kinds)) {
                        List.add(result, {
                            method = "GET";
                            host = authority;
                            kind;
                        });
                    };
                };
            };
            for (
                instance in mem.install.committed_app_instances.vals()
            ) addInstance(instance);
            switch (InstallMemory.instancesForDeployment(
                mem.install,
                runningDeploymentId,
            )) {
                case (?instances) {
                    for (instance in instances.vals()) {
                        var duplicate = false;
                        for (
                            committed in
                            mem.install.committed_app_instances.vals()
                        ) {
                            if (
                                committed.scope == instance.scope and
                                committed.browser_origin_nonce ==
                                    instance.browser_origin_nonce and
                                committed.browser_origin_authority_epoch ==
                                    instance.browser_origin_authority_epoch
                            ) duplicate := true;
                        };
                        if (not duplicate) addInstance(instance);
                    };
                };
                case null {};
            };
            List.toArray(result);
        };

        // Static assets and app-host routes share the standard URL-first
        // http_expr tree. Remove only each static asset's exact request owners
        // so a package clear can never erase another app's clean-path proof.
        func staticCertificationOwners(key : Text) : [Cert.RequestOwner] {
            // The complete shared-route stem is broker-owned. A crafted or
            // stale static write there must never delete a route proof.
            if (isSharedAppRoutePath(key)) return [];
            if (isPackageHttpAssetPath(key)) {
                return [{ method = "GET"; host = "" }];
            };
            let hosts = List.empty<Text>();
            func addHost(authority : Text) : () {
                for (current in List.values(hosts)) {
                    if (current == authority) return;
                };
                List.add(hosts, authority);
            };
            func addLabel(hostLabel : Text) : () {
                for (authority in certifiedAuthorities(hostLabel).vals()) {
                    addHost(authority);
                };
            };
            addLabel(canisterId);
            switch (appIdFromAssetUrl(key)) {
                case null {};
                case (?appId) {
                    addLabel(appOriginPrefix(appId) # "--" # canisterId);
                    func addPersistent(instances : [InstallTypes.AppInstance]) : () {
                        switch (InstallMemory.findApp(instances, appId)) {
                            case (?instance) addLabel(
                                persistentAppOriginPrefix(instance.browser_origin_nonce) #
                                "--" # canisterId
                            );
                            case null {};
                        };
                    };
                    addPersistent(mem.install.committed_app_instances);
                    switch (InstallMemory.instancesForDeployment(
                        mem.install,
                        runningDeploymentId,
                    )) {
                        case (?instances) addPersistent(instances);
                        case null {};
                    };
                };
            };
            Array.map<Text, Cert.RequestOwner>(
                List.toArray(hosts),
                func(host) { { method = "GET"; host } },
            );
        };

        let cert = Cert.CertifiedHttp(
            mem.core.cert,
            mem.certified_assets.authenticated_forest,
        );
        let notFoundBody = Text.encodeUtf8("Not found");
        let notFoundHeaders : [Painless.HeaderField] = [
            ("Content-Type", "text/plain; charset=utf-8"),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("Referrer-Policy", "no-referrer"),
            (
                "Permissions-Policy",
                "camera=(), geolocation=(), microphone=()",
            ),
            (
                Cert.CERTIFICATE_EXPRESSION_HEADER,
                Cert.NOT_FOUND_EXPRESSION,
            ),
        ];
        let notFoundBodyHash = Cert.hashChunks([notFoundBody]);
        do {
            cert.initialize(notFoundHeaders, notFoundBodyHash);
        };

        let certifiedAssets = CertifiedAssetsService.Service(
            mem.certified_assets,
            cert,
            canisterId,
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            func() {
                InstallMemory.deploymentCommitted(mem.install, runningDeploymentId)
            },
            runtimeCapabilityRegistry,
            Cycles.balance,
            nowNanos,
        );

        let httpPostUpdateHandlers = HttpPostUpdateHandlersService.Service(
            mem.http_post_update_handlers,
            canisterId,
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            func() {
                InstallMemory.deploymentCommitted(mem.install, runningDeploymentId)
            },
            func(principal : Principal) : Bool {
                Set.contains(mem.core.authorized, Principal.compare, principal)
            },
            func(scope : CapabilityTypes.AppScope) : Nat64 {
                appUsage.beginInstructions(
                    scope,
                    AppUsageService.INGRESS_MESSAGE_BASE_CYCLES,
                ).started_at
            },
            func(scope : CapabilityTypes.AppScope, startedAt : Nat64) : () {
                appUsage.finishInstructions({ scope; started_at = startedAt })
            },
            runtimeCapabilityRegistry,
            Cycles.balance,
            nowNanos,
        );

        let publicIngress = PublicIngressService.Service(
            mem.public_ingress,
            func(scope) {
                InstallMemory.scopeActive(mem.install, runningDeploymentId, scope)
            },
            func() {
                InstallMemory.deploymentCommitted(mem.install, runningDeploymentId)
            },
            runtimeCapabilityRegistry,
            Cycles.balance,
            Cycles.available,
            Cycles.accept,
            appUsage.recordIncomingCycles,
            nowNanos,
        );

        func staticCertificationMutations(
            key : Text,
            bodyHash : Blob,
        ) : [Cert.Mutation] {
            // Shared-route paths are broker-owned even if a stale or crafted
            // install batch reaches this final write boundary.
            assert (not isSharedAppRoutePath(key));
            let prior = staticCertificationOwners(key);
            let ?file = assets.get(key) else {
                return [#remove({ url = key; requests = prior })];
            };
            let next = Array.map<Cert.CertificationVariant, Cert.ResponseVariant>(
                publicCertificationVariants(key, file, bodyHash),
                func(variant) {
                    {
                        method = "GET";
                        host = variant.host;
                        response_headers = variant.response_headers;
                        status_code = 200;
                        body_hash = bodyHash;
                    };
                },
            );
            let residentPrior = residentStaticCertificationOwners(
                key,
                file,
            );
            let residentNext = residentCertificationVariants(
                key,
                file,
                bodyHash,
            );
            let mutations = List.empty<Cert.Mutation>();
            List.add(mutations, #replace({ url = key; prior; next }));
            if (
                residentPrior.size() > 0 or residentNext.size() > 0
            ) List.add(mutations, #replace_resident({
                    url = key;
                    prior = residentPrior;
                    next = residentNext;
                }));
            List.toArray(mutations);
        };

        func publicStaticAssetCertificationIsCurrent(
            key : Text,
            bodyHash : Blob,
        ) : Bool {
            let ?file = assets.get(key) else return false;
            let expected = Array.map<
                Cert.CertificationVariant,
                Cert.ResponseVariant,
            >(
                publicCertificationVariants(key, file, bodyHash),
                func(variant) {
                    {
                        method = "GET";
                        host = variant.host;
                        response_headers = variant.response_headers;
                        status_code = 200;
                        body_hash = bodyHash;
                    };
                },
            );
            if (expected.size() == 0) return false;
            for (variant in expected.vals()) {
                if (not cert.hasPublicResponse(key, variant)) return false;
            };
            let residentExpected = residentCertificationVariants(
                key,
                file,
                bodyHash,
            );
            for (variant in residentExpected.vals()) {
                if (not cert.hasResidentResponse(key, variant)) return false;
            };
            true;
        };

        func certifyPublicAsset(key : Text, bodyHash : Blob) : () {
            cert.apply(staticCertificationMutations(key, bodyHash));
        };

        func reconcilePublicStaticAssetsAtPrefix(prefix : Text) : () {
            let mutations = List.empty<Cert.Mutation>();
            label assets for (key in assets.allKeys(prefix).vals()) {
                if (
                    not isSharedAppRoutePath(key)
                ) {
                    switch (cert.assetHash(key)) {
                        case (?bodyHash) {
                            if (
                                publicStaticAssetCertificationIsCurrent(
                                    key,
                                    bodyHash,
                                )
                            ) { continue assets };
                            // Replacing the complete known request-owner set
                            // also removes dedicated leaves after a capability
                            // disable or origin-mode rotation. Presence-only
                            // reconciliation would retain stale nonce authority.
                            for (mutation in staticCertificationMutations(
                                key,
                                bodyHash,
                            ).vals()) List.add(mutations, mutation);
                        };
                        case null {};
                    };
                };
            };
            cert.apply(List.toArray(mutations));
        };

        // Explicit resident-origin policy changes may alter the request owners
        // of one installed app's package files. This path is never part of an
        // install or actor upgrade.
        func reconcilePublicStaticAssetsForApp(appId : Text) : () {
            reconcilePublicStaticAssetsAtPrefix("/app/" # appId # "/");
        };

        // Incremental installs change the actor deployment id even when an
        // existing app is untouched. Resident authority is installation-
        // scoped, so its initial document excludes deployment/package hashes.
        // Reconcile at most one entrypoint per app to migrate older leaves
        // without scanning every installed asset.
        func reconcileResidentBackgroundEntrypoints() : () {
            let mutations = List.empty<Cert.Mutation>();
            for (
                instance in mem.install.committed_app_instances.vals()
            ) {
                if (dedicatedResidentOriginActive(instance)) {
                    switch (residentBackgroundPath(instance)) {
                        case (?key) {
                            switch (cert.assetHash(key)) {
                                case (?bodyHash) {
                                    if (
                                        not publicStaticAssetCertificationIsCurrent(
                                            key,
                                            bodyHash,
                                        )
                                    ) {
                                        for (
                                            mutation in
                                            staticCertificationMutations(
                                                key,
                                                bodyHash,
                                            ).vals()
                                        ) List.add(mutations, mutation);
                                    };
                                };
                                case null {};
                            };
                        };
                        case null {};
                    };
                };
            };
            cert.apply(List.toArray(mutations));
        };

        func deleteStaticAssetCertification(
            key : Text,
            priorFile : ?Assets.Doc,
        ) : () {
            cert.deleteAssetHash(key);
            // Cleanup may encounter a legacy/stale static value beneath the
            // reserved route namespace. Remove its stored body hash,
            // but never touch the live route's public request branches.
            if (isSharedAppRoutePath(key)) return;
            let mutations = List.empty<Cert.Mutation>();
            List.add(mutations, #remove({
                url = key;
                requests = staticCertificationOwners(key);
            }));
            switch (priorFile) {
                case (?file) {
                    let residentRequests =
                        residentStaticCertificationOwners(key, file);
                    if (residentRequests.size() > 0) {
                        List.add(mutations, #remove_resident({
                            url = key;
                            requests = residentRequests;
                        }));
                    };
                };
                case null {};
            };
            cert.apply(List.toArray(mutations));
        };

        let installs = InstallService.Service(
            mem.install,
            assets,
            cert,
            mem.backend_calls,
            runningDeploymentId,
            activeAppInstanceInventory,
            backendCalls.supportsScope,
            certifyPublicAsset,
            func(removedApps : [InstallTypes.AppInstance], changedBy : Principal) {
                certifiedAssets.commitConfiguration();
                httpPostUpdateHandlers.commitConfiguration();
                publicIngress.commitConfiguration();
                httpsOutcalls.commitConfiguration();
                chainKeySigning.commitConfiguration();
                stableStore.commitConfiguration();
                appUsage.removeScopes(
                    Array.map<InstallTypes.AppInstance, CapabilityTypes.AppScope>(
                        removedApps,
                        func(instance) { instance.scope },
                    )
                );
                connections.commitConfiguration(
                    Array.map<InstallTypes.AppInstance, CapabilityTypes.AppScope>(
                        removedApps,
                        func(instance) { instance.scope },
                    )
                );
                vetkeys.commitConfiguration(
                    removedApps,
                    changedBy,
                    nowNanos(),
                );
            },
        );
        let settingsAccess = SettingsAccess.Service(mem.core.authorized);
        let activation = ActivationService.Service(
            activationMem,
            mem.core.authorized,
        );

        public func configure_app_capabilities(
            declarations : [AppCapabilitiesDeclaration],
            configuration : AppCapabilitiesConfiguration,
        ) : () {
            Map.clear(residentBackgroundPaths);
            for (declaration in declarations.vals()) {
                assert (CapabilityScope.valid(declaration.app_scope));
                let ?instances = InstallMemory.instancesForDeployment(
                    mem.install,
                    runningDeploymentId,
                ) else Runtime.trap("App-instance inventory is unavailable");
                let ?instance = InstallMemory.findApp(
                    instances,
                    declaration.app_scope.app_id,
                ) else Runtime.trap("Configured app is absent from the runtime inventory");
                assert (
                    instance.scope == declaration.app_scope and
                    instance.resident_frame_security ==
                        declaration.resident_frame_security
                );
                switch (declaration.resident_background_path) {
                    case (?path) {
                        assert (
                            validatedHttpAssetPath(path) == ?path and
                            appIdFromAssetUrl(path) ==
                                ?declaration.app_scope.app_id and
                            Map.get(
                                residentBackgroundPaths,
                                Text.compare,
                                declaration.app_scope.app_id,
                            ) == null
                        );
                        Map.add(
                            residentBackgroundPaths,
                            Text.compare,
                            declaration.app_scope.app_id,
                            path,
                        );
                    };
                    case null {
                        assert (
                            declaration.resident_frame_security ==
                                #credentialless_opaque_v1
                        );
                    };
                };
            };
            certifiedAssets.configure(
                Array.map<AppCapabilitiesDeclaration, CertifiedAssetsTypes.AppDeclaration>(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            certified_assets = declaration.certified_assets;
                        };
                    },
                )
            );
            httpPostUpdateHandlers.configure(
                Array.map<AppCapabilitiesDeclaration, HttpPostUpdateHandlersTypes.AppDeclaration>(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            http_routes = declaration.http_routes_v1;
                        };
                    },
                )
            );
            publicIngress.configure(
                Array.map<AppCapabilitiesDeclaration, PublicIngressTypes.AppDeclaration>(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            public_ingress = declaration.public_ingress;
                        };
                    },
                )
            );
            httpsOutcalls.configure(
                Array.map<AppCapabilitiesDeclaration, HttpsOutcallsTypes.AppDeclaration>(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            https_outcalls = declaration.https_outcalls;
                        };
                    },
                )
            );
            chainKeySigning.configure(
                configuration.chain_key_signing_keys,
                Array.map<
                    AppCapabilitiesDeclaration,
                    ChainKeySigningTypes.AppDeclaration,
                >(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            chain_key_signing = declaration.chain_key_signing;
                        };
                    },
                ),
            );
            stableStore.configure(
                Array.map<AppCapabilitiesDeclaration, StableStoreTypes.AppDeclaration>(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            stable_store = declaration.stable_store;
                        };
                    },
                )
            );
            connections.configure(
                Array.map<AppCapabilitiesDeclaration, ConnectionTypes.AppDeclaration>(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            connections = declaration.connections;
                        };
                    },
                )
            );
            backendCalls.configure(
                Array.map<
                    AppCapabilitiesDeclaration,
                    BackendCallTypes.AppCapabilitiesDeclaration,
                >(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            backend_calls = declaration.backend_calls;
                        };
                    },
                ),
                canisterPrincipal,
            );
            randomness.configure(
                Array.map<AppCapabilitiesDeclaration, RandomnessTypes.AppDeclaration>(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            randomness = declaration.randomness;
                        };
                    },
                )
            );
            vetkeys.configure(
                configuration.vetkeys_environment,
                Array.map<AppCapabilitiesDeclaration, VetKeyTypes.AppDeclaration>(
                    declarations,
                    func(declaration) {
                        {
                            app_scope = declaration.app_scope;
                            vetkeys = declaration.vetkeys;
                        };
                    },
                ),
            );
        };

        public func configure_frontend_surface_counts(
            counts : FrontendRuntimeAdmission.SurfaceCounts,
        ) : () {
            assert (FrontendRuntimeAdmission.accepts(counts));
        };

        public func configure_capability_registry(
            registrations : [CapabilityTypes.CapabilityRegistration],
            self : actor {},
        ) : () {
            capabilityRegistry.configure(registrations);
            let committed = InstallMemory.deploymentCommitted(
                mem.install,
                runningDeploymentId,
            );
            if (committed) {
                cert.beginV2PublicationBatch();
                certifiedAssets.commitConfiguration();
                httpPostUpdateHandlers.commitConfiguration();
                publicIngress.commitConfiguration();
                httpsOutcalls.commitConfiguration();
                chainKeySigning.commitConfiguration();
                stableStore.commitConfiguration();
            };
            assert (
                capabilityRegistry.commitConfiguration(Principal.fromActor(self)) ==
                committed
            );
            if (committed) {
                certifiedAssets.syncRuntimeState();
                ignore cert.finishV2PublicationBatch();
            };
        };

        public func configure_http_post_update_handlers(
            registrations : [HttpPostUpdateHandlersTypes.HandlerRegistration],
        ) : () {
            httpPostUpdateHandlers.configureHandlers(registrations);
        };

        public func configure_public_ingress_handlers(
            registrations : [PublicIngressHandlerRegistrationV1],
        ) : () {
            publicIngress.configureHandlers(registrations);
        };

        public func public_ingress_cycles_capability(
            scope : CapabilityTypes.AppScope,
        ) : PublicIngressCyclesV1 {
            publicIngress.cyclesCapability(scope);
        };

        public func public_ingress_query(
            scope : CapabilityTypes.AppScope,
            protocol : Text,
            caller : Principal,
            request : PublicIngressRequestV1,
        ) : PublicIngressResultV1 {
            publicIngress.dispatchQuery(scope, protocol, caller, request);
        };

        public func public_ingress_update<system>(
            scope : CapabilityTypes.AppScope,
            protocol : Text,
            caller : Principal,
            request : PublicIngressRequestV1,
        ) : async* PublicIngressResultV1 {
            let measurement = switch (
                publicIngress.updateOrigin(scope, protocol, caller, request)
            ) {
                case (?#authenticated_ingress) {
                    ?appUsage.beginInstructions(
                        scope,
                        AppUsageService.INGRESS_MESSAGE_BASE_CYCLES,
                    );
                };
                case (?#canister_call) {
                    ?appUsage.beginInstructions(scope, 0);
                };
                case null null;
            };
            let result = await* publicIngress.dispatchUpdate<system>(
                scope,
                protocol,
                caller,
                request,
            );
            switch (measurement) {
                case (?value) appUsage.finishInstructions(value);
                case null {};
            };
            result;
        };

        // Compiler-generated app entrypoint wrappers are the only callers.
        // The token never enters an app capability object or Candid surface.
        public func app_usage_instruction_begin(
            scope : CapabilityTypes.AppScope,
            fixedMessageCycles : Nat,
        ) : AppUsageTypes.InstructionMeasurement {
            appUsage.beginInstructions(scope, fixedMessageCycles);
        };

        public func app_usage_instruction_finish(
            measurement : AppUsageTypes.InstructionMeasurement,
        ) : () {
            appUsage.finishInstructions(measurement);
        };

        public func public_ingress_dispatch_begin(
            scope : CapabilityTypes.AppScope,
            protocol : Text,
            method : Text,
            dispatch : PublicIngressDispatchV1,
        ) : () {
            publicIngress.dispatchBegin(scope, protocol, method, dispatch);
        };

        public func public_ingress_dispatch_finish(
            scope : CapabilityTypes.AppScope,
            protocol : Text,
            method : Text,
            dispatch : PublicIngressDispatchV1,
            response : Blob,
        ) : () {
            publicIngress.dispatchFinish(scope, protocol, method, dispatch, response);
        };

        public func http_post_update_handler_dispatch_begin(
            scope : CapabilityTypes.AppScope,
            mountId : Text,
            dispatch : HttpPostUpdateHandlerDispatchV1,
        ) : () {
            httpPostUpdateHandlers.dispatchBegin(scope, mountId, dispatch);
        };

        public func http_post_update_handler_dispatch_finish(
            scope : CapabilityTypes.AppScope,
            mountId : Text,
            dispatch : HttpPostUpdateHandlerDispatchV1,
            response : HttpPostUpdateHandlerResponseV1,
        ) : () {
            httpPostUpdateHandlers.dispatchFinish(scope, mountId, dispatch, response);
        };

        public func backend_calls_capability(
            appScope : CapabilityTypes.AppScope,
            self : actor {},
        ) : BackendCallTypes.Capability {
            backendCalls.capability(appScope, self);
        };

        public func task_backend_calls_capability(
            appScope : CapabilityTypes.AppScope,
            taskId : Text,
            limit : Nat,
            lease : SchedulerTypes.InvocationLease,
            self : actor {},
        ) : BackendCallTypes.Capability {
            backendCalls.scheduledCapability(appScope, taskId, limit, lease, self);
        };

        public func deferred_timers_capability(
            appScope : CapabilityTypes.AppScope,
        ) : SchedulerTypes.DeferredTimersV1 {
            scheduler.deferredTimersCapability(
                appScope,
                func(callback : () -> ()) : () {
                    let measurement = appUsage.beginInstructions(
                        appScope,
                        260_000,
                    );
                    callback();
                    appUsage.finishInstructions(measurement);
                },
            );
        };

        public func randomness_capability(
            appScope : CapabilityTypes.AppScope,
        ) : RandomnessTypes.Capability {
            randomness.capability(appScope);
        };

        public func https_outcalls_capability(
            appScope : CapabilityTypes.AppScope,
        ) : HttpsOutcallsTypes.Capability {
            httpsOutcalls.capability(appScope);
        };

        public func chain_key_signing_capability(
            appScope : CapabilityTypes.AppScope,
        ) : ChainKeySigningTypes.Capability {
            chainKeySigning.capability(appScope);
        };

        public func stable_store_capability(
            appScope : CapabilityTypes.AppScope,
        ) : StableStoreTypes.Capability {
            stableStore.capability(appScope);
        };

        public func certified_assets_capability(
            appScope : CapabilityTypes.AppScope,
        ) : CertifiedAssetsTypes.Capability {
            certifiedAssets.capability(appScope);
        };

        public func vetkeys_public_capability(
            appScope : CapabilityTypes.AppScope,
            self : actor {},
        ) : VetKeyTypes.PublicCapability {
            vetkeys.capability(appScope, self);
        };

        public func app_scope(
            appId : Text,
            deploymentId : Text,
        ) : CapabilityTypes.AppScope {
            let ?scope = InstallMemory.appScopeForDeployment(
                mem.install,
                appId,
                deploymentId,
            ) else Runtime.trap("App scope is not available for this deployment");
            scope;
        };

        public func runtime_app_instances(
            deploymentId : Text,
        ) : [InstallTypes.AppInstance] {
            let ?instances = InstallMemory.instancesForDeployment(
                mem.install,
                deploymentId,
            ) else Runtime.trap("App-instance inventory does not match this deployment");
            instances;
        };

        public func committed_app_scope(
            appId : Text,
        ) : ?CapabilityTypes.AppScope {
            InstallMemory.committedScope(mem.install, appId);
        };

        public func scope_active(scope : CapabilityTypes.AppScope) : Bool {
            InstallMemory.scopeActive(mem.install, runningDeploymentId, scope);
        };

        public func configure_scheduled_tasks<system>(tasks : [SchedulerTypes.Task]) : () {
            scheduler.start<system>(tasks);
        };

        public func /*update*/kernel_authorized_add(id : Principal) : () {
            if (not SettingsAccess.validPrincipal(id)) {
                // Actor-class post-upgrade initialization uses anonymous as the
                // installer. Never persist it as an authorized caller.
                Set.remove(mem.core.authorized, Principal.compare, id);
                return;
            };
            Set.add(mem.core.authorized, Principal.compare, id);
        };

        public func /*update*/kernel_authorized_rem(
            id : Principal,
            /*caller*/ caller : Principal,
        ) : () {
            assert(not Principal.equal(id, caller));
            assert(not vetkeys.holdsSlots(id));
            Set.remove(mem.core.authorized, Principal.compare, id);
        };

        public func /*internal*/is_authorized(id : Principal) : Bool {
            Set.contains(mem.core.authorized, Principal.compare, id);
        };

        public func /*query:unauthorized*/kernel_check_authorized((),/*caller*/ caller:Principal) : Bool {
            Set.contains(mem.core.authorized, Principal.compare, caller);
        };

        public func /*update:unauthorized*/kernel_authorized_recover(
            id : Principal,
            /*caller,this*/ caller : Principal,
            self : actor {},
        ) : async* () {
            await* settingsAccess.authorizeFromController(id, caller, self);
        };

        public func /*update:unauthorized*/kernel_activation(
            request : ActivationService.Request,
            /*caller,this*/ caller : Principal,
            self : actor {},
        ) : async* ActivationService.Result {
            switch (request) {
                case (#set(hash)) {
                    await* settingsAccess.assertController(caller, self);
                    activation.set(hash, caller);
                };
                case (#use(token)) {
                    // This branch contains no await. Authorization and token
                    // deletion therefore commit atomically.
                    activation.use(token, caller);
                };
            };
        };

        public func /*update*/kernel_static(cmd: StaticCmd) : () {
            cert.beginV2PublicationBatch();
            switch(cmd) {
                case(#store_chunk(x)) {
                    assert(not InstallService.isDispatchMarkerPath(x.key));
                    assert(not isSharedAppRoutePath(x.key));
                    cert.chunkedSend(x.key, x.chunk_id, x.content);
                };
                case(#store({key; val})) {
                    assert(not InstallService.isDispatchMarkerPath(key));
                    assert(not isSharedAppRoutePath(key));
                    assert(val.chunks > 0);
                    
                    // Allows uploads of large certified files.
                    cert.chunkedStart(key, val.chunks, val.content, func(
                        content : [Blob],
                        bodyHash : Blob,
                    ) {
                        assets.put({
                            id= key;
                            chunks= val.chunks;
                            content= content;
                            content_encoding= val.content_encoding;
                            content_type = val.content_type;
                        });
                        certifyPublicAsset(key, bodyHash);
                    });
                   
                };
                case(#delete({key})) {
                    assert(not InstallService.isDispatchMarkerPath(key));
                    let priorFile = assets.get(key);
                    ignore assets.delete(key);
                    deleteStaticAssetCertification(key, priorFile);
                };
                case(#clear({prefix})) {
                    for (k in assets.allKeys(prefix).vals()) {
                        if (not InstallService.isDispatchMarkerPath(k)) {
                            let priorFile = assets.get(k);
                            ignore assets.delete(k);
                            deleteStaticAssetCertification(k, priorFile);
                        };
                    };
                };
            };
            ignore cert.finishV2PublicationBatch();
        };

        public func /*query*/kernel_static_query(cmd: StaticCmdQuery) : [Text] {
            switch(cmd) {
                case(#list({prefix})) {
                    let keys = assets.keys(prefix, MAX_STATIC_LIST_KEYS + 1);
                    assert(keys.size() <= MAX_STATIC_LIST_KEYS);
                    keys;
                };
            };
        };

        func plainHttpError(
            statusCode : Nat16,
            message : Text,
        ) : Painless.Response {
            {
                body = Text.encodeUtf8(message);
                headers = [
                    ("Content-Type", "text/plain; charset=utf-8"),
                    ("Cache-Control", "no-store"),
                    ("X-Content-Type-Options", "nosniff"),
                ];
                streaming_strategy = null;
                status_code = statusCode;
                upgrade = null;
            };
        };

        func emptyRouteHttpError(statusCode : Nat16) : Painless.Response {
            {
                body = Blob.fromArray([]);
                headers = [("Cache-Control", "no-store")];
                streaming_strategy = null;
                status_code = statusCode;
                upgrade = null;
            };
        };

        func certifiedRouteRange(
            headers : [Painless.HeaderField],
        ) : CertifiedAssetsTypes.RangeSelection {
            switch (CertV2.parseRange(headers)) {
                case (#absent) #absent;
                case (#valid(start)) #start(start);
                case (#unsupported) #unsupported;
            };
        };

        func hasNonemptyHttpQuery(url : Text, canonicalPath : Text) : Bool {
            switch (Text.stripStart(url, #text (canonicalPath # "?"))) {
                case (?queryText) queryText != "";
                case null false;
            };
        };

        func publicationPresentation(
            resolved : CertifiedAssetsTypes.Resolved,
        ) : ?CertV2.PublicationPresentation {
            if (resolved.kind != #publication) return null;
            switch (resolved.presentation) {
                case (?#inline_text) ?#inline_text;
                case (?#attachment) {
                    let ?filename = resolved.filename else return null;
                    ?#attachment({ filename });
                };
                case null null;
            };
        };

        func validPublicationChunkDescriptors(
            resolved : CertifiedAssetsTypes.Resolved,
        ) : Bool {
            if (
                resolved.chunk_descriptors.size() < 1 or
                resolved.chunk_descriptors.size() >
                    CertV2.PUBLICATION_BLOCKS_MAX_V2
            ) return false;
            var expectedOffset = 0;
            var index = 0;
            for (chunk in resolved.chunk_descriptors.vals()) {
                if (
                    chunk.index != Nat32.fromNat(index) or
                    chunk.offset != expectedOffset or
                    chunk.body_hash.size() != 32 or
                    chunk.length > CertV2.PUBLICATION_BLOCK_BYTES_MAX_V2
                ) return false;
                if (
                    resolved.body_bytes > 0 and chunk.length == 0
                ) return false;
                expectedOffset += chunk.length;
                if (expectedOffset > resolved.body_bytes) return false;
                index += 1;
            };
            expectedOffset == resolved.body_bytes and (
                resolved.body_bytes > 0 or
                resolved.chunk_descriptors.size() == 1
            );
        };

        func selectedPublicationBlock(
            resolved : CertifiedAssetsTypes.Resolved,
        ) : ?CertV2.ResolvedPublicationBlock {
            switch (resolved.method) {
                case (#head) {
                    if (resolved.blocks.size() != 0) return null;
                    null;
                };
                case (#get) {
                    if (resolved.blocks.size() != 1) return null;
                    let block = resolved.blocks[0];
                    let index = Nat32.toNat(block.index);
                    if (index >= resolved.chunk_descriptors.size()) return null;
                    let descriptor = resolved.chunk_descriptors[index];
                    if (
                        descriptor.index != block.index or
                        descriptor.offset != block.offset or
                        descriptor.length != block.length or
                        descriptor.body_hash != block.body_hash or
                        block.body.size() != block.length
                    ) return null;
                    ?{
                        index;
                        offset = block.offset;
                        length = block.length;
                        body_hash = block.body_hash;
                    };
                };
            };
        };

        func certifiedRouteResponse(
            url : Text,
            request : Painless.Request,
            response : CertV2.CertifiedResponse,
            leaf : Cert.V2LeafKey,
            body : Blob,
        ) : ?Painless.Response {
            let ?certificate = cert.certificationHeaderV2FromLeaf(
                url,
                {
                    method = request.method;
                    headers = request.headers;
                    body = request.body;
                },
                leaf,
            ) else return null;
            ?{
                body;
                headers = Array.concat<Painless.HeaderField>(
                    response.response_headers,
                    [certificate],
                );
                streaming_strategy = null;
                status_code = response.status_code;
                upgrade = null;
            };
        };

        func presentCertifiedRouteResponse(
            url : Text,
            authority : Text,
            request : Painless.Request,
            resolved : CertifiedAssetsTypes.Resolved,
        ) : ?Painless.Response {
            if (resolved.canonical_path != url) return null;
            let ?leaf = resolved.certification_leaf_key else return null;
            switch (publicationPresentation(resolved)) {
                case (?presentation) {
                    if (
                        resolved.authority_mode != #exact_neutron_host_v1 or
                        not validPublicationChunkDescriptors(resolved)
                    ) return null;
                    let selected = selectedPublicationBlock(resolved);
                    let method : CertV2.PublicationMethod = switch (resolved.method) {
                        case (#get) {
                            if (selected == null) return null;
                            #get;
                        };
                        case (#head) #head;
                    };
                    let rendered = switch (CertV2.resolvedPublicationResponse({
                        canonical_path = resolved.canonical_path;
                        host = authority;
                        presentation;
                        content_tag = resolved.content_tag;
                        total_length = resolved.body_bytes;
                        method;
                        selected_block = selected;
                    })) {
                        case (#ok(value)) value;
                        case (#err(_)) return null;
                    };
                    let body = switch (resolved.method) {
                        case (#head) Blob.fromArray([]);
                        case (#get) resolved.blocks[0].body;
                    };
                    certifiedRouteResponse(
                        url,
                        request,
                        rendered.response,
                        leaf,
                        body,
                    );
                };
                case null {
                    if (
                        resolved.authority_mode != #canister_gateway_v1 or
                        resolved.method != #get or
                        resolved.blocks.size() != 1
                    ) return null;
                    let block = resolved.blocks[0];
                    if (
                        block.index != 0 or block.offset != 0 or
                        block.length != resolved.body_bytes or
                        block.body.size() != block.length or
                        block.body_hash != resolved.body_hash
                    ) return null;
                    let policy : CertV2.PortableBlobPolicy = switch (resolved.kind) {
                        case (#immutable_blob) #immutable;
                        case (#mutable_blob) #mutable;
                        case (#publication) return null;
                    };
                    let rendered = switch (CertV2.portableBlobOwnerResponses({
                        canonical_path = resolved.canonical_path;
                        policy;
                        body_hash = resolved.body_hash;
                        body_length = resolved.body_bytes;
                    })) {
                        case (#ok(value)) value;
                        case (#err(_)) return null;
                    };
                    if (rendered.responses.size() != 1) return null;
                    certifiedRouteResponse(
                        url,
                        request,
                        rendered.responses[0],
                        leaf,
                        block.body,
                    );
                };
            };
        };

        func absentCertifiedRouteResponse(
            url : Text,
            authority : Text,
            request : Painless.Request,
            resolved : CertifiedAssetsTypes.ResolvedAbsence,
        ) : ?Painless.Response {
            if (resolved.canonical_path != url) return null;
            let leaf : Cert.V2LeafKey = resolved.certification_leaf_key;
            let rendered = switch (resolved.authority_mode) {
                case (#exact_neutron_host_v1) {
                    CertV2.absenceOwnerResponses({
                        base_path = leaf.owner.canonical_path;
                        authority = #host_bound({ host = authority });
                    });
                };
                case (#canister_gateway_v1) {
                    CertV2.absenceOwnerResponses({
                        base_path = leaf.owner.canonical_path;
                        authority = #portable;
                    });
                };
            };
            let sets = switch (rendered) {
                case (#ok(value)) value;
                case (#err(_)) return null;
            };
            var selected : ?CertV2.CertifiedResponse = null;
            for (set in sets.vals()) {
                if (set.owner.method == request.method) {
                    if (
                        selected != null or set.responses.size() != 1
                    ) return null;
                    selected := ?set.responses[0];
                };
            };
            let ?response = selected else return null;
            certifiedRouteResponse(
                url,
                request,
                response,
                leaf,
                Blob.fromArray([]),
            );
        };

        func httpPostUpdateHandlerResponse(
            response : HttpPostUpdateHandlerResponseV1,
        ) : Painless.Response {
            let statusCode : Nat16 = switch (response.status) {
                case (#ok) 200;
                case (#created) 201;
                case (#accepted) 202;
                case (#bad_request) 400;
                case (#unauthorized) 401;
                case (#forbidden) 403;
                case (#not_found) 404;
                case (#conflict) 409;
                case (#unprocessable_content) 422;
            };
            {
                body = response.body;
                headers = [
                    ("Content-Type", response.content_type),
                    ("Content-Encoding", "identity"),
                    ("Content-Length", Nat.toText(response.body.size())),
                    ("Cache-Control", "no-store"),
                    ("X-Content-Type-Options", "nosniff"),
                    ("Referrer-Policy", "no-referrer"),
                    ("Permissions-Policy", "camera=(), geolocation=(), microphone=()"),
                    ("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"),
                ];
                streaming_strategy = null;
                status_code = statusCode;
                upgrade = null;
            };
        };

        func httpPostUpdateHandlerError(error : HttpPostUpdateHandlersTypes.Error) : Painless.Response {
            switch (error) {
                case (#bad_request) plainHttpError(400, "Invalid public POST request");
                case (#not_found) plainHttpError(404, "Public POST route not found");
                case (#method_not_allowed) plainHttpError(405, "Unsupported HTTP method");
                case (#too_large) plainHttpError(413, "HTTP request body is too large");
                case (#conflict) plainHttpError(409, "Idempotency key conflicts with an earlier request");
                case (#pending) plainHttpError(425, "Request is already in progress");
                case (#failed_unknown) plainHttpError(409, "Earlier request outcome is unknown");
                case (#rate_limited) plainHttpError(429, "Public POST route is rate limited");
                case (#capacity_exceeded) plainHttpError(503, "Public POST replay capacity is full");
                case (#busy) plainHttpError(503, "Public POST route is busy");
                case (#low_cycles) plainHttpError(503, "Public POST route is unavailable");
                case (#revoked) plainHttpError(503, "Public POST route authority changed");
                case (#handler_failed) plainHttpError(500, "Public POST handler failed");
            };
        };

        func assetNotFound(url : Text) : Painless.Response {
            let certificate = cert.notFoundCertificationHeader(
                url,
                notFoundHeaders,
                notFoundBodyHash,
            );
            let headers = switch (certificate) {
                case (?header) Array.concat<Painless.HeaderField>(
                    notFoundHeaders,
                    [header],
                );
                case null notFoundHeaders;
            };
            {
                body = notFoundBody;
                headers;
                streaming_strategy = null;
                status_code = 404;
                upgrade = null;
            };
        };

        func httpAssetOriginPolicy(
            headers : [Painless.HeaderField],
            url : Text,
            canisterId : Text,
        ) : HttpAssetOriginPolicy {
            let authority = requestHostAuthority(headers);

            switch (appIdFromAssetUrl(url)) {
                case (null) {
                    switch (authority) {
                        case (#invalid) #deny;
                        case (#present(host)) {
                            if (
                                RouteNamespace.isSharedAuthority(
                                    canisterId,
                                    host.authority,
                                )
                            ) #kernel else #deny;
                        };
                        case (#missing) #kernel;
                    };
                };
                case (?appId) {
                    let ?instance = InstallMemory.findApp(
                        mem.install.committed_app_instances,
                        appId,
                    ) else return #deny;
                    if (not InstallMemory.scopeActive(
                        mem.install,
                        runningDeploymentId,
                        instance.scope,
                    )) {
                        return #deny;
                    };
                    appAssetOriginPolicyForHeaders(
                        headers,
                        canisterId,
                        appId,
                        instance.browser_origin_nonce,
                        dedicatedResidentOriginActive(instance),
                    );
                };
            };
        };

        public func /*query:unauthorized*/http_request(
            request : Painless.Request,
            /*this*/ self : actor {
                http_request_streaming_callback : Painless.CallbackFunc;
            },
        ) : Painless.Response {
            if (not supportedHttpCertificationVersion(
                request.certificate_version,
            )) {
                return plainHttpError(
                    426,
                    "HTTP response verification v2 is required",
                );
            };
            let ?url = validatedHttpAssetPath(request.url) else {
                return plainHttpError(400, "Invalid HTTP request target");
            };
            if (request.method == "POST") {
                if (
                    request.url != url or
                    request.body.size() > HttpPostUpdateHandlersService.MAX_REQUEST_BYTES or
                    not boundedHttpEnvelope(request.url, request.headers)
                ) return plainHttpError(400, "Invalid public POST request");
                switch (requestHostAuthority(request.headers)) {
                    case (#present(authority)) {
                        if (
                            not authority.raw_gateway and
                            httpPostUpdateHandlers.canUpgrade(
                                authority.authority,
                                url,
                                request.method,
                                request.headers,
                                request.body,
                            )
                        ) {
                            return {
                                body = Text.encodeUtf8("");
                                headers = [];
                                streaming_strategy = null;
                                status_code = 200;
                                upgrade = ?true;
                            };
                        };
                    };
                    case _ {};
                };
                return plainHttpError(404, "Public POST route not found");
            };
            if (not boundedCertifiedHttpRequest(request)) {
                return plainHttpError(405, "Unsupported HTTP request");
            };
            if (isInternalHttpStatePath(url)) return assetNotFound(url);

            // The v2 CEL expression selects no query parameters. Host-bound
            // publications ignore a query alias; portable blobs reject a
            // non-empty query before any object lookup.
            switch (requestHostAuthority(request.headers)) {
                case (#present(authority)) {
                    switch (certifiedAssets.resolve(
                        authority.authority,
                        url,
                        request.method,
                        certifiedRouteRange(request.headers),
                        hasNonemptyHttpQuery(request.url, url),
                    )) {
                        case (?#bad_request) {
                            return emptyRouteHttpError(400);
                        };
                        case (?#present(resolved)) {
                            let ?response = presentCertifiedRouteResponse(
                                url,
                                authority.authority,
                                request,
                                resolved,
                            ) else return emptyRouteHttpError(404);
                            return response;
                        };
                        case (?#absent(resolved)) {
                            let ?response = absentCertifiedRouteResponse(
                                url,
                                authority.authority,
                                request,
                                resolved,
                            ) else return emptyRouteHttpError(404);
                            return response;
                        };
                        case null {};
                    };
                };
                case _ {};
            };
            // A shared-route path never falls through to package assets. This
            // remains true for an unknown, disabled, or record-missing mount.
            if (isSharedAppRoutePath(url)) return assetNotFound(url);
            if (request.method != "GET") {
                return plainHttpError(405, "Unsupported HTTP request");
            };
            let originPolicy = if (isPackageHttpAssetPath(url)) {
                // Public package/compiler data has one sandboxed response
                // policy on every gateway authority. Its v2 proof therefore
                // remains valid on non-default local ports without weakening
                // exact-Host proofs for executable web assets or app routes.
                #opaque_app;
            } else {
                httpAssetOriginPolicy(
                    request.headers,
                    url,
                    canisterId,
                );
            };
            switch (originPolicy) {
                case (#deny) return assetNotFound(url);
                case _ {};
            };

            switch (assets.get(url)) {
                case null assetNotFound(url);
                case (?file) {
                    if (file.chunks != file.content.size()) {
                        return assetNotFound(url);
                    };
                    let residentKind : ?Cert.ResidentRequestKind = if (
                        originPolicy == #persistent_app
                    ) {
                        let ?appId = appIdFromAssetUrl(url) else {
                            return assetNotFound(url);
                        };
                        let ?instance = InstallMemory.findApp(
                            mem.install.committed_app_instances,
                            appId,
                        ) else return assetNotFound(url);
                        if (
                            not dedicatedResidentOriginActive(instance) or
                            not dedicatedResidentAssetRequestBound(
                                request.url,
                                url,
                                request.headers,
                                file.content_type,
                                instance,
                            )
                        ) return assetNotFound(url);
                        let ?kind = residentRequestKindForRequest(
                            request.url,
                            url,
                            request.headers,
                            file.content_type,
                            instance,
                        ) else return assetNotFound(url);
                        ?kind;
                    } else {
                        null;
                    };
                    let ?bodyHash = cert.assetHash(url) else {
                        return assetNotFound(url);
                    };
                    let headers = certifiedResponseHeaders(
                        url,
                        file,
                        originPolicy,
                        bodyHash,
                        switch (residentKind) {
                            case (?kind) {
                                ?Cert.residentCertificationExpression(kind);
                            };
                            case null null;
                        },
                    );
                    let certifiedRequest : Cert.CertifiedRequest = {
                        method = request.method;
                        headers = request.headers;
                        body = request.body;
                    };
                    let certificate = switch (residentKind) {
                        case (?_) cert.residentCertificationHeader(
                            url,
                            request.url,
                            certifiedRequest,
                            headers,
                            bodyHash,
                        );
                        case null cert.certificationHeader(
                            url,
                            certifiedRequest,
                            headers,
                            bodyHash,
                        );
                    };
                    let ?certification = certificate else {
                        return assetNotFound(url);
                    };
                    let assetRequest : Painless.Request = {
                        method = request.method;
                        url;
                        headers = request.headers;
                        body = request.body;
                        certificate_version = request.certificate_version;
                    };
                    Painless.Request(assetRequest, {
                        chunkFunc = func(_key : Text, _index : Nat) : Painless.Chunk {
                            if (file.chunks > 1) return #more(file.content[0]);
                            #end(file.content[0]);
                        };
                        cbFunc = self.http_request_streaming_callback;
                        headers = Array.concat<Painless.HeaderField>(
                            headers,
                            [certification],
                        );
                    });
                };
            }
        };

        public func /*query:unauthorized*/http_request_streaming_callback(
            token : Painless.Token,
        ) : Painless.Callback {
            if (
                validatedHttpAssetPath(token.key) != ?token.key or
                isInternalHttpStatePath(token.key) or
                isSharedAppRoutePath(token.key)
            ) return { body = Text.encodeUtf8(""); token = null };

            Painless.Callback(token, {
                chunkFunc = func(key : Text, index : Nat) : Painless.Chunk {
                    switch (assets.get(key)) {
                        case null #none;
                        case (?file) {
                            if (
                                file.chunks != file.content.size() or
                                index >= file.chunks
                            ) return #none;
                            if (index + 1 < file.chunks) {
                                #more(file.content[index]);
                            } else {
                                #end(file.content[index]);
                            };
                        };
                    };
                };
            });
        };

        public func /*update:unauthorized*/http_request_update(
            request : Painless.UpdateRequest,
            /*caller*/ caller : Principal,
        ) : async* Painless.Response {
            let ?url = validatedHttpAssetPath(request.url) else {
                return plainHttpError(400, "Invalid HTTP request target");
            };
            if (
                request.method != "POST" or request.url != url or
                request.body.size() > HttpPostUpdateHandlersService.MAX_REQUEST_BYTES or
                not boundedHttpEnvelope(request.url, request.headers)
            ) return plainHttpError(400, "Invalid public POST request");
            let #present(authority) = requestHostAuthority(request.headers) else {
                return plainHttpError(400, "A single valid Host header is required");
            };
            if (authority.raw_gateway) {
                return plainHttpError(404, "Public POST route not found");
            };
            let result = await* httpPostUpdateHandlers.dispatch(
                caller,
                authority.authority,
                url,
                request.method,
                request.headers,
                request.body,
            );
            switch (result) {
                case (#ok(response)) httpPostUpdateHandlerResponse(response);
                case (#err(error)) httpPostUpdateHandlerError(error);
            };
        };

        // The IC invokes this pure query separately on each replica before
        // response consensus. Only the management principal may enter it;
        // app code cannot select the callback or its one-byte context.
        public func /*query:unauthorized*/kernel_https_outcall_transform(
            args : IC.http_transform_args,
            /*caller*/ caller : Principal,
        ) : IC.http_request_result {
            assert (HttpsOutcallsAdapter.managementCaller(caller));
            HttpsOutcallsAdapter.transform(args);
        };

        public func /*update*/kernel_install_begin_checked(
            inp : InstallTypes.CheckedBeginInput,
        ) : () {
            assert(inp.expected_deployment_id == runningDeploymentId);
            installs.begin(inp.journal);
        };

        public func /*query*/kernel_install_status(()) : ?InstallTypes.Status {
            installs.status();
        };

        public func /*query*/kernel_settings_snapshot(()) : SettingsTypes.Snapshot {
            SettingsService.snapshot();
        };

        public func /*query*/kernel_certified_assets_scope_info(
            scope : CapabilityTypes.AppScope,
        ) : CertifiedAssetsTypes.ScopeInfoResult {
            certifiedAssets.scopeInfo(scope);
        };

        public func /*query*/kernel_certified_assets_usage(
            scope : CapabilityTypes.AppScope,
        ) : CertifiedAssetsTypes.UsageResult {
            certifiedAssets.usage(scope);
        };

        public func /*query*/kernel_certified_assets_diagnostics(
            (),
        ) : CertifiedAssetsTypes.Diagnostics {
            certifiedAssets.diagnostics();
        };

        // Kernel-authorized Settings integrity surface. It is intentionally
        // absent from every app capability handle and exposes only a bounded
        // cursor page.
        public func /*query*/kernel_certified_assets_audit_content_ownership_page(
            input : {
                cursor : ?CertifiedAssetsTypes.ContentOwnershipAuditCursor;
                max_nodes : Nat;
            },
        ) : CertifiedAssetsTypes.ContentOwnershipAuditPage {
            certifiedAssets.auditContentOwnershipPage(
                input.cursor,
                input.max_nodes,
            );
        };

        public func /*query*/kernel_certified_assets_audit_catalog_page(
            input : {
                cursor : ?CertifiedAssetsTypes.CatalogAuditCursor;
                max_nodes : Nat;
            },
        ) : CertifiedAssetsTypes.CatalogAuditPage {
            certifiedAssets.auditCatalogPage(
                input.cursor,
                input.max_nodes,
            );
        };

        public func /*update*/kernel_certified_assets_set_admission_ceilings(
            input : {
                scope : CapabilityTypes.AppScope;
                ceilings : CertifiedAssetsTypes.AdmissionCeilings;
            },
        ) : CertifiedAssetsTypes.Result {
            certifiedAssets.settingsSetAdmissionCeilings(
                input.scope,
                input.ceilings,
            );
        };

        public func /*update*/kernel_certified_assets_set_writes_frozen(
            input : {
                scope : CapabilityTypes.AppScope;
                frozen : Bool;
            },
        ) : CertifiedAssetsTypes.Result {
            certifiedAssets.settingsSetWritesFrozen(
                input.scope,
                input.frozen,
            );
        };

        public func /*update*/kernel_certified_assets_maintenance_page(
            scope : CapabilityTypes.AppScope,
        ) : CertifiedAssetsTypes.MaintenancePageOk {
            certifiedAssets.settingsMaintenancePage(scope);
        };

        public func /*update*/kernel_certified_assets_retire_scope(
            scope : CapabilityTypes.AppScope,
        ) : CertifiedAssetsTypes.Result {
            certifiedAssets.settingsRetireScope(scope);
        };

        public func /*update*/kernel_publication_entropy_initialize(
        ) : async* PublicationEntropyInitializeResult {
            switch (certifiedAssets.publicationEntropyFingerprint()) {
                case (?fingerprint) {
                    return #ok({ fingerprint });
                };
                case null {};
            };
            try {
                let random32 = await IC.management.raw_rand();
                switch (certifiedAssets.initializePublicationEntropy(
                    random32,
                )) {
                    case (?fingerprint) #ok({ fingerprint });
                    case null #err(#randomness_failed);
                };
            } catch (_cause) {
                // Another concurrent initializer may have stored the winner
                // while this raw_rand call was suspended.
                switch (certifiedAssets.publicationEntropyFingerprint()) {
                    case (?fingerprint) {
                        #ok({ fingerprint });
                    };
                    case null #err(#randomness_failed);
                };
            };
        };

        public func /*query*/kernel_app_usage_snapshot(
            (),
        ) : AppUsageTypes.SnapshotV2 {
            appUsage.snapshot();
        };

        public func /*update*/kernel_memory_snapshot(
            (),
            /*this*/ self : actor {},
        ) : async* SettingsTypes.MemorySnapshot {
            await* SettingsService.memorySnapshot(self);
        };

        public func /*query*/kernel_backend_reservations_snapshot(
            (),
        ) : [BackendCallTypes.ReservationSummary] {
            backendCalls.reservations();
        };

        public func /*query*/kernel_scheduled_tasks_snapshot(()) : [SchedulerTypes.Summary] {
            scheduler.summaries();
        };

        public func /*query*/kernel_capabilities_page(
            input : CapabilityTypes.CapabilityPageInput,
        ) : CapabilityTypes.CapabilityPage {
            capabilityRegistry.page(input);
        };

        public func /*update*/kernel_capability_set_enabled(
            input : CapabilityTypes.CapabilitySetEnabledInput,
            /*caller*/ caller : Principal,
        ) : CapabilityTypes.CapabilitySummary {
            setCapabilityEnabled(input, caller);
        };

        func setCapabilityEnabled(
            input : CapabilityTypes.CapabilitySetEnabledInput,
            caller : Principal,
        ) : CapabilityTypes.CapabilitySummary {
            let ?updated = capabilityRegistry.setEnabled(input, caller) else {
                Runtime.trap("Capability resource is unavailable");
            };
            if (not updated.enabled) {
                switch (updated.kind) {
                    case (#scheduled_tasks) {
                        ignore scheduler.closeDisabledLease(
                            updated.scope,
                            updated.resource_id,
                        );
                    };
                    case (_) {};
                };
            };
            switch (updated.kind) {
                case (#certified_assets) {
                    // The registry revocation epoch changes on every toggle,
                    // including a disable/re-enable pair. Mirror that change
                    // in stable store/collection authority so accepted
                    // positive-write authority from the prior generation
                    // cannot resume after re-enable.
                    certifiedAssets.rotateStoreAuthority(updated.scope);
                };
                case (#certified_read_routes) {
                    certifiedAssets.setMountEnabled(
                        updated.scope,
                        updated.resource_id,
                        updated.enabled,
                    );
                };
                case (#http_routes) {
                    httpPostUpdateHandlers.setMountEnabled(
                        updated.scope,
                        updated.resource_id,
                    );
                };
                case (#public_ingress) {
                    publicIngress.setRouteEnabled(
                        updated.scope,
                        updated.resource_id,
                    );
                };
                case (#persistent_browser_storage) {
                    reconcilePublicStaticAssetsForApp(updated.scope.app_id);
                };
                case (#dedicated_resident_origin) {
                    reconcilePublicStaticAssetsForApp(updated.scope.app_id);
                };
                case (_) {};
            };
            updated;
        };

        public func /*update*/kernel_backend_reservations_apply(
            inp : BackendCallTypes.ReservationApplyInput,
            /*caller,this*/ caller : Principal,
            self : actor {},
        ) : [BackendCallTypes.ReservationSummary] {
            // Preparation relies on a frozen reservation table until commit
            // or abort consumes the pending install journal. Claims remain
            // inert, so existing apps can still call already-owned scopes.
            assert (installs.status() == null);
            backendCalls.applyReservations(inp, caller, self);
        };

        public func /*update*/kernel_install_reservations_prepare(
            inp : BackendCallTypes.InstallReservationsPrepareInput,
            /*caller*/ caller : Principal,
        ) : () {
            let preparation = installs.reservationPreparation({
                deployment_id = inp.deployment_id;
            });
            backendCalls.prepareInstallReservations(
                inp.apps,
                preparation.target_scopes,
                preparation.changed_scopes,
                caller,
                canisterPrincipal,
            );
        };

        // Recovery candidates are derived from the compiled target defaults,
        // not from the ordinary reservation snapshot. At most one
        // deterministic row is exposed at a time and every retry recomputes
        // whether its removal still advances the pending target.
        public func /*query*/kernel_install_pending_reservation_blockers(
            inp : InstallTypes.DeploymentInput,
        ) : [BackendCallTypes.PendingReservationBlocker] {
            if (inp.deployment_id != runningDeploymentId) return [];
            let ?status = installs.status() else return [];
            if (status.deployment_id != runningDeploymentId) return [];
            let preparation = installs.commitReservationPreparation(inp);
            backendCalls.pendingInstallReservationBlockers(
                preparation.changed_scopes,
                canisterPrincipal,
            );
        };

        // Ordinary reservation mutation stays frozen. Release re-derives the
        // authoritative candidate inside this update and refuses stale,
        // unrelated, or immediately recreated rows.
        public func /*update*/kernel_install_pending_reservation_release(
            inp : {
                deployment_id : Text;
                reservation_id : Nat;
            },
        ) : Bool {
            if (inp.deployment_id != runningDeploymentId) return false;
            let ?status = installs.status() else return false;
            if (status.deployment_id != runningDeploymentId) return false;
            let preparation = installs.commitReservationPreparation({
                deployment_id = inp.deployment_id;
            });
            backendCalls.releasePendingReservation(
                preparation.changed_scopes,
                canisterPrincipal,
                inp.reservation_id,
            );
        };

        public func /*update*/kernel_access_snapshot(
            (),
            /*this*/ self : actor {},
        ) : async* SettingsTypes.AccessSnapshot {
            await* settingsAccess.snapshot(self);
        };

        public func /*update*/kernel_controller_add(
            id : Principal,
            /*this*/ self : actor {},
        ) : async* SettingsTypes.AccessSnapshot {
            await* settingsAccess.addController(id, self);
        };

        public func /*update*/kernel_controller_rem(
            id : Principal,
            /*this*/ self : actor {},
        ) : async* SettingsTypes.AccessSnapshot {
            await* settingsAccess.removeController(id, self);
        };

        public func /*update*/kernel_install_commit<system>(
            inp : InstallTypes.DeploymentInput,
            /*caller*/ caller : Principal,
            managedMemoryCommit : Text -> (),
        ) : InstallTypes.CommitResult {
            commitInstall<system>(
                inp,
                caller,
                managedMemoryCommit,
            );
        };

        func commitInstall<system>(
            inp : InstallTypes.DeploymentInput,
            caller : Principal,
            managedMemoryCommit : Text -> (),
        ) : InstallTypes.CommitResult {
            // Journal assets belong to the compiled actor named by the
            // deployment id. Never publish them while its predecessor is
            // still running.
            if (inp.deployment_id != runningDeploymentId) return #blocked;
            let ?status = installs.status() else return #committed;
            if (status.deployment_id != inp.deployment_id) return #blocked;
            if (not stableStore.configurationCommitReady()) return #blocked;
            let preparation =
                installs.commitReservationPreparation(inp);
            if (not backendCalls.canFinalizeInstallReservations(
                preparation.changed_scopes,
                caller,
                canisterPrincipal,
            )) return #blocked;
            if (not certifiedAssets.configurationCommitReady()) {
                return #blocked;
            };

            // Reservation readiness is established before any inventory,
            // certification, capability, or scheduler mutation begins.
            cert.beginV2PublicationBatch();
            assert (backendCalls.finalizeInstallReservations(
                preparation.changed_scopes,
                caller,
                canisterPrincipal,
            ));
            ignore installs.commit(inp, caller, managedMemoryCommit);
            assert (capabilityRegistry.commitConfiguration(caller));
            certifiedAssets.syncRuntimeState();
            reconcileResidentBackgroundEntrypoints();
            // Reconcile task state and release run_on_start only after the
            // install service has atomically promoted this deployment.
            scheduler.commitConfiguration<system>();
            ignore cert.finishV2PublicationBatch();
            #committed;
        };

        public func /*update*/kernel_install_abort(
            inp : InstallTypes.DeploymentInput,
            /*this*/ self : actor {},
        ) : async* () {
            // Never discard the assets/journal for the actor that is running.
            assert(inp.deployment_id != runningDeploymentId);
            if (installs.isDispatched(inp)) {
                // Calls from this canister to the management canister are FIFO.
                // A successful status reply proves the earlier one-way install
                // request is terminal. Successful activation replaces this
                // continuation; only the old actor can resume and safely abort.
                ignore await IC.management.canister_status({
                    canister_id = Principal.fromActor(self);
                });
                assert(inp.deployment_id != runningDeploymentId);
                installs.abortAfterManagementFence(inp);
            } else {
                installs.abort(inp);
            };
        };

        public func /*update*/kernel_install_wasm_chunks_clear(
            inp : InstallTypes.DeploymentInput,
            /*this*/ self : actor {},
        ) : async* () {
            assert (InstallMemory.has(mem.install, inp.deployment_id));
            if (
                installs.isDispatched(inp) and
                inp.deployment_id != runningDeploymentId
            ) {
                // Calls from this canister to management are FIFO. If the
                // chunked install succeeds, this callback is replaced by the
                // new actor. If it resumes in the old actor, the earlier
                // install is terminal and the chunk store is safe to clear.
                ignore await IC.management.canister_status({
                    canister_id = Principal.fromActor(self);
                });
                assert (inp.deployment_id != runningDeploymentId);
            };
            await IC.management.clear_chunk_store({
                canister_id = Principal.fromActor(self);
            });
        };

        public func /*update*/kernel_install_wasm_chunk(
            inp : {
                deployment_id : Text;
                chunk : Blob;
                sha256 : Blob;
            },
            /*this*/ self : actor {},
        ) : async* () {
            assert (
                inp.chunk.size() > 0 and
                inp.chunk.size() <= MAX_INSTALL_WASM_CHUNK_BYTES
            );
            assert (inp.sha256.size() == SHA256_BYTES);
            let deployment = { deployment_id = inp.deployment_id };
            assert (InstallMemory.has(mem.install, inp.deployment_id));
            ignore installs.reservationPreparation(deployment);
            let uploaded = await IC.management.upload_chunk({
                canister_id = Principal.fromActor(self);
                chunk = inp.chunk;
            });
            // Re-check the journal after the management await. Another
            // authorized tab cannot turn an upload for an aborted or already
            // dispatched install into authority for a different deployment.
            assert (InstallMemory.has(mem.install, inp.deployment_id));
            ignore installs.reservationPreparation(deployment);
            assert (uploaded.hash == inp.sha256);
        };

        public func /*update*/kernel_install_code_chunked(
            inp : {
                deployment_id : Text;
                chunk_hashes : [Blob];
                wasm_module_hash : Blob;
            },
            /*this*/ self : actor {},
        ) : async* () {
            assert (
                inp.chunk_hashes.size() > 0 and
                inp.chunk_hashes.size() <= MAX_INSTALL_WASM_CHUNKS
            );
            assert (inp.wasm_module_hash.size() == SHA256_BYTES);
            for (hash in inp.chunk_hashes.vals()) {
                assert (hash.size() == SHA256_BYTES);
            };
            assert (InstallMemory.has(mem.install, inp.deployment_id));
            let deployment = { deployment_id = inp.deployment_id };
            installs.markDispatched(deployment);
            try {
                IC.management.install_chunked_code({
                    arg = [];
                    mode = #upgrade(?{
                        skip_pre_upgrade = null;
                        wasm_memory_persistence = ?#keep;
                    });
                    target_canister = Principal.fromActor(self);
                    store_canister = null;
                    chunk_hashes_list = Array.map<Blob, IC.chunk_hash>(
                        inp.chunk_hashes,
                        func(hash) { { hash } },
                    );
                    wasm_module_hash = inp.wasm_module_hash;
                    sender_canister_version = ?Prim.canisterVersion();
                });
            } catch (cause) {
                switch (Error.code(cause)) {
                    case (#call_error(_)) {
                        installs.clearDispatchAfterCallError(deployment);
                    };
                    case (_) {};
                };
                throw cause;
            };
        };

        public func /*update*/kernel_install_code(inp: {wasm: [Nat8]; candid: Text; deployment_id : Text}, /*this*/ self: actor {}) : async* () {
            assert (InstallMemory.has(mem.install, inp.deployment_id));
            let deployment = { deployment_id = inp.deployment_id };
            installs.markDispatched(deployment);
            try {
                IC.management.install_code({
                    arg = [];
                    wasm_module = inp.wasm;
                    mode = #upgrade(?{
                        skip_pre_upgrade = null;
                        wasm_memory_persistence = ?#keep;
                    });
                    canister_id = Principal.fromActor(self);
                    sender_canister_version = ?Prim.canisterVersion();
                });
            } catch (cause) {
                switch (Error.code(cause)) {
                    case (#call_error(_)) {
                        // The one-way message was definitely not enqueued.
                        installs.clearDispatchAfterCallError(deployment);
                    };
                    case (_) {};
                };
                throw cause;
            };

        };

        public func /*update*/kernel_connections_begin(
            inp : ConnectionTypes.BeginConnectionInput,
            /*caller,this*/ caller : Principal,
            self : actor {},
        ) : async* ConnectionTypes.BeginConnectionResult {
            await* connections.begin(inp, caller, self);
        };

        public func /*update*/kernel_connections_complete(
            inp : ConnectionTypes.CompleteConnectionInput,
            /*caller*/ caller : Principal,
        ) : async* ConnectionTypes.ConnectionSummary {
            await* connections.complete(inp, caller);
        };

        public func /*query*/kernel_connections_list(
            inp : ConnectionTypes.ListConnectionsInput,
            /*caller*/ caller : Principal,
        ) : [ConnectionTypes.ConnectionSummary] {
            connections.list(inp, caller);
        };

        public func /*update*/kernel_connections_acquire(
            inp : ConnectionTypes.ConnectionInput,
            /*caller*/ caller : Principal,
        ) : async* ConnectionTypes.SensitiveCredential {
            await* connections.acquire(inp, caller);
        };

        public func /*update*/kernel_connections_disconnect(
            inp : ConnectionTypes.ConnectionInput,
            /*caller*/ caller : Principal,
        ) : async* ConnectionTypes.ConnectionSummary {
            await* connections.disconnect(inp, caller);
        };

        // The frontend broker supplies app_id only after resolving a live
        // source endpoint. SDK payloads do not contain app identity.
        public func /*query*/kernel_vetkeys_list(
            input : { app_id : Text },
        ) : [VetKeyTypes.PublicSlotSummary] {
            vetkeys.list(input.app_id);
        };

        public func /*query*/kernel_vetkeys_binding(
            input : { app_id : Text; slot_id : Text },
        ) : VetKeyTypes.OperationResult<Nat> {
            vetkeys.binding(input.app_id, input.slot_id);
        };

        public func /*update*/kernel_vetkeys_reserve(
            input : VetKeyTypes.AppSlotInput,
            /*caller,this*/ caller : Principal,
            self : actor {},
        ) : async* VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary> {
            await* vetkeys.reserve(input, caller, self);
        };

        public func /*update*/kernel_vetkeys_enable(
            input : VetKeyTypes.AppSlotInput,
            /*caller*/ caller : Principal,
        ) : VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary> {
            vetkeys.enable(input, caller);
        };

        public func /*update*/kernel_vetkeys_disable(
            input : VetKeyTypes.AppSlotInput,
            /*caller*/ caller : Principal,
        ) : VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary> {
            vetkeys.disable(input, caller);
        };

        public func /*update*/kernel_vetkeys_rotate(
            input : VetKeyTypes.AppSlotInput,
            /*caller*/ caller : Principal,
        ) : VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary> {
            vetkeys.rotate(input, caller);
        };

        public func /*update*/kernel_vetkeys_retire_generation(
            input : VetKeyTypes.AppGenerationInput,
            /*caller*/ caller : Principal,
        ) : VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary> {
            vetkeys.retireGeneration(input, caller);
        };

        public func /*update*/kernel_vetkeys_transfer(
            input : VetKeyTypes.TransferInput,
            /*caller*/ caller : Principal,
        ) : VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary> {
            vetkeys.transfer(input, caller);
        };

        public func /*update*/kernel_vetkeys_retire_slot(
            input : VetKeyTypes.AppSlotInput,
            /*caller*/ caller : Principal,
        ) : VetKeyTypes.OperationResult<()> {
            vetkeys.retireSlot(input, caller);
        };

        public func /*update*/kernel_vetkeys_public_key(
            input : {
                app_id : Text;
                slot_id : Text;
                generation : Nat64;
            },
            /*this*/ self : actor {},
        ) : async* VetKeyTypes.PublicKeyResult {
            await* vetkeys.publicKey(
                input.app_id,
                { slot = input.slot_id; generation = input.generation },
                Principal.fromActor(self),
            );
        };

        public func /*update*/kernel_vetkeys_derive(
            input : VetKeyTypes.DeriveInput,
            /*caller,this*/ caller : Principal,
            self : actor {},
        ) : async* VetKeyTypes.DeriveResult {
            await* vetkeys.derive(
                input,
                caller,
                Principal.fromActor(self),
            );
        };

        public func /*query*/kernel_vetkeys_audit_snapshot(
            (),
        ) : [VetKeyTypes.AuditEntry] {
            vetkeys.auditSnapshot();
        };

        public func /*query*/kernel_vetkeys_admin_snapshot(
            (),
        ) : VetKeyTypes.AdminSnapshot {
            vetkeys.adminSnapshot();
        };


    };

    func nowNanos() : Nat64 {
        Nat64.fromNat(Int.abs(Time.now()));
    };


/*---NEUTRON GENERATED BEGIN---*/

public type kernel_authorized_add_Input = (id : Principal);
public type kernel_authorized_add_Output = ();

public type kernel_authorized_rem_Input = (id : Principal);
public type kernel_authorized_rem_Output = ();

public type is_authorized_Input = (id : Principal);
public type is_authorized_Output = Bool;

public type kernel_check_authorized_Input = (());
public type kernel_check_authorized_Output = Bool;

public type kernel_authorized_recover_Input = (id : Principal);
public type kernel_authorized_recover_Output = ();

public type kernel_activation_Input = (request : ActivationService.Request);
public type kernel_activation_Output = ActivationService.Result;

public type kernel_static_Input = (cmd: StaticCmd);
public type kernel_static_Output = ();

public type kernel_static_query_Input = (cmd: StaticCmdQuery);
public type kernel_static_query_Output = [Text];

public type http_request_Input = (request : Painless.Request);
public type http_request_Output = Painless.Response;

public type http_request_streaming_callback_Input = (token : Painless.Token,);
public type http_request_streaming_callback_Output = Painless.Callback;

public type http_request_update_Input = (request : Painless.UpdateRequest);
public type http_request_update_Output = Painless.Response;

public type kernel_https_outcall_transform_Input = (args : IC.http_transform_args);
public type kernel_https_outcall_transform_Output = IC.http_request_result;

public type kernel_install_begin_checked_Input = (inp : InstallTypes.CheckedBeginInput,);
public type kernel_install_begin_checked_Output = ();

public type kernel_install_status_Input = (());
public type kernel_install_status_Output = ?InstallTypes.Status;

public type kernel_settings_snapshot_Input = (());
public type kernel_settings_snapshot_Output = SettingsTypes.Snapshot;

public type kernel_certified_assets_scope_info_Input = (scope : CapabilityTypes.AppScope,);
public type kernel_certified_assets_scope_info_Output = CertifiedAssetsTypes.ScopeInfoResult;

public type kernel_certified_assets_usage_Input = (scope : CapabilityTypes.AppScope,);
public type kernel_certified_assets_usage_Output = CertifiedAssetsTypes.UsageResult;

public type kernel_certified_assets_diagnostics_Input = ((),);
public type kernel_certified_assets_diagnostics_Output = CertifiedAssetsTypes.Diagnostics;

public type kernel_certified_assets_audit_content_ownership_page_Input = (input : {
                cursor : ?CertifiedAssetsTypes.ContentOwnershipAuditCursor;
                max_nodes : Nat;
            },);
public type kernel_certified_assets_audit_content_ownership_page_Output = CertifiedAssetsTypes.ContentOwnershipAuditPage;

public type kernel_certified_assets_audit_catalog_page_Input = (input : {
                cursor : ?CertifiedAssetsTypes.CatalogAuditCursor;
                max_nodes : Nat;
            },);
public type kernel_certified_assets_audit_catalog_page_Output = CertifiedAssetsTypes.CatalogAuditPage;

public type kernel_certified_assets_set_admission_ceilings_Input = (input : {
                scope : CapabilityTypes.AppScope;
                ceilings : CertifiedAssetsTypes.AdmissionCeilings;
            },);
public type kernel_certified_assets_set_admission_ceilings_Output = CertifiedAssetsTypes.Result;

public type kernel_certified_assets_set_writes_frozen_Input = (input : {
                scope : CapabilityTypes.AppScope;
                frozen : Bool;
            },);
public type kernel_certified_assets_set_writes_frozen_Output = CertifiedAssetsTypes.Result;

public type kernel_certified_assets_maintenance_page_Input = (scope : CapabilityTypes.AppScope,);
public type kernel_certified_assets_maintenance_page_Output = CertifiedAssetsTypes.MaintenancePageOk;

public type kernel_certified_assets_retire_scope_Input = (scope : CapabilityTypes.AppScope,);
public type kernel_certified_assets_retire_scope_Output = CertifiedAssetsTypes.Result;

public type kernel_publication_entropy_initialize_Input = ();
public type kernel_publication_entropy_initialize_Output = PublicationEntropyInitializeResult;

public type kernel_app_usage_snapshot_Input = ((),);
public type kernel_app_usage_snapshot_Output = AppUsageTypes.SnapshotV2;

public type kernel_memory_snapshot_Input = (());
public type kernel_memory_snapshot_Output = SettingsTypes.MemorySnapshot;

public type kernel_backend_reservations_snapshot_Input = ((),);
public type kernel_backend_reservations_snapshot_Output = [BackendCallTypes.ReservationSummary];

public type kernel_scheduled_tasks_snapshot_Input = (());
public type kernel_scheduled_tasks_snapshot_Output = [SchedulerTypes.Summary];

public type kernel_capabilities_page_Input = (input : CapabilityTypes.CapabilityPageInput,);
public type kernel_capabilities_page_Output = CapabilityTypes.CapabilityPage;

public type kernel_capability_set_enabled_Input = (input : CapabilityTypes.CapabilitySetEnabledInput);
public type kernel_capability_set_enabled_Output = CapabilityTypes.CapabilitySummary;

public type kernel_backend_reservations_apply_Input = (inp : BackendCallTypes.ReservationApplyInput);
public type kernel_backend_reservations_apply_Output = [BackendCallTypes.ReservationSummary];

public type kernel_install_reservations_prepare_Input = (inp : BackendCallTypes.InstallReservationsPrepareInput);
public type kernel_install_reservations_prepare_Output = ();

public type kernel_install_pending_reservation_blockers_Input = (inp : InstallTypes.DeploymentInput,);
public type kernel_install_pending_reservation_blockers_Output = [BackendCallTypes.PendingReservationBlocker];

public type kernel_install_pending_reservation_release_Input = (inp : {
                deployment_id : Text;
                reservation_id : Nat;
            },);
public type kernel_install_pending_reservation_release_Output = Bool;

public type kernel_access_snapshot_Input = (());
public type kernel_access_snapshot_Output = SettingsTypes.AccessSnapshot;

public type kernel_controller_add_Input = (id : Principal);
public type kernel_controller_add_Output = SettingsTypes.AccessSnapshot;

public type kernel_controller_rem_Input = (id : Principal);
public type kernel_controller_rem_Output = SettingsTypes.AccessSnapshot;

public type kernel_install_commit_Input = (inp : InstallTypes.DeploymentInput);
public type kernel_install_commit_Output = InstallTypes.CommitResult;

public type kernel_install_abort_Input = (inp : InstallTypes.DeploymentInput);
public type kernel_install_abort_Output = ();

public type kernel_install_wasm_chunks_clear_Input = (inp : InstallTypes.DeploymentInput);
public type kernel_install_wasm_chunks_clear_Output = ();

public type kernel_install_wasm_chunk_Input = (inp : {
                deployment_id : Text;
                chunk : Blob;
                sha256 : Blob;
            });
public type kernel_install_wasm_chunk_Output = ();

public type kernel_install_code_chunked_Input = (inp : {
                deployment_id : Text;
                chunk_hashes : [Blob];
                wasm_module_hash : Blob;
            });
public type kernel_install_code_chunked_Output = ();

public type kernel_install_code_Input = (inp: {wasm: [Nat8]; candid: Text; deployment_id : Text});
public type kernel_install_code_Output = ();

public type kernel_connections_begin_Input = (inp : ConnectionTypes.BeginConnectionInput);
public type kernel_connections_begin_Output = ConnectionTypes.BeginConnectionResult;

public type kernel_connections_complete_Input = (inp : ConnectionTypes.CompleteConnectionInput);
public type kernel_connections_complete_Output = ConnectionTypes.ConnectionSummary;

public type kernel_connections_list_Input = (inp : ConnectionTypes.ListConnectionsInput);
public type kernel_connections_list_Output = [ConnectionTypes.ConnectionSummary];

public type kernel_connections_acquire_Input = (inp : ConnectionTypes.ConnectionInput);
public type kernel_connections_acquire_Output = ConnectionTypes.SensitiveCredential;

public type kernel_connections_disconnect_Input = (inp : ConnectionTypes.ConnectionInput);
public type kernel_connections_disconnect_Output = ConnectionTypes.ConnectionSummary;

public type kernel_vetkeys_list_Input = (input : { app_id : Text },);
public type kernel_vetkeys_list_Output = [VetKeyTypes.PublicSlotSummary];

public type kernel_vetkeys_binding_Input = (input : { app_id : Text; slot_id : Text },);
public type kernel_vetkeys_binding_Output = VetKeyTypes.OperationResult<Nat>;

public type kernel_vetkeys_reserve_Input = (input : VetKeyTypes.AppSlotInput);
public type kernel_vetkeys_reserve_Output = VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary>;

public type kernel_vetkeys_enable_Input = (input : VetKeyTypes.AppSlotInput);
public type kernel_vetkeys_enable_Output = VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary>;

public type kernel_vetkeys_disable_Input = (input : VetKeyTypes.AppSlotInput);
public type kernel_vetkeys_disable_Output = VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary>;

public type kernel_vetkeys_rotate_Input = (input : VetKeyTypes.AppSlotInput);
public type kernel_vetkeys_rotate_Output = VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary>;

public type kernel_vetkeys_retire_generation_Input = (input : VetKeyTypes.AppGenerationInput);
public type kernel_vetkeys_retire_generation_Output = VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary>;

public type kernel_vetkeys_transfer_Input = (input : VetKeyTypes.TransferInput);
public type kernel_vetkeys_transfer_Output = VetKeyTypes.OperationResult<VetKeyTypes.PublicSlotSummary>;

public type kernel_vetkeys_retire_slot_Input = (input : VetKeyTypes.AppSlotInput);
public type kernel_vetkeys_retire_slot_Output = VetKeyTypes.OperationResult<()>;

public type kernel_vetkeys_public_key_Input = (input : {
                app_id : Text;
                slot_id : Text;
                generation : Nat64;
            });
public type kernel_vetkeys_public_key_Output = VetKeyTypes.PublicKeyResult;

public type kernel_vetkeys_derive_Input = (input : VetKeyTypes.DeriveInput);
public type kernel_vetkeys_derive_Output = VetKeyTypes.DeriveResult;

public type kernel_vetkeys_audit_snapshot_Input = ((),);
public type kernel_vetkeys_audit_snapshot_Output = [VetKeyTypes.AuditEntry];

public type kernel_vetkeys_admin_snapshot_Input = ((),);
public type kernel_vetkeys_admin_snapshot_Output = VetKeyTypes.AdminSnapshot;

/*---NEUTRON GENERATED END---*/
}
