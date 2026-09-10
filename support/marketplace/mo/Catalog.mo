// All rights reserved. See ../LICENSE.
import Text "mo:core/Text";
import Runtime "mo:core/Runtime";
import Store "Store";
import Types "Types";
import Rankings "Rankings";
import Pricing "Pricing";

module {
  public type Result<T> = { #ok : T; #err : Text };

  // Match the existing Neutron package ID grammar. This is package
  // compatibility, not a new publisher naming policy.
  public func validAppId(appId : Text) : Bool {
    let length = appId.size();
    if (length < 4 or length > 30) return false;
    var previousSeparator = true;
    for (character in appId.chars()) {
      if (character == '_') {
        if (previousSeparator) return false;
        previousSeparator := true;
      } else {
        if (not ((character >= 'a' and character <= 'z') or (character >= '0' and character <= '9'))) return false;
        previousSeparator := false;
      };
    };
    not previousSeparator;
  };

  public func validPrice(priceUsdMicros : Nat) : Bool {
    Pricing.validateListingPrice(priceUsdMicros) == #ok(());
  };

  public func hasText(value : Text) : Bool {
    Text.trim(value, #predicate(func(character : Char) : Bool {
      character == ' ' or character == '\n' or character == '\r' or character == '\t';
    })) != "";
  };

  public func validateListing(appId : Text, title : Text, summary : Text, priceUsdMicros : Nat) : Result<()> {
    if (not validAppId(appId)) return #err("App IDs must use 4–30 lowercase letters or digits, separated by single underscores.");
    if (not hasText(title)) return #err("Enter an app title.");
    if (not hasText(summary)) return #err("Enter a short app description.");
    if (not validPrice(priceUsdMicros)) return #err("An app must be free or priced between $1 and $50 before discounts.");
    #ok(());
  };

  public type ListingInput = {
    appId : Text; title : Text; summary : Text; description : Text;
    priceUsdMicros : Nat; expectedRevision : ?Nat64;
    visible : Bool; iconArtifact : ?Nat64; screenshots : [Nat64];
  };

  func must<T>(value : { #ok : T; #err : Types.Error }) : T {
    switch (value) { case (#ok(result)) result; case (#err(error)) Runtime.trap("Catalog storage invariant: " # debug_show(error)) };
  };

  public func approvedRelease(db : Store.DB, app : Types.App) : ?Types.Candidate {
    let ?candidateId = app.approvedCandidate else return null;
    let ?candidate = db.candidates.get(candidateId) else return null;
    if (candidate.appId != app.appId or not candidate.published or candidate.state != #approved) return null;
    ?candidate;
  };

  public func eligible(db : Store.DB, app : Types.App) : Bool {
    app.visible and approvedRelease(db, app) != null;
  };

  func sameListing(app : Types.App, input : ListingInput) : Bool {
    app.title == input.title and app.summary == input.summary and app.description == input.description and
    app.priceUsdMicros == input.priceUsdMicros and app.visible == input.visible and
    app.iconArtifact == input.iconArtifact and app.screenshots == input.screenshots;
  };

  func imageAvailable(db : Store.DB, artifactId : Nat64, owner : Principal) : Bool {
    let ?artifact = db.artifacts.get(artifactId) else return false;
    if (not Text.startsWith(artifact.mediaType, #text("image/"))) return false;
    if (artifact.publicLegacy) return true;
    for (upload in db.uploads.by_artifact.rangeIter({ gt = null; gte = ?artifactId; lt = null; lte = ?artifactId; dir = #fwd }, null)) {
      if (upload.owner == owner and upload.purpose == #image and upload.state == #attached) return true;
    };
    false;
  };

  public func save(db : Store.DB, owner : Principal, input : ListingInput, now : Int) : Result<Types.App> {
    switch (validateListing(input.appId, input.title, input.summary, input.priceUsdMicros)) {
      case (#err(error)) return #err(error);
      case (#ok(())) {};
    };
    switch (input.iconArtifact) {
      case (?artifactId) { if (not imageAvailable(db, artifactId, owner)) return #err("The app icon must reference a completed image upload.") };
      case null {};
    };
    for (artifactId in input.screenshots.vals()) {
      if (not imageAvailable(db, artifactId, owner)) return #err("Screenshots must reference completed image uploads.");
    };
    let previous = db.apps.by_appId.lookup(input.appId);
    switch (previous) {
      case (?app) {
        if (app.owner != owner) return #err("This app ID belongs to another publisher.");
        // Exact repeats are harmless even if their expected revision is now old.
        if (sameListing(app, input)) return #ok(app);
        if (input.expectedRevision != ?app.revision) return #err("The listing changed. Review its current revision before saving.");
        if (app.revision == 18_446_744_073_709_551_615) return #err("The listing revision is exhausted.");
      };
      case null {
        switch (input.expectedRevision) {
          case null {};
          case (?revision) { if (revision != 0) return #err("This listing does not exist at the expected revision.") };
        };
      };
    };
    let revision : Nat64 = switch (previous) { case null 1; case (?app) app.revision + 1 };
    let createdAtNs = switch (previous) { case null now; case (?app) app.createdAtNs };
    let listing : Types.CreateListing = {
      appId = input.appId; revision; owner; title = input.title; summary = input.summary;
      description = input.description; priceUsdMicros = input.priceUsdMicros;
      iconArtifact = input.iconArtifact; screenshots = input.screenshots; createdAtNs = now;
    };
    ignore must(db.listings.insert(listing));
    let app : Types.App = switch (previous) {
      case (?previousApp) must(db.apps.update({ previousApp with
        title = input.title; summary = input.summary; description = input.description;
        priceUsdMicros = input.priceUsdMicros; revision; visible = input.visible;
        iconArtifact = input.iconArtifact; screenshots = input.screenshots; updatedAtNs = now;
      }));
      case null {
        let id = must(db.apps.insert({
          appId = input.appId; owner; title = input.title; summary = input.summary;
          description = input.description; priceUsdMicros = input.priceUsdMicros; revision;
          approvedCandidate = null; visible = input.visible; iconArtifact = input.iconArtifact;
          screenshots = input.screenshots; ratingCount = 0; ratingTotal = 0; createdAtNs; updatedAtNs = now;
        }));
        switch (db.apps.get(id)) { case (?saved) saved; case null Runtime.trap("Saved app missing") };
      };
    };
    Rankings.refreshEligibility(db, app);
    #ok(app);
  };

}
