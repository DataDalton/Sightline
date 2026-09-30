import type { MuteChoice } from "../../lib/alerts/mute";
import type {
	PageAlertList,
	PageAlertRecord,
	PromoteTarget,
} from "../../lib/alerts/pageStore";

// Where the page alert routes are, and the calls the browser makes to them.

export type { PageAlertList, PageAlertRecord, PromoteTarget };

export function pageAlertsKey(pageId: string): string {
	return `/api/page-alerts/?pageId=${encodeURIComponent(pageId)}`;
}

export const subscriptionsKey = "/api/page-alerts/subscriptions/";

export interface Sent<T> {
	ok: boolean;
	body: T & { error?: string };
}

// A JSON request that reports a refusal as a message rather than throwing.
export async function send<T>(
	url: string,
	method: "POST" | "PUT" | "DELETE",
	body?: unknown,
): Promise<Sent<T>> {
	try {
		const response = await fetch(url, {
			method,
			headers:
				body === undefined
					? undefined
					: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const parsed = (await response.json().catch(() => ({}))) as T & {
			error?: string;
		};
		return { ok: response.ok, body: parsed };
	} catch {
		return {
			ok: false,
			body: { error: "The request did not reach the server." } as T & {
				error?: string;
			},
		};
	}
}

export function changeSubscription(
	id: string,
	change: { subscribed?: boolean; mute?: MuteChoice },
): Promise<Sent<{ alert?: PageAlertRecord }>> {
	return send(
		`/api/page-alerts/${encodeURIComponent(id)}/subscription/`,
		"PUT",
		change,
	);
}
