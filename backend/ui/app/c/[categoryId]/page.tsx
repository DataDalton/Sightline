import { headers } from "next/headers";
import CategoryView from "../CategoryView";
import { getIdentityFromHeaders } from "../../../lib/auth/identity";
import { resolvePolicyClass } from "../../../lib/auth/policy";
import {
	categoryPayload,
	withinSeedBudget,
} from "../../../lib/platform/pageData";

// The reports in this category, resolved while the document is rendered, so the
// list is in the first paint rather than a round trip after hydration.
async function listingFor(categoryId: string) {
	const identity = getIdentityFromHeaders(await headers());
	if (!identity) return undefined;

	return withinSeedBudget(async () => {
		const policy = await resolvePolicyClass(identity);
		const category = await categoryPayload(identity, policy, categoryId);
		// A category this reader cannot open is left to the client, which asks
		// and is refused. Seeding an absence would be indistinguishable from a
		// listing that is still loading.
		if (!category) return undefined;
		return category;
	}, undefined);
}

export default async function CategoryPage({
	params,
}: {
	params: Promise<{ categoryId: string }>;
}) {
	const { categoryId } = await params;
	const initial = await listingFor(categoryId);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return <CategoryView categoryId={categoryId} initial={initial as any} />;
}
