import CertifiedStore "./CertifiedStore";
import GeneratedRepository "./GeneratedRepository";

persistent actor Repository {
  public type ReadRequest = { index : Nat };
  public type ManifestReadRequest = { id : Text; index : Nat };
  public type PackageReadRequest = { sha256 : Text; index : Nat };
  public type CertifiedValue = CertifiedStore.CertifiedValue;
  public type CertifiedRead = CertifiedStore.CertifiedRead;

  private transient let store = CertifiedStore.Store(
    GeneratedRepository.resources,
  );

  // Transient certification state is rebuilt from the generated immutable
  // resources on install and after every code upgrade.
  do { store.initialize() };

  system func postupgrade() {
    store.initialize();
  };

  public query func repo_info(request : ReadRequest) : async CertifiedRead {
    store.read("/repo/v1/info.json", request.index);
  };

  public query func repo_manifests(request : ReadRequest) : async CertifiedRead {
    store.read("/repo/v1/manifests.json", request.index);
  };

  public query func repo_manifest(
    request : ManifestReadRequest,
  ) : async CertifiedRead {
    store.read(
      "/repo/v1/manifests/" # request.id # ".json",
      request.index,
    );
  };

  public query func repo_package(
    request : PackageReadRequest,
  ) : async CertifiedRead {
    store.read(
      "/repo/v1/packages/" # request.sha256 # ".neutron",
      request.index,
    );
  };
};
