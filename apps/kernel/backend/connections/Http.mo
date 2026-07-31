import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Text "mo:core/Text";
import Cycles "mo:core/Cycles";
import IC "../aaa_interface";

module {
    public let OUTCALL_CYCLES : Nat = 350_000_000_000;
    let MAX_TOKEN_RESPONSE_BYTES : Nat64 = 16_384;

    public type Response = { body : Text; charged_cycles : Nat };
    public type Failure = { message : Text; charged_cycles : Nat };
    public type Result = { #ok : Response; #err : Failure };

    public func postJson(url : Text, body : Text) : async* Result {
        let response = try {
            await (with cycles = OUTCALL_CYCLES) IC.management.http_request({
                url;
                max_response_bytes = ?MAX_TOKEN_RESPONSE_BYTES;
                method = #post;
                headers = [
                    { name = "content-type"; value = "application/json" },
                    { name = "accept"; value = "application/json" },
                ];
                body = ?Text.encodeUtf8(body);
                transform = null;
                is_replicated = ?false;
            });
        } catch (_) {
            return #err({
                message = "Connection provider request failed";
                charged_cycles = charged();
            });
        };
        let chargedCycles = charged();

        if (response.status < 200 or response.status >= 300) {
            return #err({
                message = "Connection provider rejected the credential exchange (HTTP " #
                    Nat.toText(response.status) # ")";
                charged_cycles = chargedCycles;
            });
        };
        if (response.body.size() > Nat64.toNat(MAX_TOKEN_RESPONSE_BYTES)) {
            return #err({
                message = "Connection provider response is too large";
                charged_cycles = chargedCycles;
            });
        };
        if (not isJson(response.headers)) {
            return #err({
                message = "Connection provider returned an invalid content type";
                charged_cycles = chargedCycles;
            });
        };
        let ?decoded = Text.decodeUtf8(response.body) else {
            return #err({
                message = "Connection provider returned invalid text";
                charged_cycles = chargedCycles;
            });
        };
        #ok({ body = decoded; charged_cycles = chargedCycles });
    };

    func charged() : Nat {
        let refunded = Cycles.refunded();
        if (refunded >= OUTCALL_CYCLES) 0 else OUTCALL_CYCLES - refunded;
    };

    func isJson(headers : [IC.http_header]) : Bool {
        for (header in headers.vals()) {
            if (Text.toLower(header.name) == "content-type") {
                return Text.startsWith(
                    Text.toLower(header.value),
                    #text "application/json",
                );
            };
        };
        false;
    };
};
