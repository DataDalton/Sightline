"use client";

import { createContext, useContext } from "react";

// Which visual, if any, a reader has opened to fill the screen.
//
// A context rather than a prop, because the button that asks for it sits in the
// visual's own header and the thing that can honour it is the page: the frame
// has no idea how big the window is or what else is on it, and threading a
// callback down through the grid, the group boxes and the renderer would mean
// every one of them carrying something none of them use.
//
// Absent by default. A visual drawn outside a page, in the editor canvas or in
// a version comparison, has nothing to expand into, and the button is simply
// not offered there rather than being offered and doing nothing.

export interface ExpandState {
	expandedId: string | null;
	setExpandedId: (visualId: string | null) => void;
}

export const ExpandContext = createContext<ExpandState | null>(null);

export function useExpand(): ExpandState | null {
	return useContext(ExpandContext);
}
