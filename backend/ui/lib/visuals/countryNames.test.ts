import assert from "node:assert/strict";
import { test } from "node:test";
import { knownCountries, matchCountry, normaliseCountry } from "./countryNames";

// The names the boundary file actually carries, spelled as Natural Earth
// spells them.
const known = knownCountries([
	"United States of America",
	"United Kingdom",
	"Germany",
	"France",
	"India",
	"Czechia",
	"Dem. Rep. Congo",
	"Congo",
	"Côte d'Ivoire",
	"W. Sahara",
	"South Korea",
	"Russia",
	"Turkey",
	"Vietnam",
	"Bosnia and Herz.",
]);

test("a name spelled exactly as the map spells it matches", () => {
	assert.equal(matchCountry("Germany", known), "Germany");
});

test("case and spacing do not matter", () => {
	assert.equal(matchCountry("  GERMANY  ", known), "Germany");
	assert.equal(matchCountry("united  kingdom", known), "United Kingdom");
});

test("the abbreviations every system uses are matched", () => {
	assert.equal(matchCountry("USA", known), "United States of America");
	assert.equal(matchCountry("US", known), "United States of America");
	assert.equal(
		matchCountry("United States", known),
		"United States of America",
	);
	assert.equal(matchCountry("UK", known), "United Kingdom");
	assert.equal(matchCountry("Great Britain", known), "United Kingdom");
});

test("names the boundaries abbreviate are matched from the long form", () => {
	assert.equal(matchCountry("Czech Republic", known), "Czechia");
	assert.equal(
		matchCountry("Democratic Republic of the Congo", known),
		"Dem. Rep. Congo",
	);
	assert.equal(matchCountry("Western Sahara", known), "W. Sahara");
	assert.equal(
		matchCountry("Bosnia and Herzegovina", known),
		"Bosnia and Herz.",
	);
});

test("accents are matched with or without them", () => {
	assert.equal(matchCountry("Côte d'Ivoire", known), "Côte d'Ivoire");
	assert.equal(matchCountry("Cote d Ivoire", known), "Côte d'Ivoire");
	assert.equal(matchCountry("Ivory Coast", known), "Côte d'Ivoire");
});

test("two letter country codes are matched", () => {
	assert.equal(matchCountry("DE", known), "Germany");
	assert.equal(matchCountry("fr", known), "France");
	assert.equal(matchCountry("KR", known), "South Korea");
});

test("the two Congos are told apart", () => {
	assert.equal(matchCountry("Congo Kinshasa", known), "Dem. Rep. Congo");
	assert.equal(matchCountry("Republic of the Congo", known), "Congo");
});

test("a value that is not a country matches nothing", () => {
	assert.equal(matchCountry("EMEA", known), null);
	assert.equal(matchCountry("Unknown", known), null);
	assert.equal(matchCountry("", known), null);
	assert.equal(matchCountry("   ", known), null);
});

test("a two letter value that is not a country code matches nothing", () => {
	// A status column holding "OK" must not become a country.
	assert.equal(matchCountry("OK", known), null);
	assert.equal(matchCountry("XX", known), null);
});

test("an alias pointing at a name these boundaries lack is no match", () => {
	// Written as a match, but this map has no Japan, so claiming one would
	// colour nothing and report a success.
	const narrow = knownCountries(["Germany"]);
	assert.equal(matchCountry("JP", narrow), null);
	assert.equal(matchCountry("USA", narrow), null);
});

test("normalising strips punctuation and folds accents", () => {
	assert.equal(normaliseCountry("Côte d'Ivoire"), "cote d ivoire");
	assert.equal(normaliseCountry("Bosnia and Herz."), "bosnia and herz");
	assert.equal(normaliseCountry("U.S.A."), "u s a");
});

test("renamed countries are matched under both names", () => {
	assert.equal(matchCountry("Turkiye", known), "Turkey");
	assert.equal(matchCountry("Turkey", known), "Turkey");
	assert.equal(matchCountry("Russian Federation", known), "Russia");
	assert.equal(matchCountry("Viet Nam", known), "Vietnam");
});
