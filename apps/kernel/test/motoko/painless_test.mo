import Painless "../../backend/lib/Painless";

let callback = Painless.Callback(
    {
        key = "/missing";
        sha256 = null;
        index = 99;
        content_encoding = "";
    },
    {
        chunkFunc = func(_key, _index) { #none };
    },
);

assert (callback.body.size() == 0);
assert (callback.token == null);
