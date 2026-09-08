import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Main "../backend/main";
import MarketMemory "../backend/memory/icpswap/v1";
import SwapMemory "../backend/memory/icpswap_swap/v1";
import ActionsMemory "../backend/memory/icpswap_actions/v1";
import Actions "../backend/icpswap/Actions";
import Types "../backend/icpswap/Types";

persistent actor {
  public func run() : async Text {
    let swaps = SwapMemory.init();
    let actions = ActionsMemory.init();
    let actionJournal = Actions.Journal(actions, func() : Int { 1 }, func(id : Text) : Bool {
      Map.containsKey(swaps.records, Text.compare, id);
    });
    func seedAction(id : Text) {
      switch (actionJournal.beginTyped({ id; input_json = "retained current action";
        plan_json = "retained plan"; funding_json = "" }, to_candid("fixture plan"))) {
        case (#ok(_)) {};
        case (#err(error)) Runtime.trap(error);
      };
    };
    let token0 : Types.TokenRef = { address = "ryjl3-tyaaa-aaaaa-aaaba-cai"; standard = "ICRC2" };
    let token1 : Types.TokenRef = { address = "xevnm-gaaaa-aaaar-qafnq-cai"; standard = "ICRC2" };
    let pool : Types.PoolData = {
      canisterId = Principal.fromText("mohjv-bqaaa-aaaag-qjyia-cai");
      fee = 3000; key = "ICP_ckUSDC_3000"; tickSpacing = 60; token0; token1;
    };
    func request(id : Text) : Main.SwapExecuteRequest = {
      request_id = id; input_address = token0.address; output_address = token1.address;
      amount_in = 1000000; slippage = 500;
    };
    func record(id : Text, state : SwapMemory.SwapState) : SwapMemory.SwapRecord = {
      request_id = id; pool = Principal.toText(pool.canisterId); pool_key = pool.key;
      input_address = token0.address; output_address = token1.address;
      input_symbol = "ICP"; output_symbol = "ckUSDC";
      amount_in = 1000000; amount_out_minimum = 985074; quoted_out = 990000;
      swapped_out = if (state == #settled or state == #swapped) 990000 else 0;
      token_in_fee = 10000; token_out_fee = 10000; slippage = 500;
      state; funding_status = "retained funding"; funding_block = "original Wallet block";
      detail = "production history"; started_at = 1; updated_at = 2;
    };
    func seed(value : SwapMemory.SwapRecord) {
      ignore Map.insert(swaps.records, Text.compare, value.request_id, value);
      swaps.order := Array.concat(swaps.order, [value.request_id]);
    };
    let states : [(Text, SwapMemory.SwapState)] = [
      ("planned", #planned), ("funded", #funded), ("ambiguous", #ambiguous),
      ("swapped", #swapped), ("settled", #settled), ("refunded", #refunded), ("failed", #failed),
    ];
    for ((id, state) in states.vals()) seed(record(id, state));
    // The released 100-entry display default must not erase old execution IDs
    // when a new entry is appended; otherwise a delayed retry could spend twice.
    var index = 0;
    while (index < 120) { seed(record("older-" # Nat.toText(index), #settled)); index += 1 };
    let originalCount = Map.size(swaps.records);
    var brokerReads = 0;
    var protocolWrites = 0;
    var allowCalls = false;
    var poolAvailable = true;
    var poolWhitelist : [Principal] = [];
    var inputStandard = "ICRC2";
    var activeRequest = request("fresh");
    var onDispatch : () -> async* () = func() : async* () {};
    var onQuote : () -> async* () = func() : async* () {};
    let success : Types.NatResult = #ok(990000);
    var poolReply : Caps.BackendCallResultV1 = #ok(to_candid(success));
    func brokerCall(call : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
      if (not allowCalls) Runtime.trap("A retained legacy request reached the broker");
      if (call.method == "depositFromAndSwap") {
        protocolWrites += 1;
        assert call.canister == pool.canisterId and call.cycles == 0;
        let decoded : ?Types.DepositAndSwapArgs = from_candid(call.args);
        let ?args = decoded else Runtime.trap("Legacy pool call has incorrect Candid");
        assert args.zeroForOne and args.amountIn == "1000000" and args.amountOutMinimum == "985074";
        assert args.tokenInFee == 10000 and args.tokenOutFee == 10000;
        let ?saved = Map.get(swaps.records, Text.compare, activeRequest.request_id)
          else Runtime.trap("Legacy request was not retained before dispatch");
        assert saved.state == #ambiguous and saved.funding_status == "protocol_requested";
        await* onDispatch();
        return poolReply;
      };
      brokerReads += 1;
      switch (call.method) {
        case ("getPool") {
          let decoded : ?Types.GetPoolArgs = from_candid(call.args);
          let ?args = decoded else Runtime.trap("Incorrect factory lookup Candid");
          assert args.token0.address == token0.address and args.token1.address == token1.address;
          let lookupPool = { pool with token0 = { token0 with standard = inputStandard } };
          let result : Types.PoolDataResult = if (args.fee == 3000) #ok(lookupPool) else #err(#CommonError);
          #ok(to_candid(result));
        };
        case ("quote") {
          await* onQuote();
          let result : Types.NatResult = #ok(990000);
          #ok(to_candid(result));
        };
        case ("getCachedTokenFee") {
          #ok(to_candid({ token0Fee = 10000; token1Fee = 10000 } : Types.CachedTokenFee));
        };
        case ("getAvailabilityState") {
          #ok(to_candid({ available = poolAvailable; whiteList = poolWhitelist } : Types.AvailabilityState));
        };
        case ("metadata") {
          let result : Types.PoolMetadataResult = #ok({ fee = pool.fee; key = pool.key;
            liquidity = 1000000000; sqrtPriceX96 = 0; tick = 0; token0; token1 });
          #ok(to_candid(result));
        };
        case (_) Runtime.trap("Unexpected legacy broker method: " # call.method);
      };
    };
    let calls : Caps.BackendCallsV1 = {
      canister_principal = Principal.fromText("aaaaa-aa");
      can_call = func(_ : Principal, _ : Text) : Bool { true };
      call = brokerCall;
      call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
        let results = List.empty<Caps.BackendCallResultV1>();
        for (call in requests.vals()) List.add(results, await* brokerCall(call));
        List.toArray(results);
      };
    };
    let env : Main.AppBackendEnvironment = {
      stable_memory = { icpswap = MarketMemory.init(); icpswap_swap = swaps; icpswap_actions = actions };
      capabilities = { backend_calls = calls };
    };
    let app = Main.Init(env);
    for ((id, state) in states.vals()) {
      let prior = record(id, state);
      let receipt = await* app.icpswap_swap_execute(request(id));
      assert receipt.pool == prior.pool and receipt.amount_out_minimum == prior.amount_out_minimum;
      assert receipt.swapped_out == prior.swapped_out and not receipt.needs_funding;
      assert receipt.received_out == (if (state == #settled) 980000 else 0);
      if (state == #planned or state == #funded or state == #ambiguous) assert receipt.state == "ambiguous";
      let ?unchanged = Map.get(swaps.records, Text.compare, id) else Runtime.trap("Released swap was removed");
      assert unchanged == prior;
      let originalRequest = request(id);
      let conflict = await* app.icpswap_swap_execute({ originalRequest with amount_in = 2000000 });
      assert conflict.state == "failed";
      assert Text.contains(conflict.detail, #text "another saved swap intent");
      // Switching a released tool alias to the current journal must not turn
      // an old operation ID into a fresh quote and another funding command.
      switch (await* app.icpswap_swap_prepare_v1({ id; input_json = "current alias"; request = request(id) })) {
        case (#err(_)) {};
        case (#ok(_)) Runtime.trap("A released swap ID was prepared in the current journal");
      };
      switch (await* app.icpswap_swap_execute_v1({ id; expected_revision = 0 })) {
        case (#err(_)) {};
        case (#ok(_)) Runtime.trap("A released swap ID entered current execution");
      };
      switch (await* app.icpswap_liquidity_prepare({ id; input_json = "LP intent reusing released ID";
        request = { pool = Principal.toText(pool.canisterId); kind = "mint"; position_id = null;
          tick_lower = -60; tick_upper = 60; amount0 = 1000000; amount1 = 1000000;
          liquidity = 0; withdraw_token = ""; withdraw_amount = 0 } })) {
        case (#err(_)) {};
        case (#ok(_)) Runtime.trap("A released swap ID was reused for liquidity funding");
      };
      assert actionJournal.get(id) == null;
    };
    assert brokerReads == 0 and protocolWrites == 0;
    assert Map.size(actions.operations) == 0;
    seedAction("current-action");
    let currentAction = actionJournal.get("current-action");
    let wrongEndpoint = await* app.icpswap_swap_execute(request("current-action"));
    assert wrongEndpoint.state == "failed" and not wrongEndpoint.needs_funding;
    assert actionJournal.get("current-action") == currentAction;
    assert brokerReads == 0 and protocolWrites == 0;
    allowCalls := true;
    var reentered = false;
    onDispatch := func() : async* () {
      assert not reentered;
      reentered := true;
      let readsBefore = brokerReads;
      let repeated = await* Main.Init(env).icpswap_swap_execute(activeRequest);
      assert repeated.state == "ambiguous" and not repeated.needs_funding;
      assert protocolWrites == 1 and brokerReads == readsBefore;
    };
    let executed = await* app.icpswap_swap_execute(activeRequest);
    assert executed.state == "swapped" and executed.swapped_out == 990000 and executed.received_out == 0;
    assert reentered and protocolWrites == 1 and brokerReads == 7;
    assert Map.size(swaps.records) == originalCount + 1 and swaps.order.size() == originalCount + 1;
    assert Map.get(swaps.records, Text.compare, "planned") == ?record("planned", #planned);
    assert Map.get(swaps.records, Text.compare, "older-0") == ?record("older-0", #settled);
    allowCalls := false;
    let recovered = await* Main.Init(env).icpswap_swap_execute(activeRequest);
    assert recovered == executed and protocolWrites == 1;
    ignore await* app.icpswap_swap_execute(request("older-0"));
    assert protocolWrites == 1;

    // A broker error containing ledger-like text remains a transport unknown;
    // it is never misclassified as a protocol-confirmed clean rejection.
    allowCalls := true;
    activeRequest := request("transport-unknown");
    onDispatch := func() : async* () {};
    poolReply := #err({ code = "call_rejected"; message = "InsufficientFunds while reply interrupted" });
    let unknown = await* app.icpswap_swap_execute(activeRequest);
    assert unknown.state == "ambiguous" and protocolWrites == 2;
    allowCalls := false;
    let recoveredUnknown = await* Main.Init(env).icpswap_swap_execute(activeRequest);
    assert recoveredUnknown == unknown and protocolWrites == 2;

    // ICPSwap's whitelist is an alternative to public availability. Match the
    // actual owner principal sent by the broker, rather than anonymous reads.
    allowCalls := true;
    poolAvailable := false;
    poolWhitelist := [calls.canister_principal];
    switch (await* app.icpswap_swap_quote(request("whitelisted"))) {
      case (#ok(_)) {};
      case (#err(error)) Runtime.trap("Whitelisted owner was refused: " # error);
    };
    poolWhitelist := [Principal.fromText("2vxsx-fae")];
    switch (await* app.icpswap_swap_quote(request("not-whitelisted"))) {
      case (#err(_)) {};
      case (#ok(_)) Runtime.trap("Unavailable pool accepted a non-whitelisted owner");
    };
    poolAvailable := true;
    inputStandard := "DIP20";
    switch (await* app.icpswap_swap_quote(request("unsupported-funding"))) {
      case (#err(error)) assert Text.contains(error, #text "ICRC2");
      case (#ok(_)) Runtime.trap("ICRC2 funding was offered for a DIP20 input");
    };
    assert protocolWrites == 2;

    // A current action can be retained while an older caller awaits its quote.
    // The legacy executor must check again before its irreversible dispatch.
    inputStandard := "ICRC2";
    onQuote := func() : async* () { seedAction("action-wins-race") };
    let actionWins = await* app.icpswap_swap_execute(request("action-wins-race"));
    assert actionWins.state == "failed" and not actionWins.needs_funding;
    assert Map.get(swaps.records, Text.compare, "action-wins-race") == null;
    assert actionJournal.get("action-wins-race") != null and protocolWrites == 2;

    // The converse race must be caught at the new journal's atomic insertion:
    // a legacy dispatch saved during modern quoting owns the ID permanently.
    onQuote := func() : async* () { seed(record("legacy-wins-race", #ambiguous)) };
    switch (await* app.icpswap_swap_prepare_v1({ id = "legacy-wins-race";
      input_json = "overlapping modern intent"; request = request("legacy-wins-race") })) {
      case (#err(_)) {};
      case (#ok(_)) Runtime.trap("Modern quoting overwrote a concurrently retained legacy identity");
    };
    assert actionJournal.get("legacy-wins-race") == null and protocolWrites == 2;
    assert Map.get(swaps.records, Text.compare, "legacy-wins-race") == ?record("legacy-wins-race", #ambiguous);
    "released states replay without calls, immutable IDs survive retention, and fresh effects dispatch once";
  };
};
