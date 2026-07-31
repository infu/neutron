import Http "../Http";
import Types "../Types";
import Protocol "OpenRouterProtocol";
import Provider "Provider";

module {
    let TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
    public let exchange_cycles = Http.OUTCALL_CYCLES;

    public func authorizationUrl(callbackUrl : Text, challenge : Text) : Text {
        Protocol.authorizationUrl(callbackUrl, challenge);
    };

    public func exchange(code : Text, verifier : Text) : async* Types.ExchangeResult {
        let response = await* Http.postJson(
            TOKEN_URL,
            Protocol.exchangeBody(code, verifier),
        );
        let value = switch (response) {
            case (#ok(value)) value;
            case (#err(failure)) return #err(failure);
        };
        let ?key = Protocol.credential(value.body) else {
            return #err({
                message = "Connection provider returned an invalid credential";
                charged_cycles = value.charged_cycles;
            });
        };
        #ok({ credential = key; charged_cycles = value.charged_cycles });
    };

    public func adapter() : Provider.Adapter {
        {
            authorization_origin = Protocol.authorization_origin;
            authorizationUrl;
            exchange_cycles;
            exchange;
        };
    };
};
