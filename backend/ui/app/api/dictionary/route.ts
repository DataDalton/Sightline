import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	dictionaryFields,
	fieldDefinition,
	fieldUsage,
	usageCounts,
	usageKey,
} from "@/lib/platform/dictionary";

// The field catalogue, and what depends on any one field.
//
// Two answers from one route because they are read together: the list is opened
// first and a field from it second, and a second endpoint for the second half
// would be the same access work done twice.
export async function GET(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	const params = request.nextUrl.searchParams;
	const sourceKey = params.get("sourceKey");
	const field = params.get("field");

	try {
		// One field, asked for by name: where it is used.
		if (sourceKey && field) {
			const policy = await resolvePolicyClass(identity);
			// The definition is read from the warehouse and can fail on its
			// own, which should not cost the reader the usage list beside it.
			const [usage, definition] = await Promise.all([
				fieldUsage(identity, policy, sourceKey, field),
				fieldDefinition(identity, sourceKey, field).catch((error) => {
					console.warn("Could not read a field definition:", error);
					return null;
				}),
			]);
			return NextResponse.json({ usage, definition });
		}

		// Counts alongside the list, so a field nothing references is visible
		// without opening every row to find out.
		const [fields, counts] = await Promise.all([
			dictionaryFields(identity),
			usageCounts(identity).catch(() => new Map<string, number>()),
		]);

		return NextResponse.json({
			fields: fields.map((f) => ({
				...f,
				uses: counts.get(usageKey(f.sourceKey, f.name)) ?? 0,
			})),
		});
	} catch (error) {
		console.error("Dictionary read failed:", error);
		return NextResponse.json(
			{ error: "Could not read the dictionary" },
			{ status: 500 },
		);
	}
}
