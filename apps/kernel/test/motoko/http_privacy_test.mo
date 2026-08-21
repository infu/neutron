import Kernel "../../backend/main";
import Painless "../../backend/lib/Painless";
import InstallTypes "../../backend/install/Types";
import Blob "mo:core/Blob";
import Text "mo:core/Text";

func request(
    method : Text,
    url : Text,
    headers : [Painless.HeaderField],
    body : Blob,
    certificateVersion : ?Nat16,
) : Painless.Request {
    {
        method;
        url;
        headers;
        body;
        certificate_version = certificateVersion;
    };
};

assert (Kernel.supportedHttpCertificationVersion(?2));
assert (Kernel.mediaSessionOriginPrefix("abcdef0123456789abcdef0123456789") == "mabcdef0123456789abcdef01");
assert (Kernel.supportedHttpCertificationVersion(?3));
assert (not Kernel.supportedHttpCertificationVersion(?1));
assert (not Kernel.supportedHttpCertificationVersion(null));
assert (Kernel.validatedHttpAssetPath("/main.js?cache=1") == ?"/main.js");
assert (
    Kernel.validatedHttpAssetPath("/main.js?download=%2Fname%5Cpart") ==
    ?"/main.js"
);
assert (Kernel.validatedHttpAssetPath("/a/./b") == null);
assert (Kernel.validatedHttpAssetPath("/a/../b") == null);
assert (Kernel.validatedHttpAssetPath("/a%2fb") == null);
assert (Kernel.validatedHttpAssetPath("/a\\b") == null);
assert (Kernel.validatedHttpAssetPath("/a//b") == null);
assert (Kernel.validatedHttpAssetPath("/main.js#fragment") == null);
var tooManySegments = "";
var segmentIndex = 0;
while (segmentIndex < 65) {
    tooManySegments #= "/a";
    segmentIndex += 1;
};
assert (Kernel.validatedHttpAssetPath(tooManySegments) == null);
assert (Kernel.boundedStaticHttpRequest(request(
    "GET",
    "/main.js?cache=1",
    [("Host", "example.icp0.io")],
    Blob.fromArray([]),
    ?2,
)));
assert (Kernel.boundedCertifiedHttpRequest(request(
    "GET",
    "/api/items",
    [("Host", "amaila--example.icp0.io")],
    Blob.fromArray([]),
    ?2,
)));
assert (Kernel.boundedCertifiedHttpRequest(request(
    "HEAD",
    "/api/items",
    [("Host", "amaila--example.icp0.io")],
    Blob.fromArray([]),
    ?2,
)));
// Query selection is a dispatcher policy layered above the common size and
// method boundary; canonical path validation deliberately strips it.
assert (Kernel.boundedCertifiedHttpRequest(request(
    "GET",
    "/api/items?cursor=1",
    [("Host", "amaila--example.icp0.io")],
    Blob.fromArray([]),
    ?2,
)));
assert (not Kernel.boundedCertifiedHttpRequest(request(
    "HEAD",
    "/api/items",
    [("Host", "amaila--example.icp0.io")],
    Blob.fromArray([1]),
    ?2,
)));
assert (not Kernel.boundedStaticHttpRequest(request(
    "POST",
    "/main.js",
    [],
    Blob.fromArray([]),
    ?2,
)));
assert (not Kernel.boundedStaticHttpRequest(request(
    "GET",
    "/main.js",
    [],
    Blob.fromArray([1]),
    ?2,
)));

// The system namespace is internal by default. Its committed public metadata,
// package metadata, and compiler sources are public again.
assert (Kernel.isInternalHttpStatePath("/system/private"));
assert (Kernel.isInternalHttpStatePath("/system/private/state"));
assert (Kernel.isInternalHttpStatePath("/system/staging"));
assert (Kernel.isInternalHttpStatePath("/system/staging/deployment/assets/0"));
assert (Kernel.isInternalHttpStatePath("/system/other.json"));

assert (not Kernel.isInternalHttpStatePath("/system/apps.json"));
assert (not Kernel.isInternalHttpStatePath("/system/runtime-config.json"));
assert (not Kernel.isInternalHttpStatePath("/system/install-provenance.json"));
assert (not Kernel.isInternalHttpStatePath("/system/deployment-build-record.json"));
assert (not Kernel.isInternalHttpStatePath("/mo/hash.mo"));
assert (not Kernel.isInternalHttpStatePath("/pkg/neutron.did"));
assert (not Kernel.isInternalHttpStatePath("/app/hello/pkg/neutron.json"));
assert (not Kernel.isInternalHttpStatePath("/main.js"));

// The checked install transaction is the only writer for the authoritative
// deployment record. Package staging remains available under /system/staging,
// while direct writes/deletes and ancestor clears are rejected by kernel_static.
assert (Kernel.isDeploymentBuildRecordStaticTarget(
    "/system/deployment-build-record.json"
));
assert (not Kernel.isDeploymentBuildRecordStaticTarget(
    "/system/deployment-build-record.json/retained"
));
assert (not Kernel.isDeploymentBuildRecordStaticTarget(
    "/system/staging/deployment/deployment-build-record.json"
));
assert (Kernel.staticClearTouchesDeploymentBuildRecord(""));
assert (Kernel.staticClearTouchesDeploymentBuildRecord("/system/"));
assert (Kernel.staticClearTouchesDeploymentBuildRecord(
    "/system/deployment-build-record.json"
));
assert (not Kernel.staticClearTouchesDeploymentBuildRecord(
    "/system/deployment-build-record.json/retained"
));
assert (not Kernel.staticClearTouchesDeploymentBuildRecord("/app/"));

assert (Kernel.isPackageHttpAssetPath("/system/apps.json"));
assert (Kernel.isPackageHttpAssetPath("/system/runtime-config.json"));
assert (Kernel.isPackageHttpAssetPath("/system/install-provenance.json"));
assert (Kernel.isPackageHttpAssetPath("/system/deployment-build-record.json"));
assert (Kernel.isPackageHttpAssetPath("/mo/hash.mo"));
assert (Kernel.isPackageHttpAssetPath("/pkg/neutron.did"));
assert (Kernel.isPackageHttpAssetPath("/app/hello/pkg/neutron.json"));
assert (not Kernel.isPackageHttpAssetPath("/system/staging/deployment/assets/0"));
assert (not Kernel.isPackageHttpAssetPath("/system/private/state"));
assert (not Kernel.isPackageHttpAssetPath("/app/hello/index.html"));

// Only Motoko modules whose complete SHA-256 is verified against their path
// may be cached indefinitely. Build-tool filename hashes are not a Kernel
// integrity contract, so JavaScript, CSS, entrypoints, registries, manifests,
// and application assets must all be revalidated.
assert (Kernel.isImmutableHttpAssetPath(
    "/mo/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.mo"
));
assert (not Kernel.isImmutableHttpAssetPath("/chunks/chunk-4FRBFXSV.js"));
assert (not Kernel.isImmutableHttpAssetPath(
    "/chunks/playwright_auth-XFZDPRS5.js"
));
assert (not Kernel.isImmutableHttpAssetPath("/chunks/main-QWWVKTAN.css"));
assert (not Kernel.isImmutableHttpAssetPath("/mo"));
assert (not Kernel.isImmutableHttpAssetPath("/mo/hash.mo"));
assert (not Kernel.isImmutableHttpAssetPath("/motoko/moc.wasm.js"));
assert (not Kernel.isImmutableHttpAssetPath("/pkg/neutron.did"));
assert (not Kernel.isImmutableHttpAssetPath("/system/apps.json"));
assert (not Kernel.isImmutableHttpAssetPath("/system/runtime-config.json"));
assert (not Kernel.isImmutableHttpAssetPath("/app/hello/pkg/neutron.json"));
assert (not Kernel.isImmutableHttpAssetPath("/index.html"));
assert (not Kernel.isImmutableHttpAssetPath("/main.js"));
assert (not Kernel.isImmutableHttpAssetPath("/main.css"));
assert (not Kernel.isImmutableHttpAssetPath("/main-FOHRSME2.js"));
assert (not Kernel.isImmutableHttpAssetPath(
    "/app/hello/chunks/chunk-4FRBFXSV.js"
));
assert (not Kernel.isImmutableHttpAssetPath(
    "/system/chunks/chunk-4FRBFXSV.js"
));
assert (not Kernel.isImmutableHttpAssetPath(
    "/pkg/chunks/chunk-4FRBFXSV.js"
));
assert (not Kernel.isImmutableHttpAssetPath(
    "/chunks/nested/chunk-4FRBFXSV.js"
));
assert (not Kernel.isImmutableHttpAssetPath("/chunks/chunk-4FRBFXS.js"));
assert (not Kernel.isImmutableHttpAssetPath("/chunks/chunk-4FRBFXS0.js"));
assert (not Kernel.isImmutableHttpAssetPath("/chunks/chunk-4frbfxsv.js"));
assert (not Kernel.isImmutableHttpAssetPath("/chunks/-4FRBFXSV.js"));
assert (not Kernel.isImmutableHttpAssetPath(
    "/chunks/chunk-4FRBFXSV.js.map"
));
assert (not Kernel.isImmutableHttpAssetPath("/chunks/chunk-4FRBFXSV.wasm"));

let zeroHash = Blob.fromArray([
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
]);
let zeroHashPath =
    "/mo/0000000000000000000000000000000000000000000000000000000000000000.mo";
assert (Kernel.isImmutableHttpAssetResponse(
    zeroHashPath,
    "identity",
    zeroHash,
));
assert (not Kernel.isImmutableHttpAssetResponse(
    zeroHashPath,
    "gzip",
    zeroHash,
));
assert (not Kernel.isImmutableHttpAssetResponse(
    zeroHashPath,
    "identity",
    Blob.fromArray([1]),
));
assert (not Kernel.isImmutableHttpAssetResponse(
    "/chunks/chunk-4FRBFXSV.js",
    "gzip",
    zeroHash,
));
assert (not Kernel.isImmutableHttpAssetResponse(
    "/chunks/main-QWWVKTAN.css",
    "identity",
    zeroHash,
));
assert (not Kernel.isImmutableHttpAssetResponse(
    "/chunks/chunk-4FRBFXSV.js",
    "br",
    zeroHash,
));
assert (Kernel.httpAssetCacheControl(
    "/chunks/chunk-4FRBFXSV.js",
    "gzip",
    zeroHash,
) == "no-cache");
assert (Kernel.httpAssetCacheControl(
    zeroHashPath,
    "identity",
    zeroHash,
) == "public, max-age=31536000, immutable");
assert (Kernel.httpAssetCacheControl(
    "/main.js",
    "gzip",
    zeroHash,
) == "no-cache");
assert (Kernel.httpAssetCacheControl(
    "/main.css",
    "gzip",
    zeroHash,
) == "no-cache");
assert (Kernel.httpAssetCacheControl(
    "/index.html",
    "gzip",
    zeroHash,
) == "no-cache");
assert (Kernel.httpAssetCacheControl(
    "/system/apps.json",
    "identity",
    zeroHash,
) == "no-cache");
assert (Kernel.httpAssetCacheControl(
    "/pkg/neutron.did",
    "gzip",
    zeroHash,
) == "no-cache");
assert (Kernel.httpAssetCacheControl(
    "/app/hello/main.js",
    "gzip",
    zeroHash,
) == "no-cache");

assert (Kernel.isSharedAppRoutePath("/app/hello/_route/data"));
assert (Kernel.isSharedAppRoutePath("/app/hello/_route/data/item.json"));
assert (Kernel.isSharedAppRoutePath("/app/hello_world/_route/hook_1/inbound"));
assert (not Kernel.isSharedAppRoutePath("/app/hello/_route"));
assert (not Kernel.isSharedAppRoutePath("/app/hello/routes/data"));
assert (not Kernel.isSharedAppRoutePath("/app/x/_route/data"));
assert (not Kernel.isSharedAppRoutePath("/app/hello/_route/Data"));

let canisterId = "4caro-hl777-77775-aaaba-cai";
let nonce = "0123456789abcdef0123456789abcdef";
let persistentHost = ?(
    "p0123456789abcdef01234567--" # canisterId
);
let legacyHost = ?("agemmaa--" # canisterId);

assert (
    Kernel.requestHostAuthority([
        ("hOsT", "p0123456789abcdef01234567--" # canisterId # ".localhost:8000")
    ]) == #present({
        authority = "p0123456789abcdef01234567--" # canisterId #
            ".localhost:8000";
        hostname = "p0123456789abcdef01234567--" # canisterId #
            ".localhost";
        host_label = "p0123456789abcdef01234567--" # canisterId;
        port = ?"8000";
        raw_gateway = false;
    })
);
assert (
    Kernel.requestHostAuthority([
        ("X-Forwarded-Host", "p0123456789abcdef01234567--" # canisterId)
    ]) == #missing
);
assert (
    Kernel.requestHostAuthority([
        ("Host", canisterId # ".localhost:8000"),
        ("X-Forwarded-Host", "p0123456789abcdef01234567--" # canisterId),
    ]) == #present({
        authority = canisterId # ".localhost:8000";
        hostname = canisterId # ".localhost";
        host_label = canisterId;
        port = ?"8000";
        raw_gateway = false;
    })
);
assert (
    Kernel.requestHostAuthority([
        ("Host", "agemmaa--" # canisterId # ".raw.icp0.io")
    ]) == #present({
        authority = "agemmaa--" # canisterId # ".raw.icp0.io";
        hostname = "agemmaa--" # canisterId # ".raw.icp0.io";
        host_label = "agemmaa--" # canisterId;
        port = null;
        raw_gateway = true;
    })
);
assert (
    Kernel.requestHostAuthority([
        ("Host", "Agemmaa--" # canisterId # ".ICP0.IO")
    ]) == #invalid
);
assert (
    Kernel.requestHostAuthority([
        ("Host", canisterId # ".localhost:8000"),
        ("HOST", canisterId # ".localhost:8000"),
    ]) == #invalid
);
assert (
    Kernel.requestHostAuthority([
        ("Host", canisterId # ".localhost:8000"),
        ("host", "p0123456789abcdef01234567--" # canisterId),
    ]) == #invalid
);
assert (
    Kernel.requestHostAuthority([
        ("Host", canisterId # ",p0123456789abcdef01234567--" # canisterId)
    ]) == #invalid
);

assert (
    Kernel.appAssetOriginPolicy(
        persistentHost,
        canisterId,
        "gemma",
        nonce,
        true,
    ) == #persistent_app
);
// A forwarded-host spoof cannot turn an unprefixed response into the one
// unsandboxed persistent origin.
assert (
    Kernel.appAssetOriginPolicyForHeaders(
        [("X-Forwarded-Host", "p0123456789abcdef01234567--" # canisterId)],
        canisterId,
        "gemma",
        nonce,
        true,
    ) == #opaque_app
);
assert (
    Kernel.appAssetOriginPolicyForHeaders(
        [
            ("Host", "p0123456789abcdef01234567--" # canisterId),
            ("host", "p0123456789abcdef01234567--" # canisterId),
        ],
        canisterId,
        "gemma",
        nonce,
        true,
    ) == #deny
);
assert (
    Kernel.appAssetOriginPolicyForHeaders(
        [("Host", "agemmaa--" # canisterId # ".raw.icp0.io")],
        canisterId,
        "gemma",
        nonce,
        false,
    ) == #deny
);
assert (
    Kernel.appAssetOriginPolicyForHeaders(
        [("Host", "agemmaa--" # canisterId # ".example.com")],
        canisterId,
        "gemma",
        nonce,
        false,
    ) == #deny
);
// A persistent app cannot navigate back to its old app-id hostname.
assert (
    Kernel.appAssetOriginPolicy(
        legacyHost,
        canisterId,
        "gemma",
        nonce,
        true,
    ) == #deny
);
// Nor can it reuse a nonce hostname from an earlier installation.
assert (
    Kernel.appAssetOriginPolicy(
        ?("pffffffffffffffffffffffff--" # canisterId),
        canisterId,
        "gemma",
        nonce,
        true,
    ) == #deny
);

// Unprefixed and same-host proxy responses remain available to ordinary
// tile/tray/background frames, but the response itself forces an opaque
// document even if a persistent iframe self-navigates to it.
let rawCanisterPolicy = Kernel.appAssetOriginPolicy(
    ?canisterId,
    canisterId,
    "gemma",
    nonce,
    true,
);
assert (rawCanisterPolicy == #opaque_app);
assert (
    Kernel.appAssetSandboxHeaders(rawCanisterPolicy) == [
        ("Content-Security-Policy", "sandbox allow-scripts")
    ]
);
assert (
    Kernel.appAssetSandboxHeaders(#persistent_app).size() == 0
);

let residentInstance : InstallTypes.AppInstance = {
    scope = { app_id = "gemma"; installation_uid = 17 };
    version = 100;
    deployment_id = "deployment_0123";
    capability_plan_fingerprint =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    resident_frame_security = #credentialless_ephemeral_dedicated_v1;
    browser_origin_nonce = nonce;
    browser_origin_authority_epoch = 3;
};
let residentPath = "/app/gemma/service.html";
let residentQuery =
    "app=gemma&role=background" #
    "&installation-uid=17" #
    "&resident-frame-security=credentialless_ephemeral_dedicated_v1" #
    "&browser-origin-nonce=" # nonce #
    "&browser-origin-authority-epoch=3";
let residentUrl = residentPath # "?" # residentQuery;
assert (Kernel.dedicatedResidentHtmlRequestBound(
    residentUrl,
    residentPath,
    [("Sec-Fetch-Dest", "iframe")],
    residentInstance,
));
assert (Kernel.dedicatedResidentAssetRequestBound(
    residentUrl,
    residentPath,
    [("Sec-Fetch-Dest", "iframe")],
    "text/html; charset=utf-8",
    residentInstance,
));
assert (not Kernel.dedicatedResidentAssetRequestBound(
    residentUrl,
    residentPath,
    [("Sec-Fetch-Dest", "document")],
    "text/html",
    residentInstance,
));
assert (not Kernel.dedicatedResidentAssetRequestBound(
    "/app/gemma/icon.svg",
    "/app/gemma/icon.svg",
    [("Sec-Fetch-Dest", "iframe")],
    "image/svg+xml",
    residentInstance,
));
assert (not Kernel.dedicatedResidentAssetRequestBound(
    "/app/gemma/data.xml",
    "/app/gemma/data.xml",
    [("Sec-Fetch-Dest", "object")],
    "application/xml",
    residentInstance,
));
assert (not Kernel.dedicatedResidentAssetRequestBound(
    "/app/gemma/manual.pdf",
    "/app/gemma/manual.pdf",
    [],
    "application/pdf",
    residentInstance,
));
assert (Kernel.dedicatedResidentAssetRequestBound(
    "/app/gemma/service.js",
    "/app/gemma/service.js",
    [("Sec-Fetch-Dest", "worker")],
    "text/javascript",
    residentInstance,
));
assert (not Kernel.dedicatedResidentAssetRequestBound(
    "/app/gemma/service.js",
    "/app/gemma/service.js",
    [],
    "text/javascript",
    residentInstance,
));
assert (Kernel.dedicatedResidentAssetRequestBound(
    "/app/gemma/icon.svg",
    "/app/gemma/icon.svg",
    [("Sec-Fetch-Dest", "image")],
    "image/svg+xml",
    residentInstance,
));
assert (not Kernel.dedicatedResidentAssetRequestBound(
    "/app/gemma/service-worker.js",
    "/app/gemma/service-worker.js",
    [("Sec-Fetch-Dest", "serviceworker")],
    "text/javascript",
    residentInstance,
));
assert (not Kernel.dedicatedResidentAssetRequestBound(
    "/app/gemma/service.js",
    "/app/gemma/service.js",
    [
        ("Sec-Fetch-Dest", "worker"),
        ("sec-fetch-dest", "worker"),
    ],
    "text/javascript",
    residentInstance,
));
func assertResidentUrlRejected(url : Text) : () {
    assert (not Kernel.dedicatedResidentHtmlRequestBound(
        url,
        residentPath,
        [("Sec-Fetch-Dest", "iframe")],
        residentInstance,
    ));
};
assertResidentUrlRejected(Text.replace(
    residentUrl,
    #text "app=gemma",
    "app=other",
));
assertResidentUrlRejected(Text.replace(
    residentUrl,
    #text "role=background",
    "role=tile",
));
assertResidentUrlRejected(Text.replace(
    residentUrl,
    #text "installation-uid=17",
    "installation-uid=18",
));
// Unrelated actor deployments and package-plan fingerprints do not rotate a
// persistent app installation's browser authority or invalidate its document.
assert (Kernel.dedicatedResidentHtmlRequestBound(
    residentUrl,
    residentPath,
    [("Sec-Fetch-Dest", "iframe")],
    {
        residentInstance with
        deployment_id = "deployment_9999";
        capability_plan_fingerprint =
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    },
));
assertResidentUrlRejected(Text.replace(
    residentUrl,
    #text
        "resident-frame-security=credentialless_ephemeral_dedicated_v1",
    "resident-frame-security=persistent_dedicated_v1",
));
assertResidentUrlRejected(Text.replace(
    residentUrl,
    #text ("browser-origin-nonce=" # nonce),
    "browser-origin-nonce=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
));
assert (not Kernel.dedicatedResidentHtmlRequestBound(
    residentUrl,
    residentPath,
    [],
    residentInstance,
));
assert (not Kernel.dedicatedResidentHtmlRequestBound(
    residentUrl,
    residentPath,
    [("Sec-Fetch-Dest", "document")],
    residentInstance,
));
assert (not Kernel.dedicatedResidentHtmlRequestBound(
    residentUrl,
    residentPath,
    [
        ("Sec-Fetch-Dest", "iframe"),
        ("sec-fetch-dest", "iframe"),
    ],
    residentInstance,
));
assert (not Kernel.dedicatedResidentHtmlRequestBound(
    residentPath # "?" # residentQuery # "&app=gemma",
    residentPath,
    [("Sec-Fetch-Dest", "iframe")],
    residentInstance,
));
assert (not Kernel.dedicatedResidentHtmlRequestBound(
    residentPath # "?" # residentQuery # "&unexpected=value",
    residentPath,
    [("Sec-Fetch-Dest", "iframe")],
    residentInstance,
));
assert (not Kernel.dedicatedResidentHtmlRequestBound(
    residentPath # "?" #
    "role=background&app=gemma" #
    "&installation-uid=17" #
    "&resident-frame-security=credentialless_ephemeral_dedicated_v1" #
    "&browser-origin-nonce=" # nonce #
    "&browser-origin-authority-epoch=3",
    residentPath,
    [("Sec-Fetch-Dest", "iframe")],
    residentInstance,
));
assert (not Kernel.dedicatedResidentHtmlRequestBound(
    Text.replace(
        residentUrl,
        #text "browser-origin-authority-epoch=3",
        "browser-origin-authority-epoch=4",
    ),
    residentPath,
    [("Sec-Fetch-Dest", "iframe")],
    residentInstance,
));
assert (not Kernel.dedicatedResidentHtmlRequestBound(
    residentUrl,
    residentPath,
    [("Sec-Fetch-Dest", "iframe")],
    {
        residentInstance with
        resident_frame_security = #credentialless_opaque_v1;
    },
));
let persistentResidentInstance = {
    residentInstance with
    resident_frame_security = #persistent_dedicated_v1;
};
let persistentResidentUrl = Text.replace(
    residentUrl,
    #text
        "resident-frame-security=credentialless_ephemeral_dedicated_v1",
    "resident-frame-security=persistent_dedicated_v1",
);
assert (Kernel.dedicatedResidentHtmlRequestBound(
    persistentResidentUrl,
    residentPath,
    [("sec-fetch-dest", "iframe")],
    persistentResidentInstance,
));
assert (not Kernel.dedicatedResidentHtmlRequestBound(
    persistentResidentUrl,
    "/app/gemma/other.html",
    [("Sec-Fetch-Dest", "iframe")],
    persistentResidentInstance,
));

// Non-persistent surfaces retain their ordinary app host, but cannot opt in
// to a nonce host and are always response-sandboxed.
let ordinaryPolicy = Kernel.appAssetOriginPolicy(
    legacyHost,
    canisterId,
    "gemma",
    nonce,
    false,
);
assert (ordinaryPolicy == #opaque_app);
assert (Kernel.appAssetSandboxHeaders(ordinaryPolicy).size() == 1);
assert (
    Kernel.appAssetOriginPolicy(
        persistentHost,
        canisterId,
        "gemma",
        nonce,
        false,
    ) == #deny
);
