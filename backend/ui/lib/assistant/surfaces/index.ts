import type { SemanticSource } from "../../semantic/types";
import { alertSurface } from "./alert";
import { boardSurface } from "./board";
import { editorSurface } from "./editor";
import { exploreSurface } from "./explore";
import { formulaSurface } from "./formula";
import { sheetSurface } from "./sheet";
import {
	asRecord,
	surfaceKinds,
	type Surface,
	type SurfaceKind,
} from "./shared";

export type { Surface, SurfaceKind } from "./shared";

// The screen a question was asked from, as the request names it, or null for
// a question asked with no screen to fill in. The state is whatever the page
// sent, and each screen reads it as untrusted input.
export function buildSurface(
	raw: unknown,
	available: SemanticSource[],
): Surface | null {
	const r = asRecord(raw);
	const kind = r.kind as SurfaceKind;
	if (!surfaceKinds.includes(kind)) return null;
	switch (kind) {
		case "alert":
			return alertSurface(r.state, available);
		case "formula":
			return formulaSurface(r.state);
		case "sheet":
			return sheetSurface(r.state, available);
		case "explore":
			return exploreSurface(r.state, available);
		case "editor":
			return editorSurface(r.state, available);
		case "board":
			return boardSurface(r.state, available);
	}
}
