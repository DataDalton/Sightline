"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";

// The signed-in user and their resolved policy class, loaded once per session.
// The policy class is what decides which reports render and which cache
// entries a query may read, so the shell surfaces its state rather than
// hiding it: a stale or degraded class changes what the user sees.

export interface UserPolicy {
	id: string;
	grants: string[];
	// Membership could not be resolved. Data is refused while this holds.
	degraded: boolean;
	// Serving last known grants through a lookup outage.
	stale: boolean;
}

export interface User {
	email: string;
	name: string;
	initials: string;
	authenticated: boolean;
	// False when no forwarded token is present, meaning no data query can run.
	canQueryAsUser: boolean;
	// Member of a central editor group: edits publish to everyone.
	canEdit: boolean;
	canAdminister: boolean;
	policy: UserPolicy;
}

interface UserContextValue {
	user: User | null;
	loading: boolean;
	error: boolean;
	refresh: () => void;
}

const UserContext = createContext<UserContextValue>({
	user: null,
	loading: true,
	error: false,
	refresh: () => {},
});

export function UserProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const inFlight = useRef(false);

	const load = useCallback(() => {
		if (inFlight.current) return;
		inFlight.current = true;
		setLoading(true);
		setError(false);

		fetch("/api/user")
			.then((res) => {
				if (!res.ok) throw new Error(String(res.status));
				return res.json();
			})
			.then((data: User) => {
				setUser(data);
				setLoading(false);
			})
			.catch(() => {
				setLoading(false);
				setError(true);
			})
			.finally(() => {
				inFlight.current = false;
			});
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	// A degraded policy class resolves itself once the lookup recovers, so the
	// shell retries rather than leaving the user stuck until a reload.
	useEffect(() => {
		if (!user?.policy.degraded && !error) return;
		const timer = setTimeout(load, 30000);
		return () => clearTimeout(timer);
	}, [user?.policy.degraded, error, load]);

	return (
		<UserContext.Provider value={{ user, loading, error, refresh: load }}>
			{children}
		</UserContext.Provider>
	);
}

export function useUser() {
	return useContext(UserContext);
}
