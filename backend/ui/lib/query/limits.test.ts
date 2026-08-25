import assert from "node:assert/strict";
import { test } from "node:test";
import { visualCatalog } from "../visuals/catalog";
import { maxDimensions, maxMeasures } from "./spec";

// The request guard and the catalogue describe different things: the guard
// caps what any one query may cost, the catalogue says what each visual type
// is for. They only work together if the guard sits above everything the
// catalogue allows. When it did not, a table authored inside its own stated
// limit was refused by the query layer, and the only symptom was an error on
// a page that had been fine to build.

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
