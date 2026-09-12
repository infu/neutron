/** Deliberately replaces the Neutron transport in local UI tests. */
export function onAppStateChange(_topic: string, callback: (event: unknown) => void) {
  const listener = () => callback({ appId: "feedback", topic: _topic, revision: String(Date.now()) });
  window.addEventListener("feedback-fixture-state", listener);
  return () => window.removeEventListener("feedback-fixture-state", listener);
}
export function onTileViewRequest(callback: (view: string) => void) {
  const listener = (event: Event) => callback((event as CustomEvent<string>).detail);
  window.addEventListener("feedback-fixture-view", listener);
  return () => window.removeEventListener("feedback-fixture-view", listener);
}
export async function copyToClipboard(text: string) { (window as any).__feedbackTest.copies.push(text); }
export async function openAppTile(input: { view?: string }) {
  if (input.view !== undefined && !/^[a-z][a-z0-9_/-]{0,63}$/.test(input.view)) throw Error("Invalid tile view. The production SDK accepts letters, digits, underscores, slashes and hyphens.");
  (window as any).__feedbackTest.opened.push(input);
}
export async function dismissTray() { (window as any).__feedbackTest.dismissed++; }
export async function publishAppStateChange() { window.dispatchEvent(new CustomEvent("feedback-fixture-state")); }
export async function callTool(): Promise<never> { throw Error("Browser regression must use its injected FeedbackClient."); }
