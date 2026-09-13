// All rights reserved. See ../../../LICENSE.
// Persistent schema. Keep immutable after release. Existing protocol roots and
// listing revisions remain untouched; this root is added once on a keep upgrade.
import Map "mo:core/Map";

module {
  public type Tag = { id : Text; name : Text };
  public type Presentation = {
    title : Text;
    subtitle : Text;
    tags : [Text];
    // Selects an existing listing gallery image, using its existing certified
    // access and retention rules. It does not grant access to an uploaded file.
    coverArtifact : ?Nat64;
    revision : Nat;
  };
  public type Config = { tags : [Tag]; featured : [Text]; revision : Nat };
  public type Mem = {
    var config : Config;
    apps : Map.Map<Text, Presentation>;
  };
  public func init() : Mem {
    { var config = { tags = []; featured = []; revision = 0 }; apps = Map.empty<Text, Presentation>() };
  };
};
