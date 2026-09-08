import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Caps "mo:neutron-capabilities";
import Actions "../backend/icpswap/Actions";
import Memory "../backend/memory/icpswap_actions/v1";
import SwapActions "../backend/icpswap/SwapActions";
import Types "../backend/icpswap/Types";

// Real local IC execution is necessary here: a source interpreter cannot
// exercise to_candid/from_candid, and the saved blob is the execution boundary.
persistent actor {
  public func run() : async Text {
    func ok<T>(result : Actions.Result<T>) : T {
      switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(error) };
    };
    func fails<T>(result : Actions.Result<T>) {
      switch (result) { case (#err(_)) {}; case (#ok(_)) Runtime.trap("Expected rejection") };
    };
    let pool = Principal.fromText("mohjv-bqaaa-aaaag-qjyia-cai");
    let originalQuote : SwapActions.Quote = {
      pool = Principal.toText(pool); pool_key = "ICP_ckUSDC_3000"; fee_tier = 3000;
      input_address = "ryjl3-tyaaa-aaaaa-aaaba-cai";
      output_address = "xevnm-gaaaa-aaaar-qafnq-cai";
      decimals_in = 8; decimals_out = 6; zero_for_one = true;
      amount_in = 1000000; quoted_out = 990000; amount_out_minimum = 985074;
      expected_out = 980000; token_in_fee = 10000; token_out_fee = 10000;
      funding_amount = 1000000; total_debit = 1020000;
      price_impact = 0.01; warn = false; slippage = 500;
      funding_ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
      funding_spender = Principal.toText(pool); at = 100;
    };
    func request(id : Text) : SwapActions.Request = {
      request_id = id; input_address = originalQuote.input_address;
      output_address = originalQuote.output_address; amount_in = originalQuote.amount_in;
      slippage = originalQuote.slippage;
    };
    let fundingJson = "[{\"requestId\":\"saved-wallet-request\",\"validUntilNs\":\"123456\"}]";
    let fundingResult = "{\"kind\":\"wallet_funding_v1\",\"result\":\"exact retained receipt\"}";

    class Fixture(reply : Caps.BackendCallResultV1, throws : Bool) {
      let mem = Memory.init();
      public let journal = Actions.Journal(mem, func() : Int { 100 }, func(_ : Text) : Bool { false });
      public var calls = 0;
      public var quotes = 0;
      public var changeQuote = false;
      public var onDispatch : () -> async* () = func() : async* () {};
      public var onQuote : () -> async* () = func() : async* () {};
      public var lastCall : ?Caps.BackendCallRequestV1 = null;
      func dispatch(call : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
        calls += 1;
        lastCall := ?call;
        await* onDispatch();
        if (throws) throw Error.reject("Lost broker reply after dispatch");
        reply;
      };
      let broker : Caps.BackendCallsV1 = {
        canister_principal = Principal.fromText("aaaaa-aa");
        can_call = func(_ : Principal, _ : Text) : Bool { true };
        call = func(call : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
          await* dispatch(call);
        };
        call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
          assert requests.size() == 1;
          [await* dispatch(requests[0])];
        };
      };
      func quote(_ : SwapActions.Request) : async* Actions.Result<SwapActions.Quote> {
        quotes += 1;
        let observation = if (changeQuote) ({
          originalQuote with pool = "aaaaa-aa"; funding_spender = "aaaaa-aa";
          amount_out_minimum = 1; quoted_out = 2; at = 200;
        }) else originalQuote;
        await* onQuote();
        #ok(observation);
      };
      public let service = SwapActions.Service(broker, journal, quote, func() : Int { 100 });
      public func restored() : SwapActions.Service {
        SwapActions.Service(broker, Actions.Journal(mem, func() : Int { 200 }, func(_ : Text) : Bool { false }), quote, func() : Int { 200 });
      };
      public func prepare(id : Text) : async* SwapActions.Prepared {
        ok(await* service.prepare({ id; input_json = "saved caller intent"; request = request(id) }));
      };
      public func fund(operation : Actions.Operation) : Actions.Operation {
        ok(journal.update({ id = operation.id; expected_revision = operation.revision;
          state = "funded"; detail = "Original Wallet command confirmed";
          funding_json = fundingJson; result_json = fundingResult }));
      };
    };

    let successResult : Types.NatResult = #ok(990000);
    let success = Fixture(#ok(to_candid(successResult)), false);
    fails(await* success.service.prepare({ id = "outer-id"; input_json = "split identity";
      request = request("another-request-id") }));
    assert success.calls == 0 and success.quotes == 0;
    let prepared = await* success.prepare("success");
    assert prepared.operation.state == "prepared" and prepared.operation.effects.size() == 0;
    assert success.calls == 0 and success.quotes == 1;
    fails(await* success.service.execute({ id = "success"; expected_revision = prepared.operation.revision }));
    assert success.calls == 0;
    success.changeQuote := true;
    let unchanged = await* success.prepare("success");
    assert unchanged.plan == originalQuote;
    assert success.quotes == 1;
    let conflictRequest = request("success");
    fails(await* success.service.prepare({ id = "success"; input_json = "another intent";
      request = { conflictRequest with amount_in = 2000000 } }));
    assert success.calls == 0;
    let funded = success.fund(prepared.operation);
    var reentered = false;
    success.onDispatch := func() : async* () {
      assert not reentered;
      reentered := true;
      let ?saved = success.journal.get("success") else Runtime.trap("Dispatch was not saved before calling pool");
      assert saved.state == "execution_requested" and saved.effects.size() == 1;
      assert saved.effects[0].state == "requested";
      // Simulate another executor waking up while the first awaits its reply.
      ignore await* success.restored().execute({ id = "success"; expected_revision = saved.revision });
      assert success.calls == 1;
    };
    let completed = ok(await* success.service.execute({ id = "success"; expected_revision = funded.revision }));
    assert reentered and success.calls == 1;
    assert completed.operation.state == "settlement_pending";
    assert completed.operation.funding_json == fundingJson;
    assert completed.operation.result_json == fundingResult;
    assert completed.operation.effects.size() == 1 and completed.operation.effects[0].state == "succeeded";
    let ?receipt = completed.receipt else Runtime.trap("Successful protocol reply lost");
    assert receipt.pool == originalQuote.pool and receipt.amount_out_minimum == originalQuote.amount_out_minimum;
    assert receipt.swapped_out == 990000 and receipt.received_out == 0;
    assert receipt.state == "settlement_pending";
    let ?call = success.lastCall else Runtime.trap("Missing dispatched request");
    assert call.canister == pool and call.method == "depositFromAndSwap" and call.cycles == 0;
    let decoded : ?Types.DepositAndSwapArgs = from_candid(call.args);
    let ?args = decoded else Runtime.trap("Incorrect swap Candid arguments");
    assert args.zeroForOne and args.amountIn == "1000000" and args.amountOutMinimum == "985074";
    assert args.tokenInFee == 10000 and args.tokenOutFee == 10000;
    let restored = success.restored();
    let ?retained = restored.status("success") else Runtime.trap("Saved operation did not survive restore");
    assert retained.operation == completed.operation and retained.plan == originalQuote;
    ignore await* restored.execute({ id = "success"; expected_revision = retained.operation.revision });
    ignore await* restored.execute({ id = "success"; expected_revision = funded.revision });
    assert success.calls == 1 and success.quotes == 1;

    // Two overlapping preparations may receive different market observations.
    // The first saved plan wins; the slower caller must return that same plan.
    let overlapping = Fixture(#ok(to_candid(successResult)), false);
    overlapping.onQuote := func() : async* () {
      overlapping.onQuote := func() : async* () {};
      overlapping.changeQuote := true;
      let faster = await* overlapping.prepare("overlapping");
      assert faster.plan.pool == "aaaaa-aa" and faster.plan.amount_out_minimum == 1;
    };
    let slower = await* overlapping.prepare("overlapping");
    assert overlapping.quotes == 2 and overlapping.calls == 0;
    assert slower.plan.pool == "aaaaa-aa" and slower.plan.amount_out_minimum == 1;
    let ?winning = overlapping.restored().status("overlapping") else Runtime.trap("Overlapping plan was lost");
    assert winning.plan == slower.plan and winning.operation == slower.operation;

    func uncertain(id : Text, reply : Caps.BackendCallResultV1, throws : Bool) : async* () {
      let fixture = Fixture(reply, throws);
      let intent = await* fixture.prepare(id);
      let funding = fixture.fund(intent.operation);
      let result = ok(await* fixture.service.execute({ id; expected_revision = funding.revision }));
      assert result.operation.state == "uncertain" and fixture.calls == 1;
      assert result.operation.funding_json == fundingJson and result.operation.result_json == fundingResult;
      assert result.operation.effects.size() == 1 and result.operation.effects[0].state == "uncertain";
      let replay = fixture.restored();
      ignore await* replay.execute({ id; expected_revision = result.operation.revision });
      ignore await* replay.prepare({ id; input_json = "saved caller intent"; request = request(id) });
      assert fixture.calls == 1 and fixture.quotes == 1;
    };
    await* uncertain("broker-error", #err({ code = "call_rejected"; message = "Reply interrupted" }), false);
    await* uncertain("malformed-reply", #ok(to_candid("not a swap result")), false);
    await* uncertain("invalid-candid", #ok(Blob.fromArray([0, 1, 2])), false);
    await* uncertain("thrown-reply", #ok(Blob.fromArray([])), true);
    let slippageRefund : Types.NatResult = #err(#InternalError("Slippage check failed: current price moved"));
    await* uncertain("refund-pending", #ok(to_candid(slippageRefund)), false);
    let swapTrapRefund : Types.NatResult = #err(#InternalError("Swap trapped: pool computation failed"));
    await* uncertain("swap-trap-refund", #ok(to_candid(swapTrapRefund)), false);

    let cleanResult : Types.NatResult = #err(#InternalError("Wrong fee cache"));
    let clean = Fixture(#ok(to_candid(cleanResult)), false);
    let cleanIntent = await* clean.prepare("clean-failure");
    let cleanFunded = clean.fund(cleanIntent.operation);
    let stopped = ok(await* clean.service.execute({ id = "clean-failure"; expected_revision = cleanFunded.revision }));
    assert stopped.operation.state == "stopped" and clean.calls == 1;
    assert stopped.operation.funding_json == fundingJson and stopped.operation.result_json == fundingResult;
    ignore await* clean.restored().execute({ id = "clean-failure"; expected_revision = stopped.operation.revision });
    assert clean.calls == 1;
    "immutable quote, one dispatch, recovery, funding evidence, and truthful settlement outcomes";
  };
};
