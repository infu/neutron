export function checkForDangerousCode(code) {
  let dangerous = [];

  /\WstableMemoryStore/.test(code) && dangerous.push("stableMemoryStore*");
  /\WstableMemoryLoad/.test(code) && dangerous.push("stableMemoryLoad*");
  /\WstableVarQuery\W/.test(code) && dangerous.push("stableVarQuery*");
  /\Wcall_raw\W/.test(code) && dangerous.push("call_raw");
  /\WgetCertificate\W/.test(code) && dangerous.push("getCertificate");
  /\WsetCertifiedData\W/.test(code) && dangerous.push("setCertifiedData");
  /\WcyclesAdd\W/.test(code) && dangerous.push("cyclesAdd");
  /\WcreateActor\W/.test(code) && dangerous.push("createActor");
  /\Wactor\W/.test(code) && dangerous.push("actor");

  return dangerous;
}
