import { NextRequest, NextResponse } from "next/server";

// Two things that have to happen before a request reaches a handler: deciding
// whether the browser was asked to send it by this application, and minting the
// nonce that lets the page run its own scripts and nothing else.

// --- Where the request came from -------------------------------------------

// Requests that change something. A GET is not on this list because a GET must
// not change anything, and any that does is a bug this would only hide.
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Authentication here is ambient: the proxy in front of the app resolves the
// reader's session and injects their identity, so any request a browser can be
// made to send arrives authenticated. That is what makes cross-site request
// forgery possible, and it is not theoretical here. A cross-origin form post
// carries no preflight when its content type is text/plain, and every route
// parses its body with request.json(), which does not look at the content type.
// So a page anywhere could have a reader's browser publish a report edit, grant
// access, or start a catalogue walk, in their name.
//
// Sec-Fetch-Site is the check. The browser sets it and script cannot, so unlike
// a token it cannot be replayed and unlike an Origin comparison it does not
// depend on reconstructing the deployment's own hostname from behind a proxy
// that rewrites it.
//
// Absent, it falls back to comparing Origin against the forwarded host. A
// request carrying neither is not a browser, and a non-browser client has no
// ambient session to borrow, so it is left alone.
function sameOrigin(request: NextRequest): boolean {
	const site = request.headers.get("sec-fetch-site");
	if (site) {
		// "none" is a direct navigation, which cannot be a scripted write.
		return site === "same-origin" || site === "none";
	}

	const origin = request.headers.get("origin");
	if (!origin) return true;

	const host =
		request.headers.get("x-forwarded-host") ?? request.headers.get("host");
	if (!host) return false;

	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

// --- Letting the page run its own scripts, and nothing else -----------------

// A policy naming 'unsafe-inline' for scripts is a policy that permits injected
// script, which is the thing it exists to stop. The application needs inline
// script for exactly two reasons: the framework's own bootstrap, and the theme
// applied before first paint so the page does not flash the wrong one. Both are
// ours, so both can carry a nonce, and the policy can then refuse everything
// else.
//
// A nonce has to be unguessable and has to differ per response, or it is a
// constant an injected script could simply include.
function makeNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes));
}

function policy(nonce: string, development: boolean): string {
	// React needs eval in development for its refresh transform. It is not in
	// the production policy.
	const script = development
		? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'strict-dynamic'`
		: `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

	return [
		"default-src 'self'",
		script,
		// Styles stay open to inline. React writes element styles directly and
		// the visual layer computes colours per cell, so a nonce cannot reach
		// them. An injected stylesheet can deface a page and can read nothing,
		// which is a different order of problem from injected script.
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self'",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"frame-src 'none'",
		"worker-src 'self' blob:",
		"base-uri 'self'",
		"form-action 'self'",
		"object-src 'none'",
		"upgrade-insecure-requests",
	].join("; ");
}

export function middleware(request: NextRequest) {
	if (unsafeMethods.has(request.method) && !sameOrigin(request)) {
		// Deliberately terse. Naming the check tells an attacker which header to
		// try next, and a caller who hits this legitimately is a developer with
		// access to this file.
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const nonce = makeNonce();
	const development = process.env.NODE_ENV !== "production";
	const csp = policy(nonce, development);

	// Passed forward on the request so the framework applies it to the scripts
	// it renders, and set on the response so the browser enforces it.
	const headers = new Headers(request.headers);
	headers.set("x-nonce", nonce);
	headers.set("content-security-policy", csp);

	const response = NextResponse.next({ request: { headers } });
	response.headers.set("Content-Security-Policy", csp);
	return response;
}

export const config = {
	// Everything except the build output and static files, which are public,
	// unchanging, and carry no session.
	matcher: ["/((?!_next/static|_next/image|favicon.ico|static/).*)"],
};
