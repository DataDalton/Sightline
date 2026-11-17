import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { listBoards } from "../boards/store";
import { listSheets } from "../sheets/store";
import { readableUpdates } from "../updates/store";
import { actorOf, loadConfig } from "../work/access";
import { listItems } from "../work/store";
import { readableSourceList } from "./sources";
import type { SearchTarget } from "./search";

// Things a person works with besides reports, for the palette: requests by key
// or title, updates, datasets, sheets and boards.
//
// Read fresh on each opening rather than cached with the reports, because
// requests and updates change through the day and a palette that cannot find
// the request filed this morning is the one people stop trusting. Every list
// comes through the function that already decides what this person may see,
// so nothing is offered that would then refuse to open.

// Enough to find any recent request or update by name without sending the
// whole history to the browser.
const requestLimit = 500;
const updateLimit = 200;

export async function contentTargets(
	identity: Identity,
	policy: PolicyClass,
): Promise<SearchTarget[]> {
	// Each list on its own, so one that fails leaves the others in the
	// palette rather than emptying it.
	const settle = async (
		read: () => Promise<SearchTarget[]>,
		what: string,
	): Promise<SearchTarget[]> => {
		try {
			return await read();
		} catch (error) {
			console.warn(`Search could not list ${what}:`, error);
			return [];
		}
	};
	const lists = await Promise.all([
		settle(() => requestTargets(identity, policy), "requests"),
		settle(() => updateTargets(identity, policy), "updates"),
		settle(() => datasetTargets(identity), "datasets"),
		settle(() => sheetTargets(identity), "sheets"),
		settle(() => boardTargets(identity), "boards"),
	]);
	return lists.flat();
}

async function requestTargets(
	identity: Identity,
	policy: PolicyClass,
): Promise<SearchTarget[]> {
	const actor = await actorOf(policy, identity);
	if (!actor.mayRequest && !actor.engineer) return [];
	const [items, config] = await Promise.all([
		listItems(actor, { includeClosed: true, limit: requestLimit }),
		loadConfig(),
	]);
	const columns = new Map(config.columns.map((c) => [c.id, c.label]));
	return items.map((item) => ({
		id: `request:${item.key}`,
		kind: "request" as const,
		title: item.title,
		context: `${item.key}, ${
			item.closedAs === "duplicate"
				? "Duplicate"
				: item.closedAs
					? "Declined"
					: (columns.get(item.status) ?? item.status)
		}`,
		href: `/work/${encodeURIComponent(item.key)}`,
		keywords: `${item.key} ${(item.tags ?? []).join(" ")}`,
	}));
}

async function updateTargets(
	identity: Identity,
	policy: PolicyClass,
): Promise<SearchTarget[]> {
	const updates = await readableUpdates(policy, identity);
	return (
		[...updates]
			// Newest first, read as times since the store may hand back a date or
			// its text.
			.sort(
				(a, b) =>
					new Date(b.postedOn).getTime() -
					new Date(a.postedOn).getTime(),
			)
			.slice(0, updateLimit)
			.map((update) => ({
				id: `update:${update.updateId}`,
				kind: "update" as const,
				title: update.title,
				context: `Posted ${new Date(update.postedOn).toLocaleDateString(
					"en-US",
					{ month: "short", day: "numeric", year: "numeric" },
				)}`,
				href: `/status?tab=updates&open=${encodeURIComponent(update.updateId)}`,
				keywords: `${update.type} ${(update.tags ?? []).join(" ")}`,
			}))
	);
}

async function datasetTargets(identity: Identity): Promise<SearchTarget[]> {
	const sources = await readableSourceList(identity);
	return sources.map((source) => ({
		id: `dataset:${source.sourceKey}`,
		kind: "dataset" as const,
		title: source.title,
		context: "Dictionary",
		href: `/dictionary?source=${encodeURIComponent(source.sourceKey)}`,
		keywords: `${source.description ?? ""} ${source.sourceKey}`,
	}));
}

async function sheetTargets(identity: Identity): Promise<SearchTarget[]> {
	const sheets = await listSheets(identity);
	return sheets.map((sheet) => ({
		id: `sheet:${sheet.id}`,
		kind: "sheet" as const,
		title: sheet.title,
		context:
			sheet.ownerEmail.toLowerCase() === identity.email.toLowerCase()
				? "Yours"
				: `Shared by ${sheet.ownerEmail}`,
		href: `/sheets/${encodeURIComponent(sheet.id)}`,
		keywords: `sheet ${sheet.sourceKey}`,
	}));
}

async function boardTargets(identity: Identity): Promise<SearchTarget[]> {
	const boards = await listBoards(identity);
	return boards.map((board) => ({
		id: `board:${board.id}`,
		kind: "board" as const,
		title: board.title,
		context:
			board.ownerEmail.toLowerCase() === identity.email.toLowerCase()
				? "Yours"
				: `Shared by ${board.ownerEmail}`,
		href: `/boards/${encodeURIComponent(board.id)}`,
		keywords: "board",
	}));
}
