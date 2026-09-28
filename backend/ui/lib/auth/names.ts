// A readable name from an address, for places that know someone only by their
// email. Takes the part before the @, splits it on dots, underscores and
// hyphens, and capitalises each word.
export function displayNameFromEmail(email: string): string {
	const localPart = email.split("@")[0] ?? email;
	return localPart
		.replace(/[._-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
