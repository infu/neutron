import Codec "../../backend/connections/Codec";
import OpenRouter "../../backend/connections/providers/OpenRouterProtocol";
import FakeProvider "fixtures/FakeConnectionProvider";

assert (Codec.percentEncode("a b+%&=é") == "a%20b%2B%25%26%3D%C3%A9");
assert (
    OpenRouter.exchangeBody("code\"value", "verify\\value") ==
    "{\"code\":\"code\\\"value\",\"code_verifier\":\"verify\\\\value\",\"code_challenge_method\":\"S256\"}"
);
assert (Codec.parseStringField("{\"key\":\"sk-test\"}", "key") == ?"sk-test");
assert (
    Codec.parseStringField("{\"key\":\"one\",\"extra\":1}", "key") ==
    ?"one"
);
assert (
    Codec.parseStringField("{\"key\":\"one\",\"key\":\"two\"}", "key") ==
    null
);
assert (OpenRouter.authorization_origin == "https://openrouter.ai");
assert (
    FakeProvider.authorizationUrl(
        "https://example.test/callback?state=one",
        "challenge/value",
    ) ==
    "https://example.test/callback?state=one&code=fake-code&challenge=challenge%2Fvalue"
);
assert (
    OpenRouter.authorizationUrl(
        "https://example.test/callback?flow=one",
        "challenge/value",
    ) ==
    "https://openrouter.ai/auth?callback_url=https%3A%2F%2Fexample.test%2Fcallback%3Fflow%3Done&code_challenge=challenge%2Fvalue&code_challenge_method=S256"
);
