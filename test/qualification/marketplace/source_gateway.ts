import assert from "node:assert/strict";
import { Principal } from "@dfinity/principal";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import type { BrowserContext } from "@playwright/test";

type HttpRequest = { method: string; url: string; headers: [string, string][]; body: Uint8Array; certificate_version: number[] };
type HttpResponse = { status_code: number; headers: [string, string][]; body: Uint8Array; streaming_strategy: unknown[] };
export type SourceCorsRestoration = { path: string; status: number; gatewayExposedHeaders: string | null; canisterExposedHeaders: string; verificationVersion: number; gatewayCertificateVerified: true; authorizationPresent: boolean };
type SourceTransport = {
  source: string;
  gateway: string;
  rootKey: Uint8Array;
  readHttp(request: HttpRequest): Promise<HttpResponse>;
};

/** Playwright's routed Chromium synthesizes preflights. Observe both the actual
 * certified canister policy and the unmodified PocketIC gateway independently. */
export async function inspectSourcePreflight(input: SourceTransport, path: string) {
  const headers: [string, string][] = [["Origin", "http://qualification.localhost:8000"], ["Access-Control-Request-Method", "GET"], ["Access-Control-Request-Headers", "authorization"]];
  const request: HttpRequest = { method: "OPTIONS", url: path, headers, body: new Uint8Array(), certificate_version: [2] };
  const original = await input.readHttp(request);
  const verified = verifyRequestResponsePair(request, { status_code: original.status_code, headers: original.headers, body: new Uint8Array(original.body) }, Principal.fromText(input.source).toUint8Array(), BigInt(Date.now()) * 1_000_000n, 300_000_000_000n, input.rootKey, 2);
  assert.equal(verified.verificationVersion, 2);
  assert.ok(verified.response);
  const actual = Object.fromEntries(original.headers.map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(original.status_code, 204);
  assert.equal(actual["access-control-allow-origin"], "*");
  assert.ok(actual["access-control-allow-headers"]?.toLowerCase().split(",").map(value => value.trim()).includes("authorization"));
  assert.ok(actual["access-control-allow-methods"]?.split(",").map(value => value.trim()).includes("GET"));
  const gateway = await fetch(new URL(path, input.gateway), { method: "OPTIONS", headers: { ...Object.fromEntries(headers), Host: `${input.source}.localhost:8000` }, signal: AbortSignal.timeout(15_000) });
  await gateway.arrayBuffer();
  return {
    path, canister: { status: original.status_code, headers: actual, verificationVersion: verified.verificationVersion },
    gateway: { status: gateway.status, headers: Object.fromEntries(gateway.headers) },
    routedBrowserPreflight: "Playwright supplies preflight responses; the installed gate does not verify the gateway's preflight policy.",
  };
}

/** PocketIC 14's gateway replaces the canister's exposed-header list. Restore
 * only that CORS list, obtained from a real separately verified canister reply.
 * Package bytes, status, proof headers and private cache/authorization behavior
 * continue through the actual owned gateway. No production requests are made. */
export async function preserveSourceCertificateVisibility(context: BrowserContext, input: SourceTransport & {
  evidence: SourceCorsRestoration[];
  errors: string[];
}): Promise<void> {
  const host = `${input.source}.localhost:8000`;
  await context.route(url => url.protocol === "http:" && url.host === host && url.pathname.startsWith("/repo/v1/"), async route => {
    const browserRequest = route.request();
    if (browserRequest.method() !== "GET") return route.fallback();
    try {
      const url = new URL(browserRequest.url());
      const headers = await browserRequest.allHeaders();
      const request: HttpRequest = { method: "GET", url: url.pathname + url.search, headers: Object.entries(headers), body: new Uint8Array(), certificate_version: [2] };
      const original = await input.readHttp(request);
      assert.deepEqual(original.streaming_strategy, [], "These bounded fixture resources must not stream");
      const verified = verifyRequestResponsePair(request, { status_code: original.status_code, headers: original.headers, body: new Uint8Array(original.body) }, Principal.fromText(input.source).toUint8Array(), BigInt(Date.now()) * 1_000_000n, 300_000_000_000n, input.rootKey, 2);
      assert.equal(verified.verificationVersion, 2);
      assert.ok(verified.response, "Skipping certification is not a verified response");
      const declared = original.headers.find(([name]) => name.toLowerCase() === "access-control-expose-headers")?.[1];
      assert.ok(declared?.toLowerCase().includes("ic-certificate"), "The canister must itself expose the certificate header");
      // Playwright's API transport does not use Chromium's host resolver, so
      // retain the canonical Host while connecting to the owned gateway IP.
      const gateway = await route.fetch({ url: new URL(request.url, input.gateway).href, headers: { ...headers, host }, maxRedirects: 0 });
      const body = await gateway.body();
      assert.equal(gateway.status(), original.status_code, "Gateway status differs from the verified canister response");
      assert.deepEqual(new Uint8Array(body), new Uint8Array(original.body), "Gateway bytes differ from the verified canister response");
      const gatewayHeaders = gateway.headers();
      assert.ok(gatewayHeaders["ic-certificate"], "Never synthesize a missing gateway certificate");
      assert.ok(gatewayHeaders["ic-certificateexpression"], "Never synthesize a missing gateway expression");
      for (const name of ["access-control-allow-origin", "cache-control", "ic-certificateexpression"]) {
        const certified = original.headers.find(([key]) => key.toLowerCase() === name)?.[1];
        assert.ok(certified, `The canister must declare ${name}`);
        assert.equal(gatewayHeaders[name], certified, `Gateway changed ${name}; do not let Playwright's fulfillment defaults hide this`);
      }
      // Bind the certificate actually delivered by the gateway to the same
      // status, bytes and declared response headers. PocketIC appends Vary and
      // overwrites Expose-Headers after its own verification, so use the exact
      // declared headers for that certificate's response hash, never invented
      // values or a weaker expression.
      for (const [name, value] of original.headers) {
        if (["ic-certificate", "access-control-expose-headers", "vary"].includes(name.toLowerCase())) continue;
        assert.equal(gatewayHeaders[name.toLowerCase()], value, `Gateway changed the certified ${name} header`);
      }
      const declaredVary = original.headers.find(([name]) => name.toLowerCase() === "vary")?.[1].toLowerCase().split(",").map(value => value.trim()) ?? [];
      const gatewayVary = gatewayHeaders.vary?.toLowerCase().split(",").map(value => value.trim()) ?? [];
      assert.ok(declaredVary.every(value => gatewayVary.includes(value)), "Gateway removed a declared Vary dimension");
      const gatewayProof = verifyRequestResponsePair(request, { status_code: gateway.status(), headers: original.headers.map(([name, value]) => [name, name.toLowerCase() === "ic-certificate" ? gatewayHeaders["ic-certificate"]! : value]), body: new Uint8Array(body) }, Principal.fromText(input.source).toUint8Array(), BigInt(Date.now()) * 1_000_000n, 300_000_000_000n, input.rootKey, 2);
      assert.equal(gatewayProof.verificationVersion, 2);
      assert.ok(gatewayProof.response);
      input.evidence.push({ path: request.url, status: gateway.status(), gatewayExposedHeaders: gatewayHeaders["access-control-expose-headers"] ?? null, canisterExposedHeaders: declared, verificationVersion: verified.verificationVersion, gatewayCertificateVerified: true, authorizationPresent: !!headers.authorization });
      await route.fulfill({ response: gateway, headers: { ...gatewayHeaders, "access-control-expose-headers": declared }, body });
    } catch (error) {
      input.errors.push(`Source gateway qualification: ${String(error)}`);
      await route.abort("failed").catch(() => undefined);
    }
  });
}
