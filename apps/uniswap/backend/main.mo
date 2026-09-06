import Time "mo:core/Time";
import Memory "./memory/uniswap/v1";
import Journal "./Journal";

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

    public type AppBackendEnvironment = {
        stable_memory : { uniswap : Memory.Mem };
    };

    public class Init(env : AppBackendEnvironment) {
        let memory = env.stable_memory.uniswap;

        public func /*update*/uniswap_begin_v1(input : BeginInputV1) : ResultV1 {
            Journal.begin(memory, input, Time.now());
        };

        public func /*query*/uniswap_get_v1(id : Text) : ?SwapV1 {
            Journal.get(memory, id);
        };

        public func /*query*/uniswap_list_v1() : [SwapV1] {
            Journal.list(memory);
        };

        public func /*update*/uniswap_update_v1(input : UpdateInputV1) : ResultV1 {
            Journal.update(memory, input, Time.now());
        };
    };
/*---NEUTRON GENERATED BEGIN---*/

public type uniswap_begin_v1_Input = (input : BeginInputV1);
public type uniswap_begin_v1_Output = ResultV1;

public type uniswap_get_v1_Input = (id : Text);
public type uniswap_get_v1_Output = ?SwapV1;

public type uniswap_list_v1_Input = ();
public type uniswap_list_v1_Output = [SwapV1];

public type uniswap_update_v1_Input = (input : UpdateInputV1);
public type uniswap_update_v1_Output = ResultV1;

/*---NEUTRON GENERATED END---*/
}
