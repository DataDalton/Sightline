"use client";

import { SWRConfig } from "swr";
import { swrDefaults } from "../../lib/swr";

export default function SWRProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	return <SWRConfig value={swrDefaults}>{children}</SWRConfig>;
}
