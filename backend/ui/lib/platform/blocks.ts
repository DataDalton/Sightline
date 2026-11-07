import { randomUUID } from "node:crypto";
import { insertLog } from "../activityLog";
import type { Identity } from "../auth/identity";
import type { PolicyClass } from "../auth/policy";
import { sql, transaction } from "../data/lakebase";
import {
	blockRefOf,
	planBlockUpdate,
	visualsToBlock,
	withoutBlockRef,
	type BlockVisual,
} from "../visuals/blocks";
import { can, getExplicitContext } from "./access";
import { invalidateReport } from "./curated";
import { assertDefinitionsAreDrawable } from "./editing";
import { writeVersion } from "./versionWrite";

// Sets of visuals saved once and placed in many reports. See lib/visuals/blocks.
//
// Updating a block writes its new definition onto every placed visual straight away,
// as a new version of each report, so history says what happened and everything that
// reads a report needs to know nothing about blocks.

export class BlockError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export interface Block {
	blockId: string;
	name: string;
	description: string | null;
	visuals: BlockVisual[];
	createdBy: string;
	modifiedOn: string;
	usedIn: number;
	canChange: boolean;
}

export interface BlockInputVisual {
	visualType: string;
	title: string | null;
	sourceKey?: string | null;
	config: Record<string, unknown>;
	layout: { x: number; y: number; w: number; h: number };
}

interface BlockRow {
	block_id: string;
	name: string;
	description: string | null;
	visuals: BlockVisual[];
	created_by: string;
	modified_on: string;
	used_in: string;
}

// Anybody who edits reports somewhere can build one.
async function assertCanBuild(
	policy: PolicyClass,
	email: string,
): Promise<void> {
	const context = await getExplicitContext(policy, email);
	const builds =
		(context.capabilities.get("report.edit")?.size ?? 0) > 0 ||
		(context.capabilities.get("report.create")?.size ?? 0) > 0;
	if (!builds || context.denied.get("report.edit")?.has("*")) {
		throw new BlockError(
			"You do not have permission to build blocks.",
			403,
		);
	}
}

async function mayChange(
	policy: PolicyClass,
	email: string,
	createdBy: string,
): Promise<boolean> {
	if (createdBy.toLowerCase() === email.toLowerCase()) return true;
	const context = await getExplicitContext(policy, email);
	return can(context.capabilities, "block.manage", null, context.denied);
}

export async function listBlocks(
	policy: PolicyClass,
	identity: Identity,
): Promise<Block[]> {
	await assertCanBuild(policy, identity.email);
	const rows = await sql<BlockRow>(
		`SELECT b.block_id::text AS block_id, b.name, b.description, b.visuals,
		        b.created_by, b.modified_on,
		        (SELECT count(DISTINCT p.report_id)
		         FROM report_visuals v
		         JOIN report_pages p ON p.page_id = v.page_id
		         WHERE v.is_active = TRUE
		           AND v.config->'blockRef'->>'blockId' = b.block_id::text
		        )::text AS used_in
		 FROM blocks b
		 WHERE b.is_active = TRUE
		 ORDER BY b.name`,
	);
	const context = await getExplicitContext(policy, identity.email);
	const manages = can(
		context.capabilities,
		"block.manage",
		null,
		context.denied,
	);
	const email = identity.email.toLowerCase();
	return rows.map((row) => ({
		blockId: row.block_id,
		name: row.name,
		description: row.description,
		visuals: row.visuals,
		createdBy: row.created_by,
		modifiedOn: row.modified_on,
		usedIn: Number(row.used_in),
		canChange: manages || row.created_by.toLowerCase() === email,
	}));
}

function cleanVisuals(visuals: unknown): BlockInputVisual[] {
	if (!Array.isArray(visuals) || visuals.length === 0) {
		throw new BlockError("Select at least one visual first.");
	}
	return visuals as BlockInputVisual[];
}

async function assertDrawable(visuals: BlockInputVisual[]): Promise<void> {
	await assertDefinitionsAreDrawable(
		visuals.map((visual) => ({
			type: "addVisual" as const,
			pageId: "",
			visualType: visual.visualType,
			title: visual.title ?? undefined,
			sourceKey: visual.sourceKey ?? null,
			config: visual.config,
		})) as never,
	);
}

export async function createBlock(
	policy: PolicyClass,
	identity: Identity,
	input: { name: unknown; description?: unknown; visuals: unknown },
): Promise<Block> {
	await assertCanBuild(policy, identity.email);
	const name = String(input.name ?? "").trim();
	if (!name) throw new BlockError("A block needs a name.");
	const visuals = cleanVisuals(input.visuals);
	await assertDrawable(visuals);

	const stored = visualsToBlock(visuals, randomUUID);
	const rows = await sql<{ block_id: string; modified_on: string }>(
		`INSERT INTO blocks (name, description, visuals, created_by)
		 VALUES ($1, $2, $3::jsonb, $4)
		 RETURNING block_id::text AS block_id, modified_on`,
		[
			name.slice(0, 120),
			input.description ? String(input.description).slice(0, 500) : null,
			JSON.stringify(stored),
			identity.email,
		],
	);
	await insertLog({
		recordType: "block",
		recordId: rows[0].block_id,
		action: "create_block",
		changedBy: identity.email,
		newValue: name,
	});
	return {
		blockId: rows[0].block_id,
		name,
		description: null,
		visuals: stored,
		createdBy: identity.email,
		modifiedOn: rows[0].modified_on,
		usedIn: 0,
		canChange: true,
	};
}

// A report whose lock says nothing may change keeps what it has, and is named in the
// answer, because a lock stops everyone until somebody with the key lifts it.
export async function updateBlock(
	policy: PolicyClass,
	identity: Identity,
	blockId: string,
	input: { name?: unknown; visuals: unknown },
): Promise<{
	visuals: BlockVisual[];
	updated: string[];
	lockedOut: string[];
}> {
	const found = await sql<{ created_by: string; name: string }>(
		`SELECT created_by, name FROM blocks
		 WHERE block_id = $1 AND is_active = TRUE`,
		[blockId],
	);
	if (!found[0]) throw new BlockError("Not found", 404);
	if (!(await mayChange(policy, identity.email, found[0].created_by))) {
		throw new BlockError(
			"Only whoever built this block or an administrator can change it.",
			403,
		);
	}
	const incoming = cleanVisuals(input.visuals);
	await assertDrawable(incoming);

	// A visual that already came from this block keeps its key, so what is placed
	// elsewhere is updated rather than removed and added again.
	const fresh = visualsToBlock(incoming, randomUUID);
	const visuals = fresh.map((visual, index) => {
		const ref = blockRefOf(incoming[index].config);
		return ref?.blockId === blockId ? { ...visual, key: ref.key } : visual;
	});

	const name = input.name ? String(input.name).trim().slice(0, 120) : null;
	const updated: string[] = [];
	const lockedOut: string[] = [];
	const touched: { reportId: string; slug: string }[] = [];

	await transaction(async (client) => {
		await client.query(
			`UPDATE blocks
			 SET visuals = $2::jsonb, name = COALESCE($3, name), modified_by = $4,
			     modified_on = now()
			 WHERE block_id = $1`,
			[blockId, JSON.stringify(visuals), name, identity.email],
		);

		const placed = await client.query<{
			visual_id: string;
			page_id: string;
			config: unknown;
			report_id: string;
			protected: boolean;
		}>(
			`SELECT v.visual_id::text AS visual_id, v.page_id::text AS page_id,
			        v.config, p.report_id::text AS report_id,
			        (r.protect_edit OR p.protect_edit) AS protected
			 FROM report_visuals v
			 JOIN report_pages p ON p.page_id = v.page_id
			 JOIN reports r ON r.report_id = p.report_id
			 WHERE v.is_active = TRUE AND r.is_active = TRUE
			   AND v.config->'blockRef'->>'blockId' = $1`,
			[blockId],
		);

		const byReport = new Map<string, typeof placed.rows>();
		for (const row of placed.rows) {
			byReport.set(row.report_id, [
				...(byReport.get(row.report_id) ?? []),
				row,
			]);
		}

		for (const [reportId, rows] of byReport) {
			const open = rows.filter((row) => !row.protected);
			const header = await client.query<{
				version: string;
				slug: string;
				title: string;
				is_personal: boolean;
			}>(
				`SELECT version, slug, title, is_personal FROM reports
				 WHERE report_id = $1 FOR UPDATE`,
				[reportId],
			);
			const report = header.rows[0];
			if (open.length < rows.length) lockedOut.push(report.title);
			if (open.length === 0) continue;

			const plan = planBlockUpdate(
				blockId,
				visuals,
				open.map((row) => ({
					visualId: row.visual_id,
					pageId: row.page_id,
					config: row.config,
				})),
			);
			for (const { visualId, visual, ref } of plan.updates) {
				await client.query(
					`UPDATE report_visuals
					 SET visual_type = $2, title = $3, source_key = $4, config = $5::jsonb
					 WHERE visual_id = $1`,
					[
						visualId,
						visual.visualType,
						visual.title,
						visual.sourceKey,
						JSON.stringify({ ...visual.config, blockRef: ref }),
					],
				);
			}
			for (const visualId of plan.removes) {
				await client.query(
					`UPDATE report_visuals SET is_active = FALSE WHERE visual_id = $1`,
					[visualId],
				);
			}
			for (const { pageId, visual, ref, layout } of plan.inserts) {
				await client.query(
					`INSERT INTO report_visuals
					   (page_id, visual_type, title, source_key, config,
					    layout_x, layout_y, layout_w, layout_h, sort_order)
					 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,
					         (SELECT COALESCE(max(sort_order), 0) + 1
					          FROM report_visuals WHERE page_id = $1))`,
					[
						pageId,
						visual.visualType,
						visual.title,
						visual.sourceKey,
						JSON.stringify({ ...visual.config, blockRef: ref }),
						layout.x,
						layout.y,
						layout.w,
						layout.h,
					],
				);
			}

			const version = Number(report.version) + 1;
			await client.query(
				`UPDATE reports
				 SET version = $2, modified_by = $3, modified_on = now()
				 WHERE report_id = $1`,
				[reportId, version, identity.email],
			);
			if (!report.is_personal) {
				const snapshot = await client.query(
					`SELECT v.visual_id, v.page_id, v.visual_type, v.title,
					        v.source_key, v.config, v.layout_x, v.layout_y,
					        v.layout_w, v.layout_h, v.sort_order, v.is_active
					 FROM report_visuals v
					 JOIN report_pages p ON p.page_id = v.page_id
					 WHERE p.report_id = $1`,
					[reportId],
				);
				const pages = await client.query(
					`SELECT page_id, slug, title, source_key, config, sort_order,
					        is_active
					 FROM report_pages WHERE report_id = $1`,
					[reportId],
				);
				const about = await client.query(
					`SELECT title, description, theme FROM reports
					 WHERE report_id = $1`,
					[reportId],
				);
				await writeVersion(client, {
					reportId,
					version,
					label: `Block "${name ?? found[0].name}" updated`,
					snapshot: {
						visuals: snapshot.rows,
						pages: pages.rows,
						report: about.rows[0] ?? null,
					},
					createdBy: identity.email,
				});
			}
			updated.push(report.title);
			touched.push({ reportId, slug: report.slug });
		}
	});

	for (const { reportId, slug } of touched) {
		invalidateReport(reportId, [slug]);
	}
	await insertLog({
		recordType: "block",
		recordId: blockId,
		action: "update_block",
		changedBy: identity.email,
		newValue: JSON.stringify({ updated, lockedOut }),
	});
	return { visuals, updated, lockedOut };
}

// What is placed stays where it is and stops following, so removing a block never
// takes anything off a page.
export async function removeBlock(
	policy: PolicyClass,
	identity: Identity,
	blockId: string,
): Promise<void> {
	const found = await sql<{ created_by: string }>(
		`SELECT created_by FROM blocks WHERE block_id = $1 AND is_active = TRUE`,
		[blockId],
	);
	if (!found[0]) throw new BlockError("Not found", 404);
	if (!(await mayChange(policy, identity.email, found[0].created_by))) {
		throw new BlockError(
			"Only whoever built this block or an administrator can remove it.",
			403,
		);
	}
	const touched = await transaction(async (client) => {
		await client.query(
			`UPDATE blocks SET is_active = FALSE WHERE block_id = $1`,
			[blockId],
		);
		const placed = await client.query<{
			visual_id: string;
			config: Record<string, unknown>;
			report_id: string;
		}>(
			`SELECT v.visual_id::text AS visual_id, v.config,
			        p.report_id::text AS report_id
			 FROM report_visuals v
			 JOIN report_pages p ON p.page_id = v.page_id
			 WHERE v.config->'blockRef'->>'blockId' = $1`,
			[blockId],
		);
		for (const row of placed.rows) {
			await client.query(
				`UPDATE report_visuals SET config = $2::jsonb WHERE visual_id = $1`,
				[row.visual_id, JSON.stringify(withoutBlockRef(row.config))],
			);
		}
		return [...new Set(placed.rows.map((row) => row.report_id))];
	});
	for (const reportId of touched) invalidateReport(reportId, []);
	await insertLog({
		recordType: "block",
		recordId: blockId,
		action: "remove_block",
		changedBy: identity.email,
	});
}
