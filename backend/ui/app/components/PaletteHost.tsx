"use client";

import { CommandPalette } from "./CommandPalette";
import { useShell } from "../context/ShellContext";

// Holds the palette open state at the shell level.
//
// The layout is a server component and cannot read the shell context itself,
// so this sits between them. It renders nothing until the palette is opened,
// which is also what keeps the search request off every page load.
export default function PaletteHost() {
	const { paletteOpen, closePalette } = useShell();
	return <CommandPalette open={paletteOpen} onClose={closePalette} />;
}
