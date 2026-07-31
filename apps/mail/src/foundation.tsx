import { dismissTray, openAppTile } from "neutron-tools/app";

export function MailFoundation({ surface }: { surface: "tile" | "tray" }) {
  async function openMail(): Promise<void> {
    await openAppTile({
      appId: "mail",
      tileId: "mail",
      reuseExisting: true,
    });
    await dismissTray();
  }

  if (surface === "tray") {
    return (
      <main className="nt-app mail-foundation mail-foundation--tray">
        <div className="mail-foundation-copy">
          <strong>Private Mail is not active</strong>
          <span>Finish secure Mail setup in the app.</span>
        </div>
        <button type="button" className="nt-button" onClick={() => void openMail()}>
          Open Mail
        </button>
      </main>
    );
  }

  return (
    <main className="nt-app mail-foundation">
      <section className="mail-foundation-panel" aria-labelledby="mail-foundation-title">
        <span className="mail-foundation-mark" aria-hidden="true">✉</span>
        <div>
          <h1 id="mail-foundation-title">Private Mail</h1>
          <p>
            Private Mail uses an app-isolated key slot. Set it up once and Mail
            prepares its private key automatically whenever you read or send.
          </p>
        </div>
      </section>
    </main>
  );
}
