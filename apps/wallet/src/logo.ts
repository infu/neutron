const MAX_LOGO_LENGTH = 32_768;
const DATA_IMAGE_PATTERN =
  /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;

export function safeTokenLogo(value: string | null): string | null {
  if (!value || value.length > MAX_LOGO_LENGTH) return null;
  const match = DATA_IMAGE_PATTERN.exec(value);
  if (!match) return null;

  const payload = match[1]!;
  if (payload.length === 0 || payload.length % 4 !== 0) return null;
  return value;
}

export function tokenInitials(symbol: string | null): string {
  return (symbol?.trim() || "?").slice(0, 2).toUpperCase();
}
