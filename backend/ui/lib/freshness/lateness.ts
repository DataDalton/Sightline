import { sql, transaction, tryAdvisoryLock } from "../data/lakebase";
import { knownMembers } from "../messages/store";
import {
	notifyInTransaction,
	pushNotification,
	type InboxItem,
	type NewNotification,
} from "../notify/store";
import { categoryRoleId } from "../platform/roles";
import {
	describePattern,
	describeSpan,
	judge,
	learnPattern,
	learningWindowMs,
	readLatenessSetting,
	type ArrivalPattern,
	type LateState,
	type LatenessSetting,
} from "./arrivals";
import { lateSubscribers } from "./status";

// Whether each source's data has arrived when it usually does.
//
// Judged from the arrivals the checker records for each table a source reads,
// so it needs no warehouse and runs on every replica. A source reading several
// tables is as late as the latest of them. The first replica to see a source
// go late is the one that tells people, since the change of state is claimed
// in the same transaction that writes the notices.

// How late a state is, so a source reading several tables takes the worst.
const rank: Record<LateState | "unwatched", number> = {
	late: 6,
	overdue: 5,
	on_time: 4,
	learning: 3,
	irregular: 2,
	off: 1,
	unwatched: 0,
};

interface SourceRow {
	source_key: string;
	title: string;
	kind: string;
	catalog_name: string;
	schema_name: string;
	object_name: string;
	base_tables: string[] | null;
	freshness_mode: string;
	lateness: unknown;
	late_state: string | null;
}

export interface StoredPattern extends ArrivalPattern {
	// The table the pattern was learned from, for a source reading several.
	table: string;
}

function tablesOf(row: SourceRow): string[] {
	if (row.kind === "metric_view") {
		return Array.isArray(row.base_tables) ? row.base_tables : [];
	}
	return [`${row.catalog_name}.${row.schema_name}.${row.object_name}`];
}

// Judged at most this often on one replica. What decides it moves with the
// clock and with each look, neither of which changes much in a minute.
const everyMs = 60_000;
let lastRun = 0;
let running = false;

// Identifies the lateness lock. Every replica ticks, one judges at a time.
const latenessLockKey = 8577412;

export async function evaluateLateness(force = false): Promise<void> {
	const now = Date.now();
	if (running || (!force && now - lastRun < everyMs)) return;
	running = true;
	lastRun = now;
	try {
		await tryAdvisoryLock(latenessLockKey, () => evaluate(now));
	} finally {
		running = false;
	}
}

async function evaluate(now: number): Promise<void> {
	const sources = await sql<SourceRow>(
		`SELECT source_key, title, kind, catalog_name, schema_name, object_name,
		        base_tables, freshness_mode, lateness, late_state
		 FROM data_sources WHERE is_active`,
	);
	const tables = [...new Set(sources.flatMap(tablesOf))];
	if (tables.length === 0) return;

	const [arrivals, checks] = await Promise.all([
		sql<{ table_name: string; arrived_on: string }>(
			`SELECT table_name, arrived_on::text FROM table_arrivals
			 WHERE table_name = ANY($1::text[])
			   AND arrived_on > now() - make_interval(secs => $2)`,
			[tables, learningWindowMs / 1000],
		),
		sql<{ table_name: string; checked_on: string | null }>(
			`SELECT table_name, checked_on::text FROM source_checks
			 WHERE table_name = ANY($1::text[])`,
			[tables],
		),
	]);

	const byTable = new Map<string, number[]>();
	for (const a of arrivals) {
		const list = byTable.get(a.table_name) ?? [];
		list.push(Date.parse(a.arrived_on));
		byTable.set(a.table_name, list);
	}
	const checkedOn = new Map(
		checks.map((c) => [
			c.table_name,
			c.checked_on ? Date.parse(c.checked_on) : null,
		]),
	);

	// Every source that is not newly late, written together at the end.
	const settled: (string | null)[][] = [];

	for (const source of sources) {
		const setting = readLatenessSetting(source.lateness);
		const names = tablesOf(source);

		let state: LateState | "unwatched" = "unwatched";
		let expectedBy: number | null = null;
		let lastArrival: number | null = null;
		let pattern: StoredPattern | null = null;

		// A source on a timer has no history to learn from.
		if (source.freshness_mode === "checked" && names.length > 0) {
			for (const table of names) {
				const seen = byTable.get(table) ?? [];
				const last = seen.length ? Math.max(...seen) : null;
				const learned = learnPattern(seen, now, setting);
				const judged = judge(
					learned,
					last,
					checkedOn.get(table) ?? null,
					now,
					setting,
				);
				// The worst table speaks for the source. Between two equally
				// placed, the one with more history says more about it.
				const better =
					rank[judged.state] > rank[state] ||
					(rank[judged.state] === rank[state] &&
						learned.arrivals > (pattern?.arrivals ?? -1));
				if (better) {
					state = judged.state;
					expectedBy = judged.expectedBy;
					lastArrival = last;
					pattern = { ...learned, table };
				}
			}
		}

		const values = [
			source.source_key,
			state,
			expectedBy ? new Date(expectedBy).toISOString() : null,
			lastArrival ? new Date(lastArrival).toISOString() : null,
			pattern ? JSON.stringify(pattern) : null,
		];

		// Newly late. The move to late and every notice about it are written
		// in one transaction, and only by the replica whose update moved it,
		// so a crash between the two can neither lose the notices nor send
		// them twice. When the notice cannot be put together the source is
		// left as it was and tried again on the next evaluation.
		if (state === "late" && source.late_state !== "late" && pattern) {
			const moved = await moveToLate(
				source,
				values,
				pattern,
				lastArrival,
				now,
			).catch((error) => {
				console.warn("Late data notice was not sent:", error);
				return null;
			});
			if (moved !== false) continue;
		}

		settled.push(values);
	}
	if (settled.length === 0) return;

	// One statement, writing only the rows whose standing moved.
	const column = (i: number) => settled.map((v) => v[i]);
	await sql(
		`UPDATE data_sources d SET late_state = u.state,
		   expected_by = u.expected, last_arrival = u.arrival,
		   arrival_pattern = u.pattern::jsonb
		 FROM unnest($1::text[], $2::text[], $3::timestamptz[],
		             $4::timestamptz[], $5::text[])
		      AS u(key, state, expected, arrival, pattern)
		 WHERE d.source_key = u.key
		   AND (d.late_state, d.expected_by, d.last_arrival, d.arrival_pattern)
		       IS DISTINCT FROM
		       (u.state, u.expected, u.arrival, u.pattern::jsonb)`,
		[column(0), column(1), column(2), column(3), column(4)],
	);
}

// The people who look after a source, meaning whoever may manage the catalogue of
// sources, and the maintainers of every category with a report built on it.
async function lookAfters(sourceKey: string): Promise<{
	people: string[];
	link: string | null;
}> {
	const reports = await sql<{ category_id: string | null; slug: string }>(
		`SELECT DISTINCT r.category_id, r.slug
		 FROM reports r
		 LEFT JOIN report_pages p ON p.report_id = r.report_id AND p.is_active
		 LEFT JOIN report_visuals v ON v.page_id = p.page_id AND v.is_active
		 WHERE r.is_active
		   AND (r.source_key = $1 OR p.source_key = $1 OR v.source_key = $1)`,
		[sourceKey],
	);
	const categoryRoles = [
		...new Set(
			reports
				.map((r) => r.category_id)
				.filter((c): c is string => Boolean(c)),
		),
	].map(categoryRoleId);

	const subjects = await sql<{ subject_type: string; subject_id: string }>(
		`SELECT DISTINCT a.subject_type, a.subject_id
		 FROM role_assignments a
		 LEFT JOIN role_capabilities c ON c.role_id = a.role_id
		 WHERE a.is_active
		   AND ((a.scope_type = 'global' AND c.capability = 'semantic.sync')
		        OR (a.scope_type = 'category' AND a.role_id = ANY($1::text[])))`,
		[categoryRoles],
	);

	const people = new Set(
		subjects
			.filter((s) => s.subject_type === "user")
			.map((s) => s.subject_id.toLowerCase()),
	);
	const groups = subjects
		.filter((s) => s.subject_type === "group")
		.map((s) => s.subject_id);
	for (const members of Object.values(await knownMembers(groups))) {
		for (const email of members) people.add(email.toLowerCase());
	}

	const curated = reports.find((r) => r.category_id);
	return {
		people: [...people],
		link: curated ? `/r/${curated.slug}/` : null,
	};
}

// Moves a source to late and tells the people who look after it, together.
// Returns false when another replica or an earlier evaluation had already
// moved it, so the caller settles it with the rest.
async function moveToLate(
	source: SourceRow,
	values: (string | null)[],
	pattern: StoredPattern,
	lastArrival: number | null,
	now: number,
): Promise<boolean> {
	const notice = await lateNotice(source, pattern, lastArrival, now);
	const written = await transaction(async (client) => {
		const moved = await client.query(
			`UPDATE data_sources SET late_state = $2, expected_by = $3,
			   last_arrival = $4, arrival_pattern = $5
			 WHERE source_key = $1 AND late_state IS DISTINCT FROM 'late'
			 RETURNING source_key`,
			values,
		);
		if (!moved.rowCount) return null;
		const items: { email: string; item: InboxItem }[] = [];
		for (const email of notice.people) {
			items.push({
				email,
				item: await notifyInTransaction(client, email, notice.input),
			});
		}
		return items;
	});
	if (written === null) return false;
	// Pushed once the entries are committed, so no device hears of one that
	// rolled back.
	for (const { email, item } of written) pushNotification(email, item);
	return true;
}

async function lateNotice(
	source: SourceRow,
	pattern: StoredPattern,
	lastArrival: number | null,
	now: number,
): Promise<{ people: string[]; input: NewNotification }> {
	const [{ people: lookAfterPeople, link }, subscribers] = await Promise.all([
		lookAfters(source.source_key),
		lateSubscribers(source.source_key),
	]);
	const people = [
		...new Set([
			...lookAfterPeople,
			...subscribers.map((email) => email.toLowerCase()),
		]),
	];
	const since = lastArrival
		? `The last load was ${describeSpan(now - lastArrival)} ago.`
		: "";
	// Said in UTC, since the people told may be anywhere, and marked so.
	const usual = describePattern(pattern, "UTC").replace(
		/ (AM|PM)\.$/,
		" $1 UTC.",
	);
	return {
		people,
		input: {
			kind: "data",
			title: `${source.title} has not updated`,
			body: `${usual} ${since}`.trim(),
			link,
			data: { sourceKey: source.source_key },
		},
	};
}

export interface LateSource {
	sourceKey: string;
	title: string;
	state: LateState | "unwatched";
	expectedBy: string | null;
	lastArrival: string | null;
	description: string | null;
}

// The standing of some sources, for the pages built on them and for the
// administration screens.
export async function latenessOf(
	sourceKeys: string[] | null,
	timeZone: string,
): Promise<LateSource[]> {
	const rows = await sql<{
		source_key: string;
		title: string;
		late_state: string | null;
		expected_by: string | null;
		last_arrival: string | null;
		arrival_pattern: StoredPattern | null;
	}>(
		`SELECT source_key, title, late_state, expected_by::text,
		        last_arrival::text, arrival_pattern
		 FROM data_sources
		 WHERE is_active AND ($1::text[] IS NULL OR source_key = ANY($1::text[]))`,
		[sourceKeys],
	);
	return rows.map((r) => ({
		sourceKey: r.source_key,
		title: r.title,
		state: (r.late_state as LateState | null) ?? "unwatched",
		expectedBy: r.expected_by,
		lastArrival: r.last_arrival,
		description: r.arrival_pattern
			? describePattern(r.arrival_pattern, timeZone)
			: null,
	}));
}

export interface LatenessDetail {
	setting: LatenessSetting;
	state: LateState | "unwatched";
	expectedBy: string | null;
	lastArrival: string | null;
	// Said in the reader's own time zone by the screen showing it.
	pattern: StoredPattern | null;
}

// One source's standing and setting, for its settings dialog.
export async function latenessDetail(
	sourceKey: string,
): Promise<LatenessDetail | null> {
	const rows = await sql<{
		lateness: unknown;
		late_state: string | null;
		expected_by: string | null;
		last_arrival: string | null;
		arrival_pattern: StoredPattern | null;
	}>(
		`SELECT lateness, late_state, expected_by::text, last_arrival::text,
		        arrival_pattern
		 FROM data_sources WHERE source_key = $1`,
		[sourceKey],
	);
	const row = rows[0];
	if (!row) return null;
	return {
		setting: readLatenessSetting(row.lateness),
		state: (row.late_state as LateState | null) ?? "unwatched",
		expectedBy: row.expected_by,
		lastArrival: row.last_arrival,
		pattern: row.arrival_pattern,
	};
}
