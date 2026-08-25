export function nullableField(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const stripped = String(value).trim();
	return stripped || null;
}

export function strOrNone(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const s = String(value).trim();
	return s || null;
}

export function utcNow(): string {
	return new Date().toISOString().replace("T", " ").substring(0, 19);
}
