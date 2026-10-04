import type { Identity } from "../auth/identity";
import { resolvePolicyClass } from "../auth/policy";
import { sql, transaction } from "../data/lakebase";
import { reachableSet } from "../platform/sources";
import type { Row } from "../data/types";
import { toNumber } from "../format";
import {
	notifyInTransaction,
	pushNotification,
	type InboxItem,
	type NewNotification,
} from "../notify/store";
import { getReport } from "../platform/reports";
import { parseQuerySpec } from "../query/spec";
import { queryForVisual } from "../query/visualSpec";
import { getSource, listSources } from "../semantic/registry";
import { settings } from "../settings";
import { openingFilters } from "../visuals/pageDefaults";
import { nextRun, type Schedule } from "../alerts/schedule";
import { measureFormat, runsUnattended } from "../alerts/store";
import {
	recordingWindow,
	restrictableSources,
	restrictionFor,
} from "../alerts/recorded";
import { confirmableSources } from "../platform/sources";
import { BatchReads } from "../alerts/reads";
import {
	asApp,
	asOwner,
	confirmationRefresh,
	ownerThrottleMs,
	type RunQuery,
} from "../alerts/runner";
import type { RunIdentity } from "../alerts/shared";
import { hasOwnedChecks } from "../alerts/owners";
import { pageLink } from "./store";
import { perProcess } from "../perProcess";

// Works out and sends the pages people have scheduled.
//
// The same authority rules as alerts, for the same reasons. A person's token
// only exists while they use the app, so:
//
//   - A page whose figures come from a dataset that shows everybody the same
//     rows is worked out as the app on its schedule, while the owner has been
//     seen able to open the report within the last day.
//   - A page on a row-filtered dataset is worked out as the app narrowed to
//     what the owner was recorded seeing. See lib/alerts/recorded.
//   - Anything else is sent when the owner is next in the app, under their
//     own token, and the page says so.

const claimLease = "15 minutes";
const accessWindow = "24 hours";
const batchSize = 20;

interface DeliveryRow {
	delivery_id: string;
	owner_email: string;
	report_id: string;
	page_id: string;
	source_key: string | null;
	schedule: Schedule;
	state: { values?: Record<string, number | null> };
	last_run_on: string | null;
	next_run_on: string;
}

const deliveryColumns = `delivery_id::text, owner_email, report_id::text,
	page_id::text, source_key, schedule, state, last_run_on::text,
	next_run_on::text`;

interface PageRow {
	slug: string;
	report_title: string;
	page_title: string;
	is_first: boolean;
}

interface VisualRow {
	visual_id: string;
	visual_type: string;
	source_key: string | null;
	config: {
		dimensions?: string[];
		measures?: string[];
		filters?: unknown[];
		options?: Record<string, unknown>;
	};
}

export interface Figure {
	measure: string;
	value: number | null;
	text: string;
	change: number | null;
}

// The headline figures of one page, as it would show them on opening today.
// KPI tiles from the page's figure dataset only, so a restriction taken on
// that dataset covers every query made. Read through the batch, so people who
// scheduled the same page share its queries where their scope allows.
export async function pageFigures(
	pageId: string,
	sourceKey: string,
	reads: BatchReads,
	restricted: boolean,
	ownerEmail: string,
): Promise<Figure[]> {
	const source = getSource(sourceKey);
	if (!source) throw new Error("The dataset is no longer available.");

	const restriction = restricted
		? await restrictionFor(ownerEmail, sourceKey)
		: undefined;
	if (restriction === null) {
		throw new Error(
			"Waiting for you to open the app, to confirm what you can see.",
		);
	}

	const visuals = await sql<VisualRow>(
		`SELECT visual_id::text, visual_type, source_key, config
		 FROM report_visuals WHERE page_id = $1::uuid AND is_active
		 ORDER BY sort_order`,
		[pageId],
	);
	const pageFilters = Object.values(
		openingFilters(
			visuals.map((v) => ({
				visualId: v.visual_id,
				visualType: v.visual_type,
				config: v.config,
			})),
			new Date(),
		),
	).flat();

	const figures: Figure[] = [];
	for (const visual of visuals) {
		if (visual.visual_type !== "kpiRow") continue;
		if ((visual.source_key ?? sourceKey) !== sourceKey) continue;
		const measures = visual.config.measures ?? [];
		if (measures.length === 0) continue;

		const shape = queryForVisual("kpiRow", {
			sourceKey,
			dimensions: [],
			measures,
			filters: [...pageFilters, ...(visual.config.filters ?? [])],
		});
		if (!shape) continue;
		const rows: Row[] = await reads.read(
			source,
			parseQuerySpec(shape),
			restriction,
		);
		for (const measure of measures) {
			const value = toNumber(rows[0]?.[measure]);
			figures.push({
				measure,
				value,
				text: measureFormat(source, measure)(value),
				change: null,
			});
		}
	}
	return figures;
}

function describeChange(change: number | null): string {
	if (change === null || !Number.isFinite(change)) return "";
	const rounded = Math.round(change * 10) / 10;
	if (rounded === 0) return ", unchanged since last time";
	return `, ${rounded > 0 ? "up" : "down"} ${Math.abs(rounded)}% since last time`;
}

// Works out one delivery, sends it, and moves it to its next time. A failure
// is recorded on the delivery for its owner to see, and the schedule moves on
// so one bad day does not retry every minute.
async function deliver(
	row: DeliveryRow,
	reads: BatchReads,
	restricted: boolean,
	// The time to put back instead of moving the schedule, for a send the
	// owner asked for.
	keep: string | null = null,
): Promise<void> {
	let status = "ok";
	let error: string | null = null;
	let values = row.state.values ?? {};
	let message: { ownerEmail: string; input: NewNotification } | null = null;

	try {
		const [page] = await sql<PageRow>(
			`SELECT r.slug, r.title AS report_title, p.title AS page_title,
			        p.sort_order = (SELECT min(sort_order) FROM report_pages
			                        WHERE report_id = r.report_id AND is_active)
			          AS is_first
			 FROM report_pages p JOIN reports r ON r.report_id = p.report_id
			 WHERE p.page_id = $1::uuid AND p.is_active AND r.is_active`,
			[row.page_id],
		);
		if (!page) throw new Error("The page is no longer there.");
		if (!row.source_key) throw new Error("The page has no dataset.");

		const figures = await pageFigures(
			row.page_id,
			row.source_key,
			reads,
			restricted,
			row.owner_email,
		);
		for (const figure of figures) {
			const before = values[figure.measure];
			if (
				before !== undefined &&
				before !== null &&
				before !== 0 &&
				figure.value !== null
			) {
				figure.change =
					((figure.value - before) / Math.abs(before)) * 100;
			}
		}
		values = Object.fromEntries(figures.map((f) => [f.measure, f.value]));

		const title =
			page.page_title === page.report_title
				? page.report_title
				: `${page.report_title}: ${page.page_title}`;
		const body =
			figures.length > 0
				? figures
						.map(
							(f) =>
								`${f.measure} ${f.text}${describeChange(f.change)}`,
						)
						.join(". ") + "."
				: "Your scheduled page is ready.";

		message = {
			ownerEmail: row.owner_email,
			input: {
				kind: "delivery",
				title,
				body,
				link: pageLink(page.slug, page.page_title, page.is_first),
				data: { deliveryId: row.delivery_id },
			},
		};
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		status = error.startsWith("Waiting") ? "waiting" : "error";
		message = null;
	}

	// Saved together with the inbox entry, and only while the row still holds
	// the run this one started from. Two runs of the same delivery at once
	// then send once, and a process that stops part way leaves neither the
	// run nor the entry, so the delivery is taken again after the lease and
	// sent once.
	const nextOn = keep ?? nextRun(row.schedule, new Date()).toISOString();
	let item: InboxItem | null = null;
	try {
		item = await transaction(async (client) => {
			const saved = await client.query(
				`UPDATE deliveries SET
				   state = $2, last_run_on = now(), last_status = $3,
				   last_error = $4, next_run_on = $5
				 WHERE delivery_id = $1::uuid
				   AND last_run_on IS NOT DISTINCT FROM $6::timestamptz
				 RETURNING delivery_id`,
				[
					row.delivery_id,
					JSON.stringify({ values }),
					status,
					error ? error.slice(0, 500) : null,
					nextOn,
					row.last_run_on,
				],
			);
			if (saved.rowCount === 0 || !message) return null;
			return notifyInTransaction(
				client,
				message.ownerEmail,
				message.input,
			);
		});
	} catch (e) {
		// Nothing was saved, so a scheduled delivery stays claimed until the
		// lease ends and is tried again then. A send the owner asked for puts
		// back the time it was due. The failure is shown on it meanwhile.
		const failure = e instanceof Error ? e.message : String(e);
		await sql(
			`UPDATE deliveries SET last_status = 'error', last_error = $2,
			   next_run_on = coalesce($3::timestamptz, next_run_on)
			 WHERE delivery_id = $1::uuid
			   AND last_run_on IS NOT DISTINCT FROM $4::timestamptz`,
			[row.delivery_id, failure.slice(0, 500), keep, row.last_run_on],
		);
		return;
	}

	// Pushed only once the entry is committed, so a device is never told of
	// an entry that rolled back.
	if (item && message) pushNotification(message.ownerEmail, item);
}

async function runAll(
	rows: DeliveryRow[],
	run: RunQuery,
	identity: RunIdentity,
	restricted: (row: DeliveryRow) => boolean = () => false,
): Promise<void> {
	// One set of reads for the batch, so two people who scheduled the same
	// page share its figure queries.
	const reads = new BatchReads(identity, run);
	const queue = [...rows];
	const workers = Array.from({ length: 3 }, async () => {
		for (let row = queue.shift(); row; row = queue.shift()) {
			await deliver(row, reads, restricted(row)).catch((error) => {
				console.warn(`Delivery ${row.delivery_id} failed:`, error);
			});
		}
	});
	await Promise.all(workers);
}

// --- On the timer ----------------------------------------------------------

let running = false;

export async function runScheduledDeliveries(): Promise<void> {
	if (!settings().alertsEnabled || running) return;
	running = true;
	try {
		const unattended = listSources()
			.filter((s) => runsUnattended(s))
			.map((s) => s.sourceKey);
		const restrictable = [...(await restrictableSources()).keys()];
		if (unattended.length === 0 && restrictable.length === 0) return;

		// Claimed in one statement, so two replicas ticking at once take
		// different deliveries rather than both sending the same one.
		const rows = await sql<DeliveryRow>(
			`UPDATE deliveries SET next_run_on = now() + interval '${claimLease}'
			 WHERE delivery_id IN (
			   SELECT d.delivery_id FROM deliveries d
			   WHERE d.enabled
			     AND d.next_run_on <= now()
			     AND d.access_confirmed_on > now() - interval '${accessWindow}'
			     AND (
			       d.source_key = ANY($1::text[])
			       OR (
			         d.source_key = ANY($3::text[])
			         AND EXISTS (
			           SELECT 1 FROM alert_access a
			           WHERE a.owner_email = d.owner_email
			             AND a.source_key = d.source_key
			             AND NOT a.too_many
			             AND a.captured_on > now() - interval '${recordingWindow}'
			         )
			       )
			     )
			   ORDER BY d.next_run_on
			   LIMIT $2
			   FOR UPDATE SKIP LOCKED
			 )
			 RETURNING ${deliveryColumns}`,
			[unattended, batchSize, restrictable],
		);
		const open = new Set(unattended);
		if (rows.length > 0) {
			await runAll(
				rows,
				asApp,
				{ app: true },
				(row) => !open.has(row.source_key ?? ""),
			);
		}
	} finally {
		running = false;
	}
}

// --- While the owner is here -----------------------------------------------

// Held back like the alert pass. See ownerThrottleMs in lib/alerts/runner.
const lastOwnerRun = perProcess(
	"deliveries/runner:lastOwnerRun",
	() => new Map<string, number>(),
);

// Called from a request the owner made. Confirms which of their scheduled
// reports they can still open, which is what lets those run while they are
// away, and sends any that are due under their own token.
export function runDeliveriesForOwner(identity: Identity): void {
	if (!settings().alertsEnabled) return;
	const email = identity.email.toLowerCase();
	const now = Date.now();
	if (now - (lastOwnerRun.get(email) ?? 0) < ownerThrottleMs) return;
	// Kept in the order each pass ran, so the passes old enough to run again
	// are at the front and are dropped from there.
	lastOwnerRun.delete(email);
	lastOwnerRun.set(email, now);
	for (const [held, ranAt] of lastOwnerRun) {
		if (now - ranAt < ownerThrottleMs) break;
		lastOwnerRun.delete(held);
	}

	const run = asOwner(identity);
	if (!run) return;

	void (async () => {
		if (!(await hasOwnedChecks(email))) return;
		const mine = await sql<{
			delivery_id: string;
			slug: string;
			source_key: string | null;
			recent: boolean;
		}>(
			`SELECT d.delivery_id::text, r.slug, d.source_key,
			        coalesce(d.access_confirmed_on
			                   > now() - interval '${confirmationRefresh}', false)
			          AS recent
			 FROM deliveries d
			 JOIN reports r ON r.report_id = d.report_id AND r.is_active
			 WHERE d.owner_email = $1 AND d.enabled`,
			[email],
		);
		if (mine.length === 0) return;

		// Opening the report is not enough on its own. The figures are worked
		// out later as the app, so the owner has to be able to read the source
		// they come from as well.
		//
		// One confirmed recently stands as it is. It is neither checked nor
		// written again until it is old enough to need renewing.
		const confirmed: string[] = [];
		const renewed: string[] = [];
		const stale = mine.filter((d) => {
			if (d.recent && d.source_key) confirmed.push(d.delivery_id);
			return !d.recent;
		});
		if (stale.length > 0) {
			const readable = await confirmableSources(identity);
			const policy = await resolvePolicyClass(identity);
			for (const { delivery_id, slug, source_key } of stale) {
				if (!source_key) continue;
				if (readable && !readable.has(source_key)) continue;
				if (await getReport(policy, identity, slug)) {
					renewed.push(delivery_id);
				}
			}
		}
		if (renewed.length > 0) {
			await sql(
				`UPDATE deliveries SET access_confirmed_on = now()
				 WHERE delivery_id::text = ANY($1::text[])`,
				[renewed],
			);
			confirmed.push(...renewed);
		}
		if (confirmed.length === 0) return;

		const rows = await sql<DeliveryRow>(
			`UPDATE deliveries SET next_run_on = now() + interval '${claimLease}'
			 WHERE delivery_id IN (
			   SELECT delivery_id FROM deliveries
			   WHERE delivery_id::text = ANY($1::text[])
			     AND next_run_on <= now()
			   ORDER BY next_run_on
			   LIMIT $2
			   FOR UPDATE SKIP LOCKED
			 )
			 RETURNING ${deliveryColumns}`,
			[confirmed, batchSize],
		);
		if (rows.length > 0) {
			await runAll(rows, run, { app: false, ownerEmail: email });
		}
	})().catch((error) => {
		console.warn(`Deliveries for ${email} could not be sent:`, error);
	});
}

// "Send it now", from the owner's own list: under their own token, without
// moving the schedule.
export async function sendNow(identity: Identity, id: string): Promise<void> {
	const run = asOwner(identity);
	if (!run) throw new Error("A user token is required to send this now.");
	const email = identity.email.toLowerCase();
	const found = await sql<{ source_key: string | null }>(
		`SELECT source_key FROM deliveries
		 WHERE delivery_id::text = $1 AND owner_email = $2`,
		[id, email],
	);
	if (!found[0]) throw new Error("Not found");
	const reachable = await reachableSet(identity);
	const sourceKey = found[0].source_key;
	if (reachable && (!sourceKey || !reachable.has(sourceKey))) {
		throw new Error("That dataset is not one you can read.");
	}

	// Claimed as the timer claims, so the timer does not send the same page
	// while this one is worked out. The time it was due is put back after.
	const row = await transaction(async (client) => {
		const held = await client.query<DeliveryRow>(
			`SELECT ${deliveryColumns} FROM deliveries
			 WHERE delivery_id::text = $1 AND owner_email = $2
			 FOR UPDATE`,
			[id, email],
		);
		const claimed = held.rows[0];
		if (!claimed) return null;
		await client.query(
			`UPDATE deliveries
			 SET next_run_on = now() + interval '${claimLease}'
			 WHERE delivery_id::text = $1`,
			[id],
		);
		return claimed;
	});
	if (!row) throw new Error("Not found");
	const reads = new BatchReads({ app: false, ownerEmail: email }, run);
	await deliver(row, reads, false, row.next_run_on);
}
