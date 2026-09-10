// All rights reserved. See ../LICENSE.
import Array "mo:core/Array";
import Base64 "mo:core/Base64";
import Blob "mo:core/Blob";
import CertifiedData "mo:core/CertifiedData";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import CertTree "mo:ic-certification/CertTree";
import ReqData "mo:ic-certification/ReqData";
import Sha256 "mo:sha2/Sha256";

module {
  public type Header = (Text, Text);
  public type Request = {
    method : Text;
    url : Text;
    headers : [Header];
    body : Blob;
    certificate_version : ?Nat16;
  };
  public type Token = {
    path : Text;
    sha256 : Blob;
    grant : ?Text;
    index : Nat;
  };
  public type StreamingResponse = { body : Blob; token : ?Token };
  public type Callback = shared query Token -> async StreamingResponse;
  public type Response = {
    status_code : Nat16;
    headers : [Header];
    body : Blob;
    streaming_strategy : ?{ #Callback : { callback : Callback; token : Token } };
    upgrade : ?Bool;
  };
  public type Artifact = {
    path : Text;
    sha256 : Blob;
    size : Nat;
    contentType : Text;
    chunks : Nat;
    publicAccess : Bool;
    immutable : Bool;
  };
  public type Callbacks = {
    artifact : Text -> ?Artifact;
    chunk : (Text, Nat) -> ?Blob;
    // This callback must recheck the grant, exact artifact scope, current
    // audit/revocation state, and buyer/publisher/auditor authorization.
    authorize : (Text, ?Text) -> Bool;
  };
  public type Memory = CertTree.Store;

  public let PRIVATE_EXPRESSION = "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[\"authorization\"],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";
  public let PUBLIC_EXPRESSION = "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";
  // Arbitrary invalid bearer values cannot be pre-certified in a query. This
  // expression certifies ONLY fixed empty 403/404/204 responses. It never has
  // a 200 leaf or artifact body. Selecting it instead of a valid success can
  // deny availability, but cannot authenticate or disclose protected bytes.
  public let EMPTY_EXPRESSION = "default_certification(ValidationArgs{certification:Certification{no_request_certification:Empty{},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";

  public func init() : Memory { CertTree.newStore() };
  public func hash(bytes : Blob) : Blob { Sha256.fromBlob(#sha256, bytes) };
  public func authorizationHash(token : Text) : Blob { hash(Text.encodeUtf8("Bearer " # token)) };

  func pairHash(left : Blob, right : Blob) : Blob {
    let digest = Sha256.Digest(#sha256);
    digest.writeBlob(left);
    digest.writeBlob(right);
    digest.sum();
  };
  func concat(left : Blob, right : Blob) : Blob {
    Blob.fromArray(Array.concat(Blob.toArray(left), Blob.toArray(right)));
  };
  func pathAppend(left : [Blob], right : [Blob]) : [Blob] { Array.concat(left, right) };

  // The request digest can be rebuilt from a saved hash of the Authorization
  // value. Neither the certification tree nor durable grants need its secret.
  public func requestHash(method : Text, authorizationDigest : ?Blob) : Blob {
    let methodEntry = concat(hash(Text.encodeUtf8(":ic-cert-method")), hash(Text.encodeUtf8(method)));
    let entries = switch (authorizationDigest) {
      case null [methodEntry];
      case (?digest) {
        assert digest.size() == 32;
        let authEntry = concat(hash(Text.encodeUtf8("authorization")), digest);
        switch (Blob.compare(methodEntry, authEntry)) {
          case (#greater) [authEntry, methodEntry];
          case _ [methodEntry, authEntry];
        };
      };
    };
    let headers = Sha256.Digest(#sha256);
    for (entry in entries.vals()) headers.writeBlob(entry);
    pairHash(headers.sum(), hash(""));
  };

  public func responseHash(headers : [Header], status : Nat16, bodyHash : Blob) : Blob {
    let entries = List.empty<(Text, ReqData.V)>();
    for ((name, value) in headers.vals()) {
      let lower = Text.toLower(name);
      if (lower != "ic-certificate") List.add(entries, (lower, #string(value)));
    };
    List.add(entries, (":ic-cert-status", #nat(Nat16.toNat(status))));
    pairHash(ReqData.hash(List.toArray(entries)), bodyHash);
  };

  public func hex(bytes : Blob) : Text {
    let alphabet = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
    var result = "";
    for (byte in bytes.vals()) {
      result #= alphabet[Nat8.toNat(byte) / 16] # alphabet[Nat8.toNat(byte) % 16];
    };
    result;
  };

  // Repository/artifact paths are ASCII canonical paths. Keeping their URL
  // spelling unchanged also keeps the v2 expression path unambiguous.
  public func validPath(path : Text) : Bool {
    if (not Text.startsWith(path, #text "/")) return false;
    if (path == "/") return true;
    if (Text.endsWith(path, #text "/")) return false;
    let segments = Text.split(path, #char '/');
    ignore segments.next();
    for (segment in segments) {
      if (segment == "" or segment == "." or segment == "..") return false;
      for (character in segment.chars()) {
        if (not ((character >= 'a' and character <= 'z') or (character >= 'A' and character <= 'Z') or (character >= '0' and character <= '9') or character == '-' or character == '_' or character == '.')) return false;
      };
    };
    true;
  };

  func hexDigit(byte : Nat8) : ?Nat8 {
    if (byte >= 48 and byte <= 57) ?(byte - 48)
    else if (byte >= 65 and byte <= 70) ?(byte - 55)
    else if (byte >= 97 and byte <= 102) ?(byte - 87)
    else null;
  };
  // The official verifier percent-decodes the URI path and ignores empty
  // interior slash components. Use that same path for routing and proofs so
  // an encoded spelling cannot incorrectly claim absence of a present path.
  public func requestPath(url : Text) : ?Text {
    let ?raw = Text.split(url, #char '?').next() else return null;
    let encoded = Text.encodeUtf8(raw);
    let decoded = List.empty<Nat8>();
    var index = 0;
    while (index < encoded.size()) {
      let byte = encoded[index];
      if (byte == 37 and index + 2 < encoded.size()) {
        switch (hexDigit(encoded[index + 1]), hexDigit(encoded[index + 2])) {
          case (?hi, ?lo) { List.add(decoded, hi * 16 + lo); index += 3 };
          case _ { List.add(decoded, byte); index += 1 };
        };
      } else { List.add(decoded, byte); index += 1 };
    };
    let ?path = Text.decodeUtf8(Blob.fromArray(List.toArray(decoded))) else return null;
    if (not Text.startsWith(path, #text "/")) return null;
    var normalized = "";
    for (part in Text.split(path, #char '/')) {
      if (part != "") normalized #= "/" # part;
    };
    if (normalized == "") return ?"/";
    if (Text.endsWith(path, #text "/")) normalized #= "/";
    ?normalized;
  };

  func segments(path : Text) : [Text] {
    let result = List.empty<Text>();
    for (part in Text.split(path, #char '/')) {
      if (part != "") List.add(result, part);
    };
    if (Text.endsWith(path, #text "/")) List.add(result, "");
    List.toArray(result);
  };
  public func expressionPath(path : Text) : [Text] {
    Array.concat(["http_expr"], Array.concat(segments(path), ["<$>"]));
  };
  func blobPath(path : [Text]) : [Blob] { Array.map(path, Text.encodeUtf8) };
  func exactPath(path : Text) : [Blob] { blobPath(expressionPath(path)) };
  func leaf(path : [Blob], expression : Text, request : Blob, response : Blob) : [Blob] {
    pathAppend(path, [hash(Text.encodeUtf8(expression)), request, response]);
  };

  func cborLength(output : List.List<Nat8>, major : Nat, size : Nat) {
    if (size < 24) {
      List.add(output, Nat8.fromNat(major * 32 + size));
    } else {
      var n = size;
      let bytes = List.empty<Nat8>();
      while (n > 0) {
        List.add(bytes, Nat8.fromNat(n % 256));
        n /= 256;
      };
      let width = if (size <= 255) 1 else if (size <= 65535) 2 else if (size <= 4294967295) 4 else 8;
      assert bytes.size() <= width;
      List.add(output, Nat8.fromNat(major * 32 + (if (width == 1) 24 else if (width == 2) 25 else if (width == 4) 26 else 27)));
      var i = width;
      let little = List.toArray(bytes);
      while (i > 0) {
        i -= 1;
        List.add(output, if (i < little.size()) little[i] else (0 : Nat8));
      };
    };
  };
  public func encodeExpressionPath(path : [Text]) : Blob {
    let output = List.empty<Nat8>();
    for (b in ([0xd9, 0xd9, 0xf7] : [Nat8]).vals()) List.add(output, b);
    cborLength(output, 4, path.size());
    for (part in path.vals()) {
      let bytes = Text.encodeUtf8(part);
      cborLength(output, 3, bytes.size());
      for (b in bytes.vals()) List.add(output, b);
    };
    Blob.fromArray(List.toArray(output));
  };

  public func successHeaders(artifact : Artifact, privateResponse : Bool) : [Header] {
    [
      ("Content-Type", artifact.contentType),
      ("Content-Length", Nat.toText(artifact.size)),
      ("Content-Digest", "sha-256=:" # Base64.encode(artifact.sha256) # ":"),
      ("ETag", "\"" # hex(artifact.sha256) # "\""),
      ("Cache-Control", if (privateResponse) "private, no-store" else if (artifact.immutable) "public, max-age=31536000, immutable, no-transform" else "public, max-age=0, must-revalidate, no-transform"),
      ("Vary", "Authorization"),
      ("Access-Control-Allow-Origin", "*"),
      ("Access-Control-Expose-Headers", "IC-Certificate, IC-CertificateExpression, Content-Length, Content-Digest, ETag, WWW-Authenticate, Vary"),
      ("Cross-Origin-Resource-Policy", "cross-origin"),
      ("X-Content-Type-Options", "nosniff"),
      ("IC-CertificateExpression", if (privateResponse) PRIVATE_EXPRESSION else PUBLIC_EXPRESSION),
    ];
  };
  public func emptyHeaders(status : Nat16) : [Header] {
    [
      ("Content-Type", "application/octet-stream"),
      ("Content-Length", "0"),
      ("Cache-Control", "private, no-store"),
      ("Vary", "Authorization"),
      ("Access-Control-Allow-Origin", "*"),
      ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
      ("Access-Control-Allow-Headers", "Authorization"),
      ("Access-Control-Expose-Headers", "IC-Certificate, IC-CertificateExpression, Content-Length, WWW-Authenticate, Vary"),
      ("WWW-Authenticate", if (status == 403) "Bearer realm=\"repository\"" else "Bearer"),
      ("Cross-Origin-Resource-Policy", "cross-origin"),
      ("X-Content-Type-Options", "nosniff"),
      ("IC-CertificateExpression", EMPTY_EXPRESSION),
    ];
  };

  public class Store(memory : Memory, callbacks : Callbacks) {
    let cert = CertTree.Ops(memory);
    public func commitCertification() { cert.setCertifiedData() };
    public func rootHash() : Blob { cert.treeHash() };

    func putEmpty(path : [Blob], status : Nat16) {
      cert.put(leaf(path, EMPTY_EXPRESSION, "", responseHash(emptyHeaders(status), status, hash(""))), "");
    };
    public func initialize() {
      let path : [Blob] = ["http_expr", "<*>"];
      putEmpty(path, 404);
      putEmpty(path, 204);
    };
    // Response headers are part of every v2 response hash. Upgrades that change
    // them rebuild this derived branch before recertifying retained resources.
    // The repository's separate certified Candid assets branch is untouched.
    public func resetResponses() {
      cert.delete(["http_expr"]);
      initialize();
    };
    // Updating a path removes all older response hashes and private grants.
    // Callers can then reinsert only grants that remain currently eligible.
    public func configureArtifact(artifact : Artifact) {
      assert validPath(artifact.path);
      assert artifact.sha256.size() == 32;
      assert artifact.chunks > 0 or artifact.size == 0;
      let path = exactPath(artifact.path);
      cert.delete(path);
      putEmpty(path, 403);
      putEmpty(path, 204);
      if (artifact.publicAccess) {
        certifySuccess(artifact, null);
      };
    };
    func certifySuccess(artifact : Artifact, digest : ?Blob) {
      let privateResponse = digest != null;
      let expression = if (privateResponse) PRIVATE_EXPRESSION else PUBLIC_EXPRESSION;
      let headers = successHeaders(artifact, privateResponse);
      for (method in ["GET", "HEAD"].vals()) {
        let bodyHash = if (method == "HEAD") hash("") else artifact.sha256;
        cert.put(leaf(exactPath(artifact.path), expression, requestHash(method, digest), responseHash(headers, 200, bodyHash)), "");
      };
    };
    public func certifyGrantHash(artifact : Artifact, digest : Blob) {
      assert digest.size() == 32;
      assert validPath(artifact.path);
      assert not artifact.publicAccess;
      certifySuccess(artifact, ?digest);
    };
    public func revokeGrantHash(path : Text, digest : Blob) {
      for (method in ["GET", "HEAD"].vals()) {
        cert.delete(pathAppend(exactPath(path), [hash(Text.encodeUtf8(PRIVATE_EXPRESSION)), requestHash(method, ?digest)]));
      };
    };
    public func removeArtifact(path : Text) { cert.delete(exactPath(path)) };

    func proof(path : Text, selected : [Blob], wildcard : Bool) : Header {
      let ?certificate = CertifiedData.getCertificate() else Runtime.trap("HTTP certification is available only in queries");
      let paths = List.empty<[Blob]>();
      List.add(paths, selected);
      if (wildcard) {
        List.add(paths, exactPath(path));
        let parts = segments(path);
        var length = parts.size();
        while (length > 0) {
          let prefix = Array.tabulate<Text>(length, func(i) { parts[i] });
          List.add(paths, blobPath(Array.concat(["http_expr"], Array.concat(prefix, ["<*>"]))));
          let directory = Array.tabulate<Text>(length - 1, func(i) { parts[i] });
          List.add(paths, blobPath(Array.concat(["http_expr"], Array.concat(directory, ["", "<*>"]))));
          length -= 1;
        };
      };
      let witness = cert.encodeWitness(cert.reveals(List.toArray(paths).vals()));
      let expression = if (wildcard) ["http_expr", "<*>"] else expressionPath(path);
      ("IC-Certificate", "certificate=:" # Base64.encode(certificate) # ":, tree=:" # Base64.encode(witness) # ":, expr_path=:" # Base64.encode(encodeExpressionPath(expression)) # ":, version=2");
    };
    func emptyResponse(path : Text, status : Nat16, wildcard : Bool) : Response {
      let headers = emptyHeaders(status);
      let selected = leaf(if (wildcard) ["http_expr", "<*>"] else exactPath(path), EMPTY_EXPRESSION, "", responseHash(headers, status, hash("")));
      {
        status_code = status;
        headers = Array.concat(headers, [proof(path, selected, wildcard)]);
        body = "";
        streaming_strategy = null;
        upgrade = null;
      };
    };
    public func httpRequest(request : Request, callback : Callback) : Response {
      let ?path = requestPath(request.url) else Runtime.trap("Malformed HTTP request path");
      let artifact = if (validPath(path)) callbacks.artifact(path) else null;
      let ?asset = artifact else return emptyResponse(path, if (request.method == "OPTIONS") 204 else 404, true);
      if (request.method == "OPTIONS") return emptyResponse(path, 204, false);
      if ((request.method != "GET" and request.method != "HEAD") or request.body.size() != 0) return emptyResponse(path, 403, false);
      var token : ?Text = null;
      var digest : ?Blob = null;
      var authCount = 0;
      for ((name, value) in request.headers.vals()) {
        if (Text.toLower(name) == "authorization") {
          authCount += 1;
          switch (Text.stripStart(value, #text "Bearer ")) {
            case (?value) { token := ?value; digest := ?authorizationHash(value) };
            case null {};
          };
        };
      };
      if (authCount > 1 or (authCount == 1 and token == null)) return emptyResponse(path, 403, false);
      if (not callbacks.authorize(path, token)) return emptyResponse(path, 403, false);
      let privateResponse = not asset.publicAccess;
      if (privateResponse and token == null) return emptyResponse(path, 403, false);
      let authorizationDigest = if (privateResponse) digest else null;
      let expression = if (privateResponse) PRIVATE_EXPRESSION else PUBLIC_EXPRESSION;
      let headers = successHeaders(asset, privateResponse);
      let bodyHash = if (request.method == "HEAD") hash("") else asset.sha256;
      let selected = leaf(exactPath(path), expression, requestHash(request.method, authorizationDigest), responseHash(headers, 200, bodyHash));
      // Grant/auth changes must be represented in the committed tree before
      // returning bytes. This also fails closed during incomplete rebuilds.
      if (cert.lookup(selected) != ?("" : Blob)) return emptyResponse(path, 403, false);
      let body = if (request.method == "HEAD" or asset.size == 0) ("" : Blob) else switch (callbacks.chunk(path, 0)) {
        case (?bytes) bytes;
        case null Runtime.trap("Certified artifact content is unavailable");
      };
      let next = if (request.method == "GET" and asset.chunks > 1) ?#Callback({ callback; token = { path; sha256 = asset.sha256; grant = if (privateResponse) token else null; index = 1 } }) else null;
      { status_code = 200; headers = Array.concat(headers, [proof(path, selected, false)]); body; streaming_strategy = next; upgrade = null };
    };
    public func stream(token : Token) : StreamingResponse {
      let ?asset = callbacks.artifact(token.path) else Runtime.trap("Artifact is unavailable");
      if (not validPath(token.path) or asset.sha256 != token.sha256 or token.index >= asset.chunks or not callbacks.authorize(token.path, token.grant)) Runtime.trap("Artifact access is no longer authorized");
      if (not asset.publicAccess) {
        let ?grant = token.grant else Runtime.trap("Artifact access requires a grant");
        let headers = successHeaders(asset, true);
        let selected = leaf(exactPath(token.path), PRIVATE_EXPRESSION, requestHash("GET", ?authorizationHash(grant)), responseHash(headers, 200, asset.sha256));
        if (cert.lookup(selected) != ?("" : Blob)) Runtime.trap("Artifact grant has been revoked");
      };
      let ?body = callbacks.chunk(token.path, token.index) else Runtime.trap("Certified artifact content is unavailable");
      { body; token = if (token.index + 1 < asset.chunks) ?{ token with index = token.index + 1 } else null };
    };
  };
};
