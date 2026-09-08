// Token avatars.
//
// The icon is whatever the ledger itself declares as `icrc1:logo`, falling back
// to the token's SNS logo, and finally to a monogram derived from the ledger
// canister id. Resolution happens in the browser (see `logos.ts`); the monogram
// draws immediately so the table never waits on a network round trip and never
// reflows when the real icon arrives.

import { useEffect, useSyncExternalStore } from "react";
import { tokenInitials } from "./format.ts";
import { markLogoBroken, onLogoResolved, peekLogo, resolveLogo } from "./logos.ts";

const PALETTE = [
  "#8adf9d",
  "#7fc7ff",
  "#c9a6ff",
  "#ffb877",
  "#ff9aa8",
  "#7fe3d4",
  "#e0d27f",
  "#a8b6ff",
] as const;

function hash(value: string): number {
  let accumulator = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    accumulator ^= value.charCodeAt(index);
    accumulator = Math.imul(accumulator, 16777619);
  }
  return accumulator >>> 0;
}

function markFontSize(label: string, size: "sm" | "lg"): number {
  const base = size === "lg" ? 1.6 : 1;
  if (label.length >= 4) return 8 * base;
  if (label.length === 3) return 9.5 * base;
  return 11 * base;
}

/** The resolved icon for a ledger, resolving it on first use. */
export function useTokenLogo(address: string): string | null {
  const logo = useSyncExternalStore(
    onLogoResolved,
    () => (address === "" ? null : (peekLogo(address) ?? null)),
    () => null,
  );

  useEffect(() => {
    if (address === "") return;
    void resolveLogo(address);
  }, [address]);

  return logo;
}

export type TokenMarkProps = {
  symbol: string;
  address: string;
  size?: "sm" | "lg";
};

export function TokenMark({ symbol, address, size = "sm" }: TokenMarkProps) {
  const logo = useTokenLogo(address);
  const color = PALETTE[hash(address || symbol) % PALETTE.length] ?? PALETTE[0];
  const label = tokenInitials(symbol, address);
  const className =
    size === "lg" ? "ics-token-logo ics-detail-logo" : "ics-token-logo";

  if (logo !== null) {
    return (
      <span className={className}>
        <img
          alt=""
          decoding="async"
          loading="lazy"
          // A ledger can name an SNS logo that was never uploaded, which only
          // the image element discovers; fall back to the monogram then.
          onError={() => markLogoBroken(address)}
          src={logo}
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        color,
        boxShadow: `inset 0 0 0 1px ${color}55`,
        fontSize: `${markFontSize(label, size)}px`,
      }}
    >
      {label}
    </span>
  );
}
