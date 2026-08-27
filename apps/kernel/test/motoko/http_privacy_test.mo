import Kernel "../../backend/main";
import Cert "../../backend/certified_http";
import Painless "../../backend/lib/Painless";
import InstallTypes "../../backend/install/Types";
import Blob "mo:core/Blob";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";

assert (Kernel.MAX_BROWSER_SURFACE_CERTIFICATION_UNITS == 1_024);

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
assert (not Kernel.isInternalHttpStatePath(
    "/system/browser-surface-origins.json"
));
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

// The public registries may be seeded once during fresh provisioning, after
// which exact retry bytes are the only direct static write accepted. Deletion
// and ancestor clears are always reserved for the checked install transaction.
assert (Kernel.isAppRegistryStaticTarget("/system/apps.json"));
assert (not Kernel.isAppRegistryStaticTarget("/system/apps.json/retained"));
assert (Kernel.staticClearTouchesAppRegistry(""));
assert (Kernel.staticClearTouchesAppRegistry("/system/"));
assert (Kernel.staticClearTouchesAppRegistry("/system/apps.json"));
assert (not Kernel.staticClearTouchesAppRegistry(
    "/system/apps.json/retained"
));
assert (not Kernel.staticClearTouchesAppRegistry("/app/"));

assert (Kernel.isBrowserSurfaceOriginsStaticTarget(
    "/system/browser-surface-origins.json"
));
assert (not Kernel.isBrowserSurfaceOriginsStaticTarget(
    "/system/browser-surface-origins.json/retained"
));
assert (Kernel.staticClearTouchesBrowserSurfaceOrigins(""));
assert (Kernel.staticClearTouchesBrowserSurfaceOrigins("/system/"));
assert (Kernel.staticClearTouchesBrowserSurfaceOrigins(
    "/system/browser-surface-origins.json"
));
assert (not Kernel.staticClearTouchesBrowserSurfaceOrigins(
    "/system/browser-surface-origins.json/retained"
));
assert (not Kernel.staticClearTouchesBrowserSurfaceOrigins("/app/"));

assert (Kernel.isPackageHttpAssetPath("/system/apps.json"));
assert (Kernel.isPackageHttpAssetPath(
    "/system/browser-surface-origins.json"
));
assert (Kernel.isPackageHttpAssetPath("/system/runtime-config.json"));
assert (not Kernel.hasOriginScopedStaticCertification(
    "/system/runtime-config.json"
));
assert (Kernel.hasOriginScopedStaticCertification("/app/hello/main.js"));
assert (not Kernel.hasOriginScopedStaticCertification("/pkg/neutron.did"));
assert (Kernel.isPackageHttpAssetPath("/system/install-provenance.json"));
assert (Kernel.isPackageHttpAssetPath("/system/deployment-build-record.json"));
assert (Kernel.isPackageHttpAssetPath("/mo/hash.mo"));
assert (Kernel.isPackageHttpAssetPath("/pkg/neutron.did"));
assert (Kernel.isPackageHttpAssetPath("/app/hello/pkg/neutron.json"));
assert (Kernel.isAppPackageHttpAssetPath("/app/hello/pkg/neutron.json"));
assert (Kernel.isAppPackageHttpAssetPath("/app/hello/pkg"));
assert (not Kernel.isAppPackageHttpAssetPath("/pkg/neutron.did"));
assert (not Kernel.isAppPackageHttpAssetPath("/app/hello/pkg-copy/code.js"));
assert (
    Kernel.httpAssetResponseContentType(
        "/app/hello/pkg/worker.js",
        "text/javascript",
        true,
    ) == "application/octet-stream"
);
assert (
    Kernel.httpAssetResponseContentType(
        "/app/hello/pkg",
        "text/javascript",
        true,
    ) == "application/octet-stream"
);
assert (
    Kernel.httpAssetResponseContentType(
        "/app/hello/pkg/index.html",
        "text/html; charset=utf-8",
        true,
    ) == "application/octet-stream"
);
// A retained pre-v26 app keeps the authored response hash and remains readable
// until its complete app package is selected for adoption.
assert (
    Kernel.httpAssetResponseContentType(
        "/app/hello/pkg/neutron.json",
        "application/json",
        false,
    ) == "application/json"
);
assert (
    Kernel.httpAssetResponseContentType(
        "/pkg/compiler.js",
        "text/javascript",
        true,
    ) == "text/javascript"
);
assert (
    Kernel.httpAssetResponseContentType(
        "/app/hello/main.js",
        "text/javascript",
        true,
    ) == "text/javascript"
);

assert (not Kernel.isPackageHttpAssetPath("/system/staging/deployment/assets/0"));
assert (not Kernel.isPackageHttpAssetPath("/system/private/state"));
assert (not Kernel.isPackageHttpAssetPath("/app/hello/index.html"));
assert (Kernel.installationRuntimeConfigRequestAllowed(
    "/system/runtime-config.json",
    "/system/runtime-config.json",
    ?"empty",
));
assert (not Kernel.installationRuntimeConfigRequestAllowed(
    "/system/runtime-config.json?x=1",
    "/system/runtime-config.json",
    ?"empty",
));
assert (not Kernel.installationRuntimeConfigRequestAllowed(
    "/system/apps.json",
    "/system/apps.json",
    ?"empty",
));
assert (not Kernel.installationRuntimeConfigRequestAllowed(
    "/system/runtime-config.json",
    "/system/runtime-config.json",
    ?"script",
));
assert (not Kernel.installationRuntimeConfigRequestAllowed(
    "/system/runtime-config.json",
    "/system/runtime-config.json",
    null,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "aaaaa-aa.localhost:8000")],
    false,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json?alias=1",
    "/app/hello/pkg/neutron.json",
    [("Host", "aaaaa-aa.localhost:8000")],
    false,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json?alias=1",
    "/app/hello/pkg/neutron.json",
    [("Host", "aaaaa-aa.localhost:4943")],
    false,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "aaaaa-aa.custom.example")],
    false,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "packages.example.test:8443")],
    false,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "127.0.0.1:4943")],
    false,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [],
    false,
));
assert (not Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "i0123456789abcdef01234567--aaaaa-aa.localhost:8000")],
    true,
));
assert (Kernel.portablePackageRequestAllowed(
    "/system/runtime-config.json",
    "/system/runtime-config.json",
    [
        ("Host", "i0123456789abcdef01234567--aaaaa-aa.localhost:8000"),
        ("Sec-Fetch-Dest", "empty"),
    ],
    true,
));
assert (not Kernel.portablePackageRequestAllowed(
    "/system/runtime-config.json",
    "/system/runtime-config.json",
    [
        ("Host", "i0123456789abcdef01234567--aaaaa-aa.localhost:8000"),
        ("Sec-Fetch-Dest", "empty"),
    ],
    false,
));
assert (not Kernel.portablePackageRequestAllowed(
    "/system/runtime-config.json?alias=1",
    "/system/runtime-config.json",
    [
        ("Host", "i0123456789abcdef01234567--aaaaa-aa.localhost:8000"),
        ("Sec-Fetch-Dest", "empty"),
    ],
    true,
));
assert (not Kernel.portablePackageRequestAllowed(
    "/system/runtime-config.json",
    "/system/runtime-config.json",
    [
        ("Host", "i0123456789abcdef01234567--aaaaa-aa.localhost:8000"),
        ("Sec-Fetch-Dest", "script"),
    ],
    true,
));
assert (not Kernel.portablePackageRequestAllowed(
    "/system/runtime-config.json",
    "/system/runtime-config.json",
    [
        ("Host", "i0123456789abcdef01234567--aaaaa-aa.localhost:8000"),
        ("Sec-Fetch-Dest", "empty"),
        ("sec-fetch-dest", "empty"),
    ],
    true,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "p0123456789abcdef01234567--aaaaa-aa.localhost:8000")],
    false,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "ahelloa--aaaaa-aa.localhost:8000")],
    false,
));
assert (not Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/other.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "aaaaa-aa.localhost:8000")],
    false,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "bbbbb-bb.custom.example")],
    false,
));
assert (not Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [
        ("Host", "aaaaa-aa.localhost:8000"),
        ("Host", "aaaaa-aa.localhost:8000"),
    ],
    false,
));
assert (Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "p0123456789abcdef01234567--stale.example:1234")],
    false,
));
assert (not Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "iffffffffffffffffffffffff--stale.example:1234")],
    false,
));
assert (not Kernel.portablePackageRequestAllowed(
    "/app/hello/pkg/neutron.json",
    "/app/hello/pkg/neutron.json",
    [("Host", "packages.example.test:065")],
    false,
));

let installationSurface =
    "i0123456789abcdef01234567--aaaaa-aa";
let ?productionInstallationCsp = Kernel.installationDocumentCspForAuthority(
    installationSurface,
    "hello",
    "aaaaa-aa",
    installationSurface # ".icp0.io",
) else Runtime.trap("missing production installation CSP");
let ?localInstallationCsp = Kernel.installationDocumentCspForAuthority(
    installationSurface,
    "hello",
    "aaaaa-aa",
    installationSurface # ".localhost:8000",
) else Runtime.trap("missing local installation CSP");
assert (productionInstallationCsp != localInstallationCsp);
assert (
    productionInstallationCsp ==
    "sandbox allow-scripts allow-same-origin; script-src " #
    "'unsafe-inline' 'unsafe-eval' blob: https://" #
    installationSurface # ".icp0.io/app/hello/; object-src 'none'; " #
    "worker-src blob: https://" # installationSurface #
    ".icp0.io/app/hello/; frame-ancestors https://aaaaa-aa.icp0.io"
);
assert (
    localInstallationCsp ==
    "sandbox allow-scripts allow-same-origin; script-src " #
    "'unsafe-inline' 'unsafe-eval' blob: http://" #
    installationSurface #
    ".localhost:8000/app/hello/; object-src 'none'; " #
    "worker-src blob: http://" # installationSurface #
    ".localhost:8000/app/hello/; " #
    "frame-ancestors http://aaaaa-aa.localhost:8000"
);
assert (not Text.contains(productionInstallationCsp, #text "'self'"));
assert (not Text.contains(localInstallationCsp, #text "'self'"));
assert (Text.contains(
    productionInstallationCsp,
    #text (
        "worker-src blob: https://" # installationSurface #
        ".icp0.io/app/hello/"
    ),
));
assert (Text.contains(
    productionInstallationCsp,
    #text "frame-ancestors https://aaaaa-aa.icp0.io",
));
assert (not Text.contains(productionInstallationCsp, #text "localhost"));
assert (Text.contains(
    localInstallationCsp,
    #text (
        "worker-src blob: http://" # installationSurface #
        ".localhost:8000/app/hello/"
    ),
));
assert (Text.contains(
    localInstallationCsp,
    #text "frame-ancestors http://aaaaa-aa.localhost:8000",
));
assert (not Text.contains(localInstallationCsp, #text "icp0.io"));
assert (Kernel.installationDocumentCspForAuthority(
    installationSurface,
    "hello",
    "aaaaa-aa",
    installationSurface # ".raw.icp0.io",
) == null);
assert (Kernel.installationDocumentCspForAuthority(
    installationSurface,
    "hello",
    "aaaaa-aa",
    "other--aaaaa-aa.icp0.io",
) == null);
assert (Kernel.installationDocumentCspForAuthority(
    installationSurface,
    "../hello",
    "aaaaa-aa",
    installationSurface # ".icp0.io",
) == null);

let residentSurface = "p0123456789abcdef01234567--aaaaa-aa";
let ?productionResidentCsp = Kernel.residentDocumentCspForAuthority(
    residentSurface,
    "aaaaa-aa",
    residentSurface # ".icp0.io",
) else Runtime.trap("missing production resident CSP");
let ?localResidentCsp = Kernel.residentDocumentCspForAuthority(
    residentSurface,
    "aaaaa-aa",
    residentSurface # ".localhost:8000",
) else Runtime.trap("missing local resident CSP");
assert (productionResidentCsp != localResidentCsp);
assert (Text.startsWith(
    productionResidentCsp,
    #text "sandbox allow-scripts allow-same-origin; frame-ancestors ",
));
assert (Text.contains(
    productionResidentCsp,
    #text "frame-ancestors https://aaaaa-aa.icp0.io",
));
assert (not Text.contains(productionResidentCsp, #text "localhost"));
assert (Text.contains(
    localResidentCsp,
    #text "frame-ancestors http://aaaaa-aa.localhost:8000",
));
assert (not Text.contains(localResidentCsp, #text "icp0.io"));
assert (not Text.contains(localResidentCsp, #text "worker-src"));
assert (Kernel.residentDocumentCspForAuthority(
    residentSurface,
    "aaaaa-aa",
    residentSurface # ".raw.icp0.io",
) == null);

func documentHeaders(
    csp : Text,
    expression : Text,
) : [Cert.HeaderField] {
    [
        ("Content-Type", "text/html; charset=utf-8"),
        ("Content-Security-Policy", csp),
        (Cert.CERTIFICATE_EXPRESSION_HEADER, expression),
    ];
};
let documentBodyHash = Cert.hashChunks(["environment-bound document"]);
func documentVariant(
    host : Text,
    kind : Cert.ResidentRequestKind,
    headers : [Cert.HeaderField],
) : Cert.ResidentResponseVariant {
    {
        method = "GET";
        host;
        kind;
        status_code = 200;
        body_hash = documentBodyHash;
        response_headers = headers;
    };
};
let installationKind : Cert.ResidentRequestKind = #installation_html_v1;
let residentKind : Cert.ResidentRequestKind = #html_v1({
    canonical_query =
        "app=hello&role=background&installation-uid=1" #
        "&resident-frame-security=persistent_dedicated_v1" #
        "&browser-origin-nonce=0123456789abcdef0123456789abcdef" #
        "&browser-origin-authority-epoch=1";
});
let productionInstallationHeaders = documentHeaders(
    productionInstallationCsp,
    Cert.RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION,
);
let localInstallationHeaders = documentHeaders(
    localInstallationCsp,
    Cert.RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION,
);
let productionResidentHeaders = documentHeaders(
    productionResidentCsp,
    Cert.RESIDENT_HTML_CERTIFICATION_EXPRESSION,
);
let localResidentHeaders = documentHeaders(
    localResidentCsp,
    Cert.RESIDENT_HTML_CERTIFICATION_EXPRESSION,
);
assert (productionInstallationHeaders != localInstallationHeaders);
assert (productionResidentHeaders != localResidentHeaders);
let productionInstallationVariant = documentVariant(
    installationSurface # ".icp0.io",
    installationKind,
    productionInstallationHeaders,
);
let localInstallationVariant = documentVariant(
    installationSurface # ".localhost:8000",
    installationKind,
    localInstallationHeaders,
);
let productionResidentVariant = documentVariant(
    residentSurface # ".icp0.io",
    residentKind,
    productionResidentHeaders,
);
let localResidentVariant = documentVariant(
    residentSurface # ".localhost:8000",
    residentKind,
    localResidentHeaders,
);
let environmentTree = Cert.PublicCertificationTree(Cert.init());
environmentTree.apply([
    #replace_origin_scoped({
        url = "/app/hello/environment.html";
        next = [productionInstallationVariant, localInstallationVariant];
    }),
    #replace_origin_scoped({
        url = "/app/hello/resident.html";
        next = [productionResidentVariant, localResidentVariant];
    }),
]);
assert (environmentTree.hasResident(
    "/app/hello/environment.html",
    productionInstallationVariant,
));
assert (environmentTree.hasResident(
    "/app/hello/environment.html",
    localInstallationVariant,
));
assert (not environmentTree.hasResident(
    "/app/hello/environment.html",
    documentVariant(
        installationSurface # ".icp0.io",
        installationKind,
        localInstallationHeaders,
    ),
));
assert (not environmentTree.hasResident(
    "/app/hello/environment.html",
    documentVariant(
        installationSurface # ".localhost:8000",
        installationKind,
        productionInstallationHeaders,
    ),
));
assert (environmentTree.hasResident(
    "/app/hello/resident.html",
    productionResidentVariant,
));
assert (environmentTree.hasResident(
    "/app/hello/resident.html",
    localResidentVariant,
));
assert (not environmentTree.hasResident(
    "/app/hello/resident.html",
    documentVariant(
        residentSurface # ".icp0.io",
        residentKind,
        localResidentHeaders,
    ),
));
assert (not environmentTree.hasResident(
    "/app/hello/resident.html",
    documentVariant(
        residentSurface # ".localhost:8000",
        residentKind,
        productionResidentHeaders,
    ),
));

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
assert (not Kernel.isImmutableHttpAssetPath(
    "/system/browser-surface-origins.json"
));
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

let installationLabel =
    "i0123456789abcdef01234567--" # canisterId;
assert (Kernel.isInstallationAppHostLabel(installationLabel));
assert (Kernel.isInstallationAppHostLabel(
    "iffffffffffffffffffffffff--stale-canister"
));
// Reserve the entire i<96-bit>-- namespace so malformed current-looking
// authorities cannot fall through to portable package delivery.
assert (Kernel.isInstallationAppHostLabel(
    "iffffffffffffffffffffffff--stale--canister"
));
assert (Kernel.isInstallationAppHostLabel(
    "iffffffffffffffffffffffff--"
));
assert (not Kernel.isInstallationAppHostLabel(
    "I0123456789abcdef01234567--" # canisterId
));
assert (not Kernel.isInstallationAppHostLabel(
    "i0123456789abcdef0123456--" # canisterId
));
assert (not Kernel.isInstallationAppHostLabel(
    "i0123456789abcdef0123456g--" # canisterId
));
assert (
    Kernel.appAssetOriginPolicyForHeadersWithInstallation(
        [("Host", installationLabel # ".icp0.io")],
        canisterId,
        "gemma",
        nonce,
        false,
        [installationLabel],
    ) == #installation_app
);
assert (
    Kernel.appAssetOriginPolicyForHeadersWithInstallation(
        [("Host", installationLabel # ".raw.icp0.io")],
        canisterId,
        "gemma",
        nonce,
        false,
        [installationLabel],
    ) == #deny
);
assert (
    Kernel.appAssetOriginPolicyForHeadersWithInstallation(
        [("Host", installationLabel # ".example.com")],
        canisterId,
        "gemma",
        nonce,
        false,
        [installationLabel],
    ) == #deny
);
assert (
    Kernel.appAssetOriginPolicyWithInstallation(
        ?("iffffffffffffffffffffffff--" # canisterId),
        canisterId,
        "gemma",
        nonce,
        false,
        [installationLabel],
    ) == #deny
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
    Kernel.appAssetSandboxHeaders(rawCanisterPolicy, true) == [
        ("Content-Security-Policy", "sandbox allow-scripts")
    ]
);
assert (
    Kernel.appAssetSandboxHeaders(#persistent_app, true).size() == 0
);
assert (
    Kernel.appAssetSandboxHeaders(#kernel, true) == [
        ("Content-Security-Policy", "frame-ancestors 'none'")
    ]
);
assert (
    Kernel.appAssetSandboxHeaders(#kernel, false) == [
        ("Content-Security-Policy", "frame-ancestors 'none'")
    ]
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
assert (Kernel.appAssetSandboxHeaders(ordinaryPolicy, true).size() == 1);
assert (
    Kernel.appAssetOriginPolicy(
        persistentHost,
        canisterId,
        "gemma",
        nonce,
        false,
    ) == #deny
);
