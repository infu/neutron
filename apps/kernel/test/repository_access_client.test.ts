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

const preparedToken = "d".repeat(64);
const offeredSource = `/repo/v1/sources/${"e".repeat(64)}.source.v1.msgpack.gz`;
function preparedAccess(paths: readonly string[] = [path, second, offeredSource]) {
  return { source, token: preparedToken, paths };
}
function withoutAcquisition(fetch: RepositoryFetch) {
  const invoked: string[] = [];
  const fail = (method: string): never => { invoked.push(method); throw new Error(`${method} must not run`); };
  return {
    invoked,
    fetcher: createRepositoryAccessFetcher(deps(fetch, {
      requireApprovedAccess: true,
      ownerKey: () => fail("ownerKey"),
      authorize: async () => fail("authorize"),
      reviewCharge: async () => fail("reviewCharge"),
      randomBytes: () => fail("randomBytes"),
    })),
  };
}

test("prepared access downloads exact package and source paths without acquiring authority", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const { fetcher, invoked } = withoutAcquisition(async (input, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ url: String(input), authorization });
    if (authorization === null) return denied();
    expect(authorization).toBe(`Bearer ${preparedToken}`);
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", mode: "cors" });
    return privateBytes();
  });
  await Promise.all([path, second, offeredSource].map(async (resource) => {
    const response = await fetcher(`${origin}${resource}`, { headers: { authorization: "Bearer unrelated" }, credentials: "include" }, {
      preparedAccess: preparedAccess(), resourcePaths: [path, second, offeredSource],
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  }));
  for (const resource of [path, second, offeredSource]) {
    expect(requests.filter(({ url }) => url === `${origin}${resource}`).map(({ authorization }) => authorization)).toEqual([null, `Bearer ${preparedToken}`]);
  }
  expect(invoked).toEqual([]);
});

test("prepared free packages remain anonymous and accept the source's certified public response", async () => {
  const requests: Array<string | null> = [];
  const { fetcher, invoked } = withoutAcquisition(async (_input, init) => {
    requests.push(new Headers(init?.headers).get("authorization"));
    return new Response(new Uint8Array([7, 8, 9]), { headers: { ...proof, "cache-control": "public, max-age=60" } });
  });
  const response = await fetcher(`${origin}${path}`, { headers: { authorization: "Bearer ambient" } }, {
    preparedAccess: preparedAccess(), allowAccessAcquisition: false,
  });
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
  expect(requests).toEqual([null]);
  expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  expect(invoked).toEqual([]);
});

test("prepared reads preserve non-challenge failures without presenting credentials", async () => {
  for (const status of [404, 429, 503]) {
    const requests: Array<string | null> = [];
    const { fetcher, invoked } = withoutAcquisition(async (_input, init) => {
      requests.push(new Headers(init?.headers).get("authorization"));
      return new Response(null, { status, headers: proof });
    });
    expect((await fetcher(`${origin}${path}`, {}, { preparedAccess: preparedAccess() })).status).toBe(status);
    expect(requests).toEqual([null]);
    expect(invoked).toEqual([]);
  }
});

test("a prepared batch can read public and challenged private packages under one existing grant", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const { fetcher, invoked } = withoutAcquisition(async (input, init) => {
    const url = String(input), authorization = new Headers(init?.headers).get("authorization");
    requests.push({ url, authorization });
    if (url.endsWith(second)) return new Response("free", { headers: { ...proof, "cache-control": "public, max-age=60" } });
    return authorization ? privateBytes() : denied();
  });
  const [paid, free] = await Promise.all([path, second].map(resource => fetcher(`${origin}${resource}`, {}, {
    preparedAccess: preparedAccess(), resourcePaths: [path, second], allowAccessAcquisition: false,
  })));
  expect(await free!.text()).toBe("free");
  expect(new Uint8Array(await paid!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect(requests.filter(({ authorization }) => authorization !== null)).toEqual([{ url: `${origin}${path}`, authorization: `Bearer ${preparedToken}` }]);
  expect(invoked).toEqual([]);
});

test("only a certified challenge can cause prepared bearer disclosure", async () => {
  for (const status of [401, 403]) {
    const requests: Array<string | null> = [];
    const { fetcher, invoked } = withoutAcquisition(async (_input, init) => {
      requests.push(new Headers(init?.headers).get("authorization"));
      return new Response(null, { status });
    });
    await expect(fetcher(`${origin}${path}`, {}, { preparedAccess: preparedAccess() })).rejects.toThrow("not certified");
    expect(requests).toEqual([null]);
    expect(invoked).toEqual([]);
  }
});

test("canceling after the anonymous challenge does not send the prepared bearer", async () => {
  const controller = new AbortController();
  const requests: Array<string | null> = [];
  const { fetcher, invoked } = withoutAcquisition(async (_input, init) => {
    requests.push(new Headers(init?.headers).get("authorization"));
    controller.abort();
    return denied();
  });
  await expect(fetcher(`${origin}${path}`, {}, { preparedAccess: preparedAccess(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toEqual([null]);
  expect(invoked).toEqual([]);
});

test("prepared access cannot escape its source, canonical paths or read methods", async () => {
  let downloads = 0;
  const { fetcher, invoked } = withoutAcquisition(async () => { downloads++; return privateBytes(); });
  for (const [url, init] of [
    [`https://external.example${path}`, {}],
    [`https://ryjl3-tyaaa-aaaaa-aaaba-cai.icp0.io${path}`, {}],
    [`https://${source}.raw.icp0.io${path}`, {}],
    [`${origin}:8443${path}`, {}],
    [`${origin}${path}?download=1`, {}],
    [`${origin}${path}#fragment`, {}],
    [`https://user:secret@${source}.icp0.io${path}`, {}],
    [`${origin}/repo/v1/access.json`, {}],
    [`${origin}${second}`, {}],
    [`${origin}${path}`, { method: "POST" }],
  ] as const) {
    await expect(fetcher(url, init, { preparedAccess: preparedAccess([path]) })).rejects.toThrow("exact source and resource");
  }
  await expect(fetcher(`${origin}${path}`, {}, {
    preparedAccess: preparedAccess([path]), resourcePaths: [path, second],
  })).rejects.toThrow("every requested resource");
  expect(downloads).toBe(0);
  expect(invoked).toEqual([]);
});

test("malformed prepared capabilities fail before contacting a source", async () => {
  let downloads = 0;
  const { fetcher, invoked } = withoutAcquisition(async () => { downloads++; return privateBytes(); });
  for (const invalid of [
    null,
    { ...preparedAccess(), source: source.toUpperCase() },
    { ...preparedAccess(), source: "not-a-principal" },
    { ...preparedAccess(), token: preparedToken.toUpperCase() },
    { ...preparedAccess(), token: "too-short" },
    { ...preparedAccess(), token: `${preparedToken}\r\nother: header` },
    { ...preparedAccess(), paths: [] },
    { ...preparedAccess(), paths: [path, `${offeredSource}?token=secret`] },
    { ...preparedAccess(), paths: [path, 2] },
  ]) {
    await expect(fetcher(`${origin}${path}`, {}, { preparedAccess: invalid as ReturnType<typeof preparedAccess> })).rejects.toThrow("prepared source access is invalid");
  }
  expect(downloads).toBe(0);
  expect(invoked).toEqual([]);
});

test("denied prepared capabilities never renew, self-authorize or expose remote bodies", async () => {
  for (const status of [401, 403]) {
    let downloads = 0;
    const { fetcher, invoked } = withoutAcquisition(async (_input, init) => {
      downloads++;
      return new Headers(init?.headers).has("authorization") ? new Response(`Revoked ${preparedToken}`, { status }) : denied();
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await fetcher(`${origin}${path}`, {}, { preparedAccess: preparedAccess() }).catch((error: Error) => error);
      expect(error).toBeInstanceOf(RepositoryAccessError);
      expect((error as Error).message).toContain("no longer accepts");
      expect((error as Error).message).not.toContain(preparedToken);
      expect((error as Error).cause).toBeUndefined();
    }
    expect(downloads).toBe(4);
    expect(invoked).toEqual([]);
  }
});

test("prepared downloads still require exact URL and private authorization-bound certification", async () => {
  for (const variant of ["redirect", "different-url", "missing-proof", "unbound", "public-cache", "no-vary"] as const) {
    const { fetcher, invoked } = withoutAcquisition(async (_input, init) => {
      if (!new Headers(init?.headers).has("authorization")) return denied();
      const response = privateBytes();
      if (variant === "redirect") Object.defineProperty(response, "redirected", { value: true });
      if (variant === "different-url") Object.defineProperty(response, "url", { value: `${origin}${second}` });
      if (variant === "missing-proof") response.headers.delete("ic-certificate");
      if (variant === "unbound") response.headers.set("ic-certificateexpression", proof["ic-certificateexpression"]);
      if (variant === "public-cache") response.headers.set("cache-control", "public, max-age=60");
      if (variant === "no-vary") response.headers.delete("vary");
      return response;
    });
    await expect(fetcher(`${origin}${path}`, {}, { preparedAccess: preparedAccess() })).rejects.toBeInstanceOf(RepositoryAccessError);
    expect(invoked).toEqual([]);
  }
});

test("prepared transport failures do not expose bearer credentials or retain their causes", async () => {
  const requests: Array<string | null> = [];
  const { fetcher, invoked } = withoutAcquisition(async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push(authorization);
    if (!authorization) return denied();
    throw new Error(`Request failed with Authorization: Bearer ${preparedToken}`);
  });
  const error = await fetcher(`${origin}${path}`, {}, { preparedAccess: preparedAccess() }).catch((error: Error) => error);
  expect(error).toBeInstanceOf(RepositoryAccessError);
  expect((error as Error).message).toContain("prepared source download");
  expect((error as Error).message).not.toContain(preparedToken);
  expect((error as Error).cause).toBeUndefined();
  expect(requests).toEqual([null, `Bearer ${preparedToken}`]);
  expect(invoked).toEqual([]);
});

test("prepared access snapshots its scope and does not populate the ordinary grant cache", async () => {
  const capability = { ...preparedAccess(), paths: [path] };
  const authorizations: RepositoryAccessRequest[] = [];
  let token = "";
  const fetcher = createRepositoryAccessFetcher(deps(async (input, init) => {
    const sent = new Headers(init?.headers).get("authorization");
    if (sent === `Bearer ${preparedToken}`) {
      token = sent;
      capability.token = "0".repeat(64);
      capability.paths[0] = second;
      await Promise.resolve();
      return privateBytes();
    }
    return privateFetch(input, init);
  }, { authorize: async ({ request }) => { authorizations.push(request); return ok(request); } }));
  expect((await fetcher(`${origin}${path}`, {}, { preparedAccess: capability })).ok).toBe(true);
  expect(token).toBe(`Bearer ${preparedToken}`);
  expect(authorizations).toEqual([]);
  expect((await fetcher(`${origin}${path}`)).ok).toBe(true);
  expect(authorizations).toHaveLength(1);
  expect(authorizations[0]!.token).not.toBe(preparedToken);
});

test("public-only acquisition cannot reconcile or pay a cached interrupted access request", async () => {
  let authorizations = 0;
  let owners = 0;
  let descriptors = 0;
  const fetcher = createRepositoryAccessFetcher(deps(async (input, init) => {
    if (String(input).endsWith("/access.json")) descriptors++;
    return privateFetch(input, init);
  }, {
    ownerKey: () => { owners++; return "neutron:owner:1"; },
    authorize: async () => {
      authorizations++;
      throw new Error("The original authorization reply was interrupted");
    },
  }));
  await expect(fetcher(`${origin}${path}`)).rejects.toThrow("same access request");
  expect(authorizations).toBe(1);
  const ownersBefore = owners;
  const descriptorsBefore = descriptors;
  await expect(fetcher(`${origin}${path}`, {}, { allowAccessAcquisition: false, approvedAccess: [] })).rejects.toThrow("requires prepared download access");
  expect(authorizations).toBe(1);
  expect(owners).toBe(ownersBefore);
  expect(descriptors).toBe(descriptorsBefore);
});

test("disabling acquisition preserves public reads and explicit prepared access", async () => {
  let publicReads = 0;
  const { fetcher, invoked } = withoutAcquisition(async (input, init) => {
    if (String(input).endsWith(second)) { publicReads++; return new Response("public"); }
    return privateFetch(input, init);
  });
  expect(await (await fetcher(`${origin}${second}`, {}, { allowAccessAcquisition: false })).text()).toBe("public");
  expect((await fetcher(`${origin}${path}`, {}, { allowAccessAcquisition: false, preparedAccess: preparedAccess() })).ok).toBe(true);
  await expect(fetcher(`${origin}${path}`, {}, { allowAccessAcquisition: false })).rejects.toThrow("requires prepared download access");
  expect(publicReads).toBe(1);
  expect(invoked).toEqual([]);
});
