import { beforeAll, expect, test } from "bun:test";
import {
  fetchPackageFromUrl,
  parseOfferedPackageUrl,
  parsePackageUrl,
} from "../src/tools/package_url.ts";
import { loadIcRuntimeFixture } from "./runtime_fixture.ts";

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
