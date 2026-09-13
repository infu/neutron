// All rights reserved. See ../LICENSE.
import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Access "./Access";
import API "./API";
import Catalog "./Catalog";
import Encoding "./Encoding";
import Publishing "./Publishing";
import Store "./Store";
import Types "./Types";

module {
  public type PurchaseGraph = {
    apps : [Types.App];
    releases : Map.Map<Text, Types.Candidate>;
    selection : [API.ReleaseSelection];
  };
  type Purpose = {
    #purchase : { buyer : Principal; mode : ?API.ChannelMode };
    #installation : { owner : Principal; mode : API.ChannelMode };
    #promotion : Map.Map<Text, Types.Candidate>;
  };
  type Required = { appId : Text; minimum : Nat; root : Bool };
  type Resolved = { candidate : Types.Candidate; app : ?Types.App; selection : ?API.ReleaseSelection };

  func error<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };

  public func validInstallerId(id : Text) : Bool {
    Catalog.validAppId(id) and id != "constructor" and id != "prototype" and id != "__proto__";
  };

  public func installerCompatible(candidate : Types.Candidate, artifact : Types.Artifact) : Bool {
    validInstallerId(candidate.appId) and Publishing.validReleaseVersion(candidate.version) and
    candidate.digest.size() == 32 and candidate.digest == artifact.digest and
    artifact.size > 0 and Nat64.toNat(artifact.size) <= Publishing.maxPackageBytes;
  };

  // All three operations resolve one synchronous graph. Their differences are
  // protocol rules, kept explicit here: purchases omit owned price lines,
  // installations require access and omit the installed Kernel, and promotion
  // validates the resulting stable graph with the whole proposed batch overlaid.
  func resolve(db : Store.DB, roots : [Text], purpose : Purpose) : API.Result<PurchaseGraph> {
    let apps = List.empty<Types.App>();
    let releases = Map.empty<Text, Types.Candidate>();
    let selection = List.empty<API.ReleaseSelection>();
    let digests = Map.empty<Text, Text>();
    let pending = List.empty<Required>();
    var totalBytes = 0;
    let forward = switch (purpose) { case (#installation(_)) true; case (_) false };
    let includeKernel = switch (purpose) {
      case (#purchase(value)) value.mode != null;
      case (#installation(_)) false;
      case (#promotion(_)) true;
    };

    func lookup(required : Required) : API.Result<Resolved> {
      let appId = required.appId;
      switch (purpose) {
        case (#purchase(value)) {
          let ?app = Store.getApp(db, appId) else return error(
            if (required.root) "app_missing" else "dependency_unavailable",
            "No marketplace app exists for " # appId # ".");
          let selected = switch (value.mode) {
            case null Catalog.approvedRelease(db, app);
            case (?mode) Catalog.release(db, app, mode);
          };
          let ?candidate = selected else return error("not_available", "No approved published release is available for " # appId # ".");
          #ok({ candidate; app = ?app; selection = null });
        };
        case (#installation(value)) {
          let ?app = Store.getApp(db, appId) else return error("dependency_unavailable", "No marketplace app exists for " # appId # ".");
          let ?entry = Catalog.selection(db, app, value.mode) else return error("release_unavailable", "No approved published release is available in the selected channel for " # appId # ".");
          let ?candidate = Store.getCandidate(db, entry.candidateId) else Runtime.trap("Selected candidate disappeared without an await");
          #ok({ candidate; app = ?app; selection = ?entry });
        };
        case (#promotion(selected)) {
          let candidate = switch (Map.get(selected, Text.compare, appId)) {
            case (?value) value;
            case null {
              let ?app = Store.getApp(db, appId) else return error("dependency_unavailable", "No stable dependency exists for " # appId # ".");
              let ?value = Catalog.release(db, app, #stable_) else return error("dependency_unavailable", "Promote the required " # appId # " beta in this same transaction.");
              value;
            };
          };
          #ok({ candidate; app = null; selection = null });
        };
      };
    };

    func admit(resolved : Resolved) : API.Result<()> {
      let candidate = resolved.candidate;
      let appId = candidate.appId;
      switch (purpose) {
        case (#purchase(value)) {
          let ?app = resolved.app else Runtime.trap("Purchase release has no app");
          let owned = Store.getEntitlement(db, value.buyer, appId) != null;
          if (appId != "kernel" and not owned and not app.visible) return error("not_available", "This required app is not available to acquire: " # appId # ".");
          if (appId != "kernel" and not owned) List.add(apps, app);
          switch (value.mode) {
            case null {};
            case (?mode) {
              let ?entry = Catalog.selection(db, app, mode) else Runtime.trap("Selected release disappeared from synchronous snapshot");
              List.add(selection, entry);
            };
          };
        };
        case (#installation(value)) {
          let ?app = resolved.app else Runtime.trap("Installation release has no app");
          let ?artifact = Store.getArtifact(db, candidate.artifactId) else return error("release_unavailable", "The package for " # appId # " is unavailable.");
          if (not installerCompatible(candidate, artifact)) return error("installer_incompatible", "The approved " # appId # " release does not fit the existing Neutron package format.");
          if (app.priceUsdMicros > 0 and Store.getEntitlement(db, value.owner, appId) == null) return error("dependency_not_owned", "This selection needs the paid app " # appId # ". Add it to My apps before installing.");
          if (not Access.canAccess(db, value.owner, candidate.artifactId, #buyer)) return error("release_unavailable", "The approved package for " # appId # " is not accessible to this Neutron.");
          // Existing installer wire-format limits, never catalog quotas.
          if (Map.size(releases) >= 64 or totalBytes + Nat64.toNat(artifact.size) > 67_108_864) return error("installer_batch_limit", "This selection exceeds Neutron's existing 64-package or 64 MiB install batch format. Select fewer apps.");
          let digest = Encoding.hex(candidate.digest);
          switch (Map.get(digests, Text.compare, digest)) {
            case (?other) return error("duplicate_package", "The same package digest cannot identify both " # other # " and " # appId # ".");
            case null {};
          };
          Map.add(digests, Text.compare, digest, appId);
          totalBytes += Nat64.toNat(artifact.size);
          let ?entry = resolved.selection else Runtime.trap("Installation release has no channel selection");
          List.add(selection, entry);
        };
        case (#promotion(_)) {};
      };
      #ok(());
    };

    // Preserve the historical traversal and error precedence: installations
    // visit roots/dependencies in forward order, purchase/promotion use a stack.
    for (appId in (if (forward) Array.reverse(roots) else roots).vals()) {
      List.add(pending, { appId; minimum = 100; root = true });
    };
    label walk loop {
      let ?required = List.removeLast(pending) else break walk;
      if (required.appId != "kernel" or includeKernel) {
        let existing = Map.get(releases, Text.compare, required.appId);
        let resolved = switch (existing) {
          case (?candidate) { { candidate; app = null; selection = null } };
          case null switch (lookup(required)) { case (#ok(value)) value; case (#err(value)) return #err(value) };
        };
        let candidate = resolved.candidate;
        if (candidate.version < required.minimum) return error("dependency_version", switch (purpose) {
          case (#promotion(_)) "The resulting stable " # required.appId # " does not satisfy the required version.";
          case (_) "The selected " # required.appId # " release does not satisfy the dependency minimum.";
        });
        if (existing == null) {
          switch (admit(resolved)) { case (#ok(())) {}; case (#err(value)) return #err(value) };
          Map.add(releases, Text.compare, required.appId, candidate);
          let dependencies = if (forward) Array.reverse(candidate.dependencies) else candidate.dependencies;
          for (dependency in dependencies.vals()) {
            List.add(pending, { appId = dependency.appId; minimum = dependency.minVersion; root = false });
          };
        };
      };
    };
    #ok({ apps = List.toArray(apps); releases; selection = Array.sort<API.ReleaseSelection>(List.toArray(selection), func(a, b) { Text.compare(a.appId, b.appId) }) });
  };

  public func purchase(db : Store.DB, buyer : Principal, roots : [Text], mode : ?API.ChannelMode) : API.Result<PurchaseGraph> {
    let sorted = Array.sort<Text>(roots, Text.compare);
    var previous : ?Text = null;
    for (appId in sorted.vals()) {
      if (previous == ?appId) return error("duplicate_app", "Select each app once.");
      previous := ?appId;
      if (appId == "kernel") return error("invalid_app", "Upgrade the Kernel through Settings; it is not an app purchase.");
    };
    resolve(db, sorted, #purchase({ buyer; mode }));
  };

  // The repository validates/normalizes root IDs before resolving dependencies.
  public func installation(db : Store.DB, owner : Principal, roots : [Text], mode : API.ChannelMode) : API.Result<[API.ReleaseSelection]> {
    for (appId in roots.vals()) {
      if (Store.getEntitlement(db, owner, appId) == null) return error("app_not_owned", "Add " # appId # " to My apps before installing it.");
    };
    switch (resolve(db, roots, #installation({ owner; mode }))) {
      case (#err(value)) #err(value);
      case (#ok(value)) #ok(value.selection);
    };
  };

  public func promotion(db : Store.DB, selected : Map.Map<Text, Types.Candidate>) : API.Result<()> {
    let roots = List.empty<Text>();
    for ((appId, _) in Map.entries(selected)) List.add(roots, appId);
    switch (resolve(db, List.toArray(roots), #promotion(selected))) {
      case (#err(value)) #err(value);
      case (#ok(_)) #ok(());
    };
  };
};
