import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { getIdentityFromHeaders } from "../lib/auth/identity";
import {
	shellPayload,
	withinSeedBudget,
	type UserPayload,
} from "../lib/platform/pageData";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";
import SWRProvider from "./components/SWRProvider";
import { UserProvider } from "./context/UserContext";
import { ThemeProvider, themeBootstrapScript } from "./context/ThemeContext";
import { ShellProvider } from "./context/ShellContext";
import NavScrim from "./components/NavScrim";
import styles from "./layout.module.css";

// The document title before the settings table has been read, and while a
// deployment is still unnamed. What an installation calls itself is set in the
// app rather than at build time, so usePageTitle replaces both of these as soon
// as the branding arrives, and adds where the reader is.
// Every page here is rendered for one reader: the shell carries their name,
// their navigation and their permissions. Saying so up front stops Next
// attempting a static render it would then have to throw out, and stops that
// attempt reaching the catch below, which is for a platform store that is down
// and not for a framework telling us what kind of page this is.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Sightline",
	description: "Analytics and reporting platform",
};

// What the shell needs, resolved while the document is being rendered.
//
// The reader and the navigation are on every page, and asking for them from the
// browser meant the shell could not draw until a round trip after hydration. The
// request that produced this document already carries the headers those answers
// come from, so it can answer them for free.
//
// Degrades to nothing rather than failing or holding the page. Without a payload
// the client asks the way it always did, which is a slower first paint and not a
// broken one, and that is the right trade when the platform store is unreachable
// or a cold container is still opening its first connection.
interface Shell {
	user: UserPayload | null;
	fallback: Record<string, unknown>;
}

const empty: Shell = { user: null, fallback: {} };

async function resolveShell(): Promise<Shell> {
	const identity = getIdentityFromHeaders(await headers());
	if (!identity) return empty;

	return withinSeedBudget<Shell>(async () => {
		const shell = await shellPayload(identity);
		return {
			user: shell.user,
			fallback: {
				"/api/user": shell.user,
				"/api/navigation": shell.navigation,
				"/api/info": shell.info,
			},
		};
	}, empty);
}

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const shell = await resolveShell();
	// Minted per response in middleware.ts and read back here.
	const nonce = (await headers()).get("x-nonce") ?? undefined;

	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* Applies the stored theme before first paint, so the page never
				    renders light and then flips to dark. Carries the nonce the
				    policy names, because the policy permits no inline script
				    that does not. */}
				<script
					nonce={nonce}
					dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
				/>
			</head>
			<body>
				<ThemeProvider>
					<SWRProvider fallback={shell.fallback}>
						<UserProvider initial={shell.user}>
							<ShellProvider>
								<Header />
								<div className={styles.container}>
									<Sidebar />
									<NavScrim />
									<main className={styles.main}>
										{children}
									</main>
								</div>
							</ShellProvider>
						</UserProvider>
					</SWRProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
