import Codec "../../../backend/connections/Codec";
import Types "../../../backend/connections/Types";
import Provider "../../../backend/connections/providers/Provider";

module {
    public let authorization_origin = "https://provider.test";
    public let exchange_cycles : Nat = 0;

    public func authorizationUrl(callbackUrl : Text, challenge : Text) : Text {
        callbackUrl #
        "&code=fake-code" #
        "&challenge=" # Codec.percentEncode(challenge);
    };

    public func exchange(code : Text, verifier : Text) : async* Types.ExchangeResult {
        #ok({
            credential = "fake:" # code # ":" # verifier;
            charged_cycles = 0;
        });
    };

    public func adapter() : Provider.Adapter {
        { authorization_origin; authorizationUrl; exchange_cycles; exchange };
    };
};
