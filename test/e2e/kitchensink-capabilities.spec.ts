import { randomUUID } from "node:crypto";
import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { expect, test, type Page } from "@playwright/test";
import {
  physicalAppMethodName,
  physicalPublicIngressMethodName,
} from "neutron-tools/src/physical_names.js";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { localIdentityFromSeed } from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

const APP_ID = "kitchensink";
const TEXT_PAIR_UPDATE = IDL.Func(
  [IDL.Tuple(IDL.Text, IDL.Text)],
  [IDL.Text],
  [],
);
let authorizedAgentPromise: Promise<HttpAgent> | null = null;

type PublicIngressResult =
  | { ok: Uint8Array | number[] }
  | { err: Record<string, null> };

test.describe("Kitchen Sink capability transports", () => {
  test("anonymous clients reach the physical public-ingress query dispatcher", async () => {
    const canisterId = resolveCanisterId();
    const method = physicalPublicIngressMethodName(
      APP_ID,
      "demo_v1",
      "query",
    );
    const agent = await HttpAgent.create({ host: localGatewayUrl() });
    await agent.fetchRootKey();
    const actor = Actor.createActor(
      ({ IDL }) => {
        const request = IDL.Record({
          method: IDL.Text,
          payload: IDL.Vec(IDL.Nat8),
        });
        const error = IDL.Variant({
          bad_request: IDL.Null,
          not_found: IDL.Null,
          too_large: IDL.Null,
          unauthorized: IDL.Null,
          rate_limited: IDL.Null,
          busy: IDL.Null,
          low_cycles: IDL.Null,
          revoked: IDL.Null,
          revoked_after_dispatch: IDL.Null,
          handler_failed: IDL.Null,
        });
        return IDL.Service({
          [method]: IDL.Func(
            [request],
            [IDL.Variant({ ok: IDL.Vec(IDL.Nat8), err: error })],
            ["query"],
          ),
        });
      },
      { agent, canisterId },
    ) as unknown as Record<
      string,
      ActorMethod<
        [{ method: string; payload: Uint8Array }],
        PublicIngressResult
      >
    >;

    const result = await actor[method]!({
      method: "status",
      payload: IDL.encode([], []),
    });

    expect(result).toHaveProperty("ok");
    if (!("ok" in result)) {
      throw new Error(`Public ingress failed: ${JSON.stringify(result)}`);
    }
    expect(IDL.decode([IDL.Text], Uint8Array.from(result.ok))).toEqual([
      "Kitchen Sink capability lab is ready",
    ]);

    const unknown = await actor[method]!({
      method: "missing",
      payload: IDL.encode([], []),
    });
    expect(unknown).toEqual({ err: { not_found: null } });
  });

  test("published shared-route content is available through certified GET and HEAD", async ({
    request,
  }) => {
    const canisterId = resolveCanisterId();
    const content = `Kitchen Sink certified transport ${randomUUID()}`;
    const token = randomUUID().replaceAll("-", "").slice(0, 16);
    const result = await callAuthorizedAppMethod<string>(
      canisterId,
      "publish_publication",
      TEXT_PAIR_UPDATE,
      [[content, token]],
    );
    const path = /^Published staged fixture: (\S+) \(revision /.exec(
      result,
    )?.[1];
    expect(path).toMatch(
      /^\/app\/kitchensink\/_route\/publication_demo\/[0-9a-f]{64}\/message\.txt$/,
    );

    const url = new URL(path!, localKernelUrl(canisterId)).href;
    const getResponse = await request.get(url);
    expect(getResponse.status()).toBe(200);
    expect(await getResponse.text()).toBe(content);
    expect(getResponse.headers()["content-type"]).toBe(
      "text/plain; charset=utf-8",
    );
    expect(getResponse.headers()["content-encoding"]).toBeUndefined();
    expect(getResponse.headers()["cache-control"]).toBe("no-store");
    expect(getResponse.headers()["ic-certificate"]).toBeTruthy();
    expect(getResponse.headers()["ic-certificateexpression"]).toContain(
      "certified_request_headers:[\"host\"]",
    );

    const headResponse = await request.fetch(url, { method: "HEAD" });
    expect(headResponse.status()).toBe(200);
    expect(await headResponse.body()).toHaveLength(0);
    expect(headResponse.headers()["content-length"]).toBe(
      String(Buffer.byteLength(content)),
    );
    expect(headResponse.headers()["ic-certificate"]).toBeTruthy();
    expect(headResponse.headers()["ic-certificateexpression"]).toBe(
      getResponse.headers()["ic-certificateexpression"],
    );

    const deleted = await callAuthorizedAppMethod<string>(
      canisterId,
      "delete_publication",
      TEXT_PAIR_UPDATE,
      [[content, token]],
    );
    expect(deleted).toBe(`Deleted staged fixture: ${path}`);
    expect((await request.get(url)).status()).toBe(404);
  });

  test("mutable blob uses exact CAS and serves portable bytes", async ({
    request,
  }) => {
    const canisterId = resolveCanisterId();
    const firstMessage = `Kitchen Sink head ${randomUUID()}`;
    const first = await callAuthorizedAppMethod<string>(
      canisterId,
      "put_mutable_blob",
      TEXT_PAIR_UPDATE,
      [[firstMessage, randomUUID().replaceAll("-", "").slice(0, 16)]],
    );
    const firstRevision = BigInt(
      /\(kernel revision ([0-9]+)\)$/.exec(first)?.[1] ?? "-1",
    );

    const secondMessage = `Kitchen Sink head CAS ${randomUUID()}`;
    const second = await callAuthorizedAppMethod<string>(
      canisterId,
      "put_mutable_blob",
      TEXT_PAIR_UPDATE,
      [[secondMessage, randomUUID().replaceAll("-", "").slice(0, 16)]],
    );
    const secondRevision = BigInt(
      /\(kernel revision ([0-9]+)\)$/.exec(second)?.[1] ?? "-1",
    );
    expect(secondRevision).toBe(firstRevision + 1n);

    const url = new URL(
      "/app/kitchensink/_route/blob_demo/v1/mutable/" +
        "000102030405060708090a0b0c0d0e0f" +
        "101112131415161718191a1b1c1d1e1f",
      localKernelUrl(canisterId),
    ).href;
    const response = await request.get(url);
    expect(response.status()).toBe(200);
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
    expect(response.headers()["cache-control"]).toBe(
      "no-cache, must-revalidate",
    );
    const [decoded] = IDL.decode(
      [IDL.Record({ schema: IDL.Nat, message: IDL.Text })],
      new Uint8Array(await response.body()),
    ) as [{ schema: bigint; message: string }];
    expect(decoded).toEqual({ schema: 1n, message: secondMessage });
  });

  test("the installed Kitchen Sink UI sends each two-text capability tuple", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const runtime = resolveLocalNeutronRuntime();
    await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
    await loginAsDeveloper(page, runtime.developerIdentitySeed);
    await page.locator('[data-tid="launcher-open"]').click();
    await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
    await page
      .locator('[data-tid="launcher-tile-kitchensink-main"]')
      .click();

    const kitchen = page.frameLocator(
      'iframe[data-app-id="kitchensink"][data-tile-id="main"]',
    );
    await kitchen.locator('[data-tid="kitchen-nav-certified_assets"]').click();
    await expect(
      kitchen.locator('[data-tid="kitchen-demo-certified_assets"]'),
    ).toBeVisible();
    const result = kitchen.locator('[data-tid="capability-assets-result"]');

    await kitchen.getByLabel("Staged publication text").fill(
      `UI publication ${randomUUID()}`,
    );
    await kitchen.getByRole("button", { name: "Review publish" }).click();
    await approveCallDialog(page);
    await expect(result).toContainText("Published staged fixture:");

    await kitchen
      .getByRole("button", { name: "Review conditional delete" })
      .click();
    await approveCallDialog(page);
    await expect(result).toContainText("Deleted staged fixture:");

    await kitchen.getByLabel("Staged immutable blob").fill(
      `UI immutable ${randomUUID()}`,
    );
    await kitchen
      .getByRole("button", { name: "Review immutable publish" })
      .click();
    await approveCallDialog(page);
    await expect(result).toContainText("Published immutable blob:");

    await kitchen.getByLabel("Inline/CAS mutable blob").fill(
      `UI mutable ${randomUUID()}`,
    );
    await kitchen
      .getByRole("button", { name: "Review inline/CAS put" })
      .click();
    await approveCallDialog(page);
    await expect(result).toContainText("Published inline/CAS mutable blob:");
  });

  test("the installed scheduler records the daily Kitchen Sink run-on-start", async () => {
    const canisterId = resolveCanisterId();
    const initial = await readScheduledStatus(canisterId);
    expect(initial.task_id).toBe("daily_tick");
    expect(initial.interval_seconds).toBe(86_400n);

    await expect
      .poll(
        async () => (await readScheduledStatus(canisterId)).runs,
        {
          message: "expected the daily task's run-on-start to be recorded",
          timeout: 25_000,
          intervals: [250, 500, 1_000],
        },
      )
      .toBeGreaterThan(0n);
  });
});

async function loginAsDeveloper(page: Page, seed: number) {
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
  await page.waitForFunction(
    () =>
      typeof (
        window as typeof window & {
          __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown;
        }
      ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function",
  );
  await page.evaluate(async (identitySeed) => {
    const login = (
      window as typeof window & {
        __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (value: number) => Promise<string>;
      }
    ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login is unavailable");
    await login(identitySeed);
  }, seed);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
}

async function approveCallDialog(page: Page) {
  const dialog = page.locator('[data-tid="call-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-tid="call-approve"]').click();
  await expect(dialog).toHaveCount(0, { timeout: 120_000 });
}

async function readScheduledStatus(canisterId: string): Promise<{
  task_id: string;
  runs: bigint;
  last_counter: bigint;
  interval_seconds: bigint;
}> {
  return callAuthorizedAppMethod(
    canisterId,
    "scheduled_status",
    IDL.Func(
      [IDL.Null],
      [
        IDL.Record({
          task_id: IDL.Text,
          runs: IDL.Nat,
          last_counter: IDL.Nat,
          interval_seconds: IDL.Nat,
        }),
      ],
      ["query"],
    ),
    [null],
  );
}

async function callAuthorizedAppMethod<Result>(
  canisterId: string,
  logicalMethod: string,
  candidMethod: ReturnType<typeof IDL.Func>,
  args: unknown[],
): Promise<Result> {
  const method = physicalAppMethodName(APP_ID, logicalMethod);
  authorizedAgentPromise ??= (async () => {
    const agent = await HttpAgent.create({
      host: localGatewayUrl(),
      identity: localIdentityFromSeed(
        resolveLocalNeutronRuntime().developerIdentitySeed,
      ),
    });
    await agent.fetchRootKey();
    return agent;
  })();
  const agent = await authorizedAgentPromise;
  const actor = Actor.createActor(
    ({ IDL }) => IDL.Service({ [method]: candidMethod }),
    { agent, canisterId },
  ) as unknown as Record<string, (...values: unknown[]) => Promise<Result>>;
  return actor[method]!(...args);
}

function localKernelUrl(canisterId: string): string {
  return localCanisterOrigin(canisterId, localGatewayUrl());
}

function resolveCanisterId(): string {
  return resolveLocalNeutronRuntime().canisterId;
}

function localGatewayUrl(): string {
  return resolveLocalNeutronRuntime().gatewayUrl;
}
