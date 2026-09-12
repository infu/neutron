import IC "mo:core/InternetComputer";
import Principal "mo:core/Principal";

// Disposable PocketIC fixture: authenticates protocol calls as a canister.
// This unrestricted relay is test-only and must never be deployed publicly.
persistent actor class Relay() {
  public shared func rawCall(target : Principal, method : Text, args : Blob) : async Blob {
    await IC.call(target, method, args)
  };
};
