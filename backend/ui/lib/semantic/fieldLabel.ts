// A readable label from a raw column name, for tables whose columns are not
// already written for a reader.
//
// A short word is taken for an initialism and kept in capitals, which is right
// for an id or a three letter code and wrong for an ordinary word. The joining
// words and the common short words a column name is made of are written as
// words instead, and a figure with its unit, such as 1yr or 30d, stays as it is.

// Joining words, lower case unless the label starts with one.
const joiningWords = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"by",
	"for",
	"from",
	"in",
	"into",
	"is",
	"of",
	"on",
	"or",
	"per",
	"the",
	"to",
	"via",
	"vs",
	"with",
]);

// Ordinary short words and the usual abbreviations of longer ones, written
// with a capital rather than in capitals. Any other word of three letters or
// fewer is taken for a code and kept in capitals.
const shortWords = new Set([
	"add",
	"age",
	"ago",
	"all",
	"amt",
	"any",
	"app",
	"ask",
	"avg",
	"bad",
	"bid",
	"big",
	"bin",
	"bit",
	"box",
	"buy",
	"can",
	"cap",
	"car",
	"cnt",
	"cut",
	"day",
	"dev",
	"dry",
	"due",
	"end",
	"fee",
	"few",
	"fit",
	"fix",
	"gap",
	"hit",
	"hot",
	"hr",
	"job",
	"key",
	"lab",
	"lag",
	"law",
	"log",
	"lot",
	"low",
	"map",
	"max",
	"mid",
	"min",
	"mix",
	"mo",
	"net",
	"new",
	"no",
	"not",
	"num",
	"off",
	"old",
	"one",
	"out",
	"own",
	"pay",
	"pct",
	"pin",
	"pre",
	"pro",
	"put",
	"qtr",
	"qty",
	"raw",
	"ref",
	"row",
	"run",
	"sea",
	"sec",
	"seq",
	"set",
	"six",
	"src",
	"std",
	"sub",
	"sum",
	"tag",
	"tax",
	"ten",
	"tip",
	"top",
	"two",
	"up",
	"use",
	"val",
	"var",
	"way",
	"web",
	"win",
	"wk",
	"yes",
	"yr",
	"zip",
]);

function words(column: string): string[] {
	return column
		.replace(/[_-]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.split(" ")
		.filter(Boolean);
}

export function toLabel(column: string): string {
	const parts = words(column);
	const allCapitals = column === column.toUpperCase();
	return parts
		.map((word, index) => {
			const lower = word.toLowerCase();
			if (/^\d/.test(word)) return lower;
			// A code with a figure in it, such as L2 or PHL3, stays as written.
			if (/\d/.test(word)) return word;
			if (joiningWords.has(lower)) {
				return index === 0
					? lower[0].toUpperCase() + lower.slice(1)
					: lower;
			}
			if (shortWords.has(lower))
				return lower[0].toUpperCase() + lower.slice(1);
			if (word.length <= 3) return word.toUpperCase();
			// A column written wholly in capitals, in several words, reads as
			// words. A name of one word in capitals may be a code, and a word
			// in capitals beside ordinary ones was written that way on purpose,
			// so both are kept.
			const shouted = allCapitals && parts.length > 1;
			const rest = shouted ? lower.slice(1) : word.slice(1);
			return word[0].toUpperCase() + rest;
		})
		.join(" ");
}

// The label registration used to make, which put every word of three letters
// or fewer in capitals. A display name still equal to it was never chosen by
// anybody, so it can be replaced with toLabel without losing an edit.
export function legacyLabel(column: string): string {
	return words(column)
		.map((w) =>
			w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
		)
		.join(" ");
}
