// All rights reserved. See ../../LICENSE.
import Access "../../mo/Access";
import API "../../mo/API";
import Certification "../../mo/Certification";
import Http "../../mo/Http";
import PublisherStore "../../mo/PublisherStore";
import ReleaseStore "../../mo/ReleaseStore";
import Repository "../../mo/Repository";
import Store "../../mo/Store";
import Types "../../mo/Types";
import F "../motoko/Fixtures";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

persistent actor Fixture {
  let memory = F.memory();
  let publishers = PublisherStore.init();
  let channels = ReleaseStore.init();
  let certification = Http.init();
  var seeded = false;
  transient let db = Store.UseWithChannels(memory, publishers, channels);
  transient let repo = Repository.Service(db, certification, Principal.fromActor(Fixture));
  transient let http = Http.Store(certification, {
    artifact = func(path) { switch (repo.artifact(path)) { case (?value) ?value; case null Certification.artifact(db, path) } };
    chunk = func(path, index) { if (repo.isMetadata(path)) repo.chunk(path, index) else Certification.chunk(db, path, index) };
    authorize = func(path, credential) { repo.isMetadata(path) or Access.authorizeHttp(db, path, credential) };
  });
  func accepted<T>(value : API.Result<T>) : T {
    switch (value) { case (#ok(result)) result; case (#err(error)) Runtime.trap(debug_show(error)) };
  };
  if (not seeded) {
    ignore F.draft(db, "channel_http", 0);
    let stableCandidate = F.candidate(db, "channel_http", 100, "stable-http");
    let betaCandidate = F.candidate(db, "channel_http", 101, "beta-http");
    ignore F.stored(db.candidates.update({ stableCandidate with state = #approved; published = true }));
    ignore F.stored(db.candidates.update({ betaCandidate with state = #approved; published = true }));
    ReleaseStore.putHeads(channels, "channel_http", {
      stableHead = { candidateId = ?stableCandidate.id; revision = 1 };
      betaHead = { candidateId = ?betaCandidate.id; revision = 1 };
    });
    ignore F.stored(Store.insertEntitlement(db, { owner = F.other(); appId = "channel_http"; orderId = 1; kind = #paid; acquiredAtNs = 2 }));
    seeded := true;
  };
  http.initialize();
  repo.initialize(http);

  public func prepareBeta() : async API.InstallResult {
    let current = accepted(repo.selection(F.other(), { appIds = ["channel_http"]; mode = #beta }));
    accepted(repo.prepareV2(http, F.other(), {
      request = { requestId = "beta-http-install"; appIds = current.appIds; feeVersion = 1 };
      mode = #beta; selection = current.selection;
    }, 3));
  };
  public func revokeBeta() : async () {
    let ?id = ReleaseStore.heads(channels, "channel_http").betaHead.candidateId else Runtime.trap("Missing beta head");
    let ?candidate = Store.getCandidate(db, id) else Runtime.trap("Missing beta candidate");
    ignore F.stored(db.candidates.update({ candidate with state = #revoked }));
    repo.refreshApp(http, candidate.appId);
  };
  public query func read(input : { key : Text; index : Nat }) : async Repository.CertifiedRead { repo.read(input.key, input.index) };
  public query func http_request(input : Http.Request) : async Http.Response { http.httpRequest(input, http_streaming_callback) };
  public query func http_streaming_callback(input : Http.Token) : async Http.StreamingResponse { http.stream(input) };
};
