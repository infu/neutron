export function checkForDangerousTextCode(code) {
  let dangerous = [];
  let dangerousItems = [
    { term: "stableMemoryStore", regex: /\WstableMemoryStore/ },
    { term: "stableMemoryLoad", regex: /\WstableMemoryLoad/ },
    { term: "stableVarQuery", regex: /\WstableVarQuery\W/ },
    { term: "call_raw", regex: /\Wcall_raw\W/ },
    { term: "getCertificate", regex: /\WgetCertificate\W/ },
    { term: "setCertifiedData", regex: /\WsetCertifiedData\W/ },
    { term: "cyclesAdd", regex: /\WcyclesAdd\W/ },
    { term: "createActor", regex: /\WcreateActor\W/ },
    { term: "actor", regex: /\Wactor\W/, regex_except: /\Wactor\s*{/ },
  ];

  let lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (let item of dangerousItems) {
      if (item.regex.test(lines[i])) {
        if (item.regex_except && item.regex_except.test(lines[i])) {
          continue;
        }
        dangerous.push({
          line: i + 1,
          code: item.term,
          context: {
            previous: lines[i - 1] || "No previous line",
            current: lines[i],
            next: lines[i + 1] || "No next line",
          },
        });
      }
    }
  }

  return dangerous;
}
