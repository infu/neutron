import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";

module {
    public let BODY_SIZES : [Nat] = [1_040, 4_112, 16_400, 36_880];
    public let PREFIX_BYTES = 2_319;

    public func envelope(
        bodySize : Nat,
        messageNumber : Nat,
        epoch : Nat,
        fingerprintByte : Nat8,
    ) : Blob {
        envelopeWithFingerprint(
            bodySize,
            messageNumber,
            epoch,
            repeatBlob(32, fingerprintByte),
        );
    };

    public func envelopeWithFingerprint(
        bodySize : Nat,
        messageNumber : Nat,
        epoch : Nat,
        fingerprint : Blob,
    ) : Blob {
        assert (fingerprint.size() == 32);
        let fingerprintBytes = Blob.toArray(fingerprint);
        Blob.fromArray(
            Array.tabulate<Nat8>(
                PREFIX_BYTES + bodySize,
                func(index) {
                    if (index == 0) return 1;
                    if (index == 1) return 0;
                    if (index == 2) return 1;
                    if (index >= 3 and index < 11) {
                        return bigEndianByte(epoch, 10 - index);
                    };
                    if (index >= 11 and index < 43) return fingerprintBytes[index - 11];
                    if (index >= 43 and index < 57) return 0x44;
                    if (index == 57) return Nat8.fromNat((messageNumber / 256) % 256);
                    if (index == 58) return Nat8.fromNat(messageNumber % 256);
                    if (index >= 59 and index < 227) return 0x55;
                    if (index >= 227 and index < 239) {
                        return Nat8.fromNat(index - 226);
                    };
                    if (index >= 239 and index < 2_303) return 0x66;
                    if (index >= 2_303 and index < 2_315) {
                        return Nat8.fromNat(index - 2_270);
                    };
                    if (index >= 2_315 and index < PREFIX_BYTES) {
                        return bigEndianByte(bodySize, 2_318 - index);
                    };
                    0x77;
                },
            )
        );
    };

    public func repeatBlob(size : Nat, value : Nat8) : Blob {
        Blob.fromArray(Array.tabulate<Nat8>(size, func(_) { value }));
    };

    public func messageId(messageNumber : Nat) : Blob {
        Blob.fromArray(
            Array.tabulate<Nat8>(
                16,
                func(index) {
                    if (index < 14) return 0x44;
                    if (index == 14) return Nat8.fromNat((messageNumber / 256) % 256);
                    Nat8.fromNat(messageNumber % 256);
                },
            )
        );
    };

    public func replace(input : Blob, index : Nat, value : Nat8) : Blob {
        let bytes = Blob.toArray(input);
        Blob.fromArray(
            Array.tabulate<Nat8>(
                bytes.size(),
                func(cursor) {
                    if (cursor == index) value else bytes[cursor];
                },
            )
        );
    };

    public func appendByte(input : Blob, value : Nat8) : Blob {
        let bytes = Blob.toArray(input);
        Blob.fromArray(
            Array.tabulate<Nat8>(
                bytes.size() + 1,
                func(index) {
                    if (index == bytes.size()) value else bytes[index];
                },
            )
        );
    };

    public func copyHeaderNonceToBody(input : Blob) : Blob {
        let bytes = Blob.toArray(input);
        Blob.fromArray(
            Array.tabulate<Nat8>(
                bytes.size(),
                func(index) {
                    if (index >= 2_303 and index < 2_315) {
                        bytes[227 + index - 2_303];
                    } else bytes[index];
                },
            )
        );
    };

    func bigEndianByte(value : Nat, shiftBytes : Nat) : Nat8 {
        var shifted = value;
        var remaining = shiftBytes;
        while (remaining > 0) {
            shifted /= 256;
            remaining -= 1;
        };
        Nat8.fromNat(shifted % 256);
    };
};
