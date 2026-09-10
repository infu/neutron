import { expect, test } from "bun:test";
import { createRepositoryAccessFetcher, RepositoryAccessError, type RepositoryAccessDependencies, type RepositoryFetch } from "../src/repository_access/client.ts";
import { isRepositoryResourcePath, parseRepositoryAccessDescriptor, type RepositoryAccessRequest } from "neutron-tools/src/repository_access.js";
const source = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const origin = `https://${source}.icp0.io`;
const path = `/repo/v1/packages/${"a".repeat(64)}.neutron`;
const second = `/repo/v1/packages/${"b".repeat(64)}.neutron`;
const expression = 'default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:["authorization"],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})';
const proof = { "ic-certificate": "certificate=:Y2VydA==:, tree=:dHJlZQ==:, expr_path=:cGF0aA==:, version=2", "ic-certificateexpression": "default_certification(ValidationArgs{certification:Certification{}})" };
function denied() { return new Response(null, { status: 401, headers: proof }); }
function descriptor() { return new Response(JSON.stringify({ protocol: "neutron-repo-access-v1", fee_version: "2", cycles: "100" }), { headers: { ...proof, "content-type": "application/json" } }); }
function privateBytes() { return new Response(new Uint8Array([1, 2, 3]), { headers: { ...proof, "ic-certificateexpression": expression, "cache-control": "private, no-store", vary: "Authorization" } }); }
const privateFetch: RepositoryFetch = async (input, init) => String(input).endsWith("/access.json") ? descriptor() : new Headers(init?.headers).has("authorization") ? privateBytes() : denied();
function ok(request: RepositoryAccessRequest) { return { result: { ok: { request_id: request.request_id, paths: [...request.paths], accepted_cycles: 100n } }, charged_cycles: [100n] as [bigint] }; }
function deps(fetch: RepositoryFetch = privateFetch, extra: Partial<RepositoryAccessDependencies> = {}): RepositoryAccessDependencies {
  return { fetch, resolveSource: (url) => url.origin === origin ? { canisterId: source, origin } : null, ownerKey: () => "neutron:owner:1", authorize: async ({ request }) => ok(request), ...extra };
}
test("access protocol accepts only closed V1 descriptors and canonical content paths", () => {
  expect(parseRepositoryAccessDescriptor({ protocol: "neutron-repo-access-v1", fee_version: "0", cycles: "0" }).cycles).toBe("0");
  for (const value of [null, [], { protocol: "neutron-repo-access-v1", fee_version: "01", cycles: "2" }, { protocol: "neutron-repo-access-v1", fee_version: "1", cycles: "2", method: "arbitrary" }]) expect(() => parseRepositoryAccessDescriptor(value)).toThrow();
  expect(isRepositoryResourcePath(path)).toBe(true);
  expect(isRepositoryResourcePath(`/repo/v1/sources/${"c".repeat(64)}.source.v1.msgpack.gz`)).toBe(true);
  for (const value of [`${path}?token=x`, path.toUpperCase(), "/repo/v1/packages/../private", "/repo/v1/access.json"]) expect(isRepositoryResourcePath(value)).toBe(false);
});
test("public and unrelated URLs never request owner authentication or source cycles", async () => {
  let sessions = 0;
  const fetcher = createRepositoryAccessFetcher(deps(async () => new Response("public"), { ownerKey: () => { sessions++; throw new Error("must not sign in"); }, authorize: async () => { throw new Error("must not pay"); } }));
  expect(await (await fetcher(`${origin}${path}`)).text()).toBe("public");
  expect(await (await fetcher(`https://external.example${path}`)).text()).toBe("public");
  expect(sessions).toBe(0);
});
test("one exact-path grant serves a concurrent batch and later selected resources", async () => {
  const requests: RepositoryAccessRequest[] = [];
  let reviews = 0;
  const fetcher = createRepositoryAccessFetcher(deps(async (input, init) => {
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error"); expect(init?.referrerPolicy).toBe("no-referrer");
    return privateFetch(input, init);
  }, { reviewCharge: async ({ source: actual, cycles, paths }) => { expect(actual).toBe(source); expect(cycles).toBe(100n); expect(paths).toEqual([path, second]); reviews++; }, authorize: async ({ source: actual, request, cycles }) => { expect(actual).toBe(source); expect(cycles).toBe(100n); requests.push(request); return ok(request); } }));
  const results = await Promise.all([path, second].map((item) => fetcher(`${origin}${item}`, {}, { resourcePaths: [second, path] })));
  expect(await results[0]!.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
  expect(requests.length).toBe(1); expect(reviews).toBe(1);
  expect(requests[0]!.token).toMatch(/^[0-9a-f]{64}$/); expect(requests[0]!.request_id).toMatch(/^[0-9a-f]{32}$/);
  await fetcher(`${origin}${path}`);
  expect(requests.length).toBe(1);
});
test("forged challenges, redirected descriptor and unbound or public-cache private proofs fail closed", async () => {
  for (const variant of ["challenge", "redirect", "public", "unbound"] as const) {
    let calls = 0;
    const fetcher = createRepositoryAccessFetcher(deps(async (input, init) => {
      if (String(input).endsWith("/access.json")) { const response = descriptor(); if (variant === "redirect") Object.defineProperty(response, "url", { value: "https://external.example/repo/v1/access.json" }); return response; }
      if (!new Headers(init?.headers).has("authorization")) return variant === "challenge" ? new Response(null, { status: 401 }) : denied();
      const response = privateBytes();
      if (variant === "public") response.headers.set("cache-control", "public, max-age=31536000");
      if (variant === "unbound") response.headers.set("ic-certificateexpression", proof["ic-certificateexpression"]);
      return response;
    }, { authorize: async ({ request }) => { calls++; return ok(request); } }));
    await expect(fetcher(`${origin}${path}`)).rejects.toBeInstanceOf(RepositoryAccessError);
    if (variant === "challenge" || variant === "redirect") expect(calls).toBe(0);
  }
});
test("interrupted access retries the original request without exposing the secret", async () => {
  const requests: RepositoryAccessRequest[] = [];
  const fetcher = createRepositoryAccessFetcher(deps(privateFetch, { authorize: async ({ request }) => { requests.push(request); if (requests.length === 1) throw new Error(`Network error ${request.token}`); return { result: { ok: { request_id: request.request_id, paths: [...request.paths], accepted_cycles: 0n } }, charged_cycles: [0n] as [bigint] }; } }));
  let error: Error | undefined;
  try { await fetcher(`${origin}${path}`); } catch (cause) { error = cause as Error; }
  expect(error?.message).toContain("same access request"); expect(error?.message).not.toContain(requests[0]!.token);
  await fetcher(`${origin}${path}`); expect(requests[1]).toBe(requests[0]);
});
test("owner change or cancellation during authorization prevents artifact access", async () => {
  for (const change of ["owner", "abort"] as const) {
    let owner = "owner-a"; const controller = new AbortController(); let downloads = 0;
    const fetcher = createRepositoryAccessFetcher(deps(async (input, init) => { if (String(input).endsWith("/access.json")) return descriptor(); if (new Headers(init?.headers).has("authorization")) downloads++; return denied(); }, {
      ownerKey: () => owner,
      authorize: async ({ request }) => { if (change === "owner") owner = "owner-b"; else controller.abort(); return ok(request); },
    }));
    await expect(fetcher(`${origin}${path}`, { signal: controller.signal })).rejects.toThrow(); expect(downloads).toBe(0);
  }
});
test("source cannot grant a subset, substitute the request or overstate accepted cycles", async () => {
  for (const change of ["paths", "id", "cycles"] as const) {
    let downloads = 0;
    const fetcher = createRepositoryAccessFetcher(deps(async (input, init) => { if (String(input).endsWith("/access.json")) return descriptor(); if (new Headers(init?.headers).has("authorization")) downloads++; return denied(); }, { authorize: async ({ request }) => ({ result: { ok: { request_id: change === "id" ? "0".repeat(32) : request.request_id, paths: change === "paths" ? [] : [...request.paths], accepted_cycles: change === "cycles" ? 101n : 100n } }, charged_cycles: [100n] as [bigint] }) }));
    await expect(fetcher(`${origin}${path}`)).rejects.toThrow("invalid access receipt"); expect(downloads).toBe(0);
  }
});
test("newly issued denied grants stop instead of paying in a retry loop", async () => {
  let calls = 0;
  const fetcher = createRepositoryAccessFetcher(deps(async (input) => String(input).endsWith("/access.json") ? descriptor() : denied(), { authorize: async ({ request }) => { calls++; return ok(request); } }));
  await expect(fetcher(`${origin}${path}`)).rejects.toThrow("no longer authorizes"); expect(calls).toBe(1);
});
test("HTTP timeout does not time out the signed access update", async () => {
  const fetcher = createRepositoryAccessFetcher(deps(privateFetch, { authorize: async ({ request }) => { await new Promise((resolve) => setTimeout(resolve, 15)); return ok(request); } }));
  expect((await fetcher(`${origin}${path}`, {}, { timeoutMs: 5 })).status).toBe(200);
});

test("descriptor body uses the caller HTTP timeout before a grant can be paid", async () => {
  let canceled = false;
  let signed = false;
  const fetcher = createRepositoryAccessFetcher(deps(async (input) => {
    if (!String(input).endsWith("/access.json")) return denied();
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      cancel() { canceled = true; },
    }), { headers: { ...proof, "content-type": "application/json" } });
  }, { authorize: async ({ request }) => { signed = true; return ok(request); } }));
  await expect(fetcher(`${origin}${path}`, {}, { timeoutMs: 5 })).rejects.toThrow("description took too long");
  expect(canceled).toBe(true);
  expect(signed).toBe(false);
});

test("production acquisition binds the source and exact fee revision shown by the existing action", async () => {
  let signed = 0;
  const fetcher = createRepositoryAccessFetcher(deps(privateFetch, {
    requireApprovedAccess: true,
    authorize: async ({ request }) => { signed++; return ok(request); },
  }));
  const approval = { source, descriptor: { protocol: "neutron-repo-access-v1" as const, fee_version: "2", cycles: "100" } };
  await expect(fetcher(`${origin}${path}`)).rejects.toThrow("cost needs review");
  await expect(fetcher(`${origin}${path}`, {}, { approvedAccess: [{ ...approval, source: "wrong-source" }] })).rejects.toThrow("cost needs review");
  await expect(fetcher(`${origin}${path}`, {}, { approvedAccess: [{ ...approval, descriptor: { ...approval.descriptor, fee_version: "1" } }] })).rejects.toThrow("cost needs review");
  await expect(fetcher(`${origin}${path}`, {}, { approvedAccess: [{ ...approval, descriptor: { ...approval.descriptor, cycles: "99" } }] })).rejects.toThrow("cost needs review");
  expect(signed).toBe(0);
  expect((await fetcher(`${origin}${path}`, {}, { approvedAccess: [approval] })).ok).toBe(true);
  expect(signed).toBe(1);
  // Existing grants need no second payment or fee authorization.
  expect((await fetcher(`${origin}${path}`)).ok).toBe(true);
  expect(signed).toBe(1);
});

test("native rejected calls retain unknown charge and original request for reconciliation", async () => {
  const requests: RepositoryAccessRequest[] = [];
  const fetcher = createRepositoryAccessFetcher(deps(privateFetch, {
    authorize: async ({ request }) => {
      requests.push(request);
      if (requests.length === 1) return { result: { err: { code: "invocation_unknown", message: "Retry the original access request." } }, charged_cycles: [] };
      return ok(request);
    },
  }));
  await expect(fetcher(`${origin}${path}`)).rejects.toThrow("original access request");
  expect((await fetcher(`${origin}${path}`)).ok).toBe(true);
  expect(requests[0]).toBe(requests[1]);
});
