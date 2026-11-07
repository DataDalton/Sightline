"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Scenario } from "../../lib/insight/insight";

// The what if in force on a page, read wherever rows reach the screen.

const ScenarioContext = createContext<Scenario[] | null>(null);

export function useScenario(): Scenario[] | null {
	return useContext(ScenarioContext);
}

export function ScenarioProvider({
	value,
	children,
}: {
	value: Scenario[] | null;
	children: ReactNode;
}) {
	return (
		<ScenarioContext.Provider value={value}>
			{children}
		</ScenarioContext.Provider>
	);
}
