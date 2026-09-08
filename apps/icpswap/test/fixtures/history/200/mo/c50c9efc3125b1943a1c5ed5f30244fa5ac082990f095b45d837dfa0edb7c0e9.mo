import Map "59d991367413199580f31df1021c41cd6aafb1ad1580824a58e45ca6e5d1f9f2";
module {
    public type SwapState = {
        #planned;
        #funded;
        #swapped;
        #settled;
        #refunded;
        #failed;
        #ambiguous;
    };
    public type SwapRecord = {
        request_id : Text;
        pool : Text;
        pool_key : Text;
        input_address : Text;
        output_address : Text;
        input_symbol : Text;
        output_symbol : Text;
        amount_in : Nat;
        amount_out_minimum : Nat;
        quoted_out : Nat;
        swapped_out : Nat;
        token_in_fee : Nat;
        token_out_fee : Nat;
        slippage : Nat;
        state : SwapState;
        funding_status : Text;
        funding_block : Text;
        detail : Text;
        started_at : Int;
        updated_at : Int;
    };
    public type Mem = {
        records : Map.Map<Text, SwapRecord>;
        var order : [Text];
        var limit : Nat;
        var slippage : Nat;
        var completed : Nat;
    };
    public func init() : Mem {
        {
            records = Map.empty<Text, SwapRecord>();
            var order = [];
            var limit = 100;
            var slippage = 500;
            var completed = 0;
        };
    };
};
