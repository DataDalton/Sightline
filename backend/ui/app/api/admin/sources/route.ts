import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { resolvePolicyClass } from "@/lib/auth/policy";
import { canDo } from "@/lib/platform/access";
import { ensureReadyOrDegrade } from "@/lib/platform/bootstrap";
import {
	deactivateSource,
	listCatalogs,
	listObjects,
	listSchemas,
	registerSource,
	RegistrationError,
	sourceKeyFor,
	updateSource,
	updateSourceFields,
} from "@/lib/semantic/discovery";
import { checkWriteRateLimit } from "@/lib/rateLimit";

// Browsing Unity Catalog, and registering what is found as a source.
//
// Everything the platform can build is built on a source, and until this
// existed a source could only be created by writing SQL against data_sources by
// hand. A fresh installation pointed at a catalogue full of tables had nothing
// to report on and no way in the application to change that.
//
// Browsing runs under the caller's own token, so an administrator sees what they
// can see. Registering grants nobody anything: which rows a reader gets still
// comes from Unity Catalog when the query runs.

async function guard(request: NextRequest) {
	await ensureReadyOrDegrade();

	const identity = getIdentity(request);
	if (!identity) {
		return {
			error: NextResponse.json(
				{ error: "Not authenticated" },
				{ status: 401 },
			),
		};
	}

	const policy = await resolvePolicyClass(identity);
	if (!(await canDo(policy, identity, "semantic.sync"))) {
		return {
			error: NextResponse.json({ error: "Not found" }, { status: 404 }),
		};
	}

	return { identity };
}

export async function GET(request: NextRequest) {
	const checked = await guard(request);
	if (checked.error) return checked.error;
	const identity = checked.identity;

	const params = request.nextUrl.searchParams;
	const catalog = params.get("catalog");
	const schema = params.get("schema");

	try {
		if (catalog && schema) {
			return NextResponse.json({
				objects: await listObjects(identity, catalog, schema),
			});
		}
		if (catalog) {
			return NextResponse.json({
				schemas: await listSchemas(identity, catalog),
			});
		}
		return NextResponse.json({ catalogs: await listCatalogs(identity) });
	} catch (error) {
		// A catalogue the caller cannot browse, or a warehouse that is not
		// answering. Named, because "no catalogues" and "could not ask" call
		// for different things.
		console.error("Catalogue browse failed:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Could not read the catalogue.",
			},
			{ status: 502 },
		);
	}
}

export async function POST(request: NextRequest) {
	const limited = checkWriteRateLimit(request);
	if (limited) return limited;

	const checked = await guard(request);
	if (checked.error) return checked.error;
	const identity = checked.identity;

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
	}

	const action = String(body.action ?? "register");

	try {
		if (action === "remove") {
			await deactivateSource(identity, String(body.sourceKey ?? ""));
			return NextResponse.json({ ok: true });
		}

		if (action === "update") {
			await updateSource(identity, String(body.sourceKey ?? ""), {
				title:
					body.title === undefined ? undefined : String(body.title),
				description:
					body.description === undefined
						? undefined
						: String(body.description ?? "").slice(0, 500) || null,
				defaultTimeField:
					body.defaultTimeField === undefined
						? undefined
						: String(body.defaultTimeField ?? "") || null,
				cacheTtlSeconds:
					body.cacheTtlSeconds === undefined
						? undefined
						: Number(body.cacheTtlSeconds) || 0,
			});
			return NextResponse.json({ ok: true });
		}

		if (action === "updateFields") {
			const edits = Array.isArray(body.fields)
				? (body.fields as Record<string, unknown>[]).map((field) => ({
						fieldName: String(field.fieldName ?? ""),
						displayName:
							field.displayName === undefined
								? undefined
								: String(field.displayName ?? "").slice(0, 120),
						description:
							field.description === undefined
								? undefined
								: String(field.description ?? "").slice(0, 500),
						formatHint:
							field.formatHint === undefined
								? undefined
								: String(field.formatHint ?? "").slice(0, 40),
					}))
				: [];
			const changed = await updateSourceFields(
				identity,
				String(body.sourceKey ?? ""),
				edits.filter((edit) => edit.fieldName),
			);
			return NextResponse.json({ ok: true, changed });
		}

		const catalog = String(body.catalog ?? "");
		const schema = String(body.schema ?? "");
		const object = String(body.object ?? "");

		return NextResponse.json(
			await registerSource(identity, {
				catalog,
				schema,
				object,
				kind: body.kind === "metric_view" ? "metric_view" : "table",
				title: String(body.title ?? object),
				description: body.description
					? String(body.description).slice(0, 500)
					: null,
				sourceKey: body.sourceKey
					? String(body.sourceKey)
					: sourceKeyFor(schema, object),
				hasRowFilter: body.hasRowFilter === true,
				cacheTtlSeconds: Number(body.cacheTtlSeconds) || undefined,
			}),
		);
	} catch (error) {
		if (error instanceof RegistrationError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error("Source registration failed:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Could not register that source.",
			},
			{ status: 500 },
		);
	}
}
