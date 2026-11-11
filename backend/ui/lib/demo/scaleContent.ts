import { sql, transaction } from "../data/lakebase";
import { tablesOf } from "../dataRules/store";
import { measuresOnPage } from "../insight/pageGoals";
import { localIdentityEmail } from "../runtime";
import { dropHeld } from "../updates/store";
import { categories, people } from "./content";
import { sources } from "./datasets";
import {
	buildDeck,
	buildFollows,
	buildGoals,
	buildNotes,
	buildReads,
	buildRuleRuns,
	buildRules,
	buildThreads,
	buildUpdates,
	buildValueNotes,
	buildVisualNotes,
	githubAliases,
	goalHistory,
	makeRandom,
	ruleSpecs,
	type ScalePage,
	type ScaleReport,
	type ScaleVisual,
} from "./scaleData";

// Brings the demo up to the volumes a production workspace holds for updates, data rules,
// goals, decks, value notes, visual notes and conversations, so a load test against the
// demo pays what production pays for them. The rows are built in lib/demo/scaleData and
// written here in one transaction, a statement per table.
//
// Written once. The first scale update's reference marks a demo that already has it, so
// a demo seeded before this existed gains it on its next start and keeps it after.

const markerReference = "demo-scale-1";
const seed = 20261110;
const updateCount = 600;
const ruleHistoryDays = 90;
const goalHistoryDays = 60;
const valueNoteCount = 40;
const visualNoteCount = 150;
const threadCount = 30;

const dayMs = 86_400_000;
const hourMs = 3_600_000;

// Quotes a column name the seed itself chose, for the sample tables.
function column(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function tableOfSource(sourceKey: string): string | null {
	const source = sources.find((s) => s.key === sourceKey);
	return source ? `${column(source.schema)}.${column(source.object)}` : null;
}

async function distinctValues(
	sourceKey: string,
	name: string,
	limit = 200,
): Promise<string[]> {
	const table = tableOfSource(sourceKey);
	if (!table) return [];
	const rows = await sql<{ value: string }>(
		`SELECT DISTINCT ${column(name)}::text AS value FROM ${table}
		 WHERE ${column(name)} IS NOT NULL ORDER BY 1 LIMIT ${limit}`,
	);
	return rows.map((row) => row.value);
}

// The text dimensions of each source that hold a short list of values, such as a region
// or a carrier, with what each holds. Dates and identifiers are left out.
async function dimensionValues(): Promise<
	{ sourceKey: string; field: string; column: string; values: string[] }[]
> {
	const out: {
		sourceKey: string;
		field: string;
		column: string;
		values: string[];
	}[] = [];
	for (const source of sources) {
		for (const field of source.fields) {
			if (field.kind !== "dimension" || field.type !== "string") continue;
			if (/\bID$/.test(field.name)) continue;
			const values = await distinctValues(source.key, field.expr, 41);
			if (values.length > 0 && values.length <= 40) {
				out.push({
					sourceKey: source.key,
					field: field.name,
					column: field.expr,
					values,
				});
			}
		}
	}
	return out;
}

async function readWorld() {
	const reports = await sql<ScaleReport>(
		`SELECT report_id::text AS "reportId", slug, title, category_id AS "categoryId",
		        source_key AS "sourceKey"
		 FROM reports WHERE is_active AND NOT is_personal
		 ORDER BY slug`,
	);
	const pages = await sql<ScalePage>(
		`SELECT p.page_id::text AS "pageId", p.report_id::text AS "reportId", p.title,
		        p.source_key AS "sourceKey"
		 FROM report_pages p JOIN reports r ON r.report_id = p.report_id
		 WHERE p.is_active AND r.is_active AND NOT r.is_personal
		 ORDER BY r.slug, p.sort_order, p.title`,
	);
	const visuals = await sql<
		ScaleVisual & {
			sourceKey: string | null;
			config: { measures?: unknown };
		}
	>(
		`SELECT v.visual_id::text AS "visualId", v.page_id::text AS "pageId",
		        p.report_id::text AS "reportId", v.visual_type AS "visualType", v.title,
		        v.source_key AS "sourceKey", v.config
		 FROM report_visuals v
		 JOIN report_pages p ON p.page_id = v.page_id
		 JOIN reports r ON r.report_id = p.report_id
		 WHERE v.is_active AND p.is_active AND r.is_active AND NOT r.is_personal
		 ORDER BY r.slug, p.sort_order, v.sort_order, v.layout_y, v.layout_x, v.visual_type`,
	);
	return { reports, pages, visuals };
}

// The figure a goal's measure stands at today, over the whole table or one value of a field.
async function currentValue(
	sourceKey: string,
	measure: string,
	filter: { column: string; value: string } | null,
): Promise<number | null> {
	const source = sources.find((s) => s.key === sourceKey);
	const field = source?.fields.find(
		(f) => f.name === measure && f.kind === "measure",
	);
	const table = tableOfSource(sourceKey);
	if (!field || !table) return null;
	const rows = await sql<{ value: number | null }>(
		`SELECT (${field.expr})::float8 AS value FROM ${table}
		 ${filter ? `WHERE ${column(filter.column)}::text = $1` : ""}`,
		filter ? [filter.value] : [],
	);
	const value = rows[0]?.value;
	return value === null ||
		value === undefined ||
		!Number.isFinite(Number(value))
		? null
		: Number(value);
}

export async function seedScale(): Promise<void> {
	const held = await sql(`SELECT 1 FROM updates WHERE reference = $1`, [
		markerReference,
	]);
	if (held.length > 0) return;
	const started = Date.now();
	const now = started;
	const random = makeRandom(seed);
	const emails = people.map((person) => person.email);
	const signedIn = localIdentityEmail.toLowerCase();

	// --- Reading what the demo holds -------------------------------------------------
	const world = await readWorld();
	const dimensions = await dimensionValues();
	const valuesByColumn = new Map<string, string[]>();
	const valuesOf = async (sourceKey: string, name: string) => {
		const key = `${sourceKey}|${name}`;
		if (!valuesByColumn.has(key))
			valuesByColumn.set(key, await distinctValues(sourceKey, name));
		return valuesByColumn.get(key)!;
	};
	const tableNames = new Map<string, string>();
	const rowCounts = new Map<string, number>();
	for (const source of sources) {
		const [table] = await tablesOf(source.key);
		if (table) tableNames.set(source.key, table);
		const [counted] = await sql<{ total: number }>(
			`SELECT count(*)::int AS total FROM ${tableOfSource(source.key)}`,
		);
		rowCounts.set(source.key, counted?.total ?? 0);
	}

	// --- Building ------------------------------------------------------------------------
	const updates = buildUpdates(
		random,
		{ now, people: emails, reports: world.reports, pages: world.pages },
		updateCount,
	);
	const reads = buildReads(random, updates, emails, now);
	const notes = buildNotes(random, updates, emails, now);
	const follows = buildFollows(random, emails);
	const aliases = githubAliases(emails);

	// Allowed values and group labels are read before building, since the builder is synchronous.
	for (const [sourceKey, specs] of Object.entries(ruleSpecs)) {
		for (const spec of specs) {
			if (spec.valuesFrom) await valuesOf(sourceKey, spec.valuesFrom);
			if (spec.groupBy) await valuesOf(sourceKey, spec.groupBy);
			if (spec.kind === "distributionShift" && spec.params.column)
				await valuesOf(sourceKey, spec.params.column);
		}
	}
	const cached = (sourceKey: string, name: string) =>
		valuesByColumn.get(`${sourceKey}|${name}`) ?? [];
	const rules = buildRules(
		random,
		(key) => tableNames.get(key) ?? null,
		cached,
		emails,
	).map((rule) => ({
		...rule,
		ruleId: random.uuid(),
	}));
	const failingToday = random.sample(
		rules.map((_, index) => index),
		random.int(2, 3),
	);
	const { runs, incidents } = buildRuleRuns(
		random,
		rules.map((rule) => ({
			kind: rule.spec.kind,
			severity: rule.spec.severity,
			rowCount: rowCounts.get(rule.sourceKey) ?? 0,
			groupLabels: rule.spec.groupBy
				? cached(rule.sourceKey, rule.spec.groupBy)
				: rule.spec.kind === "distributionShift" &&
					  rule.spec.params.column
					? cached(rule.sourceKey, rule.spec.params.column)
					: [],
		})),
		ruleHistoryDays,
		now,
		failingToday,
	);

	// Goals go on the measures each report's pages show.
	const reportMeasures = world.reports.map((report) => {
		const found = new Map<string, { sourceKey: string; measure: string }>();
		for (const page of world.pages.filter(
			(p) => p.reportId === report.reportId,
		)) {
			const onPage = measuresOnPage(
				world.visuals.filter((v) => v.pageId === page.pageId),
				page.sourceKey ?? report.sourceKey,
			);
			for (const held of onPage)
				found.set(`${held.sourceKey}|${held.measure}`, held);
		}
		return { reportId: report.reportId, measures: [...found.values()] };
	});
	const goalPlans = buildGoals(random, reportMeasures, emails, (sourceKey) =>
		dimensions
			.filter((d) => d.sourceKey === sourceKey)
			.map((d) => ({ field: d.field, values: d.values })),
	);
	const goals: {
		goalId: string;
		plan: (typeof goalPlans)[number];
		target: number;
		readers: string[];
		current: number;
	}[] = [];
	for (const plan of goalPlans) {
		const dimension = plan.filter
			? dimensions.find(
					(d) =>
						d.sourceKey === plan.sourceKey &&
						d.field === plan.filter!.field,
				)
			: undefined;
		const current = await currentValue(
			plan.sourceKey,
			plan.measure,
			plan.filter && dimension
				? { column: dimension.column, value: plan.filter.value }
				: null,
		);
		if (current === null) continue;
		const target = plan.lowerIsBetter
			? current * (1 - plan.stretch)
			: current * (1 + plan.stretch);
		goals.push({
			goalId: random.uuid(),
			plan,
			target:
				Math.abs(target) >= 100
					? Math.round(target)
					: Math.round(target * 100) / 100,
			readers: random.sample(emails, random.int(3, 5)),
			current,
		});
	}
	const progress = goals.flatMap((goal) =>
		goal.readers.flatMap((email) =>
			goalHistory(
				random,
				goal.current,
				goalHistoryDays,
				goal.plan.lowerIsBetter,
			).map((point) => ({
				goalId: goal.goalId,
				email,
				daysAgo: point.daysAgo,
				value: point.value,
			})),
		),
	);

	// Decks on about half the reports, a walkthrough, slides or both.
	const deckReports = world.reports.filter(() => random.chance(0.5));
	const decks = deckReports.flatMap((report) => {
		const shape = {
			reportId: report.reportId,
			title: report.title,
			pages: world.pages
				.filter((page) => page.reportId === report.reportId)
				.map((page) => ({
					pageId: page.pageId,
					title: page.title,
					visuals: world.visuals.filter(
						(v) =>
							v.pageId === page.pageId &&
							!/Filter$|Switch$/.test(v.visualType),
					),
				})),
		};
		const kinds = random.weighted([
			[["walkthrough"], 40],
			[["slides"], 25],
			[["walkthrough", "slides"], 35],
		] as const);
		return kinds.map((kind) => ({
			deckId: random.uuid(),
			reportId: report.reportId,
			deck: buildDeck(random, shape, kind),
			createdDaysAgo: random.int(5, 300),
			by: random.pick(emails),
		}));
	});
	const deckProgress = decks.flatMap((deck) =>
		random.sample(emails, random.int(2, 7)).map((email) => {
			const startedDaysAgo = random.int(0, deck.createdDaysAgo);
			return {
				deckId: deck.deckId,
				email,
				startedOn: new Date(now - startedDaysAgo * dayMs).toISOString(),
				finishedOn: random.chance(0.6)
					? new Date(
							now -
								startedDaysAgo * dayMs +
								random.int(5, 40) * 60_000,
						).toISOString()
					: null,
			};
		}),
	);

	const valueNotes = buildValueNotes(
		random,
		dimensions.map((d) => ({
			sourceKey: d.sourceKey,
			field: d.field,
			values: d.values,
		})),
		emails,
		valueNoteCount,
	).map((note) => ({ ...note, noteId: random.uuid() }));

	const visualNotes = buildVisualNotes(
		random,
		world.visuals.filter((v) => !/Filter$|Switch$/.test(v.visualType)),
		emails,
		visualNoteCount,
	);

	const categoryIds = new Set(
		(
			await sql<{ id: string }>(
				`SELECT category_id AS id FROM categories`,
			)
		).map((row) => row.id),
	);
	const threads = buildThreads(
		random,
		categories
			.filter((category) => categoryIds.has(category.id))
			.map((category) => ({
				id: category.id,
				maintainers: category.maintainers,
				reports: world.reports
					.filter((r) => r.categoryId === category.id)
					.map((r) => ({ slug: r.slug, title: r.title })),
			})),
		emails,
		threadCount,
	).map((thread) => ({ ...thread, threadId: random.uuid() }));

	// --- Writing ------------------------------------------------------------------------
	await transaction(async (client) => {
		// One statement for a whole table, its rows passed as one JSON array in $1.
		const write = (text: string, rows: unknown[], extra: unknown[] = []) =>
			rows.length === 0
				? Promise.resolve()
				: client.query(text, [JSON.stringify(rows), ...extra]);

		await write(
			`INSERT INTO updates
			   (type, title, body, impact, status, about, before_value, after_value, links,
			    tags, reference, posted_on, effective_on, period_from, period_to, starts_on,
			    ends_on, repeat_every, incident_state, audience, delivery, show_from,
			    expires_on, require_ack, reason, created_by, authors, placement, notify,
			    what_to_do, delivered_on)
			 SELECT u.type, u.title, u.body, u.impact, u.status, u.about, u."before", u."after",
			        u.links, ARRAY(SELECT jsonb_array_elements_text(u.tags)), u.reference,
			        u."postedOn", u."effectiveOn", u."periodFrom", u."periodTo", u."startsOn",
			        u."endsOn", u."repeat", u."incidentState", u.audience, u.delivery,
			        u."showFrom", u."expiresOn", u."requireAck", u.reason, u."createdBy",
			        u.authors, u.placement, u.notify, u."whatToDo", u."postedOn"
			 FROM jsonb_to_recordset($1::jsonb) AS u(
			   type text, title text, body text, impact text, status text, about jsonb,
			   "before" text, "after" text, links jsonb, tags jsonb, reference text,
			   "postedOn" timestamptz, "effectiveOn" timestamptz, "periodFrom" timestamptz,
			   "periodTo" timestamptz, "startsOn" timestamptz, "endsOn" timestamptz,
			   "repeat" text, "incidentState" text, audience jsonb, delivery jsonb,
			   "showFrom" timestamptz, "expiresOn" timestamptz, "requireAck" boolean,
			   reason text, "createdBy" text, authors jsonb, placement text, notify boolean,
			   "whatToDo" text)`,
			updates.map((update) => ({
				...update.input,
				postedOn: update.postedOn,
				createdBy: update.createdBy,
			})),
		);
		// Every entry's history opens with its posting, as one posted through the app does.
		await client.query(
			`INSERT INTO update_events (update_id, by_email, at, kind)
			 SELECT update_id, created_by, posted_on, 'created' FROM updates
			 WHERE reference LIKE 'demo-scale-%'`,
		);
		await write(
			`INSERT INTO update_events (update_id, by_email, at, kind, note)
			 SELECT u.update_id, n.email, n."at", 'note', n.note
			 FROM jsonb_to_recordset($1::jsonb) AS n(reference text, email text, "at" timestamptz, note text)
			 JOIN updates u ON u.reference = n.reference`,
			notes.map((note) => ({
				...note,
				reference: `demo-scale-${note.index}`,
			})),
		);
		await write(
			`INSERT INTO update_reads (update_id, user_email, read_on, acked_on)
			 SELECT u.update_id, r.email, r."readOn", r."ackedOn"
			 FROM jsonb_to_recordset($1::jsonb)
			   AS r(reference text, email text, "readOn" timestamptz, "ackedOn" timestamptz)
			 JOIN updates u ON u.reference = r.reference
			 ON CONFLICT (update_id, user_email) DO NOTHING`,
			reads.map((read) => ({
				...read,
				reference: `demo-scale-${read.index}`,
			})),
		);
		await write(
			`INSERT INTO update_follows (user_email, kind, value, mode)
			 SELECT f.email, f.kind, f.value, f.mode
			 FROM jsonb_to_recordset($1::jsonb) AS f(email text, kind text, value text, mode text)
			 ON CONFLICT (user_email, kind, value) DO NOTHING`,
			follows,
		);
		await write(
			`INSERT INTO update_people_aliases (alias, kind, email, set_by)
			 SELECT a.alias, 'github', a.email, $2
			 FROM jsonb_to_recordset($1::jsonb) AS a(alias text, email text)
			 ON CONFLICT (alias) DO NOTHING`,
			aliases,
			[signedIn],
		);

		await write(
			`INSERT INTO data_rules
			   (rule_id, source_key, table_name, name, kind, params, severity, owner_email,
			    group_by, recent_column, recent_days, schedule, allow_failing, created_by,
			    created_on)
			 SELECT r."ruleId"::uuid, r."sourceKey", r."table", r.name, r.kind, r.params,
			        r.severity, r.owner, r."groupBy", r."recentColumn", r."recentDays",
			        r.schedule, r."allowFailing", r.owner, r."createdOn"
			 FROM jsonb_to_recordset($1::jsonb) AS r(
			   "ruleId" text, "sourceKey" text, "table" text, name text, kind text,
			   params jsonb, severity text, owner text, "groupBy" text, "recentColumn" text,
			   "recentDays" int, schedule text, "allowFailing" bigint, "createdOn" timestamptz)`,
			rules.map((rule) => ({
				ruleId: rule.ruleId,
				sourceKey: rule.sourceKey,
				table: rule.table,
				name: rule.spec.name,
				kind: rule.spec.kind,
				params: rule.spec.params,
				severity: rule.spec.severity,
				owner: rule.owner,
				groupBy: rule.spec.groupBy ?? null,
				recentColumn: rule.spec.recentColumn ?? null,
				recentDays: rule.spec.recentDays ?? null,
				schedule: rule.spec.schedule,
				allowFailing: rule.spec.allowFailing ?? 0,
				createdOn: new Date(
					now - (ruleHistoryDays + 5) * dayMs,
				).toISOString(),
			})),
		);
		await write(
			`INSERT INTO data_rule_runs
			   (rule_id, run_on, status, failing, checked, groups, measures, error, duration_ms)
			 SELECT r."ruleId"::uuid, r."runOn", r.status, r.failing, r.checked, r.groups,
			        r.measures, r.error, r."durationMs"
			 FROM jsonb_to_recordset($1::jsonb) AS r(
			   "ruleId" text, "runOn" timestamptz, status text, failing bigint, checked bigint,
			   groups jsonb, measures jsonb, error text, "durationMs" int)`,
			runs.map((run) => ({
				...run,
				ruleId: rules[run.ruleIndex].ruleId,
			})),
		);
		await write(
			`INSERT INTO data_incidents (rule_id, severity, status, opened_on, resolved_on)
			 SELECT i."ruleId"::uuid, i.severity,
			        CASE WHEN i."resolvedOn" IS NULL THEN 'open' ELSE 'resolved' END,
			        i."openedOn", i."resolvedOn"
			 FROM jsonb_to_recordset($1::jsonb)
			   AS i("ruleId" text, severity text, "openedOn" timestamptz, "resolvedOn" timestamptz)`,
			incidents.map((incident) => ({
				...incident,
				ruleId: rules[incident.ruleIndex].ruleId,
			})),
		);

		await write(
			`INSERT INTO goals
			   (goal_id, title, source_key, measure, filters, target, due_on, created_by,
			    report_id, created_on)
			 SELECT g."goalId"::uuid, g.title, g."sourceKey", g.measure, g.filters, g.target,
			        CURRENT_DATE + g."dueInDays", g."createdBy", g."reportId"::uuid,
			        now() - make_interval(days => $2::int)
			 FROM jsonb_to_recordset($1::jsonb) AS g(
			   "goalId" text, title text, "sourceKey" text, measure text, filters jsonb,
			   target float8, "dueInDays" int, "createdBy" text, "reportId" text)`,
			goals.map((goal) => ({
				goalId: goal.goalId,
				title: goal.plan.title,
				sourceKey: goal.plan.sourceKey,
				measure: goal.plan.measure,
				filters: goal.plan.filter
					? [
							{
								field: goal.plan.filter.field,
								op: "eq",
								value: goal.plan.filter.value,
							},
						]
					: [],
				target: goal.target,
				dueInDays: goal.plan.dueInDays,
				createdBy: goal.plan.createdBy,
				reportId: goal.plan.reportId,
			})),
			[goalHistoryDays],
		);
		await write(
			`INSERT INTO goal_progress (goal_id, user_email, day, value)
			 SELECT p."goalId"::uuid, p.email, CURRENT_DATE - p."daysAgo", p.value
			 FROM jsonb_to_recordset($1::jsonb)
			   AS p("goalId" text, email text, "daysAgo" int, value float8)
			 ON CONFLICT (goal_id, user_email, day) DO NOTHING`,
			progress,
		);

		await write(
			`INSERT INTO report_decks
			   (deck_id, report_id, kind, title, steps, prompt_once, record_field,
			    record_source, require_record, modified_by, modified_on, created_on)
			 SELECT d."deckId"::uuid, d."reportId"::uuid, d.kind, d.title, d.steps,
			        d."promptOnce", d."recordField", d."recordSource", d."requireRecord",
			        d.by, d."createdOn", d."createdOn"
			 FROM jsonb_to_recordset($1::jsonb) AS d(
			   "deckId" text, "reportId" text, kind text, title text, steps jsonb,
			   "promptOnce" boolean, "recordField" text, "recordSource" text,
			   "requireRecord" boolean, by text, "createdOn" timestamptz)`,
			decks.map((deck) => ({
				...deck.deck,
				deckId: deck.deckId,
				reportId: deck.reportId,
				by: deck.by,
				createdOn: new Date(
					now - deck.createdDaysAgo * dayMs,
				).toISOString(),
			})),
		);
		await write(
			`INSERT INTO deck_progress (deck_id, user_email, epoch, started_on, finished_on)
			 SELECT p."deckId"::uuid, p.email, 1, p."startedOn", p."finishedOn"
			 FROM jsonb_to_recordset($1::jsonb)
			   AS p("deckId" text, email text, "startedOn" timestamptz, "finishedOn" timestamptz)
			 ON CONFLICT (deck_id, user_email) DO NOTHING`,
			deckProgress,
		);

		await write(
			`INSERT INTO value_notes
			   (note_id, source_key, field, value, body, author_email, created_on, expires_on)
			 SELECT n."noteId"::uuid, n."sourceKey", n.field, n.value, n.body, n.author,
			        now() - make_interval(days => n."createdDaysAgo"),
			        CASE WHEN n."expiresInDays" IS NULL THEN NULL
			             ELSE now() + make_interval(days => n."expiresInDays") END
			 FROM jsonb_to_recordset($1::jsonb) AS n(
			   "noteId" text, "sourceKey" text, field text, value text, body text,
			   author text, "createdDaysAgo" int, "expiresInDays" int)`,
			valueNotes,
		);
		await write(
			`INSERT INTO value_note_replies (note_id, author_email, body, created_on)
			 SELECT r."noteId"::uuid, r.author, r.body, r."createdOn"
			 FROM jsonb_to_recordset($1::jsonb)
			   AS r("noteId" text, author text, body text, "createdOn" timestamptz)`,
			valueNotes.flatMap((note) =>
				note.replies.map((reply) => ({
					noteId: note.noteId,
					author: reply.author,
					body: reply.body,
					createdOn: new Date(
						Math.min(
							now - 60_000,
							now -
								note.createdDaysAgo * dayMs +
								reply.hoursAfter * hourMs,
						),
					).toISOString(),
				})),
			),
		);

		await write(
			`INSERT INTO visual_notes
			   (report_id, page_id, visual_id, author_email, body, anchored_on, created_on,
			    updated_on)
			 SELECT n."reportId"::uuid, n."pageId"::uuid, n."visualId"::uuid, n.author, n.body,
			        CASE WHEN n."anchoredDaysAgo" IS NULL THEN NULL
			             ELSE CURRENT_DATE - n."anchoredDaysAgo" END,
			        n."createdOn", n."createdOn"
			 FROM jsonb_to_recordset($1::jsonb) AS n(
			   "reportId" text, "pageId" text, "visualId" text, author text, body text,
			   "anchoredDaysAgo" int, "createdOn" timestamptz)`,
			visualNotes.map((note) => ({
				reportId: note.visual.reportId,
				pageId: note.visual.pageId,
				visualId: note.visual.visualId,
				author: note.author,
				body: note.body,
				anchoredDaysAgo: note.anchoredDaysAgo,
				createdOn: new Date(
					now - note.createdDaysAgo * dayMs,
				).toISOString(),
			})),
		);

		const threadMessages = threads.flatMap((thread) =>
			thread.messages.map((message) => ({
				threadId: thread.threadId,
				author: message.author,
				body: message.body,
				createdOn: new Date(
					Math.min(
						now - 60_000,
						now -
							thread.startedDaysAgo * dayMs +
							message.hoursAfter * hourMs,
					),
				).toISOString(),
			})),
		);
		const lastMessage = new Map<string, string>();
		for (const message of threadMessages)
			lastMessage.set(message.threadId, message.createdOn);
		await write(
			`INSERT INTO threads
			   (thread_id, subject, category_id, report_slug, created_by, created_on,
			    last_message_on)
			 SELECT t."threadId"::uuid, t.subject, t."categoryId", t."reportSlug", t.author,
			        t."createdOn", t."lastMessageOn"
			 FROM jsonb_to_recordset($1::jsonb) AS t(
			   "threadId" text, subject text, "categoryId" text, "reportSlug" text,
			   author text, "createdOn" timestamptz, "lastMessageOn" timestamptz)`,
			threads.map((thread) => ({
				threadId: thread.threadId,
				subject: thread.subject,
				categoryId: thread.categoryId,
				reportSlug: thread.reportSlug,
				author: thread.author,
				createdOn: new Date(
					now - thread.startedDaysAgo * dayMs,
				).toISOString(),
				lastMessageOn: lastMessage.get(thread.threadId),
			})),
		);
		await write(
			`INSERT INTO thread_members (thread_id, member_type, member_id)
			 SELECT m."threadId"::uuid, m.type, m.id
			 FROM jsonb_to_recordset($1::jsonb) AS m("threadId" text, type text, id text)
			 ON CONFLICT DO NOTHING`,
			threads.flatMap((thread) => [
				{ threadId: thread.threadId, type: "user", id: thread.author },
				...thread.recipients.map((member) => ({
					threadId: thread.threadId,
					...member,
				})),
			]),
		);
		await write(
			`INSERT INTO thread_messages (thread_id, author_email, body, created_on)
			 SELECT m."threadId"::uuid, m.author, m.body, m."createdOn"
			 FROM jsonb_to_recordset($1::jsonb)
			   AS m("threadId" text, author text, body text, "createdOn" timestamptz)`,
			threadMessages,
		);
		// Whoever wrote last has read everything up to their own message.
		await write(
			`INSERT INTO thread_reads (thread_id, user_email, read_on)
			 SELECT r."threadId"::uuid, r.email, r."readOn"
			 FROM jsonb_to_recordset($1::jsonb) AS r("threadId" text, email text, "readOn" timestamptz)
			 ON CONFLICT (thread_id, user_email) DO NOTHING`,
			threads.map((thread) => ({
				threadId: thread.threadId,
				email: thread.messages[thread.messages.length - 1].author,
				readOn: lastMessage.get(thread.threadId),
			})),
		);
	});

	// A reader may have asked while this was being written.
	dropHeld();
	console.log(`Demo scale content written in ${Date.now() - started} ms.`);
}
