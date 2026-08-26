/** @type {import('next').NextConfig} */

// The Content Security Policy is not here.
//
// It carries a per-response nonce so the page can run its own two inline
// scripts without naming 'unsafe-inline', which would permit any injected one.
// A nonce has to be minted per request, and this file is read once at startup,
// so the policy is set in middleware.ts instead. Everything below is constant
// and can be declared here.

const securityHeaders = [
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
	// Severs the window from anything that opened it or that it opens, so a
	// cross-origin page cannot reach into this one through window.opener.
	{ key: "Cross-Origin-Opener-Policy", value: "same-origin" },
	// Refuses to be embedded as a subresource by another origin, which is the
	// read side of the same boundary frame-ancestors closes for framing.
	{ key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig = {
	// Next writes CLAUDE.md and AGENTS.md into the project on every dev run.
	// Nothing here depends on them, so they stay out of the tree.
	agentRules: false,
	trailingSlash: true,
	skipTrailingSlashRedirect: true,
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
