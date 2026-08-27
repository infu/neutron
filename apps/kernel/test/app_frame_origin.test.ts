import { expect, test } from "bun:test";
import type { AppInstanceProjection } from "../src/app_scope.ts";
import { ordinaryAppFramePolicy } from "../src/app_frame_security.ts";
import { residentFrameSecurityMode } from "../src/capabilities/plan.ts";
import type { RuntimeDeployment } from "../src/runtime_deployment.ts";
import { registryApp } from "./app_registry_fixture.ts";

const canisterId = "4caro-hl777-77775-aaaba-cai";
const deployment: RuntimeDeployment = Object.freeze({
  target: "pocketic",
  canisterId,
  deploymentId: "deployment",
  gateway: "http://localhost:8000",
  identityProvider: "http://id.ai.localhost:8000/",
  rootKeyPolicy: "fetch",
  allowLoopbackHttp: true,
  isolatedFrameOriginTemplate:
    `http://{prefix}--${canisterId}.localhost:8000`,
  updateSourceOrigin: null,
  local: true,
  localHost: "http://localhost:8000",
});

test("resident capabilities never move ordinary surfaces onto the Kernel origin", () => {
  for (const capabilities of [
    {
      dedicated_resident_origin: {
        api: 1 as const,
        surface: "background" as const,
        mode: "credentialless_ephemeral_v1" as const,
      },
    },
    {
      persistent_browser_storage: {
        api: 1 as const,
        surface: "background" as const,
      },
    },
  ]) {
    const app = registryApp({
      id: "mail",
      name: "Mail",
      tiles: [{ id: "mail", title: "Mail" }],
      background: { path: "service.html" },
      tray: { title: "Mail", path: "tray.html", icon: "icon.svg" },
      capabilities,
    });
    const appInstance: AppInstanceProjection = {
      scope: { appId: "mail", installationUid: "7" },
      version: app.version,
      deploymentId: "deployment",
      capabilityPlanFingerprint: app.capability_plan_fingerprint,
      browserOriginNonce: "dc67918c9d79794438224f851f95897c",
      browserOriginAuthorityEpoch: "2",
      residentFrameSecurity: residentFrameSecurityMode(app),
    };
    const tile = ordinaryAppFramePolicy({
      appId: "mail",
      app,
      appInstance,
      endpoint: {
        role: "tile",
        path: "index.html",
        tileId: "mail",
        instanceId: "one",
        workspace: 1,
      },
      deployment,
      browserSurfaceOriginAdopted: true,
    });
    const tray = ordinaryAppFramePolicy({
      appId: "mail",
      app,
      appInstance,
      endpoint: { role: "tray", path: "tray.html", instanceId: "one" },
      deployment,
      browserSurfaceOriginAdopted: true,
    });

    expect(tile.origin).toStartWith("http://i");
    expect(tray.origin).toStartWith("http://i");
    expect(tile.origin).not.toBe(`http://${canisterId}.localhost:8000`);
    expect(tray.origin).not.toBe(tile.origin);
  }
});
