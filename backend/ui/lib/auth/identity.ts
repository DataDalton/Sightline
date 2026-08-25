import type { NextRequest } from "next/server";
import {
	accessTokenHeader,
	allowLocalIdentity,
	emailHeader,
	localIdentityEmail,
} from "../runtime";

// Identity of the caller, resolved from proxy-injected headers. Databricks
// Apps authenticates the user upstream and forwards the result, so these
// headers are the only trusted source of identity. A body field or query
// parameter is never used for an authorization decision.

export interface Identity {
	email: string;
	// Display name derived from the email local part.
	name: string;
	initials: string;
	// True when the identity came from a proxy header rather than the local
	// development fallback.
	authenticated: boolean;
	// Forwarded user token, present only when on-behalf-of authorization is
	// enabled for the app. Direct-mode dataset queries run with this so Unity
	// Catalog row filters and column masks apply. Null means the caller can
	// only reach import-mode datasets.
	userToken: string | null;
}

function displayNameFromEmail(email: string): string {
	const localPart = email.split("@")[0] ?? email;
	return localPart
		.replace(/[._-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function initialsFromName(name: string): string {
	const parts = name.split(/\s+/).filter((p) => p.length > 0);
	if (parts.length === 0) return "?";
	return parts
		.slice(0, 2)
		.map((p) => p[0].toUpperCase())
		.join("");
}

function buildIdentity(
	email: string,
	userToken: string | null,
	authenticated: boolean,
): Identity {
	const name = displayNameFromEmail(email);
	return {
		email,
		name,
		initials: initialsFromName(name),
		authenticated,
		userToken,
	};
}

// Reads the caller identity from a request. Returns null when no proxy header
// is present and the local development fallback is disabled, so a
// misconfigured production deployment fails closed rather than serving an
// anonymous session with full access.
export function getIdentity(request: NextRequest): Identity | null {
	const rawEmail = request.headers.get(emailHeader);
	const email = rawEmail?.trim().toLowerCase() ?? "";

	// The forwarded token is re-read on every request. Capturing it once (for
	// example when a websocket connects) is a known failure mode: the token
	// goes stale across reconnects and long-lived sessions, and every
	// subsequent on-behalf-of query fails with an auth error.
	const userToken =
		request.headers.get(accessTokenHeader)?.trim() || null;

	if (email) {
		return buildIdentity(email, userToken, true);
	}

	if (allowLocalIdentity) {
		return buildIdentity(
			localIdentityEmail.toLowerCase(),
			userToken,
			false,
		);
	}

	return null;
}

// Reads identity from a plain header map. Used by the websocket upgrade path
// and by any handler that does not receive a NextRequest.
export function getIdentityFromHeaders(
	headers: Headers | Map<string, string>,
): Identity | null {
	const read = (key: string): string | null => {
		if (headers instanceof Headers) return headers.get(key);
		return headers.get(key) ?? headers.get(key.toLowerCase()) ?? null;
	};

	const email = read(emailHeader)?.trim().toLowerCase() ?? "";
	const userToken = read(accessTokenHeader)?.trim() || null;

	if (email) return buildIdentity(email, userToken, true);
	if (allowLocalIdentity) {
		return buildIdentity(
			localIdentityEmail.toLowerCase(),
			userToken,
			false,
		);
	}
	return null;
}
