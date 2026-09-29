"use client";

import { useEffect, useRef } from "react";
import { useUser } from "../context/UserContext";
import { useAssistant, type SurfaceBinding } from "./AssistantContext";

// Registers the screen that calls it with the assistant for as long as it is
// open, so a question asked from the assistant panel carries the screen's
// state and a draft that comes back lands on it.
//
// The binding passed in changes every render, since it closes over the
// screen's state. What is registered is a fixed object that reads the latest
// one, so registering happens once rather than on every keystroke.
export function useAssistantSurface(binding: SurfaceBinding | null): void {
	const { user } = useUser();
	const { registerSurface } = useAssistant();
	const latest = useRef(binding);
	latest.current = binding;

	const kind = binding?.kind ?? null;
	const placeholder = binding?.placeholder;
	// Joined so a new array with the same questions is not a change.
	const examples = binding?.examples?.join("\n") ?? "";
	const enabled = Boolean(user?.assistant) && kind !== null;

	useEffect(() => {
		if (!enabled || !kind) return;
		return registerSurface({
			kind,
			placeholder,
			examples: examples ? examples.split("\n") : undefined,
			state: () => latest.current?.state() ?? null,
			apply: (draft) => latest.current?.apply(draft),
		});
	}, [enabled, kind, placeholder, examples, registerSurface]);
}
