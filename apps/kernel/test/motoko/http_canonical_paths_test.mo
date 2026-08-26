import CertTree "mo:ic-certification/CertTree";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Cert "../../backend/certified_http";
import V2 "../../backend/certified_http_v2";
import Allocator "../../backend/certified_assets/Allocator";
import Forest "../../backend/certified_assets/AuthenticatedForest";

let emptyBody = Blob.fromArray([]);
let bodyHash = Cert.hashChunks([Text.encodeUtf8("canonical route")]);
let host = "a--aaaaa-aa.icp0.io";
let responseHeaders : [Cert.HeaderField] = [
    ("Content-Type", "text/plain"),
    (
        Cert.CERTIFICATE_EXPRESSION_HEADER,
        Cert.HOST_BOUND_CERTIFICATION_EXPRESSION,
    ),
];
let response : Cert.ResponseCertificationVariant = {
    method = "GET";
    host;
    status_code = 200;
    body_hash = bodyHash;
    response_headers = responseHeaders;
};
let canonicalPath = "/api/items";
let trailingSlashPath = canonicalPath # "/";
let aliases = [
    "api/items",
    "/api//items",
    "/api/./items",
    "/api/../api/items",
    "/api/%2f/items",
    "/api\\items",
    "/api/items?query",
    "/api/items#fragment",
];

assert (V2.validCanonicalPath(canonicalPath));
assert (V2.validCanonicalPath(trailingSlashPath));
assert (Cert.validCanonicalPath(canonicalPath));
assert (Cert.validCanonicalPath(trailingSlashPath));
let ?maximumSegment = Text.decodeUtf8(Blob.fromArray(
    Array.repeat<Nat8>(0x61, V2.CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2),
)) else Runtime.trap("maximum canonical segment is not UTF-8");
let ?oversizedSegment = Text.decodeUtf8(Blob.fromArray(
    Array.repeat<Nat8>(
        0x61,
        V2.CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2 + 1,
    ),
)) else Runtime.trap("oversized canonical segment is not UTF-8");
assert (V2.validCanonicalPath("/" # maximumSegment));
assert (not V2.validCanonicalPath("/" # oversizedSegment));
assert (Cert.validCanonicalPath("/" # maximumSegment));
assert (not Cert.validCanonicalPath("/" # oversizedSegment));
for (alias in aliases.vals()) {
    assert (not V2.validCanonicalPath(alias));
    assert (not Cert.validCanonicalPath(alias));
    assert (not Cert.validLegacyMutationPaths([#replace({
        url = alias;
        prior = [];
        next = [response];
    })]));
    assert (not Cert.validLegacyMutationPaths([#remove({
        url = alias;
        requests = [{ method = "GET"; host }];
    })]));
};

// The compatibility tree and production tree use the same admission guard.
// Invalid inspection inputs fail closed instead of segmenting to a committed
// canonical leaf. A terminal slash remains a valid, distinct exact route.
let compatibilityTree = Cert.PublicCertificationTree(Cert.init());
compatibilityTree.apply([
    #replace({ url = canonicalPath; prior = []; next = [response] }),
    #replace({ url = trailingSlashPath; prior = []; next = [response] }),
]);
assert (compatibilityTree.has(canonicalPath, response));
assert (compatibilityTree.has(trailingSlashPath, response));
for (alias in aliases.vals()) {
    assert (not compatibilityTree.has(alias, response));
};

let residentHost =
    "i0123456789abcdef01234567--aaaaa-aa.icp0.io";
let residentKind : Cert.ResidentRequestKind = #installation_html_v1;
let residentOwner : Cert.ResidentRequestOwner = {
    method = "GET";
    host = residentHost;
    kind = residentKind;
};
let residentHeaders : [Cert.HeaderField] = [
    ("Content-Type", "text/html; charset=utf-8"),
    (
        Cert.CERTIFICATE_EXPRESSION_HEADER,
        Cert.RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION,
    ),
];
let residentResponse : Cert.ResidentResponseVariant = {
    method = "GET";
    host = residentHost;
    kind = residentKind;
    status_code = 200;
    body_hash = bodyHash;
    response_headers = residentHeaders;
};
let residentPath = "/app/files/index.html";
let residentAlias = "/app//files/index.html";
assert (not Cert.validLegacyMutationPaths([#replace_resident({
    url = residentAlias;
    prior = [];
    next = [residentResponse];
})]));
assert (not Cert.validLegacyMutationPaths([#replace_origin_scoped({
    url = residentAlias;
    next = [residentResponse];
})]));
assert (not Cert.validLegacyMutationPaths([#remove_resident({
    url = residentAlias;
    requests = [residentOwner];
})]));

let forest = Forest.init(
    Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
    Allocator.layoutFingerprint(),
);
let productionTree = Cert.PersistentCertificationTree(forest, func() {});
productionTree.apply([
    #replace({ url = canonicalPath; prior = []; next = [response] }),
    #replace({ url = trailingSlashPath; prior = []; next = [response] }),
    #replace_resident({
        url = residentPath;
        prior = [];
        next = [residentResponse];
    }),
]);
let #ok(_) = Forest.commit(forest) else {
    Runtime.trap("canonical-path forest commit failed");
};
assert (productionTree.has(canonicalPath, response));
assert (productionTree.has(trailingSlashPath, response));
assert (productionTree.hasResident(residentPath, residentResponse));
for (alias in aliases.vals()) {
    assert (not productionTree.has(alias, response));
};
assert (not productionTree.hasResident(residentAlias, residentResponse));

// These doubled-slash proof inputs segment to the committed canonical leaves
// without the entry checks. Reject them before witness/certificate creation.
let proof = Cert.CertifiedHttp(Cert.init(), forest);
assert (proof.certificationHeaderForResponse(
    "/api//items",
    {
        method = "GET";
        headers = [("Host", host)];
        body = emptyBody;
    },
    200,
    responseHeaders,
    bodyHash,
) == null);
assert (proof.residentCertificationHeader(
    residentAlias,
    residentAlias,
    {
        method = "GET";
        headers = [
            ("Host", residentHost),
            ("Sec-Fetch-Dest", "iframe"),
        ];
        body = emptyBody;
    },
    residentHeaders,
    bodyHash,
) == null);

// Deleting the valid slash-suffixed route does not touch its sibling.
productionTree.removeStaticExpressionTree(trailingSlashPath);
let #ok(_) = Forest.commit(forest) else {
    Runtime.trap("canonical-path forest deletion commit failed");
};
assert (productionTree.has(canonicalPath, response));
assert (not productionTree.has(trailingSlashPath, response));

// Restored pre-V26 state can contain a static key that predates canonical
// admission. A doubled slash maps to the same legacy expression-tree path as
// its canonical sibling. Model the cleanup's exact hash-store deletion and
// prove the shared canonical response branch remains present.
let legacyKey = "/api//items";
assert (
    Cert.exactExpressionPath(legacyKey) ==
    Cert.exactExpressionPath(canonicalPath)
);
let legacyStore = Cert.init();
let legacyStoreOps = CertTree.Ops(legacyStore);
let legacyHashPath = [
    Text.encodeUtf8("http_assets"),
    Text.encodeUtf8(legacyKey),
];
legacyStoreOps.put(legacyHashPath, bodyHash);
assert (legacyStoreOps.lookup(legacyHashPath) == ?bodyHash);
legacyStoreOps.delete(legacyHashPath);
assert (legacyStoreOps.lookup(legacyHashPath) == null);
assert (productionTree.has(canonicalPath, response));
