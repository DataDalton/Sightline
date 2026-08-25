"use client";

import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
	type ReactNode,
} from "react";

// Shared page state: filters, cross-filtering and drill position.
//
// Three things travel together because they all answer "what is this page
// currently showing", and a visual has to combine all three to build its
// query. Keeping them in one place means a visual asks once rather than
// reconciling three sources.

export interface FilterClause {
	field: string;
	op: string;
	value?: string;
	values?: string[];
}

// A selection made by clicking inside a visual. Attributed to the visual that
// produced it so the same visual can show what is selected without filtering
// itself down to the single point that was clicked.
export interface CrossFilter {
	sourceVisualId: string;
	clauses: FilterClause[];
	// Human-readable, for the chip that lets a reader see and clear it.
	label: string;
	// Whether the visual that made the selection narrows to it as well.
	//
	// Clicking one bar and dragging across a range are different requests.
	// A click says "show me everything else about this one", so the clicked
	// chart keeps its context and the rest of the page filters. A drag says
	// "this part, closer", so the chart that was dragged on narrows too.
	zoomSource?: boolean;
}

// Where a visual currently sits in its drill hierarchy. Each entry is a value
// that was clicked to descend.
export interface DrillStep {
	field: string;
	value: string;
}

interface PageState {
	setWidgetFilter: (widgetId: string, clauses: FilterClause[]) => void;
	clearWidget: (widgetId: string) => void;
	byWidget: Record<string, FilterClause[]>;

	crossFilter: CrossFilter | null;
	setCrossFilter: (next: CrossFilter | null) => void;

	// The dimension a page's switcher is currently set to. Visuals configured
	// with the "<selected>" placeholder resolve it to this, which is how one
	// control repoints several visuals at once.
	selectedDimension: string | null;
	setSelectedDimension: (field: string | null) => void;

	// The time grain a page's period switcher is set to. Kept apart from the
	// breakdown so a page can carry both controls without one clearing the
	// other. Visuals configured with "<grain>" resolve it to this.
	selectedGrain: string | null;
	setSelectedGrain: (field: string | null) => void;

	drillByVisual: Record<string, DrillStep[]>;
	drillDown: (visualId: string, step: DrillStep) => void;
	drillUp: (visualId: string, toDepth?: number) => void;

	clearAll: () => void;
	activeClauses: FilterClause[];
	// Everything a given visual should apply. Excludes that visual's own cross
	// filter, and includes its own drill path.
	clausesFor: (visualId: string) => FilterClause[];
	// Clauses from every widget except the one asking, so a dropdown can offer
	// values narrowed by the other filters without narrowing by itself.
	clausesExcept: (widgetId: string) => FilterClause[];
	hasAnything: boolean;
}

const PageFilterContext = createContext<PageState>({
	setWidgetFilter: () => {},
	clearWidget: () => {},
	byWidget: {},
	crossFilter: null,
	setCrossFilter: () => {},
	selectedDimension: null,
	setSelectedDimension: () => {},
	selectedGrain: null,
	setSelectedGrain: () => {},
	drillByVisual: {},
	drillDown: () => {},
	drillUp: () => {},
	clearAll: () => {},
	activeClauses: [],
	clausesFor: () => [],
	clausesExcept: () => [],
	hasAnything: false,
});

export function PageFilterProvider({ children }: { children: ReactNode }) {
	const [byWidget, setByWidget] = useState<Record<string, FilterClause[]>>({});
	const [crossFilter, setCrossFilterState] = useState<CrossFilter | null>(null);
	const [drillByVisual, setDrillByVisual] = useState<
		Record<string, DrillStep[]>
	>({});
	const [selectedDimension, setSelectedDimension] = useState<string | null>(
		null,
	);
	const [selectedGrain, setSelectedGrain] = useState<string | null>(null);

	const setWidgetFilter = useCallback(
		(widgetId: string, clauses: FilterClause[]) => {
			setByWidget((prev) => {
				// An empty contribution is removed rather than stored, so the
				// active list never carries no-op entries into a cache key.
				if (clauses.length === 0) {
					if (!(widgetId in prev)) return prev;
					const next = { ...prev };
					delete next[widgetId];
					return next;
				}
				return { ...prev, [widgetId]: clauses };
			});
		},
		[],
	);

	const clearWidget = useCallback((widgetId: string) => {
		setByWidget((prev) => {
			if (!(widgetId in prev)) return prev;
			const next = { ...prev };
			delete next[widgetId];
			return next;
		});
	}, []);

	// Clicking the same point again clears the selection, which is what makes
	// cross-filtering feel like a toggle rather than a mode to escape from.
	const setCrossFilter = useCallback((next: CrossFilter | null) => {
		setCrossFilterState((prev) => {
			if (!next) return null;
			if (
				prev &&
				prev.sourceVisualId === next.sourceVisualId &&
				prev.label === next.label
			) {
				return null;
			}
			return next;
		});
	}, []);

	const drillDown = useCallback((visualId: string, step: DrillStep) => {
		setDrillByVisual((prev) => ({
			...prev,
			[visualId]: [...(prev[visualId] ?? []), step],
		}));
	}, []);

	// Drilling up to a depth rather than by one step, so a breadcrumb can jump
	// back several levels in one click.
	const drillUp = useCallback((visualId: string, toDepth = -1) => {
		setDrillByVisual((prev) => {
			const path = prev[visualId] ?? [];
			if (path.length === 0) return prev;
			const depth = toDepth < 0 ? path.length - 1 : toDepth;
			const next = { ...prev };
			if (depth <= 0) delete next[visualId];
			else next[visualId] = path.slice(0, depth);
			return next;
		});
	}, []);

	const clearAll = useCallback(() => {
		setByWidget({});
		setCrossFilterState(null);
		setDrillByVisual({});
		// The dimension choice is not cleared: it is what the page is showing,
		// not a filter applied on top of it.
	}, []);

	const widgetClauses = useMemo(
		() => Object.values(byWidget).flat(),
		[byWidget],
	);

	const activeClauses = useMemo(
		() => [...widgetClauses, ...(crossFilter?.clauses ?? [])],
		[widgetClauses, crossFilter],
	);

	const clausesFor = useCallback(
		(visualId: string) => {
			const drill = (drillByVisual[visualId] ?? []).map((step) => ({
				field: step.field,
				op: "eq",
				values: [step.value],
			}));

			// A visual does not normally apply its own cross filter: filtering
			// the clicked chart down to the single bar that was clicked would
			// leave nothing to compare it against. A range drawn across it is
			// the exception, because narrowing to the range is the whole point
			// of drawing it.
			const cross =
				crossFilter &&
				(crossFilter.sourceVisualId !== visualId || crossFilter.zoomSource)
					? crossFilter.clauses
					: [];

			return [...widgetClauses, ...cross, ...drill];
		},
		[widgetClauses, crossFilter, drillByVisual],
	);

	const clausesExcept = useCallback(
		(widgetId: string) =>
			Object.entries(byWidget)
				.filter(([id]) => id !== widgetId)
				.flatMap(([, clauses]) => clauses),
		[byWidget],
	);

	const value = useMemo(
		() => ({
			setWidgetFilter,
			clearWidget,
			byWidget,
			crossFilter,
			setCrossFilter,
			selectedDimension,
			setSelectedDimension,
			selectedGrain,
			setSelectedGrain,
			drillByVisual,
			drillDown,
			drillUp,
			clearAll,
			activeClauses,
			clausesFor,
			clausesExcept,
			hasAnything:
				widgetClauses.length > 0 ||
				crossFilter !== null ||
				Object.keys(drillByVisual).length > 0,
		}),
		[
			setWidgetFilter, clearWidget, byWidget, crossFilter, setCrossFilter,
			selectedDimension, selectedGrain, drillByVisual, drillDown, drillUp, clearAll,
			activeClauses, clausesFor, clausesExcept, widgetClauses,
		],
	);

	return (
		<PageFilterContext.Provider value={value}>
			{children}
		</PageFilterContext.Provider>
	);
}

export function usePageFilters() {
	return useContext(PageFilterContext);
}
