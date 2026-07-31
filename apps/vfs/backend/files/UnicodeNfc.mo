import Char "mo:core/Char";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";
import Data "UnicodeNfcData";

module {
    let S_BASE : Nat = 0xAC00;
    let L_BASE : Nat = 0x1100;
    let V_BASE : Nat = 0x1161;
    let T_BASE : Nat = 0x11A7;
    let L_COUNT : Nat = 19;
    let V_COUNT : Nat = 21;
    let T_COUNT : Nat = 28;
    let N_COUNT : Nat = 588;
    let S_COUNT : Nat = 11_172;

    type Decomposition = {
        offset : Nat;
        length : Nat;
    };

    public let unicodeVersion : Text = Data.unicodeVersion;
    public let unicodeLicenseNotice : Text = Data.unicodeLicenseNotice;

    // Unicode Normalization Process for Stabilized Strings (NPSS): a name is
    // admitted only when every scalar is assigned in the pinned UCD and the
    // complete text is NFC. This keeps durable path identity stable when host
    // JavaScript engines implement different Unicode versions.
    public func isStabilizedNfc(value : Text) : Bool {
        for (character in value.chars()) {
            if (not isAssigned(scalar(character))) return false;
        };
        isNfc(value);
    };

    // Exact NFC validation. The quick-check pass settles ordinary text without
    // allocation. MAYBE input is fully canonically decomposed, stably ordered,
    // canonically composed, and compared scalar-for-scalar with the input.
    public func isNfc(value : Text) : Bool {
        var lastCombiningClass = 0;
        var maybe = false;
        for (character in value.chars()) {
            let codePoint = scalar(character);
            if (codePoint <= 0x7F) {
                lastCombiningClass := 0;
            } else {
                let combiningClass = canonicalCombiningClass(codePoint);
                if (
                    combiningClass != 0 and
                    lastCombiningClass > combiningClass
                ) return false;
                switch (quickCheck(codePoint)) {
                    case (1) return false;
                    case (2) maybe := true;
                    case (_) {};
                };
                lastCombiningClass := combiningClass;
            };
        };
        if (not maybe) return true;
        normalizedScalarsEqual(value);
    };

    // Segment-level text grammar shared by direct names, cursors, and
    // defensive stored-node validation. Length and dot-segment bounds stay in
    // PlainService because they are Files protocol constants.
    public func isCanonicalNameText(value : Text) : Bool {
        var empty = true;
        var leadingWhitespace = false;
        var trailingWhitespace = false;
        for (character in value.chars()) {
            let codePoint = scalar(character);
            if (
                isControl(codePoint) or
                codePoint == 0x2F or
                codePoint == 0x5C or
                not isAssigned(codePoint)
            ) return false;
            let whitespace = isWhiteSpace(codePoint);
            if (empty) {
                empty := false;
                leadingWhitespace := whitespace;
            };
            trailingWhitespace := whitespace;
        };
        if (empty or leadingWhitespace or trailingWhitespace) return false;
        isNfc(value);
    };

    func normalizedScalarsEqual(value : Text) : Bool {
        let input = Text.toArray(value);
        let capacity = input.size() * Data.maximumCanonicalDecomposition;
        let decomposed = VarArray.repeat<Nat>(0, capacity);
        var decomposedSize = 0;

        func appendOrdered(codePoint : Nat) {
            assert (decomposedSize < capacity);
            let combiningClass = canonicalCombiningClass(codePoint);
            var insertion = decomposedSize;
            while (combiningClass != 0 and insertion > 0) {
                let previous = decomposed[insertion - 1];
                let previousClass = canonicalCombiningClass(previous);
                if (
                    previousClass == 0 or
                    previousClass <= combiningClass
                ) {
                    decomposed[insertion] := codePoint;
                    decomposedSize += 1;
                    return;
                };
                decomposed[insertion] := previous;
                insertion -= 1;
            };
            decomposed[insertion] := codePoint;
            decomposedSize += 1;
        };

        for (character in input.vals()) {
            let codePoint = scalar(character);
            if (isHangulSyllable(codePoint)) {
                let syllableIndex = codePoint - S_BASE;
                appendOrdered(L_BASE + syllableIndex / N_COUNT);
                appendOrdered(
                    V_BASE + (syllableIndex % N_COUNT) / T_COUNT
                );
                let trailingIndex = syllableIndex % T_COUNT;
                if (trailingIndex != 0) {
                    appendOrdered(T_BASE + trailingIndex);
                };
            } else {
                switch (canonicalDecomposition(codePoint)) {
                    case null appendOrdered(codePoint);
                    case (?decomposition) {
                        var index = 0;
                        while (index < decomposition.length) {
                            appendOrdered(
                                u24(
                                    Data.decompositionPool,
                                    (decomposition.offset + index) * 3,
                                )
                            );
                            index += 1;
                        };
                    };
                };
            };
        };

        let composed = VarArray.repeat<Nat>(0, decomposedSize);
        var composedSize = 0;
        var starterIndex : ?Nat = null;
        var lastCombiningClass = 0;
        var index = 0;
        while (index < decomposedSize) {
            let codePoint = decomposed[index];
            let combiningClass = canonicalCombiningClass(codePoint);
            var consumed = false;
            switch (starterIndex) {
                case (?starter) {
                    if (
                        lastCombiningClass == 0 or
                        lastCombiningClass < combiningClass
                    ) {
                        switch (compose(composed[starter], codePoint)) {
                            case (?composedCodePoint) {
                                composed[starter] := composedCodePoint;
                                consumed := true;
                            };
                            case null {};
                        };
                    };
                };
                case null {};
            };
            if (not consumed) {
                composed[composedSize] := codePoint;
                if (combiningClass == 0) {
                    starterIndex := ?composedSize;
                    lastCombiningClass := 0;
                } else {
                    lastCombiningClass := combiningClass;
                };
                composedSize += 1;
            };
            index += 1;
        };

        if (composedSize != input.size()) return false;
        index := 0;
        while (index < composedSize) {
            if (composed[index] != scalar(input[index])) return false;
            index += 1;
        };
        true;
    };

    func canonicalCombiningClass(codePoint : Nat) : Nat {
        switch (
            rangeRecord(
                Data.combiningClassRanges,
                Data.combiningClassRangeCount,
                7,
                codePoint,
            )
        ) {
            case null 0;
            case (?offset) byte(Data.combiningClassRanges, offset + 6);
        };
    };

    func quickCheck(codePoint : Nat) : Nat {
        switch (
            rangeRecord(
                Data.quickCheckRanges,
                Data.quickCheckRangeCount,
                7,
                codePoint,
            )
        ) {
            case null 0;
            case (?offset) byte(Data.quickCheckRanges, offset + 6);
        };
    };

    func isAssigned(codePoint : Nat) : Bool {
        rangeRecord(
            Data.assignedRanges,
            Data.assignedRangeCount,
            6,
            codePoint,
        ) != null;
    };

    func canonicalDecomposition(
        codePoint : Nat
    ) : ?Decomposition {
        var low = 0;
        var high = Data.decompositionCount;
        while (low < high) {
            let middle = low + (high - low) / 2;
            let offset = middle * 6;
            let candidate = u24(Data.decompositionIndex, offset);
            if (codePoint < candidate) {
                high := middle;
            } else if (codePoint > candidate) {
                low := middle + 1;
            } else {
                return ?{
                    offset = u16(Data.decompositionIndex, offset + 3);
                    length = byte(Data.decompositionIndex, offset + 5);
                };
            };
        };
        null;
    };

    func compose(first : Nat, second : Nat) : ?Nat {
        if (
            first >= L_BASE and first < L_BASE + L_COUNT and
            second >= V_BASE and second < V_BASE + V_COUNT
        ) {
            return ?(
                S_BASE +
                (first - L_BASE) * N_COUNT +
                (second - V_BASE) * T_COUNT
            );
        };
        if (
            isHangulSyllable(first) and
            (first - S_BASE) % T_COUNT == 0 and
            second > T_BASE and second < T_BASE + T_COUNT
        ) {
            return ?(first + second - T_BASE);
        };

        var low = 0;
        var high = Data.compositionCount;
        while (low < high) {
            let middle = low + (high - low) / 2;
            let offset = middle * 9;
            let candidateFirst = u24(Data.compositions, offset);
            let candidateSecond = u24(Data.compositions, offset + 3);
            if (
                first < candidateFirst or
                (first == candidateFirst and second < candidateSecond)
            ) {
                high := middle;
            } else if (
                first > candidateFirst or
                (first == candidateFirst and second > candidateSecond)
            ) {
                low := middle + 1;
            } else {
                return ?u24(Data.compositions, offset + 6);
            };
        };
        null;
    };

    func rangeRecord(
        data : Blob,
        count : Nat,
        width : Nat,
        codePoint : Nat,
    ) : ?Nat {
        var low = 0;
        var high = count;
        while (low < high) {
            let middle = low + (high - low) / 2;
            let offset = middle * width;
            let first = u24(data, offset);
            let last = u24(data, offset + 3);
            if (codePoint < first) {
                high := middle;
            } else if (codePoint > last) {
                low := middle + 1;
            } else {
                return ?offset;
            };
        };
        null;
    };

    func isHangulSyllable(codePoint : Nat) : Bool {
        codePoint >= S_BASE and codePoint < S_BASE + S_COUNT;
    };

    func isControl(codePoint : Nat) : Bool {
        codePoint <= 0x1F or
        (codePoint >= 0x7F and codePoint <= 0x9F);
    };

    // Unicode White_Space, pinned explicitly instead of delegating to compiler
    // or Rust tables whose Unicode versions can differ between test/runtime.
    func isWhiteSpace(codePoint : Nat) : Bool {
        (codePoint >= 0x09 and codePoint <= 0x0D) or
        codePoint == 0x20 or
        codePoint == 0x85 or
        codePoint == 0xA0 or
        codePoint == 0x1680 or
        (codePoint >= 0x2000 and codePoint <= 0x200A) or
        (codePoint >= 0x2028 and codePoint <= 0x2029) or
        codePoint == 0x202F or
        codePoint == 0x205F or
        codePoint == 0x3000;
    };

    func scalar(character : Char) : Nat {
        Nat32.toNat(Char.toNat32(character));
    };

    func byte(data : Blob, offset : Nat) : Nat {
        Nat8.toNat(data[offset]);
    };

    func u16(data : Blob, offset : Nat) : Nat {
        byte(data, offset) * 0x100 +
        byte(data, offset + 1);
    };

    func u24(data : Blob, offset : Nat) : Nat {
        byte(data, offset) * 0x10000 +
        byte(data, offset + 1) * 0x100 +
        byte(data, offset + 2);
    };
};
