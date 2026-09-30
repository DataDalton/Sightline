// CSV encoding, RFC 4180.
//
// Held apart from the export that uses it because this is the part that can
// corrupt somebody's file rather than merely slow it down, and because the
// export writes in batches: the encoder has to produce pieces that concatenate
// into one valid document, which is a property worth stating and testing on its
// own.

// Text a spreadsheet program would run as a formula when the file is opened
// starts with one of these. A tab or carriage return is read past to the
// character after it by some programs, so those count as well.
const formulaLead = /^[=+\-@\t\r]/;

// A plain decimal number written as text, as the warehouse returns DECIMAL
// columns. Opened as a number, so it runs nothing and stays a number.
const plainNumber = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// Makes a text cell inert in a spreadsheet by prefixing a single quote, which
// every spreadsheet program reads as "this is text". Only text is changed. A
// number, a boolean, and text that is only a plain number pass through, so
// -5 stays a number a spreadsheet can sum. Applied to every cell and header
// a CSV file is built from, so no export path can skip it.
export function neutraliseFormula(value: unknown): unknown {
	if (typeof value !== "string") return value;
	if (!formulaLead.test(value) || plainNumber.test(value)) return value;
	return `'${value}`;
}

// A cell containing a delimiter, quote or newline is quoted, and embedded
// quotes are doubled. Text that would run as a formula is made inert first.
export function escapeCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	const safe = neutraliseFormula(value);
	const text = typeof safe === "string" ? safe : String(safe);
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
