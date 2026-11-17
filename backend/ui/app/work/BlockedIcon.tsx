// The mark beside anything blocked in the work queue: a stop sign with an
// exclamation, the same on the board, the table, the list and the calendar.
export function BlockedIcon({
	size = 13,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			style={{ flexShrink: 0 }}
		>
			<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z" />
			<path d="M12 7.5v5M12 16.5h.01" />
		</svg>
	);
}
