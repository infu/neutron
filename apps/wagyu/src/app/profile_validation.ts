const UTF8 = new TextEncoder();

export interface Utf8FieldValidation {
  byteLength: number;
  error: string | null;
}

export function validateUtf8Field(
  value: string,
  label: string,
  maxBytes: number,
): Utf8FieldValidation {
  const byteLength = UTF8.encode(value).byteLength;
  return {
    byteLength,
    error:
      byteLength > maxBytes
        ? `${label} is ${byteLength.toLocaleString()} UTF-8 bytes; the maximum is ${maxBytes.toLocaleString()}.`
        : null,
  };
}

export function profileSaveIsDisabled({
  saving,
  changed,
  textError,
  avatarError,
}: {
  saving: boolean;
  changed: boolean;
  textError: string | null;
  avatarError: string | null;
}): boolean {
  return saving || !changed || textError !== null || avatarError !== null;
}
