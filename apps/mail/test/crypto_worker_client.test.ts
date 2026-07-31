import { describe, expect, test } from "bun:test";
import {
  MailCryptoWorkerClient,
  mailWorkerCacheScopeFromUrl,
} from "../src/crypto_worker_client.ts";

const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const NONCE = "0123456789abcdef0123456789abcdef";
const QUERY = new URLSearchParams({
  app: "mail",
  role: "background",
  "installation-uid": "17",
  "resident-frame-security": "persistent_dedicated_v1",
  "browser-origin-nonce": NONCE,
  "browser-origin-authority-epoch": "3",
});

describe("Mail worker cache scope", () => {
  test("accepts only the exact persistent installation-scoped resident URL", () => {
    const production = residentUrl(
      `https://p${NONCE.slice(0, 24)}--${CANISTER}.icp0.io`,
    );
    const local = residentUrl(
      `http://p${NONCE.slice(0, 24)}--${CANISTER}.localhost:8000`,
    );
    const expected = {
      app: "mail" as const,
      canisterPrincipal: CANISTER,
      installationUid: "17",
      browserOriginNonce: NONCE,
      browserOriginAuthorityEpoch: "3",
    };

    expect(mailWorkerCacheScopeFromUrl(production)).toEqual(expected);
    expect(mailWorkerCacheScopeFromUrl(local)).toEqual(expected);
  });

  test("rejects changed authority, origin, path, or extra URL state", () => {
    const valid = new URL(residentUrl(
      `https://p${NONCE.slice(0, 24)}--${CANISTER}.icp0.io`,
    ));
    const variants = [
      changed(valid, (url) => url.searchParams.set("role", "tile")),
      changed(valid, (url) =>
        url.searchParams.set(
          "resident-frame-security",
          "credentialless_ephemeral_dedicated_v1",
        )),
      changed(valid, (url) => url.searchParams.set("installation-uid", "017")),
      changed(valid, (url) => url.searchParams.set("unexpected", "1")),
      changed(valid, (url) => {
        url.pathname = "/app/mail/index.html";
      }),
      changed(valid, (url) => {
        url.hostname = `p${"f".repeat(24)}--${CANISTER}.icp0.io`;
      }),
    ];

    for (const variant of variants) {
      expect(mailWorkerCacheScopeFromUrl(variant)).toBeNull();
    }
  });

  test("terminates the worker when an operation times out", async () => {
    const worker = new SilentWorker();
    const client = new MailCryptoWorkerClient(worker as unknown as Worker, null);

    await expect(client.call({ type: "status" }, 5))
      .rejects.toThrow("timed out");
    expect(worker.terminateCalls).toBe(1);
    await expect(client.status()).rejects.toThrow("closed");
  });
});

class SilentWorker {
  terminateCalls = 0;

  addEventListener(): void {}

  postMessage(): void {}

  terminate(): void {
    this.terminateCalls += 1;
  }
}

function residentUrl(origin: string): string {
  return `${origin}/app/mail/service.html?${QUERY.toString()}`;
}

function changed(input: URL, mutate: (url: URL) => void): URL {
  const output = new URL(input);
  mutate(output);
  return output;
}
