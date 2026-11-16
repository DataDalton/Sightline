import { sql } from "../data/lakebase";
import { notify, safeLink } from "../notify/store";
import { maintainersFor } from "../platform/dependents";
import { tellWatchers } from "../updates/links";
import { assistantActor } from "./actor";

// Telling people about what the assistant changed.
//
// Only an action that changed something tells anybody, and each person hears
// once per action however many reports it touched. Who hears:
//
//   The owners and maintainers of each report changed, by name, since the
//   reports are theirs.
//   Whoever watches the update the change was made because of.
//   Whoever follows the changes the assistant makes, for everything, a
//   category, a source, or only reports they own or have starred.
//
// Only owners and maintainers are told which reports. Everybody else is told
// how many and sent to the update, which lists only the reports each reader can
// open.

export interface ChangedReport {
	reportId: string;
}

interface ReportFacts {
	report_id: string;
	slug: string;
	title: string;
	category_id: string | null;
	owner_email: string | null;
}

export async function tellAboutChanges(input: {
	updateId: string | null;
	sourceKey: string | null;
	// What the change was, such as "Region renamed to Sales Region".
	what: string;
	reportIds: string[];
}): Promise<void> {
	const reportIds = [...new Set(input.reportIds)];
	if (reportIds.length === 0) return;
	const reports = await sql<ReportFacts>(
		`SELECT report_id::text, slug, title, category_id, owner_email
		 FROM reports WHERE report_id = ANY($1::uuid[])`,
		[reportIds],
	);
	if (reports.length === 0) return;
	const updateLink = input.updateId
		? safeLink(`/status?tab=updates&open=${input.updateId}`)
		: null;
	const told = new Set<string>([assistantActor.toLowerCase()]);

	// Owners and maintainers, each with the reports that are theirs.
	const theirs = new Map<string, ReportFacts[]>();
	const add = (email: string | null, report: ReportFacts) => {
		if (!email) return;
		const key = email.toLowerCase();
		const held = theirs.get(key) ?? [];
		if (!held.includes(report)) held.push(report);
		theirs.set(key, held);
	};
	const byCategory = new Map<string, ReportFacts[]>();
	for (const report of reports) {
		add(report.owner_email, report);
		if (report.category_id) {
			const held = byCategory.get(report.category_id) ?? [];
			held.push(report);
			byCategory.set(report.category_id, held);
		}
	}
	for (const [categoryId, held] of byCategory) {
		for (const person of await maintainersFor([categoryId])) {
			for (const report of held) add(person, report);
		}
	}
	for (const [person, held] of theirs) {
		if (told.has(person)) continue;
		told.add(person);
		const names = held.map((report) => report.title);
		await notify(person, {
			kind: "schema",
			title:
				held.length === 1
					? `${names[0]} was changed by the assistant`
					: `${held.length} of your reports were changed by the assistant`,
			body: `${input.what}. Changed: ${names.join(", ")}.`,
			link: updateLink ?? safeLink(`/r/${held[0].slug}`),
			data: { updateId: input.updateId },
		}).catch((error) => {
			console.warn("A report owner was not told about a change:", error);
		});
	}

	const count = `${reports.length} report${reports.length === 1 ? "" : "s"}`;
	if (input.updateId) {
		for (const person of await tellWatchers(
			input.updateId,
			assistantActor,
			`The assistant changed ${count}`,
			`${input.what}. See the update for what changed.`,
		)) {
			told.add(person);
		}
	}

	// Followers of the assistant's changes, by the scope each one chose.
	const follows = await sql<{
		user_email: string;
		value: string;
		mode: string;
	}>(
		`SELECT user_email, value, mode FROM update_follows WHERE kind = 'changes'`,
	);
	if (follows.length === 0) return;
	const categories = new Set(
		reports.map((report) => report.category_id).filter(Boolean),
	);
	const starred = await sql<{ user_email: string }>(
		`SELECT DISTINCT lower(user_email) AS user_email FROM favourites
		 WHERE report_id = ANY($1::uuid[])`,
		[reportIds],
	);
	const mine = new Set([
		...reports
			.map((report) => report.owner_email?.toLowerCase())
			.filter(Boolean),
		...starred.map((row) => row.user_email),
	]);
	for (const follow of follows) {
		const person = follow.user_email.toLowerCase();
		if (told.has(person)) continue;
		const value = follow.value ?? "";
		const matches =
			value === "" ||
			(value.startsWith("category:") && categories.has(value.slice(9))) ||
			(value.startsWith("source:") &&
				value.slice(7) === input.sourceKey) ||
			(value === "mine" && mine.has(person));
		if (!matches) continue;
		told.add(person);
		if (follow.mode === "digest" && input.updateId) {
			await sql(
				`INSERT INTO update_digest_queue (update_id, user_email)
				 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
				[input.updateId, person],
			);
			continue;
		}
		await notify(person, {
			kind: "schema",
			title: `The assistant changed ${count}`,
			body: `${input.what}.`,
			link: updateLink,
			data: { updateId: input.updateId },
		}).catch((error) => {
			console.warn("A follower was not told about a change:", error);
		});
	}
}

// The owner of an alert or goal the assistant turned off, told directly, since
// these belong to one person and are not shown on the update.
export async function tellItemOwners(
	items: { kind: string; id: string; name: string }[],
	what: string,
): Promise<void> {
	for (const item of items) {
		const owner =
			item.kind === "alert"
				? await sql<{ owner_email: string }>(
						`SELECT owner_email FROM alert_rules WHERE rule_id::text = $1`,
						[item.id],
					)
				: item.kind === "goal"
					? await sql<{ owner_email: string }>(
							`SELECT owner_email FROM goals WHERE goal_id::text = $1`,
							[item.id],
						)
					: item.kind === "pageAlert"
						? await sql<{ owner_email: string }>(
								`SELECT created_by AS owner_email FROM page_alerts WHERE alert_id::text = $1`,
								[item.id],
							)
						: [];
		const email = owner[0]?.owner_email;
		if (!email) continue;
		await notify(email, {
			kind: "schema",
			title: `${item.kind === "goal" ? "Goal" : "Alert"} "${item.name}" was turned off`,
			body: `${what}, and it had nothing left to measure.`,
			link: item.kind === "goal" ? null : safeLink("/alerts"),
		}).catch(() => {});
	}
}
