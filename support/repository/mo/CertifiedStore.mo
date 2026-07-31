import CertTree "mo:ic-certification/CertTree";
import Blob "mo:core/Blob";
import CertifiedData "mo:core/CertifiedData";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";

module {
  public type Resource = {
    path : Text;
    sha256 : Blob;
    chunks : [Blob];
  };

  public type CertifiedValue = {
    content : Blob;
    chunks : Nat;
  };

  public type CertifiedRead = {
    certificate : Blob;
    witness : Blob;
    asset : ?CertifiedValue;
  };

  public func findResource(resources : [Resource], path : Text) : ?Resource {
    for (resource in resources.vals()) {
      if (resource.path == path) return ?resource;
    };
    null;
  };

  public func readResource(
    resources : [Resource],
    path : Text,
    index : Nat,
  ) : ?CertifiedValue {
    let ?resource = findResource(resources, path) else return null;
    if (index >= resource.chunks.size()) {
      Runtime.trap("Repository chunk index is out of range");
    };
    ?{
      content = resource.chunks[index];
      chunks = resource.chunks.size();
    };
  };

  public class Store(resources : [Resource]) {
    let certStore = CertTree.newStore();
    let cert = CertTree.Ops(certStore);

    public func initialize() : () {
      for (resource in resources.vals()) {
        cert.put(
          ["http_assets", Text.encodeUtf8(resource.path)],
          resource.sha256,
        );
      };
      cert.setCertifiedData();
    };

    public func read(path : Text, index : Nat) : CertifiedRead {
      let witness = cert.reveal(["http_assets", Text.encodeUtf8(path)]);
      let certificate = switch (CertifiedData.getCertificate()) {
        case (?value) value;
        case null Runtime.trap("Repository certified reads must be queries");
      };
      {
        certificate;
        witness = cert.encodeWitness(witness);
        asset = readResource(resources, path, index);
      };
    };
  };
};
