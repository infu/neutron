import Types "../Types";

module {
    public type Adapter = {
        authorization_origin : Text;
        authorizationUrl : (Text, Text) -> Text;
        exchange_cycles : Nat;
        exchange : (Text, Text) -> async* Types.ExchangeResult;
    };
};
