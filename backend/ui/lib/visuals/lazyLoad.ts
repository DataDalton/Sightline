// Where a visual's distance from the screen is measured from.
//
// A report scrolls inside the shell's content column rather than the document,
// so an observer on the viewport sees a visual below the fold as clipped by
// that column and never as nearly visible. Only the scrolling element itself
// can say a visual is one screen away. Kept free of the DOM so the rule can be
// tested with plain objects.

// How far outside the scroll root a visual counts as near, as a CSS margin.
// A full screen above and below, so a visual has its data by the time a
// reader scrolls it into view.
export const nearMargin = "100% 0px 100% 0px";

// Whether a box is within one screen of the area it scrolls through, the
// same reach nearMargin gives the observer. Measured once as a frame mounts,
// so a visual already in view loads before the page is first painted rather
// than showing its placeholder until the observer first reports.
export function withinReach(
	box: { top: number; bottom: number },
	view: { top: number; bottom: number },
): boolean {
	const height = view.bottom - view.top;
	return box.bottom >= view.top - height && box.top <= view.bottom + height;
}

export interface ScrollNode {
	parentElement: ScrollNode | null;
	scrollHeight: number;
	clientHeight: number;
}

export interface ScrollStyle {
	overflowY: string;
	position: string;
}

const scrolling = new Set(["auto", "scroll", "overlay"]);

// The outermost ancestor that scrolls vertically and has something to scroll,
// or null to measure against the viewport.
//
// The outermost rather than the nearest, because that is the one a reader
// moves through a report with. A scroller nested inside it, such as a group
// with more in it than fits, still clips what it holds, so a visual inside an
// off screen group waits for the page to reach it rather than counting as
// near because the group is. An ancestor that could scroll but holds less
// than its own height clips nothing and is passed over. A fixed ancestor ends
// the search, because a fixed element is placed against the viewport and a
// scroller further up does not clip it. So does the document's own body,
// whose scrolling is the viewport's.
export function scrollRootFor<T extends ScrollNode>(
	element: T,
	styleOf: (node: T) => ScrollStyle,
	isDocument: (node: T) => boolean = () => false,
): T | null {
	if (styleOf(element).position === "fixed") return null;
	let found: T | null = null;
	for (
		let node = element.parentElement as T | null;
		node && !isDocument(node);
		node = node.parentElement as T | null
	) {
		const style = styleOf(node);
		if (
			scrolling.has(style.overflowY) &&
			node.scrollHeight > node.clientHeight
		) {
			found = node;
		}
		if (style.position === "fixed") break;
	}
	return found;
}
