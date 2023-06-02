export const actor = (x) => x?.args?.find((z) => z?.name === "ActorUrlE");

export const cyclesAdd = (x) =>
  x.name === "DotE" && x.args.find((z) => z === "cyclesAdd");

export const createActor = (x) =>
  x.name === "DotE" && x.args.find((z) => z === "createActor");

export const stableMemoryStore = (x) =>
  x.name === "DotE" &&
  x.args.find(
    (z) => typeof z === "string" && z.indexOf("stableMemoryStore") === 0
  );

export const stableMemoryLoad = (x) =>
  x.name === "DotE" &&
  x.args.find(
    (z) => typeof z === "string" && z.indexOf("stableMemoryLoad") === 0
  );

export const stableVarQuery = (x) =>
  x.name === "DotE" && x.args.find((z) => z === "stableVarQuery");

export const getCertificate = (x) =>
  x.name === "DotE" && x.args.find((z) => z === "getCertificate");

export const setCertifiedData = (x) =>
  x.name === "DotE" && x.args.find((z) => z === "setCertifiedData");

export const call_raw = (x) =>
  x.name === "DotE" && x.args.find((z) => z === "call_raw");
