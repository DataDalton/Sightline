// Creates reports, pages, visuals and sources from a manifest.
//
// A reporting platform needs a way to make things in bulk. Clicking forty
// reports into existence is not a migration path, and neither is a script that
// understands one organisation's planning documents. So this reads a manifest
// written in the platform's own vocabulary: sources, categories, reports,
// pages, visuals. Anything that knows a different shape converts to this and
// calls in, which keeps the writing in one place.
//
// Idempotent by default. A report whose slug already exists is left alone,
// because by the time an import is re-run somebody has usually edited the
// thing it would overwrite. Pass --replace when overwriting is the intent.
//
// Usage:
//   node scripts/import.mjs manifest.json
//   node scripts/import.mjs manifest.json --dry-run
//   node scripts/import.mjs manifest.json --replace
//
// See examples/manifest.example.json for the shape, and README.md for what
// each field means.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "./connect.mjs";
import { visualByType, checkEncoding } from "./catalog.mjs";

const gridColumns = 12;

// --- Identity ---------------------------------------------------------------

// A visual needs the same id every time the same manifest is imported, or a
// second run would insert duplicates rather than recognising what it wrote
// last time. Derived from where the visual sits rather than from its content,
// so editing a title does not orphan the row it belongs to.
function stableId(...parts) {
	const digest = createHash("sha1").update(parts.join("\u0000")).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	// Marked as a name-based UUID so it is obvious this was derived rather
	// than drawn at random.
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

// --- Validation -------------------------------------------------------------

// Everything wrong with the manifest, not just the first thing. An import that
// reports one error per run turns a forty report migration into forty runs.
function validate(manifest) {
	const errors = [];
	const at = (path, message) => errors.push(`${path}: ${message}`);

	if (!manifest || typeof manifest !== "object") {
		return ["manifest: expected an object"];
	}

	const sourceKeys = new Set();
	(manifest.sources ?? []).forEach((source, i) => {
		const path = `sources[${i}]`;
		if (!source.key) at(path, "key is required");
		if (!source.catalog || !source.schema || !source.object) {
			at(path, "catalog, schema and object are required");
		}
		if (source.kind && !["metric_view", "table"].includes(source.kind)) {
			at(path, `kind must be metric_view or table, got "${source.kind}"`);
		}
		// A table has no semantic layer, so each field has to say how it is
		// computed. A metric view resolves its own, and an expression here
		// would be a second definition free to drift from the first.
		if (source.kind === "table") {
			for (const field of source.measures ?? []) {
				if (!field.sqlExpr) {
					at(
						`${path}.measures`,
						`"${field.name}" needs sqlExpr: a table has no semantic layer to resolve it`,
					);
				}
			}
		}
		if (source.key) sourceKeys.add(source.key);
	});

	const categoryIds = new Set(
		(manifest.categories ?? []).map((c) => c.id).filter(Boolean),
	);

	const slugs = new Set();
	(manifest.reports ?? []).forEach((report, i) => {
		const path = `reports[${i}]`;
		if (!report.slug) at(path, "slug is required");
		if (!report.title) at(path, "title is required");
		if (report.slug && slugs.has(report.slug)) {
			at(path, `slug "${report.slug}" is used more than once`);
		}
		if (report.slug) slugs.add(report.slug);

		if (report.categoryId && !categoryIds.has(report.categoryId)) {
			at(path, `categoryId "${report.categoryId}" is not in categories`);
		}
		if (report.sourceKey && sourceKeys.size > 0 && !sourceKeys.has(report.sourceKey)) {
			at(path, `sourceKey "${report.sourceKey}" is not in sources`);
		}

		(report.pages ?? []).forEach((page, p) => {
			const pagePath = `${path}.pages[${p}]`;
			if (!page.title) at(pagePath, "title is required");

			(page.visuals ?? []).forEach((visual, v) => {
				const visualPath = `${pagePath}.visuals[${v}]`;
				const definition = visualByType[visual.type];
				if (!definition) {
					at(
						visualPath,
						`unknown visual type "${visual.type}". The catalogue has: ${Object.keys(visualByType).sort().join(", ")}`,
					);
					return;
				}
				// The same check the editor makes, so a manifest cannot create
				// something the editor would refuse to save.
				const problem = checkEncoding(
					visual.type,
					visual.dimensions ?? [],
					visual.measures ?? [],
				);
				if (problem) at(visualPath, problem.message);
			});
		});
	});

	return errors;
}

// --- Layout -----------------------------------------------------------------

// A position for every visual that did not state one.
//
// Footprints come from the visual catalogue rather than from a copy kept here,
// which is what stopped the previous importer from drifting: its private table
// still listed two types that no longer exist. Visuals flow left to right and
// wrap, so a manifest that says nothing about layout still opens as a page
// somebody arranged rather than a pile at the origin.
function layoutFor(visuals) {
	let x = 0;
	let y = 0;
	let rowHeight = 0;

	return visuals.map((visual) => {
		if (visual.layout) return visual.layout;

		const footprint = visualByType[visual.type]?.defaultLayout ?? {
			w: 6,
			h: 4,
		};

		if (x + footprint.w > gridColumns) {
			x = 0;
			y += rowHeight;
			rowHeight = 0;
		}

		const rect = { x, y, w: footprint.w, h: footprint.h };
		x += footprint.w;
		rowHeight = Math.max(rowHeight, footprint.h);
		return rect;
	});
}

// --- Formatting -------------------------------------------------------------

// How a value should be rendered, when the manifest does not say.
//
// Guessed from the name, which is all an unannotated field offers. Wrong
// guesses are corrected in the app; the alternative is every number rendering
// as a bare decimal until somebody fixes each one by hand.
function formatHintFor(name, kind) {
	const n = String(name).toLowerCase();
	if (n.endsWith(" pct") || n.includes("percent") || n.includes(" rate")) {
		return "percent";
	}
	if (
		/(amount|revenue|sales|price|cost|margin|due|paid|freight|exposure|spend)/.test(
			n,
		)
	) {
		return "currency";
	}
	if (n.includes("count") || n.includes("units") || n.includes("quantity")) {
		return "integer";
	}
	if (kind === "dimension" && /(date|month|year|quarter|day|start|end)/.test(n)) {
		return "date";
	}
	return kind === "measure" ? "decimal" : "text";
}

// --- Import -----------------------------------------------------------------

export async function importManifest(manifest, options = {}) {
	const { dryRun = false, replace = false, owner = null, log = console.log } =
		options;

	const errors = validate(manifest);
	if (errors.length > 0) {
		const error = new Error(
			`The manifest has ${errors.length} problem${errors.length === 1 ? "" : "s"}:\n  ` +
				errors.join("\n  "),
		);
		error.validationErrors = errors;
		throw error;
	}

	const ownerEmail = owner ?? process.env.PGUSER ?? "import";
	const client = await connect();
	const counts = {
		sources: 0,
		fields: 0,
		categories: 0,
		reports: 0,
		pages: 0,
		visuals: 0,
		skipped: [],
	};

	try {
		if (!dryRun) await client.query("BEGIN");

		// --- Sources -------------------------------------------------------
		for (const source of manifest.sources ?? []) {
			const kind = source.kind ?? "metric_view";
			counts.sources++;

			if (!dryRun) {
				await client.query(
					`INSERT INTO data_sources
					   (source_key, title, description, catalog_name, schema_name,
					    object_name, kind, access_mode, has_row_filter,
					    cache_ttl_seconds, default_time_field, is_active)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,'direct',$8,$9,$10,TRUE)
					 ON CONFLICT (source_key) DO UPDATE SET
					   title = EXCLUDED.title,
					   description = EXCLUDED.description,
					   catalog_name = EXCLUDED.catalog_name,
					   schema_name = EXCLUDED.schema_name,
					   object_name = EXCLUDED.object_name,
					   kind = EXCLUDED.kind,
					   has_row_filter = EXCLUDED.has_row_filter,
					   default_time_field = EXCLUDED.default_time_field,
					   modified_on = now()`,
					[
						source.key,
						source.title ?? source.key,
						source.description ?? null,
						source.catalog,
						source.schema,
						source.object,
						kind,
						// Filtered unless the manifest says otherwise. A source
						// wrongly marked unfiltered has its results shared
						// across policy classes, so the safe reading is the
						// default and the claim has to be made explicitly.
						source.hasRowFilter !== false,
						source.cacheTtlSeconds ?? 300,
						source.defaultTimeField ?? null,
					],
				);
			}

			let order = 0;
			for (const [kindName, list] of [
				["dimension", source.dimensions ?? []],
				["measure", source.measures ?? []],
			]) {
				for (const field of list) {
					counts.fields++;
					if (dryRun) continue;
					await client.query(
						`INSERT INTO source_fields
						   (source_key, field_name, display_name, field_kind,
						    sql_expr, data_type, description, format_hint, sort_order)
						 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
						 ON CONFLICT (source_key, field_name) DO UPDATE SET
						   display_name = EXCLUDED.display_name,
						   field_kind = EXCLUDED.field_kind,
						   sql_expr = EXCLUDED.sql_expr,
						   description = COALESCE(source_fields.description, EXCLUDED.description),
						   modified_on = now()`,
						[
							source.key,
							field.name,
							field.displayName ?? null,
							kindName,
							// A metric view resolves its own expressions.
							kind === "metric_view" ? null : (field.sqlExpr ?? null),
							field.dataType ?? null,
							field.description ?? null,
							field.formatHint ?? formatHintFor(field.name, kindName),
							order++,
						],
					);
				}
			}
		}

		// --- Categories ----------------------------------------------------
		for (const category of manifest.categories ?? []) {
			counts.categories++;
			if (dryRun) continue;
			await client.query(
				`INSERT INTO categories (category_id, name, description, icon, sort_order, is_active)
				 VALUES ($1,$2,$3,$4,$5,TRUE)
				 ON CONFLICT (category_id) DO UPDATE SET
				   name = EXCLUDED.name,
				   description = EXCLUDED.description,
				   icon = EXCLUDED.icon,
				   sort_order = EXCLUDED.sort_order`,
				[
					category.id,
					category.name ?? category.id,
					category.description ?? null,
					category.icon ?? category.id,
					category.sortOrder ?? 0,
				],
			);
		}

		// --- Reports -------------------------------------------------------
		for (const report of manifest.reports ?? []) {
			const existing = await client.query(
				`SELECT report_id FROM reports WHERE slug = $1`,
				[report.slug],
			);

			// Somebody has usually edited what an overwrite would destroy, so
			// the default is to leave it and say so.
			if (existing.rows.length > 0 && !replace) {
				counts.skipped.push(report.slug);
				continue;
			}

			const reportId = existing.rows[0]?.report_id ?? randomUUID();
			counts.reports++;

			if (!dryRun) {
				await client.query(
					`INSERT INTO reports
					   (report_id, category_id, slug, title, description, source_key,
					    owner_email, visibility, is_active)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
					 ON CONFLICT (report_id) DO UPDATE SET
					   category_id = EXCLUDED.category_id,
					   title = EXCLUDED.title,
					   description = EXCLUDED.description,
					   source_key = EXCLUDED.source_key,
					   visibility = EXCLUDED.visibility,
					   is_active = TRUE,
					   modified_on = now()`,
					[
						reportId,
						report.categoryId ?? null,
						report.slug,
						report.title,
						report.description ?? null,
						report.sourceKey ?? null,
						report.owner ?? ownerEmail,
						report.visibility ?? "published",
					],
				);
			}

			const keptPages = [];
			(report.pages ?? []).forEach((page, pageIndex) => {
				keptPages.push(stableId(report.slug, page.slug ?? String(pageIndex)));
			});

			for (const [pageIndex, page] of (report.pages ?? []).entries()) {
				const pageId = keptPages[pageIndex];
				const pageSlug = page.slug ?? `page-${pageIndex + 1}`;
				counts.pages++;

				if (!dryRun) {
					await client.query(
						`INSERT INTO report_pages
						   (page_id, report_id, slug, title, source_key, config,
						    sort_order, is_active)
						 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,TRUE)
						 ON CONFLICT (page_id) DO UPDATE SET
						   slug = EXCLUDED.slug,
						   title = EXCLUDED.title,
						   source_key = EXCLUDED.source_key,
						   config = EXCLUDED.config,
						   sort_order = EXCLUDED.sort_order,
						   is_active = TRUE`,
						[
							pageId,
							reportId,
							pageSlug,
							page.title,
							page.sourceKey ?? report.sourceKey ?? null,
							JSON.stringify(page.config ?? {}),
							pageIndex,
						],
					);
				}

				const visuals = page.visuals ?? [];
				const rects = layoutFor(visuals);
				const keptVisuals = [];

				for (const [i, visual] of visuals.entries()) {
					const visualId = stableId(report.slug, pageSlug, String(i));
					keptVisuals.push(visualId);
					counts.visuals++;
					if (dryRun) continue;

					await client.query(
						`INSERT INTO report_visuals
						   (visual_id, page_id, visual_type, title, source_key, config,
						    layout_x, layout_y, layout_w, layout_h, sort_order, is_active)
						 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,TRUE)
						 ON CONFLICT (visual_id) DO UPDATE SET
						   visual_type = EXCLUDED.visual_type,
						   title = EXCLUDED.title,
						   source_key = EXCLUDED.source_key,
						   config = EXCLUDED.config,
						   layout_x = EXCLUDED.layout_x,
						   layout_y = EXCLUDED.layout_y,
						   layout_w = EXCLUDED.layout_w,
						   layout_h = EXCLUDED.layout_h,
						   sort_order = EXCLUDED.sort_order,
						   is_active = TRUE`,
						[
							visualId,
							pageId,
							visual.type,
							visual.title ?? null,
							visual.sourceKey ?? page.sourceKey ?? report.sourceKey ?? null,
							JSON.stringify({
								dimensions: visual.dimensions ?? [],
								measures: visual.measures ?? [],
								filters: visual.filters ?? [],
								sort: visual.sort ?? [],
								options: visual.options ?? {},
								...(visual.style ? { style: visual.style } : {}),
							}),
							rects[i].x,
							rects[i].y,
							rects[i].w,
							rects[i].h,
							i,
						],
					);
				}

				// A visual removed from the manifest goes away on a replace.
				// Deactivated rather than deleted, so a restore can bring it
				// back and its history stays readable.
				if (!dryRun && replace) {
					await client.query(
						`UPDATE report_visuals SET is_active = FALSE
						 WHERE page_id = $1 AND NOT (visual_id = ANY($2::uuid[]))`,
						[pageId, keptVisuals],
					);
				}
			}

			if (!dryRun && replace) {
				await client.query(
					`UPDATE report_pages SET is_active = FALSE
					 WHERE report_id = $1 AND NOT (page_id = ANY($2::uuid[]))`,
					[reportId, keptPages],
				);
			}
		}

		if (!dryRun) await client.query("COMMIT");
	} catch (error) {
		if (!dryRun) await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		await client.end();
	}

	log(
		`${dryRun ? "would import" : "imported"}: ` +
			`${counts.sources} sources, ${counts.fields} fields, ` +
			`${counts.categories} categories, ${counts.reports} reports, ` +
			`${counts.pages} pages, ${counts.visuals} visuals`,
	);
	if (counts.skipped.length > 0) {
		log(
			`left alone (already exist, pass --replace to overwrite): ` +
				counts.skipped.join(", "),
		);
	}

	return counts;
}

// --- Command line -----------------------------------------------------------

// Only when run directly, so the local converters can import the function
// without triggering a second import of their own.
const invokedDirectly =
	process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (invokedDirectly) {
	const args = process.argv.slice(2);
	const file = args.find((a) => !a.startsWith("--"));

	if (!file) {
		console.error(
			"Usage: node scripts/import.mjs <manifest.json> [--dry-run] [--replace]",
		);
		process.exit(1);
	}

	try {
		await importManifest(JSON.parse(readFileSync(file, "utf-8")), {
			dryRun: args.includes("--dry-run"),
			replace: args.includes("--replace"),
		});
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
