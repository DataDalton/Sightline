"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps, FocusEvent, MouseEvent, TouchEvent } from "react";

// A link that prefetches its page when someone points at it, focuses it or
// touches it, rather than whenever it scrolls into view.
//
// Every page is rendered on the server for each reader, and prefetching on
// sight rendered every page linked from the screen for every page somebody
// looked at. The sidebar alone links a dozen. A pointer reaches a link a
// moment before the click, which is enough for the prefetch to be under way,
// and the server renders only the pages people are about to open.
type Props = ComponentProps<typeof Link>;

function pathOf(href: Props["href"]): string | null {
	if (typeof href === "string") return href;
	return href.pathname ?? null;
}

export default function AppLink({
	href,
	prefetch,
	onMouseEnter,
	onFocus,
	onTouchStart,
	...rest
}: Props) {
	const router = useRouter();
	const warm = () => {
		const path = pathOf(href);
		if (path && prefetch !== false) router.prefetch(path);
	};
	return (
		<Link
			href={href}
			prefetch={false}
			onMouseEnter={(event: MouseEvent<HTMLAnchorElement>) => {
				warm();
				onMouseEnter?.(event);
			}}
			onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
				warm();
				onFocus?.(event);
			}}
			onTouchStart={(event: TouchEvent<HTMLAnchorElement>) => {
				warm();
				onTouchStart?.(event);
			}}
			{...rest}
		/>
	);
}
