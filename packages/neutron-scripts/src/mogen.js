import fs from "fs/promises";

function removeCommentsAndEmptyLines(content) {
  // Removes comments.

  let noComments = content.replace(/\/\/.*/g, "");
  // Removes lines with only whitespace.
  const noEmptyLines = noComments.replace(/^\s*\n/gm, "");
  return noEmptyLines;
}

const processConfigAndMain = async () => {
  const pattern =
    /public\s*func\s*\/\*(.*?)\*\/\s*(\w+)\((.*?)\)\s*:(\s*.*?){/gs;

  // open neutron.json
  const conf_file = await fs.readFile("./neutron.json", "utf8");
  const conf = JSON.parse(conf_file);

  const main_fn = "./backend/" + conf.src;

  conf.func = {};

  // read file backend/main.mo
  const main = await fs.readFile(main_fn, "utf8");

  // find all public functions
  const matchAgainst = removeCommentsAndEmptyLines(main);
  const matches = [...matchAgainst.matchAll(pattern)];
  const r_begin = "/*---NEUTRON GENERATED BEGIN---*/";
  const r_end = "/*---NEUTRON GENERATED END---*/\n";
  let gen = r_begin + "\n";

  for (const match of matches) {
    if (!match[4]) continue;
    const ffunc = match[1].split(":");

    const ftype = ffunc[0].trim();
    const unauthorized = ffunc[1]
      ? ffunc[1].trim() === "unauthorized"
      : undefined;

    const functionName = match[2].trim();
    let inputs = match[3].trim();

    let leftSide, commentContent, rightSide, commentParts;

    if (inputs.includes("/*") && inputs.includes("*/")) {
      let parts = inputs.split("/*");

      leftSide = parts[0].trim();
      let temp = parts[1].split("*/");

      commentContent = temp[0].trim();
      rightSide = temp[1].trim();

      commentParts = commentContent.split(",").map((part) => part.trim());

      // Optional: Remove comma at the end of the left side if it exists
      if (leftSide.endsWith(",")) {
        leftSide = leftSide.slice(0, -1).trim();
      }

      inputs = leftSide;
    }

    let output = match[4].trim();
    const async = match[0].includes("async");
    output = output.replace("async", "").trim();

    conf.func[functionName] = {
      type: ftype,
      async,
      arg: commentParts,
      allow: unauthorized ? "unauthorized" : undefined,
    };

    gen += `
public type ${functionName}_Input = (${inputs});
public type ${functionName}_Output = ${output};
    `;
  }
  gen += "\n" + r_end;

  const beginIndex = main.indexOf(r_begin);
  const endIndex = main.indexOf(r_end);

  let updatedContent;
  if (beginIndex !== -1 && endIndex !== -1) {
    // Content exists, replace it
    updatedContent =
      main.slice(0, beginIndex) + gen + main.slice(endIndex + r_end.length);
  } else {
    // Content doesn't exist, insert before the last '}'
    const lastBraceIndex = main.lastIndexOf("}");
    updatedContent =
      main.slice(0, lastBraceIndex) + gen + main.slice(lastBraceIndex);
  }

  // write script
  await fs.writeFile(main_fn, updatedContent, "utf-8");

  // write new neutron.json
  await fs.writeFile("./neutron.json", JSON.stringify(conf, null, 2), "utf-8");
};

await processConfigAndMain();
