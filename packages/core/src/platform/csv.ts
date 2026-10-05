/** Spreadsheet formula injection guard for CSV cells. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 document (CRLF line endings, trailing newline) of guarded cells. */
export function toCsv(header: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  const lines = [header.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}
