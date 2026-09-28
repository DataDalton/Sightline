import { Suspense } from "react";
import InboxView from "./InboxView";

export default function InboxRoute() {
	return (
		<Suspense>
			<InboxView />
		</Suspense>
	);
}
