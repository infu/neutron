import Codec "../Codec";

module {
    public let authorization_origin = "https://openrouter.ai";

    public func authorizationUrl(callbackUrl : Text, challenge : Text) : Text {
        "https://openrouter.ai/auth" #
        "?callback_url=" # Codec.percentEncode(callbackUrl) #
        "&code_challenge=" # Codec.percentEncode(challenge) #
        "&code_challenge_method=S256";
    };

    public func exchangeBody(code : Text, verifier : Text) : Text {
        "{" #
        "\"code\":" # Codec.jsonString(code) # "," #
        "\"code_verifier\":" # Codec.jsonString(verifier) # "," #
        "\"code_challenge_method\":\"S256\"" #
        "}";
    };

    public func credential(responseBody : Text) : ?Text {
        let ?key = Codec.parseStringField(responseBody, "key") else return null;
        if (key.size() < 16 or key.size() > 4096) return null;
        ?key;
    };
};
