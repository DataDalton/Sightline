// CSV encoding, RFC 4180.
//
// Held apart from the export that uses it because this is the part that can
// corrupt somebody's file rather than merely slow it down, and because the
// export writes in batches: the encoder has to produce pieces that concatenate
// into one valid document, which is a property worth stating and testing on its
// own.

// A cell containing a delimiter, quote or newline is quoted, and embedded
// quotes are doubled.
export function escapeCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	const text = typeof value === "string" ? value : String(value);
	if (/[",\r\n]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

// A UTF-8 BOM, so Excel opens non-ASCII names as text rather than as bytes.
export const byteOrderMark = "\ufeff";

// The header line, including the mark. Always the first piece of a document.
export function csvHeader(columns: string[]): string {
	return byteOrderMark + columns.map(escapeCell).join(",") + "\r\n";
}

// One batch of rows.
//
// Every line is terminated rather than separated, so two batches joined end to
// end do not run the last row of one into the first row of the next. That is
// the whole reason this is not a join: a separator-joined batch is valid on its
// own and wrong the moment it is followed by another.
export function csvRows(
	columns: string[],
	rows: Record<string, unknown>[],
): string {
	if (rows.length === 0) return "";
	let out = "";
	for (const row of rows) {
		out += columns.map((c) => escapeCell(row[c])).join(",") + "\r\n";
	}
	return out;
}
