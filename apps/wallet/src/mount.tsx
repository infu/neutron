import { createRoot } from "react-dom/client";
import { WalletApp, type WalletSurface } from "./index.tsx";

export function mountWallet(surface: WalletSurface): void {
  const container = document.getElementById("root");
  if (!container) throw new Error("Missing Wallet root element");
  createRoot(container).render(<WalletApp surface={surface} />);
}
