import Time "mo:core/Time";
import Memory "./memory/uniswap/v1";
import Journal "./Journal";
import ActionMemory "./memory/uniswap_actions/v1";
import Actions "./Actions";

module {
    // The method-schema emitter resolves concrete local API types. These are
    // structurally checked against the immutable schema and journal types by
    // the calls below; keep API versions explicit instead of imported aliases.
    public type SwapV1 = {
        id : Text;
        account_id : Text;
        chain_id : Nat;
        recipient : Text;
        quote_json : Text;
        approval_request_id : ?Text;
        approval_request_json : ?Text;
        swap_request_id : Text;
        swap_request_json : Text;
        approval_operation_json : ?Text;
        swap_operation_json : ?Text;
        phase : Text;
        revision : Nat;
        created_at : Int;
        updated_at : Int;
    };
    public type BeginInputV1 = {
        id : Text;
        account_id : Text;
        chain_id : Nat;
        recipient : Text;
        quote_json : Text;
        approval_request_id : ?Text;
        approval_request_json : ?Text;
        swap_request_id : Text;
        swap_request_json : Text;
    };
    public type UpdateInputV1 = {
        id : Text;
        expected_revision : Nat;
        stage : Text;
        request_id : Text;
        account_id : Text;
        chain_id : Nat;
        operation_json : ?Text;
        phase : Text;
    };
    public type ResultV1 = { #ok : SwapV1; #err : Text };
    public type HistoryInputV1 = { cursor : ?Text; limit : Nat };
    public type HistoryPageV1 = { rows : [SwapV1]; next_cursor : ?Text };
    public type HistoryResultV1 = { #ok : HistoryPageV1; #err : Text };

    public type ActionV1 = {
        id : Text;
        input_json : Text;
        summary : Text;
        state_json : Text;
        phase : Text;
        revision : Nat;
        created_at : Int;
        updated_at : Int;
    };
    public type ActionBeginInputV1 = {
        id : Text;
        input_json : Text;
        summary : Text;
        state_json : Text;
        phase : Text;
    };
    public type ActionUpdateInputV1 = {
        id : Text;
        expected_revision : Nat;
        state_json : Text;
        phase : Text;
    };
    public type ActionResultV1 = { #ok : ActionV1; #err : Text };
    public type ActionSummaryV1 = {
        id : Text;
        summary : Text;
        phase : Text;
        revision : Nat;
        created_at : Int;
        updated_at : Int;
    };
    public type ActionPageInputV1 = { cursor : ?Text; limit : Nat };
    public type ActionPageV1 = { rows : [ActionSummaryV1]; next_cursor : ?Text };
    public type ActionPageResultV1 = { #ok : ActionPageV1; #err : Text };
    public type PositionRefV1 = { chain_id : Nat; protocol : Text; token_id : Text };
    public type PositionResultV1 = { #ok : PositionRefV1; #err : Text };

    public type AppBackendEnvironment = {
        stable_memory : { uniswap : Memory.Mem; uniswap_actions : ActionMemory.Mem };
    };

    public class Init(env : AppBackendEnvironment) {
        let memory = env.stable_memory.uniswap;
        let actions = env.stable_memory.uniswap_actions;

        public func /*update*/uniswap_begin_v1(input : BeginInputV1) : ResultV1 {
            Journal.begin(memory, input, Time.now());
        };

        public func /*query*/uniswap_get_v1(id : Text) : ?SwapV1 {
            Journal.get(memory, id);
        };

        public func /*query*/uniswap_list_v1() : [SwapV1] {
            Journal.list(memory);
        };

        public func /*query*/uniswap_history_v1(input : HistoryInputV1) : HistoryResultV1 {
            Journal.history(memory, input);
        };

        public func /*update*/uniswap_update_v1(input : UpdateInputV1) : ResultV1 {
            Journal.update(memory, input, Time.now());
        };

        public func /*update*/uniswap_action_begin_v1(input : ActionBeginInputV1) : ActionResultV1 {
            Actions.begin(actions, input, Time.now());
        };

        public func /*query*/uniswap_action_get_v1(id : Text) : ?ActionV1 {
            Actions.get(actions, id);
        };

        public func /*query*/uniswap_action_page_v1(input : ActionPageInputV1) : ActionPageResultV1 {
            Actions.page(actions, input);
        };

        public func /*update*/uniswap_action_update_v1(input : ActionUpdateInputV1) : ActionResultV1 {
            Actions.update(actions, input, Time.now());
        };

        public func /*update*/uniswap_position_track_v1(input : PositionRefV1) : PositionResultV1 {
            Actions.trackPosition(actions, input);
        };

        public func /*query*/uniswap_position_refs_v1(chain_id : Nat) : [PositionRefV1] {
            Actions.positionRefs(actions, chain_id);
        };
    };
/*---NEUTRON GENERATED BEGIN---*/

public type uniswap_begin_v1_Input = (input : BeginInputV1);
public type uniswap_begin_v1_Output = ResultV1;

public type uniswap_get_v1_Input = (id : Text);
public type uniswap_get_v1_Output = ?SwapV1;

public type uniswap_list_v1_Input = ();
public type uniswap_list_v1_Output = [SwapV1];

public type uniswap_history_v1_Input = (input : HistoryInputV1);
public type uniswap_history_v1_Output = HistoryResultV1;

public type uniswap_update_v1_Input = (input : UpdateInputV1);
public type uniswap_update_v1_Output = ResultV1;

public type uniswap_action_begin_v1_Input = (input : ActionBeginInputV1);
public type uniswap_action_begin_v1_Output = ActionResultV1;

public type uniswap_action_get_v1_Input = (id : Text);
public type uniswap_action_get_v1_Output = ?ActionV1;

public type uniswap_action_page_v1_Input = (input : ActionPageInputV1);
public type uniswap_action_page_v1_Output = ActionPageResultV1;

public type uniswap_action_update_v1_Input = (input : ActionUpdateInputV1);
public type uniswap_action_update_v1_Output = ActionResultV1;

public type uniswap_position_track_v1_Input = (input : PositionRefV1);
public type uniswap_position_track_v1_Output = PositionResultV1;

public type uniswap_position_refs_v1_Input = (chain_id : Nat);
public type uniswap_position_refs_v1_Output = [PositionRefV1];

/*---NEUTRON GENERATED END---*/
}
