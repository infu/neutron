import { expect, test } from "bun:test";
import {
  FILES_WORKER_INITIAL_STATUS,
  verifyFilesWorkerInChromium,
} from "../scripts/worker_browser_release.ts";

test(
  "exact inline worker runs in a persistent Chromium Window",
  async () => {
    const evidence = await verifyFilesWorkerInChromium();
    expect(evidence.engine.name).toBe("chromium");
    expect(evidence.engine.version.length).toBeGreaterThan(0);
    expect(evidence.frame).toEqual({
      credentialless: false,
      indexed_db: true,
      path: "/frame",
    });
    expect(evidence.worker.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.worker.source_bytes).toBeGreaterThan(100_000);
    expect(evidence.worker.initial_status).toEqual(
      FILES_WORKER_INITIAL_STATUS,
    );
    expect(evidence.negative_control).toEqual({
      credentialless_frame_rejected: true,
      reason: "persistent_resident_required",
    });
  },
  30_000,
);
