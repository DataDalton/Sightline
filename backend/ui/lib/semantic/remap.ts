import { sql } from "../data/lakebase";
import { applyFieldChange } from "../upkeep/fieldChange";

// Pointing everything that names a missing field at its new name, in one step,
// once an administrator confirms the rename.
//
// The rewrite itself is lib/upkeep/fieldChange, which the assistant uses for the
// renames and removals it carries out on its own. This adds the checks a person
// confirming a rename by hand needs: both names exist, the old one is gone, and
// the two are the same kind of field.

export class RemapError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

export interface RemapResult {
	sourceKey: string;
	from: string;
	to: string;
	// Items rewritten, by kind.
	changed: Record<string, number>;
	// Reports given a new version.
	reports: string[];
}

interface FieldRow {
	field_name: string;
	field_kind: string;
	status: string;
}

export async function remapField(
	email: string,
	sourceKey: string,
	from: string,
	to: string,
): Promise<RemapResult> {
	if (!sourceKey || !from || !to) {
		throw new RemapError(
			"Name the dataset, the old field and the new one.",
		);
	}
	if (from === to) throw new RemapError("The two names are the same.");

	const rows = await sql<FieldRow>(
		`SELECT field_name, field_kind, status FROM source_fields
		 WHERE source_key = $1 AND field_name = ANY($2::text[])`,
		[sourceKey, [from, to]],
	);
	const old = rows.find((r) => r.field_name === from);
	const next = rows.find((r) => r.field_name === to);
	if (!old)
		throw new RemapError(`${from} is not a field of this dataset.`, 404);
	if (!next)
		throw new RemapError(`${to} is not a field of this dataset.`, 404);
	if (old.status !== "missing") {
		throw new RemapError(
			`${from} is still published by the dataset, so nothing needs remapping.`,
		);
	}
	if (next.status !== "active") {
		throw new RemapError(`${to} is not published by the dataset either.`);
	}
	// A measure grouped by, or a dimension summed, would change what every
	// query built on it means.
	if (old.field_kind !== next.field_kind) {
		throw new RemapError(
			`${from} is a ${old.field_kind} and ${to} is a ${next.field_kind}. Only a field of the same kind can take its place.`,
		);
	}

	const result = await applyFieldChange({
		sourceKey,
		field: from,
		to,
		actor: email,
		reason: `Field ${from} renamed to ${to}`,
	});
	return {
		sourceKey,
		from,
		to,
		changed: result.changed,
		reports: result.reports.map((report) => report.reportId),
	};
}
