import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import {
	addsUp,
	breakdown,
	rankBreakdowns,
	type Breakdown,
} from "@/lib/explain/drivers";
import { toNumber } from "@/lib/format";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { reachableSet } from "@/lib/platform/sources";
import { executeQuery, QueryAccessError } from "@/lib/query/execute";
import { parseQuerySpec, QuerySpecError } from "@/lib/query/spec";
import { checkWriteRateLimit } from "@/lib/rateLimit";
import { getSource } from "@/lib/semantic/registry";
import type { SemanticSource } from "@/lib/semantic/types";

// Where a figure's change between two periods came from.
//
// The same figure asked for twice, over the window a reader is looking at and
// the one before it, split by each of the dataset's dimensions in turn. Every
// question goes through the executor a report uses, under the reader's own
// access, so a split shows only the rows they could already see. See
// lib/explain/drivers for how the parts are weighed.

// Dimensions tried at once. Enough to find where a change sits, few enough
// that one click does not become a hundred queries.
const maxDimensions = 12;
// Values read per dimension. A dimension with more than this is an
// identifier rather than a way of splitting, and is left out.
const maxValues = 300;
// Queries in flight at once for one request.
const parallel = 4;

interface Drill {
	field: string;
	value: string;
}

function isDate(source: SemanticSource, name: string): boolean {
	if (source.defaultTimeField === name) return true;
	const field = source.dimensions.find((f) => f.name === name);
	return Boolean(field?.dataType && /date|timestamp/i.test(field.dataType));
}

async function inTurn<T, R>(
	items: T[],
	work: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(parallel, items.length) }, async () => {
			while (next < items.length) {
				const at = next++;
				results[at] = await work(items[at]);
			}
		}),
	);
	return results;
}

export async function POST(request: NextRequest) {
	await ensureReadyOrDegrade();

	// Each request is two dozen queries, so it is held to the same budget as
	// the other expensive requests.
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
	}

	const source = getSource(String(body.sourceKey ?? ""));
	const reachable = await reachableSet(identity);
	if (!source || (reachable && !reachable.has(source.sourceKey))) {
		return NextResponse.json(
			{ error: "That dataset is not one you can read." },
			{ status: 403 },
		);
	}
	const measure = String(body.measure ?? "");
	if (!source.measures.some((m) => m.name === measure)) {
		return NextResponse.json(
			{ error: `${measure} is not a measure on ${source.title}.` },
			{ status: 400 },
		);
	}

	const current = Array.isArray(body.filters) ? body.filters : [];
	const previous = Array.isArray(body.previousFilters)
		? body.previousFilters
		: null;
	if (!previous) {
		return NextResponse.json(
			{ error: "There is no earlier period to compare with." },
			{ status: 400 },
		);
	}
	const drill: Drill[] = (Array.isArray(body.drill) ? body.drill : [])
		.map((d) => d as Record<string, unknown>)
		.filter(
			(d) => typeof d.field === "string" && typeof d.value === "string",
		)
		.slice(0, 6)
		.map((d) => ({ field: String(d.field), value: String(d.value) }));
	const drillFilters = drill.map((d) =>
		d.value === "(blank)"
			? { field: d.field, op: "is_empty" }
			: { field: d.field, op: "eq", value: d.value },
	);

	// Dates are what the two windows are, not a way of splitting the change
	// between them, and a field already drilled into has one value left. A
	// field the page filters to one value drops out on its own, since a split
	// with one part says nothing.
	const drilled = new Set(drill.map((d) => d.field));
	const dimensions = source.dimensions
		.map((f) => f.name)
		.filter((name) => !isDate(source, name))
		.filter((name) => !drilled.has(name))
		.slice(0, maxDimensions);

	const ask = async (filters: unknown[], dimension: string | null) => {
		const result = await executeQuery(
			identity,
			parseQuerySpec({
				sourceKey: source.sourceKey,
				dimensions: dimension ? [dimension] : [],
				measures: [measure],
				filters: [...filters, ...drillFilters],
				sort: [{ field: measure, direction: "desc" }],
				limit: dimension ? maxValues + 1 : 1,
				offset: 0,
				transforms: [],
			}),
		);
		return result.rows;
	};

	try {
		const [nowTotal, beforeTotal] = await Promise.all([
			ask(current, null),
			ask(previous, null),
		]);
		const totalNow = toNumber(nowTotal[0]?.[measure]);
		const totalBefore = toNumber(beforeTotal[0]?.[measure]);
		const change =
			totalNow !== null && totalBefore !== null
				? totalNow - totalBefore
				: 0;

		const splits = await inTurn(dimensions, async (dimension) => {
			try {
				const [now, before] = await Promise.all([
					ask(current, dimension),
					ask(previous, dimension),
				]);
				if (now.length > maxValues || before.length > maxValues) {
					return { dimension, now: null, before: null };
				}
				return { dimension, now, before };
			} catch {
				// One dimension the warehouse would not split by does not stop
				// the others.
				return { dimension, now: null, before: null };
			}
		});

		const usable = splits.filter(
			(
				s,
			): s is {
				dimension: string;
				now: Record<string, unknown>[];
				before: Record<string, unknown>[];
			} => s.now !== null && s.before !== null,
		);
		const additive = usable.some((s) => s.now.length > 0)
			? addsUp(
					totalNow,
					usable.find((s) => s.now.length > 0)?.now ?? [],
					measure,
				)
			: false;

		const ranked: Breakdown[] = rankBreakdowns(
			usable.map((s) =>
				breakdown(
					s.dimension,
					s.now,
					s.before,
					measure,
					change,
					additive,
				),
			),
		);

		return NextResponse.json({
			measure,
			current: totalNow,
			previous: totalBefore,
			change,
			additive,
			breakdowns: ranked.slice(0, 6),
			// Too many values to be a way of splitting, such as an order
			// number, so they were left out.
			skipped: splits
				.filter((s) => s.now === null)
				.map((s) => s.dimension),
		});
	} catch (error) {
		if (error instanceof QueryAccessError) {
			return NextResponse.json({ error: error.message }, { status: 403 });
		}
		if (error instanceof QuerySpecError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Explaining a change failed:", error);
		return NextResponse.json(
			{ error: "The change could not be broken down." },
			{ status: 500 },
		);
	}
}
