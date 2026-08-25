/** @type {import('next').NextConfig} */

// Content Security Policy for the application. The app is a Next.js / React
// front-end that only calls its own same-origin /api routes, so connect-src,
// script-src, and style-src are scoped to 'self'. 'unsafe-inline' is required
// for the Next.js bootstrap/hydration inline script and styled-jsx inline
// styles. frame-ancestors 'none' blocks the app from being framed.
// React uses eval() only in development mode for debugging, so 'unsafe-eval'
// is added to script-src in development and excluded from the production policy.
const isDev = process.env.NODE_ENV !== "production";
const scriptSrc = isDev
	? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
	: "script-src 'self' 'unsafe-inline'";

const contentSecurityPolicy = [
	"default-src 'self'",
	scriptSrc,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'self'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"object-src 'none'",
].join("; ");

const securityHeaders = [
	{ key: "Content-Security-Policy", value: contentSecurityPolicy },
	{ key: "X-Frame-Options", value: "DENY" },
	// The legacy XSS Auditor was buggy and is removed from modern browsers.
	// Send 0 to disable it on any old browser that still has it. CSP is the
	// actual XSS control.
	{ key: "X-XSS-Protection", value: "0" },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{
		key: "Strict-Transport-Security",
		value: "max-age=63072000; includeSubDomains; preload",
	},
	{ key: "X-DNS-Prefetch-Control", value: "off" },
	{ key: "X-Permitted-Cross-Domain-Policies", value: "none" },
	{
		key: "Permissions-Policy",
		value: "camera=(), microphone=(), geolocation=()",
	},
];

const nextConfig = {
	// Next writes CLAUDE.md and AGENTS.md into the project on every dev run.
	// Nothing here depends on them, so they stay out of the tree.
	agentRules: false,
	trailingSlash: true,
	reactStrictMode: true,
	compress: true,
	poweredByHeader: false,
	images: {
		unoptimized: true,
	},
	serverExternalPackages: ["@databricks/sql"],
	turbopack: {
		root: __dirname,
	},
	async headers() {
		return [
			{
				source: "/:path*",
				headers: securityHeaders,
			},
		];
	},
};

module.exports = nextConfig;
