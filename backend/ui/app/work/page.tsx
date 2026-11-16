import { Suspense } from "react";
import WorkView from "./WorkView";

export default function WorkRoute() {
	return (
		<Suspense>
			<WorkView />
		</Suspense>
	);
}
