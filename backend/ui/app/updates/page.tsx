import { redirect } from "next/navigation";

// Updates live on Data status now. Links already sent out, such as in the Inbox, still arrive.
export default async function UpdatesRoute({
	searchParams,
}: {
	searchParams: Promise<{ open?: string }>;
}) {
	const { open } = await searchParams;
	redirect(
		`/status?tab=updates${open ? `&open=${encodeURIComponent(open)}` : ""}`,
	);
}
