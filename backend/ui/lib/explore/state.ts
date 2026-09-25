import type { Condition, ConditionOp } from "./conditions";

// An exploration as data: the dataset, the columns in order, and the
// conditions. What a saved view stores and what the address carries, so a
// reload lands back on the same table and a link opens it for somebody else.
//
// Everything read back is checked and cut to size here, because both places it
// comes from are ones anybody can edit: a stored row was written by a client,
// and an address can be typed.
//
// Kept free of browser and network imports so it can be tested on its own.

export interface ExploreState {
	sourceKey: string;
	columns: string[];
	conditions: Condition[];
}

const maxColumns = 60;
const maxConditions = 40;
const maxValues = 200;
const maxText = 500;

const ops = new Set<ConditionOp>([
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"contains",
	"starts_with",
	"ends_with",
	"is_empty",
	"is_not_empty",
]);

function text(value: unknown): string | null {
	return typeof value === "string" ? value.slice(0, maxText) : null;
}

// Brackets on one condition. More than a handful at one place is not a query
// anybody wrote.
const maxBrackets = 8;

function bracketCount(
	key: "open" | "close",
	value: unknown,
): Partial<Record<"open" | "close", number>> {
	const n = Number(value);
	return Number.isInteger(n) && n > 0
		? { [key]: Math.min(n, maxBrackets) }
		: {};
}

export function cleanState(raw: unknown): ExploreState | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;

	const sourceKey = text(o.sourceKey);
	if (!sourceKey) return null;

	const columns = (Array.isArray(o.columns) ? o.columns : [])
		.map(text)
		.filter((c): c is string => Boolean(c))
		.filter((c, i, all) => all.indexOf(c) === i)
		.slice(0, maxColumns);

	const conditions: Condition[] = [];
	for (const item of Array.isArray(o.conditions) ? o.conditions : []) {
		if (conditions.length >= maxConditions) break;
		if (!item || typeof item !== "object") continue;
		const c = item as Record<string, unknown>;
		const field = text(c.field);
		const op = c.op as ConditionOp;
		if (!field || !ops.has(op)) continue;
		const values = Array.isArray(c.values)
			? c.values
					.map(text)
					.filter((v): v is string => v !== null)
					.slice(0, maxValues)
			: [];
		const value = text(c.value);
		conditions.push({
			field,
			op,
			...(values.length > 0
				? { values }
				: value !== null
					? { value }
					: {}),
			negate: c.negate === true,
			join: c.join === "or" ? "or" : "and",
			...bracketCount("open", c.open),
			...bracketCount("close", c.close),
		});
	}

	return { sourceKey, columns, conditions };
}

// Base64 in the URL-safe alphabet, over the UTF-8 bytes, so a field name or a
// value outside ASCII survives the trip through an address.
function toBase64Url(value: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(value)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return new TextDecoder().decode(
		Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
	);
}

export function encodeState(state: ExploreState): string {
	return toBase64Url(JSON.stringify(state));
}

// Null for anything that is not a state this page wrote, rather than an error:
// a mangled link opens an empty explorer, not a broken one.
export function decodeState(value: string): ExploreState | null {
	try {
		return cleanState(JSON.parse(fromBase64Url(value)));
	} catch {
		return null;
	}
}
