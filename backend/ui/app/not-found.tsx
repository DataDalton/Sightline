import { ErrorState } from "./components/shared/ErrorState";

// A URL that resolves to nothing.
//
// Reached by a report that was removed or renamed as often as by a typo, so the
// wording does not assume the reader made a mistake. Rendered inside the layout,
// so the navigation is there to leave by.

export default function NotFound() {
	return (
		<ErrorState
			title="That page does not exist"
			body="It may have been renamed or removed. Anything you can open is listed in the navigation."
		/>
	);
}
