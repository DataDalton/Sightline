import { Suspense } from "react";
import AdminView from "./AdminView";

// The open pane is read from the address, and reading it needs a boundary so
// the rest of the route can be prerendered without waiting on the router.
export default function AdminPage() {
	return (
		<Suspense>
			<AdminView />
		</Suspense>
	);
}
