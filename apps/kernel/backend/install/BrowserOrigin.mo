import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Iter "mo:core/Iter";
import Nat8 "mo:core/Nat8";
import Text "mo:core/Text";
import Codec "../certified_assets/Codec";

module {
    let SURFACE_DOMAIN = "neutron.app-browser-surface-origin.v1";
    let NONCE_BYTES = 16;

    public func surfaceNonce(
        browserOriginNonce : Text,
        surfaceKey : Text,
    ) : Text {
        assert (isValidNonce(browserOriginNonce));
        assert (surfaceKey != "");
        truncate(Codec.sha256Chunks([
            Codec.lpText(SURFACE_DOMAIN),
            Codec.lpText(browserOriginNonce),
            Codec.lpText(surfaceKey),
        ]));
    };

    public func surfacePrefix(
        browserOriginNonce : Text,
        surfaceKey : Text,
    ) : Text {
        let nonce = surfaceNonce(browserOriginNonce, surfaceKey);
        "i" # Text.fromIter(Iter.take(nonce.chars(), 24));
    };

    public func isValidNonce(value : Text) : Bool {
        if (value.size() != 32) return false;
        for (char in value.chars()) {
            if (not (
                (char >= '0' and char <= '9') or
                (char >= 'a' and char <= 'f')
            )) return false;
        };
        true;
    };

    func truncate(value : Blob) : Text {
        Codec.hex(truncateBlob(value));
    };

    func truncateBlob(value : Blob) : Blob {
        assert (value.size() >= NONCE_BYTES);
        let bytes = Blob.toArray(value);
        Blob.fromArray(Array.tabulate<Nat8>(
            NONCE_BYTES,
            func(index) { bytes[index] },
        ));
    };
};
