import {
  createKernelRuntimeConfig,
  encodeKernelRuntimeConfig,
  IC_RUNTIME_GATEWAY,
  IC_RUNTIME_IDENTITY_PROVIDER,
  isolatedFrameOriginTemplate,
} from "neutron-tools/src/runtime_config.js";
import { loadRuntimeDeployment } from "../src/runtime_deployment.ts";

export const TEST_KERNEL_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";

const certificate =
  "certificate=:AA==:, tree=:AA==:, expr_path=:AA==:, version=2";

export async function loadIcRuntimeFixture(): Promise<void> {
  const config = createKernelRuntimeConfig({
    target: "ic",
    gateway: IC_RUNTIME_GATEWAY,
    identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
    canister_id: TEST_KERNEL_CANISTER_ID,
    deployment_id: "01".repeat(16),
    root_key_policy: "mainnet",
    allow_loopback_http: false,
    isolated_frame_origin_template: isolatedFrameOriginTemplate(
      "ic",
      TEST_KERNEL_CANISTER_ID,
    ),
    update_source_origin: null,
  });
  await loadRuntimeDeployment(
    (async () =>
      new Response(encodeKernelRuntimeConfig(config) as unknown as BodyInit, {
        headers: {
          "content-type": "application/json",
          "ic-certificate": certificate,
          "ic-certificateexpression":
            "default_certification(ValidationArgs{certification: Certification{}})",
        },
      })) as unknown as typeof fetch,
    `https://${TEST_KERNEL_CANISTER_ID}.icp0.io/`,
  );
}
