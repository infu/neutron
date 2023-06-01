import fs from "fs/promises";
import { matchTraverseTree } from "./src/lib.js";
import * as disallowed from "./src/disallowed.js";
import mo from "motoko";
import chalk from "chalk";

async function check_directory(path, expect_exist = false) {
  let afiles = await fs.readdir(path);
  for (let fn of afiles) {
    let contents = await fs.readFile(path + "/" + fn, "utf-8");

    try {
      let ast = mo.parseMotoko(contents);

      for (let pattern in disallowed) {
        if (expect_exist && fn.indexOf(pattern) === -1) continue;
        let exists = matchTraverseTree(ast, disallowed[pattern]);
        if (exists === expect_exist) {
          console.log(
            chalk.blue("\u2713"),
            "passed",
            chalk.blue(pattern),
            chalk.green(path),
            chalk.yellow(fn)
          );
        } else {
          console.log(
            chalk.red("\u2717"),
            "failed",
            chalk.blue(pattern),
            chalk.green(path),
            chalk.yellow(fn)
          );
        }
      }
    } catch (e) {
      console.log(
        chalk.blue("\u2713"),
        "passed",
        chalk.green(path),
        chalk.yellow(fn),
        chalk.cyan(e.message)
      );
    }
  }
}

// Check allowed
await check_directory("./allowed", false);

// Check disallowed
await check_directory("./disallowed/", true);
