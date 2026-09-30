// Whether a source's answers may be shared between readers, decided from what
// the catalogue says rather than from a box somebody remembered to tick.
//
// A source with a row filter or a column mask returns different rows or values
// to different readers. Marked as unfiltered, its answers are cached under one
// shared key and every reader is served whatever the first one saw. Marked as
// filtered when it is not, answers are only cached per policy class, which
// costs warehouse time and nothing else.
//
// The two mistakes are not equal, so the rule is lopsided. Anything detection
// finds turns protection on straight away. Protection only comes off when
// detection read every table involved and positively found neither a filter
// nor a mask, and never while an administrator has asked for it by hand. A
// detection that failed, or could not see every table, changes nothing.
//
// Kept free of database and network imports so it can be tested on its own.

export interface ProtectionFlags {
	hasRowFilter: boolean;
	hasColumnMask: boolean;
}

export interface Detection {
	// Found on the object or any table behind it.
	rowFilter: boolean;
	columnMask: boolean;
	// True only when every table was read and was visible to the reader. A
	// table the reader cannot see lists no filters, which reads exactly like a
	// table that has none.
	complete: boolean;
}

export interface ProtectionDecision {
	next: ProtectionFlags;
	// Protection went from off to on, so answers cached as unfiltered have to
	// be thrown away.
	turnedOn: boolean;
	changed: boolean;
}

export function decideProtection(
	current: ProtectionFlags,
	forced: boolean,
	detection: Detection | null,
): ProtectionDecision {
	let hasRowFilter = current.hasRowFilter || forced;
	let hasColumnMask = current.hasColumnMask;

	if (detection) {
		if (detection.rowFilter || detection.columnMask) hasRowFilter = true;
		if (detection.columnMask) hasColumnMask = true;

		if (detection.complete) {
			if (!detection.columnMask) hasColumnMask = false;
			if (!detection.rowFilter && !detection.columnMask) {
				hasRowFilter = forced;
			}
		}
	}

	return {
		next: { hasRowFilter, hasColumnMask },
		turnedOn: !current.hasRowFilter && hasRowFilter,
		changed:
			hasRowFilter !== current.hasRowFilter ||
			hasColumnMask !== current.hasColumnMask,
	};
}
