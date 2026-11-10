// Whether a warehouse error is the catalogue refusing the caller, as opposed to
// the warehouse failing. A refusal is a definite answer about the caller's
// access, so it can be recorded as "reads nothing there". Any other failure says
// nothing about access and has to be reported as a failure.
//
// The driver puts the SQLSTATE on the response it attaches to the error. The
// error class in the message is checked as well, since a refusal is recognised
// by either alone.
export function isCatalogRefusal(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const held = error as {
		message?: unknown;
		sqlState?: unknown;
		response?: { sqlState?: unknown };
	};
	if (held.sqlState === "42501" || held.response?.sqlState === "42501") {
		return true;
	}
	return (
		typeof held.message === "string" &&
		/\[(INSUFFICIENT_PERMISSIONS|PERMISSION_DENIED)\]/.test(held.message)
	);
}
