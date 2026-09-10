import { beforeAll, expect, test } from "bun:test";
import {
  fetchPackageFromUrl,
  parseOfferedPackageUrl,
  parsePackageUrl,
} from "../src/tools/package_url.ts";
import { loadIcRuntimeFixture } from "./runtime_fixture.ts";
import {
  createRepositoryAccessFetcher,
  RepositoryAccessError,
} from "../src/repository_access/client.ts";

beforeAll(loadIcRuntimeFixture);

test("package URL parsing requires an absolute private-free HTTPS URL", () => {
  expect(parsePackageUrl(" https://apps.example/demo.neutron?build=1 ").href).toBe(
    "https://apps.example/demo.neutron?build=1",
  );
  for (const value of [
    "",
    "/demo.neutron",
    "file:///tmp/demo.neutron",
    "data:application/octet-stream,hello",
    "https://user:secret@apps.example/demo.neutron",
    "https://apps.example/demo.neutron#download",
    "http://apps.example/demo.neutron",
  ]) {
    expect(() => parsePackageUrl(value)).toThrow();
  }
});

test("package URL parsing permits HTTP only for local loopback development", () => {
  for (const hostname of ["localhost", "kernel.localhost", "127.0.0.1", "[::1]"]) {
    expect(
      parsePackageUrl(`http://${hostname}:8000/demo.neutron`, {
        allowLoopbackHttp: true,
      }).protocol,
    ).toBe("http:");
  }
  expect(() =>
    parsePackageUrl("http://192.168.1.10/demo.neutron", {
      allowLoopbackHttp: true,
    }),
  ).toThrow("HTTPS");
});

test("install offers require an exact .neutron pathname while manual URLs remain flexible", () => {
  expect(
    parseOfferedPackageUrl(
      "https://apps.example/releases/demo.neutron?build=stable&token=secret",
    ).href,
  ).toBe(
    "https://apps.example/releases/demo.neutron?build=stable&token=secret",
  );

  for (const value of [
    "https://apps.example/releases/demo.neutron.zip",
    "https://apps.example/releases/demo.neutron/",
    "https://apps.example/releases/demo.NEUTRON",
    "https://apps.example/releases/demo%2Eneutron",
    "https://apps.example/download?package=demo.neutron",
  ]) {
    expect(() => parseOfferedPackageUrl(value)).toThrow(
      "URL ending in .neutron",
    );
  }

  expect(
    parsePackageUrl(
      "https://apps.example/download?package=demo.neutron&token=secret",
    ).href,
  ).toBe(
    "https://apps.example/download?package=demo.neutron&token=secret",
  );
});

test("URL package fetch is credentialless, referrerless, uncached, and bounded", async () => {
  const expected = new Uint8Array([1, 2, 3, 4]);
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const bytes = await fetchPackageFromUrl("https://apps.example/demo.neutron", {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(expected, {
        headers: { "content-length": String(expected.byteLength) },
        status: 200,
      });
    }) as unknown as typeof fetch,
    maxBytes: 16,
  });

  expect(bytes).toEqual(expected);
  expect(requestedUrl).toBe("https://apps.example/demo.neutron");
  expect(requestedInit).toMatchObject({
    cache: "no-store",
    credentials: "omit",
    method: "GET",
    mode: "cors",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
});

test("public canonical repository package downloads keep their existing direct fetch path", async () => {
  const url = `https://233tv-xiaaa-aaaay-aacta-cai.icp0.io/repo/v1/packages/${"a".repeat(64)}.neutron`;
  const expected = new Uint8Array([1, 2, 3, 4]);
  const calls: string[] = [];
  const content = await fetchPackageFromUrl(url, {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(expected);
    }) as unknown as typeof fetch,
  });
  expect(content).toEqual(expected);
  expect(calls).toEqual([url]);
});

test("private repository package acquisition retains the URL install byte bound", async () => {
  const source = {
    canisterId: "233tv-xiaaa-aaaay-aacta-cai",
    origin: "https://233tv-xiaaa-aaaay-aacta-cai.icp0.io",
  };
  const path = `/repo/v1/packages/${"a".repeat(64)}.neutron`;
  const url = `${source.origin}${path}`;
  const content = new Uint8Array([1, 2, 3, 4]);
  const certificate = "certificate=:AA==:, tree=:AA==:, expr_path=:AA==:, version=2";
  const publicHeaders = {
    "ic-certificate": certificate,
    "ic-certificateexpression": "default_certification(ValidationArgs{certification:Certification{}})",
  };
  let token = "";
  let authorizations = 0;
  const access = createRepositoryAccessFetcher({
    resolveSource: () => source,
    ownerKey: () => "neutron:owner:session",
    randomBytes: (length) => new Uint8Array(length).fill(7),
    authorize: async ({ request }) => {
      authorizations += 1;
      expect(request.paths).toEqual([path]);
      token = request.token;
      return {
        result: { ok: { request_id: request.request_id, paths: [...request.paths], accepted_cycles: 100n } },
        charged_cycles: [100n] as [bigint],
      };
    },
    fetch: async (input, init) => {
      if (String(input) === `${source.origin}/repo/v1/access.json`) {
        return Response.json({ protocol: "neutron-repo-access-v1", fee_version: "1", cycles: "100" }, { headers: publicHeaders });
      }
      expect(String(input)).toBe(url);
      const authorization = new Headers(init?.headers).get("authorization");
      if (!authorization) return new Response("access required", { status: 401, headers: publicHeaders });
      expect(authorization).toBe(`Bearer ${token}`);
      return new Response(content, { headers: {
        ...publicHeaders,
        "ic-certificateexpression": 'default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:["authorization"],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})',
        "cache-control": "private, no-store",
        vary: "authorization",
        "content-length": "4",
      } });
    },
  });
  expect(await fetchPackageFromUrl(url, { fetch: access as unknown as typeof fetch, maxBytes: 4 })).toEqual(content);
  await expect(fetchPackageFromUrl(url, { fetch: access as unknown as typeof fetch, maxBytes: 3 })).rejects.toThrow("3 bytes URL-install limit");
  expect(authorizations).toBe(1);
});

test("URL package fetch rejects HTTP failures and declared oversized bodies", async () => {
  await expect(
    fetchPackageFromUrl("https://apps.example/missing.neutron", {
      fetch: (async () => new Response("missing", { status: 404 })) as unknown as typeof fetch,
      maxBytes: 16,
    }),
  ).rejects.toThrow("HTTP 404");

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  await expect(
    fetchPackageFromUrl("https://apps.example/large.neutron", {
      fetch: (async () =>
        new Response(body, {
          headers: { "content-length": "17" },
          status: 200,
        })) as unknown as typeof fetch,
      maxBytes: 16,
    }),
  ).rejects.toThrow("16 bytes URL-install limit");
  expect(body.locked).toBe(false);
});

test("prepared package downloads retain byte bounds and hide stream errors containing the bearer", async () => {
  const source = "233tv-xiaaa-aaaay-aacta-cai";
  const path = `/repo/v1/packages/${"a".repeat(64)}.neutron`;
  const token = "c".repeat(64);
  const headers = {
    "ic-certificate": "certificate=:AA==:, tree=:AA==:, expr_path=:AA==:, version=2",
    "ic-certificateexpression": 'default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:["authorization"],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})',
    "cache-control": "private, no-store", vary: "Authorization",
  };
  for (const variant of ["oversized", "stream-error"] as const) {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (variant === "oversized") controller.enqueue(new Uint8Array(5));
        else controller.error(new Error(`Remote error ${token}`, { cause: token }));
      },
      cancel() { canceled = true; },
    });
    const error = await fetchPackageFromUrl(`https://${source}.icp0.io${path}`, {
      maxBytes: 4,
      preparedAccess: { source, token, paths: [path] },
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!new Headers(init?.headers).has("authorization")) return new Response(null, { status: 401, headers });
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
        return new Response(body, { headers });
      }) as unknown as typeof fetch,
    }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).cause).toBeUndefined();
    if (variant === "oversized") {
      expect((error as Error).message).toContain("4 bytes URL-install limit");
      expect(canceled).toBe(true);
    } else expect((error as Error).message).toBe("Package download was interrupted");
  }
});

test("URL package fetch cancels a stream that exceeds its actual byte limit", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(new Uint8Array(17));
    },
  });

  await expect(
    fetchPackageFromUrl("https://apps.example/large.neutron", {
      fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
      maxBytes: 16,
    }),
  ).rejects.toThrow("16 bytes URL-install limit");
  expect(cancelled).toBe(true);
});

test("URL package fetch preserves exact-limit bytes across chunks", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close();
    },
  });
  const bytes = await fetchPackageFromUrl(
    "https://apps.example/exact.neutron",
    {
      fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
      maxBytes: 4,
    },
  );
  expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test("URL package fetch gives a useful CORS-safe transport error", async () => {
  await expect(
    fetchPackageFromUrl("https://apps.example/demo.neutron", {
      fetch: (async () => {
        throw new TypeError("Failed to fetch https://secret.example/token");
      }) as unknown as typeof fetch,
    }),
  ).rejects.toThrow("Check the address, CORS settings");
});

test("an external manual package URL keeps its query and does not acquire repository credentials", async () => {
  const url = "https://apps.example/download?package=demo.neutron&token=external-token";
  const controller = new AbortController();
  const calls: string[] = [];
  await expect(fetchPackageFromUrl(url, {
    signal: controller.signal,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      expect(init?.signal).toBe(controller.signal);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      return new Response("private external package", { status: 401 });
    }) as unknown as typeof fetch,
  })).rejects.toThrow("HTTP 401");
  expect(calls).toEqual([url]);
});

test("canceling package acquisition retains AbortError instead of suggesting another download", async () => {
  const controller = new AbortController();
  const aborted = new DOMException("Owner canceled the download", "AbortError");
  await expect(fetchPackageFromUrl("https://apps.example/demo.neutron", {
    signal: controller.signal,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort(aborted);
      throw aborted;
    }) as unknown as typeof fetch,
  })).rejects.toBe(aborted);
});

test("package acquisition preserves safe repository access errors", async () => {
  const denied = new RepositoryAccessError("not_owned", "This Neutron does not own this package.");
  await expect(fetchPackageFromUrl("https://apps.example/demo.neutron", {
    fetch: (async () => { throw denied; }) as unknown as typeof fetch,
  })).rejects.toBe(denied);
});
