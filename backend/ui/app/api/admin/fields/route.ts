import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { canDo } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import { sql } from "@/lib/data/lakebase";
import {
	collectDependents,
	type DependentKind,
} from "@/lib/platform/dependents";
import { getSource } from "@/lib/semantic/registry";

// Fields sources stopped publishing, with what still names each one and the
// rename the sync offered for it, for the administration page.
//
// A total under the sync button said something had gone and nothing about
// what, or whether anything used it. This is the list somebody acts on: which
// field, how many items break without it, and one button when it was renamed.

interface MissingRow {
	source_key: string;
	source_title: string;
	field_name: string;
	field_kind: string;
	missing_since: string | null;
	renamed_to: string | null;
	rename_candidate: string | null;
	rename_confidence: number | null;
	announced_on: string | null;
}

export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const policy = await resolvePolicyClass(identity);
	if (!(await canDo(policy, identity, "semantic.sync"))) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	try {
		const rows = await sql<MissingRow>(
			`SELECT f.source_key, d.title AS source_title, f.field_name,
			        f.field_kind, f.missing_since::text AS missing_since,
			        f.renamed_to, f.rename_candidate, f.rename_confidence,
			        f.announced_on::text AS announced_on
			 FROM source_fields f
			 JOIN data_sources d ON d.source_key = f.source_key
			 WHERE f.status = 'missing' AND f.is_active AND d.is_active
			 ORDER BY d.title, f.field_name`,
		);

		const keys = [...new Set(rows.map((r) => r.source_key))];
		const dependents = await collectDependents(keys, [
			...new Set(rows.map((r) => r.field_name)),
		]);

		// Items per field and kind, each item counted once.
		const counted = new Map<string, Map<DependentKind, Set<string>>>();
		for (const d of dependents) {
			const key = `${d.sourceKey}\u0000${d.field}`;
			const byKind = counted.get(key) ?? new Map();
			const ids = byKind.get(d.kind) ?? new Set<string>();
			ids.add(d.id);
			byKind.set(d.kind, ids);
			counted.set(key, byKind);
		}

		const sources = new Map<
			string,
			{
				sourceKey: string;
				title: string;
				fields: unknown[];
			}
		>();
		for (const row of rows) {
			const byKind =
				counted.get(`${row.source_key}\u0000${row.field_name}`) ??
				new Map<DependentKind, Set<string>>();
			const uses: Partial<Record<DependentKind, number>> = {};
			let total = 0;
			for (const [kind, ids] of byKind) {
				uses[kind] = ids.size;
				total += ids.size;
			}
			// A field already remapped with nothing left naming it is done.
			if (row.renamed_to && total === 0) continue;

			// Fields of the same kind the source still publishes, for a remap
			// to a name the sync did not guess.
			const source = getSource(row.source_key);
			const choices = (
				row.field_kind === "measure"
					? (source?.measures ?? [])
					: (source?.dimensions ?? [])
			).map((f) => f.name);

			const held = sources.get(row.source_key) ?? {
				sourceKey: row.source_key,
				title: row.source_title,
				fields: [],
			};
			held.fields.push({
				name: row.field_name,
				kind: row.field_kind,
				missingSince: row.missing_since,
				renamedTo: row.renamed_to,
				candidate: row.rename_candidate,
				confidence:
					row.rename_confidence === null
						? null
						: Number(row.rename_confidence),
				announced: row.announced_on !== null,
				dependents: total,
				uses,
				choices,
			});
			sources.set(row.source_key, held);
		}

		const response = NextResponse.json({ sources: [...sources.values()] });
		response.headers.set("Cache-Control", "no-store");
		return response;
	} catch (error) {
		console.error("Could not list missing fields:", error);
		return NextResponse.json(
			{ error: "Could not list missing fields." },
			{ status: 500 },
		);
	}
}
