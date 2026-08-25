import assert from "node:assert/strict";
import { test } from "node:test";
import { visualCatalog } from "../visuals/catalog";
import { maxDimensions, maxMeasures } from "./spec";

// The request guard and the catalogue describe different things: the guard
// caps what any one query may cost, the catalogue says what each visual type
// is for. They only work together if the guard sits above everything the
// catalogue allows. A guard below it refuses a visual the editor accepted, and
// the only symptom is an error on a page that saved without complaint.

test("the request guard is above every encoding the catalogue permits", () => {
	const widestDimensions = Math.max(
		...visualCatalog.map((v) => v.encoding.dimensions.max),
	);
	const widestMeasures = Math.max(
		...visualCatalog.map((v) => v.encoding.measures.max),
	);

	assert.ok(
		maxDimensions >= widestDimensions,
		`maxDimensions ${maxDimensions} is below the catalogue's ${widestDimensions}`,
	);
	assert.ok(
		maxMeasures >= widestMeasures,
		`maxMeasures ${maxMeasures} is below the catalogue's ${widestMeasures}`,
	);
});
