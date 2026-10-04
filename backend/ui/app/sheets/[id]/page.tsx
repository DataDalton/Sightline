import { headers } from "next/headers";
import { GET as authoringGet } from "../../api/authoring/route";
import { GET as sheetGet } from "../../api/sheets/[id]/route";
import { answeredHere } from "../../answeredHere";
import { getIdentityFromHeaders } from "../../../lib/auth/identity";
import { withinSeedBudget } from "../../../lib/platform/pageData";
import SheetEditor from "../SheetEditor";

// The sheet and the datasets it can read from, answered while the document
// renders. See app/answeredHere.
async function openingResponses(id: string): Promise<Record<string, unknown>> {
	const incoming = await headers();
	if (!getIdentityFromHeaders(incoming)) return {};
	return withinSeedBudget<Record<string, unknown>>(
		() =>
			answeredHere(new Headers(incoming), [
				{ key: `/api/sheets/${id}`, handler: sheetGet, params: { id } },
				{ key: "/api/authoring", handler: authoringGet },
			]),
		{},
	);
}

export default async function SheetRoute({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <SheetEditor id={id} seeded={await openingResponses(id)} />;
}
