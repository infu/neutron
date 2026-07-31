import { CONNECTION_PROVIDER_SUPPORT_SCHEMA } from "neutron-tools/src/capabilities/catalog.js";

const TEXT_ENCODER = new TextEncoder();

/** Minimal canonical provider-support catalog required by every Kernel archive. */
export function testKernelConnectionProviderSupport(): Uint8Array {
  return TEXT_ENCODER.encode(
    JSON.stringify({
      schema: CONNECTION_PROVIDER_SUPPORT_SCHEMA,
      providers: [],
    }),
  );
}
