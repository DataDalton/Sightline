import type { InboxItem } from "../../lib/notify/store";

// Icons for the inbox and its entries, one per kind of notification.

export function BellIcon({ size = 18 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
		</svg>
	);
}

export const kindPaths: Record<InboxItem["kind"], string> = {
	alert: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0",
	share: "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13",
	message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
	delivery: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
	data: "M12 3C7 3 4 4.3 4 6v12c0 1.7 3 3 8 3s8-1.3 8-3V6c0-1.7-3-3-8-3zM4 6c0 1.7 3 3 8 3s8-1.3 8-3M12 13v3M12 11h.01",
	system: "M3 11l18-8-8 18-2-8z",
};

export function KindIcon({
	kind,
	size = 16,
}: {
	kind: InboxItem["kind"];
	size?: number;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={kindPaths[kind] ?? kindPaths.system} />
		</svg>
	);
}
