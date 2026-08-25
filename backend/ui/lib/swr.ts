// Global SWR fetcher used by SWRConfig in app/layout.tsx.
// Throws on non-2xx so SWR's `error` channel fires for failed responses.
export async function fetcher<T = any>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) {
		const err: Error & { status?: number; info?: any } = new Error(
			`Request failed: ${res.status}`,
		);
		err.status = res.status;
		try {
			err.info = await res.json();
		} catch {
			err.info = null;
		}
		throw err;
	}
	return res.json();
}

export const swrDefaults = {
	fetcher,
	revalidateOnFocus: false,
	revalidateOnReconnect: true,
	dedupingInterval: 5000,
	keepPreviousData: true,
} as const;
