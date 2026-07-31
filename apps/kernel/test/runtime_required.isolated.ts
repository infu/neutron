import { expect, test } from "bun:test";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  serializeRepositoryReleaseRecord,
} from "neutron-tools/repository";
import {
  createKernelRuntimeConfig,
  encodeKernelRuntimeConfig,
  isolatedFrameOriginTemplate,
  POCKETIC_RUNTIME_GATEWAY,
  runtimeUpdateSourceOrigin,
} from "neutron-tools/src/runtime_config.js";
import { scopedLocalIdentityProvider } from "neutron-tools/src/runtime.js";
import { getNeutronId } from "../src/config.ts";
import { createAnonymousRepositorySource } from "../src/repository/client.ts";
import {
  getRuntimeDeployment,
  loadRuntimeDeployment,
} from "../src/runtime_deployment.ts";
import { fetchPackageFromUrl } from "../src/tools/package_url.ts";
import { fetchUpdateRelease } from "../src/updates/client.ts";

const CANISTER_ID = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const KERNEL_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";

test("active Kernel routing fails before transport without certified runtime", async () => {
  let fetches = 0;
  const transport = (async () => {
    fetches += 1;
    return new Response();
  }) as unknown as typeof fetch;

  expect(() => getRuntimeDeployment()).toThrow(
    "Kernel runtime deployment has not been loaded",
  );
  expect(() => getNeutronId()).toThrow(
    "Kernel runtime deployment has not been loaded",
  );
  await expect(
    fetchUpdateRelease(CANISTER_ID, "mail", { fetch: transport }),
  ).rejects.toThrow("Kernel runtime deployment has not been loaded");
  await expect(
    fetchPackageFromUrl("https://apps.example/mail.neutron", {
      fetch: transport,
    }),
  ).rejects.toThrow("Kernel runtime deployment has not been loaded");
  await expect(
    createAnonymousRepositorySource(CANISTER_ID, { fetch: transport }),
  ).rejects.toThrow("Kernel runtime deployment has not been loaded");
  expect(fetches).toBe(0);

  const runtime = createKernelRuntimeConfig({
    target: "pocketic",
    gateway: POCKETIC_RUNTIME_GATEWAY,
    identity_provider: scopedLocalIdentityProvider({
      neutronCanisterId: KERNEL_ID,
      localHost: POCKETIC_RUNTIME_GATEWAY,
    }),
    canister_id: KERNEL_ID,
    deployment_id: "01".repeat(16),
    root_key_policy: "fetch",
    allow_loopback_http: true,
    isolated_frame_origin_template: isolatedFrameOriginTemplate(
      "pocketic",
      KERNEL_ID,
    ),
    update_source_origin: runtimeUpdateSourceOrigin(
      "pocketic",
      CANISTER_ID,
    ),
  });
  await loadRuntimeDeployment(
    (async () =>
      new Response(encodeKernelRuntimeConfig(runtime) as unknown as BodyInit, {
        headers: {
          "content-type": "application/json",
          "ic-certificate":
            "certificate=:AA==:, tree=:AA==:, expr_path=:AA==:, version=2",
          "ic-certificateexpression": "default_certification()",
        },
      })) as unknown as typeof fetch,
    `http://${KERNEL_ID}.localhost:8000/`,
  );

  const packageBytes = new Uint8Array([1, 2, 3]);
  const release = {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id: "mail",
    version: 101,
    sha256: hashContent(packageBytes),
    size: packageBytes.byteLength,
  } as const;
  let requested = "";
  await fetchUpdateRelease(CANISTER_ID, "mail", {
    fetch: (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(
        serializeRepositoryReleaseRecord(release) as unknown as BodyInit,
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
  expect(requested).toBe(
    `http://${CANISTER_ID}.localhost:8000/repo/v1/releases/mail.json`,
  );
});
