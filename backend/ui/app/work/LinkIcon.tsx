// The marks for the things a request can point at, drawn in the stroke style
// the rest of the app uses. An unknown kind draws the plain link.

const linkIconPaths: Record<string, string> = {
	url: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
	source: "M12 2c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3zM21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5",
	report: "M18 20V10M12 20V4M6 20v-6",
	field: "M3 3h18v18H3zM9 3v18M15 3v18",
	page: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
	visual: "M21.21 15.89A10 10 0 1 1 8 2.83M22 12A10 10 0 0 0 12 2v10z",
	// An arrow turning into this request, for the work it waits on.
	dependsOn: "M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12",
	// A stop sign, for the work that waits on this.
	blocks: "M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86zM8 12h8",
	update: "M3 11l18-8-8 18-2-8-8-2z",
	plus: "M12 5v14M5 12h14",
	remove: "M18 6L6 18M6 6l12 12",
};

export function LinkIcon({ kind, size = 16 }: { kind: string; size?: number }) {
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
			<path d={linkIconPaths[kind] ?? linkIconPaths.url} />
		</svg>
	);
}
