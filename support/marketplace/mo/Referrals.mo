// All rights reserved. See ../LICENSE.
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import API "API";
import Store "Store";
import Types "Types";

module {
  public type Result<T> = { #ok : T; #err : Text };

  // The endpoint supplies the authenticated Neutron, never an owner received
  // as an input argument. Lookup, sequence allocation and insertion contain no
  // await, so concurrent requests by one owner cannot allocate two codes.
  public func getOrCreate(db : Store.DB, owner : Principal, now : Int) : Types.Referral {
    switch (Store.getReferralByOwner(db, owner)) {
      case (?existing) return existing;
      case null {};
    };
    let code = codeFor(Store.allocateReferralCodeId(db));
    switch (Store.insertReferral(db, { owner; code; createdAtNs = now })) {
      case (#ok(referral)) referral;
      // Roll back the sequence allocation as well as any partial storage work.
      case (#err(error)) Runtime.trap("Could not save the referral code: " # debug_show(error));
    };
  };

  // Resolve only the code explicitly supplied for this checkout. The purchase
  // domain freezes this owner/code alongside its configured terms; this module
  // has no sticky referral state and does not calculate a second set of prices.
  public func resolve(db : Store.DB, buyer : Principal, requestedCode : ?Text) : Result<?Types.Referral> {
    let ?input = requestedCode else return #ok(null);
    let code = normalizeCode(input);
    if (code == "") return #ok(null);
    let ?referral = Store.getReferralByCode(db, code) else {
      return #err("This affiliate code is not registered.");
    };
    if (referral.owner == buyer) return #err("You cannot use your own affiliate code.");
    #ok(?referral);
  };

  // Validate a saved browser preference without preparing a purchase, reading
  // rates or allocating a code. Checkout still freezes and validates its own
  // attribution and terms; activating a preference is not a payment quote.
  public func quote(db : Store.DB, buyer : Principal, code : Text) : API.Result<API.ReferralQuote> {
    let referral = switch (resolve(db, buyer, ?code)) {
      case (#err(message)) return #err({ code = "invalid_referral"; message });
      case (#ok(null)) return #err({ code = "invalid_referral"; message = "Enter a discount code." });
      case (#ok(?value)) value;
    };
    let terms = Store.config(db).referralTerms;
    #ok({ code = referral.code; affiliate = referral.owner; discountBps = terms.discountBps; termsVersion = terms.version });
  };

  // Referral codes identify public attribution; they are not authorization
  // secrets. The durable sequence is allocated only after checking ownership.
  public func codeFor(sequence : Nat64) : Text {
    let alphabet : [Char] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
    var remainder = Nat64.toNat(sequence);
    var encoded = "";
    loop {
      encoded := Text.fromChar(alphabet[remainder % 36]) # encoded;
      remainder /= 36;
      if (remainder == 0) return "N" # encoded;
    };
  };

  public func normalizeCode(code : Text) : Text {
    Text.toUpper(Text.trim(code, #predicate(func(character : Char) : Bool {
      character == ' ' or character == '\t' or character == '\r' or character == '\n';
    })));
  };
}
