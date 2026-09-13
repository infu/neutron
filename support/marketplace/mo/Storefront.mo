// All rights reserved. See ../LICENSE.
import API "./API";
import Access "./Access";
import Catalog "./Catalog";
import Store "./Store";
import Views "./Views";
import Memory "./memory/storefront/v1";
import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Text "mo:core/Text";

module {
  public type ConfigInput = { tags : [Memory.Tag]; featured : [Text]; expectedRevision : Nat };
  public type AppInput = { appId : Text; title : Text; subtitle : Text; tags : [Text]; coverArtifact : ?Nat64; expectedRevision : Nat };
  public type Selection = { mode : API.ChannelMode; tag : ?Text; search : Text };
  public type BrowseRequest = { request : API.CatalogRequest; mode : API.ChannelMode; tag : ?Text; exclude : [Text] };
  public type Presentation = { title : Text; subtitle : Text; tags : [Memory.Tag]; coverUrl : ?Text; revision : Nat };
  public type App = { release : API.ChannelApp; presentation : Presentation };
  public type Home = { config : Memory.Config; featured : [App] };
  public type Page = { apps : [App]; nextCursor : ?API.Cursor; asOfNs : Int; generation : Nat64; refreshing : Bool };

  func failure<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func contains(values : [Text], value : Text) : Bool { Array.find<Text>(values, func(item) { item == value }) != null };
  func trim(value : Text) : Text { Text.trim(value, #predicate(func(c : Char) : Bool { c == ' ' or c == '\t' or c == '\r' or c == '\n' })) };
  func validTags(mem : Memory.Mem, tags : [Text]) : Bool {
    for (id in tags.vals()) {
      if (Array.find<Memory.Tag>(mem.config.tags, func(tag) { tag.id == id }) == null) return false;
    };
    true;
  };
  func unique(values : [Text]) : Bool {
    let seen = Map.empty<Text, Bool>();
    for (id in values.vals()) {
      if (trim(id) == "" or Map.containsKey(seen, Text.compare, id)) return false;
      Map.add(seen, Text.compare, id, true);
    };
    true;
  };

  public func saveConfig(db : Store.DB, mem : Memory.Mem, input : ConfigInput) : API.Result<Memory.Config> {
    if (input.tags == mem.config.tags and input.featured == mem.config.featured) return #ok(mem.config);
    if (input.expectedRevision != mem.config.revision) return failure("storefront_conflict", "The storefront changed. Read its current revision before saving.");
    if (not unique(Array.map<Memory.Tag, Text>(input.tags, func(tag) { tag.id })) or not unique(input.featured)) return failure("storefront_input", "Tag IDs and featured app IDs must be nonempty and unique.");
    for (tag in input.tags.vals()) if (trim(tag.name) == "") return failure("storefront_input", "Give each tag a display label.");
    for (appId in input.featured.vals()) if (Store.getApp(db, appId) == null) return failure("app_not_found", "A featured app must have an existing listing.");
    mem.config := { tags = input.tags; featured = input.featured; revision = mem.config.revision + 1 };
    // Renaming a label keeps assignments; removing a tag removes its assignments
    // in this same commit, so it cannot silently reappear when an ID is reused.
    for ((id, value) in Map.entries(mem.apps)) {
      let tags = Array.filter<Text>(value.tags, func(tag) { validTags(mem, [tag]) });
      if (tags != value.tags) Map.add(mem.apps, Text.compare, id, { value with tags; revision = value.revision + 1 });
    };
    #ok(mem.config);
  };

  public func saveApp(db : Store.DB, mem : Memory.Mem, input : AppInput) : API.Result<Memory.Presentation> {
    let ?app = Store.getApp(db, input.appId) else return failure("app_not_found", "This app could not be found.");
    let previous = Map.get(mem.apps, Text.compare, input.appId);
    let revision = switch (previous) { case null 0; case (?value) {
      if (value.title == input.title and value.subtitle == input.subtitle and value.tags == input.tags and value.coverArtifact == input.coverArtifact) return #ok(value);
      value.revision;
    } };
    if (revision != input.expectedRevision) return failure("storefront_conflict", "This app's presentation changed. Read its current revision before saving.");
    if (not unique(input.tags) or not validTags(mem, input.tags)) return failure("storefront_input", "Choose distinct IDs from the storefront tags.");
    switch (input.coverArtifact) {
      case null {};
      case (?id) {
        if (Array.find<Nat64>(app.screenshots, func(image) { image == id }) == null) return failure("storefront_image", "Choose a cover from the app's saved listing images.");
      };
    };
    let value = { title = input.title; subtitle = input.subtitle; tags = input.tags; coverArtifact = input.coverArtifact; revision = revision + 1 };
    Map.add(mem.apps, Text.compare, input.appId, value);
    #ok(value);
  };

  public func presentation(db : Store.DB, mem : Memory.Mem, source : Principal, app : API.App) : Presentation {
    let saved = Map.get(mem.apps, Text.compare, app.appId);
    let tags = switch (saved) {
      case null [];
      case (?value) Array.filterMap<Text, Memory.Tag>(value.tags, func(id) { Array.find<Memory.Tag>(mem.config.tags, func(tag) { tag.id == id }) });
    };
    var coverUrl : ?Text = if (app.screenshots.size() > 0) ?app.screenshots[0] else null;
    switch (saved) {
      case (?value) switch (value.coverArtifact) {
        case (?id) {
          let currentGallery = switch (Store.getApp(db, app.appId)) { case null []; case (?record) record.screenshots };
          let referenced = Array.find<Nat64>(currentGallery, func(image) { image == id }) != null or
            Array.find<Nat64>(app.screenshotArtifacts, func(image) { image == id }) != null;
          // An explicit admin cover can follow a media-only listing edit, while
          // release selection and its frozen title/description remain intact.
          switch (Store.getArtifact(db, id)) {
            case (?artifact) if (referenced and Access.isPublicPath(db, Access.artifactPath(artifact, #image))) coverUrl := Views.imageUrl(db, source, id);
            case null {};
          };
        };
        case null {};
      };
      case null {};
    };
    {
      title = switch (saved) { case (?value) if (trim(value.title) != "") value.title else app.title; case null app.title };
      subtitle = switch (saved) { case (?value) if (trim(value.subtitle) != "") value.subtitle else app.summary; case null app.summary };
      revision = switch (saved) { case (?value) value.revision; case null 0 };
      tags; coverUrl;
    };
  };
  func matches(db : Store.DB, mem : Memory.Mem, source : Principal, app : API.App, tag : ?Text, search : Text) : Bool {
    if (app.appId == "kernel" or app.appId == "marketplace") return false;
    let view = presentation(db, mem, source, app);
    switch (tag) { case (?id) if (Array.find<Memory.Tag>(view.tags, func(tag) { tag.id == id }) == null) return false; case null {} };
    let needle = Text.toLower(trim(search));
    if (Views.matches(app, needle) or Text.contains(Text.toLower(view.title # " " # view.subtitle), #text needle)) return true;
    switch (app.publisherProfile) { case (?profile) if (Text.contains(Text.toLower(profile.publisherId # " " # profile.name), #text needle)) return true; case null {} };
    Array.find<Memory.Tag>(view.tags, func(tag) { Text.contains(Text.toLower(tag.name), #text needle) }) != null;
  };
  public func home(db : Store.DB, mem : Memory.Mem, source : Principal, owner : ?Principal, input : Selection) : Home {
    let featured = List.empty<App>();
    for (id in mem.config.featured.vals()) {
      switch (Store.getApp(db, id)) {
        case (?record) if (Catalog.eligibleFor(db, record, input.mode)) {
          let release = Views.channelApp(db, source, owner, record, input.mode);
          if (matches(db, mem, source, release.app, input.tag, input.search)) List.add(featured, { release; presentation = presentation(db, mem, source, release.app) });
        };
        case null {};
      };
    };
    { config = mem.config; featured = List.toArray(featured) };
  };
  public func browse(db : Store.DB, mem : Memory.Mem, source : Principal, owner : ?Principal, input : BrowseRequest, now : Int) : API.Result<Page> {
    switch (Views.catalogMatching(db, source, owner, input.request, now, input.mode, func(app) {
      not contains(input.exclude, app.appId) and matches(db, mem, source, app, input.tag, input.request.search);
    })) {
      case (#err(error)) #err(error);
      case (#ok(page)) #ok({ page with apps = Array.map<API.ChannelApp, App>(page.apps, func(release) { { release; presentation = presentation(db, mem, source, release.app) } }) });
    };
  };
};
