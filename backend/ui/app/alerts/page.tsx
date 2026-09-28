import { Suspense } from "react";
import InboxView from "../inbox/InboxView";

// Alerts are a view of the inbox. This address stays so links to it keep
// working, and opens the inbox on that view.
export default function AlertsRoute() {
	return (
		<Suspense>
			<InboxView initial="alerts" />
		</Suspense>
	);
}
