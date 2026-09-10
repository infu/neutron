// All rights reserved. See ../LICENSE.
import Http "../mo/Http";
import Text "mo:core/Text";

persistent actor {
  let memory = Http.init();
  var eligible = true;
  var grantActive = true;
  transient let token = "0000000000000000000000000000000000000000000000000000000000000001";
  transient let secret : Blob = "secret-part-1secret-part-2secret-part-3";
  transient let privateAsset : Http.Artifact = { path = "/repo/v1/packages/private.neutron"; sha256 = Http.hash(secret); size = secret.size(); contentType = "application/octet-stream"; chunks = 3; publicAccess = false; immutable = true };
  transient let publicContent : Blob = "{\"protocol\":\"neutron-repo-access-v1\"}";
  transient let publicAsset : Http.Artifact = { path = "/repo/v1/access.json"; sha256 = Http.hash(publicContent); size = publicContent.size(); contentType = "application/json"; chunks = 1; publicAccess = true; immutable = false };
  transient let rootAsset : Http.Artifact = { publicAsset with path = "/" };
  transient let http = Http.Store(memory, {
    artifact = func(path : Text) : ?Http.Artifact {
      if (path == privateAsset.path) ?privateAsset else if (path == publicAsset.path) ?publicAsset else if (path == "/") ?rootAsset else null;
    };
    authorize = func(path : Text, grant : ?Text) : Bool {
      if (path == publicAsset.path or path == "/") true else path == privateAsset.path and eligible and grantActive and grant == ?token;
    };
    chunk = func(path : Text, index : Nat) : ?Blob {
      if ((path == publicAsset.path or path == "/") and index == 0) return ?publicContent;
      if (path != privateAsset.path) return null;
      if (index == 0) ?("secret-part-1" : Blob) else if (index == 1) ?("secret-part-2" : Blob) else if (index == 2) ?("secret-part-3" : Blob) else null;
    };
  });
  http.initialize();
  http.configureArtifact(privateAsset);
  http.configureArtifact(publicAsset);
  http.configureArtifact(rootAsset);
  if (grantActive and eligible) http.certifyGrantHash(privateAsset, Http.authorizationHash(token));
  http.commitCertification();

  public query func http_request(request : Http.Request) : async Http.Response { http.httpRequest(request, http_streaming_callback) };
  public query func http_streaming_callback(token : Http.Token) : async Http.StreamingResponse { http.stream(token) };
  public func revoke() : async () {
    grantActive := false;
    http.revokeGrantHash(privateAsset.path, Http.authorizationHash(token));
    http.commitCertification();
  };
  public func setEligibility(value : Bool) : async () { eligible := value };
  public query func digests() : async { privateRequest : Blob; publicRequest : Blob; root : Blob } {
    { privateRequest = Http.requestHash("GET", ?Http.authorizationHash(token)); publicRequest = Http.requestHash("GET", null); root = http.rootHash() };
  };
};
