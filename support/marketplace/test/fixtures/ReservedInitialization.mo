// All rights reserved. See ../../LICENSE.
import Initialization "../../mo/Initialization";
import PublisherStore "../../mo/PublisherStore";
import Store "../../mo/Store";
import Types "../../mo/Types";

persistent actor class ReservedInitialization(initial : Types.Init) {
  let publisherMemory = PublisherStore.init();
  let memory = Initialization.memory(initial, 1, publisherMemory);
  transient let db = Store.Use(memory, publisherMemory);
  public query func app(appId : Text) : async ?Types.App { Store.getApp(db, appId) };
  public query func apps() : async Nat { db.apps.size() };
};
