import { exec as callbackExec } from "child_process";
import { promisify } from "util";

const exec = promisify(callbackExec);
const base_versions = [
  "0.9.1",
  "0.9.0",
  "0.8.8",
  "0.8.7",
  "0.8.6",
  "0.8.5",
  "0.8.4",
  "0.8.3",
  "0.8.2",
  "0.8.1",
  "0.8.0",
  "0.7.6",
  "0.7.5",
  "0.7.4",
  "0.7.3",
  "0.7.2",
  "0.7.1",
  "0.7.0",
  "0.6.30",
  "0.6.29",
  "0.6.27",
  "0.6.26",
  "0.6.24",
];

for (const version of base_versions) {
  await exec(`mops install base@${version}`);
}
