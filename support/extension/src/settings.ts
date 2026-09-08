import { PAIRING_KEY } from "./protocol";
import type { Pairing } from "./protocol";
import { settingsRequest, showError } from "./ui";

async function render() {
  try {
    const { entries } = await settingsRequest("list") as { entries: Pairing[] };
    const container = document.getElementById("connections")!;
    container.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No Neutrons connected yet.";
      container.append(empty);
    }
    for (const entry of entries) {
      const row = document.createElement("section");
      row.className = "connection";
      const origin = document.createElement("div");
      origin.className = "connection-origin";
      origin.textContent = entry.origin;
      const bottom = document.createElement("div");
      bottom.className = "connection-bottom";
      const date = document.createElement("span");
      date.textContent = `Connected ${new Date(entry.connectedAt).toLocaleDateString()}`;
      const revoke = document.createElement("button");
      revoke.className = "secondary";
      revoke.textContent = "Revoke";
      revoke.setAttribute("aria-label", `Revoke ${entry.origin}`);
      revoke.addEventListener("click", () => {
        revoke.disabled = true;
        void settingsRequest("revoke", { origin: entry.origin }).then(render).catch(error => { showError(error); revoke.disabled = false; });
      });
      bottom.append(date, revoke);
      row.append(origin, bottom);
      container.append(row);
    }
  } catch (error) { showError(error); }
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[PAIRING_KEY]) void render(); });
void render();
