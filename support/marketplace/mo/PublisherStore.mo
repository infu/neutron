// All rights reserved. See ../LICENSE.
import Runtime "mo:core/Runtime";
import Generated "../.private/publishers/.ashroot/lib";

module {
  public type Mem = Generated.Mem;
  public type DB = Generated.DB;
  public type Profile = Generated.Types.PublisherProfile;
  public type CreateProfile = Generated.Types.CreatePublisherProfile;
  public type Stats = Generated.Types.PublisherStat;
  public type AppStats = Generated.Types.PublisherAppStat;
  public type Maintenance = Generated.Types.Store;

  public func init() : Mem {
    let mem = Generated.Mem();
    mem.store.value := ?{
      appsCursor = null;
      acquisitionsCursor = null;
      appsComplete = false;
      acquisitionsComplete = false;
    };
    mem;
  };

  public func Use(mem : Mem) : DB {
    let ?retained = mem.store.value else Runtime.trap("Publisher storage is not initialized");
    Generated.Use(mem, retained);
  };
};
