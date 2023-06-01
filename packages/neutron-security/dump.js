import fs from "fs/promises";
import util from "util";
import mo from "motoko";
import chalk from "chalk";

let arg1 = process.argv[2];

let contents = await fs.readFile(arg1, "utf-8");
const ast = mo.parseMotoko(contents);

console.log(util.inspect(ast, false, null, true /* enable colors */));

// Help understanding these here https://github.com/dfinity/motoko/blob/cf5ac77f1fb86b215065ea8fcfef4ecac1012817/src/mo_def/syntax.ml#L153
