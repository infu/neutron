export async function settingsRequest(op: string, fields: Record<string, unknown> = {}): Promise<any> {
  const reply = await chrome.runtime.sendMessage({ target: "neutron-extension-settings", op, ...fields });
  if (!reply?.ok) throw new Error(reply?.error?.message ?? "The extension could not complete this request.");
  return reply.result;
}
export function showError(error: unknown) {
  const element = document.getElementById("error")!;
  element.textContent = error instanceof Error ? error.message : "The extension could not complete this request.";
  element.hidden = false;
}
