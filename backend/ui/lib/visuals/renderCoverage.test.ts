import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { visualCatalog } from "./catalog";

// The picker's preview draws each visual at reading size, one case per type.
// A type with no case falls through to a dashed empty box, which looks like the
// preview failed to load rather than like a type nobody has drawn yet.
//
// This is the fourth list in this codebase that has to be kept in step with the
// catalogue: the card drawing, the category ordering, the behaviour, and now
// this. Every one of them silently dropped whatever was added last, so every
// one of them gets a test that names what is missing.
//
// Read from the source rather than imported, because the drawings are JSX in a
// client component and this suite compiles plain modules only. It is looking
// for a switch case per type, which is the shape the file is written in.
//
// Resolved against the working directory rather than the built file's own
// location, because the build flattens lib/ into a directory of its own and the
// path back out of it describes the build rather than the repository.
const sourcePath = resolve(process.cwd(), "app/editor/VisualRender.tsx");

function readSource(): string {
	try {
		return readFileSync(sourcePath, "utf8");
	} catch {
		throw new Error(
			`Could not read ${sourcePath}. Run the tests from backend/ui.`,
		);
	}
}

const source = readSource();

function drawnTypes(): Set<string> {
	const found = new Set<string>();
	const pattern = /case "([a-zA-Z]+)":/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source))) found.add(match[1]);
	return found;
}

test("every visual in the catalogue has a drawing", () => {
	const drawn = drawnTypes();
	const missing = visualCatalog
		.map((definition) => definition.type)
		.filter((type) => !drawn.has(type));

	assert.deepEqual(missing, [], "add a case for these to VisualRender.tsx");
});

// A drawing for a type that no longer exists is dead code rather than a bug,
// but it is dead code that looks alive, and the next person to widen the
// catalogue will read it as a working example.
test("no drawing is left over from a type that was removed", () => {
	const known = new Set(visualCatalog.map((definition) => definition.type));
	// Cases the file uses for its own branching rather than for a visual type.
	const notTypes = new Set<string>();
	const stale = [...drawnTypes()].filter(
		(type) => !known.has(type) && !notTypes.has(type),
	);

	assert.deepEqual(stale, [], "these types are no longer in the catalogue");
});
