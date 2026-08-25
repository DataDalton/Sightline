import type { Metadata } from "next";
import "./globals.css";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";
import SWRProvider from "./components/SWRProvider";
import { UserProvider } from "./context/UserContext";
import { ThemeProvider, themeBootstrapScript } from "./context/ThemeContext";
import { ShellProvider } from "./context/ShellContext";
import NavScrim from "./components/NavScrim";
import styles from "./layout.module.css";

// The document title before the settings table has been read. What an
// installation calls itself is set in the app, not at build time.
const appName = "Sightline";
const appDescription =
	process.env.NEXT_PUBLIC_APP_DESCRIPTION || "Analytics and reporting platform";

export const metadata: Metadata = {
	title: appName,
	description: appDescription,
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* Applies the stored theme before first paint, so the page never
				    renders light and then flips to dark. */}
				<script
					dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
				/>
			</head>
			<body>
				<ThemeProvider>
					<SWRProvider>
						<UserProvider>
							<ShellProvider>
								<Header />
								<div className={styles.container}>
									<Sidebar />
									<NavScrim />
									<main className={styles.main}>{children}</main>
								</div>
							</ShellProvider>
						</UserProvider>
					</SWRProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
