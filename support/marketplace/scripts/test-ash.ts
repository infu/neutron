import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareAsh, projectRoot } from "./test-ash-runtime.ts";

const ash = await prepareAsh();
const sourceConfig = JSON.parse(await readFile(path.join(projectRoot, "test/protocol.ash.json"), "utf8"));
const configured = new Set(sourceConfig.canisters.map((entry: { src: string }) => entry.src));
const discovered = (await readdir(path.join(projectRoot, "test"), { recursive: true })).filter((name) => name.endsWith(".test.mo") && !configured.has(name)).sort();
const canisters = [...sourceConfig.canisters, ...discovered.map((src) => ({ name: src.replace(/\.test\.mo$/, "").replace(/[^a-zA-Z0-9_]/g, "_"), src }))].map((entry) => ({ ...entry, src: path.resolve(projectRoot, "test", entry.src) }));
const config = path.join(ash.directory, "protocol.ash.json");
await writeFile(config, JSON.stringify({ ...sourceConfig, canisters }, null, 2));
await ash.testCommand(config, process.argv[2], { verbose: true });
