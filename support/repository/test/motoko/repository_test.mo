import CertifiedStore "../../mo/CertifiedStore";

let resources : [CertifiedStore.Resource] = [
  {
    path = "/repo/v1/info.json";
    sha256 = "\00";
    chunks = ["\01", "\02"];
  },
  {
    path = "/repo/v1/manifests/hello.json";
    sha256 = "\01";
    chunks = ["\03"];
  },
];

let ?info = CertifiedStore.findResource(resources, "/repo/v1/info.json") else {
  assert false;
  loop {};
};
assert info.chunks.size() == 2;

let ?chunk = CertifiedStore.readResource(resources, "/repo/v1/info.json", 1) else {
  assert false;
  loop {};
};
assert chunk.chunks == 2;
assert chunk.content == "\02";

assert CertifiedStore.findResource(resources, "/repo/v1/missing.json") == null;
assert CertifiedStore.readResource(resources, "/repo/v1/missing.json", 0) == null;
