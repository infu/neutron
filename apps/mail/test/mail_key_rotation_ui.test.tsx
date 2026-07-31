import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MailKeyRotationPanel } from "../src/mail_key_rotation_ui.tsx";
import type { MailBackendCryptoProgress } from "../src/backend.ts";

const HOLDER = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";

describe("Mail key rotation UI", () => {
  test("moves through automatic preparation, resumable migration, and retirement", () => {
    const migrating = render(progress(3));
    expect(migrating).toContain("3 items left");
    expect(migrating).toContain("prepares both key generations automatically");
    expect(migrating).toContain("Continue migration");
    expect(migrating).not.toMatch(/Unlock|Lock/u);

    const resumable = render(progress(3));
    expect(resumable).toContain("Continue migration");

    const retire = render(progress(0));
    expect(retire).toContain("All local key wraps use the current generation");
    expect(retire).toContain("Retire previous key");
  });

  test("a clean current generation offers rotation without exposing key material", () => {
    const current = progress(0);
    current.previousEpoch = null;
    const markup = render(current);
    expect(markup).toContain("Rotate key");
    expect(markup).toContain("migrates only local encrypted-key wraps");
    expect(markup).not.toMatch(/wrapped|fingerprint|ciphertext/i);
  });
});

function render(
  cryptoProgress: MailBackendCryptoProgress,
): string {
  return renderToStaticMarkup(
    <MailKeyRotationPanel
      progress={cryptoProgress}
      phase="idle"
      notice={null}
      error={null}
      onRefresh={() => undefined}
      onRotate={() => undefined}
      onMigrate={() => undefined}
      onRetire={() => undefined}
    />,
  );
}

function progress(remaining: number): MailBackendCryptoProgress {
  return {
    revision: "9",
    keyHolder: HOLDER,
    currentEpoch: "8",
    previousEpoch: "7",
    previousReferences: {
      settings: "0",
      inbox: String(remaining),
      outbox: "0",
      total: String(remaining),
    },
    readyToRetire: remaining === 0,
  };
}
