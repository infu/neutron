import {
  installWagyuVerificationWorkerBootstrap,
  type WagyuWorkerBootstrapScopeV1,
} from "./runtime.ts";

// The build embeds this complete program in service.js. It starts from those
// exact package-owned bytes and accepts one private MessagePort; the global
// Worker channel never receives verifier trust or tasks.
installWagyuVerificationWorkerBootstrap(
  globalThis as unknown as WagyuWorkerBootstrapScopeV1,
);
