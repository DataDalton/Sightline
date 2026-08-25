import type { VisualSpec } from "../visuals/VisualRenderer";
import type { Rect } from "../../lib/visuals/layout";

// A visual as the editor holds it: the stored definition plus its position on
// the canvas. Kept apart from VisualSpec because a reader never needs the
// layout, and the renderer should not be able to change it.
export interface EditableVisual extends VisualSpec {
	layout: Rect;
	// Set on a visual added in this session and not yet saved, so the save can
	// tell an insert from an update without asking the server.
	isNew?: boolean;
}

export function toVisualSpec(visual: EditableVisual): VisualSpec {
	return {
		visualId: visual.visualId,
		visualType: visual.visualType,
		title: visual.title,
		sourceKey: visual.sourceKey,
		config: visual.config,
	};
}
