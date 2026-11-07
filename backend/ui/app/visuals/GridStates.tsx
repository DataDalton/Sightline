"use client";

import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import type { GridState } from "../../lib/visuals/gridState";

// Each table's choices, held by the page around it so a reload, a link and a
// saved view can carry them. See lib/visuals/gridState.

type Update = (change: (current: GridState) => GridState) => void;

const GridStatesContext = createContext<{
	states: Record<string, GridState>;
	update: (
		visualId: string,
		change: (current: GridState) => GridState,
	) => void;
} | null>(null);

export function GridStatesProvider({
	states,
	update,
	children,
}: {
	states: Record<string, GridState>;
	update: (
		visualId: string,
		change: (current: GridState) => GridState,
	) => void;
	children: ReactNode;
}) {
	const value = useMemo(() => ({ states, update }), [states, update]);
	return (
		<GridStatesContext.Provider value={value}>
			{children}
		</GridStatesContext.Provider>
	);
}

const nothingChosen: GridState = {};

// A table's choices. Outside a report page, such as in the editor's preview,
// they are simply held by the table.
export function useGridState(
	visualId: string | null | undefined,
): [GridState, Update] {
	const shared = useContext(GridStatesContext);
	const [own, setOwn] = useState<GridState>(nothingChosen);
	const onPage = shared && visualId;

	const sharedUpdate = shared?.update;
	const update = useCallback<Update>(
		(change) => {
			if (sharedUpdate && visualId) sharedUpdate(visualId, change);
			else setOwn(change);
		},
		[sharedUpdate, visualId],
	);

	return [onPage ? (shared.states[visualId] ?? nothingChosen) : own, update];
}
