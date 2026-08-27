import Base64 "mo:core/Base64";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Text "mo:core/Text";
import SHA256 "mo:sha2/Sha256";
import GatewayAuthority "./http_routes/GatewayAuthority";

module {
  public type HeaderField = (Text, Text);

  // These two expressions are protocol constants. Do not pretty-print them:
  // their exact UTF-8 bytes are part of every response-certification leaf.
  public let HOST_BOUND_CERTIFICATION_EXPRESSION =
    "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[\"host\"],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";
  public let PORTABLE_CERTIFICATION_EXPRESSION =
    "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";
  public let RESIDENT_SUBRESOURCE_CERTIFICATION_EXPRESSION_V1 =
    "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[\"host\",\"sec-fetch-dest\"],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";
  public let RESIDENT_HTML_CERTIFICATION_EXPRESSION_V1 =
    "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[\"host\",\"sec-fetch-dest\"],certified_query_parameters:[\"app\",\"role\",\"installation-uid\",\"resident-frame-security\",\"browser-origin-nonce\",\"browser-origin-authority-epoch\"]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";

  // Closed response-policy table committed by the persistent authenticated
  // forest header.  Placeholders describe the only dynamic scalar positions;
  // header order, fixed values, status/method set, CEL, and Host policy are
  // exact protocol material. Changing any byte requires a new policy table
  // version and intentionally makes an old forest fail closed after upgrade.
  public func responsePolicyTableCanonicalV1() : Text {
    "neutron.certified-http.response-policy-table.v1\n" #
    "publication_inline_text|host=exact|methods=GET:200_or_206,HEAD:200|cel=" #
    HOST_BOUND_CERTIFICATION_EXPRESSION #
    "|headers=Content-Type:text/plain; charset=utf-8,Cache-Control:no-store,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',Accept-Ranges:bytes,ETag:{content_tag_hex_quoted},Content-Length:{decimal},Content-Range:{optional_bytes_range},IC-CertificateExpression:{cel}\n" #
    "publication_attachment|host=exact|methods=GET:200_or_206,HEAD:200|cel=" #
    HOST_BOUND_CERTIFICATION_EXPRESSION #
    "|headers=Content-Type:application/octet-stream,Content-Disposition:attachment; filename=\"{escaped_filename}\",Cache-Control:no-store,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',Accept-Ranges:bytes,ETag:{content_tag_hex_quoted},Content-Length:{decimal},Content-Range:{optional_bytes_range},IC-CertificateExpression:{cel}\n" #
    "immutable_blob|host=excluded|methods=GET:200|cel=" #
    PORTABLE_CERTIFICATION_EXPRESSION #
    "|headers=Content-Type:application/octet-stream,Content-Length:{decimal},Content-Digest:sha-256=:{base64_sha256}:,ETag:{sha256_hex_quoted},Cache-Control:public, max-age=31536000, immutable,Access-Control-Allow-Origin:*,Access-Control-Expose-Headers:IC-Certificate, IC-CertificateExpression, Content-Length, Content-Digest, ETag,Cross-Origin-Resource-Policy:cross-origin,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',IC-CertificateExpression:{cel}\n" #
    "mutable_blob|host=excluded|methods=GET:200|cel=" #
    PORTABLE_CERTIFICATION_EXPRESSION #
    "|headers=Content-Type:application/octet-stream,Content-Length:{decimal},Content-Digest:sha-256=:{base64_sha256}:,ETag:{sha256_hex_quoted},Cache-Control:no-cache, must-revalidate,Access-Control-Allow-Origin:*,Access-Control-Expose-Headers:IC-Certificate, IC-CertificateExpression, Content-Length, Content-Digest, ETag,Cross-Origin-Resource-Policy:cross-origin,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',IC-CertificateExpression:{cel}\n" #
    "host_bound_not_found|host=exact|methods=GET:404,HEAD:404|cel=" #
    HOST_BOUND_CERTIFICATION_EXPRESSION #
    "|headers=Content-Type:text/plain; charset=utf-8,Content-Length:0,Cache-Control:no-store,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',IC-CertificateExpression:{cel}\n" #
    "portable_not_found|host=excluded|methods=GET:404|cel=" #
    PORTABLE_CERTIFICATION_EXPRESSION #
    "|headers=Content-Type:application/octet-stream,Content-Length:0,Cache-Control:no-store,Access-Control-Allow-Origin:*,Access-Control-Expose-Headers:IC-Certificate, IC-CertificateExpression, Content-Length,Cross-Origin-Resource-Policy:cross-origin,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',IC-CertificateExpression:{cel}\n";
  };

  public func responsePolicyTableFingerprint() : Blob {
    SHA256.fromBlob(
      #sha256,
      Text.encodeUtf8(responsePolicyTableCanonicalV1()),
    );
  };

  public let CERTIFICATE_EXPRESSION_HEADER = "IC-CertificateExpression";
  public let CERTIFICATE_HEADER = "IC-Certificate";

  // The current provision, gateway, and kernel runtime policies all admit the
  // official 3 MiB non-replicated-query reply ceiling. Publication blocks stay
  // below it so the witness, headers, and Candid envelope have fixed headroom.
  public let CERTIFIED_HTTP_QUERY_REPLY_MAX_V2 : Nat = 3_145_728;
  public let CERTIFIED_HTTP_RESPONSE_SAFETY_MARGIN_V2 : Nat = 65_536;
  public let PUBLICATION_BLOCK_BYTES_MAX_V2 : Nat = 1_889_984;
  public let PUBLICATION_OBJECT_BYTES_MAX_V2 : Nat = 67_108_864;
  public let PUBLICATION_BLOCKS_MAX_V2 : Nat = 36;
  public let PORTABLE_BLOB_BODY_BYTES_MAX_V2 : Nat = 1_048_576;
  // Global/wildcard absence witnesses reveal at most two candidates per
  // segment plus the exact request and selected leaf. This cap keeps every
  // production proof within AuthenticatedForest.witnessMany's 32-path bound.
  public let CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2 : Nat = 14;
  // Keep URL labels within the authenticated forest's released per-label
  // bound. Total URL bytes are bounded separately by the HTTP router.
  public let CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2 : Nat = 1_024;

  public type HostMode = {
    #exact : Text;
    #excluded;
  };

  public type ExpressionKind = {
    #exact;
    #wildcard;
  };

  public type V2RequestOwner = {
    method : Text;
    canonical_path : Text;
    expression_kind : ExpressionKind;
    host_mode : HostMode;
    empty_body_hash : Blob;
    certification_expression : Text;
  };

  public type CertifiedResponse = {
    status_code : Nat16;
    response_headers : [HeaderField];
    body_hash : Blob;
  };

  public type ResponseMode = {
    #single;
    #range_chunks;
  };

  public type OwnerResponses = {
    owner : V2RequestOwner;
    response_mode : ResponseMode;
    responses : [CertifiedResponse];
  };

  public type ProofOwner = {
    method : Text;
    canonical_path : Text;
    expression_kind : ExpressionKind;
    host_mode : HostMode;
  };

  // Persist this compact key with a committed record/response alternative.
  // Query proof construction can then address the authenticated leaf without
  // re-rendering headers or recomputing request/response hashes.
  public type V2LeafKey = {
    owner : ProofOwner;
    expression_hash : Blob;
    request_hash : Blob;
    response_hash : Blob;
  };

  public type V2Mutation = {
    #replace : {
      // Exact committed leaves are persisted with each record. Deleting those
      // leaves keeps the persistent authenticated forest bounded and avoids
      // discovering or recursively dropping an unbounded request subtree.
      prior : [V2LeafKey];
      next : [OwnerResponses];
    };
    #remove : {
      leaves : [V2LeafKey];
    };
    // Removes the authenticated expression subtree rooted at one declared app
    // route in logarithmic work, then optionally installs the mount's fixed
    // wildcard absence owners beneath the now-empty prefix.
    #detach_prefix : {
      base_path : Text;
      next_wildcard : [OwnerResponses];
    };
  };

  public type PublicationPresentation = {
    #inline_text;
    #attachment : { filename : Text };
  };

  public type PublicationBlock = {
    length : Nat;
    body_hash : Blob;
  };

  public type PublicationObject = {
    canonical_path : Text;
    host : Text;
    presentation : PublicationPresentation;
    content_tag : Blob;
    blocks : [PublicationBlock];
  };

  public type PublicationMethod = { #get; #head };

  public type SelectedPublicationResponse = {
    owner : V2RequestOwner;
    response : CertifiedResponse;
    // Present only for GET. Body lookup reads exactly this stored block.
    block_index : ?Nat;
  };

  public type ResolvedPublicationBlock = {
    index : Nat;
    offset : Nat;
    length : Nat;
    body_hash : Blob;
  };

  // Query-time metadata after storage has selected and materialized at most
  // one block. This avoids loading every block merely to reconstruct headers.
  public type ResolvedPublicationObject = {
    canonical_path : Text;
    host : Text;
    presentation : PublicationPresentation;
    content_tag : Blob;
    total_length : Nat;
    method : PublicationMethod;
    selected_block : ?ResolvedPublicationBlock;
  };

  public type PortableBlobPolicy = {
    #immutable;
    #mutable;
  };

  public type PortableBlobObject = {
    canonical_path : Text;
    policy : PortableBlobPolicy;
    body_hash : Blob;
    body_length : Nat;
  };

  public type AbsenceAuthority = {
    #host_bound : { host : Text };
    #portable;
  };

  public type Absence = {
    base_path : Text;
    authority : AbsenceAuthority;
  };

  public type RenderError = {
    #invalid_path;
    #invalid_host;
    #invalid_filename;
    #invalid_hash;
    #invalid_geometry;
    #invalid_range;
    #too_large;
  };

  public type RenderResult<T> = {
    #ok : T;
    #err : RenderError;
  };

  public type ParsedRange = {
    #absent;
    #valid : Nat;
    #unsupported;
  };

  public type CertificateVersionDecision = {
    #v2;
    #reject;
  };

  let HEX = [
    "0", "1", "2", "3", "4", "5", "6", "7",
    "8", "9", "a", "b", "c", "d", "e", "f",
  ];
  let MAX_PINNED_RANGE_START : Nat = 4_294_967_295;

  public func emptyBodyHash() : Blob {
    SHA256.fromBlob(#sha256, Blob.fromArray([]));
  };

  let PUBLICATION_COMMON_HEADERS : [HeaderField] = [
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Permissions-Policy", "camera=(), geolocation=(), microphone=()"),
    (
      "Content-Security-Policy",
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    ),
    ("Accept-Ranges", "bytes"),
  ];

  let PORTABLE_CORS_AND_SECURITY_HEADERS : [HeaderField] = [
    ("Access-Control-Allow-Origin", "*"),
    (
      "Access-Control-Expose-Headers",
      "IC-Certificate, IC-CertificateExpression, Content-Length, Content-Digest, ETag",
    ),
    ("Cross-Origin-Resource-Policy", "cross-origin"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Permissions-Policy", "camera=(), geolocation=(), microphone=()"),
    (
      "Content-Security-Policy",
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    ),
  ];

  let PORTABLE_ABSENCE_CORS_AND_SECURITY_HEADERS : [HeaderField] = [
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
  ];

  public func certificateVersionDecision(
    maximumVersion : ?Nat16,
  ) : CertificateVersionDecision {
    switch (maximumVersion) {
      case (?version) {
        if (version >= 2) #v2 else #reject;
      };
      case null #reject;
    };
  };

  public func supportsCertificateVersion(
    maximumVersion : ?Nat16,
  ) : Bool {
    certificateVersionDecision(maximumVersion) == #v2;
  };

  public func certificationExpression(hostMode : HostMode) : Text {
    switch (hostMode) {
      case (#exact(_)) HOST_BOUND_CERTIFICATION_EXPRESSION;
      case (#excluded) PORTABLE_CERTIFICATION_EXPRESSION;
    };
  };

  public func certificationExpressionHash(hostMode : HostMode) : Blob {
    SHA256.fromBlob(
      #sha256,
      Text.encodeUtf8(certificationExpression(hostMode)),
    );
  };

  public func requestOwner(
    method : Text,
    canonicalPath : Text,
    expressionKind : ExpressionKind,
    hostMode : HostMode,
  ) : V2RequestOwner {
    {
      method;
      canonical_path = canonicalPath;
      expression_kind = expressionKind;
      host_mode = hostMode;
      empty_body_hash = emptyBodyHash();
      certification_expression = certificationExpression(hostMode);
    };
  };

  public func lowercaseHex(value : Blob) : Text {
    var result = "";
    for (byte in value.vals()) {
      let natural = Nat8.toNat(byte);
      result #= HEX[natural / 16] # HEX[natural % 16];
    };
    result;
  };

  public func validAttachmentFilename(value : Text) : Bool {
    let bytes = Text.encodeUtf8(value);
    if (
      bytes.size() < 1 or bytes.size() > 100 or
      value == "." or value == ".."
    ) return false;
    for (byte in bytes.vals()) {
      let n = Nat8.toNat(byte);
      if (not (
        (n >= 65 and n <= 90) or
        (n >= 97 and n <= 122) or
        (n >= 48 and n <= 57) or
        n == 46 or n == 95 or n == 45
      )) return false;
    };
    true;
  };

  public func attachmentDisposition(filename : Text) : ?Text {
    if (not validAttachmentFilename(filename)) return null;
    ?("attachment; filename=\"" # filename # "\"");
  };

  public func validCanonicalPath(path : Text) : Bool {
    if (
      path == "" or not Text.startsWith(path, #char '/') or
      Text.contains(path, #char '?') or
      Text.contains(path, #char '#') or
      Text.contains(path, #char '%') or
      Text.contains(path, #char '\\') or
      Text.contains(path, #text "//")
    ) return false;
    for (char in path.chars()) {
      if (char < ' ' or char == '\u{7f}') return false;
    };
    var segments = 0;
    for (segment in Text.split(path, #char '/')) {
      if (segment == "." or segment == "..") return false;
      if (segment != "") {
        if (
          Text.encodeUtf8(segment).size() >
          CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2
        ) return false;
        segments += 1;
        if (segments > CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2) return false;
      };
    };
    true;
  };

  public func validWildcardBase(path : Text) : Bool {
    validCanonicalPath(path) and
    (path == "/" or not Text.endsWith(path, #char '/'));
  };

  public func validDetachableBase(path : Text) : Bool {
    validWildcardBase(path) and path != "/" and
    Text.contains(path, #text "/_route/");
  };

  func finalPathSegment(path : Text) : ?Text {
    if (Text.endsWith(path, #char '/')) return null;
    var result : ?Text = null;
    for (segment in Text.split(path, #char '/')) {
      if (segment != "") result := ?segment;
    };
    result;
  };

  func validHost(host : Text) : Bool {
    GatewayAuthority.parseCanonical(host) != null;
  };

  func appendHeaders(
    target : List.List<HeaderField>,
    source : [HeaderField],
  ) : () {
    for (header in source.vals()) List.add(target, header);
  };

  func publicationHeaders(
    presentation : PublicationPresentation,
    contentTag : Blob,
    contentLength : Nat,
    contentRange : ?Text,
  ) : RenderResult<[HeaderField]> {
    let headers = List.empty<HeaderField>();
    switch (presentation) {
      case (#inline_text) {
        List.add(headers, ("Content-Type", "text/plain; charset=utf-8"));
      };
      case (#attachment({ filename })) {
        let ?disposition = attachmentDisposition(filename) else {
          return #err(#invalid_filename);
        };
        List.add(headers, ("Content-Type", "application/octet-stream"));
        List.add(headers, ("Content-Disposition", disposition));
      };
    };
    appendHeaders(headers, PUBLICATION_COMMON_HEADERS);
    List.add(headers, ("ETag", "\"" # lowercaseHex(contentTag) # "\""));
    List.add(headers, ("Content-Length", Nat.toText(contentLength)));
    switch (contentRange) {
      case (?value) List.add(headers, ("Content-Range", value));
      case null {};
    };
    List.add(
      headers,
      (
        CERTIFICATE_EXPRESSION_HEADER,
        HOST_BOUND_CERTIFICATION_EXPRESSION,
      ),
    );
    #ok(List.toArray(headers));
  };

  func validatePublicationObject(
    input : PublicationObject,
  ) : RenderResult<Nat> {
    if (not validCanonicalPath(input.canonical_path)) {
      return #err(#invalid_path);
    };
    let ?filename = finalPathSegment(input.canonical_path) else {
      return #err(#invalid_path);
    };
    if (not validAttachmentFilename(filename)) {
      return #err(#invalid_filename);
    };
    switch (input.presentation) {
      case (#inline_text) {};
      case (#attachment(value)) {
        if (value.filename != filename) return #err(#invalid_filename);
      };
    };
    if (not validHost(input.host)) return #err(#invalid_host);
    if (input.content_tag.size() != 32) return #err(#invalid_hash);
    if (
      input.blocks.size() < 1 or
      input.blocks.size() > PUBLICATION_BLOCKS_MAX_V2
    ) return #err(#invalid_geometry);

    var total = 0;
    var nonemptyBlocks = 0;
    for (block in input.blocks.vals()) {
      if (block.body_hash.size() != 32) return #err(#invalid_hash);
      if (block.length > PUBLICATION_BLOCK_BYTES_MAX_V2) {
        return #err(#too_large);
      };
      if (block.length > 0) nonemptyBlocks += 1;
      total += block.length;
      if (total > PUBLICATION_OBJECT_BYTES_MAX_V2) return #err(#too_large);
    };
    if (
      (total == 0 and input.blocks.size() != 1) or
      (total > 0 and nonemptyBlocks != input.blocks.size())
    ) return #err(#invalid_geometry);
    if (
      total == 0 and input.blocks[0].body_hash != emptyBodyHash()
    ) return #err(#invalid_hash);
    #ok(total);
  };

  public func publicationOwnerResponses(
    input : PublicationObject,
  ) : RenderResult<[OwnerResponses]> {
    let total = switch (validatePublicationObject(input)) {
      case (#ok(value)) value;
      case (#err(error)) return #err(error);
    };

    let hostMode : HostMode = #exact(input.host);
    let getResponses = List.empty<CertifiedResponse>();
    if (input.blocks.size() == 1) {
      let block = input.blocks[0];
      let #ok(headers) = publicationHeaders(
        input.presentation,
        input.content_tag,
        block.length,
        null,
      ) else return #err(#invalid_filename);
      List.add(getResponses, {
        status_code = Nat.toNat16(200);
        response_headers = headers;
        body_hash = block.body_hash;
      });
    } else {
      var start = 0;
      for (block in input.blocks.vals()) {
        let end = Nat.sub(start + block.length, 1);
        let #ok(headers) = publicationHeaders(
          input.presentation,
          input.content_tag,
          block.length,
          ?(
            "bytes " # Nat.toText(start) # "-" # Nat.toText(end) #
            "/" # Nat.toText(total)
          ),
        ) else return #err(#invalid_filename);
        List.add(getResponses, {
          status_code = Nat.toNat16(206);
          response_headers = headers;
          body_hash = block.body_hash;
        });
        start += block.length;
      };
    };

    let #ok(headHeaders) = publicationHeaders(
      input.presentation,
      input.content_tag,
      total,
      null,
    ) else return #err(#invalid_filename);
    #ok([
      {
        owner = requestOwner(
          "GET",
          input.canonical_path,
          #exact,
          hostMode,
        );
        response_mode = if (input.blocks.size() == 1) {
          #single;
        } else {
          #range_chunks;
        };
        responses = List.toArray(getResponses);
      },
      {
        owner = requestOwner(
          "HEAD",
          input.canonical_path,
          #exact,
          hostMode,
        );
        response_mode = #single;
        responses = [{
          status_code = 200;
          response_headers = headHeaders;
          body_hash = emptyBodyHash();
        }];
      },
    ]);
  };

  public func resolvedPublicationResponse(
    input : ResolvedPublicationObject,
  ) : RenderResult<SelectedPublicationResponse> {
    if (not validCanonicalPath(input.canonical_path)) {
      return #err(#invalid_path);
    };
    let ?filename = finalPathSegment(input.canonical_path) else {
      return #err(#invalid_path);
    };
    if (not validAttachmentFilename(filename)) {
      return #err(#invalid_filename);
    };
    switch (input.presentation) {
      case (#inline_text) {};
      case (#attachment(value)) {
        if (value.filename != filename) return #err(#invalid_filename);
      };
    };
    if (not validHost(input.host)) return #err(#invalid_host);
    if (input.content_tag.size() != 32) return #err(#invalid_hash);
    if (input.total_length > PUBLICATION_OBJECT_BYTES_MAX_V2) {
      return #err(#too_large);
    };
    let hostMode : HostMode = #exact(input.host);

    switch (input.method) {
      case (#head) {
        if (input.selected_block != null) return #err(#invalid_geometry);
        let headers = switch (publicationHeaders(
          input.presentation,
          input.content_tag,
          input.total_length,
          null,
        )) {
          case (#ok(value)) value;
          case (#err(error)) return #err(error);
        };
        #ok({
          owner = requestOwner(
            "HEAD",
            input.canonical_path,
            #exact,
            hostMode,
          );
          response = {
            status_code = 200;
            response_headers = headers;
            body_hash = emptyBodyHash();
          };
          block_index = null;
        });
      };
      case (#get) {
        let ?block = input.selected_block else {
          return #err(#invalid_geometry);
        };
        if (
          block.body_hash.size() != 32 or
          block.index >= PUBLICATION_BLOCKS_MAX_V2 or
          block.length > PUBLICATION_BLOCK_BYTES_MAX_V2 or
          block.offset > input.total_length or
          block.length > Nat.sub(input.total_length, block.offset)
        ) return #err(#invalid_geometry);
        if (
          input.total_length == 0 and (
            block.index != 0 or block.offset != 0 or block.length != 0 or
            block.body_hash != emptyBodyHash()
          )
        ) return #err(#invalid_geometry);
        if (
          input.total_length > 0 and block.length == 0
        ) return #err(#invalid_geometry);

        let single =
          block.index == 0 and block.offset == 0 and
          block.length == input.total_length;
        let contentRange = if (single) {
          null;
        } else {
          ?(
            "bytes " # Nat.toText(block.offset) # "-" #
            Nat.toText(Nat.sub(block.offset + block.length, 1)) # "/" #
            Nat.toText(input.total_length)
          );
        };
        let headers = switch (publicationHeaders(
          input.presentation,
          input.content_tag,
          block.length,
          contentRange,
        )) {
          case (#ok(value)) value;
          case (#err(error)) return #err(error);
        };
        #ok({
          owner = requestOwner(
            "GET",
            input.canonical_path,
            #exact,
            hostMode,
          );
          response = {
            status_code = if (single) 200 else 206;
            response_headers = headers;
            body_hash = block.body_hash;
          };
          block_index = ?block.index;
        });
      };
    };
  };

  public func selectPublicationResponse(
    input : PublicationObject,
    method : PublicationMethod,
    requestHeaders : [HeaderField],
  ) : RenderResult<SelectedPublicationResponse> {
    let total = switch (validatePublicationObject(input)) {
      case (#ok(value)) value;
      case (#err(error)) return #err(error);
    };
    let lengths = List.empty<Nat>();
    for (block in input.blocks.vals()) {
      List.add(lengths, block.length);
    };
    let ?rangeBlock = selectPublicationBlock(
      requestHeaders,
      List.toArray(lengths),
    ) else return #err(#invalid_range);
    switch (method) {
      case (#head) {
        resolvedPublicationResponse({
          canonical_path = input.canonical_path;
          host = input.host;
          presentation = input.presentation;
          content_tag = input.content_tag;
          total_length = total;
          method = #head;
          selected_block = null;
        });
      };
      case (#get) {
        let index = rangeBlock;
        var start = 0;
        var cursor = 0;
        while (cursor < index) {
          start += input.blocks[cursor].length;
          cursor += 1;
        };
        let block = input.blocks[index];
        resolvedPublicationResponse({
          canonical_path = input.canonical_path;
          host = input.host;
          presentation = input.presentation;
          content_tag = input.content_tag;
          total_length = total;
          method = #get;
          selected_block = ?{
            index;
            offset = start;
            length = block.length;
            body_hash = block.body_hash;
          };
        });
      };
    };
  };

  func portableBlobCache(policy : PortableBlobPolicy) : Text {
    switch (policy) {
      case (#immutable) {
        "public, max-age=31536000, immutable";
      };
      case (#mutable) {
        "no-cache, must-revalidate";
      };
    };
  };

  public func portableBlobOwnerResponses(
    input : PortableBlobObject,
  ) : RenderResult<OwnerResponses> {
    if (not validCanonicalPath(input.canonical_path)) {
      return #err(#invalid_path);
    };
    if (input.body_hash.size() != 32) return #err(#invalid_hash);
    if (input.body_length > PORTABLE_BLOB_BODY_BYTES_MAX_V2) {
      return #err(#too_large);
    };
    let headers = List.empty<HeaderField>();
    List.add(headers, ("Content-Type", "application/octet-stream"));
    List.add(headers, ("Content-Length", Nat.toText(input.body_length)));
    List.add(
      headers,
      (
        "Content-Digest",
        "sha-256=:" # Base64.encode(input.body_hash) # ":",
      ),
    );
    List.add(
      headers,
      ("ETag", "\"" # lowercaseHex(input.body_hash) # "\""),
    );
    List.add(headers, ("Cache-Control", portableBlobCache(input.policy)));
    appendHeaders(headers, PORTABLE_CORS_AND_SECURITY_HEADERS);
    List.add(
      headers,
      (
        CERTIFICATE_EXPRESSION_HEADER,
        PORTABLE_CERTIFICATION_EXPRESSION,
      ),
    );
    #ok({
      owner = requestOwner(
        "GET",
        input.canonical_path,
        #exact,
        #excluded,
      );
      response_mode = #single;
      responses = [{
        status_code = 200;
        response_headers = List.toArray(headers);
        body_hash = input.body_hash;
      }];
    });
  };

  public func absenceOwnerResponses(
    input : Absence,
  ) : RenderResult<[OwnerResponses]> {
    if (not validWildcardBase(input.base_path)) {
      return #err(#invalid_path);
    };
    switch (input.authority) {
      case (#host_bound({ host })) {
        if (not validHost(host)) return #err(#invalid_host);
        let headers = List.empty<HeaderField>();
        List.add(headers, ("Content-Type", "text/plain; charset=utf-8"));
        List.add(headers, ("Content-Length", "0"));
        List.add(headers, ("Cache-Control", "no-store"));
        List.add(headers, ("X-Content-Type-Options", "nosniff"));
        List.add(headers, ("Referrer-Policy", "no-referrer"));
        List.add(
          headers,
          ("Permissions-Policy", "camera=(), geolocation=(), microphone=()"),
        );
        List.add(
          headers,
          (
            "Content-Security-Policy",
            "sandbox; default-src 'none'; frame-ancestors 'none'",
          ),
        );
        List.add(
          headers,
          (
            CERTIFICATE_EXPRESSION_HEADER,
            HOST_BOUND_CERTIFICATION_EXPRESSION,
          ),
        );
        let response : CertifiedResponse = {
          status_code = 404;
          response_headers = List.toArray(headers);
          body_hash = emptyBodyHash();
        };
        #ok([
          {
            owner = requestOwner(
              "GET",
              input.base_path,
              #wildcard,
              #exact(host),
            );
            response_mode = #single;
            responses = [response];
          },
          {
            owner = requestOwner(
              "HEAD",
              input.base_path,
              #wildcard,
              #exact(host),
            );
            response_mode = #single;
            responses = [response];
          },
        ]);
      };
      case (#portable) {
        let headers = List.empty<HeaderField>();
        List.add(headers, ("Content-Type", "application/octet-stream"));
        List.add(headers, ("Content-Length", "0"));
        List.add(headers, ("Cache-Control", "no-store"));
        appendHeaders(headers, PORTABLE_ABSENCE_CORS_AND_SECURITY_HEADERS);
        List.add(
          headers,
          (
            CERTIFICATE_EXPRESSION_HEADER,
            PORTABLE_CERTIFICATION_EXPRESSION,
          ),
        );
        #ok([{
          owner = requestOwner(
            "GET",
            input.base_path,
            #wildcard,
            #excluded,
          );
          response_mode = #single;
          responses = [{
            status_code = 404;
            response_headers = List.toArray(headers);
            body_hash = emptyBodyHash();
          }];
        }]);
      };
    };
  };

  func strictNat(value : Text) : ?Nat {
    if (value == "") return null;
    var result = 0;
    for (char in value.chars()) {
      if (char < '0' or char > '9') return null;
      result :=
        result * 10 +
        Nat32.toNat(Char.toNat32(char) - Char.toNat32('0'));
    };
    ?result;
  };

  func parseContentRange(
    value : Text,
  ) : ?{ start : Nat; end : Nat; total : Nat } {
    let ?rangeAndTotal = Text.stripStart(value, #text "bytes ") else {
      return null;
    };
    let slash = Text.split(rangeAndTotal, #char '/');
    let ?range = slash.next() else return null;
    let ?totalText = slash.next() else return null;
    if (slash.next() != null) return null;
    let dash = Text.split(range, #char '-');
    let ?startText = dash.next() else return null;
    let ?endText = dash.next() else return null;
    if (dash.next() != null) return null;
    let ?start = strictNat(startText) else return null;
    let ?end = strictNat(endText) else return null;
    let ?total = strictNat(totalText) else return null;
    if (end < start) return null;
    ?{ start; end; total };
  };

  func lowercaseHexNibble(byte : Nat8) : ?Nat8 {
    let value = Nat8.toNat(byte);
    if (value >= 48 and value <= 57) {
      ?Nat.toNat8(value - 48);
    } else if (value >= 97 and value <= 102) {
      ?Nat.toNat8(value - 87);
    } else {
      null;
    };
  };

  func parseQuotedSha256Etag(value : Text) : ?Blob {
    let bytes = Text.encodeUtf8(value);
    if (
      bytes.size() != 66 or
      bytes[0] != 34 or
      bytes[65] != 34
    ) return null;
    let digest = List.empty<Nat8>();
    var index = 1;
    while (index < 65) {
      let ?high = lowercaseHexNibble(bytes[index]) else return null;
      let ?low = lowercaseHexNibble(bytes[index + 1]) else return null;
      List.add(
        digest,
        Nat.toNat8(Nat8.toNat(high) * 16 + Nat8.toNat(low)),
      );
      index += 2;
    };
    ?Array.toBlob(List.toArray(digest));
  };

  func validQuotedSha256Etag(value : Text) : Bool {
    parseQuotedSha256Etag(value) != null;
  };

  func exactHeader(
    headers : [HeaderField],
    index : Nat,
    name : Text,
    value : Text,
  ) : Bool {
    headers[index] == (name, value);
  };

  func canonicalNat(value : Text) : ?Nat {
    let ?parsed = strictNat(value) else return null;
    if (Nat.toText(parsed) != value) return null;
    ?parsed;
  };

  func publicationPresentation(
    headers : [HeaderField],
    canonicalPath : Text,
  ) : ?{
    presentation : PublicationPresentation;
    common_start : Nat;
  } {
    let ?filename = finalPathSegment(canonicalPath) else return null;
    if (not validAttachmentFilename(filename) or headers.size() < 1) {
      return null;
    };
    if (
      headers[0] ==
      ("Content-Type", "text/plain; charset=utf-8")
    ) {
      ?{
        presentation = #inline_text;
        common_start = 1;
      };
    } else {
      let ?disposition = attachmentDisposition(filename) else return null;
      if (
        headers.size() < 2 or
        headers[0] != ("Content-Type", "application/octet-stream") or
        headers[1] != ("Content-Disposition", disposition)
      ) return null;
      ?{
        presentation = #attachment({ filename });
        common_start = 2;
      };
    };
  };

  func validSinglePublicationResponse(
    owner : V2RequestOwner,
    response : CertifiedResponse,
  ) : Bool {
    if (
      owner.expression_kind != #exact or
      not validCanonicalPath(owner.canonical_path) or
      owner.certification_expression !=
        HOST_BOUND_CERTIFICATION_EXPRESSION
    ) return false;
    let #exact(host) = owner.host_mode else return false;
    if (not validHost(host)) return false;
    if (owner.method != "GET" and owner.method != "HEAD") return false;

    let headers = response.response_headers;
    let ?headerPolicy = publicationPresentation(
      headers,
      owner.canonical_path,
    ) else return false;
    if (headers.size() != headerPolicy.common_start + 9) return false;
    let ?contentTag = parseQuotedSha256Etag(
      headers[headerPolicy.common_start + 6].1,
    ) else return false;
    let ?length = canonicalNat(
      headers[headerPolicy.common_start + 7].1,
    ) else {
      return false;
    };
    let (method, selectedBlock) : (
      PublicationMethod,
      ?ResolvedPublicationBlock,
    ) = if (owner.method == "GET") {
      (
        #get,
        ?{
          index = 0;
          offset = 0;
          length;
          body_hash = response.body_hash;
        },
      );
    } else {
      (#head, null);
    };
    switch (resolvedPublicationResponse({
      canonical_path = owner.canonical_path;
      host;
      presentation = headerPolicy.presentation;
      content_tag = contentTag;
      total_length = length;
      method;
      selected_block = selectedBlock;
    })) {
      case (#ok(expected)) {
        expected.owner == owner and expected.response == response;
      };
      case (#err(_)) false;
    };
  };

  func validSinglePortableBlobResponse(
    owner : V2RequestOwner,
    response : CertifiedResponse,
  ) : Bool {
    if (
      owner.method != "GET" or owner.expression_kind != #exact or
      not validCanonicalPath(owner.canonical_path) or
      owner.host_mode != #excluded or
      owner.certification_expression != PORTABLE_CERTIFICATION_EXPRESSION
    ) return false;
    let headers = response.response_headers;
    if (headers.size() != 13) return false;
    let ?length = canonicalNat(headers[1].1) else return false;
    let policy : PortableBlobPolicy = if (
      headers[4] ==
      ("Cache-Control", "public, max-age=31536000, immutable")
    ) {
      #immutable;
    } else if (
      headers[4] == ("Cache-Control", "no-cache, must-revalidate")
    ) {
      #mutable;
    } else {
      return false;
    };
    switch (portableBlobOwnerResponses({
      canonical_path = owner.canonical_path;
      policy;
      body_hash = response.body_hash;
      body_length = length;
    })) {
      case (#ok(expected)) expected == {
        owner;
        response_mode = #single;
        responses = [response];
      };
      case (#err(_)) false;
    };
  };

  func validSingleAbsenceResponse(
    owner : V2RequestOwner,
    response : CertifiedResponse,
  ) : Bool {
    if (
      owner.expression_kind != #wildcard or
      not validWildcardBase(owner.canonical_path)
    ) return false;
    let authority : AbsenceAuthority = switch (owner.host_mode) {
      case (#exact(host)) {
        if (response.response_headers.size() != 8) return false;
        #host_bound({ host });
      };
      case (#excluded) {
        if (response.response_headers.size() != 11) return false;
        #portable;
      };
    };
    let #ok(expected) = absenceOwnerResponses({
      base_path = owner.canonical_path;
      authority;
    }) else return false;
    for (candidate in expected.vals()) {
      if (candidate == {
        owner;
        response_mode = #single;
        responses = [response];
      }) return true;
    };
    false;
  };

  // Revalidate every closed single-response shape at the authenticated-tree
  // boundary by reconstructing it through the only renderer that may create
  // that policy. The mode tag alone grants no response-policy authority.
  public func validClosedSingleResponseSet(
    set : OwnerResponses,
  ) : Bool {
    if (
      set.response_mode != #single or set.responses.size() != 1 or
      set.owner.empty_body_hash != emptyBodyHash()
    ) return false;
    let response = set.responses[0];
    if (response.body_hash.size() != 32) return false;
    if (response.status_code == 404) {
      validSingleAbsenceResponse(set.owner, response);
    } else {
      switch (set.owner.host_mode) {
        case (#exact(_)) {
          validSinglePublicationResponse(set.owner, response);
        };
        case (#excluded) {
          validSinglePortableBlobResponse(set.owner, response);
        };
      };
    };
  };

  // The response-set tag is not trusted by itself. Revalidate the complete
  // closed publication range policy at the tree boundary so an internal caller
  // cannot certify unrelated alternatives merely by choosing #range_chunks.
  public func validPublicationRangeResponseSet(
    set : OwnerResponses,
  ) : Bool {
    if (
      set.response_mode != #range_chunks or
      set.owner.method != "GET" or
      set.owner.expression_kind != #exact or
      set.owner.certification_expression !=
        HOST_BOUND_CERTIFICATION_EXPRESSION or
      set.responses.size() < 2 or
      set.responses.size() > PUBLICATION_BLOCKS_MAX_V2
    ) return false;
    switch (set.owner.host_mode) {
      case (#exact(host)) {
        if (not validHost(host)) return false;
      };
      case (#excluded) return false;
    };

    let ?routeFilename = finalPathSegment(set.owner.canonical_path) else {
      return false;
    };
    let firstHeaders = set.responses[0].response_headers;
    if (firstHeaders.size() < 1) return false;
    let commonStart = if (
      firstHeaders[0] ==
      ("Content-Type", "text/plain; charset=utf-8")
    ) {
      1;
    } else {
      let ?disposition = attachmentDisposition(routeFilename) else {
        return false;
      };
      if (
        firstHeaders.size() < 2 or
        firstHeaders[0] !=
          ("Content-Type", "application/octet-stream") or
        firstHeaders[1] != ("Content-Disposition", disposition)
      ) return false;
      2;
    };
    if (firstHeaders.size() != commonStart + 10) return false;
    let etag = firstHeaders[commonStart + 6].1;
    if (not validQuotedSha256Etag(etag)) return false;

    var expectedStart = 0;
    var expectedTotal : ?Nat = null;
    for (response in set.responses.vals()) {
      let headers = response.response_headers;
      if (
        response.status_code != 206 or
        response.body_hash.size() != 32 or
        headers.size() != commonStart + 10
      ) return false;
      if (commonStart == 1) {
        if (
          headers[0] !=
          ("Content-Type", "text/plain; charset=utf-8")
        ) return false;
      } else {
        let ?disposition = attachmentDisposition(routeFilename) else {
          return false;
        };
        if (
          headers[0] !=
            ("Content-Type", "application/octet-stream") or
          headers[1] != ("Content-Disposition", disposition)
        ) return false;
      };
      if (
        not exactHeader(
          headers,
          commonStart,
          "Cache-Control",
          "no-store",
        ) or
        not exactHeader(
          headers,
          commonStart + 1,
          "X-Content-Type-Options",
          "nosniff",
        ) or
        not exactHeader(
          headers,
          commonStart + 2,
          "Referrer-Policy",
          "no-referrer",
        ) or
        not exactHeader(
          headers,
          commonStart + 3,
          "Permissions-Policy",
          "camera=(), geolocation=(), microphone=()",
        ) or
        not exactHeader(
          headers,
          commonStart + 4,
          "Content-Security-Policy",
          "sandbox; default-src 'none'; frame-ancestors 'none'",
        ) or
        not exactHeader(
          headers,
          commonStart + 5,
          "Accept-Ranges",
          "bytes",
        ) or
        not exactHeader(headers, commonStart + 6, "ETag", etag) or
        headers[commonStart + 7].0 != "Content-Length" or
        headers[commonStart + 8].0 != "Content-Range" or
        not exactHeader(
          headers,
          commonStart + 9,
          CERTIFICATE_EXPRESSION_HEADER,
          HOST_BOUND_CERTIFICATION_EXPRESSION,
        )
      ) return false;
      let ?length = strictNat(headers[commonStart + 7].1) else {
        return false;
      };
      let ?range = parseContentRange(headers[commonStart + 8].1) else {
        return false;
      };
      if (
        length == 0 or
        length > PUBLICATION_BLOCK_BYTES_MAX_V2 or
        range.start != expectedStart or
        range.end + 1 != range.start + length or
        range.total > PUBLICATION_OBJECT_BYTES_MAX_V2
      ) return false;
      switch (expectedTotal) {
        case (?total) {
          if (range.total != total) return false;
        };
        case null expectedTotal := ?range.total;
      };
      expectedStart += length;
    };
    switch (expectedTotal) {
      case (?total) expectedStart == total;
      case null false;
    };
  };

  func parsePinnedNat(value : Text) : ?Nat {
    if (value == "") return null;
    var result = 0;
    var first = true;
    var digits = 0;
    for (char in value.chars()) {
      if (first and char == '+') {
        first := false;
      } else {
        first := false;
        if (char < '0' or char > '9') return null;
        let digit = Nat32.toNat(Char.toNat32(char) - Char.toNat32('0'));
        if (
          result > MAX_PINNED_RANGE_START / 10 or
          result * 10 > Nat.sub(MAX_PINNED_RANGE_START, digit)
        ) return null;
        result := result * 10 + digit;
        digits += 1;
      };
    };
    if (digits == 0) null else ?result;
  };

  // Accept one bounded byte range only. The end remains selection-neutral, but
  // is parsed so malformed, reversed, duplicate, suffix, and multi-range input
  // fails closed instead of aliasing the first certified block.
  public func parseRange(headers : [HeaderField]) : ParsedRange {
    var found : ?Text = null;
    for ((name, value) in headers.vals()) {
      if (Text.toLower(name) == "range") {
        if (found != null) return #unsupported;
        found := ?value;
      };
    };
    let ?value = found else return #absent;
    let trimmed = Text.trim(value, #predicate(Char.isWhitespace));
    let ?spec = Text.stripStart(trimmed, #text "bytes=") else {
      return #unsupported;
    };
    if (Text.contains(spec, #char ',')) return #unsupported;
    let parts = Text.split(spec, #char '-');
    let ?rawStart = parts.next() else return #unsupported;
    let ?rawEnd = parts.next() else return #unsupported;
    if (parts.next() != null) return #unsupported;
    let start = Text.trim(
      rawStart,
      #predicate(Char.isWhitespace),
    );
    let ?startValue = parsePinnedNat(start) else return #unsupported;
    let end = Text.trim(
      rawEnd,
      #predicate(Char.isWhitespace),
    );
    if (end != "") {
      let ?endValue = parsePinnedNat(end) else return #unsupported;
      if (endValue < startValue) return #unsupported;
    };
    #valid(startValue);
  };

  public func selectPublicationBlock(
    headers : [HeaderField],
    blockLengths : [Nat],
  ) : ?Nat {
    if (blockLengths.size() == 0) return null;
    let start = switch (parseRange(headers)) {
      case (#valid(value)) value;
      case (#absent) return ?0;
      case (#unsupported) return null;
    };
    var offset = 0;
    var index = 0;
    while (index < blockLengths.size()) {
      let length = blockLengths[index];
      if (start < offset + length) return ?index;
      offset += length;
      index += 1;
    };
    null;
  };
};
