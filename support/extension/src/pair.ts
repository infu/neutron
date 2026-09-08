import { settingsRequest, showError } from "./ui";
const requestId = new URL(location.href).searchParams.get("request");
const approve = document.getElementById("approve") as HTMLButtonElement;
const deny = document.getElementById("deny") as HTMLButtonElement;

void settingsRequest("pair_details", { requestId }).then(result => {
  document.getElementById("origin")!.textContent = result.origin;
  approve.disabled = false;
}).catch(showError);

async function decide(accept: boolean) {
  approve.disabled = true;
  deny.disabled = true;
  try {
    await settingsRequest("pair_decide", { requestId, accept });
    window.close();
  } catch (error) { showError(error); approve.disabled = false; deny.disabled = false; }
}
approve.addEventListener("click", () => { void decide(true); });
deny.addEventListener("click", () => { void decide(false); });
