/**
 * A DAO's own logo.
 *
 * The source is always an inline `data:image/…` URI — `readMetadata` refuses
 * anything else — so nothing here reaches the network, and a missing or
 * rejected logo falls back to the DAO's initials rather than a broken image or
 * a hole in the layout.
 */

export function SnsLogo({
  logo,
  name,
  size = 20,
}: {
  logo?: string | undefined;
  name: string;
  size?: number;
}) {
  if (logo) {
    return (
      <img
        alt=""
        className="snsgov-logo"
        decoding="async"
        height={size}
        loading="lazy"
        src={logo}
        style={{ width: `${size}px`, height: `${size}px` }}
        width={size}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="snsgov-logo snsgov-logo--fallback"
      style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }}
    >
      {initials(name)}
    </span>
  );
}

/** Up to two letters, the way a DAO is spoken about: "BOOM DAO" -> "BD". */
function initials(name: string): string {
  const words = name
    .split(/[\s_-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}
