// Matching a value in the data to a country on the map.
//
// The boundaries come from Natural Earth, which spells several countries
// differently from every business system that has ever recorded one: "United
// States of America" rather than "USA", "Dem. Rep. Congo" rather than
// "Democratic Republic of the Congo". A map that silently drops the rows it
// cannot place is a map that lies by omission, and the row it drops is usually
// the largest one.
//
// So matching is deliberate rather than incidental: normalise both sides, try a
// table of the aliases that actually occur, and hand back what did not match so
// the visual can say so rather than quietly drawing a smaller world.

// Lower case, no punctuation, no accents, single spaces. Enough to make
// "Côte d'Ivoire", "Cote d Ivoire" and "COTE DIVOIRE" the same string.
export function normaliseCountry(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// What a value in the data might be called, against what the boundaries call
// it. Written the way the data spells it, since that is the side that varies.
//
// ISO codes are included because a warehouse column is as likely to hold "US"
// as it is to hold a name.
const aliases: Record<string, string> = {
	// The one every system spells differently.
	usa: "United States of America",
	us: "United States of America",
	"u s a": "United States of America",
	"united states": "United States of America",
	"united states of america": "United States of America",
	america: "United States of America",

	uk: "United Kingdom",
	gb: "United Kingdom",
	"great britain": "United Kingdom",
	britain: "United Kingdom",
	england: "United Kingdom",

	// Names the boundaries abbreviate.
	"bosnia and herzegovina": "Bosnia and Herz.",
	"central african republic": "Central African Rep.",
	"czech republic": "Czechia",
	"democratic republic of the congo": "Dem. Rep. Congo",
	"congo kinshasa": "Dem. Rep. Congo",
	drc: "Dem. Rep. Congo",
	"republic of the congo": "Congo",
	"congo brazzaville": "Congo",
	"dominican republic": "Dominican Rep.",
	"equatorial guinea": "Eq. Guinea",
	"south sudan": "S. Sudan",
	"solomon islands": "Solomon Is.",
	"western sahara": "W. Sahara",
	"falkland islands": "Falkland Is.",
	"french southern territories": "Fr. S. Antarctic Lands",
	"north macedonia": "Macedonia",
	macedonia: "Macedonia",
	"cote d ivoire": "Côte d'Ivoire",
	"ivory coast": "Côte d'Ivoire",
	"east timor": "Timor-Leste",
	"cape verde": "Cabo Verde",
	swaziland: "eSwatini",
	burma: "Myanmar",
	"south korea": "South Korea",
	"korea south": "South Korea",
	"republic of korea": "South Korea",
	"north korea": "North Korea",
	"korea north": "North Korea",
	"russian federation": "Russia",
	"vatican city": "Vatican",
	"holy see": "Vatican",
	laos: "Laos",
	"lao pdr": "Laos",
	syria: "Syria",
	"syrian arab republic": "Syria",
	"viet nam": "Vietnam",
	"iran islamic republic of": "Iran",
	"tanzania united republic of": "Tanzania",
	"venezuela bolivarian republic of": "Venezuela",
	"bolivia plurinational state of": "Bolivia",
	"moldova republic of": "Moldova",
	"brunei darussalam": "Brunei",
	"antigua and barbuda": "Antigua and Barb.",
	"saint kitts and nevis": "St. Kitts and Nevis",
	"saint vincent and the grenadines": "St. Vin. and Gren.",
	"saint lucia": "Saint Lucia",
	"trinidad and tobago": "Trinidad and Tobago",
	"united arab emirates": "United Arab Emirates",
	"marshall islands": "Marshall Is.",
	"northern mariana islands": "N. Mariana Is.",
	"turks and caicos islands": "Turks and Caicos Is.",
	"british virgin islands": "British Virgin Is.",
	"us virgin islands": "U.S. Virgin Is.",
	"sao tome and principe": "São Tomé and Principe",
	turkiye: "Turkey",
};

// Two letter ISO codes, for the columns that hold one. Only the codes that are
// not already the start of a country's own name, so a lookup cannot turn a real
// name into the wrong country.
const isoCodes: Record<string, string> = {
	af: "Afghanistan",
	ar: "Argentina",
	at: "Austria",
	au: "Australia",
	be: "Belgium",
	br: "Brazil",
	ca: "Canada",
	ch: "Switzerland",
	cl: "Chile",
	cn: "China",
	co: "Colombia",
	cz: "Czechia",
	de: "Germany",
	dk: "Denmark",
	eg: "Egypt",
	es: "Spain",
	fi: "Finland",
	fr: "France",
	gr: "Greece",
	hu: "Hungary",
	id: "Indonesia",
	ie: "Ireland",
	il: "Israel",
	in: "India",
	it: "Italy",
	jp: "Japan",
	kr: "South Korea",
	mx: "Mexico",
	my: "Malaysia",
	nl: "Netherlands",
	no: "Norway",
	nz: "New Zealand",
	pe: "Peru",
	ph: "Philippines",
	pl: "Poland",
	pt: "Portugal",
	ro: "Romania",
	ru: "Russia",
	sa: "Saudi Arabia",
	se: "Sweden",
	sg: "Singapore",
	th: "Thailand",
	tr: "Turkey",
	tw: "Taiwan",
	ua: "Ukraine",
	vn: "Vietnam",
	za: "South Africa",
};

// The name the map knows this value by, or null when there is no honest match.
//
// Takes the set of names the loaded boundaries actually carry, so this stays
// correct if the boundary file is ever replaced: an alias pointing at a name
// the map does not have is treated as no match rather than as a match onto
// nothing.
export function matchCountry(
	value: string,
	known: Map<string, string>,
): string | null {
	const key = normaliseCountry(value);
	if (key === "") return null;

	const direct = known.get(key);
	if (direct) return direct;

	const alias = aliases[key];
	if (alias) {
		const resolved = known.get(normaliseCountry(alias));
		if (resolved) return resolved;
	}

	// Codes last, and only for a value short enough to be one. Otherwise a
	// column holding "IN" for India and a column holding "In progress" would
	// be treated the same way.
	if (key.length === 2) {
		const byCode = isoCodes[key];
		if (byCode) {
			const resolved = known.get(normaliseCountry(byCode));
			if (resolved) return resolved;
		}
	}

	return null;
}

// The lookup a map builds once from whatever boundaries it loaded.
export function knownCountries(names: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const name of names) map.set(normaliseCountry(name), name);
	return map;
}
