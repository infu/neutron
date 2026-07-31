import Base64 "mo:core/Base64";
import Blob "mo:core/Blob";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import IC "../aaa_interface";

module {
    public func base64Url(value : Blob) : Text {
        Text.trimEnd(
            Text.map(
                Base64.encode(value),
                func(char) {
                    if (char == '+') '-'
                    else if (char == '/') '_'
                    else char;
                },
            ),
            #char '=',
        );
    };

    public func hashText(value : Text) : Blob {
        Sha256.fromBlob(#sha256, Text.encodeUtf8(value));
    };

    public func pkceChallenge(verifier : Text) : Text {
        base64Url(hashText(verifier));
    };

    public func randomToken() : async* Text {
        base64Url(await IC.management.raw_rand());
    };
};
