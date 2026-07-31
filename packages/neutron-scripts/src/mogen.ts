import fs from "fs/promises";

type GeneratedFunctionConfig = {
  type: string;
  async: boolean | "async*";
  arg?: string[];
  allow?: "unauthorized";
  expose?: "apps";
};

type MogenConfig = {
  src?: unknown;
  func?: Record<string, GeneratedFunctionConfig>;
  [key: string]: unknown;
};

function removeCommentsAndEmptyLines(content: string): string {
  // Removes comments.

  let noComments = content.replace(/\/\/.*/g, "");
  // Removes lines with only whitespace.
  const noEmptyLines = noComments.replace(/^\s*\n/gm, "");
  return noEmptyLines;
}

const processConfigAndMain = async () => {
  const pattern =
    /public\s*func\s*\/\*(.*?)\*\/\s*(\w+)(?:\s*<[^>{}]*>)?\s*\((.*?)\)\s*:(\s*.*?){/gs;

  // open neutron.json
  const conf_file = await fs.readFile("./neutron.json", "utf8");
  const conf = JSON.parse(conf_file) as MogenConfig;
  if (typeof conf.src !== "string") {
    throw new Error("neutron.json must include a string src field");
  }

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
    const ffunc = (match[1] ?? "").split(":");

    const ftype = (ffunc[0] ?? "").trim();
    const modifiers = ffunc.slice(1).map((x: string) => x.trim());
    const unauthorized = modifiers.includes("unauthorized");
    const exposedToApps = modifiers.includes("apps");

    if (exposedToApps && ftype !== "internal") {
      throw new Error(
        `Only internal functions can use the apps modifier: ${match[2]?.trim() ?? "unknown"}`,
      );
    }

    const functionName = match[2]?.trim();
    if (!functionName) continue;
    let inputs = (match[3] ?? "").trim();

    let commentParts: string[] | undefined;

    if (inputs.includes("/*") && inputs.includes("*/")) {
      const parts = inputs.split("/*");

      let leftSide = (parts[0] ?? "").trim();
      const temp = (parts[1] ?? "").split("*/");

      const commentContent = (temp[0] ?? "").trim();

      commentParts = commentContent
        .split(",")
        .map((part: string) => part.trim());

      // Optional: Remove comma at the end of the left side if it exists
      if (leftSide.endsWith(",")) {
        leftSide = leftSide.slice(0, -1).trim();
      }

      inputs = leftSide;
    }

    let output = match[4].trim();
    const async = /\basync\*/.test(match[0])
      ? "async*"
      : /\basync\b/.test(match[0]);
    output = output.replace(/^async\*?\s*/, "").trim();

    const generatedFunction: GeneratedFunctionConfig = {
      type: ftype,
      async,
    };
    if (commentParts) generatedFunction.arg = commentParts;
    if (unauthorized) generatedFunction.allow = "unauthorized";
    if (exposedToApps) generatedFunction.expose = "apps";
    conf.func[functionName] = generatedFunction;

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
