import { rm } from "node:fs/promises";
import { cases } from "../test/protocol.integration.ts";
import { qualificationPath, writeQualification } from "../test/runtime.ts";

const filter = process.argv[2];
const selected = cases.filter(test => !filter || test.name.includes(filter));
if (selected.length === 0) throw new Error("No Feedback integration tests match the requested filter");
if (!filter) await rm(qualificationPath, { force: true });
let passed = 0;
let failed = 0;
for (const test of selected) {
  try {
    await test.run();
    passed += 1;
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error);
  }
}
console.log(`Feedback PocketIC: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
else if (!filter) await writeQualification(selected.map(test => test.name));
