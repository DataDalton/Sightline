import { headers } from "next/headers";
import HomeView from "./HomeView";
import { getIdentityFromHeaders } from "../lib/auth/identity";
import { resolvePolicyClass } from "../lib/auth/policy";
import { briefingPlan } from "../lib/briefing/plan";
import { withinSeedBudget } from "../lib/platform/pageData";

// The briefing's plan, worked out while the document is rendered, from the
// same call the briefing route makes and under the key the briefing asks
// with. The briefing then draws its figures' places from the document rather
// than asking first. Within the budget every seeded answer keeps to, and left
// for the browser to ask when it is not ready in time.
async function openingResponses(): Promise<Record<string, unknown>> {
	const identity = getIdentityFromHeaders(await headers());
	if (!identity) return {};
	return withinSeedBudget<Record<string, unknown>>(async () => {
		const policy = await resolvePolicyClass(identity);
		return { "/api/briefing/": await briefingPlan(identity, policy) };
	}, {});
}

export default async function HomePage() {
	return <HomeView seeded={await openingResponses()} />;
}
