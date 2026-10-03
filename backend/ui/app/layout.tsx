import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { getIdentityFromHeaders } from "../lib/auth/identity";
import { pushPublicKey } from "../lib/notify/push";
import { inboxSummary } from "../lib/notify/store";
import { settings } from "../lib/settings";
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
import PaletteHost from "./components/PaletteHost";
import styles from "./layout.module.css";
import { AssistantProvider } from "./assist/AssistantContext";
import { AssistantDock } from "./assist/AssistantDock";
import { NotifyProvider } from "./notify/NotifyContext";
import { MobileTabBar } from "./components/MobileTabBar";

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
	// Installed from Safari, iOS reads these rather than the manifest for how
	// the app window looks.
	appleWebApp: {
		capable: true,
		statusBarStyle: "black-translucent",
	},
	formatDetection: { telephone: false },
};

// Drawn edge to edge once installed, with the header clearing the status bar
// through the safe area insets. The theme colour is the chrome, which is dark
// in both themes, so the browser's own bar matches the header below it.
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	themeColor: "#16181d",
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
		const [shell, inbox, pushKey] = await Promise.all([
			shellPayload(identity),
			inboxSummary(identity.email).catch(() => null),
			pushPublicKey().catch(() => null),
		]);
		return {
			user: shell.user,
			fallback: {
				"/api/user": shell.user,
				"/api/navigation": shell.navigation,
				"/api/info": shell.info,
				// The same shape the summary route answers, so the badge draws
				// from the document and asks again only on its own schedule.
				...(inbox
					? {
							"/api/notifications/summary": {
								unread: inbox.unread,
								latest: inbox.latest,
								pushKey,
								alerts: settings().alertsEnabled,
							},
						}
					: {}),
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
	// Minted per response in proxy.ts and read back here.
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
				{/* With credentials, because the app sits behind a sign-in
				    and a manifest is otherwise fetched without the cookie
				    that gets past it, which fails the install silently. */}
				<link
					rel="manifest"
					href="/app-manifest/"
					crossOrigin="use-credentials"
				/>
				<link
					rel="icon"
					type="image/png"
					sizes="32x32"
					href="/app-icon/icon-32.png"
				/>
				<link
					rel="apple-touch-icon"
					href="/app-icon/apple-touch-icon.png"
				/>
			</head>
			<body>
				<ThemeProvider>
					<SWRProvider fallback={shell.fallback}>
						<UserProvider initial={shell.user}>
							<ShellProvider>
								<NotifyProvider>
									<AssistantProvider>
										<a
											href="#main"
											className={styles.skipLink}
										>
											Skip to content
										</a>
										<Header />
										<div className={styles.container}>
											<Sidebar />
											<NavScrim />
											<main
												id="main"
												tabIndex={-1}
												className={styles.main}
											>
												{children}
											</main>
										</div>
										<MobileTabBar />
										<PaletteHost />
										<AssistantDock />
									</AssistantProvider>
								</NotifyProvider>
							</ShellProvider>
						</UserProvider>
					</SWRProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
