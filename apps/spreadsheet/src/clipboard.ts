/** Parse the tabular text format used by spreadsheet clipboards.
 *
 * Tabs and line breaks delimit ordinary fields. Quoted fields may contain
 * tabs, CR/LF line breaks, and doubled quotes, matching the interoperable
 * TSV shape emitted by Excel, Sheets, and common data tools.
 */
export function parseClipboardTable(source: string): string[][] {
  const rows: string[][] = [[]];
  let field = "";
  let quoted = false;
  let atFieldStart = true;

  const pushField = () => {
    rows.at(-1)!.push(field);
    field = "";
    atFieldStart = true;
  };
  const pushRow = () => {
    pushField();
    rows.push([]);
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else if (character === "\r") {
        field += "\n";
        if (source[index + 1] === "\n") index += 1;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (character === "\t") {
      pushField();
    } else if (character === "\n" || character === "\r") {
      pushRow();
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else {
      field += character;
      atFieldStart = false;
    }
  }
  if (quoted) throw new Error("Clipboard text contains an unterminated quoted field");
  pushField();
  return rows;
}

export function stringifyClipboardTable(rows: string[][]): string {
  return rows.map((row) => row.map((field) => {
    if (!/[\t\r\n"]/u.test(field)) return field;
    return `"${field.replaceAll('"', '""')}"`;
  }).join("\t")).join("\n");
}
