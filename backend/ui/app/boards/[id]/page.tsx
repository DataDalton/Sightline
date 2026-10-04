import { headers } from "next/headers";
import { GET as authoringGet } from "../../api/authoring/route";
import { GET as boardGet } from "../../api/boards/[id]/route";
import { answeredHere } from "../../answeredHere";
import { getIdentityFromHeaders } from "../../../lib/auth/identity";
import { withinSeedBudget } from "../../../lib/platform/pageData";
import BoardView from "../BoardView";

// The board and the datasets its charts read, answered while the document
// renders. See app/answeredHere.
async function openingResponses(id: string): Promise<Record<string, unknown>> {
	const incoming = await headers();
	if (!getIdentityFromHeaders(incoming)) return {};
	return withinSeedBudget<Record<string, unknown>>(
		() =>
			answeredHere(new Headers(incoming), [
				{
					key: `/api/boards/${id}/`,
					handler: boardGet,
					params: { id },
				},
				{ key: "/api/authoring", handler: authoringGet },
			]),
		{},
	);
}

export default async function BoardRoute({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <BoardView id={id} seeded={await openingResponses(id)} />;
}
