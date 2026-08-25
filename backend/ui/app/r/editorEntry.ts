"use client";

import dynamic from "next/dynamic";

// The editor, loaded when somebody edits.
//
// It is the largest thing in the reader's route and almost nobody there can
// use it: the panels, the canvas, the conditional formatting editor and the
// thumbnail catalogue together outweigh the report they are wrapped around,
// and a reader without edit rights can never open any of it. Imported directly
// it went into the same chunk as the report, so every reader paid to download
// and parse a screen they will not be shown.
//
// No server rendering, because it never appears on a first paint: reaching it
// takes a click on a control that only an editor is given.
export const ReportEditor = dynamic(
	() => import("../editor/ReportEditor").then((m) => m.ReportEditor),
	{ ssr: false },
);
