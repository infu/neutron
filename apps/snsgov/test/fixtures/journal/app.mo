import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";
import Caps "mo:neutron-capabilities";
import SnsGov "../../../backend/main";
import Memory "../../../backend/memory/snsgov/v1";
import OperationsMemory "../../../backend/memory/snsgov_operations/v1";

// The production service owns every journal transition. Only its broker is
// replaced; that broker genuinely awaits a separate PocketIC canister.
// These persistent fields are retained by install_code(mode = upgrade).
persistent actor class Journal(gateId : Principal) = this {
  let snsgov = Memory.init();
  let snsgov_operations = OperationsMemory.init();
  var trap_after_reply : ?Blob = null;
  transient let gate : actor { manage_neuron : shared (Text, Blob) -> async Blob } = actor (Principal.toText(gateId));
  func knownMethod(method : Text) : Bool {
    method == "manage_neuron" or method == "fail_stuck_upgrade_in_progress" or
    method == "reset_timers" or method == "get_maturity_modulation";
  };
  transient let broker : Caps.BackendCallsV1 = {
    canister_principal = Principal.fromActor(this);
    can_call = func(_ : Principal, method : Text) : Bool { knownMethod(method) };
    call = func(request : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
      assert request.canister == gateId;
      assert knownMethod(request.method);
      assert request.cycles == 0;
      let reply = await gate.manage_neuron(request.method, request.args);
      // A callback trap cannot be caught by the application's try/catch.
      // The remote side effect and the pre-await dispatch receipt survive.
      if (trap_after_reply == ?request.args) Runtime.trap("journal fixture callback trap after remote reply");
      #ok(reply);
    };
    call_batch = func(_ : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
      Runtime.trap("journal dispatch must use its single-step broker");
    };
  };
  transient let app = SnsGov.Init({
    stable_memory = { snsgov; snsgov_operations };
    capabilities = { backend_calls = broker };
  });

  public query func fixture_version() : async Nat { 1 };
  public func prepare(request : SnsGov.OperationPrepare) : async SnsGov.OperationOutcome {
    app.snsgov_operation_prepare(request);
  };
  public query func get(operation_id : Text) : async ?SnsGov.OperationDetail {
    app.snsgov_operation_get(operation_id);
  };
  public query func list(request : SnsGov.OperationListQuery) : async SnsGov.OperationPage {
    app.snsgov_operation_list(request);
  };
  public func dispatch(request : SnsGov.OperationDispatch) : async SnsGov.OperationOutcome {
    await* app.snsgov_operation_dispatch(request);
  };
  public func update(request : SnsGov.OperationUpdate) : async SnsGov.OperationOutcome {
    app.snsgov_operation_update(request);
  };
  public func trapAfterReply(args : ?Blob) : async () { trap_after_reply := args };
  public func configure(request : SnsGov.SnsUpsert) : async SnsGov.Outcome {
    app.snsgov_sns_upsert(request);
  };
  public func remove(sns : Principal) : async SnsGov.Outcome {
    app.snsgov_sns_remove(sns);
  };
  public func seedLegacy(sns : Principal) : async () {
    assert app.snsgov_sns_upsert({ sns; governance = gateId; voting_enabled = true;
      agent_voting_enabled = true; label_text = "Retained SNS" }) == #ok;
    ignore app.snsgov_audit_append({ sns; governance = gateId; kind = "vote";
      proposal_id = ?42; initiator = "user"; vote = ?1; neurons_attempted = 1;
      neurons_succeeded = 1; note = "retained before actual Wasm upgrade" });
    switch (app.snsgov_draft_save({ id = null; sns; governance = gateId;
      title = "Retained proposal draft"; summary = "Keep the original bytes";
      url = ""; action_kind = "Motion"; payload = ?"original draft payload";
      function_id = null; rendering = null; proposer = null; created_by = "user" })) {
      case (#ok(_)) {};
      case (#err(error)) Runtime.trap(error);
    };
  };
  public query func legacy() : async { config : SnsGov.ConfigView; drafts : [SnsGov.DraftView] } {
    { config = app.snsgov_config(()); drafts = app.snsgov_drafts(()) };
  };
};
