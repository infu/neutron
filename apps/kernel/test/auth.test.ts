import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { AuthGeneration } from "../src/reducer/auth_generation.ts";

test("a stale authorization response cannot survive a newer auth action", async () => {
  const auth = new AuthGeneration();
  const activation = auth.begin();
  let resolveAuthorization: ((value: boolean) => void) | undefined;
  const authorization = new Promise<boolean>((resolve) => {
    resolveAuthorization = resolve;
  });
  const result = auth.wait(activation, authorization);

  auth.begin();
  resolveAuthorization?.(true);

  expect(await result).toEqual({ current: false });
});

test("the current authorization response remains usable", async () => {
  const auth = new AuthGeneration();
  const activation = auth.begin();

  expect(await auth.wait(activation, Promise.resolve(true))).toEqual({
    current: true,
    value: true,
  });
});

test("an unauthorized identity remains in Neutron for manual authorization", async () => {
  const source = await readFile(
    new URL("../src/reducer/auth.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("if (!authorized)");
  const end = source.indexOf("\n  if (!activationIsCurrent())", start);
  const unauthorizedFlow = source.slice(start, end);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(unauthorizedFlow).toContain("Authorize it manually");
  expect(unauthorizedFlow).not.toContain("window.location");
  expect(source).not.toContain("ICP_DISPENSER_URL");
});

test("local and production share the typed-kernel plus dynamic-app actor split", async () => {
  const source = await readFile(
    new URL("../src/reducer/auth.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "export async function getNeutronCan(): Promise<KernelActor>",
  );
  const end = source.indexOf("\nconst kernelIdl:", start);
  const actorFactory = source.slice(start, end);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(actorFactory).toContain(
    "withDynamicFallback(await getBootstrapKernelCan())",
  );
  expect(actorFactory).not.toContain("if (isLocal)");

  const fallbackStart = source.indexOf("function withDynamicFallback(");
  const fallback = source.slice(fallbackStart, start);
  expect(fallback).toContain("await getNeutronDynamicCan()");
  expect(fallback).not.toContain('readKernelAssetText("/pkg/neutron.did")');
});

test("auth agents take their gateway only from certified runtime", async () => {
  const source = await readFile(
    new URL("../src/reducer/auth.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain("const deployment = getRuntimeDeployment()");
  expect(source).toContain("agentOptions: { host: deployment.gateway }");
  expect(source).toContain("host: runtimeDeployment.gateway");
  expect(source).not.toContain("process.env.LOCAL");
  expect(source).not.toContain("process.env.ICP_LOCAL_HOST");
  expect(source).not.toContain("process.env.ICP_II_PROVIDER");
});

test("the dynamic self actor is single-flight and generation scoped", async () => {
  const source = await readFile(
    new URL("../src/reducer/auth.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export function getNeutronDynamicCan()");
  const end = source.indexOf("\nfunction withDynamicFallback(", start);
  const factory = source.slice(start, end);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(factory).toContain(
    "if (neutronDynamicCanPromise) return neutronDynamicCanPromise",
  );
  expect(factory).toContain('readKernelAssetText("/pkg/neutron.did")');
  expect(factory).toContain("createDynamicIcblastClient()");
  expect(factory).toContain("generationClient(getNeutronId(), candid)");
  expect(factory).toContain("generation !== neutronCanGeneration");
  expect(factory).toContain("return getNeutronDynamicCan()");
  expect(factory).toContain("neutronDynamicCanPromise === pending");
  expect(factory).toContain("neutronDynamicCanPromise = null");

  const resetStart = source.indexOf("export function resetNeutronCan()");
  const resetEnd = source.indexOf(
    "\nasync function getBootstrapKernelCan()",
    resetStart,
  );
  const reset = source.slice(resetStart, resetEnd);
  expect(reset).toContain("neutronDynamicCan = null");
  expect(reset).toContain("neutronDynamicCanPromise = null");
});
