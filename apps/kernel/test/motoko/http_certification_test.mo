import Base64 "mo:core/Base64";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import SHA256 "mo:sha2/Sha256";
import Cert "../../backend/certified_http";
import V2 "../../backend/certified_http_v2";
import Allocator "../../backend/certified_assets/Allocator";
import Forest "../../backend/certified_assets/AuthenticatedForest";

assert (Cert.ORIGIN_RESPONSE_VARIANTS_MAX == 344);
assert (Cert.originResponseVariantCountAllowed(344));
assert (not Cert.originResponseVariantCountAllowed(345));
assert (Cert.publicationBatchWorkAllowed(Cert.PUBLICATION_BATCH_WORK_MAX));
assert (
    not Cert.publicationBatchWorkAllowed(
        Cert.PUBLICATION_BATCH_WORK_MAX + 1,
    )
);

let officialRequestHash = Blob.fromArray([
    0x10, 0x79, 0x64, 0x53, 0x46, 0x6e, 0xfb, 0x3e,
    0x33, 0x38, 0x91, 0x13, 0x6b, 0x8a, 0x59, 0x31,
    0x26, 0x9f, 0x77, 0xe4, 0x0e, 0xad, 0x9d, 0x43,
    0x7f, 0xce, 0xe9, 0x4a, 0x02, 0xfa, 0x83, 0x3c,
]);
let requestBody = Blob.fromArray([0, 1, 2, 3, 4, 5, 6]);
let requestHeaders : [Cert.HeaderField] = [
    ("Accept-Language", "en"),
    ("Accept-Language", "en-US"),
    ("Host", "https://ic0.app"),
];

// Frozen from DFINITY's ic-http-certification request_hash_without_query
// vector. It proves header-name normalization, Host selection, method/body
// binding, duplicate retention, RIH ordering, and the final pair hash.
assert (
    Cert.requestHash("POST", requestHeaders, requestBody) ==
    officialRequestHash
);
assert (
    Cert.requestHash("GET", requestHeaders, requestBody) !=
    officialRequestHash
);
assert (
    Cert.requestHash(
        "POST",
        [("Host", "https://other.ic0.app")],
        requestBody,
    ) != officialRequestHash
);
assert (
    Cert.requestHash("POST", requestHeaders, Blob.fromArray([0, 1])) !=
    officialRequestHash
);

let officialResponseExpression = "default_certification(ValidationArgs{certification:Certification{no_request_certification:Empty{},response_certification:ResponseCertification{certified_response_headers:ResponseHeaderList{headers:[\"Accept-Encoding\",\"Cache-Control\"]}}}})";
let helloWorld : Blob = "Hello World!";
let responseHeaders : [Cert.HeaderField] = [
    ("IC-Certificate", "not part of the response hash"),
    ("IC-CertificateExpression", officialResponseExpression),
    ("Accept-Encoding", "gzip"),
    ("Cache-Control", "no-cache"),
    ("Cache-Control", "no-store"),
    ("Content-Security-Policy", "default-src 'self'"),
];
let officialResponseHash = Blob.fromArray([
    0x33, 0x93, 0x25, 0x0e, 0x3c, 0xed, 0xc3, 0x04,
    0x08, 0xdc, 0xb7, 0xe8, 0x96, 0x38, 0x98, 0xc3,
    0xd7, 0x54, 0x9b, 0x8a, 0x0b, 0x76, 0x49, 0x6b,
    0x82, 0xfd, 0xfe, 0xae, 0x99, 0xc2, 0xac, 0x78,
]);

// Frozen from DFINITY's response_hash_with_certified_headers vector.
assert (
    Cert.responseHashWithHeaders(
        responseHeaders,
        ["accept-encoding", "cache-control"],
        200,
        Cert.hashChunks([helloWorld]),
    ) == officialResponseHash
);
assert (
    Cert.responseHashWithHeaders(
        responseHeaders,
        ["accept-encoding", "cache-control"],
        404,
        Cert.hashChunks([helloWorld]),
    ) != officialResponseHash
);

let allHeadersExpression = Cert.HOST_BOUND_CERTIFICATION_EXPRESSION;
let allHeaders : [Cert.HeaderField] = [
    ("Content-Type", "text/plain"),
    ("IC-CertificateExpression", allHeadersExpression),
];
let allHeadersHash = Cert.responseHash(
    allHeaders,
    200,
    Cert.hashChunks([helloWorld]),
);
// An unlisted adversarial header must invalidate the response. The public
// expressions use an empty exclusion list rather than a permissive allowlist.
assert (
    Cert.responseHash(
        [
            ("Content-Type", "text/plain"),
            ("IC-CertificateExpression", allHeadersExpression),
            ("Set-Cookie", "admin=true"),
        ],
        200,
        Cert.hashChunks([helloWorld]),
    ) != allHeadersHash
);
assert (
    Cert.responseHash(
        [
            ("Content-Type", "text/plain"),
            ("IC-CertificateExpression", allHeadersExpression),
            ("IC-Certificate", "proof bytes are excluded by protocol"),
        ],
        200,
        Cert.hashChunks([helloWorld]),
    ) == allHeadersHash
);
assert (Text.contains(
    Cert.HOST_BOUND_CERTIFICATION_EXPRESSION,
    #text "response_header_exclusions:ResponseHeaderList{headers:[]}",
));

assert (
    Cert.exactExpressionTextPath("/") == ["http_expr", "", "<$>"]
);
assert (
    Cert.exactExpressionTextPath("/a/b/") == [
        "http_expr",
        "a",
        "b",
        "",
        "<$>",
    ]
);
assert (
    Base64.encode(Cert.encodeExpressionPath(
        ["http_expr", "example.json", "<$>"],
    )) == "2dn3g2lodHRwX2V4cHJsZXhhbXBsZS5qc29uYzwkPg=="
);
assert (
    Cert.composeCertificateHeaderV2(
        Blob.fromArray([1, 2]),
        Blob.fromArray([3, 4]),
        Cert.encodeExpressionPath(["http_expr", "example.json", "<$>"]),
    ) == (
        "IC-Certificate",
        "certificate=:AQI=:, tree=:AwQ=:, expr_path=:2dn3g2lodHRwX2V4cHJsZXhhbXBsZS5qc29uYzwkPg==:, version=2",
    )
);

assert (Text.contains(
    Cert.HOST_BOUND_CERTIFICATION_EXPRESSION,
    #text "certified_request_headers:[\"host\"]",
));
assert (Text.contains(
    Cert.PORTABLE_CERTIFICATION_EXPRESSION,
    #text "certified_request_headers:[]",
));
assert (not Text.contains(
    Cert.PORTABLE_CERTIFICATION_EXPRESSION,
    #text "certified_request_headers:[\"host\"]",
));
assert (
    Cert.portableRequestHash("GET", requestBody) ==
    Cert.requestHash("GET", [], requestBody)
);
assert (
    Cert.portableRequestHash("GET", requestBody) !=
    Cert.portableRequestHash("POST", requestBody)
);
assert (
    Cert.portableRequestHash("GET", requestBody) !=
    Cert.portableRequestHash("GET", Blob.fromArray([]))
);

let routeHeaders : [Cert.HeaderField] = [
    ("Content-Type", "application/json"),
    ("Cache-Control", "no-store"),
    (
        Cert.CERTIFICATE_EXPRESSION_HEADER,
        Cert.HOST_BOUND_CERTIFICATION_EXPRESSION,
    ),
];
let routeBodyA : Blob = "{\"owner\":\"a\"}";
let routeBodyB : Blob = "{\"owner\":\"b\"}";
let routeBodyANew : Blob = "{\"owner\":\"a2\"}";
let routeBodyAHash = Cert.hashChunks([routeBodyA]);
let routeBodyBHash = Cert.hashChunks([routeBodyB]);
let routeBodyANewHash = Cert.hashChunks([routeBodyANew]);
let emptyBodyHash = Cert.hashChunks([Blob.fromArray([])]);

func responseVariant(
    method : Text,
    host : Text,
    statusCode : Nat16,
    bodyHash : Blob,
) : Cert.ResponseCertificationVariant {
    {
        method;
        host;
        status_code = statusCode;
        body_hash = bodyHash;
        response_headers = routeHeaders;
    };
};

let sharedUrl = "/api/items";
let hostA = "a--aaaaa-aa.icp0.io";
let hostB = "b--aaaaa-aa.icp0.io";
let getA = responseVariant("GET", hostA, 200, routeBodyAHash);
let getB = responseVariant("GET", hostB, 200, routeBodyBHash);
let headA = responseVariant("HEAD", hostA, 200, emptyBodyHash);
let certTree = Cert.PublicCertificationTree(Cert.init());

// One URL is a shared v2 expression path. Independently certified Host request
// hashes must coexist rather than one publisher erasing the whole URL branch.
certTree.apply([#replace({
    url = sharedUrl;
    prior = [];
    next = [getA, getB];
})]);
assert (certTree.has(sharedUrl, getA));
assert (certTree.has(sharedUrl, getB));

// HEAD occupies a distinct request hash and can carry its own empty-body
// response without replacing GET for the same URL and Host.
certTree.apply([#replace({
    url = sharedUrl;
    prior = [];
    next = [headA];
})]);
assert (certTree.has(sharedUrl, getA));
assert (certTree.has(sharedUrl, getB));
assert (certTree.has(sharedUrl, headA));
assert (
    Cert.requestHash("GET", [("Host", hostA)], Blob.fromArray([])) !=
    Cert.requestHash("HEAD", [("Host", hostA)], Blob.fromArray([]))
);

// Replacing one request branch removes every stale response hash below that
// request while preserving other methods and owners at the same URL.
let getANew = responseVariant("GET", hostA, 200, routeBodyANewHash);
certTree.apply([#replace({
    url = sharedUrl;
    prior = [{ method = "GET"; host = hostA }];
    next = [getANew];
})]);
assert (not certTree.has(sharedUrl, getA));
assert (certTree.has(sharedUrl, getANew));
assert (certTree.has(sharedUrl, headA));
assert (certTree.has(sharedUrl, getB));

let getACreated = responseVariant("GET", hostA, 201, routeBodyANewHash);
certTree.apply([#replace({
    url = sharedUrl;
    prior = [{ method = "GET"; host = hostA }];
    next = [getACreated];
})]);
assert (not certTree.has(sharedUrl, getANew));
assert (certTree.has(sharedUrl, getACreated));
assert (certTree.has(sharedUrl, headA));
assert (certTree.has(sharedUrl, getB));

certTree.apply([#remove({
    url = sharedUrl;
    requests = [{ method = "GET"; host = hostB }];
})]);
assert (not certTree.has(sharedUrl, getB));
assert (certTree.has(sharedUrl, getACreated));
assert (certTree.has(sharedUrl, headA));

// The compatibility static publisher is also request-scoped now. Publishing a
// second Host in a later call must not remove the first Host's GET leaf.
let staticTree = Cert.PublicCertificationTree(Cert.init());
staticTree.publish(sharedUrl, routeBodyAHash, [{
    host = hostA;
    response_headers = routeHeaders;
}]);
staticTree.publish(sharedUrl, routeBodyBHash, [{
    host = hostB;
    response_headers = routeHeaders;
}]);
assert (staticTree.has(sharedUrl, getA));
assert (staticTree.has(sharedUrl, getB));

// Generic portable blobs use the same method/body request hash on every
// gateway authority. Empty Host is an internal tree-owner sentinel; it is not
// accepted by the public request-key deletion API. Package/compiler data uses
// this explicit public compatibility profile; executable app authority is
// instead bounded by the selected subtree, Host/destination proof, and CSP.
let portableHeaders : [Cert.HeaderField] = [
    ("Content-Type", "text/plain"),
    (
        Cert.CERTIFICATE_EXPRESSION_HEADER,
        Cert.PORTABLE_CERTIFICATION_EXPRESSION,
    ),
];
let portableGet : Cert.ResponseCertificationVariant = {
    method = "GET";
    host = "";
    status_code = 200;
    body_hash = routeBodyAHash;
    response_headers = portableHeaders;
};
let portableTree = Cert.PublicCertificationTree(Cert.init());
portableTree.apply([#replace({
    url = "/mo/hash.mo";
    prior = [];
    next = [portableGet];
})]);
assert (portableTree.has("/mo/hash.mo", portableGet));

// Selected origin adoption replaces the one Host-independent package owner,
// so an older active-MIME response leaf cannot survive beside the passive
// application/octet-stream + nosniff response.
let passivePortableHeaders : [Cert.HeaderField] = [
    ("Content-Type", "application/octet-stream"),
    ("X-Content-Type-Options", "nosniff"),
    (
        Cert.CERTIFICATE_EXPRESSION_HEADER,
        Cert.PORTABLE_CERTIFICATION_EXPRESSION,
    ),
];
let passivePortableGet : Cert.ResponseCertificationVariant = {
    portableGet with response_headers = passivePortableHeaders;
};
let portableUrl = "/app/hello/pkg/worker.js";
let portableOwner : Cert.RequestOwner = { method = "GET"; host = "" };
let portableReplacementTree = Cert.PublicCertificationTree(Cert.init());
portableReplacementTree.apply([#replace({
    url = portableUrl;
    prior = [];
    next = [portableGet];
})]);
portableReplacementTree.apply([#replace({
    url = portableUrl;
    prior = [portableOwner];
    next = [passivePortableGet];
})]);
assert (not portableReplacementTree.has(portableUrl, portableGet));
assert (portableReplacementTree.has(portableUrl, passivePortableGet));
let portableReplacementForest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
let persistentPortableReplacementTree = Cert.PersistentCertificationTree(
    portableReplacementForest,
    func() {},
);
persistentPortableReplacementTree.apply([#replace({
    url = portableUrl;
    prior = [];
    next = [portableGet];
})]);
persistentPortableReplacementTree.apply([#replace({
    url = portableUrl;
    prior = [portableOwner];
    next = [passivePortableGet];
})]);
let #ok(_) = Forest.commit(portableReplacementForest) else {
    Runtime.trap("portable package replacement commit failed");
};
assert (not persistentPortableReplacementTree.has(portableUrl, portableGet));
assert (persistentPortableReplacementTree.has(
    portableUrl,
    passivePortableGet,
));

// A retained Kernel asset may outlive the package path that originally wrote
// it. Replacing its exact Host request owner must retire the previously
// certified active-content response and leave only the response carrying the
// current frame-ancestor restriction.
let legacyKernelAssetHeaders : [Cert.HeaderField] = [
    ("Content-Type", "image/svg+xml"),
    (
        Cert.CERTIFICATE_EXPRESSION_HEADER,
        Cert.HOST_BOUND_CERTIFICATION_EXPRESSION,
    ),
];
let hardenedKernelAssetHeaders : [Cert.HeaderField] = [
    ("Content-Type", "image/svg+xml"),
    (
        Cert.CERTIFICATE_EXPRESSION_HEADER,
        Cert.HOST_BOUND_CERTIFICATION_EXPRESSION,
    ),
    ("Content-Security-Policy", "frame-ancestors 'none'"),
];
let legacyKernelAsset : Cert.ResponseCertificationVariant = {
    method = "GET";
    host = hostA;
    status_code = 200;
    body_hash = routeBodyAHash;
    response_headers = legacyKernelAssetHeaders;
};
let hardenedKernelAsset : Cert.ResponseCertificationVariant = {
    legacyKernelAsset with response_headers = hardenedKernelAssetHeaders;
};
let kernelMigrationForest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
let kernelMigrationTree = Cert.PersistentCertificationTree(
    kernelMigrationForest,
    func() {},
);
let retainedKernelAssetUrl = "/obsolete-widget.svg";
kernelMigrationTree.apply([#replace({
    url = retainedKernelAssetUrl;
    prior = [];
    next = [legacyKernelAsset];
})]);
kernelMigrationTree.apply([#replace({
    url = retainedKernelAssetUrl;
    prior = [{ method = "GET"; host = hostA }];
    next = [hardenedKernelAsset];
})]);
let #ok(_) = Forest.commit(kernelMigrationForest) else {
    Runtime.trap("retained Kernel response replacement commit failed");
};
assert (not kernelMigrationTree.has(
    retainedKernelAssetUrl,
    legacyKernelAsset,
));
assert (kernelMigrationTree.has(
    retainedKernelAssetUrl,
    hardenedKernelAsset,
));

// The v316 actor-activation boundary must not infer predecessor expression
// ownership. It retains only complete app/package namespaces, installs the
// current root 404, and moves the rest of the predecessor response tree
// outside `http_expr` in one batch. Known public system documents are then
// reclaimed and rebuilt one at a time by actor initialization.
let cutoverForest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
let cutoverTree = Cert.PersistentCertificationTree(
    cutoverForest,
    func() {},
);
let cutoverEmpty : Blob = Blob.fromArray([]);
func syntheticExpressionLeaf(
    expressionPath : [Blob],
) : [Blob] {
    Array.concat<Blob>(
        expressionPath,
        [routeBodyAHash, routeBodyBHash, routeBodyANewHash],
    );
};
func seedExpressionLeaf(path : [Blob]) : () {
    assert (
        Forest.put(cutoverForest, path, cutoverEmpty) ==
        #ok({ inserted = true; prior = null })
    );
};

let retainedAppExact = syntheticExpressionLeaf(
    Cert.exactExpressionPath("/app/files/index.html"),
);
let retainedMountBase = "/app/files/_route/public";
let retainedAppWildcard = syntheticExpressionLeaf(
    Cert.wildcardExpressionPath(retainedMountBase),
);
let retainedPackage = syntheticExpressionLeaf(
    Cert.exactExpressionPath("/pkg/neutron.json"),
);
let retainedModule = syntheticExpressionLeaf(
    Cert.exactExpressionPath(
        "/mo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mo",
    ),
);
for (leaf in [
    retainedAppExact,
    retainedAppWildcard,
    retainedPackage,
    retainedModule,
].vals()) seedExpressionLeaf(leaf);

assert (
    Cert.KERNEL_RESPONSE_POLICY_REBUILD_SYSTEM_PATHS_V316 == [
        "/system/apps.json",
        "/system/browser-surface-origins.json",
        "/system/runtime-config.json",
        "/system/install-provenance.json",
        "/system/deployment-build-record.json",
    ]
);
for (
    url in Cert.KERNEL_RESPONSE_POLICY_REBUILD_SYSTEM_PATHS_V316.vals()
) {
    seedExpressionLeaf(syntheticExpressionLeaf(
        Cert.exactExpressionPath(url),
    ));
};

let retiredKernelLeaf = syntheticExpressionLeaf(
    Cert.exactExpressionPath("/obsolete-widget.svg"),
);
let retiredKernelWildcard = syntheticExpressionLeaf(
    Cert.wildcardExpressionPath("/legacy-api"),
);
let unretainedAppLeaf = syntheticExpressionLeaf(
    Cert.exactExpressionPath("/app/other/index.html"),
);
let kernelAppRootLeaf = syntheticExpressionLeaf(
    Cert.exactExpressionPath("/app/"),
);
let systemDescendantLeaf = syntheticExpressionLeaf(
    Cert.exactExpressionPath("/system/apps.json/child"),
);
let systemWildcardLeaf = syntheticExpressionLeaf(
    Cert.wildcardExpressionPath("/system/apps.json"),
);
for (leaf in [
    retiredKernelLeaf,
    retiredKernelWildcard,
    unretainedAppLeaf,
    kernelAppRootLeaf,
    systemDescendantLeaf,
    systemWildcardLeaf,
].vals()) seedExpressionLeaf(leaf);

let cutoverNotFoundHeaders : [Cert.HeaderField] = [
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
let cutoverNotFoundBodyHash = Cert.hashChunks([Text.encodeUtf8("Not found")]);
let predecessorNotFoundBodyHash = Cert.hashChunks([
    Text.encodeUtf8("Predecessor not found"),
]);
let notFoundPrefix : [Blob] = [
    Text.encodeUtf8("http_expr"),
    Text.encodeUtf8("<*>"),
    SHA256.fromBlob(
        #sha256,
        Text.encodeUtf8(Cert.NOT_FOUND_EXPRESSION),
    ),
    cutoverEmpty,
];
func notFoundLeaf(bodyHash : Blob) : [Blob] {
    Array.concat<Blob>(notFoundPrefix, [Cert.responseHash(
        cutoverNotFoundHeaders,
        404,
        bodyHash,
    )]);
};
let predecessorNotFoundLeaf = notFoundLeaf(
    predecessorNotFoundBodyHash,
);
let currentNotFoundLeaf = notFoundLeaf(cutoverNotFoundBodyHash);
seedExpressionLeaf(predecessorNotFoundLeaf);

cutoverTree.syncMountCatalog(
    "files:public",
    retainedMountBase,
    null,
);
let #ok(cutoverBaseline) = Forest.commit(cutoverForest) else {
    Runtime.trap("response-policy cutover baseline commit failed");
};
assert (
    cutoverTree.mountCatalogMatches(
        "files:public",
        retainedMountBase,
        null,
    ) == #present
);

let cutoverHttpAssets = Cert.init();
let cutover = Cert.CertifiedHttp(cutoverHttpAssets, cutoverForest);
cutover.beginV2PublicationBatch();
cutover.putHash("/obsolete-widget.svg", routeBodyAHash);
cutover.putHash("/app/files/index.html", routeBodyBHash);
assert (cutover.assetHash("/obsolete-widget.svg") == ?routeBodyAHash);
assert (cutover.assetHash("/app/files/index.html") == ?routeBodyBHash);

let cutoverDeployment = "0123456789abcdef0123456789abcdef";
assert (cutover.cutoverKernelResponsePolicyV316(
    cutoverDeployment,
    ["files"],
    cutoverNotFoundHeaders,
    cutoverNotFoundBodyHash,
));
let cutoverQuarantine = Cert.kernelResponsePolicyV316QuarantinePath();
let cutoverMarker = Cert.kernelResponsePolicyV316MarkerPath();
let quarantinedKernelLeaf = Array.concat<Blob>(
    cutoverQuarantine,
    Array.tabulate<Blob>(
        retiredKernelLeaf.size() - 1,
        func(index) { retiredKernelLeaf[index + 1] },
    ),
);
assert (
    Forest.pathKind(cutoverForest, quarantinedKernelLeaf) == #leaf
);
assert (
    Forest.pathKind(cutoverForest, cutoverMarker) == #leaf
);
for (
    url in Cert.KERNEL_RESPONSE_POLICY_REBUILD_SYSTEM_PATHS_V316.vals()
) {
    let systemLeaf = syntheticExpressionLeaf(Cert.exactExpressionPath(url));
    let quarantinedSystemLeaf = Array.concat<Blob>(
        cutoverQuarantine,
        Array.tabulate<Blob>(
            systemLeaf.size() - 1,
            func(index) { systemLeaf[index + 1] },
        ),
    );
    assert (
        Forest.pathKind(cutoverForest, quarantinedSystemLeaf) == #leaf
    );
    cutover.removeQuarantinedKernelStaticExpressionV316(url);
    assert (
        Forest.pathKind(cutoverForest, quarantinedSystemLeaf) == #absent
    );
};
cutover.removeQuarantinedKernelStaticExpressionV316(
    "/obsolete-widget.svg",
);
assert (Forest.pathKind(cutoverForest, quarantinedKernelLeaf) == #absent);
let #ok(cutoverCommitted) = Forest.commit(cutoverForest) else {
    Runtime.trap("response-policy cutover commit failed");
};
assert (
    cutoverCommitted.commit_sequence ==
    cutoverBaseline.commit_sequence + 1
);
assert (cutoverCommitted.attached_root_changed);
assert (Forest.deepValidate(cutoverForest));

for (leaf in [
    retainedAppExact,
    retainedAppWildcard,
    retainedPackage,
    retainedModule,
].vals()) {
    assert (Forest.lookup(cutoverForest, leaf) == #found(cutoverEmpty));
};
for (url in Cert.KERNEL_RESPONSE_POLICY_REBUILD_SYSTEM_PATHS_V316.vals()) {
    assert (
        Forest.lookup(
            cutoverForest,
            syntheticExpressionLeaf(Cert.exactExpressionPath(url)),
        ) == #absent
    );
};
for (leaf in [
    retiredKernelLeaf,
    retiredKernelWildcard,
    unretainedAppLeaf,
    kernelAppRootLeaf,
    systemDescendantLeaf,
    systemWildcardLeaf,
    predecessorNotFoundLeaf,
].vals()) {
    assert (Forest.lookup(cutoverForest, leaf) == #absent);
};
assert (
    Forest.lookup(cutoverForest, currentNotFoundLeaf) ==
    #found(cutoverEmpty)
);
assert (
    cutoverTree.mountCatalogMatches(
        "files:public",
        retainedMountBase,
        null,
    ) == #present
);
assert (cutover.assetHash("/obsolete-widget.svg") == ?routeBodyAHash);
assert (cutover.assetHash("/app/files/index.html") == ?routeBodyBHash);
assert (
    Forest.pathKind(cutoverForest, cutoverQuarantine) == #subtree
);
assert (
    Forest.lookup(cutoverForest, cutoverMarker) ==
    #found(Text.encodeUtf8(cutoverDeployment))
);

let cutoverRoot = cutoverCommitted.response_root_hash;
assert (not cutover.cutoverKernelResponsePolicyV316(
    cutoverDeployment,
    ["files"],
    cutoverNotFoundHeaders,
    cutoverNotFoundBodyHash,
));
let #ok(cutoverIdempotent) = Forest.commit(cutoverForest) else {
    Runtime.trap("idempotent response-policy cutover commit failed");
};
assert (not cutoverIdempotent.attached_root_changed);
assert (cutoverIdempotent.response_root_hash == cutoverRoot);
assert (
    cutoverIdempotent.commit_sequence == cutoverCommitted.commit_sequence
);
assert (cutover.assetHash("/obsolete-widget.svg") == ?routeBodyAHash);
assert (cutover.assetHash("/app/files/index.html") == ?routeBodyBHash);

// A predecessor containing only the root 404 and retained namespaces would
// otherwise collapse its `http_expr` root as the last retained branch is
// detached. The early marker keeps that root movable and remains the exact
// idempotence marker after every other branch is grafted back live.
let emptyQuarantineForest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
for (leaf in [
    retainedAppExact,
    retainedPackage,
    retainedModule,
    predecessorNotFoundLeaf,
].vals()) {
    assert (
        Forest.put(emptyQuarantineForest, leaf, cutoverEmpty) ==
        #ok({ inserted = true; prior = null })
    );
};
let #ok(_) = Forest.commit(emptyQuarantineForest) else {
    Runtime.trap("minimal predecessor baseline commit failed");
};
let emptyQuarantine = Cert.CertifiedHttp(
    Cert.init(),
    emptyQuarantineForest,
);
emptyQuarantine.beginV2PublicationBatch();
assert (emptyQuarantine.cutoverKernelResponsePolicyV316(
    cutoverDeployment,
    ["files"],
    cutoverNotFoundHeaders,
    cutoverNotFoundBodyHash,
));
let #ok(emptyQuarantineCommitted) = Forest.commit(emptyQuarantineForest) else {
    Runtime.trap("empty response-policy quarantine commit failed");
};
assert (emptyQuarantineCommitted.attached_root_changed);
assert (Forest.deepValidate(emptyQuarantineForest));
assert (
    Forest.pathKind(emptyQuarantineForest, cutoverQuarantine) == #subtree
);
assert (
    Forest.lookup(emptyQuarantineForest, cutoverMarker) ==
    #found(Text.encodeUtf8(cutoverDeployment))
);
assert (
    Forest.lookup(emptyQuarantineForest, currentNotFoundLeaf) ==
    #found(cutoverEmpty)
);
for (leaf in [retainedAppExact, retainedPackage, retainedModule].vals()) {
    assert (
        Forest.lookup(emptyQuarantineForest, leaf) ==
        #found(cutoverEmpty)
    );
};
assert (not emptyQuarantine.cutoverKernelResponsePolicyV316(
    cutoverDeployment,
    ["files"],
    cutoverNotFoundHeaders,
    cutoverNotFoundBodyHash,
));
let #ok(emptyQuarantineRetry) = Forest.commit(emptyQuarantineForest) else {
    Runtime.trap("empty response-policy quarantine retry commit failed");
};
assert (not emptyQuarantineRetry.attached_root_changed);
assert (
    emptyQuarantineRetry.response_root_hash ==
    emptyQuarantineCommitted.response_root_hash
);

// A multi-chunk overwrite is transiently visible to install admission even
// when an older durable asset exists at the same key. Completion clears the
// fence before invoking the storage callback.
let chunkFenceForest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
let chunkFence = Cert.CertifiedHttp(Cert.init(), chunkFenceForest);
let chunkFenceKey = "/system/staging/deployment/assets/0";
var chunkFenceCompleted = false;
// Keep publication deferred because the interpreter has no canister certified
// data API; production install uploads already run beneath an outer batch.
chunkFence.beginV2PublicationBatch();
assert (not chunkFence.hasPendingChunked(chunkFenceKey));
chunkFence.chunkedStart(
    chunkFenceKey,
    2,
    routeBodyA,
    func(chunks, bodyHash) {
        assert (not chunkFence.hasPendingChunked(chunkFenceKey));
        assert (chunks == [routeBodyA, routeBodyB]);
        assert (bodyHash == Cert.hashChunks(chunks));
        chunkFenceCompleted := true;
    },
);
assert (chunkFence.hasPendingChunked(chunkFenceKey));
chunkFence.chunkedSend(chunkFenceKey, 1, routeBodyB);
assert (chunkFenceCompleted);
assert (not chunkFence.hasPendingChunked(chunkFenceKey));

// Dedicated resident proofs bind browser destination on every nonce-host
// response. The executable HTML profile additionally binds the one canonical
// kernel-authored six-field installation-authority query.
let residentQuery =
    "app=files&role=background" #
    "&installation-uid=17" #
    "&resident-frame-security=credentialless_ephemeral_dedicated_v1" #
    "&browser-origin-nonce=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" #
    "&browser-origin-authority-epoch=3";
let residentKind : Cert.ResidentRequestKind =
    #html_v1({ canonical_query = residentQuery });
let residentHost =
    "pbbbbbbbbbbbbbbbbbbbbbbbb--aaaaa-aa.icp0.io";
let residentOwner : Cert.ResidentRequestOwner = {
    method = "GET";
    host = residentHost;
    kind = residentKind;
};
let emptyRequestBody = Blob.fromArray([]);
let residentOwnerHash = Cert.residentRequestHash(
    residentOwner,
    emptyRequestBody,
);
let residentOwnerHashGolden = Blob.fromArray([
    0x60, 0x57, 0x4d, 0x8e, 0x0a, 0x2b, 0x13, 0x53,
    0xce, 0xfe, 0xab, 0xac, 0x38, 0xd3, 0x10, 0x19,
    0x0f, 0xeb, 0x8c, 0xcc, 0x3f, 0xc6, 0xb7, 0xfa,
    0x85, 0x4d, 0x92, 0x1e, 0x53, 0xc7, 0x10, 0x1a,
]);
assert (residentOwnerHash == residentOwnerHashGolden);
assert (Cert.validResidentCanonicalQuery(residentQuery));
assert (not Cert.validResidentCanonicalQuery(
    Text.replace(
        residentQuery,
        #text "app=files&role=background",
        "role=background&app=files",
    ),
));
assert (Text.contains(
    Cert.RESIDENT_HTML_CERTIFICATION_EXPRESSION,
    #text "certified_request_headers:[\"host\",\"sec-fetch-dest\"]",
));
assert (Text.contains(
    Cert.RESIDENT_HTML_CERTIFICATION_EXPRESSION,
    #text "certified_query_parameters:[\"app\",\"role\",\"installation-uid\",\"resident-frame-security\",\"browser-origin-nonce\",\"browser-origin-authority-epoch\"]",
));
assert (Cert.RESIDENT_HTML_CERTIFICATION_EXPRESSION !=
    Cert.RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION);
assert (
    Cert.residentRequestHashForRequest(
        residentKind,
        "GET",
        "/app/files/service.html?" # residentQuery,
        [
            ("Host", residentHost),
            ("Sec-Fetch-Dest", "iframe"),
        ],
        emptyRequestBody,
    ) == ?residentOwnerHash
);
assert (
    Cert.residentRequestHashForRequest(
        residentKind,
        "GET",
        "/app/files/service.html?" # residentQuery,
        [
            ("Host", residentHost),
            ("Sec-Fetch-Dest", "document"),
        ],
        emptyRequestBody,
    ) != ?residentOwnerHash
);
assert (
    Cert.residentRequestHashForRequest(
        residentKind,
        "GET",
        "/app/files/service.html?" # residentQuery,
        [("Host", residentHost)],
        emptyRequestBody,
    ) != ?residentOwnerHash
);
assert (
    Cert.residentRequestHashForRequest(
        residentKind,
        "GET",
        "/app/files/service.html?" # residentQuery,
        [
            ("Host", residentHost),
            ("Sec-Fetch-Dest", "iframe"),
            ("sec-fetch-dest", "iframe"),
        ],
        emptyRequestBody,
    ) != ?residentOwnerHash
);
assert (
    Cert.residentRequestHashForRequest(
        residentKind,
        "GET",
        "/app/files/service.html?" # Text.replace(
            residentQuery,
            #text "app=files&role=background",
            "role=background&app=files",
        ),
        [
            ("Host", residentHost),
            ("Sec-Fetch-Dest", "iframe"),
        ],
        emptyRequestBody,
    ) != ?residentOwnerHash
);
assert (
    Cert.residentRequestHashForRequest(
        residentKind,
        "GET",
        "/app/files/service.html?" # Text.replace(
            residentQuery,
            #text "browser-origin-authority-epoch=3",
            "browser-origin-authority-epoch=4",
        ),
        [
            ("Host", residentHost),
            ("Sec-Fetch-Dest", "iframe"),
        ],
        emptyRequestBody,
    ) != ?residentOwnerHash
);

let residentWorkerKind : Cert.ResidentRequestKind =
    #subresource_v1({ destination = "worker" });
let residentWorkerOwner : Cert.ResidentRequestOwner = {
    method = "GET";
    host = residentHost;
    kind = residentWorkerKind;
};
let residentWorkerHash = Cert.residentRequestHash(
    residentWorkerOwner,
    emptyRequestBody,
);
assert (
    Cert.residentRequestHashForRequest(
        residentWorkerKind,
        "GET",
        "/app/files/worker.js",
        [
            ("Host", residentHost),
            ("Sec-Fetch-Dest", "worker"),
        ],
        emptyRequestBody,
    ) == ?residentWorkerHash
);
assert (
    Cert.residentRequestHashForRequest(
        residentWorkerKind,
        "GET",
        "/app/files/worker.js",
        [
            ("Host", residentHost),
            ("Sec-Fetch-Dest", "serviceworker"),
        ],
        emptyRequestBody,
    ) != ?residentWorkerHash
);

// Installation-owned HTML binds Host and the exact iframe destination while
// deliberately leaving ordinary launch-context query parameters out of the
// certified request. It reuses the existing subresource CEL bytes so adding
// the request kind does not alter the persisted response-policy contract.
let installationHtmlKind : Cert.ResidentRequestKind =
    #installation_html_v1;
let installationHost =
    "i0123456789abcdef01234567--aaaaa-aa.icp0.io";
let installationHtmlOwner : Cert.ResidentRequestOwner = {
    method = "GET";
    host = installationHost;
    kind = installationHtmlKind;
};
let installationHtmlHash = Cert.residentRequestHash(
    installationHtmlOwner,
    emptyRequestBody,
);
assert (
    Cert.residentCertificationExpression(installationHtmlKind) ==
    Cert.RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION
);
assert (
    Cert.residentRequestHashForRequest(
        installationHtmlKind,
        "GET",
        "/app/files/index.html?app=files&tile=call",
        [
            ("Host", installationHost),
            ("Sec-Fetch-Dest", "iframe"),
        ],
        emptyRequestBody,
    ) == ?installationHtmlHash
);
assert (
    Cert.residentRequestHashForRequest(
        installationHtmlKind,
        "GET",
        "/app/files/index.html?app=other&tile=other",
        [
            ("Host", installationHost),
            ("Sec-Fetch-Dest", "iframe"),
        ],
        emptyRequestBody,
    ) == ?installationHtmlHash
);
assert (
    Cert.residentRequestHashForRequest(
        installationHtmlKind,
        "GET",
        "/app/files/index.html?app=files&tile=call",
        [
            ("Host", installationHost),
            ("Sec-Fetch-Dest", "document"),
        ],
        emptyRequestBody,
    ) != ?installationHtmlHash
);

let residentHtmlHeaders : [Cert.HeaderField] = [
    ("Content-Type", "text/html; charset=utf-8"),
    (
        Cert.CERTIFICATE_EXPRESSION_HEADER,
        Cert.RESIDENT_HTML_CERTIFICATION_EXPRESSION,
    ),
];
let residentHtmlVariant : Cert.ResidentResponseVariant = {
    method = "GET";
    host = residentHost;
    kind = residentKind;
    status_code = 200;
    body_hash = routeBodyAHash;
    response_headers = residentHtmlHeaders;
};
let residentHtmlAlternative : Cert.ResidentResponseVariant = {
    residentHtmlVariant with body_hash = routeBodyBHash;
};
let installationHtmlHeaders : [Cert.HeaderField] = [
    ("Content-Type", "text/html; charset=utf-8"),
    (
        Cert.CERTIFICATE_EXPRESSION_HEADER,
        Cert.RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION,
    ),
];
let installationHtmlVariant : Cert.ResidentResponseVariant = {
    method = "GET";
    host = installationHost;
    kind = installationHtmlKind;
    status_code = 200;
    body_hash = routeBodyAHash;
    response_headers = installationHtmlHeaders;
};

let residentWorkerVariant : Cert.ResidentResponseVariant = {
    method = "GET";
    host = residentHost;
    kind = residentWorkerKind;
    status_code = 200;
    body_hash = routeBodyBHash;
    response_headers = installationHtmlHeaders;
};

// Current generation creates only dedicated Worker leaves. Preserve a
// predecessor-shaped seven-destination set below to prove the 344-leaf cleanup
// ceiling can still retire already-certified ServiceWorker/SharedWorker leaves.
let fanoutInstallationKinds : [Cert.ResidentRequestKind] = [
    #subresource_v1({ destination = "empty" }),
    #subresource_v1({ destination = "script" }),
    #subresource_v1({ destination = "worker" }),
    #subresource_v1({ destination = "audioworklet" }),
    #subresource_v1({ destination = "paintworklet" }),
];
let fanoutPersistentKinds : [Cert.ResidentRequestKind] = [
    #subresource_v1({ destination = "empty" }),
    #subresource_v1({ destination = "script" }),
    #subresource_v1({ destination = "worker" }),
    #subresource_v1({ destination = "sharedworker" }),
    #subresource_v1({ destination = "serviceworker" }),
    #subresource_v1({ destination = "audioworklet" }),
    #subresource_v1({ destination = "paintworklet" }),
];
let currentPersistentKindCount = 5;
let fanoutInstallationSurfaceCount = 33;
let fanoutAuthorityCount = 2;
let fanoutInstallationVariantCount = fanoutInstallationSurfaceCount *
    fanoutAuthorityCount * fanoutInstallationKinds.size();
func fanoutVariants(bodyHash : Blob) : [Cert.ResidentResponseVariant] {
    Array.tabulate<Cert.ResidentResponseVariant>(
        Cert.ORIGIN_RESPONSE_VARIANTS_MAX,
        func(index) {
            let installation = index < fanoutInstallationVariantCount;
            let localIndex = if (installation) index else
                index - fanoutInstallationVariantCount;
            let kinds = if (installation) fanoutInstallationKinds else
                fanoutPersistentKinds;
            let kindIndex = localIndex % kinds.size();
            let authorityIndex = (localIndex / kinds.size()) %
                fanoutAuthorityCount;
            let surfaceIndex = localIndex /
                (kinds.size() * fanoutAuthorityCount);
            let hostLabel = if (installation) {
                "fanout" # Nat.toText(surfaceIndex) # "--aaaaa-aa";
            } else {
                "p0123456789abcdef01234567--aaaaa-aa";
            };
            {
                method = "GET";
                host = hostLabel # (
                    if (authorityIndex == 0) ".icp0.io"
                    else ".localhost:8000"
                );
                kind = kinds[kindIndex];
                status_code = 200;
                body_hash = bodyHash;
                response_headers = installationHtmlHeaders;
            };
        },
    );
};
let initialFanoutVariants = fanoutVariants(routeBodyBHash);
assert (fanoutInstallationVariantCount == 330);
assert (
    fanoutInstallationVariantCount +
        fanoutAuthorityCount * currentPersistentKindCount == 340
);
assert (Cert.originResponseVariantCountAllowed(340));
assert (initialFanoutVariants.size() == 344);
assert (
    initialFanoutVariants.size() == Cert.ORIGIN_RESPONSE_VARIANTS_MAX
);
// Persistent-forest mechanics are independent of the declared variant count.
// Exercise a representative cross-surface set here; the exact closed maximum
// is checked above without making every unit-test run build and rotate a
// several-hundred-leaf authenticated tree.
let boundedFanoutVariants = Array.tabulate<Cert.ResidentResponseVariant>(
    8,
    func(index) { initialFanoutVariants[index] },
);
let rotatedFanoutVariants = Array.map<
    Cert.ResidentResponseVariant,
    Cert.ResidentResponseVariant,
>(boundedFanoutVariants, func(variant) {
    { variant with body_hash = routeBodyAHash };
});
let fanoutUrl = "/app/files/fanout.js";
let fanoutForest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
let fanoutTree = Cert.PersistentCertificationTree(fanoutForest, func() {});
Forest.resetOperationCounters(fanoutForest);
let fanoutWorkStart = Cert.authenticatedForestMutationWork(
    fanoutForest.counters,
);
fanoutTree.apply([#replace_origin_scoped({
    url = fanoutUrl;
    next = boundedFanoutVariants;
})]);
let fanoutPublishWork = Cert.authenticatedForestMutationWork(
    fanoutForest.counters,
) - fanoutWorkStart;
assert (fanoutPublishWork > 0);
assert (Cert.publicationBatchWorkAllowed(fanoutPublishWork));
let #ok(_) = Forest.commit(fanoutForest) else {
    Runtime.trap("fanout forest publication commit failed");
};
assert (fanoutTree.hasResident(fanoutUrl, boundedFanoutVariants[0]));
assert (fanoutTree.hasResident(
    fanoutUrl,
    boundedFanoutVariants[boundedFanoutVariants.size() - 1],
));
fanoutTree.apply([#replace_origin_scoped({
    url = fanoutUrl;
    next = rotatedFanoutVariants;
})]);
let #ok(_) = Forest.commit(fanoutForest) else {
    Runtime.trap("fanout forest rotation commit failed");
};
assert (not fanoutTree.hasResident(fanoutUrl, boundedFanoutVariants[0]));
assert (fanoutTree.hasResident(fanoutUrl, rotatedFanoutVariants[0]));
assert (fanoutTree.hasResident(
    fanoutUrl,
    rotatedFanoutVariants[rotatedFanoutVariants.size() - 1],
));
fanoutTree.removeStaticExpressionTree(fanoutUrl);
let #ok(_) = Forest.commit(fanoutForest) else {
    Runtime.trap("fanout forest deletion commit failed");
};
assert (not fanoutTree.hasResident(fanoutUrl, rotatedFanoutVariants[0]));
assert (not fanoutTree.hasResident(
    fanoutUrl,
    rotatedFanoutVariants[rotatedFanoutVariants.size() - 1],
));

// The batch meter includes the separate body-hash tree and remains owned by
// the outermost batch. Inner publishers cannot reset or publish around it.
let meteredForest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
let metered = Cert.CertifiedHttp(Cert.init(), meteredForest);
metered.beginV2PublicationBatch();
assert (metered.publicationBatchWork() == ?0);
metered.putHash("/app/files/metered.js", routeBodyAHash);
assert (metered.publicationBatchWork() == ?1);
metered.beginV2PublicationBatch();
metered.deleteAssetHash("/app/files/metered.js");
let ?afterHashWork = metered.publicationBatchWork() else {
    Runtime.trap("publication batch meter disappeared");
};
assert (afterHashWork == 2);
metered.apply([#replace_origin_scoped({
    url = "/app/files/metered.js";
    next = [initialFanoutVariants[0]];
})]);
let ?afterPublicWork = metered.publicationBatchWork() else {
    Runtime.trap("publication batch forest work disappeared");
};
assert (afterPublicWork > afterHashWork);
assert (not metered.finishV2PublicationBatch());
assert (metered.publicationBatchWork() == ?afterPublicWork);

let residentTree = Cert.PublicCertificationTree(Cert.init());
residentTree.apply([
    #replace({
        url = "/app/files/service.html";
        prior = [];
        next = [getA];
    }),
    #replace_resident({
        url = "/app/files/service.html";
        prior = [];
        next = [
            residentHtmlVariant,
            residentHtmlAlternative,
            residentWorkerVariant,
        ];
    }),
    #replace_resident({
        url = "/app/files/index.html";
        prior = [];
        next = [installationHtmlVariant];
    }),
]);
assert (
    residentTree.hasResident(
        "/app/files/service.html",
        residentHtmlVariant,
    )
);
assert (residentTree.hasResident(
    "/app/files/service.html",
    residentHtmlAlternative,
));
assert (residentTree.hasResident(
    "/app/files/service.html",
    residentWorkerVariant,
));
assert (residentTree.hasResident(
    "/app/files/index.html",
    installationHtmlVariant,
));
// The same URL may retain an ordinary Host-only expression, but no weak
// request hash exists for the nonce Host.
assert (residentTree.has("/app/files/service.html", getA));
assert (not residentTree.has(
    "/app/files/service.html",
    responseVariant("GET", residentHost, 200, routeBodyAHash),
));
// A static-origin reset drops every stale Host/destination/query owner below
// both resident expression hashes without disturbing the ordinary Host-only
// response at this exact URL or resident responses at another URL.
residentTree.apply([#replace_origin_scoped({
    url = "/app/files/service.html";
    next = [installationHtmlVariant];
})]);
assert (not residentTree.hasResident(
    "/app/files/service.html",
    residentHtmlVariant,
));
assert (not residentTree.hasResident(
    "/app/files/service.html",
    residentWorkerVariant,
));
assert (residentTree.hasResident(
    "/app/files/service.html",
    installationHtmlVariant,
));
assert (residentTree.has("/app/files/service.html", getA));
assert (residentTree.hasResident(
    "/app/files/index.html",
    installationHtmlVariant,
));
residentTree.apply([#remove_resident({
    url = "/app/files/index.html";
    requests = [installationHtmlOwner];
})]);
assert (not residentTree.hasResident(
    "/app/files/index.html",
    installationHtmlVariant,
));

let persistentResidentForest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
let persistentResidentTree =
    Cert.PersistentCertificationTree(persistentResidentForest, func() {});
persistentResidentTree.apply([
    #replace({
        url = "/app/files/service.html";
        prior = [];
        next = [getA];
    }),
    #replace_resident({
        url = "/app/files/service.html";
        prior = [];
        next = [
            residentHtmlVariant,
            residentHtmlAlternative,
            residentWorkerVariant,
        ];
    }),
    #replace_resident({
        url = "/app/files/index.html";
        prior = [];
        next = [installationHtmlVariant];
    }),
]);
let residentForestCommit = Forest.commit(persistentResidentForest);
let #ok(_) = residentForestCommit else {
    Runtime.trap(
        "resident forest commit failed: " # debug_show(residentForestCommit)
    );
};
assert (persistentResidentTree.has(
    "/app/files/service.html",
    getA,
));
assert (persistentResidentTree.hasResident(
    "/app/files/service.html",
    residentHtmlVariant,
));
assert (persistentResidentTree.hasResident(
    "/app/files/service.html",
    residentHtmlAlternative,
));
assert (persistentResidentTree.hasResident(
    "/app/files/service.html",
    residentWorkerVariant,
));
assert (persistentResidentTree.hasResident(
    "/app/files/index.html",
    installationHtmlVariant,
));
assert (not persistentResidentTree.has(
    "/app/files/service.html",
    responseVariant("GET", residentHost, 200, routeBodyAHash),
));
persistentResidentTree.apply([#replace_origin_scoped({
    url = "/app/files/service.html";
    next = [installationHtmlVariant];
})]);
let #ok(_) = Forest.commit(persistentResidentForest) else {
    Runtime.trap("resident forest origin reset commit failed");
};
assert (not persistentResidentTree.hasResident(
    "/app/files/service.html",
    residentHtmlVariant,
));
assert (not persistentResidentTree.hasResident(
    "/app/files/service.html",
    residentWorkerVariant,
));
assert (persistentResidentTree.hasResident(
    "/app/files/service.html",
    installationHtmlVariant,
));
assert (persistentResidentTree.has(
    "/app/files/service.html",
    getA,
));
assert (persistentResidentTree.hasResident(
    "/app/files/index.html",
    installationHtmlVariant,
));
persistentResidentTree.apply([#remove_resident({
    url = "/app/files/index.html";
    requests = [installationHtmlOwner];
})]);
let #ok(_) = Forest.commit(persistentResidentForest) else {
    Runtime.trap("installation HTML forest removal commit failed");
};
assert (not persistentResidentTree.hasResident(
    "/app/files/index.html",
    installationHtmlVariant,
));

// ---------------------------------------------------------------------------
// Certified Assets closed policies and request-owner response sets.

let hostBoundExpressionHash = Blob.fromArray([
    0xba, 0x88, 0x8b, 0xe3, 0xcc, 0xc9, 0x5f, 0x1a,
    0x80, 0x77, 0xa8, 0x46, 0xc0, 0xe5, 0x73, 0xb5,
    0xc0, 0x82, 0x7c, 0xe9, 0x16, 0x20, 0x0b, 0x51,
    0x9a, 0x11, 0x6b, 0xcb, 0x33, 0xd9, 0xf6, 0x1e,
]);
let portableExpressionHash = Blob.fromArray([
    0x64, 0x9f, 0x6e, 0x7b, 0x0c, 0x87, 0xa7, 0x70,
    0x11, 0x34, 0x5e, 0x93, 0x60, 0x29, 0x05, 0x57,
    0xd9, 0x55, 0x7c, 0x03, 0xcd, 0xe1, 0xd8, 0xcc,
    0xcf, 0x4c, 0xf4, 0xd9, 0x13, 0xd2, 0xaf, 0x37,
]);
assert (
    V2.certificationExpressionHash(#exact(hostA)) ==
    hostBoundExpressionHash
);
assert (
    V2.certificationExpressionHash(#excluded) ==
    portableExpressionHash
);
assert (
    V2.HOST_BOUND_CERTIFICATION_EXPRESSION ==
    Cert.HOST_BOUND_CERTIFICATION_EXPRESSION
);
assert (
    V2.PORTABLE_CERTIFICATION_EXPRESSION ==
    Cert.PORTABLE_CERTIFICATION_EXPRESSION
);

assert (V2.certificateVersionDecision(null) == #reject);
assert (V2.certificateVersionDecision(?0) == #reject);
assert (V2.certificateVersionDecision(?1) == #reject);
assert (V2.certificateVersionDecision(?2) == #v2);
assert (V2.certificateVersionDecision(?99) == #v2);
assert (not V2.supportsCertificateVersion(null));
assert (not V2.supportsCertificateVersion(?1));
assert (V2.supportsCertificateVersion(?2));

// The persisted policy fingerprint must name every fixed header byte emitted
// by the closed policies. Keep these checks next to the render assertions
// below so a policy-table-only or renderer-only edit cannot silently drift.
let responsePolicyTableV1 = V2.responsePolicyTableCanonicalV1();
assert (
    Text.contains(
        responsePolicyTableV1,
        #text(
            "Permissions-Policy:camera=(), geolocation=(), microphone=()," #
            "Content-Security-Policy:sandbox; default-src 'none'; " #
            "frame-ancestors 'none',Accept-Ranges:bytes"
        ),
    )
);
assert (
    Text.contains(
        responsePolicyTableV1,
        #text(
            "Cross-Origin-Resource-Policy:cross-origin," #
            "X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer," #
            "Permissions-Policy:camera=(), geolocation=(), microphone=()," #
            "Content-Security-Policy:sandbox; default-src 'none'; " #
            "frame-ancestors 'none'"
        ),
    )
);

assert (V2.validAttachmentFilename("a"));
assert (V2.validAttachmentFilename("safe-name_1.bin"));
assert (not V2.validAttachmentFilename(""));
assert (not V2.validAttachmentFilename("."));
assert (not V2.validAttachmentFilename(".."));
assert (not V2.validAttachmentFilename("quote\".bin"));
assert (not V2.validAttachmentFilename("path/name"));
assert (not V2.validAttachmentFilename("percent%20name"));
assert (not V2.validAttachmentFilename("unicode-\u{2603}"));
assert (
    V2.attachmentDisposition("safe-name_1.bin") ==
    ?"attachment; filename=\"safe-name_1.bin\""
);
assert (V2.attachmentDisposition("bad\r\nSet-Cookie") == null);

func header(
    headers : [V2.HeaderField],
    expectedName : Text,
) : ?Text {
    for ((name, value) in headers.vals()) {
        if (Text.toLower(name) == Text.toLower(expectedName)) return ?value;
    };
    null;
};

let publicationPath =
    "/app/test/_route/public/0123456789abcdef/note.txt";
let publicationTag = Cert.hashChunks(["complete publication identity"]);
let publicationSingle : [V2.OwnerResponses] = switch (
    V2.publicationOwnerResponses({
    canonical_path = publicationPath;
    host = hostA;
    presentation = #inline_text;
    content_tag = publicationTag;
    blocks = [{
        length = routeBodyA.size();
        body_hash = routeBodyAHash;
    }];
})) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("publication render failed");
};
assert (publicationSingle.size() == 2);
assert (publicationSingle[0].owner.method == "GET");
assert (publicationSingle[0].owner.host_mode == #exact(hostA));
assert (publicationSingle[0].owner.expression_kind == #exact);
assert (publicationSingle[0].response_mode == #single);
assert (publicationSingle[0].responses.size() == 1);
assert (publicationSingle[0].responses[0].status_code == 200);
assert (publicationSingle[0].responses[0].body_hash == routeBodyAHash);
assert (
    header(
        publicationSingle[0].responses[0].response_headers,
        "Content-Type",
    ) ==
    ?"text/plain; charset=utf-8"
);
assert (
    header(
        publicationSingle[0].responses[0].response_headers,
        "Content-Length",
    ) ==
    ?Nat.toText(routeBodyA.size())
);
assert (
    header(
        publicationSingle[0].responses[0].response_headers,
        "Content-Range",
    ) ==
    null
);
assert (
    header(
        publicationSingle[0].responses[0].response_headers,
        "Cache-Control",
    ) ==
    ?"no-store"
);
assert (
    publicationSingle[0].responses[0].response_headers == [
        ("Content-Type", "text/plain; charset=utf-8"),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        ("Permissions-Policy", "camera=(), geolocation=(), microphone=()"),
        (
            "Content-Security-Policy",
            "sandbox; default-src 'none'; frame-ancestors 'none'",
        ),
        ("Accept-Ranges", "bytes"),
        ("ETag", "\"" # V2.lowercaseHex(publicationTag) # "\""),
        ("Content-Length", Nat.toText(routeBodyA.size())),
        (
            "IC-CertificateExpression",
            V2.HOST_BOUND_CERTIFICATION_EXPRESSION,
        ),
    ]
);
assert (publicationSingle[1].owner.method == "HEAD");
assert (publicationSingle[1].response_mode == #single);
assert (publicationSingle[1].responses.size() == 1);
assert (publicationSingle[1].responses[0].body_hash == V2.emptyBodyHash());
assert (
    header(
        publicationSingle[1].responses[0].response_headers,
        "Content-Length",
    ) ==
    ?Nat.toText(routeBodyA.size())
);

// URL-scoped resident resets are expression-specific: a Certified Assets V2
// request branch at the same exact URL survives both replacement and removal.
let retainedV2Set = publicationSingle[0];
let retainedV2Response = retainedV2Set.responses[0];
let originScopedV2Tree = Cert.PublicCertificationTree(Cert.init());
assert (originScopedV2Tree.applyV2([#replace({
    prior = [];
    next = [retainedV2Set];
})]));
originScopedV2Tree.apply([#replace_origin_scoped({
    url = publicationPath;
    next = [residentHtmlVariant, installationHtmlVariant];
})]);
assert (originScopedV2Tree.hasV2(
    retainedV2Set.owner,
    retainedV2Response,
));
originScopedV2Tree.apply([#replace_origin_scoped({
    url = publicationPath;
    next = [];
})]);
assert (not originScopedV2Tree.hasResident(
    publicationPath,
    residentHtmlVariant,
));
assert (not originScopedV2Tree.hasResident(
    publicationPath,
    installationHtmlVariant,
));
assert (originScopedV2Tree.hasV2(
    retainedV2Set.owner,
    retainedV2Response,
));

let originScopedV2Forest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
let originScopedPersistentV2Tree =
    Cert.PersistentCertificationTree(originScopedV2Forest, func() {});
originScopedPersistentV2Tree.applyV2([#replace({
    prior = [];
    next = [retainedV2Set];
})]);
originScopedPersistentV2Tree.apply([#replace_origin_scoped({
    url = publicationPath;
    next = [residentHtmlVariant, installationHtmlVariant];
})]);
originScopedPersistentV2Tree.apply([#replace_origin_scoped({
    url = publicationPath;
    next = [];
})]);
let #ok(_) = Forest.commit(originScopedV2Forest) else {
    Runtime.trap("origin-scoped V2 retention commit failed");
};
assert (originScopedPersistentV2Tree.hasV2Leaf(
    Cert.v2LeafKey(retainedV2Set.owner, retainedV2Response)
));
assert (not originScopedPersistentV2Tree.hasResident(
    publicationPath,
    residentHtmlVariant,
));
assert (not originScopedPersistentV2Tree.hasResident(
    publicationPath,
    installationHtmlVariant,
));

let chunkA : Blob = "aaa";
let chunkB : Blob = "bbbbb";
let chunkC : Blob = "ccccccc";
let publicationMulti : [V2.OwnerResponses] = switch (
    V2.publicationOwnerResponses({
    canonical_path =
        "/app/test/_route/public/abcdef0123456789/archive.bin";
    host = hostA;
    presentation = #attachment({ filename = "archive.bin" });
    content_tag = publicationTag;
    blocks = [
        { length = chunkA.size(); body_hash = Cert.hashChunks([chunkA]) },
        { length = chunkB.size(); body_hash = Cert.hashChunks([chunkB]) },
        { length = chunkC.size(); body_hash = Cert.hashChunks([chunkC]) },
    ];
})) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("publication range render failed");
};
let multiGet = publicationMulti[0];
assert (multiGet.response_mode == #range_chunks);
assert (V2.validPublicationRangeResponseSet(multiGet));
assert (multiGet.responses.size() == 3);
assert (multiGet.responses[0].status_code == 206);
assert (multiGet.responses[1].status_code == 206);
assert (multiGet.responses[2].status_code == 206);
assert (
    header(multiGet.responses[0].response_headers, "Content-Range") ==
    ?"bytes 0-2/15"
);
assert (
    header(multiGet.responses[1].response_headers, "Content-Range") ==
    ?"bytes 3-7/15"
);
assert (
    header(multiGet.responses[2].response_headers, "Content-Range") ==
    ?"bytes 8-14/15"
);
assert (
    header(multiGet.responses[0].response_headers, "Content-Disposition") ==
    ?"attachment; filename=\"archive.bin\""
);
assert (
    header(
        publicationMulti[1].responses[0].response_headers,
        "Content-Length",
    ) ==
    ?"15"
);
assert (
    header(
        publicationMulti[1].responses[0].response_headers,
        "Content-Range",
    ) ==
    null
);
assert (not V2.validPublicationRangeResponseSet({
    owner = multiGet.owner;
    response_mode = #range_chunks;
    responses = [multiGet.responses[0], multiGet.responses[1]];
}));
assert (not V2.validPublicationRangeResponseSet({
    owner = multiGet.owner;
    response_mode = #range_chunks;
    responses = [
        multiGet.responses[1],
        multiGet.responses[0],
        multiGet.responses[2],
    ];
}));
let publicationSelectionInput : V2.PublicationObject = {
    canonical_path =
        "/app/test/_route/public/abcdef0123456789/archive.bin";
    host = hostA;
    presentation = #attachment({ filename = "archive.bin" });
    content_tag = publicationTag;
    blocks = [
        { length = chunkA.size(); body_hash = Cert.hashChunks([chunkA]) },
        { length = chunkB.size(); body_hash = Cert.hashChunks([chunkB]) },
        { length = chunkC.size(); body_hash = Cert.hashChunks([chunkC]) },
    ];
};
let selectedInterior = switch (V2.selectPublicationResponse(
    publicationSelectionInput,
    #get,
    [("Range", "bytes=6-")],
)) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("publication selection failed");
};
assert (selectedInterior.block_index == ?1);
assert (selectedInterior.response == multiGet.responses[1]);
let selectedHead = switch (V2.selectPublicationResponse(
    publicationSelectionInput,
    #head,
    [("Range", "bytes=8-")],
)) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("publication HEAD selection failed");
};
assert (selectedHead.block_index == null);
assert (selectedHead.response == publicationMulti[1].responses[0]);
assert (
    V2.selectPublicationResponse(
        publicationSelectionInput,
        #get,
        [("Range", "bytes=15-")],
    ) == #err(#invalid_range)
);
assert (
    V2.selectPublicationResponse(
        publicationSelectionInput,
        #head,
        [("Range", "bytes=4-garbage")],
    ) == #err(#invalid_range)
);

// The publication policy accepts and reassembles the full 64 MiB,
// 36-block geometry without widening the per-query body ceiling.
let maximumPublicationBlocks = Array.tabulate<V2.PublicationBlock>(
    V2.PUBLICATION_BLOCKS_MAX_V2,
    func(index) {
        {
            length = if (
                index + 1 == V2.PUBLICATION_BLOCKS_MAX_V2
            ) {
                959_424;
            } else {
                V2.PUBLICATION_BLOCK_BYTES_MAX_V2;
            };
            body_hash = Cert.hashChunks([
                Text.encodeUtf8(Nat.toText(index))
            ]);
        };
    },
);
let maximumPublicationResponses = switch (
    V2.publicationOwnerResponses({
    canonical_path =
        "/app/test/_route/public/abcdef0123456789/maximum.bin";
    host = hostA;
    presentation = #attachment({ filename = "maximum.bin" });
    content_tag = publicationTag;
    blocks = maximumPublicationBlocks;
})) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("maximum publication render failed");
};
assert (
    maximumPublicationResponses[0].responses.size() ==
    V2.PUBLICATION_BLOCKS_MAX_V2
);
assert (
    V2.validPublicationRangeResponseSet(maximumPublicationResponses[0])
);
assert (
    header(
        maximumPublicationResponses[0].responses[
            V2.PUBLICATION_BLOCKS_MAX_V2 - 1
        ].response_headers,
        "Content-Range",
    ) == ?"bytes 66149440-67108863/67108864"
);
assert (
    header(
        maximumPublicationResponses[1].responses[0].response_headers,
        "Content-Length",
    ) == ?"67108864"
);
let maximumPublicationLast = switch (V2.selectPublicationResponse(
    {
        canonical_path =
            "/app/test/_route/public/abcdef0123456789/maximum.bin";
        host = hostA;
        presentation = #attachment({ filename = "maximum.bin" });
        content_tag = publicationTag;
        blocks = maximumPublicationBlocks;
    },
    #get,
    [("Range", "bytes=66149440-")],
)) {
    case (#ok(value)) value;
    case (#err(_)) {
        Runtime.trap("maximum publication last-block selection failed");
    };
};
assert (maximumPublicationLast.block_index == ?35);
assert (
    maximumPublicationLast.response ==
    maximumPublicationResponses[0].responses[35]
);
assert (
    V2.publicationOwnerResponses({
        canonical_path =
            "/app/test/_route/public/abcdef0123456789/too-many.bin";
        host = hostA;
        presentation = #attachment({ filename = "too-many.bin" });
        content_tag = publicationTag;
        blocks = Array.repeat<V2.PublicationBlock>(
            {
                length = 1;
                body_hash = routeBodyAHash;
            },
            V2.PUBLICATION_BLOCKS_MAX_V2 + 1,
        );
    }) == #err(#invalid_geometry)
);

// A request owner is reset once and retains all publication block hashes.
let v2Tree = Cert.PublicCertificationTree(Cert.init());
assert (v2Tree.applyV2([#replace({ prior = []; next = [multiGet] })]));
assert (v2Tree.hasV2(multiGet.owner, multiGet.responses[0]));
assert (v2Tree.hasV2(multiGet.owner, multiGet.responses[1]));
assert (v2Tree.hasV2(multiGet.owner, multiGet.responses[2]));
let middleLeaf = Cert.v2LeafKey(multiGet.owner, multiGet.responses[1]);
assert (middleLeaf.expression_hash == hostBoundExpressionHash);
assert (middleLeaf.owner.method == "GET");
assert (middleLeaf.owner.canonical_path == multiGet.owner.canonical_path);
assert (middleLeaf.owner.host_mode == #exact(hostA));
assert (v2Tree.hasV2Leaf(middleLeaf));
let proofOnly = Cert.CertifiedHttp(
    Cert.init(),
    Forest.init(
        Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
        Allocator.layoutFingerprint(),
    ),
);
let matchingEmptyRequest : Cert.CertifiedRequest = {
    method = "GET";
    headers = [("Host", hostA)];
    body = Blob.fromArray([]);
};
assert (
    proofOnly.certificationHeaderV2FromLeaf(
        "/bad//ambiguous",
        matchingEmptyRequest,
        middleLeaf,
    ) == null
);
assert (
    proofOnly.certificationHeaderV2FromLeaf(
        middleLeaf.owner.canonical_path,
        matchingEmptyRequest,
        {
            owner = middleLeaf.owner;
            expression_hash = portableExpressionHash;
            request_hash = middleLeaf.request_hash;
            response_hash = middleLeaf.response_hash;
        },
    ) == null
);

// Replacing that owner with one response removes every old alternative.
assert (v2Tree.applyV2([#replace({
    prior = Array.map<V2.CertifiedResponse, V2.V2LeafKey>(
        multiGet.responses,
        func(response) { Cert.v2LeafKey(multiGet.owner, response) },
    );
    next = [publicationSingle[0]];
})]));
assert (not v2Tree.hasV2(multiGet.owner, multiGet.responses[0]));
assert (not v2Tree.hasV2(multiGet.owner, multiGet.responses[1]));
assert (not v2Tree.hasV2(multiGet.owner, multiGet.responses[2]));
assert (
    v2Tree.hasV2(
        publicationSingle[0].owner,
        publicationSingle[0].responses[0],
    )
);

let immutableBody : Blob = "DIDL\00\01";
let immutableHash = Cert.hashChunks([immutableBody]);
let immutableBlob : V2.OwnerResponses = switch (
    V2.portableBlobOwnerResponses({
    canonical_path =
        "/objects/immutable/sha256/0123456789abcdef";
    policy = #immutable;
    body_hash = immutableHash;
    body_length = immutableBody.size();
})) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("immutable blob render failed");
};
assert (immutableBlob.owner.method == "GET");
assert (immutableBlob.owner.host_mode == #excluded);
assert (immutableBlob.response_mode == #single);
assert (immutableBlob.responses.size() == 1);
assert (immutableBlob.responses[0].status_code == 200);
assert (
    header(immutableBlob.responses[0].response_headers, "Content-Type") ==
    ?"application/octet-stream"
);
assert (
    header(immutableBlob.responses[0].response_headers, "Cache-Control") ==
    ?"public, max-age=31536000, immutable"
);
assert (
    header(
        immutableBlob.responses[0].response_headers,
        "Access-Control-Allow-Origin",
    ) ==
    ?"*"
);
assert (
    header(
        immutableBlob.responses[0].response_headers,
        "Access-Control-Allow-Credentials",
    ) == null
);
assert (
    header(immutableBlob.responses[0].response_headers, "Content-Digest") ==
    ?("sha-256=:" # Base64.encode(immutableHash) # ":")
);
assert (
    immutableBlob.responses[0].response_headers == [
        ("Content-Type", "application/octet-stream"),
        ("Content-Length", Nat.toText(immutableBody.size())),
        ("Content-Digest", "sha-256=:" # Base64.encode(immutableHash) # ":"),
        ("ETag", "\"" # V2.lowercaseHex(immutableHash) # "\""),
        ("Cache-Control", "public, max-age=31536000, immutable"),
        ("Access-Control-Allow-Origin", "*"),
        (
            "Access-Control-Expose-Headers",
            "IC-Certificate, IC-CertificateExpression, Content-Length, " #
            "Content-Digest, ETag",
        ),
        ("Cross-Origin-Resource-Policy", "cross-origin"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        ("Permissions-Policy", "camera=(), geolocation=(), microphone=()"),
        (
            "Content-Security-Policy",
            "sandbox; default-src 'none'; frame-ancestors 'none'",
        ),
        (
            "IC-CertificateExpression",
            V2.PORTABLE_CERTIFICATION_EXPRESSION,
        ),
    ]
);
assert (
    v2Tree.applyV2([#replace({ prior = []; next = [immutableBlob] })])
);
assert (
    v2Tree.hasV2(immutableBlob.owner, immutableBlob.responses[0])
);
assert (not v2Tree.applyV2([#replace({
    prior = [Cert.v2LeafKey(
        immutableBlob.owner,
        immutableBlob.responses[0],
    )];
    next = [immutableBlob];
})]));

let hostBoundAbsence : [V2.OwnerResponses] = switch (
    V2.absenceOwnerResponses({
    base_path = "/app/test/_route/public";
    authority = #host_bound({ host = hostA });
})) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("host-bound absence render failed");
};
assert (hostBoundAbsence.size() == 2);
assert (hostBoundAbsence[0].owner.expression_kind == #wildcard);
assert (hostBoundAbsence[0].owner.host_mode == #exact(hostA));
assert (hostBoundAbsence[0].responses[0].status_code == 404);
assert (
    hostBoundAbsence[0].responses[0].body_hash == V2.emptyBodyHash()
);
assert (
    header(
        hostBoundAbsence[0].responses[0].response_headers,
        "Access-Control-Allow-Origin",
    ) == null
);
assert (
    hostBoundAbsence[0].responses[0].response_headers == [
        ("Content-Type", "text/plain; charset=utf-8"),
        ("Content-Length", "0"),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        ("Permissions-Policy", "camera=(), geolocation=(), microphone=()"),
        (
            "Content-Security-Policy",
            "sandbox; default-src 'none'; frame-ancestors 'none'",
        ),
        (
            "IC-CertificateExpression",
            V2.HOST_BOUND_CERTIFICATION_EXPRESSION,
        ),
    ]
);
assert (
    Cert.wildcardExpressionTextPath("/app/test/_route/public") == [
        "http_expr",
        "app",
        "test",
        "_route",
        "public",
        "<*>",
    ]
);
let (publicationDetached, detachedChanged) = v2Tree.detachV2(
    "/app/test/_route/public",
    hostBoundAbsence,
);
assert (detachedChanged);
assert (
    not v2Tree.hasV2(
        publicationSingle[0].owner,
        publicationSingle[0].responses[0],
    )
);
assert (
    v2Tree.hasV2(
        hostBoundAbsence[0].owner,
        hostBoundAbsence[0].responses[0],
    )
);
assert (
    v2Tree.hasV2(
        hostBoundAbsence[1].owner,
        hostBoundAbsence[1].responses[0],
    )
);
// Detaching one authority cannot disturb a disjoint certified mount.
assert (
    v2Tree.hasV2(immutableBlob.owner, immutableBlob.responses[0])
);
assert (v2Tree.attachV2(publicationDetached));
assert (
    v2Tree.hasV2(
        publicationSingle[0].owner,
        publicationSingle[0].responses[0],
    )
);
assert (
    not v2Tree.hasV2(
        hostBoundAbsence[0].owner,
        hostBoundAbsence[0].responses[0],
    )
);
assert (
    v2Tree.hasV2(immutableBlob.owner, immutableBlob.responses[0])
);

let portableAbsence : [V2.OwnerResponses] = switch (
    V2.absenceOwnerResponses({
    base_path = "/objects/immutable";
    authority = #portable;
})) {
    case (#ok(value)) value;
    case (#err(_)) Runtime.trap("portable absence render failed");
};
assert (portableAbsence.size() == 1);
assert (portableAbsence[0].owner.host_mode == #excluded);
assert (
    header(
        portableAbsence[0].responses[0].response_headers,
        "Access-Control-Allow-Origin",
    ) == ?"*"
);
assert (
    header(
        portableAbsence[0].responses[0].response_headers,
        "Access-Control-Expose-Headers",
    ) == ?"IC-Certificate, IC-CertificateExpression, Content-Length"
);
assert (
    portableAbsence[0].responses[0].response_headers == [
        ("Content-Type", "application/octet-stream"),
        ("Content-Length", "0"),
        ("Cache-Control", "no-store"),
        ("Access-Control-Allow-Origin", "*"),
        (
            "Access-Control-Expose-Headers",
            "IC-Certificate, IC-CertificateExpression, Content-Length",
        ),
        ("Cross-Origin-Resource-Policy", "cross-origin"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        ("Permissions-Policy", "camera=(), geolocation=(), microphone=()"),
        (
            "Content-Security-Policy",
            "sandbox; default-src 'none'; frame-ancestors 'none'",
        ),
        (
            "IC-CertificateExpression",
            V2.PORTABLE_CERTIFICATION_EXPRESSION,
        ),
    ]
);

// Range selection is case-insensitive by header name, but pinned to the
// upstream lowercase bytes-unit parser and a single Wasm32 start.
assert (V2.parseRange([]) == #absent);
assert (V2.parseRange([("range", "bytes=3-")]) == #valid(3));
assert (V2.parseRange([("RaNgE", "  bytes=7-999  ")]) == #valid(7));
assert (V2.parseRange([("Range", "\u{3000}bytes=+3-\u{3000}")]) == #valid(3));
assert (V2.parseRange([("Range", "bytes= +4 -")]) == #valid(4));
assert (V2.parseRange([("Range", "bytes=+-")]) == #unsupported);
assert (V2.parseRange([("Range", "bytes=4-garbage")]) == #unsupported);
assert (V2.parseRange([("Range", "bytes=4-3")]) == #unsupported);
assert (V2.parseRange([("Range", "bytes=4-5-6")]) == #unsupported);
assert (
    V2.parseRange([("Range", "bytes=4-4294967296")]) ==
    #unsupported
);
assert (V2.parseRange([("Range", "Bytes=4-")]) == #unsupported);
assert (V2.parseRange([("Range", "bytes=-4")]) == #unsupported);
assert (V2.parseRange([("Range", "bytes=0-1,5-6")]) == #unsupported);
assert (V2.parseRange([("Range", "bytes=abc-")]) == #unsupported);
assert (
    V2.parseRange([("Range", "bytes=4294967296-")]) ==
    #unsupported
);
assert (
    V2.parseRange([
        ("Range", "bytes=3-"),
        ("range", "bytes=8-"),
    ]) == #unsupported
);
assert (V2.selectPublicationBlock([], [3, 5, 7]) == ?0);
assert (
    V2.selectPublicationBlock([("Range", "bytes=0-")], [3, 5, 7]) == ?0
);
assert (
    V2.selectPublicationBlock([("Range", "bytes=2-")], [3, 5, 7]) == ?0
);
assert (
    V2.selectPublicationBlock([("Range", "bytes=3-")], [3, 5, 7]) == ?1
);
assert (
    V2.selectPublicationBlock([("Range", "bytes=6-")], [3, 5, 7]) == ?1
);
assert (
    V2.selectPublicationBlock([("Range", "bytes=8-")], [3, 5, 7]) == ?2
);
assert (
    V2.selectPublicationBlock([("Range", "bytes=99-")], [3, 5, 7]) == null
);
assert (
    V2.selectPublicationBlock([("Range", "bytes=4-garbage")], [15]) ==
    null
);
assert (
    V2.selectPublicationBlock([("Range", "bytes=-4")], [15]) == null
);
assert (
    V2.selectPublicationBlock(
        [("Range", "bytes=0-1,5-6")],
        [15],
    ) == null
);

assert (V2.CERTIFIED_HTTP_QUERY_REPLY_MAX_V2 == 3_145_728);
assert (V2.CERTIFIED_HTTP_RESPONSE_SAFETY_MARGIN_V2 == 65_536);
assert (V2.PUBLICATION_BLOCK_BYTES_MAX_V2 == 1_889_984);
assert (V2.PUBLICATION_OBJECT_BYTES_MAX_V2 == 67_108_864);
assert (V2.PUBLICATION_BLOCKS_MAX_V2 == 36);
assert (V2.PORTABLE_BLOB_BODY_BYTES_MAX_V2 == 1_048_576);
