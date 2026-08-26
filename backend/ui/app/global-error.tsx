"use client";

import { useEffect } from "react";
import "./globals.css";

// The last resort, for a failure in the root layout itself.
//
// This replaces the whole document, so it renders its own html and body and
// cannot rely on anything the layout sets up: no providers, no header, no theme
// bootstrap. Everything it needs is either a token from the stylesheet or
// written inline here, because whatever broke may be the reason the rest is
// unavailable.
//
// The theme is read from the media query alone. An explicit choice lives in
// localStorage and is applied by a script the layout renders, and that script
// is exactly what is missing here.

export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("Application render failed:", error);
	}, [error]);

	return (
		<html lang="en">
			<body
				style={{
					margin: 0,
					minHeight: "100vh",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					padding: "24px",
					background: "var(--surface-base)",
					color: "var(--text-primary)",
					fontFamily: "var(--font-sans)",
				}}
			>
				<div
					style={{
						maxWidth: "440px",
						textAlign: "center",
						display: "flex",
						flexDirection: "column",
						gap: "12px",
						alignItems: "center",
					}}
				>
					<svg
						width="32"
						height="32"
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--danger)"
						strokeWidth="2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<circle cx="12" cy="12" r="10" />
						<path d="M12 8v5M12 16h.01" />
					</svg>

					<h1
						style={{
							margin: 0,
							fontSize: "var(--text-2xl)",
							fontWeight: 600,
						}}
					>
						The app could not start
					</h1>

					<p
						style={{
							margin: 0,
							lineHeight: 1.6,
							color: "var(--text-secondary)",
						}}
					>
						Something failed before any page could be drawn. This is
						a problem with the app rather than with your access, and
						an administrator can see the reason in the deployment
						logs.
					</p>

					<div
						style={{
							display: "flex",
							gap: "8px",
							marginTop: "8px",
						}}
					>
						<button
							type="button"
							onClick={reset}
							style={{
								padding: "8px 18px",
								border: "1px solid transparent",
								borderRadius: "var(--radius-md)",
								background: "var(--brand)",
								color: "var(--brand-contrast)",
								fontSize: "var(--text-sm)",
								fontWeight: 600,
								fontFamily: "inherit",
								cursor: "pointer",
							}}
						>
							Try again
						</button>
						<a
							href="/"
							style={{
								padding: "8px 18px",
								border: "1px solid var(--border-default)",
								borderRadius: "var(--radius-md)",
								background: "var(--surface-raised)",
								color: "var(--text-primary)",
								fontSize: "var(--text-sm)",
								fontWeight: 500,
								textDecoration: "none",
							}}
						>
							Reload
						</a>
					</div>

					{error.digest && (
						<div
							style={{
								marginTop: "8px",
								fontFamily: "var(--font-mono)",
								fontSize: "var(--text-xs)",
								color: "var(--text-muted)",
								userSelect: "all",
							}}
						>
							Reference {error.digest}
						</div>
					)}
				</div>
			</body>
		</html>
	);
}
