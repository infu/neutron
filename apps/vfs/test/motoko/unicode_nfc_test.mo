import Array "mo:core/Array";
import Char "mo:core/Char";
import Nat32 "mo:core/Nat32";
import Text "mo:core/Text";
import UnicodeNfc "../../backend/files/UnicodeNfc";

func text(codePoints : [Nat32]) : Text {
    Text.fromArray(
        Array.map<Nat32, Char>(codePoints, Char.fromNat32)
    );
};

func assertNfc(codePoints : [Nat32]) {
    assert (UnicodeNfc.isNfc(text(codePoints)));
};

func assertNotNfc(codePoints : [Nat32]) {
    assert (not UnicodeNfc.isNfc(text(codePoints)));
};

func assertName(codePoints : [Nat32]) {
    assert (UnicodeNfc.isCanonicalNameText(text(codePoints)));
};

func assertNotName(codePoints : [Nat32]) {
    assert (not UnicodeNfc.isCanonicalNameText(text(codePoints)));
};

assert (UnicodeNfc.unicodeVersion == "16.0.0");

// NormalizationTest-derived canonical decomposition, ordering, blocking,
// exclusions, Hangul, and Unicode 16 composition coverage.
assertNotNfc([0x0065, 0x0301]);
assertNotNfc([0x1E0A, 0x0323]);
assertNotNfc([0x0061, 0x0315, 0x0300]);
assertNotNfc([0x0301, 0x0323]);
assertNotNfc([0x00C5, 0x0301]);
assertNotNfc([0x0958]);
assertNotNfc([0x0340]);
assertNotNfc([0x212B]);
assertNotNfc([0x03A9, 0x0314, 0x0342, 0x0345]);
assertNotNfc([0x1100, 0x1161]);
assertNotNfc([0x1100, 0x1161, 0x11A8]);
assertNotNfc([0xAC00, 0x11A8]);
assertNotNfc([0x1112, 0x1175, 0x11C2]);
assertNotNfc([0x11099, 0x110BA]);
// Unicode 16 added this Tulu-Tigalari canonical composition.
assertNotNfc([0x105D2, 0x0307]);

assertNfc([0x0041, 0x0305, 0x0301]);
assertNfc([0x0078, 0x0301]);
assertNfc([0x0323, 0x0301]);
assertNfc([0x0915, 0x093C]);
assertNfc([0x1161]);
assertNfc([0x1100, 0x0301, 0x1161]);
assertNfc([0x1113, 0x1161]);
assertNfc([0x1100, 0x1176]);
assertNfc([0xAC00, 0x11A7]);
assertNfc([0xAC01, 0x11A8]);
assertNfc([0xD7A3, 0x11A8]);
assertNfc([0x3131]);
assertNfc([0x1FAF]);
assertNfc([0x105C9]);

// Files name grammar: C0/C1 controls, separators, and exact Unicode
// White_Space at either edge are invalid, while interior whitespace is fine.
assertNotName([]);
assertNotName([0x0000]);
assertNotName([0x001F]);
assertNotName([0x007F]);
assertNotName([0x0085]);
assertNotName([0x002F]);
assertNotName([0x005C]);
assertNotName([0x0020, 0x0061]);
assertNotName([0x0061, 0x0020]);
assertNotName([0x00A0, 0x0061]);
assertNotName([0x0061, 0x2003]);
assertNotName([0x3000, 0x0061]);

assertName([0x0061]);
assertName([0x00E9]);
assertName([0x03A9]);
assertName([0xAC00]);
assertName([0x0061, 0x0020, 0x0062]);
assertName([0x0061, 0x00A0, 0x0062]);
assertName([0x0061, 0x2003, 0x0062]);
assertName([0x0323, 0x0301]);
assertName([0x180E, 0x0061]);
assertName([0x200B, 0x0061]);
assertName([0x2060, 0x0061]);
assertName([0xFEFF, 0x0061]);
assertName([0x00AD, 0x0061]);
assertName([0xE000]);

// NPSS pins durable names to scalars assigned in Unicode 16.0.
assertNotName([0x0378]);
assertNotName([0xFDD0]);
assertNotName([0x10FFFF]);

