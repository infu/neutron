import CertTree "mo:ic-certification/CertTree";
import ReqData "mo:ic-certification/ReqData";
import MerkleTree "mo:ic-certification/MerkleTree";
import Array "mo:core/Array";
import Base64 "mo:core/Base64";
import Blob "mo:core/Blob";
import CertifiedData "mo:core/CertifiedData";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";
import SHA256 "mo:sha2/Sha256";
import V2 "./certified_http_v2";
import Subtrees "./certified_subtrees";
import AuthenticatedForest "./certified_assets/AuthenticatedForest";
import Allocator "./certified_assets/Allocator";
import CapabilityScope "./capabilities/Scope";
import GatewayAuthority "./http_routes/GatewayAuthority";

module {
  public type CertifiedHttpMemory = CertTree.Store;
  public type HeaderField = (Text, Text);
  public type HostMode = V2.HostMode;
  public type ExpressionKind = V2.ExpressionKind;
  public type V2RequestOwner = V2.V2RequestOwner;
  public type CertifiedResponse = V2.CertifiedResponse;
  public type OwnerResponses = V2.OwnerResponses;
  public type ProofOwner = V2.ProofOwner;
  public type V2LeafKey = V2.V2LeafKey;
  public type V2Mutation = V2.V2Mutation;
  public type DetachedV2 = AuthenticatedForest.Detached;
  public type V2CatalogMatch = AuthenticatedForest.NamedRootMatch;
  public type V2CatalogSnapshot = AuthenticatedForest.CatalogSnapshot;
  public type RetireMountV2 = {
    base_path : Text;
    current_detached : ?DetachedV2;
    absence_leaves : [V2LeafKey];
  };
  public type FunctionalDetachedV2 = {
    base_path : Text;
    subtree : Subtrees.Tree;
  };

  public type CertifiedRequest = {
    method : Text;
    headers : [HeaderField];
    body : Blob;
  };

  public type CertificationVariant = {
    host : Text;
    response_headers : [HeaderField];
  };

  // Dedicated resident origins are browser authority, not merely alternate
  // static hosts. Every certified response on a nonce Host binds the browser
  // Fetch Metadata destination. The sole executable document profile also
  // binds the exact kernel-authored resident query.
  public type ResidentRequestKind = {
    #subresource_v1 : { destination : Text };
    // Installation-owned app HTML uses the same Host + Fetch Metadata CEL as
    // resident subresources, but admits exactly the iframe destination and no
    // authority-bearing query fields.
    #installation_html_v1;
    #html_v1 : { canonical_query : Text };
  };

  public type ResidentRequestOwner = {
    method : Text;
    host : Text;
    kind : ResidentRequestKind;
  };

  public type ResidentResponseVariant = {
    method : Text;
    host : Text;
    kind : ResidentRequestKind;
    status_code : Nat16;
    body_hash : Blob;
    response_headers : [HeaderField];
  };

  // Public app-host routes can share one URL while remaining independent by
  // request hash. Keep the complete request/response tuple on each variant so
  // GET and HEAD, different authorities, statuses, and bodies never rely on an
  // ambient publisher-wide default.
  public type RequestOwner = {
    method : Text;
    host : Text;
  };

  public type ResponseVariant = {
    method : Text;
    host : Text;
    status_code : Nat16;
    body_hash : Blob;
    response_headers : [HeaderField];
  };

  public type ResponseCertificationVariant = ResponseVariant;

  public type CertificationRequestKey = {
    url : Text;
    method : Text;
    host : Text;
  };

  public type Mutation = {
    #replace : {
      url : Text;
      prior : [RequestOwner];
      next : [ResponseVariant];
    };
    #remove : {
      url : Text;
      requests : [RequestOwner];
    };
    #replace_resident : {
      url : Text;
      prior : [ResidentRequestOwner];
      next : [ResidentResponseVariant];
    };
    // Static app assets rotate their browser authority as one URL-scoped
    // unit. This resets only the two resident expression branches; ordinary
    // Host-bound and Certified Assets expressions at the URL remain intact.
    #replace_origin_scoped : {
      url : Text;
      next : [ResidentResponseVariant];
    };
    #remove_resident : {
      url : Text;
      requests : [ResidentRequestOwner];
    };
  };

  // Every producer of an HTTP certification key must share this exact path
  // grammar. Export it through the certification facade so install admission
  // cannot drift from the tree mutation and proof boundaries.
  public func validCanonicalPath(path : Text) : Bool {
    V2.validCanonicalPath(path);
  };

  // Legacy and resident publishers share the same exact-path namespace as V2.
  // Validate every URL as one batch before owner-key construction or routing.
  public func validLegacyMutationPaths(mutations : [Mutation]) : Bool {
    for (mutation in mutations.vals()) {
      let url = switch (mutation) {
        case (#replace(value)) value.url;
        case (#remove(value)) value.url;
        case (#replace_resident(value)) value.url;
        case (#replace_origin_scoped(value)) value.url;
        case (#remove_resident(value)) value.url;
      };
      if (not validCanonicalPath(url)) return false;
    };
    true;
  };

  // Executable web assets and app routes certify Host: their CSP can differ
  // between an ordinary app origin and a persistent background origin, so a
  // response must never be replayable across those authorities.
  public let CERTIFICATE_EXPRESSION_HEADER =
    V2.CERTIFICATE_EXPRESSION_HEADER;
  public let CERTIFICATE_HEADER = V2.CERTIFICATE_HEADER;
  public let HOST_BOUND_CERTIFICATION_EXPRESSION =
    V2.HOST_BOUND_CERTIFICATION_EXPRESSION;

  // Committed package/compiler data has one response policy on every gateway
  // authority. Keep method/body certification, but omit Host so local gateways
  // are not coupled to one listening port.
  public let PORTABLE_CERTIFICATION_EXPRESSION =
    V2.PORTABLE_CERTIFICATION_EXPRESSION;
  public let RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION =
    V2.RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION_V1;
  public let RESIDENT_HTML_CERTIFICATION_EXPRESSION =
    V2.RESIDENT_HTML_CERTIFICATION_EXPRESSION_V1;

  public let NOT_FOUND_EXPRESSION = "default_certification(ValidationArgs{certification:Certification{no_request_certification:Empty{},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";
  // A predecessor response tree is retained outside `http_expr` during the
  // v316 policy cutover. Keeping it attached avoids both an unbounded actor-
  // init disposal and a new durable cleanup schema; no HTTP v2 expression can
  // name this top-level label.
  public let KERNEL_RESPONSE_POLICY_REBUILD_SYSTEM_PATHS_V316 : [Text] = [
    "/system/apps.json",
    "/system/browser-surface-origins.json",
    "/system/runtime-config.json",
    "/system/install-provenance.json",
    "/system/deployment-build-record.json",
  ];
  func kernelResponsePolicyV316MarkerLabel() : Blob {
    Blob.fromArray([255]);
  };
  public func kernelResponsePolicyV316QuarantinePath() : [Blob] {
    AuthenticatedForest.httpExprQuarantinePathV316();
  };
  public func kernelResponsePolicyV316MarkerPath() : [Blob] {
    // Expression-path URL labels are UTF-8. This invalid UTF-8 byte therefore
    // cannot collide with a quarantined predecessor branch.
    Array.concat<Blob>(
      kernelResponsePolicyV316QuarantinePath(),
      [kernelResponsePolicyV316MarkerLabel()],
    );
  };
  // A persistent background replaces the ordinary installation background:
  // Preserve the predecessor ceiling so an upgrade can remove already-certified
  // ServiceWorker and SharedWorker leaves. Current generation emits at most 340
  // JavaScript variants: 330 installation-surface leaves plus 10 persistent
  // origin leaves for the five remaining destinations.
  public let ORIGIN_RESPONSE_VARIANTS_MAX : Nat = 344;

  // One update may nest several certification publishers (install assets,
  // Certified Assets configuration, and lifecycle reconciliation) beneath one
  // outer publication batch. Bound their combined authenticated-tree work so
  // individually bounded subtree removals cannot add up without limit. This is
  // transient transaction state: a trap rolls back every mutation in the
  // canister message, so no stable schema or recovery journal is required.
  public let PUBLICATION_BATCH_WORK_MAX : Nat = 4_194_304;

  public func originResponseVariantCountAllowed(count : Nat) : Bool {
    count <= ORIGIN_RESPONSE_VARIANTS_MAX;
  };

  public func publicationBatchWorkAllowed(work : Nat) : Bool {
    work <= PUBLICATION_BATCH_WORK_MAX;
  };

  // Node visits account for balanced-map traversal. Allocation/reuse and
  // rotations account for writes that are not visits; reclamation is weighted
  // twice because bounded subtree disposal first validates and then destroys
  // every node. Map arena operations are charged by the same rule.
  public func authenticatedForestMutationWork(
    counters : AuthenticatedForest.OperationCounters,
  ) : Nat {
    counters.node_visits +
    counters.rotations +
    counters.nodes_allocated +
    counters.nodes_reused +
    (2 * counters.nodes_reclaimed) +
    counters.maps_allocated +
    counters.maps_reused +
    (2 * counters.maps_reclaimed);
  };
  func emptyBlob() : Blob { Blob.fromArray([]) };
  func httpExpr() : Blob { Text.encodeUtf8("http_expr") };
  func exactLabel() : Blob { Text.encodeUtf8("<$>") };
  func wildcardLabel() : Blob { Text.encodeUtf8("<*>") };

  public func init() : CertifiedHttpMemory {
    CertTree.newStore();
  };

  public func hashChunks(chunks : [Blob]) : Blob {
    let sha = SHA256.Digest(#sha256);
    for (chunk in chunks.vals()) sha.writeBlob(chunk);
    sha.sum();
  };

  public func combinedCertificationRoot(
    assetsRoot : Blob,
    responsesRoot : Blob,
  ) : Blob {
    if (assetsRoot == AuthenticatedForest.emptyHash()) {
      responsesRoot;
    } else if (responsesRoot == AuthenticatedForest.emptyHash()) {
      assetsRoot;
    } else {
      // Top-level labels are ordered: http_assets < http_expr.
      AuthenticatedForest.forkHash(assetsRoot, responsesRoot);
    };
  };

  public func combinedHttpExprWitness(
    assetsRoot : Blob,
    forestWitness : MerkleTree.Witness,
  ) : MerkleTree.Witness {
    if (assetsRoot == AuthenticatedForest.emptyHash()) {
      forestWitness;
    } else {
      #fork(#pruned(assetsRoot), forestWitness);
    };
  };

  func shaPair(left : Blob, right : Blob) : Blob {
    let sha = SHA256.Digest(#sha256);
    sha.writeBlob(left);
    sha.writeBlob(right);
    sha.sum();
  };

  func includesHeader(names : [Text], candidate : Text) : Bool {
    for (name in names.vals()) {
      if (name == candidate) return true;
    };
    false;
  };

  public func requestHashFromBodyHash(
    method : Text,
    headers : [HeaderField],
    bodyHash : Blob,
  ) : Blob {
    assert(bodyHash.size() == 32);
    let selected = List.empty<(Text, ReqData.V)>();
    for ((name, value) in headers.vals()) {
      let lower = Text.toLower(name);
      if (lower == "host") {
        List.add(selected, (lower, #string(value)));
      };
    };
    List.add(selected, (":ic-cert-method", #string(method)));
    shaPair(
      ReqData.hash(List.toArray(selected)),
      bodyHash,
    );
  };

  public func requestHash(
    method : Text,
    headers : [HeaderField],
    body : Blob,
  ) : Blob {
    requestHashFromBodyHash(
      method,
      headers,
      SHA256.fromBlob(#sha256, body),
    );
  };

  let RESIDENT_QUERY_PARAMETER_NAMES : [Text] = [
    "app",
    "role",
    "installation-uid",
    "resident-frame-security",
    "browser-origin-nonce",
    "browser-origin-authority-epoch",
  ];

  public func validResidentSubresourceDestination(
    destination : Text,
  ) : Bool {
    destination == "audio" or
    destination == "audioworklet" or
    destination == "empty" or
    destination == "font" or
    destination == "image" or
    destination == "manifest" or
    destination == "paintworklet" or
    destination == "script" or
    destination == "sharedworker" or
    destination == "style" or
    destination == "track" or
    destination == "video" or
    destination == "worker" or
    destination == "serviceworker";
  };

  public func validResidentCanonicalQuery(queryText : Text) : Bool {
    let fragments = Text.split(queryText, #char '&');
    var index = 0;
    for (fragment in fragments) {
      if (index >= RESIDENT_QUERY_PARAMETER_NAMES.size()) return false;
      let fields = Text.split(fragment, #char '=');
      let ?name = fields.next() else return false;
      let ?value = fields.next() else return false;
      if (
        name != RESIDENT_QUERY_PARAMETER_NAMES[index] or
        value == "" or fields.next() != null
      ) return false;
      index += 1;
    };
    index == RESIDENT_QUERY_PARAMETER_NAMES.size();
  };

  public func residentCertificationExpression(
    kind : ResidentRequestKind,
  ) : Text {
    switch (kind) {
      case (#subresource_v1(_)) {
        RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION;
      };
      case (#installation_html_v1) {
        RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION;
      };
      case (#html_v1(_)) RESIDENT_HTML_CERTIFICATION_EXPRESSION;
    };
  };

  func residentRequestHashFromSelected(
    method : Text,
    headers : [HeaderField],
    selectedQuery : ?Text,
    bodyHash : Blob,
  ) : Blob {
    assert(bodyHash.size() == 32);
    let selected = List.empty<(Text, ReqData.V)>();
    for ((name, value) in headers.vals()) {
      let lower = Text.toLower(name);
      if (lower == "host" or lower == "sec-fetch-dest") {
        List.add(selected, (lower, #string(value)));
      };
    };
    List.add(selected, (":ic-cert-method", #string(method)));
    switch (selectedQuery) {
      case (?queryText) {
        // ReqData.hash performs the value hash. Supplying the raw selected
        // query here keeps the certified tree aligned with gateway verification
        // instead of hashing the query once here and a second time below.
        List.add(
          selected,
          (
            ":ic-cert-query",
            #string(queryText),
          ),
        );
      };
      case null {};
    };
    shaPair(ReqData.hash(List.toArray(selected)), bodyHash);
  };

  public func residentRequestHashFromBodyHash(
    owner : ResidentRequestOwner,
    bodyHash : Blob,
  ) : Blob {
    let (destination, selectedQuery) = switch (owner.kind) {
      case (#subresource_v1({ destination })) {
        assert(validResidentSubresourceDestination(destination));
        (destination, null);
      };
      case (#installation_html_v1) ("iframe", null);
      case (#html_v1({ canonical_query })) {
        assert(validResidentCanonicalQuery(canonical_query));
        ("iframe", ?canonical_query);
      };
    };
    residentRequestHashFromSelected(
      owner.method,
      [
        ("host", owner.host),
        ("sec-fetch-dest", destination),
      ],
      selectedQuery,
      bodyHash,
    );
  };

  public func residentRequestHash(
    owner : ResidentRequestOwner,
    body : Blob,
  ) : Blob {
    residentRequestHashFromBodyHash(
      owner,
      SHA256.fromBlob(#sha256, body),
    );
  };

  func selectedResidentQuery(requestUrl : Text) : ?Text {
    let parts = Text.split(requestUrl, #char '?');
    ignore parts.next();
    let ?queryText = parts.next() else return null;
    // The kernel-authored resident URL contains no literal '?' in a value.
    // Reject one rather than attempting a different parse than the gateway.
    if (parts.next() != null) return null;
    let selected = List.empty<Text>();
    for (fragment in Text.split(queryText, #char '&')) {
      let fields = Text.split(fragment, #char '=');
      let ?name = fields.next() else return null;
      var selectedName = false;
      for (expected in RESIDENT_QUERY_PARAMETER_NAMES.vals()) {
        if (name == expected) selectedName := true;
      };
      if (selectedName) List.add(selected, fragment);
    };
    let fragments = List.toArray(selected);
    if (fragments.size() == 0) return null;
    var result = fragments[0];
    var index = 1;
    while (index < fragments.size()) {
      result #= "&" # fragments[index];
      index += 1;
    };
    ?result;
  };

  public func residentRequestHashForRequest(
    kind : ResidentRequestKind,
    method : Text,
    requestUrl : Text,
    headers : [HeaderField],
    body : Blob,
  ) : ?Blob {
    let selectedQuery = switch (kind) {
      case (#subresource_v1(_)) null;
      case (#installation_html_v1) null;
      case (#html_v1(_)) {
        let ?queryText = selectedResidentQuery(requestUrl) else return null;
        ?queryText;
      };
    };
    ?residentRequestHashFromSelected(
      method,
      headers,
      selectedQuery,
      SHA256.fromBlob(#sha256, body),
    );
  };

  public func portableRequestHashFromBodyHash(
    method : Text,
    bodyHash : Blob,
  ) : Blob {
    requestHashFromBodyHash(method, [], bodyHash);
  };

  public func portableRequestHash(method : Text, body : Blob) : Blob {
    requestHash(method, [], body);
  };

  public func responseHashWithHeaders(
    headers : [HeaderField],
    certifiedHeaderNames : [Text],
    statusCode : Nat16,
    bodyHash : Blob,
  ) : Blob {
    assert(bodyHash.size() == 32);
    let selected = List.empty<(Text, ReqData.V)>();
    for ((name, value) in headers.vals()) {
      let lower = Text.toLower(name);
      if (
        lower != "ic-certificate" and (
          lower == "ic-certificateexpression" or
          includesHeader(certifiedHeaderNames, lower)
        )
      ) {
        List.add(selected, (lower, #string(value)));
      };
    };
    List.add(selected, (":ic-cert-status", #nat(Nat16.toNat(statusCode))));
    shaPair(ReqData.hash(List.toArray(selected)), bodyHash);
  };

  public func responseHash(
    headers : [HeaderField],
    statusCode : Nat16,
    bodyHash : Blob,
  ) : Blob {
    assert(bodyHash.size() == 32);
    let selected = List.empty<(Text, ReqData.V)>();
    for ((name, value) in headers.vals()) {
      let lower = Text.toLower(name);
      // The v2 protocol always excludes the proof-bearing header itself.
      // Every other header is hashed so a malicious query replica cannot add
      // cookies, redirects, CORS, or browser-isolation policy.
      if (lower != "ic-certificate") {
        List.add(selected, (lower, #string(value)));
      };
    };
    List.add(selected, (":ic-cert-status", #nat(Nat16.toNat(statusCode))));
    shaPair(ReqData.hash(List.toArray(selected)), bodyHash);
  };

  func routeTextSegments(url : Text) : [Text] {
    let result = List.empty<Text>();
    for (segment in Text.split(url, #char '/')) {
      if (segment != "") List.add(result, segment);
    };
    if (Text.endsWith(url, #char '/')) List.add(result, "");
    List.toArray(result);
  };

  func blobs(values : [Text]) : [Blob] {
    let result = List.empty<Blob>();
    for (value in values.vals()) List.add(result, Text.encodeUtf8(value));
    List.toArray(result);
  };

  func appendPath(prefix : [Blob], suffix : [Blob]) : [Blob] {
    let result = List.empty<Blob>();
    for (part in prefix.vals()) List.add(result, part);
    for (part in suffix.vals()) List.add(result, part);
    List.toArray(result);
  };

  func wildcardOwns(baseUrl : Text, requestUrl : Text) : Bool {
    if (baseUrl == "/") {
      return Text.startsWith(requestUrl, #char '/');
    };
    pathAtOrBelow(baseUrl, requestUrl);
  };

  func pathAtOrBelow(baseUrl : Text, candidate : Text) : Bool {
    candidate == baseUrl or
    Text.startsWith(candidate, #text(baseUrl # "/"));
  };

  func expressionPrefixPath(baseUrl : Text) : [Blob] {
    appendPath([httpExpr()], blobs(routeTextSegments(baseUrl)));
  };

  func mutationWithinBase(
    baseUrl : Text,
    mutation : V2Mutation,
  ) : Bool {
    switch (mutation) {
      case (#replace(replacement)) {
        for (key in replacement.prior.vals()) {
          if (not pathAtOrBelow(baseUrl, key.owner.canonical_path)) {
            return false;
          };
        };
        for (set in replacement.next.vals()) {
          if (not pathAtOrBelow(baseUrl, set.owner.canonical_path)) {
            return false;
          };
        };
        true;
      };
      case (#remove(removal)) {
        for (key in removal.leaves.vals()) {
          if (not pathAtOrBelow(baseUrl, key.owner.canonical_path)) {
            return false;
          };
        };
        true;
      };
      case (#detach_prefix(_)) false;
    };
  };

  public func exactExpressionPath(url : Text) : [Blob] {
    appendPath(
      [httpExpr()],
      appendPath(blobs(routeTextSegments(url)), [exactLabel()]),
    );
  };

  public func exactExpressionTextPath(url : Text) : [Text] {
    let result = List.empty<Text>();
    List.add(result, "http_expr");
    for (part in routeTextSegments(url).vals()) List.add(result, part);
    List.add(result, "<$>");
    List.toArray(result);
  };

  public func wildcardExpressionPath(baseUrl : Text) : [Blob] {
    appendPath(
      [httpExpr()],
      appendPath(blobs(routeTextSegments(baseUrl)), [wildcardLabel()]),
    );
  };

  public func wildcardExpressionTextPath(baseUrl : Text) : [Text] {
    let result = List.empty<Text>();
    List.add(result, "http_expr");
    for (part in routeTextSegments(baseUrl).vals()) List.add(result, part);
    List.add(result, "<*>");
    List.toArray(result);
  };

  func v2ExpressionPath(owner : V2RequestOwner) : [Blob] {
    switch (owner.expression_kind) {
      case (#exact) exactExpressionPath(owner.canonical_path);
      case (#wildcard) wildcardExpressionPath(owner.canonical_path);
    };
  };

  func proofExpressionPath(owner : ProofOwner) : [Blob] {
    switch (owner.expression_kind) {
      case (#exact) exactExpressionPath(owner.canonical_path);
      case (#wildcard) wildcardExpressionPath(owner.canonical_path);
    };
  };

  func proofExpressionTextPath(owner : ProofOwner) : [Text] {
    switch (owner.expression_kind) {
      case (#exact) exactExpressionTextPath(owner.canonical_path);
      case (#wildcard) wildcardExpressionTextPath(owner.canonical_path);
    };
  };

  func v2RequestHash(owner : V2RequestOwner) : Blob {
    switch (owner.host_mode) {
      case (#exact(host)) {
        requestHashFromBodyHash(
          owner.method,
          [("Host", host)],
          owner.empty_body_hash,
        );
      };
      case (#excluded) {
        portableRequestHashFromBodyHash(
          owner.method,
          owner.empty_body_hash,
        );
      };
    };
  };

  func v2RequestPath(owner : V2RequestOwner) : [Blob] {
    appendPath(
      v2ExpressionPath(owner),
      [
        SHA256.fromBlob(
          #sha256,
          Text.encodeUtf8(owner.certification_expression),
        ),
        v2RequestHash(owner),
      ],
    );
  };

  func v2ResponsePath(
    owner : V2RequestOwner,
    response : CertifiedResponse,
  ) : [Blob] {
    appendPath(
      v2RequestPath(owner),
      [responseHash(
        response.response_headers,
        response.status_code,
        response.body_hash,
      )],
    );
  };

  public func v2LeafKey(
    owner : V2RequestOwner,
    response : CertifiedResponse,
  ) : V2LeafKey {
    assert(validV2RequestOwner(owner));
    assert(response.body_hash.size() == 32);
    assert(hasExactExpression(
      response.response_headers,
      owner.certification_expression,
    ));
    {
      owner = {
        method = owner.method;
        canonical_path = owner.canonical_path;
        expression_kind = owner.expression_kind;
        host_mode = owner.host_mode;
      };
      expression_hash = SHA256.fromBlob(
        #sha256,
        Text.encodeUtf8(owner.certification_expression),
      );
      request_hash = v2RequestHash(owner);
      response_hash = responseHash(
        response.response_headers,
        response.status_code,
        response.body_hash,
      );
    };
  };

  func v2LeafPath(key : V2LeafKey) : [Blob] {
    appendPath(
      proofExpressionPath(key.owner),
      [
        key.expression_hash,
        key.request_hash,
        key.response_hash,
      ],
    );
  };

  func publicLeafPath(
    url : Text,
    expression : Text,
    request : Blob,
    response : Blob,
  ) : [Blob] {
    appendPath(
      exactExpressionPath(url),
      [
        SHA256.fromBlob(#sha256, Text.encodeUtf8(expression)),
        request,
        response,
      ],
    );
  };

  func publicRequestPath(
    url : Text,
    method : Text,
    host : Text,
  ) : [Blob] {
    let portable = host == "";
    appendPath(
      exactExpressionPath(url),
      [
        SHA256.fromBlob(
          #sha256,
          Text.encodeUtf8(
            if (portable) PORTABLE_CERTIFICATION_EXPRESSION
            else HOST_BOUND_CERTIFICATION_EXPRESSION
          ),
        ),
        if (portable) portableRequestHash(method, emptyBlob())
        else requestHash(method, [("Host", host)], emptyBlob()),
      ],
    );
  };

  func publicResponsePath(
    url : Text,
    variant : ResponseCertificationVariant,
  ) : [Blob] {
    appendPath(
      publicRequestPath(url, variant.method, variant.host),
      [responseHash(
        variant.response_headers,
        variant.status_code,
        variant.body_hash,
      )],
    );
  };

  func residentExpressionBranchPath(
    url : Text,
    expression : Text,
  ) : [Blob] {
    appendPath(
      exactExpressionPath(url),
      [SHA256.fromBlob(#sha256, Text.encodeUtf8(expression))],
    );
  };

  func residentExpressionBranchPaths(url : Text) : [[Blob]] {
    [
      residentExpressionBranchPath(
        url,
        RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION,
      ),
      residentExpressionBranchPath(
        url,
        RESIDENT_HTML_CERTIFICATION_EXPRESSION,
      ),
    ];
  };

  func residentPublicRequestPath(
    url : Text,
    owner : ResidentRequestOwner,
  ) : [Blob] {
    appendPath(
      residentExpressionBranchPath(
        url,
        residentCertificationExpression(owner.kind),
      ),
      [
        residentRequestHash(owner, emptyBlob()),
      ],
    );
  };

  func residentPublicResponsePath(
    url : Text,
    variant : ResidentResponseVariant,
  ) : [Blob] {
    appendPath(
      residentPublicRequestPath(
        url,
        {
          method = variant.method;
          host = variant.host;
          kind = variant.kind;
        },
      ),
      [responseHash(
        variant.response_headers,
        variant.status_code,
        variant.body_hash,
      )],
    );
  };

  func notFoundLeafPath(response : Blob) : [Blob] {
    [
      httpExpr(),
      wildcardLabel(),
      SHA256.fromBlob(#sha256, Text.encodeUtf8(NOT_FOUND_EXPRESSION)),
      emptyBlob(),
      response,
    ];
  };

  func hasExactExpression(headers : [HeaderField], expected : Text) : Bool {
    var found = false;
    for ((name, value) in headers.vals()) {
      let lower = Text.toLower(name);
      if (lower == "ic-certificate") return false;
      if (lower == "ic-certificateexpression") {
        if (found or value != expected) return false;
        found := true;
      };
    };
    found;
  };

  func validRequestOwner(owner : RequestOwner) : Bool {
    (owner.method == "GET" or owner.method == "HEAD") and
    (
      owner.host == "" or
      GatewayAuthority.parseCanonical(owner.host) != null
    );
  };

  func validResidentRequestOwner(owner : ResidentRequestOwner) : Bool {
    if (
      owner.method != "GET" or
      GatewayAuthority.parseCanonical(owner.host) == null
    ) return false;
    switch (owner.kind) {
      case (#subresource_v1({ destination })) {
        validResidentSubresourceDestination(destination);
      };
      case (#installation_html_v1) true;
      case (#html_v1({ canonical_query })) {
        validResidentCanonicalQuery(canonical_query);
      };
    };
  };

  func validRequestKey(key : CertificationRequestKey) : Bool {
    V2.validCanonicalPath(key.url) and key.host != "" and validRequestOwner({
      method = key.method;
      host = key.host;
    });
  };

  func validV2RequestOwner(owner : V2RequestOwner) : Bool {
    if (
      (owner.method != "GET" and owner.method != "HEAD") or
      owner.empty_body_hash != V2.emptyBodyHash() or
      owner.certification_expression !=
        V2.certificationExpression(owner.host_mode)
    ) return false;
    switch (owner.expression_kind) {
      case (#exact) {
        if (not V2.validCanonicalPath(owner.canonical_path)) return false;
      };
      case (#wildcard) {
        if (not V2.validWildcardBase(owner.canonical_path)) return false;
      };
    };
    switch (owner.host_mode) {
      case (#exact(host)) {
        GatewayAuthority.parseCanonical(host) != null;
      };
      case (#excluded) true;
    };
  };

  func validProofOwner(owner : ProofOwner) : Bool {
    if (owner.method != "GET" and owner.method != "HEAD") return false;
    switch (owner.expression_kind) {
      case (#exact) {
        if (not V2.validCanonicalPath(owner.canonical_path)) return false;
      };
      case (#wildcard) {
        if (not V2.validWildcardBase(owner.canonical_path)) return false;
      };
    };
    switch (owner.host_mode) {
      case (#exact(host)) {
        GatewayAuthority.parseCanonical(host) != null;
      };
      case (#excluded) true;
    };
  };

  func validV2LeafKey(key : V2LeafKey) : Bool {
    validProofOwner(key.owner) and
    key.expression_hash.size() == 32 and
    key.request_hash.size() == 32 and
    key.response_hash.size() == 32 and
    key.expression_hash == V2.certificationExpressionHash(
      key.owner.host_mode,
    ) and
    key.request_hash == proofRequestHash(key.owner);
  };

  func proofRequestHash(owner : ProofOwner) : Blob {
    switch (owner.host_mode) {
      case (#exact(host)) {
        requestHashFromBodyHash(
          owner.method,
          [("Host", host)],
          V2.emptyBodyHash(),
        );
      };
      case (#excluded) {
        portableRequestHashFromBodyHash(
          owner.method,
          V2.emptyBodyHash(),
        );
      };
    };
  };

  func responseOwner(variant : ResponseVariant) : RequestOwner {
    {
      method = variant.method;
      host = variant.host;
    };
  };

  func residentResponseOwner(
    variant : ResidentResponseVariant,
  ) : ResidentRequestOwner {
    {
      method = variant.method;
      host = variant.host;
      kind = variant.kind;
    };
  };

  func lengthDelimited(value : Text) : Text {
    Nat.toText(Text.encodeUtf8(value).size()) # ":" # value;
  };

  func requestOwnerKey(
    url : Text,
    owner : RequestOwner,
  ) : Text {
    lengthDelimited(url) #
    lengthDelimited(owner.method) #
    lengthDelimited(owner.host);
  };

  func residentRequestOwnerKey(
    url : Text,
    owner : ResidentRequestOwner,
  ) : Text {
    let kind = switch (owner.kind) {
      case (#subresource_v1({ destination })) {
        "subresource_v1:" # destination;
      };
      case (#installation_html_v1) "installation_html_v1";
      case (#html_v1({ canonical_query })) {
        "html_v1:" # canonical_query;
      };
    };
    lengthDelimited(url) #
    lengthDelimited(owner.method) #
    lengthDelimited(owner.host) #
    lengthDelimited(kind);
  };

  func validateResidentResponseVariants(
    url : Text,
    variants : [ResidentResponseVariant],
  ) : () {
    assert(originResponseVariantCountAllowed(variants.size()));
    let responses = Map.empty<Text, ()>();
    for (variant in variants.vals()) {
      let owner = residentResponseOwner(variant);
      assert(validResidentRequestOwner(owner));
      // Resident static assets are successful responses. Proof lookup receives
      // the selected headers/body from the handler and intentionally fixes the
      // status to 200, so do not admit an unreachable response leaf here.
      assert(variant.status_code == 200);
      assert(variant.body_hash.size() == 32);
      assert(hasExactExpression(
        variant.response_headers,
        residentCertificationExpression(owner.kind),
      ));
      let ownerKey = residentRequestOwnerKey(url, owner);
      let key = ownerKey #
        V2.lowercaseHex(responseHash(
          variant.response_headers,
          variant.status_code,
          variant.body_hash,
        ));
      assert(Map.get(responses, Text.compare, key) == null);
      Map.add(responses, Text.compare, key, ());
    };
  };

  func v2RequestOwnerKey(owner : V2RequestOwner) : Text {
    let expressionKind = switch (owner.expression_kind) {
      case (#exact) "exact";
      case (#wildcard) "wildcard";
    };
    let host = switch (owner.host_mode) {
      case (#exact(value)) "exact:" # value;
      case (#excluded) "excluded";
    };
    lengthDelimited(owner.canonical_path) #
    lengthDelimited(expressionKind) #
    lengthDelimited(owner.method) #
    lengthDelimited(host);
  };

  func appendCborLength(output : List.List<Nat8>, major : Nat, size : Nat) {
    assert(size <= 4_294_967_295);
    if (size < 24) {
      List.add(output, Nat.toNat8(major * 32 + size));
    } else if (size <= 255) {
      List.add(output, Nat.toNat8(major * 32 + 24));
      List.add(output, Nat.toNat8(size));
    } else if (size <= 65_535) {
      List.add(output, Nat.toNat8(major * 32 + 25));
      List.add(output, Nat.toNat8(size / 256));
      List.add(output, Nat.toNat8(size % 256));
    } else {
      List.add(output, Nat.toNat8(major * 32 + 26));
      List.add(output, Nat.toNat8(size / 16_777_216));
      List.add(output, Nat.toNat8((size / 65_536) % 256));
      List.add(output, Nat.toNat8((size / 256) % 256));
      List.add(output, Nat.toNat8(size % 256));
    };
  };

  // The certificate header carries expr_path as self-describing CBOR. Keeping
  // this tiny encoder local avoids pulling a second HTTP router into the
  // trusted kernel; its only admitted value is a bounded array of UTF-8 text.
  public func encodeExpressionPath(path : [Text]) : Blob {
    let output = List.empty<Nat8>();
    List.add(output, Nat.toNat8(0xd9));
    List.add(output, Nat.toNat8(0xd9));
    List.add(output, Nat.toNat8(0xf7));
    appendCborLength(output, 4, path.size());
    for (part in path.vals()) {
      let encoded = Blob.toArray(Text.encodeUtf8(part));
      appendCborLength(output, 3, encoded.size());
      for (byte in encoded.vals()) List.add(output, byte);
    };
    Blob.fromArray(List.toArray(output));
  };

  // Pure production formatter used by the query wrapper and by byte-exact
  // maximum-state evidence fixtures. Inputs are already the IC certificate,
  // encoded mixed-hash-tree witness, and self-described CBOR expression path.
  public func composeCertificateHeaderV2(
    certificate : Blob,
    encodedWitness : Blob,
    encodedExpressionPath : Blob,
  ) : HeaderField {
    (
      CERTIFICATE_HEADER,
      "certificate=:" # Base64.encode(certificate) #
      ":, tree=:" # Base64.encode(encodedWitness) #
      ":, expr_path=:" # Base64.encode(encodedExpressionPath) #
      ":, version=2",
    );
  };

  type ChunkedCallback = {
    max_chunks : Nat;
    done : ([Blob], Blob) -> ();
    var last_chunk : Nat;
    chunks : [var ?Blob];
    sha : SHA256.Digest;
  };

  // A mutation-only view of the public v2 tree. The outer CertifiedHttp class
  // owns certified-data commitment, allowing one root update after a whole
  // lifecycle batch instead of one update per leaf.
  public class PublicCertificationTree(certStore : CertifiedHttpMemory) {
    let ct = CertTree.Ops(certStore);

    public func publish(
      url : Text,
      bodyHash : Blob,
      variants : [CertificationVariant],
    ) : () {
      assert(bodyHash.size() == 32);
      if (variants.size() == 0) return;
      let next = Array.map<CertificationVariant, ResponseVariant>(
        variants,
        func(variant) {
          {
            method = "GET";
            host = variant.host;
            status_code = 200;
            body_hash = bodyHash;
            response_headers = variant.response_headers;
          };
        },
      );
      apply([#replace({
        url;
        prior = Array.map<ResponseVariant, RequestOwner>(
          next,
          responseOwner,
        );
        next;
      })]);
    };

    public func apply(mutations : [Mutation]) : () {
      assert(validLegacyMutationPaths(mutations));
      // Validate in O(n log n). `prior` and `next` may name the same
      // request within one replacement, but neither list may duplicate itself
      // and no request may be owned by two separate mutations in one batch.
      let batchOwners = Map.empty<Text, ()>();
      let originScopedUrls = Map.empty<Text, ()>();
      let granularResidentUrls = Map.empty<Text, ()>();
      func addUnique(target : Map.Map<Text, ()>, key : Text) : () {
        assert(Map.get(target, Text.compare, key) == null);
        Map.add(target, Text.compare, key, ());
      };
      func addBatchOwner(
        localOwners : Map.Map<Text, ()>,
        key : Text,
      ) : () {
        if (Map.get(localOwners, Text.compare, key) != null) return;
        addUnique(batchOwners, key);
        Map.add(localOwners, Text.compare, key, ());
      };
      func addGranularResidentUrl(url : Text) : () {
        assert(Map.get(originScopedUrls, Text.compare, url) == null);
        Map.add(granularResidentUrls, Text.compare, url, ());
      };
      func addOriginScopedUrl(url : Text) : () {
        assert(Map.get(originScopedUrls, Text.compare, url) == null);
        assert(Map.get(granularResidentUrls, Text.compare, url) == null);
        Map.add(originScopedUrls, Text.compare, url, ());
      };

      var index = 0;
      while (index < mutations.size()) {
        switch (mutations[index]) {
          case (#replace(replacement)) {
            assert(
              replacement.prior.size() > 0 or
              replacement.next.size() > 0
            );
            let localOwners = Map.empty<Text, ()>();
            let priorOwners = Map.empty<Text, ()>();
            var ownerIndex = 0;
            while (ownerIndex < replacement.prior.size()) {
              let owner = replacement.prior[ownerIndex];
              assert(validRequestOwner(owner));
              let key = requestOwnerKey(replacement.url, owner);
              addUnique(priorOwners, key);
              addBatchOwner(localOwners, key);
              ownerIndex += 1;
            };
            let nextOwners = Map.empty<Text, ()>();
            let nextResponses = Map.empty<Text, ()>();
            var nextIndex = 0;
            while (nextIndex < replacement.next.size()) {
              let variant = replacement.next[nextIndex];
              let owner = responseOwner(variant);
              assert(validRequestOwner(owner));
              assert(variant.body_hash.size() == 32);
              assert(hasExactExpression(
                variant.response_headers,
                if (owner.host == "") PORTABLE_CERTIFICATION_EXPRESSION
                else HOST_BOUND_CERTIFICATION_EXPRESSION,
              ));
              let key = requestOwnerKey(replacement.url, owner);
              if (Map.get(nextOwners, Text.compare, key) == null) {
                Map.add(nextOwners, Text.compare, key, ());
                addBatchOwner(localOwners, key);
              };
              addUnique(
                nextResponses,
                key # V2.lowercaseHex(responseHash(
                  variant.response_headers,
                  variant.status_code,
                  variant.body_hash,
                )),
              );
              nextIndex += 1;
            };
          };
          case (#remove(removal)) {
            assert(removal.requests.size() > 0);
            let localOwners = Map.empty<Text, ()>();
            var ownerIndex = 0;
            while (ownerIndex < removal.requests.size()) {
              let owner = removal.requests[ownerIndex];
              assert(validRequestOwner(owner));
              let key = requestOwnerKey(removal.url, owner);
              addUnique(localOwners, key);
              addUnique(batchOwners, key);
              ownerIndex += 1;
            };
          };
          case (#replace_resident(replacement)) {
            addGranularResidentUrl(replacement.url);
            assert(
              replacement.prior.size() > 0 or
              replacement.next.size() > 0
            );
            let localOwners = Map.empty<Text, ()>();
            let priorOwners = Map.empty<Text, ()>();
            for (owner in replacement.prior.vals()) {
              assert(validResidentRequestOwner(owner));
              let key = residentRequestOwnerKey(replacement.url, owner);
              addUnique(priorOwners, key);
              addBatchOwner(localOwners, key);
            };
            validateResidentResponseVariants(
              replacement.url,
              replacement.next,
            );
            let nextOwners = Map.empty<Text, ()>();
            for (variant in replacement.next.vals()) {
              let owner = residentResponseOwner(variant);
              let key = residentRequestOwnerKey(replacement.url, owner);
              if (Map.get(nextOwners, Text.compare, key) == null) {
                Map.add(nextOwners, Text.compare, key, ());
                addBatchOwner(localOwners, key);
              };
            };
          };
          case (#replace_origin_scoped(replacement)) {
            addOriginScopedUrl(replacement.url);
            validateResidentResponseVariants(
              replacement.url,
              replacement.next,
            );
            let localOwners = Map.empty<Text, ()>();
            for (variant in replacement.next.vals()) {
              let key = residentRequestOwnerKey(
                replacement.url,
                residentResponseOwner(variant),
              );
              addBatchOwner(localOwners, key);
            };
          };
          case (#remove_resident(removal)) {
            addGranularResidentUrl(removal.url);
            assert(removal.requests.size() > 0);
            let localOwners = Map.empty<Text, ()>();
            for (owner in removal.requests.vals()) {
              assert(validResidentRequestOwner(owner));
              let key = residentRequestOwnerKey(removal.url, owner);
              addUnique(localOwners, key);
              addUnique(batchOwners, key);
            };
          };
        };
        index += 1;
      };

      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#replace(replacement)) {
            for (owner in replacement.prior.vals()) {
              ct.delete(publicRequestPath(
                replacement.url,
                owner.method,
                owner.host,
              ));
            };
            let resetOwners = Map.empty<Text, ()>();
            for (variant in replacement.next.vals()) {
              let owner = responseOwner(variant);
              let key = requestOwnerKey(replacement.url, owner);
              // Reset an owner once, then retain every certified alternative
              // below that request hash. Deleting per response would silently
              // retain only the last publication range block.
              if (Map.get(resetOwners, Text.compare, key) == null) {
                ct.delete(publicRequestPath(
                  replacement.url,
                  variant.method,
                  variant.host,
                ));
                Map.add(resetOwners, Text.compare, key, ());
              };
              ct.put(
                publicResponsePath(replacement.url, variant),
                emptyBlob(),
              );
            };
          };
          case (#remove(removal)) {
            for (owner in removal.requests.vals()) {
              ct.delete(publicRequestPath(
                removal.url,
                owner.method,
                owner.host,
              ));
            };
          };
          case (#replace_resident(replacement)) {
            for (owner in replacement.prior.vals()) {
              ct.delete(residentPublicRequestPath(
                replacement.url,
                owner,
              ));
            };
            let resetOwners = Map.empty<Text, ()>();
            for (variant in replacement.next.vals()) {
              let owner = residentResponseOwner(variant);
              let key = residentRequestOwnerKey(replacement.url, owner);
              if (Map.get(resetOwners, Text.compare, key) == null) {
                ct.delete(residentPublicRequestPath(
                  replacement.url,
                  owner,
                ));
                Map.add(resetOwners, Text.compare, key, ());
              };
              ct.put(
                residentPublicResponsePath(replacement.url, variant),
                emptyBlob(),
              );
            };
          };
          case (#replace_origin_scoped(replacement)) {
            for (path in residentExpressionBranchPaths(
              replacement.url
            ).vals()) {
              ct.delete(path);
            };
            for (variant in replacement.next.vals()) {
              ct.put(
                residentPublicResponsePath(replacement.url, variant),
                emptyBlob(),
              );
            };
          };
          case (#remove_resident(removal)) {
            for (owner in removal.requests.vals()) {
              ct.delete(residentPublicRequestPath(
                removal.url,
                owner,
              ));
            };
          };
        };
      };
    };

    public func has(
      url : Text,
      variant : ResponseCertificationVariant,
    ) : Bool {
      if (not V2.validCanonicalPath(url)) return false;
      ct.lookup(publicResponsePath(url, variant)) != null;
    };

    public func hasResident(
      url : Text,
      variant : ResidentResponseVariant,
    ) : Bool {
      if (not V2.validCanonicalPath(url)) return false;
      ct.lookup(residentPublicResponsePath(url, variant)) != null;
    };

    // Applies complete request-owner response sets. This is the native V2
    // mutation surface used by Certified Assets. Validation finishes before
    // the first tree mutation, each request branch is reset once, and all
    // alternatives are inserted below that request hash.
    public func applyV2(mutations : [V2Mutation]) : Bool {
      if (mutations.size() == 0) return false;
      let batchOwners = Map.empty<Text, ()>();
      let detachPrefixes = Map.empty<Text, ()>();
      let batchExpressions = Map.empty<Text, Text>();

      func addUnique(target : Map.Map<Text, ()>, key : Text) : () {
        assert(Map.get(target, Text.compare, key) == null);
        Map.add(target, Text.compare, key, ());
      };

      // Resolve every subtree authority before validating point owners, so
      // validation is independent of mutation ordering.
      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#detach_prefix(detach)) {
            assert(V2.validDetachableBase(detach.base_path));
            for (existing in Map.keys(detachPrefixes)) {
              assert(not pathAtOrBelow(existing, detach.base_path));
              assert(not pathAtOrBelow(detach.base_path, existing));
            };
            Map.add(detachPrefixes, Text.compare, detach.base_path, ());
          };
          case _ {};
        };
      };

      func addBatchOwner(
        localOwners : Map.Map<Text, ()>,
        owner : V2RequestOwner,
        detachBase : ?Text,
      ) : () {
        assert(validV2RequestOwner(owner));
        for (base in Map.keys(detachPrefixes)) {
          if (pathAtOrBelow(base, owner.canonical_path)) {
            let allowed = switch (detachBase) {
              case (?value) {
                value == base and owner.canonical_path == base and
                owner.expression_kind == #wildcard;
              };
              case null false;
            };
            assert(allowed);
          };
        };
        let key = v2RequestOwnerKey(owner);
        if (Map.get(localOwners, Text.compare, key) != null) return;
        addUnique(batchOwners, key);
        Map.add(localOwners, Text.compare, key, ());
      };

      func validateResponses(set : OwnerResponses) : () {
        assert(validV2RequestOwner(set.owner));
        switch (set.response_mode) {
          case (#single) {
            assert(V2.validClosedSingleResponseSet(set));
          };
          case (#range_chunks) {
            assert(V2.validPublicationRangeResponseSet(set));
          };
        };

        let expressionKey = (
          switch (set.owner.expression_kind) {
            case (#exact) "exact:";
            case (#wildcard) "wildcard:";
          }
        ) # set.owner.canonical_path;
        let expressionHash = V2.lowercaseHex(
          V2.certificationExpressionHash(set.owner.host_mode),
        );
        switch (Map.get(
          batchExpressions,
          Text.compare,
          expressionKey,
        )) {
          case (?existing) assert(existing == expressionHash);
          case null {
            Map.add(
              batchExpressions,
              Text.compare,
              expressionKey,
              expressionHash,
            );
          };
        };
        for (existingHash in ct.labelsAt(v2ExpressionPath(set.owner))) {
          assert(V2.lowercaseHex(existingHash) == expressionHash);
        };

        let responseHashes = Map.empty<Text, ()>();
        for (response in set.responses.vals()) {
          assert(response.body_hash.size() == 32);
          switch (set.response_mode) {
            case (#single) {};
            case (#range_chunks) {
              assert(response.status_code == 206);
            };
          };
          assert(hasExactExpression(
            response.response_headers,
            set.owner.certification_expression,
          ));
          let hash = responseHash(
            response.response_headers,
            response.status_code,
            response.body_hash,
          );
          addUnique(responseHashes, V2.lowercaseHex(hash));
        };
      };

      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#replace(replacement)) {
            assert(
              replacement.prior.size() > 0 or
              replacement.next.size() > 0
            );
            let localOwners = Map.empty<Text, ()>();
            let priorLeaves = Map.empty<Text, ()>();
            for (leaf in replacement.prior.vals()) {
              assert(validV2LeafKey(leaf));
              let key = V2.lowercaseHex(leaf.expression_hash) #
                V2.lowercaseHex(leaf.request_hash) #
                V2.lowercaseHex(leaf.response_hash);
              addUnique(priorLeaves, key);
              addBatchOwner(
                localOwners,
                {
                  method = leaf.owner.method;
                  canonical_path = leaf.owner.canonical_path;
                  expression_kind = leaf.owner.expression_kind;
                  host_mode = leaf.owner.host_mode;
                  empty_body_hash = V2.emptyBodyHash();
                  certification_expression =
                    V2.certificationExpression(leaf.owner.host_mode);
                },
                null,
              );
            };
            let nextOwners = Map.empty<Text, ()>();
            for (set in replacement.next.vals()) {
              let ownerKey = v2RequestOwnerKey(set.owner);
              addUnique(nextOwners, ownerKey);
              addBatchOwner(localOwners, set.owner, null);
              validateResponses(set);
            };
          };
          case (#remove(removal)) {
            assert(removal.leaves.size() > 0);
            let localOwners = Map.empty<Text, ()>();
            let removalLeaves = Map.empty<Text, ()>();
            for (leaf in removal.leaves.vals()) {
              assert(validV2LeafKey(leaf));
              addUnique(
                removalLeaves,
                V2.lowercaseHex(leaf.expression_hash) #
                V2.lowercaseHex(leaf.request_hash) #
                V2.lowercaseHex(leaf.response_hash),
              );
              addBatchOwner(
                localOwners,
                {
                  method = leaf.owner.method;
                  canonical_path = leaf.owner.canonical_path;
                  expression_kind = leaf.owner.expression_kind;
                  host_mode = leaf.owner.host_mode;
                  empty_body_hash = V2.emptyBodyHash();
                  certification_expression =
                    V2.certificationExpression(leaf.owner.host_mode);
                },
                null,
              );
            };
          };
          case (#detach_prefix(detach)) {
            let localOwners = Map.empty<Text, ()>();
            let wildcardOwners = Map.empty<Text, ()>();
            for (set in detach.next_wildcard.vals()) {
              assert(set.owner.canonical_path == detach.base_path);
              assert(set.owner.expression_kind == #wildcard);
              addUnique(
                wildcardOwners,
                v2RequestOwnerKey(set.owner),
              );
              addBatchOwner(
                localOwners,
                set.owner,
                ?detach.base_path,
              );
              validateResponses(set);
            };
          };
        };
      };

      let priorRoot = ct.treeHash();
      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#replace(replacement)) {
            for (leaf in replacement.prior.vals()) {
              ct.delete(v2LeafPath(leaf));
            };
            for (set in replacement.next.vals()) {
              ct.delete(v2RequestPath(set.owner));
              for (response in set.responses.vals()) {
                ct.put(v2ResponsePath(set.owner, response), emptyBlob());
              };
            };
          };
          case (#remove(removal)) {
            for (leaf in removal.leaves.vals()) {
              ct.delete(v2LeafPath(leaf));
            };
          };
          case (#detach_prefix(detach)) {
            ct.delete(expressionPrefixPath(detach.base_path));
            for (set in detach.next_wildcard.vals()) {
              for (response in set.responses.vals()) {
                ct.put(v2ResponsePath(set.owner, response), emptyBlob());
              };
            };
          };
        };
      };
      ct.treeHash() != priorRoot;
    };

    // Retains the complete authenticated mount subtree as a persistent value
    // while replacing its live route with only the fixed wildcard response.
    // The functional Merkle tree shares untouched nodes, so take/delete/graft
    // touch only the bounded ancestor path.
    public func detachV2(
      basePath : Text,
      nextWildcard : [OwnerResponses],
    ) : (FunctionalDetachedV2, Bool) {
      assert(V2.validDetachableBase(basePath));
      let detached : FunctionalDetachedV2 = {
        base_path = basePath;
        subtree = Subtrees.at(
          certStore.tree,
          expressionPrefixPath(basePath),
        );
      };
      let changed = applyV2([#detach_prefix({
        base_path = basePath;
        next_wildcard = nextWildcard;
      })]);
      (detached, changed);
    };

    public func attachV2(detached : FunctionalDetachedV2) : Bool {
      assert(V2.validDetachableBase(detached.base_path));
      let priorRoot = ct.treeHash();
      certStore.tree := Subtrees.graft(
        certStore.tree,
        expressionPrefixPath(detached.base_path),
        detached.subtree,
      );
      ct.treeHash() != priorRoot;
    };

    // Conditional delete/cleanup remains available while a mount is detached.
    // Apply it to the retained subtree without touching live certified_data.
    public func applyDetachedV2(
      detached : FunctionalDetachedV2,
      mutations : [V2Mutation],
    ) : (FunctionalDetachedV2, Bool) {
      assert(V2.validDetachableBase(detached.base_path));
      for (mutation in mutations.vals()) {
        assert(mutationWithinBase(detached.base_path, mutation));
      };
      let temporary = CertTree.newStore();
      temporary.tree := Subtrees.graft(
        temporary.tree,
        expressionPrefixPath(detached.base_path),
        detached.subtree,
      );
      let temporaryTree = PublicCertificationTree(temporary);
      let changed = temporaryTree.applyV2(mutations);
      (
        {
          base_path = detached.base_path;
          subtree = Subtrees.at(
            temporary.tree,
            expressionPrefixPath(detached.base_path),
          );
        },
        changed,
      );
    };

    public func hasV2(
      owner : V2RequestOwner,
      response : CertifiedResponse,
    ) : Bool {
      ct.lookup(v2ResponsePath(owner, response)) != null;
    };

    public func hasV2Leaf(key : V2LeafKey) : Bool {
      ct.lookup(v2LeafPath(key)) != null;
    };
  };

  // Production http_expr authority. The stable authenticated forest owns every
  // static and Certified Assets response leaf; the CertTree store beside it
  // is reserved for current http_assets body hashes.
  public class PersistentCertificationTree(
    forest : AuthenticatedForest.Memory,
    afterMutation : () -> (),
  ) {
    let MAX_STATIC_REQUEST_BRANCH_NODES : Nat = 64;
    // One asset may have 34 declared installation surfaces, two certified
    // gateway authorities, and several Fetch Metadata destinations. Keep the
    // whole-asset and origin resets bounded, but above that closed publisher
    // maximum.
    let MAX_STATIC_ASSET_TREE_NODES : Nat = 1_024;
    let MAX_V2_REQUEST_BRANCH_NODES : Nat = 16;

    func trapForest(operation : Text, error : AuthenticatedForest.Error) : None {
      Runtime.trap(
        "Persistent HTTP certification " # operation # " failed: " #
        debug_show(error),
      );
    };

    func putLeaf(path : [Blob]) : () {
      switch (AuthenticatedForest.put(forest, path, emptyBlob())) {
        case (#ok(_)) afterMutation();
        case (#err(error)) trapForest("put", error);
      };
    };

    public func publish(
      url : Text,
      bodyHash : Blob,
      variants : [CertificationVariant],
    ) : () {
      assert(bodyHash.size() == 32);
      if (variants.size() == 0) return;
      let next = Array.map<CertificationVariant, ResponseVariant>(
        variants,
        func(variant) {
          {
            method = "GET";
            host = variant.host;
            status_code = 200;
            body_hash = bodyHash;
            response_headers = variant.response_headers;
          };
        },
      );
      apply([#replace({
        url;
        prior = Array.map<ResponseVariant, RequestOwner>(
          next,
          responseOwner,
        );
        next;
      })]);
    };

    func deleteLeaf(path : [Blob]) : () {
      switch (AuthenticatedForest.delete(forest, path)) {
        case (#ok(_)) afterMutation();
        case (#err(error)) trapForest("delete", error);
      };
    };

    func removeStaticBranch(
      path : [Blob],
      maxNodes : Nat,
      operation : Text,
    ) : () {
      switch (AuthenticatedForest.detach(forest, path)) {
        case (#err(#not_found)) {};
        case (#err(error)) trapForest("detach " # operation, error);
        case (#ok(token)) {
          afterMutation();
          switch (
            AuthenticatedForest.discardDetachedBounded(
              forest,
              token,
              maxNodes,
            )
          ) {
            case (#ok(_)) afterMutation();
            case (#err(error)) {
              trapForest("discard " # operation, error);
            };
          };
        };
      };
    };

    func removeStaticRequestBranch(path : [Blob]) : () {
      removeStaticBranch(
        path,
        MAX_STATIC_REQUEST_BRANCH_NODES,
        "static request branch",
      );
    };

    func removeOriginScopedExpressionBranch(path : [Blob]) : () {
      removeStaticBranch(
        path,
        MAX_STATIC_ASSET_TREE_NODES,
        "origin-scoped expression branch",
      );
    };

    func removeV2Request(path : [Blob]) : () {
      removeStaticBranch(
        path,
        MAX_V2_REQUEST_BRANCH_NODES,
        "V2 request",
      );
    };

    public func apply(mutations : [Mutation]) : () {
      assert(validLegacyMutationPaths(mutations));
      let batchOwners = Map.empty<Text, ()>();
      let originScopedUrls = Map.empty<Text, ()>();
      let granularResidentUrls = Map.empty<Text, ()>();
      func addUnique(target : Map.Map<Text, ()>, key : Text) : () {
        assert(Map.get(target, Text.compare, key) == null);
        Map.add(target, Text.compare, key, ());
      };
      func addBatchOwner(
        localOwners : Map.Map<Text, ()>,
        key : Text,
      ) : () {
        if (Map.get(localOwners, Text.compare, key) != null) return;
        addUnique(batchOwners, key);
        Map.add(localOwners, Text.compare, key, ());
      };
      func addGranularResidentUrl(url : Text) : () {
        assert(Map.get(originScopedUrls, Text.compare, url) == null);
        Map.add(granularResidentUrls, Text.compare, url, ());
      };
      func addOriginScopedUrl(url : Text) : () {
        assert(Map.get(originScopedUrls, Text.compare, url) == null);
        assert(Map.get(granularResidentUrls, Text.compare, url) == null);
        Map.add(originScopedUrls, Text.compare, url, ());
      };
      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#replace(replacement)) {
            assert(
              replacement.prior.size() > 0 or
              replacement.next.size() > 0
            );
            let localOwners = Map.empty<Text, ()>();
            let priorOwners = Map.empty<Text, ()>();
            for (owner in replacement.prior.vals()) {
              assert(validRequestOwner(owner));
              let key = requestOwnerKey(replacement.url, owner);
              addUnique(priorOwners, key);
              addBatchOwner(localOwners, key);
            };
            let nextOwners = Map.empty<Text, ()>();
            let nextResponses = Map.empty<Text, ()>();
            for (variant in replacement.next.vals()) {
              let owner = responseOwner(variant);
              assert(validRequestOwner(owner));
              assert(variant.body_hash.size() == 32);
              assert(hasExactExpression(
                variant.response_headers,
                if (owner.host == "") PORTABLE_CERTIFICATION_EXPRESSION
                else HOST_BOUND_CERTIFICATION_EXPRESSION,
              ));
              let key = requestOwnerKey(replacement.url, owner);
              if (Map.get(nextOwners, Text.compare, key) == null) {
                Map.add(nextOwners, Text.compare, key, ());
                addBatchOwner(localOwners, key);
              };
              addUnique(
                nextResponses,
                key # V2.lowercaseHex(responseHash(
                  variant.response_headers,
                  variant.status_code,
                  variant.body_hash,
                )),
              );
            };
          };
          case (#remove(removal)) {
            assert(removal.requests.size() > 0);
            let localOwners = Map.empty<Text, ()>();
            for (owner in removal.requests.vals()) {
              assert(validRequestOwner(owner));
              let key = requestOwnerKey(removal.url, owner);
              addUnique(localOwners, key);
              addUnique(batchOwners, key);
            };
          };
          case (#replace_resident(replacement)) {
            addGranularResidentUrl(replacement.url);
            assert(
              replacement.prior.size() > 0 or
              replacement.next.size() > 0
            );
            let localOwners = Map.empty<Text, ()>();
            let priorOwners = Map.empty<Text, ()>();
            for (owner in replacement.prior.vals()) {
              assert(validResidentRequestOwner(owner));
              let key = residentRequestOwnerKey(replacement.url, owner);
              addUnique(priorOwners, key);
              addBatchOwner(localOwners, key);
            };
            validateResidentResponseVariants(
              replacement.url,
              replacement.next,
            );
            let nextOwners = Map.empty<Text, ()>();
            for (variant in replacement.next.vals()) {
              let owner = residentResponseOwner(variant);
              let key = residentRequestOwnerKey(replacement.url, owner);
              if (Map.get(nextOwners, Text.compare, key) == null) {
                Map.add(nextOwners, Text.compare, key, ());
                addBatchOwner(localOwners, key);
              };
            };
          };
          case (#replace_origin_scoped(replacement)) {
            addOriginScopedUrl(replacement.url);
            validateResidentResponseVariants(
              replacement.url,
              replacement.next,
            );
            let localOwners = Map.empty<Text, ()>();
            for (variant in replacement.next.vals()) {
              let key = residentRequestOwnerKey(
                replacement.url,
                residentResponseOwner(variant),
              );
              addBatchOwner(localOwners, key);
            };
          };
          case (#remove_resident(removal)) {
            assert(removal.requests.size() > 0);
            addGranularResidentUrl(removal.url);
            let localOwners = Map.empty<Text, ()>();
            for (owner in removal.requests.vals()) {
              assert(validResidentRequestOwner(owner));
              let key = residentRequestOwnerKey(removal.url, owner);
              addUnique(localOwners, key);
              addUnique(batchOwners, key);
            };
          };
        };
      };

      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#replace(replacement)) {
            let reset = Map.empty<Text, ()>();
            for (owner in replacement.prior.vals()) {
              let key = requestOwnerKey(replacement.url, owner);
              if (Map.get(reset, Text.compare, key) == null) {
                removeStaticRequestBranch(publicRequestPath(
                  replacement.url,
                  owner.method,
                  owner.host,
                ));
                Map.add(reset, Text.compare, key, ());
              };
            };
            for (variant in replacement.next.vals()) {
              let owner = responseOwner(variant);
              let key = requestOwnerKey(replacement.url, owner);
              if (Map.get(reset, Text.compare, key) == null) {
                removeStaticRequestBranch(publicRequestPath(
                  replacement.url,
                  owner.method,
                  owner.host,
                ));
                Map.add(reset, Text.compare, key, ());
              };
              putLeaf(publicResponsePath(replacement.url, variant));
            };
          };
          case (#remove(removal)) {
            for (owner in removal.requests.vals()) {
              removeStaticRequestBranch(publicRequestPath(
                removal.url,
                owner.method,
                owner.host,
              ));
            };
          };
          case (#replace_resident(replacement)) {
            let reset = Map.empty<Text, ()>();
            for (owner in replacement.prior.vals()) {
              let key = residentRequestOwnerKey(replacement.url, owner);
              if (Map.get(reset, Text.compare, key) == null) {
                removeStaticRequestBranch(residentPublicRequestPath(
                  replacement.url,
                  owner,
                ));
                Map.add(reset, Text.compare, key, ());
              };
            };
            for (variant in replacement.next.vals()) {
              let owner = residentResponseOwner(variant);
              let key = residentRequestOwnerKey(replacement.url, owner);
              if (Map.get(reset, Text.compare, key) == null) {
                removeStaticRequestBranch(residentPublicRequestPath(
                  replacement.url,
                  owner,
                ));
                Map.add(reset, Text.compare, key, ());
              };
              putLeaf(residentPublicResponsePath(
                replacement.url,
                variant,
              ));
            };
          };
          case (#replace_origin_scoped(replacement)) {
            for (path in residentExpressionBranchPaths(
              replacement.url
            ).vals()) {
              removeOriginScopedExpressionBranch(path);
            };
            for (variant in replacement.next.vals()) {
              putLeaf(residentPublicResponsePath(
                replacement.url,
                variant,
              ));
            };
          };
          case (#remove_resident(removal)) {
            for (owner in removal.requests.vals()) {
              removeStaticRequestBranch(residentPublicRequestPath(
                removal.url,
                owner,
              ));
            };
          };
        };
      };
    };

    func validateLeaf(key : V2LeafKey) : () {
      assert(validV2LeafKey(key));
    };

    func validateSet(set : OwnerResponses) : () {
      assert(validV2RequestOwner(set.owner));
      switch (set.response_mode) {
        case (#single) assert(V2.validClosedSingleResponseSet(set));
        case (#range_chunks) {
          assert(V2.validPublicationRangeResponseSet(set));
        };
      };
      let responseHashes = Map.empty<Text, ()>();
      for (response in set.responses.vals()) {
        assert(response.body_hash.size() == 32);
        switch (set.response_mode) {
          case (#single) {};
          case (#range_chunks) assert(response.status_code == 206);
        };
        assert(hasExactExpression(
          response.response_headers,
          set.owner.certification_expression,
        ));
        let hash = V2.lowercaseHex(responseHash(
          response.response_headers,
          response.status_code,
          response.body_hash,
        ));
        assert(Map.get(responseHashes, Text.compare, hash) == null);
        Map.add(responseHashes, Text.compare, hash, ());
      };
    };

    public func applyV2(mutations : [V2Mutation]) : () {
      let batchOwners = Map.empty<Text, ()>();
      let batchExpressions = Map.empty<Text, Text>();
      func addUnique(target : Map.Map<Text, ()>, key : Text) : () {
        assert(Map.get(target, Text.compare, key) == null);
        Map.add(target, Text.compare, key, ());
      };
      func ownerFromLeaf(leaf : V2LeafKey) : V2RequestOwner {
        {
          method = leaf.owner.method;
          canonical_path = leaf.owner.canonical_path;
          expression_kind = leaf.owner.expression_kind;
          host_mode = leaf.owner.host_mode;
          empty_body_hash = V2.emptyBodyHash();
          certification_expression =
            V2.certificationExpression(leaf.owner.host_mode);
        };
      };
      func addBatchOwner(
        localOwners : Map.Map<Text, ()>,
        owner : V2RequestOwner,
      ) : () {
        assert(validV2RequestOwner(owner));
        let key = v2RequestOwnerKey(owner);
        if (Map.get(localOwners, Text.compare, key) != null) return;
        addUnique(batchOwners, key);
        Map.add(localOwners, Text.compare, key, ());
      };
      func validateExpression(set : OwnerResponses) : () {
        let expressionKey = (
          switch (set.owner.expression_kind) {
            case (#exact) "exact:";
            case (#wildcard) "wildcard:";
          }
        ) # set.owner.canonical_path;
        let expectedHash = V2.certificationExpressionHash(
          set.owner.host_mode,
        );
        let expectedHex = V2.lowercaseHex(expectedHash);
        switch (Map.get(
          batchExpressions,
          Text.compare,
          expressionKey,
        )) {
          case (?existing) assert(existing == expectedHex);
          case null {
            Map.add(
              batchExpressions,
              Text.compare,
              expressionKey,
              expectedHex,
            );
          };
        };
        // The current response-policy table is closed, so checking every
        // admitted expression hash is equivalent to functional labelsAt while
        // preserving O(log n) persistent-tree validation.
        let admittedExpressions = [
          HOST_BOUND_CERTIFICATION_EXPRESSION,
          PORTABLE_CERTIFICATION_EXPRESSION,
          RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION,
          RESIDENT_HTML_CERTIFICATION_EXPRESSION,
        ];
        for (expression in admittedExpressions.vals()) {
          let hash = SHA256.fromBlob(
            #sha256,
            Text.encodeUtf8(expression),
          );
          if (hash != expectedHash) {
            switch (AuthenticatedForest.pathKind(
              forest,
              appendPath(v2ExpressionPath(set.owner), [hash]),
            )) {
              case (#absent) {};
              case (#leaf) assert false;
              case (#subtree) assert false;
              case (#err(error)) {
                trapForest("validate V2 expression", error);
              };
            };
          };
        };
      };

      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#replace(replacement)) {
            assert(
              replacement.prior.size() > 0 or
              replacement.next.size() > 0
            );
            let localOwners = Map.empty<Text, ()>();
            let priorLeaves = Map.empty<Text, ()>();
            for (leaf in replacement.prior.vals()) {
              validateLeaf(leaf);
              let owner = ownerFromLeaf(leaf);
              addUnique(
                priorLeaves,
                v2RequestOwnerKey(owner) #
                V2.lowercaseHex(leaf.response_hash),
              );
              addBatchOwner(localOwners, owner);
            };
            let nextOwners = Map.empty<Text, ()>();
            for (set in replacement.next.vals()) {
              addUnique(nextOwners, v2RequestOwnerKey(set.owner));
              addBatchOwner(localOwners, set.owner);
              validateSet(set);
              validateExpression(set);
            };
          };
          case (#remove(removal)) {
            assert(removal.leaves.size() > 0);
            let localOwners = Map.empty<Text, ()>();
            let removalLeaves = Map.empty<Text, ()>();
            for (leaf in removal.leaves.vals()) {
              validateLeaf(leaf);
              let owner = ownerFromLeaf(leaf);
              addUnique(
                removalLeaves,
                v2RequestOwnerKey(owner) #
                V2.lowercaseHex(leaf.response_hash),
              );
              addBatchOwner(localOwners, owner);
            };
          };
          case (#detach_prefix(_)) {
            Runtime.trap(
              "Persistent HTTP certification requires retained detach tokens",
            );
          };
        };
      };
      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#replace(replacement)) {
            for (leaf in replacement.prior.vals()) {
              deleteLeaf(v2LeafPath(leaf));
            };
            for (set in replacement.next.vals()) {
              removeV2Request(v2RequestPath(set.owner));
              for (response in set.responses.vals()) {
                putLeaf(v2ResponsePath(set.owner, response));
              };
            };
          };
          case (#remove(removal)) {
            for (leaf in removal.leaves.vals()) {
              deleteLeaf(v2LeafPath(leaf));
            };
          };
          case (#detach_prefix(_)) {};
        };
      };
    };

    public func detachV2(
      basePath : Text,
      nextWildcard : [OwnerResponses],
    ) : DetachedV2 {
      assert(V2.validDetachableBase(basePath));
      for (set in nextWildcard.vals()) {
        assert(
          set.owner.canonical_path == basePath and
          set.owner.expression_kind == #wildcard
        );
        validateSet(set);
      };
      let token = switch (
        AuthenticatedForest.detach(
          forest,
          expressionPrefixPath(basePath),
        )
      ) {
        case (#ok(value)) {
          afterMutation();
          value;
        };
        case (#err(error)) {
          trapForest("detach V2 mount", error);
        };
      };
      for (set in nextWildcard.vals()) {
        for (response in set.responses.vals()) {
          putLeaf(v2ResponsePath(set.owner, response));
        };
      };
      token;
    };

    public func retireV2(inputs : [RetireMountV2]) : [DetachedV2] {
      Array.map<RetireMountV2, DetachedV2>(
        inputs,
        func(input) {
          assert(V2.validDetachableBase(input.base_path));
          for (leaf in input.absence_leaves.vals()) {
            validateLeaf(leaf);
            assert(
              leaf.owner.canonical_path == input.base_path and
              leaf.owner.expression_kind == #wildcard
            );
          };
          switch (input.current_detached) {
            case (?existing) {
              // A disabled mount already retains its record tree. Only its
              // small live wildcard-absence response set remains attached;
              // the retained tree also contains the pre-disable copy.
              for (leaf in input.absence_leaves.vals()) {
                deleteLeaf(v2LeafPath(leaf));
              };
              var token = existing;
              for (leaf in input.absence_leaves.vals()) {
                switch (AuthenticatedForest.deleteDetached(
                  forest,
                  token,
                  relativePath(token, v2LeafPath(leaf)),
                )) {
                  case (#ok(result)) {
                    token := result.token;
                    afterMutation();
                  };
                  case (#err(error)) {
                    trapForest(
                      "delete disabled retired absence leaf",
                      error,
                    );
                  };
                };
              };
              token;
            };
            case null {
              var token = switch (
                AuthenticatedForest.detach(
                  forest,
                  expressionPrefixPath(input.base_path),
                )
              ) {
                case (#ok(value)) {
                  afterMutation();
                  value;
                };
                case (#err(error)) {
                  trapForest("detach retired V2 mount", error);
                };
              };
              // Absence leaves live inside an enabled mount's detached tree.
              // Strip them now so record cleanup can make the token exactly
              // empty and reclaim it without an unbounded subtree walk.
              for (leaf in input.absence_leaves.vals()) {
                switch (AuthenticatedForest.deleteDetached(
                  forest,
                  token,
                  relativePath(token, v2LeafPath(leaf)),
                )) {
                  case (#ok(result)) {
                    token := result.token;
                    afterMutation();
                  };
                  case (#err(error)) {
                    trapForest("delete retired absence leaf", error);
                  };
                };
              };
              token;
            };
          };
        },
      );
    };

    public func attachV2(
      detached : DetachedV2,
      currentWildcard : [OwnerResponses],
    ) : () {
      for (set in currentWildcard.vals()) {
        validateSet(set);
        for (response in set.responses.vals()) {
          deleteLeaf(v2ResponsePath(set.owner, response));
        };
      };
      switch (AuthenticatedForest.attach(forest, detached)) {
        case (#ok) afterMutation();
        case (#err(error)) trapForest("attach V2 mount", error);
      };
    };

    func relativePath(
      token : DetachedV2,
      absolute : [Blob],
    ) : [Blob] {
      assert(absolute.size() > token.absolute_path.size());
      var index = 0;
      while (index < token.absolute_path.size()) {
        assert(absolute[index] == token.absolute_path[index]);
        index += 1;
      };
      Array.tabulate<Blob>(
        absolute.size() - token.absolute_path.size(),
        func(offset) {
          absolute[token.absolute_path.size() + offset];
        },
      );
    };

    public func applyDetachedV2(
      detached : DetachedV2,
      mutations : [V2Mutation],
    ) : DetachedV2 {
      var token = detached;
      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#replace(replacement)) {
            for (leaf in replacement.prior.vals()) validateLeaf(leaf);
            for (set in replacement.next.vals()) validateSet(set);
          };
          case (#remove(removal)) {
            for (leaf in removal.leaves.vals()) validateLeaf(leaf);
          };
          case (#detach_prefix(_)) {
            Runtime.trap("Nested detached-prefix mutation is unsupported");
          };
        };
      };
      for (mutation in mutations.vals()) {
        switch (mutation) {
          case (#replace(replacement)) {
            for (leaf in replacement.prior.vals()) {
              switch (AuthenticatedForest.deleteDetached(
                forest,
                token,
                relativePath(token, v2LeafPath(leaf)),
              )) {
                case (#ok(result)) {
                  token := result.token;
                  afterMutation();
                };
                case (#err(error)) {
                  trapForest("delete detached V2 leaf", error);
                };
              };
            };
            for (set in replacement.next.vals()) {
              for (response in set.responses.vals()) {
                switch (AuthenticatedForest.putDetached(
                  forest,
                  token,
                  relativePath(
                    token,
                    v2ResponsePath(set.owner, response),
                  ),
                  emptyBlob(),
                )) {
                  case (#ok(result)) {
                    token := result.token;
                    afterMutation();
                  };
                  case (#err(error)) {
                    trapForest("put detached V2 leaf", error);
                  };
                };
              };
            };
          };
          case (#remove(removal)) {
            for (leaf in removal.leaves.vals()) {
              switch (AuthenticatedForest.deleteDetached(
                forest,
                token,
                relativePath(token, v2LeafPath(leaf)),
              )) {
                case (#ok(result)) {
                  token := result.token;
                  afterMutation();
                };
                case (#err(error)) {
                  trapForest("delete detached V2 leaf", error);
                };
              };
            };
          };
          case (#detach_prefix(_)) {};
        };
      };
      token;
    };

    public func discardDetachedV2(detached : DetachedV2) : () {
      switch (AuthenticatedForest.discardDetached(forest, detached)) {
        case (#ok) afterMutation();
        case (#err(error)) trapForest("discard detached V2 mount", error);
      };
    };

    public func has(
      url : Text,
      variant : ResponseCertificationVariant,
    ) : Bool {
      if (not V2.validCanonicalPath(url)) return false;
      AuthenticatedForest.lookup(
        forest,
        publicResponsePath(url, variant),
      ) == #found(emptyBlob());
    };

    public func hasResident(
      url : Text,
      variant : ResidentResponseVariant,
    ) : Bool {
      if (not V2.validCanonicalPath(url)) return false;
      AuthenticatedForest.lookup(
        forest,
        residentPublicResponsePath(url, variant),
      ) == #found(emptyBlob());
    };

    func removeNamedRoot(
      kind : AuthenticatedForest.RootKind,
      id : Text,
    ) : () {
      switch (AuthenticatedForest.removeNamedRoot(forest, kind, id)) {
        case (#ok(_)) afterMutation();
        case (#err(error)) trapForest("remove named root", error);
      };
    };

    func acceptNamedRoot(
      operation : Text,
      kind : AuthenticatedForest.RootKind,
      id : Text,
      result : AuthenticatedForest.NamedRootResult,
    ) : () {
      switch (result) {
        case (#ok(_)) afterMutation();
        case (#err(#not_found)) removeNamedRoot(kind, id);
        case (#err(error)) trapForest(operation, error);
      };
    };

    // Named catalogs are persistent cross-audit indexes. They bind the actual
    // attached or retained mount/collection subtree without adding a second
    // parallel HTTP certification tree.
    public func syncMountCatalog(
      id : Text,
      basePath : Text,
      detached : ?DetachedV2,
    ) : () {
      assert(V2.validDetachableBase(basePath));
      acceptNamedRoot(
        "sync mount catalog",
        #mount,
        id,
        switch (detached) {
          case null AuthenticatedForest.syncNamedRoot(
            forest,
            #mount,
            id,
            expressionPrefixPath(basePath),
          );
          case (?token) {
            assert(token.absolute_path == expressionPrefixPath(basePath));
            AuthenticatedForest.syncDetachedNamedRoot(
              forest,
              #mount,
              id,
              token,
            );
          };
        },
      );
    };

    public func syncCollectionCatalog(
      id : Text,
      canonicalPath : Text,
      exact : Bool,
      detached : ?DetachedV2,
    ) : () {
      assert(V2.validCanonicalPath(canonicalPath));
      let absolutePath = if (exact) {
        exactExpressionPath(canonicalPath);
      } else {
        expressionPrefixPath(canonicalPath);
      };
      acceptNamedRoot(
        "sync collection catalog",
        #collection,
        id,
        switch (detached) {
          case null AuthenticatedForest.syncNamedRoot(
            forest,
            #collection,
            id,
            absolutePath,
          );
          case (?token) {
            assert(absolutePath.size() >= token.absolute_path.size());
            var index = 0;
            while (index < token.absolute_path.size()) {
              assert(absolutePath[index] == token.absolute_path[index]);
              index += 1;
            };
            let relative = Array.tabulate<Blob>(
              absolutePath.size() - token.absolute_path.size(),
              func(offset) {
                absolutePath[token.absolute_path.size() + offset];
              },
            );
            AuthenticatedForest.syncDetachedNamedRootAt(
              forest,
              #collection,
              id,
              token,
              relative,
            );
          };
        },
      );
    };

    public func mountCatalogMatches(
      id : Text,
      basePath : Text,
      detached : ?DetachedV2,
    ) : V2CatalogMatch {
      if (not V2.validDetachableBase(basePath)) return #err(#invalid_path);
      switch (detached) {
        case null AuthenticatedForest.namedRootMatches(
          forest,
          #mount,
          id,
          expressionPrefixPath(basePath),
        );
        case (?token) {
          if (token.absolute_path != expressionPrefixPath(basePath)) {
            return #mismatch;
          };
          AuthenticatedForest.detachedNamedRootMatchesAt(
            forest,
            #mount,
            id,
            token,
            [],
          );
        };
      };
    };

    public func collectionCatalogMatches(
      id : Text,
      canonicalPath : Text,
      exact : Bool,
      detached : ?DetachedV2,
    ) : V2CatalogMatch {
      if (not V2.validCanonicalPath(canonicalPath)) {
        return #err(#invalid_path);
      };
      let absolutePath = if (exact) {
        exactExpressionPath(canonicalPath);
      } else {
        expressionPrefixPath(canonicalPath);
      };
      switch (detached) {
        case null AuthenticatedForest.namedRootMatches(
          forest,
          #collection,
          id,
          absolutePath,
        );
        case (?token) {
          if (absolutePath.size() < token.absolute_path.size()) {
            return #mismatch;
          };
          var index = 0;
          while (index < token.absolute_path.size()) {
            if (absolutePath[index] != token.absolute_path[index]) {
              return #mismatch;
            };
            index += 1;
          };
          let relative = Array.tabulate<Blob>(
            absolutePath.size() - token.absolute_path.size(),
            func(offset) {
              absolutePath[token.absolute_path.size() + offset];
            },
          );
          AuthenticatedForest.detachedNamedRootMatchesAt(
            forest,
            #collection,
            id,
            token,
            relative,
          );
        };
      };
    };

    public func catalogSnapshot() : ?V2CatalogSnapshot {
      AuthenticatedForest.catalogSnapshot(forest);
    };

    public func removeMountCatalog(id : Text) : () {
      removeNamedRoot(#mount, id);
    };

    public func removeCollectionCatalog(id : Text) : () {
      removeNamedRoot(#collection, id);
    };

    public func hasV2Leaf(key : V2LeafKey) : Bool {
      AuthenticatedForest.lookup(
        forest,
        v2LeafPath(key),
      ) == #found(emptyBlob());
    };

    public func removeStaticExpressionTree(url : Text) : () {
      assert(validCanonicalPath(url));
      removeStaticBranch(
        exactExpressionPath(url),
        MAX_STATIC_ASSET_TREE_NODES,
        "static expression tree",
      );
    };

    // One-time v316 response-policy boundary. Retain only installation-owned
    // app trees and the package profiles whose semantics did not change, then
    // move the entire predecessor Kernel namespace outside
    // `http_expr`. The quarantined tree stays authenticated and auditable, but
    // can no longer reconstruct an HTTP response proof.
    public func cutoverKernelResponsePolicyV316(
      deploymentId : Text,
      retainedAppIds : [Text],
      notFoundHeaders : [HeaderField],
      notFoundBodyHash : Blob,
    ) : Bool {
      assert(retainedAppIds.size() <= 512);
      assert(notFoundBodyHash.size() == 32);
      assert(hasExactExpression(notFoundHeaders, NOT_FOUND_EXPRESSION));
      let markerValue = Text.encodeUtf8(deploymentId);
      assert(markerValue.size() >= 1 and markerValue.size() <= 256);
      let quarantinePath = kernelResponsePolicyV316QuarantinePath();
      let markerPath = kernelResponsePolicyV316MarkerPath();
      let notFoundResponse = responseHash(
        notFoundHeaders,
        404,
        notFoundBodyHash,
      );
      let currentNotFoundPath = notFoundLeafPath(notFoundResponse);

      switch (AuthenticatedForest.pathKind(
        forest,
        quarantinePath,
      )) {
        case (#subtree) {
          switch (AuthenticatedForest.lookup(forest, markerPath)) {
            case (#found(value)) assert(value == markerValue);
            case (#absent) Runtime.trap(
              "Response-policy quarantine has no completion marker",
            );
            case (#err(error)) {
              trapForest("inspect cutover marker", error);
            };
          };
          switch (AuthenticatedForest.lookup(
            forest,
            currentNotFoundPath,
          )) {
            case (#found(value)) {
              assert(value == emptyBlob());
              return false;
            };
            case (#absent) Runtime.trap(
              "Completed response-policy cutover has no current 404",
            );
            case (#err(error)) {
              trapForest("inspect cutover 404", error);
            };
          };
        };
        case (#absent) {};
        case (#leaf) Runtime.trap(
          "Kernel response-policy quarantine is not a subtree",
        );
        case (#err(error)) {
          trapForest("inspect response-policy quarantine", error);
        };
      };

      // The released predecessor always has one bounded root wildcard branch.
      // Reclaim it before allocating the replacement tree so the structural
      // cutover does not require arbitrary spare arena capacity.
      switch (AuthenticatedForest.pathKind(
        forest,
        [httpExpr(), wildcardLabel()],
      )) {
        case (#subtree) {};
        case (#absent) Runtime.trap(
          "Predecessor response policy has no root wildcard branch",
        );
        case (#leaf) Runtime.trap(
          "Predecessor root wildcard branch is not a subtree",
        );
        case (#err(error)) {
          trapForest("inspect predecessor root wildcard", error);
        };
      };
      removeStaticBranch(
        [httpExpr(), wildcardLabel()],
        MAX_STATIC_ASSET_TREE_NODES,
        "predecessor root wildcard branch",
      );
      // Keep the predecessor root structurally nonempty even when every other
      // branch is retained. The wildcard reclamation above supplies this node,
      // and the invalid UTF-8 label is never a valid HTTP expression path.
      switch (AuthenticatedForest.put(
        forest,
        [httpExpr(), kernelResponsePolicyV316MarkerLabel()],
        markerValue,
      )) {
        case (#ok(result)) {
          assert(result.inserted and result.prior == null);
          afterMutation();
        };
        case (#err(error)) {
          trapForest("write response-policy completion marker", error);
        };
      };

      let retainedPaths = List.empty<[Blob]>();
      List.add(retainedPaths, expressionPrefixPath("/mo"));
      List.add(retainedPaths, expressionPrefixPath("/pkg"));
      let appIds = Map.empty<Text, ()>();
      for (appId in retainedAppIds.vals()) {
        assert(CapabilityScope.validAppId(appId));
        assert(appId != "kernel");
        assert(Map.get(appIds, Text.compare, appId) == null);
        Map.add(appIds, Text.compare, appId, ());
        List.add(
          retainedPaths,
          expressionPrefixPath("/app/" # appId),
        );
      };
      let retained = List.empty<DetachedV2>();
      for (path in List.values(retainedPaths)) {
        switch (AuthenticatedForest.detach(forest, path)) {
          case (#ok(token)) {
            afterMutation();
            List.add(retained, token);
          };
          case (#err(#not_found)) {};
          case (#err(error)) {
            trapForest("detach retained response subtree", error);
          };
        };
      };

      let predecessor = switch (AuthenticatedForest.detach(
        forest,
        [httpExpr()],
      )) {
        case (#ok(token)) {
          afterMutation();
          token;
        };
        case (#err(error)) {
          trapForest("detach predecessor response namespace", error);
        };
      };

      switch (AuthenticatedForest.attachHttpExprQuarantineV316(
        forest,
        predecessor,
      )) {
        case (#ok) afterMutation();
        case (#err(error)) {
          trapForest("quarantine predecessor response namespace", error);
        };
      };

      for (token in List.values(retained)) {
        switch (AuthenticatedForest.attach(forest, token)) {
          case (#ok) afterMutation();
          case (#err(error)) {
            trapForest("reattach retained response subtree", error);
          };
        };
      };

      putLeaf(currentNotFoundPath);
      true;
    };

    // Reclaim a known Kernel asset's predecessor expression branch before its
    // current response is rebuilt. Unknown/orphan branches remain safely
    // quarantined, while ordinary upgrades do not duplicate all retained
    // Kernel response nodes against the finite forest arena.
    public func removeQuarantinedKernelStaticExpressionV316(
      url : Text,
    ) : () {
      assert(validCanonicalPath(url));
      let quarantinePath = kernelResponsePolicyV316QuarantinePath();
      let expressionPath = exactExpressionPath(url);
      assert(
        expressionPath.size() > 1 and
        expressionPath[0] == httpExpr()
      );
      let relative = Array.tabulate<Blob>(
        expressionPath.size() - 1,
        func(index) { expressionPath[index + 1] },
      );
      removeStaticBranch(
        appendPath(quarantinePath, relative),
        MAX_STATIC_ASSET_TREE_NODES,
        "quarantined Kernel static expression tree",
      );
    };

  };

  public class CertifiedHttp(
    certStore : CertifiedHttpMemory,
    forest : AuthenticatedForest.Memory,
  ) {
    let ct = CertTree.Ops(certStore);
    let chunked = Map.empty<Text, ChunkedCallback>();
    var publicationBatchPrior : ?Blob = null;
    var publicationBatchDepth : Nat = 0;
    var publicationBatchForestWorkStart : ?Nat = null;
    var publicationBatchAssetHashOperations : Nat = 0;

    func currentPublicationBatchWork() : ?Nat {
      let ?start = publicationBatchForestWorkStart else return null;
      let current = authenticatedForestMutationWork(forest.counters);
      if (current < start) {
        Runtime.trap(
          "Authenticated HTTP forest counters reset during publication batch",
        );
      };
      ?(current - start + publicationBatchAssetHashOperations);
    };

    func enforcePublicationBatchWorkBound() : () {
      let ?work = currentPublicationBatchWork() else return;
      if (not publicationBatchWorkAllowed(work)) {
        Runtime.trap(
          "HTTP certification publication batch exceeded its work bound",
        );
      };
    };

    func chargeAssetHashMutation() : () {
      if (publicationBatchDepth == 0) return;
      publicationBatchAssetHashOperations += 1;
      enforcePublicationBatchWorkBound();
    };

    public func publicationBatchWork() : ?Nat {
      currentPublicationBatchWork();
    };

    let publicTree : PersistentCertificationTree =
      PersistentCertificationTree(
        forest,
        enforcePublicationBatchWorkBound,
      );

    func forestRoot() : Blob {
      switch (AuthenticatedForest.rootHash(forest)) {
        case (?value) value;
        case null Runtime.trap("Authenticated HTTP forest is unavailable");
      };
    };

    func combinedRoot() : Blob {
      combinedCertificationRoot(ct.treeHash(), forestRoot());
    };

    func commitForest() : () {
      switch (AuthenticatedForest.commit(forest)) {
        case (#ok(_)) {};
        case (#err(error)) {
          Runtime.trap(
            "Authenticated HTTP forest commit failed: " #
            debug_show(error),
          );
        };
      };
    };

    func commitForestAndPublish(prior : Blob) : Bool {
      commitForest();
      let next = combinedRoot();
      if (next == prior) return false;
      CertifiedData.set(next);
      true;
    };

    func attachedMutationPrior() : Blob {
      switch (publicationBatchPrior) {
        case (?prior) prior;
        case null combinedRoot();
      };
    };

    func finishAttachedMutation(prior : Blob) : Bool {
      if (publicationBatchDepth > 0) return false;
      commitForestAndPublish(prior);
    };

    public func beginV2PublicationBatch() : () {
      if (publicationBatchDepth == 0) {
        assert(publicationBatchPrior == null);
        assert(publicationBatchForestWorkStart == null);
        publicationBatchPrior := ?combinedRoot();
        publicationBatchForestWorkStart := ?authenticatedForestMutationWork(
          forest.counters,
        );
        publicationBatchAssetHashOperations := 0;
      };
      publicationBatchDepth += 1;
    };

    public func finishV2PublicationBatch() : Bool {
      if (publicationBatchDepth == 0) {
        Runtime.trap("No HTTP certification publication batch is active");
      };
      enforcePublicationBatchWorkBound();
      publicationBatchDepth -= 1;
      if (publicationBatchDepth > 0) return false;
      let ?prior = publicationBatchPrior else {
        Runtime.trap("HTTP certification publication batch lost its root");
      };
      // Clear first; a trap rolls the entire canister message back.
      publicationBatchPrior := null;
      publicationBatchForestWorkStart := null;
      publicationBatchAssetHashOperations := 0;
      commitForestAndPublish(prior);
    };

    func publishAssetRootIfChanged(prior : Blob) : Bool {
      if (publicationBatchDepth > 0) return false;
      let next = combinedRoot();
      if (next == prior) return false;
      CertifiedData.set(next);
      true;
    };

    // Re-establishing the root is required on both init and post-upgrade.
    // The fixed wildcard 404 is response-only and safe because a more precise
    // exact/wildcard path must be proven absent before a gateway accepts it.
    public func initialize(
      notFoundHeaders : [HeaderField],
      notFoundBodyHash : Blob,
    ) : () {
      assert(hasExactExpression(notFoundHeaders, NOT_FOUND_EXPRESSION));
      switch (AuthenticatedForest.validateAndRestore(
        forest,
        Text.encodeUtf8(V2.responsePolicyTableCanonicalV1()),
        Allocator.layoutFingerprint(),
      )) {
        case (#ok(_)) {};
        case (#err(error)) {
          Runtime.trap(
            "Authenticated HTTP forest restore failed: " #
            debug_show(error),
          );
        };
      };
      let response = responseHash(notFoundHeaders, 404, notFoundBodyHash);
      let notFoundPath = notFoundLeafPath(response);
      switch (AuthenticatedForest.lookup(forest, notFoundPath)) {
        case (#found(value)) assert(value == emptyBlob());
        case (#absent) {
          switch (AuthenticatedForest.put(
            forest,
            notFoundPath,
            emptyBlob(),
          )) {
            case (#ok(_)) {};
            case (#err(error)) {
              Runtime.trap(
                "Authenticated HTTP 404 initialization failed: " #
                debug_show(error),
              );
            };
          };
          commitForest();
        };
        case (#err(error)) {
          Runtime.trap(
            "Authenticated HTTP 404 restore failed: " # debug_show(error),
          );
        };
      };
      // Certified data is not stable across upgrade. Restore the one canonical
      // combined root in O(1) after validating the persistent forest header.
      CertifiedData.set(combinedRoot());
    };

    public func chunkedSend(key : Text, chunkId : Nat, content : Blob) : () {
      switch (Map.get(chunked, Text.compare, key)) {
        case (?state) {
          if (state.last_chunk + 1 != chunkId) {
            chunkedClear(key);
            Runtime.trap("chunkedSend: non-sequential chunks are unsupported");
          };
          state.last_chunk := chunkId;
          state.chunks[chunkId] := ?content;
          state.sha.writeBlob(content);

          if (chunkId + 1 == state.max_chunks) {
            let hash = state.sha.sum();
            putHash(key, hash);
            let chunks = Array.tabulate<Blob>(
              state.max_chunks,
              func(index) : Blob {
                let ?chunk = state.chunks[index] else {
                  Runtime.trap("chunkedSend: missing chunk");
                };
                chunk;
              },
            );
            let done = state.done;
            chunkedClear(key);
            done(chunks, hash);
          };
        };
        case null Runtime.trap("chunkedSend without chunkedStart");
      };
    };

    public func chunkedStart(
      key : Text,
      chunks : Nat,
      content : Blob,
      done : ([Blob], Blob) -> (),
    ) : () {
      assert(chunks > 0);
      let firstHash = SHA256.fromBlob(#sha256, content);
      if (chunks == 1) {
        putHash(key, firstHash);
        done([content], firstHash);
        return;
      };

      chunkedClear(key);
      let state : ChunkedCallback = {
        max_chunks = chunks;
        chunks = VarArray.repeat<?Blob>(null, chunks);
        done;
        var last_chunk = 0;
        sha = SHA256.Digest(#sha256);
      };
      state.chunks[0] := ?content;
      state.sha.writeBlob(content);
      Map.add(chunked, Text.compare, key, state);
    };

    // Install begin uses this transient admission check to ensure an older
    // durable value at the same staging key cannot be journaled while its
    // multi-chunk replacement is still in flight.
    public func hasPendingChunked(key : Text) : Bool {
      switch (Map.get(chunked, Text.compare, key)) {
        case (?_) true;
        case null false;
      };
    };

    func chunkedClear(key : Text) : () {
      Map.remove(chunked, Text.compare, key);
    };

    // Keep the full-body hash for each stored asset. The public HTTP v2 tree
    // certifies that hash together with the exact request/response metadata.
    public func putHash(key : Text, value : Blob) : () {
      assert(value.size() == 32);
      chargeAssetHashMutation();
      let prior = attachedMutationPrior();
      ct.put([Text.encodeUtf8("http_assets"), Text.encodeUtf8(key)], value);
      ignore publishAssetRootIfChanged(prior);
    };

    public func put(key : Text, value : Blob) : () {
      putHash(key, SHA256.fromBlob(#sha256, value));
    };

    public func putChunks(key : Text, chunks : [Blob]) : () {
      putHash(key, hashChunks(chunks));
    };

    public func assetHash(key : Text) : ?Blob {
      ct.lookup([Text.encodeUtf8("http_assets"), Text.encodeUtf8(key)]);
    };

    public func publish(
      url : Text,
      bodyHash : Blob,
      variants : [CertificationVariant],
    ) : () {
      let prior = attachedMutationPrior();
      publicTree.publish(url, bodyHash, variants);
      enforcePublicationBatchWorkBound();
      if (variants.size() > 0) {
        ignore finishAttachedMutation(prior);
      };
    };

    // Validate the complete batch before touching the shared tree, then apply
    // every request-scoped replacement/deletion and commit the certified root
    // once. Callers retain ownership descriptors and submit the exact request
    // keys they own; this class never infers ownership from a URL prefix.
    public func apply(
      mutations : [Mutation],
    ) : () {
      if (mutations.size() == 0) return;
      let prior = attachedMutationPrior();
      publicTree.apply(mutations);
      enforcePublicationBatchWorkBound();
      ignore finishAttachedMutation(prior);
    };

    public func applyPublicOperations(
      mutations : [Mutation],
    ) : () {
      apply(mutations);
    };

    // Native Certified Assets batch hook. The mutation-only tree reports
    // whether the authenticated root actually changed, so detached/no-op work
    // performs no certified-data syscall and a changed batch performs one.
    public func applyV2(
      mutations : [V2Mutation],
    ) : Bool {
      if (mutations.size() == 0) return false;
      let prior = attachedMutationPrior();
      publicTree.applyV2(mutations);
      enforcePublicationBatchWorkBound();
      finishAttachedMutation(prior);
    };

    public func detachV2(
      basePath : Text,
      nextWildcard : [OwnerResponses],
    ) : DetachedV2 {
      let prior = attachedMutationPrior();
      let detached = publicTree.detachV2(
        basePath,
        nextWildcard,
      );
      enforcePublicationBatchWorkBound();
      ignore finishAttachedMutation(prior);
      detached;
    };

    public func attachV2(
      detached : DetachedV2,
      currentWildcard : [OwnerResponses],
    ) : Bool {
      let prior = attachedMutationPrior();
      publicTree.attachV2(detached, currentWildcard);
      enforcePublicationBatchWorkBound();
      finishAttachedMutation(prior);
    };

    public func applyDetachedV2(
      detached : DetachedV2,
      mutations : [V2Mutation],
    ) : (DetachedV2, Bool) {
      assert(publicationBatchDepth == 0);
      let prior = combinedRoot();
      let updated = publicTree.applyDetachedV2(detached, mutations);
      commitForest();
      // Detached-only mutations must not alter certified_data.
      assert(combinedRoot() == prior);
      (updated, updated.token_fingerprint != detached.token_fingerprint);
    };

    public func discardDetachedV2(detached : DetachedV2) : Bool {
      assert(publicationBatchDepth == 0);
      let prior = combinedRoot();
      publicTree.discardDetachedV2(detached);
      commitForest();
      assert(combinedRoot() == prior);
      true;
    };

    public func retireV2(inputs : [RetireMountV2]) : [DetachedV2] {
      if (inputs.size() == 0) return [];
      let prior = attachedMutationPrior();
      let detached = publicTree.retireV2(inputs);
      enforcePublicationBatchWorkBound();
      ignore finishAttachedMutation(prior);
      detached;
    };

    public func syncV2MountCatalog(
      id : Text,
      basePath : Text,
      detached : ?DetachedV2,
    ) : () {
      let prior = attachedMutationPrior();
      publicTree.syncMountCatalog(id, basePath, detached);
      enforcePublicationBatchWorkBound();
      ignore finishAttachedMutation(prior);
    };

    public func syncV2CollectionCatalog(
      id : Text,
      canonicalPath : Text,
      exact : Bool,
      detached : ?DetachedV2,
    ) : () {
      let prior = attachedMutationPrior();
      publicTree.syncCollectionCatalog(
        id,
        canonicalPath,
        exact,
        detached,
      );
      enforcePublicationBatchWorkBound();
      ignore finishAttachedMutation(prior);
    };

    public func v2MountCatalogMatches(
      id : Text,
      basePath : Text,
      detached : ?DetachedV2,
    ) : V2CatalogMatch {
      publicTree.mountCatalogMatches(id, basePath, detached);
    };

    public func v2CollectionCatalogMatches(
      id : Text,
      canonicalPath : Text,
      exact : Bool,
      detached : ?DetachedV2,
    ) : V2CatalogMatch {
      publicTree.collectionCatalogMatches(
        id,
        canonicalPath,
        exact,
        detached,
      );
    };

    public func v2CatalogSnapshot() : ?V2CatalogSnapshot {
      publicTree.catalogSnapshot();
    };

    public func removeV2MountCatalog(id : Text) : () {
      let prior = attachedMutationPrior();
      publicTree.removeMountCatalog(id);
      enforcePublicationBatchWorkBound();
      ignore finishAttachedMutation(prior);
    };

    public func removeV2CollectionCatalog(id : Text) : () {
      let prior = attachedMutationPrior();
      publicTree.removeCollectionCatalog(id);
      enforcePublicationBatchWorkBound();
      ignore finishAttachedMutation(prior);
    };

    public func replacePublicResponses(
      url : Text,
      variants : [ResponseCertificationVariant],
    ) : () {
      if (variants.size() == 0) return;
      apply([#replace({
        url;
        prior = Array.map<ResponseCertificationVariant, RequestOwner>(
          variants,
          responseOwner,
        );
        next = variants;
      })]);
    };

    public func deletePublicRequests(
      requests : [CertificationRequestKey],
    ) : () {
      if (requests.size() == 0) return;
      apply(Array.map<
        CertificationRequestKey,
        Mutation,
      >(
        requests,
        func(request) {
          assert(validRequestKey(request));
          #remove({
            url = request.url;
            requests = [{
              method = request.method;
              host = request.host;
            }];
          });
        },
      ));
    };

    // A local inspection primitive used by focused tree-isolation tests and
    // lifecycle reconciliation. It exposes no witness or mutation authority.
    public func hasPublicResponse(
      url : Text,
      variant : ResponseCertificationVariant,
    ) : Bool {
      publicTree.has(url, variant);
    };

    public func hasResidentResponse(
      url : Text,
      variant : ResidentResponseVariant,
    ) : Bool {
      publicTree.hasResident(url, variant);
    };

    public func hasV2Response(
      owner : V2RequestOwner,
      response : CertifiedResponse,
    ) : Bool {
      publicTree.hasV2Leaf(v2LeafKey(owner, response));
    };

    public func hasV2Leaf(key : V2LeafKey) : Bool {
      publicTree.hasV2Leaf(key);
    };

    public func cutoverKernelResponsePolicyV316(
      deploymentId : Text,
      retainedAppIds : [Text],
      notFoundHeaders : [HeaderField],
      notFoundBodyHash : Blob,
    ) : Bool {
      if (publicationBatchDepth == 0) {
        Runtime.trap(
          "Kernel response-policy cutover requires a publication batch",
        );
      };
      let changed = publicTree.cutoverKernelResponsePolicyV316(
        deploymentId,
        retainedAppIds,
        notFoundHeaders,
        notFoundBodyHash,
      );
      enforcePublicationBatchWorkBound();
      changed;
    };

    public func removeQuarantinedKernelStaticExpressionV316(
      url : Text,
    ) : () {
      if (publicationBatchDepth == 0) {
        Runtime.trap(
          "Quarantined Kernel response cleanup requires a publication batch",
        );
      };
      publicTree.removeQuarantinedKernelStaticExpressionV316(
        url,
      );
      enforcePublicationBatchWorkBound();
    };

    public func unpublish(url : Text) : () {
      let prior = attachedMutationPrior();
      publicTree.removeStaticExpressionTree(url);
      enforcePublicationBatchWorkBound();
      ignore finishAttachedMutation(prior);
    };

    public func delete(key : Text) : () {
      assert(V2.validCanonicalPath(key));
      chargeAssetHashMutation();
      let prior = attachedMutationPrior();
      ct.delete([Text.encodeUtf8("http_assets"), Text.encodeUtf8(key)]);
      publicTree.removeStaticExpressionTree(key);
      enforcePublicationBatchWorkBound();
      ignore finishAttachedMutation(prior);
    };

    // Delete only the stored body hash. Public http_expr ownership may be
    // shared by several certified Hosts at the same URL and must be removed
    // through request-scoped mutations instead.
    public func deleteAssetHash(key : Text) : () {
      chargeAssetHashMutation();
      let prior = attachedMutationPrior();
      ct.delete([Text.encodeUtf8("http_assets"), Text.encodeUtf8(key)]);
      ignore publishAssetRootIfChanged(prior);
    };

    // Delete one restored pre-V26 hash without feeding a now-invalid path into
    // current V2/legacy mutation admission. Empty path segments collapse in
    // the legacy expression tree, so that branch may be shared with a current
    // canonical sibling and must remain untouched here. The negative assertion
    // prevents this narrow compatibility path from becoming a live publisher.
    public func deleteRestoredLegacyStaticAssetHash(key : Text) : () {
      assert(not validCanonicalPath(key));
      deleteAssetHash(key);
    };

    public func pruneAll() : () {
      // Canister-signature state is intentionally not multiplexed into the
      // HTTP certification tree. The body-hash store contains http_assets only.
    };

    func certificateHeader(
      forestWitness : MerkleTree.Witness,
      expressionPath : [Text],
    ) : HeaderField {
      let certificate = switch (CertifiedData.getCertificate()) {
        case (?value) value;
        case null Runtime.trap("A data certificate is unavailable outside a query");
      };
      let assetsRoot = ct.treeHash();
      let witness = combinedHttpExprWitness(assetsRoot, forestWitness);
      assert(MerkleTree.reconstruct(witness) == combinedRoot());
      composeCertificateHeaderV2(
        certificate,
        ct.encodeWitness(witness),
        encodeExpressionPath(expressionPath),
      );
    };

    public func certificationHeader(
      url : Text,
      request : CertifiedRequest,
      responseHeaders : [HeaderField],
      bodyHash : Blob,
    ) : ?HeaderField {
      certificationHeaderForResponse(
        url,
        request,
        200,
        responseHeaders,
        bodyHash,
      );
    };

    public func certificationHeaderForResponse(
      url : Text,
      request : CertifiedRequest,
      statusCode : Nat16,
      responseHeaders : [HeaderField],
      bodyHash : Blob,
    ) : ?HeaderField {
      if (not V2.validCanonicalPath(url)) return null;
      if (not hasExactExpression(
        responseHeaders,
        HOST_BOUND_CERTIFICATION_EXPRESSION,
      )) {
        if (not hasExactExpression(
          responseHeaders,
          PORTABLE_CERTIFICATION_EXPRESSION,
        )) return null;
      };
      let portable = hasExactExpression(
        responseHeaders,
        PORTABLE_CERTIFICATION_EXPRESSION,
      );
      let leaf = publicLeafPath(
        url,
        if (portable) PORTABLE_CERTIFICATION_EXPRESSION
        else HOST_BOUND_CERTIFICATION_EXPRESSION,
        if (portable) portableRequestHash(request.method, request.body)
        else requestHash(request.method, request.headers, request.body),
        responseHash(responseHeaders, statusCode, bodyHash),
      );
      switch (AuthenticatedForest.witness(forest, leaf)) {
        case (#ok(result)) {
          if (result.lookup != #found(emptyBlob())) return null;
          ?certificateHeader(
            result.witness,
            exactExpressionTextPath(url),
          );
        };
        case (#err(_)) null;
      };
    };

    // Resident-origin leaves bind exact Host and Fetch Metadata authority.
    // Executable HTML additionally binds the kernel-authored query fields
    // selected by its CEL. Hash the actual request so duplicate headers or a
    // different selected query cannot reuse a committed response.
    public func residentCertificationHeader(
      canonicalPath : Text,
      requestUrl : Text,
      request : CertifiedRequest,
      responseHeaders : [HeaderField],
      bodyHash : Blob,
    ) : ?HeaderField {
      if (
        not V2.validCanonicalPath(canonicalPath) or
        request.method != "GET" or
        request.body.size() != 0 or bodyHash.size() != 32
      ) return null;
      let urlParts = Text.split(requestUrl, #char '?');
      let ?requestPath = urlParts.next() else return null;
      if (requestPath != canonicalPath) return null;

      func uniqueRequestHeader(expectedName : Text) : ?Text {
        var found : ?Text = null;
        for ((name, value) in request.headers.vals()) {
          if (Text.toLower(name) == expectedName) {
            if (found != null) return null;
            found := ?value;
          };
        };
        found;
      };
      let ?host = uniqueRequestHeader("host") else return null;
      if (host == "") return null;
      let ?destination =
        uniqueRequestHeader("sec-fetch-dest") else return null;

      let kind : ResidentRequestKind =
        if (hasExactExpression(
          responseHeaders,
          RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION,
        )) {
          if (destination == "iframe") {
            #installation_html_v1;
          } else if (not validResidentSubresourceDestination(destination)) {
            return null;
          } else {
            #subresource_v1({ destination });
          };
        } else if (hasExactExpression(
          responseHeaders,
          RESIDENT_HTML_CERTIFICATION_EXPRESSION,
        )) {
          if (destination != "iframe") return null;
          let ?canonicalQuery = selectedResidentQuery(requestUrl) else {
            return null;
          };
          if (not validResidentCanonicalQuery(canonicalQuery)) return null;
          #html_v1({ canonical_query = canonicalQuery });
        } else {
          return null;
        };
      let ?requestHash = residentRequestHashForRequest(
        kind,
        request.method,
        requestUrl,
        request.headers,
        request.body,
      ) else return null;
      let leaf = publicLeafPath(
        canonicalPath,
        residentCertificationExpression(kind),
        requestHash,
        responseHash(responseHeaders, 200, bodyHash),
      );
      switch (AuthenticatedForest.witness(forest, leaf)) {
        case (#ok(result)) {
          if (result.lookup != #found(emptyBlob())) return null;
          ?certificateHeader(
            result.witness,
            exactExpressionTextPath(canonicalPath),
          );
        };
        case (#err(_)) null;
      };
    };

    public func certificationHeaderV2(
      requestUrl : Text,
      request : CertifiedRequest,
      owner : V2RequestOwner,
      response : CertifiedResponse,
    ) : ?HeaderField {
      if (
        not validV2RequestOwner(owner) or
        not V2.validCanonicalPath(requestUrl) or
        request.method != owner.method or
        request.body.size() != 0 or
        SHA256.fromBlob(#sha256, request.body) != owner.empty_body_hash or
        not hasExactExpression(
          response.response_headers,
          owner.certification_expression,
        )
      ) return null;
      switch (owner.expression_kind) {
        case (#exact) {
          if (requestUrl != owner.canonical_path) return null;
        };
        case (#wildcard) {
          if (not wildcardOwns(owner.canonical_path, requestUrl)) return null;
        };
      };
      switch (owner.host_mode) {
        case (#exact(expected)) {
          var found = false;
          for ((name, value) in request.headers.vals()) {
            if (Text.toLower(name) == "host") {
              if (found or value != expected) return null;
              found := true;
            };
          };
          if (not found) return null;
        };
        case (#excluded) {};
      };
      certificationHeaderV2FromLeaf(
        requestUrl,
        request,
        v2LeafKey(owner, response),
      );
    };

    // Hot-path proof construction from mutation-time hashes. The caller
    // persists only keys returned by v2LeafKey for an accepted mutation.
    public func certificationHeaderV2FromLeaf(
      requestUrl : Text,
      request : CertifiedRequest,
      key : V2LeafKey,
    ) : ?HeaderField {
      let owner = key.owner;
      if (
        not validProofOwner(owner) or
        not V2.validCanonicalPath(requestUrl) or
        key.expression_hash.size() != 32 or
        key.request_hash.size() != 32 or
        key.response_hash.size() != 32 or
        key.expression_hash !=
          V2.certificationExpressionHash(owner.host_mode) or
        key.request_hash != proofRequestHash(owner) or
        request.method != owner.method or
        request.body.size() != 0
      ) return null;
      switch (owner.expression_kind) {
        case (#exact) {
          if (requestUrl != owner.canonical_path) return null;
        };
        case (#wildcard) {
          if (not wildcardOwns(owner.canonical_path, requestUrl)) return null;
        };
      };
      switch (owner.host_mode) {
        case (#exact(expected)) {
          var found = false;
          for ((name, value) in request.headers.vals()) {
            if (Text.toLower(name) == "host") {
              if (found or value != expected) return null;
              found := true;
            };
          };
          if (not found) return null;
        };
        case (#excluded) {};
      };
      let leaf = v2LeafPath(key);
      if (not publicTree.hasV2Leaf(key)) return null;
      let witness = switch (owner.expression_kind) {
        case (#exact) {
          switch (AuthenticatedForest.witness(forest, leaf)) {
            case (#ok(result)) {
              if (result.lookup != #found(emptyBlob())) return null;
              result.witness;
            };
            case (#err(_)) return null;
          };
        };
        case (#wildcard) {
          let ?value = wildcardWitnessAt(
            requestUrl,
            owner.canonical_path,
            leaf,
          ) else return null;
          value;
        };
      };
      ?certificateHeader(witness, proofExpressionTextPath(owner));
    };

    func wildcardWitnessAt(
      url : Text,
      baseUrl : Text,
      leaf : [Blob],
    ) : ?MerkleTree.Witness {
      let paths = List.empty<CertTree.Path>();
      List.add(paths, exactExpressionPath(url));
      List.add(paths, leaf);
      let segments = blobs(routeTextSegments(url));
      let baseSegments = blobs(routeTextSegments(baseUrl));

      func prefixIsBase(length : Nat) : Bool {
        if (length != baseSegments.size()) return false;
        var index = 0;
        while (index < length) {
          if (segments[index] != baseSegments[index]) return false;
          index += 1;
        };
        true;
      };

      func directoryIsBase(length : Nat) : Bool {
        if (
          length == 0 or length != baseSegments.size() or
          baseSegments[length - 1].size() != 0
        ) return false;
        var index = 0;
        while (index + 1 < length) {
          if (segments[index] != baseSegments[index]) return false;
          index += 1;
        };
        true;
      };

      var length = segments.size();
      while (length > 0 and not prefixIsBase(length)) {
        let prefix = Array.tabulate<Blob>(
          length,
          func(index) { segments[index] },
        );
        List.add(paths, appendPath(
          [httpExpr()],
          appendPath(prefix, [wildcardLabel()]),
        ));
        if (segments[length - 1].size() != 0) {
          let directory = List.empty<Blob>();
          List.add(directory, httpExpr());
          var index = 0;
          while (index + 1 < length) {
            List.add(directory, segments[index]);
            index += 1;
          };
          List.add(directory, emptyBlob());
          List.add(directory, wildcardLabel());
          if (not directoryIsBase(length)) {
            List.add(paths, List.toArray(directory));
          };
        };
        length -= 1;
      };
      switch (
        AuthenticatedForest.witnessMany(
          forest,
          List.toArray(paths),
        )
      ) {
        case (#ok(result)) ?result.witness;
        case (#err(_)) null;
      };
    };

    func wildcardWitness(
      url : Text,
      leaf : [Blob],
    ) : ?MerkleTree.Witness {
      let paths = List.empty<CertTree.Path>();
      List.add(paths, exactExpressionPath(url));
      List.add(paths, leaf);
      let segments = blobs(routeTextSegments(url));
      var length = segments.size();
      while (length > 0) {
        let prefix = Array.tabulate<Blob>(length, func(index) { segments[index] });
        List.add(paths, appendPath(
          [httpExpr()],
          appendPath(prefix, [wildcardLabel()]),
        ));
        if (segments[length - 1].size() != 0) {
          let directory = List.empty<Blob>();
          List.add(directory, httpExpr());
          var index = 0;
          while (index + 1 < length) {
            List.add(directory, segments[index]);
            index += 1;
          };
          List.add(directory, emptyBlob());
          List.add(directory, wildcardLabel());
          List.add(paths, List.toArray(directory));
        };
        length -= 1;
      };
      switch (
        AuthenticatedForest.witnessMany(
          forest,
          List.toArray(paths),
        )
      ) {
        case (#ok(result)) ?result.witness;
        case (#err(_)) null;
      };
    };

    public func notFoundCertificationHeader(
      url : Text,
      responseHeaders : [HeaderField],
      bodyHash : Blob,
    ) : ?HeaderField {
      if (
        not V2.validCanonicalPath(url) or
        not hasExactExpression(responseHeaders, NOT_FOUND_EXPRESSION)
      ) return null;
      let response = responseHash(responseHeaders, 404, bodyHash);
      let leaf = notFoundLeafPath(response);
      if (
        AuthenticatedForest.lookup(forest, leaf) !=
        #found(emptyBlob())
      ) return null;
      let ?witness = wildcardWitness(url, leaf) else return null;
      ?certificateHeader(
        witness,
        ["http_expr", "<*>"],
      );
    };
  };
};
