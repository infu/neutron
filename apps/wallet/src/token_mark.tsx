import { useEffect, useState } from "react";
import { safeTokenLogo, tokenInitials } from "./logo.ts";

export function TokenMark({
  logo,
  symbol,
}: {
  logo: string | null;
  symbol: string | null;
}) {
  const source = safeTokenLogo(logo);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [source]);

  return (
    <span className="wallet-token-mark" aria-hidden="true">
      {source && !failed ? (
        <img
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
          src={source}
        />
      ) : (
        tokenInitials(symbol)
      )}
    </span>
  );
}
