// Small client-side CSV export helper. Caller passes the column definition
// (header label + value getter) and the row array; we produce an RFC 4180-ish
// CSV string and trigger a browser download via an Object URL.

export interface CsvColumn<T> {
	header: string;
	get: (row: T) => unknown;
}

function escapeCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	const s = typeof value === "string" ? value : String(value);
	// Quote when the cell contains a delimiter, quote, or newline. Embedded
	// quotes are escaped by doubling per RFC 4180.
	if (/[",\r\n]/.test(s)) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

export function buildCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
	const headerLine = columns.map((c) => escapeCell(c.header)).join(",");
	const dataLines = rows.map((row) =>
		columns.map((c) => escapeCell(c.get(row))).join(","),
	);
	// Prepend a UTF-8 BOM so Excel opens non-ASCII names correctly.
	return "﻿" + [headerLine, ...dataLines].join("\r\n");
}

export function downloadCsv(filename: string, content: string): void {
	const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.style.display = "none";
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	// Defer revoke so the click has time to start the download.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Strip characters that are illegal or awkward in cross-platform filenames.
// Collapses runs of replaced characters into a single underscore.
export function safeFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "export";
}
