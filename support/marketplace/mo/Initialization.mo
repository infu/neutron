// All rights reserved. See ../LICENSE.
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Catalog "./Catalog";
import Store "./Store";
import PublisherStore "./PublisherStore";
import Types "./Types";

module {
  public func initialize(db : Store.DB, reservations : [Types.Reservation], now : Int) : { #ok; #err : Text } {
    let owners = Map.empty<Text, Principal>();
    // Check the entire owner inventory before any write. The final installation
    // exposes all reserved IDs together, never a partially imported namespace.
    for (reservation in reservations.vals()) {
      switch (Catalog.validateListing(reservation.appId, reservation.title, "Publisher reservation", "", 0)) {
        case (#err(message)) return #err(message);
        case (#ok(())) {};
      };
      let bytes = Principal.toBlob(reservation.publisher);
      if ((bytes.size() == 0 or bytes[bytes.size() - 1] != (1 : Nat8)) and Store.getTrustedPublishingPrincipal(db) != ?reservation.publisher) return #err("A reserved publisher must be a Neutron canister or the configured trusted publishing principal.");
      switch (Map.get(owners, Text.compare, reservation.appId)) {
        case (?owner) if (owner != reservation.publisher) return #err("Conflicting publishers for reserved app " # reservation.appId);
        case (_) {};
      };
      switch (Store.getApp(db, reservation.appId)) {
        case (?app) if (app.owner != reservation.publisher) return #err("The existing owner of " # reservation.appId # " must be preserved.");
        case (_) {};
      };
      Map.add(owners, Text.compare, reservation.appId, reservation.publisher);
    };
    for (reservation in reservations.vals()) {
      // Repeated imports never replace titles, prices, approvals or ownership.
      if (Store.getApp(db, reservation.appId) == null) {
        switch (Catalog.save(db, reservation.publisher, {
          appId = reservation.appId; title = reservation.title; summary = "Publisher reservation"; description = "";
          priceUsdMicros = 0; expectedRevision = null; visible = true; iconArtifact = null; screenshots = [];
        }, now)) {
          case (#ok(_)) {};
          case (#err(message)) Runtime.trap("Validated marketplace reservation could not be stored: " # message);
        };
      };
    };
    #ok;
  };

  // Use only as the persistent root's initializer. Motoko preserves that root
  // on upgrade; fresh init arguments must never replace existing marketplace data.
  public func memory(initial : Types.Init, now : Int, publishers : PublisherStore.Mem) : Store.Mem {
    let retained = Store.init(initial);
    let db = Store.Use(retained, publishers);
    switch (initial.trustedPublishingPrincipal) {
      case null {};
      case (?principal) {
        let bytes = Principal.toBlob(principal);
        if (bytes.size() == 0 or Principal.isAnonymous(principal)) Runtime.trap("The trusted publishing principal must be authenticated.");
      };
    };
    Store.setTrustedPublishingPrincipal(db, initial.trustedPublishingPrincipal);
    switch (initial.reservations) {
      case null {};
      case (?reservations) switch (initialize(db, reservations, now)) {
        case (#ok) {};
        case (#err(message)) Runtime.trap("Invalid initial marketplace reservations: " # message);
      };
    };
    retained;
  };
};
